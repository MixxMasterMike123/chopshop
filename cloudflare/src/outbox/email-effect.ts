import {
  createOrderConfirmationEmailJob,
  deliveryIdFromKey,
  type OrderConfirmationEmailJob,
} from "../email/auth-email-job";
import { recordAuthEmailDelivery } from "../email/email-delivery-store";
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
 * The `email` outbox effect (PLAN §2.3: `outbox(email)` in the order batch).
 *
 * CP2-A's webhook inserts `{ event_type: 'email', dedupe_key:
 * 'email:order_confirmation:{orderId}', payload: { orderId, kind:
 * 'order_confirmation' } }`. The effect turns it into an
 * `order_confirmation` job on EMAIL_QUEUE; the existing `-email` consumer sends
 * it through Resend when a key is configured, exactly like the auth mails.
 *
 * EXACTLY ONE EMAIL: the job is DETERMINISTIC — its delivery id is derived from
 * the dedupe key, its createdAt is the outbox row's, its content the order's
 * immutable rows — so a retry after a crash (job enqueued, outbox not yet
 * `done`) enqueues the identical job again, and the ledger (email_deliveries,
 * keyed by delivery id + fingerprint) sends it at most once; Resend's
 * Idempotency-Key closes the last window. The job's 24-hour lifetime is the
 * ledger's rule; an effect that could not run within it fails with an alert
 * rather than mailing a day-old confirmation under a new id.
 *
 * The recipient is `orders.customer_email`, frozen at payment.
 */

const JOB_LIFETIME_MS = 24 * 60 * 60 * 1_000;
/** Enqueue only with room left for the consumer to deliver. */
const MIN_REMAINING_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_LINES = 100;

interface OrderRow {
  currency: string;
  customer_email: string;
  delivery_method: "pickup" | "shipping";
  discount_minor: number;
  order_number: string;
  shipping_country: string | null;
  shipping_minor: number;
  shop_name: string | null;
  subtotal_minor: number;
  total_minor: number;
  vat_minor: number;
}

function parsePayload(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { kind?: unknown }).kind === "order_confirmation" &&
      typeof (payload as { orderId?: unknown }).orderId === "string"
    ) {
      return (payload as { orderId: string }).orderId;
    }
  } catch {
    // fall through
  }
  return null;
}

async function buildJob(
  ctx: EffectContext,
  orderId: string,
  tenantId: string,
): Promise<OrderConfirmationEmailJob | "invalid" | "not_found"> {
  const { env, row } = ctx;
  const order = await env.DB.prepare(
    `SELECT o.order_number, o.customer_email, o.currency, o.delivery_method,
            o.shipping_country, o.subtotal_minor, o.shipping_minor,
            o.discount_minor, o.vat_minor, o.total_minor, t.shop_name
     FROM orders AS o JOIN tenants AS t ON t.tenant_id = o.tenant_id
     WHERE o.order_id = ? AND o.tenant_id = ?
     LIMIT 1`,
  )
    .bind(orderId, tenantId)
    .first<OrderRow>();
  if (order === null) {
    return "not_found";
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

  try {
    return createOrderConfirmationEmailJob({
      createdAt: row.created_at,
      deliveryId: await deliveryIdFromKey(row.dedupe_key),
      expiresAt: row.created_at + JOB_LIFETIME_MS,
      order: {
        currency: order.currency,
        deliveryMethod: order.delivery_method,
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
    return "invalid";
  }
}

async function failEmail(
  ctx: EffectContext,
  error: string,
  terminal: boolean,
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
          message: `Email effect ${row.outbox_id} (${row.dedupe_key.split(":").slice(0, 2).join(":")}) for order ${row.aggregate_id} failed (${error}); the confirmation was not sent.`,
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

export async function runEmailEffect(ctx: EffectContext): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;
  const orderId = parsePayload(row.payload_json);
  if (orderId === null || row.tenant_id === null || orderId !== row.aggregate_id) {
    return failEmail(ctx, "invalid_payload", true);
  }

  const queue = env.EMAIL_QUEUE;
  if (queue === undefined) {
    return failEmail(ctx, "email_queue_not_configured", false);
  }

  if (ctx.clock() > row.created_at + JOB_LIFETIME_MS - MIN_REMAINING_LIFETIME_MS) {
    return failEmail(ctx, "email_expired", true);
  }

  const job = await buildJob(ctx, orderId, row.tenant_id);
  if (job === "not_found") {
    return failEmail(ctx, "order_not_found", true);
  }
  if (job === "invalid") {
    return failEmail(ctx, "invalid_email_content", true);
  }

  const submitting = await markSubmitting(env.DB, claim, { now: ctx.clock() });
  if (submitting === null) {
    return { kind: "lost_claim" };
  }

  try {
    // Ledger first (the producer half, as for auth mails), then the queue.
    await recordAuthEmailDelivery(env.DB, job, ctx.clock());
  } catch {
    return failEmail(ctx, "email_ledger_error", false);
  }
  try {
    await queue.send(job, { contentType: "json" });
  } catch {
    return failEmail(ctx, "email_queue_error", false);
  }

  const now = ctx.clock();
  return outcomeOf(
    await complete(env.DB, claim, { now, resultRef: job.deliveryId }),
    now,
  );
}
