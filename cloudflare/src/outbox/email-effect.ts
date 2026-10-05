import {
  type AuthEmailJob,
  createOrderConfirmationEmailJob,
  deliveryIdFromKey,
  type OrderConfirmationEmailJob,
} from "../email/auth-email-job";
import { prepareAuthEmailDeliveryRecord } from "../email/email-delivery-store";
import {
  ADMIN_SHOP_ID_PATTERN,
  createOrderEmailJob,
  mailText,
  MAX_ORDER_MAIL_LINES,
  MAX_PICKUP_ADDRESS_LENGTH,
  type OrderEmailContent,
  type OrderEmailKind,
  realShopAddress,
  STATUS_MAIL_STEPS,
  type StatusMailStep,
} from "../email/order-emails";
import { readCanonicalOrigins } from "../lib/origins";
import {
  alertStatement,
  complete,
  type EffectContext,
  fail,
  markSubmitting,
  outboxRetryDelayMs,
  outcomeOf,
  type OutboxRunOutcome,
} from "./outbox";

/**
 * The order mails as outbox effects (PLAN §2.3: `outbox(email)` in the order
 * batch). Two event types:
 *
 *   email               payload `{ orderId, kind }`:
 *                         order_confirmation  to the buyer (CP2-A, webhook)
 *                         order_notice_shop   to the shop (CP5-WE, webhook)
 *                       and `{ kind: 'refund_notice', orderId, operationId,
 *                       full }` to the buyer, written by the batch that moves a
 *                       refund operation to 'succeeded' (src/commerce/refunds.ts)
 *                       — never on a reservation.
 *   email.order_status  payload `{ historyId, orderId }` (CP5-WB,
 *                       src/commerce/fulfilment.ts): the buyer's status mail for
 *                       one fulfilment change. `completed` mails nothing (the
 *                       row is done without a job): see STATUS_MAIL_STEPS.
 *
 * Each effect turns its row into ONE job on EMAIL_QUEUE; the existing `-email`
 * consumer sends it through Resend when a key is configured, exactly like the
 * auth mails. Without a key (staging) the job is recorded `pending` in the
 * ledger and the consumer holds it, as it holds an auth mail; nothing of that
 * reaches the webhook, the refund or the fulfilment route, which only wrote a
 * row.
 *
 * EXACTLY ONE EMAIL: the job is DETERMINISTIC — its delivery id is derived from
 * the dedupe key, its createdAt is the outbox row's, its content the order's
 * immutable rows — so a retry after a crash (job enqueued, outbox not yet
 * `done`) enqueues the identical job again, and the ledger (email_deliveries,
 * keyed by delivery id + fingerprint) sends it at most once; Resend's
 * Idempotency-Key closes the last window. The job's 24-hour lifetime is the
 * ledger's rule; an effect that could not run within it fails with an alert
 * (the dead state: outbox `failed` + `outbox_failed`) rather than mailing a
 * day-old message under a new id.
 *
 * FROZEN AT THE FIRST BUILD. What is live (the shop's name and support address,
 * the shop notice's recipient, the admin origin) is written to the row's
 * `frozen_json` (0022) in ONE batch with the ledger record and the move to
 * `submitting`, under the claim; every retry reuses it. A rename between an
 * attempt that recorded the ledger row and its retry therefore cannot produce a
 * job the ledger refuses as a fingerprint conflict. The BUYER's name is never
 * frozen (an outbox row carries no recipient data, D68): it is read again from
 * order_recipients, which is insert-once. Buyer addresses are never frozen
 * either: the recipient is `orders.customer_email`, frozen at payment.
 *
 * TENANCY: every read is by (id, tenant of the row). A row of shop A can only
 * ever name shop A's order, history row, refund and address.
 */

const JOB_LIFETIME_MS = 24 * 60 * 60 * 1_000;
/** Enqueue only with room left for the consumer to deliver. */
const MIN_REMAINING_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_LINES = 100;

export type Built =
  | { freeze: string | null; job: AuthEmailJob; kind: "built" }
  | { error: string; kind: "fail" }
  | { kind: "no_mail" };

/**
 * What a mail effect of another module (CP9-AC's reminder,
 * src/commerce/checkout-reminders.ts) may say to `deliver`: its job's own
 * lifetime, and what its alert names instead of "order <aggregate id>". Absent
 * for every mail of this module, whose jobs and alerts are as before.
 */
export interface DeliverOptions {
  lifetimeMs?: number;
  subject?: string;
}

const NOT_FOUND: Built = { error: "order_not_found", kind: "fail" };
const INVALID: Built = { error: "invalid_email_content", kind: "fail" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactly(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(record);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function parseJson(text: string | null | undefined): unknown {
  if (text === null || text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ── the `email` payloads ────────────────────────────────────────────────────

type EmailPayload =
  | { kind: "order_confirmation" | "order_notice_shop"; orderId: string }
  | { full: boolean; kind: "refund_notice"; operationId: string; orderId: string };

function parseEmailPayload(payloadJson: string): EmailPayload | null {
  const payload = parseJson(payloadJson);
  if (!isRecord(payload) || typeof payload.orderId !== "string") {
    return null;
  }
  if (
    (payload.kind === "order_confirmation" || payload.kind === "order_notice_shop") &&
    hasExactly(payload, ["kind", "orderId"])
  ) {
    return { kind: payload.kind, orderId: payload.orderId };
  }
  if (
    payload.kind === "refund_notice" &&
    hasExactly(payload, ["full", "kind", "operationId", "orderId"]) &&
    typeof payload.operationId === "string" &&
    typeof payload.full === "boolean"
  ) {
    return { full: payload.full, kind: "refund_notice", operationId: payload.operationId, orderId: payload.orderId };
  }
  return null;
}

// ── shared reads ────────────────────────────────────────────────────────────

/** What a previous attempt froze under `key`, or undefined when none did. */
function frozenPart(frozenJson: string | null | undefined, key: string): unknown {
  const frozen = parseJson(frozenJson);
  if (frozen === undefined) {
    return undefined;
  }
  return isRecord(frozen) ? (frozen[key] ?? null) : null;
}

interface OrderFacts {
  currency: string;
  customer_email: string;
  delivery_method: "pickup" | "shipping";
  /** CP8-DC: the code's current name, or null (no code, or none found). */
  discount_code: string | null;
  discount_minor: number;
  order_number: string;
  shipping_country: string | null;
  shipping_minor: number;
  shop_name: string | null;
  subtotal_minor: number;
  support_email: string | null;
  total_minor: number;
  vat_minor: number;
}

function readOrder(env: Env, orderId: string, tenantId: string): Promise<OrderFacts | null> {
  return env.DB.prepare(
    `SELECT o.order_number, o.customer_email, o.currency, o.delivery_method,
            o.shipping_country, o.subtotal_minor, o.shipping_minor,
            o.discount_minor, o.vat_minor, o.total_minor, t.shop_name, t.support_email,
            (SELECT dc.code FROM discount_codes AS dc
             WHERE dc.discount_code_id = o.discount_code_id
               AND dc.tenant_id = o.tenant_id) AS discount_code
     FROM orders AS o JOIN tenants AS t ON t.tenant_id = o.tenant_id
     WHERE o.order_id = ? AND o.tenant_id = ?
     LIMIT 1`,
  )
    .bind(orderId, tenantId)
    .first<OrderFacts>();
}

interface RecipientFacts {
  name: string;
  pickup_location_address: string | null;
  pickup_location_name: string | null;
}

/** The order's recipient (0045), or null for an order made before it. */
function readRecipient(env: Env, orderId: string, tenantId: string): Promise<RecipientFacts | null> {
  return env.DB.prepare(
    `SELECT name, pickup_location_name, pickup_location_address
     FROM order_recipients
     WHERE order_id = ? AND tenant_id = ?
     LIMIT 1`,
  )
    .bind(orderId, tenantId)
    .first<RecipientFacts>();
}

async function frameOf(ctx: EffectContext) {
  return {
    createdAt: ctx.row.created_at,
    deliveryId: await deliveryIdFromKey(ctx.row.dedupe_key),
    expiresAt: ctx.row.created_at + JOB_LIFETIME_MS,
  };
}

/**
 * Builds an order mail from its frozen part, or from fresh content (frozen on
 * this attempt). `live` holds what is never frozen (the buyer's name).
 */
async function buildOrderMail(
  ctx: EffectContext,
  input: {
    fresh: () => Promise<{ content: OrderEmailContent; recipient: string } | Built>;
    kind: OrderEmailKind;
    live: Record<string, unknown>;
    /** The buyer's address, or null when the recipient is frozen (shop notice). */
    recipient: string | null;
    tenantId: string;
  },
): Promise<Built> {
  const frozen = frozenPart(ctx.row.frozen_json, "orderMail");
  let content: unknown;
  let recipient: unknown;
  if (frozen !== undefined) {
    if (!isRecord(frozen) || !isRecord(frozen.content)) {
      return INVALID;
    }
    content = { ...frozen.content, ...input.live };
    recipient = input.recipient ?? frozen.recipient;
  } else {
    const made = await input.fresh();
    if ("kind" in made) {
      return made;
    }
    content = made.content;
    recipient = made.recipient;
  }
  if (typeof recipient !== "string") {
    return INVALID;
  }

  let job;
  try {
    job = createOrderEmailJob({
      ...(await frameOf(ctx)),
      content: content as OrderEmailContent,
      kind: input.kind,
      recipient,
      tenantId: input.tenantId,
    });
  } catch {
    return INVALID;
  }
  if (frozen !== undefined) {
    return { freeze: null, job, kind: "built" };
  }
  // Everything the job renders except what `live` supplies; the recipient
  // only when it is not the buyer's (the shop notice's address).
  const stored = Object.fromEntries(
    Object.entries(job.content as unknown as Record<string, unknown>).filter(([key]) => !(key in input.live)),
  );
  return {
    freeze: JSON.stringify({
      orderMail: input.recipient === null ? { content: stored, recipient: job.recipient } : { content: stored },
    }),
    job,
    kind: "built",
  };
}

// ── order_confirmation (CP2) ────────────────────────────────────────────────

async function buildConfirmation(ctx: EffectContext, orderId: string, tenantId: string): Promise<Built> {
  const { env } = ctx;
  const frozen = frozenPart(ctx.row.frozen_json, "confirmation");
  const order = await readOrder(env, orderId, tenantId);
  if (order === null) {
    return NOT_FOUND;
  }
  const items = await env.DB.prepare(
    `SELECT name, quantity, line_total_minor
     FROM order_items
     WHERE order_id = ? AND tenant_id = ?
     ORDER BY item_index
     LIMIT ${MAX_LINES + 1}`,
  )
    .bind(orderId, tenantId)
    .all<{ line_total_minor: number; name: string; quantity: number }>();

  let job: OrderConfirmationEmailJob;
  try {
    job = createOrderConfirmationEmailJob({
      ...(await frameOf(ctx)),
      // Re-validated by the job constructor like freshly built content.
      order: frozen !== undefined ? (frozen as OrderConfirmationEmailJob["order"]) : {
        currency: order.currency,
        deliveryMethod: order.delivery_method,
        ...(order.discount_code === null ? {} : { discountCode: order.discount_code }),
        discountMinor: order.discount_minor,
        items: items.results.map((item) => ({
          lineTotalMinor: item.line_total_minor,
          name: item.name,
          quantity: item.quantity,
        })),
        orderNumber: order.order_number,
        shippingCountry: order.shipping_country,
        shippingMinor: order.shipping_minor,
        shopName: order.shop_name,
        subtotalMinor: order.subtotal_minor,
        totalMinor: order.total_minor,
        vatMinor: order.vat_minor,
      },
      recipient: order.customer_email,
      tenantId,
    });
  } catch {
    return INVALID;
  }
  return {
    freeze: frozen !== undefined ? null : JSON.stringify({ confirmation: job.order }),
    job,
    kind: "built",
  };
}

// ── order_notice_shop (CP5-WE) ──────────────────────────────────────────────

/**
 * Where a shop is told of a new order: its support address (tenants, set by
 * the platform, D99), else its OLDEST active admin — one address, so one job
 * per order. Null when the shop has neither.
 */
async function shopNoticeAddress(env: Env, tenantId: string, supportEmail: string | null): Promise<string | null> {
  const support = realShopAddress(supportEmail);
  if (support !== null) {
    return support;
  }
  const admin = await env.DB.prepare(
    `SELECT u."email" AS email
     FROM tenant_memberships AS m
     INNER JOIN "user" AS u ON u."id" = m.user_id
     INNER JOIN identity_access AS a ON a.user_id = m.user_id
     WHERE m.tenant_id = ? AND m.role = 'admin' AND m.status = 'active'
       AND a.account_type = 'tenant_admin' AND a.status = 'active'
     ORDER BY m.created_at, m.user_id
     LIMIT 1`,
  )
    .bind(tenantId)
    .first<{ email: string }>();
  return realShopAddress(admin?.email);
}

/**
 * The admin's order page with the order's shop selected (`?shopId=`, which the
 * admin build ranks first when it picks the active shop): an admin of several
 * shops opens the notice in the shop that owns the order.
 */
function adminOrderUrl(env: Env, orderId: string, tenantId: string): string | null {
  const admin = readCanonicalOrigins(env)?.admin;
  if (admin === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId) || !ADMIN_SHOP_ID_PATTERN.test(tenantId)) {
    return null;
  }
  const url = new URL(`/admin/orders/${orderId}`, admin);
  url.searchParams.set("shopId", tenantId);
  return url.href;
}

function buildShopNotice(ctx: EffectContext, orderId: string, tenantId: string): Promise<Built> {
  const { env } = ctx;
  return buildOrderMail(ctx, {
    fresh: async () => {
      const order = await readOrder(env, orderId, tenantId);
      if (order === null) {
        return NOT_FOUND;
      }
      const recipient = await shopNoticeAddress(env, tenantId, order.support_email);
      if (recipient === null) {
        return { error: "no_shop_address", kind: "fail" };
      }
      const items = await env.DB.prepare(
        `SELECT name, quantity, line_total_minor
         FROM order_items
         WHERE order_id = ? AND tenant_id = ?
         ORDER BY item_index
         LIMIT ${MAX_ORDER_MAIL_LINES + 1}`,
      )
        .bind(orderId, tenantId)
        .all<{ line_total_minor: number; name: string; quantity: number }>();
      const place =
        order.delivery_method === "pickup"
          ? mailText((await readRecipient(env, orderId, tenantId))?.pickup_location_name)
          : null;
      return {
        content: {
          adminUrl: adminOrderUrl(env, orderId, tenantId),
          currency: order.currency,
          deliveryMethod: order.delivery_method,
          ...(order.discount_code === null ? {} : { discountCode: order.discount_code }),
          discountMinor: order.discount_minor,
          items: items.results.map((item) => ({
            lineTotalMinor: item.line_total_minor,
            name: mailText(item.name) ?? "–",
            quantity: item.quantity,
          })),
          orderNumber: order.order_number,
          pickupPlaceName: place,
          shippingCountry: order.shipping_country,
          shippingMinor: order.shipping_minor,
          shopName: mailText(order.shop_name),
          subtotalMinor: order.subtotal_minor,
          totalMinor: order.total_minor,
          vatMinor: order.vat_minor,
        },
        recipient,
      };
    },
    kind: "order_notice_shop",
    // Nothing of the buyer is in this mail.
    live: {},
    recipient: null,
    tenantId,
  });
}

// ── refund_notice (CP5-WE) ──────────────────────────────────────────────────

async function buildRefundNotice(
  ctx: EffectContext,
  payload: { full: boolean; operationId: string; orderId: string },
  tenantId: string,
): Promise<Built> {
  const { env } = ctx;
  const op = await env.DB.prepare(
    `SELECT amount_minor, state FROM refund_operations
     WHERE id = ? AND order_id = ? AND tenant_id = ?
     LIMIT 1`,
  )
    .bind(payload.operationId, payload.orderId, tenantId)
    .first<{ amount_minor: number; state: string }>();
  if (op === null) {
    return NOT_FOUND;
  }
  if (op.state !== "succeeded") {
    // It failed after succeeding (refunds.ts raises its own alert): the buyer
    // got nothing back, so they are not told otherwise.
    return { kind: "no_mail" };
  }
  const order = await readOrder(env, payload.orderId, tenantId);
  if (order === null) {
    return NOT_FOUND;
  }
  const recipientName = mailText((await readRecipient(env, payload.orderId, tenantId))?.name);
  return buildOrderMail(ctx, {
    fresh: async () => ({
      content: {
        amountMinor: op.amount_minor,
        currency: order.currency,
        full: payload.full,
        orderNumber: order.order_number,
        recipientName,
        shopName: mailText(order.shop_name),
        supportEmail: realShopAddress(order.support_email),
      },
      recipient: order.customer_email,
    }),
    kind: "refund_notice",
    live: { recipientName },
    recipient: order.customer_email,
    tenantId,
  });
}

// ── order_status_update (CP5-WE, the consumer of CP5-WB's rows) ─────────────

function parseStatusPayload(payloadJson: string): { historyId: string; orderId: string } | null {
  const payload = parseJson(payloadJson);
  if (
    isRecord(payload) &&
    hasExactly(payload, ["historyId", "orderId"]) &&
    typeof payload.historyId === "string" &&
    typeof payload.orderId === "string"
  ) {
    return { historyId: payload.historyId, orderId: payload.orderId };
  }
  return null;
}

function isMailStep(value: string): value is StatusMailStep {
  return (STATUS_MAIL_STEPS as readonly string[]).includes(value);
}

async function buildStatusUpdate(
  ctx: EffectContext,
  payload: { historyId: string; orderId: string },
  tenantId: string,
): Promise<Built> {
  const { env } = ctx;
  const change = await env.DB.prepare(
    `SELECT from_status, to_status FROM order_status_history
     WHERE history_id = ? AND order_id = ? AND tenant_id = ? AND track = 'fulfilment'
     LIMIT 1`,
  )
    .bind(payload.historyId, payload.orderId, tenantId)
    .first<{ from_status: string; to_status: string }>();
  if (change === null) {
    return { error: "history_not_found", kind: "fail" };
  }
  if (!isMailStep(change.to_status)) {
    return { kind: "no_mail" };
  }
  const step = change.to_status;
  const order = await readOrder(env, payload.orderId, tenantId);
  if (order === null) {
    return NOT_FOUND;
  }
  const recipientRow = await readRecipient(env, payload.orderId, tenantId);
  const recipientName = mailText(recipientRow?.name);
  return buildOrderMail(ctx, {
    fresh: async () => {
      const shipment =
        step === "shipped"
          ? await env.DB.prepare(
              `SELECT tracking_number, carrier FROM order_shipments
               WHERE history_id = ? AND order_id = ? AND tenant_id = ?
               LIMIT 1`,
            )
              .bind(payload.historyId, payload.orderId, tenantId)
              .first<{ carrier: string | null; tracking_number: string | null }>()
          : null;
      const pickup = step === "ready_for_pickup";
      return {
        content: {
          additionalParcel: step === "shipped" && change.from_status === "shipped",
          carrier: mailText(shipment?.carrier),
          orderNumber: order.order_number,
          pickupPlaceAddress: pickup
            ? mailText(recipientRow?.pickup_location_address, MAX_PICKUP_ADDRESS_LENGTH)
            : null,
          pickupPlaceName: pickup ? mailText(recipientRow?.pickup_location_name) : null,
          recipientName,
          shopName: mailText(order.shop_name),
          status: step,
          supportEmail: realShopAddress(order.support_email),
          trackingNumber: mailText(shipment?.tracking_number),
        },
        recipient: order.customer_email,
      };
    },
    kind: "order_status_update",
    live: { recipientName },
    recipient: order.customer_email,
    tenantId,
  });
}

// ── the run ─────────────────────────────────────────────────────────────────

export async function failEmail(
  ctx: EffectContext,
  error: string,
  terminal: boolean,
  subject?: string,
): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;
  const now = ctx.clock();
  const result = await fail(env.DB, claim, {
    backoffMs: outboxRetryDelayMs(row.attempts),
    error,
    now,
    onFailed: (guard) => [
      alertStatement(
        env.DB,
        {
          id: `outbox-failed:${row.outbox_id}`,
          kind: "outbox_failed",
          message: `Email effect ${row.outbox_id} (${row.dedupe_key.split(":").slice(0, 2).join(":")}) for ${subject ?? `order ${row.aggregate_id}`} failed (${error}); the mail was not sent.`,
          nowMs: now,
          resourceId: row.outbox_id,
          resourceType: "outbox_event",
          severity: "warning",
          tenantId: row.tenant_id,
        },
        guard,
      ),
    ],
    terminal,
  });
  return outcomeOf(result, now);
}

/** Built job → ledger + freeze + submitting (one batch, under the claim) → queue → done. */
export async function deliver(ctx: EffectContext, built: Built, options: DeliverOptions = {}): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;
  const lifetimeMs = options.lifetimeMs ?? JOB_LIFETIME_MS;
  if (built.kind === "fail") {
    return failEmail(ctx, built.error, true, options.subject);
  }
  if (built.kind === "no_mail") {
    const doneAt = ctx.clock();
    return outcomeOf(await complete(env.DB, claim, { now: doneAt, resultRef: null }), doneAt);
  }

  const queue = env.EMAIL_QUEUE;
  if (queue === undefined) {
    return failEmail(ctx, "email_queue_not_configured", false, options.subject);
  }
  if (ctx.clock() > row.created_at + lifetimeMs - MIN_REMAINING_LIFETIME_MS) {
    return failEmail(ctx, "email_expired", true, options.subject);
  }

  const { freeze, job } = built;
  const now = ctx.clock();
  const recordLedger = await prepareAuthEmailDeliveryRecord(env.DB, job, now);
  const submitting = await markSubmitting(env.DB, claim, {
    now,
    withTransition: (guard) => [
      ...(freeze === null
        ? []
        : [
            env.DB.prepare(
              `UPDATE outbox_events SET frozen_json = ?
               WHERE outbox_id = ? AND frozen_json IS NULL AND ${guard.sql}`,
            ).bind(freeze, row.outbox_id, ...guard.binds),
          ]),
      recordLedger(guard),
    ],
  });
  if (submitting === null) {
    return { kind: "lost_claim" };
  }

  try {
    await queue.send(job, { contentType: "json" });
  } catch {
    return failEmail(ctx, "email_queue_error", false, options.subject);
  }

  const doneAt = ctx.clock();
  return outcomeOf(
    await complete(env.DB, claim, { now: doneAt, resultRef: job.deliveryId }),
    doneAt,
  );
}

/** The `email` effect: the confirmation, the shop's notice, the refund notice. */
export async function runEmailEffect(ctx: EffectContext): Promise<OutboxRunOutcome> {
  const { row } = ctx;
  const payload = parseEmailPayload(row.payload_json);
  if (payload === null || row.tenant_id === null || payload.orderId !== row.aggregate_id) {
    return failEmail(ctx, "invalid_payload", true);
  }
  const tenantId = row.tenant_id;
  switch (payload.kind) {
    case "order_confirmation":
      return deliver(ctx, await buildConfirmation(ctx, payload.orderId, tenantId));
    case "order_notice_shop":
      return deliver(ctx, await buildShopNotice(ctx, payload.orderId, tenantId));
    case "refund_notice":
      return deliver(ctx, await buildRefundNotice(ctx, payload, tenantId));
  }
}

/** The `email.order_status` effect: the buyer's mail for one fulfilment change. */
export async function runOrderStatusEmailEffect(ctx: EffectContext): Promise<OutboxRunOutcome> {
  const { row } = ctx;
  const payload = parseStatusPayload(row.payload_json);
  if (
    payload === null ||
    row.tenant_id === null ||
    row.aggregate_type !== "order" ||
    payload.orderId !== row.aggregate_id
  ) {
    return failEmail(ctx, "invalid_payload", true);
  }
  return deliver(ctx, await buildStatusUpdate(ctx, payload, row.tenant_id));
}
