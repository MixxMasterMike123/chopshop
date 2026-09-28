import { deliveryIdFromKey } from "../email/auth-email-job";
import {
  createWithdrawalEmailJob,
  isWithdrawalEmailKind,
  MAX_LINE_NAME_LENGTH,
  MAX_LINE_SKU_LENGTH,
  MAX_WITHDRAWAL_LINES,
  normalizedWithdrawalEmail,
  prepareWithdrawalEmailDeliveryRecord,
  WITHDRAWAL_MAX_AGE_DAYS,
  type WithdrawalAcknowledgement,
  type WithdrawalEmailJob,
  type WithdrawalEmailKind,
  type WithdrawalLine,
  type WithdrawalReason,
} from "../email/withdrawal-email";
import { secretMatches } from "../lib/bearer";
import { readFrozenConsent } from "../legal/consent";
import {
  alertStatement,
  complete,
  type EffectContext,
  fail,
  markSubmitting,
  OUTBOX_EFFECT_TYPES,
  outboxRetryDelayMs,
  outcomeOf,
  type OutboxRunOutcome,
} from "../outbox/outbox";

/**
 * The withdrawal function (CP4-G; DAL 2 kap. 10 a §, CRD Art. 11a; D96),
 * migration 0044. Ported from the GUEST path of Firebase's `submitWithdrawal`
 * (functions/src/withdrawal/functions.ts), whose header states the law:
 *
 *   - the buyer states the ORDER NUMBER, the PURCHASE ADDRESS and a NAME, and
 *     expressly confirms; no account (requiring one is the hoop the law
 *     forbids — D11);
 *   - the server stamps the TIME the message arrived — the load-bearing proof,
 *     never the client's — and records it once;
 *   - the answer carries the receipt (mottagningsbevis) for the page to show and
 *     the buyer to save; the receipt is mailed to the purchase address and the
 *     shop is told, both through the outbox after the record is written, so a
 *     failing mail never fails the withdrawal;
 *   - NO MONEY MOVES and no order state changes: whether the withdrawal is
 *     valid, and the refund, are the shop's own assessment and action.
 *
 *   submitWithdrawal          POST /v1/withdrawals (src/routes/storefront-withdrawals.ts)
 *   readAdminOrderWithdrawal  for the admin order read (reviewer wiring)
 *   runWithdrawalEmailEffect  the `withdrawal_email` outbox effect (reviewer wiring)
 *
 * ── ONE ANSWER FOR "NO SUCH ORDER" AND "WRONG ADDRESS" ──────────────────────
 * The order is looked up by (hostname tenant, order number) with ONE query
 * that returns its id and purchase address or nothing; the stated address is
 * then compared, normalised (trimmed, lower case), as two SHA-256 digests in
 * constant time — against the empty string when there is no order, so both
 * misses run the same statements and the same comparison and end in the same
 * `not_found`. Nothing is written on either.
 *
 * ── WHAT THE FUNCTION ANSWERS ───────────────────────────────────────────────
 *   the order is older than 450 days (the source's absolute cap: 14 days +
 *     one year of extension + delivery slack; the only age limit)
 *                                         → not eligible, 'window_passed'
 *   every line is personalised and its right was waived at checkout
 *     (orders.is_personalized + the frozen consent's personalizedItems, D46)
 *                                         → not eligible, 'personalized_exempt'
 *   otherwise                             → eligible; the receipt names the
 *     lines it covers, and lists apart any personalised line of a MIXED order
 *     (those keep no right; the others do — the source refused the whole order)
 * Every answer is recorded with its time, and every one carries the receipt:
 * the receipt confirms that the message arrived, not that it is valid.
 *
 * ── ONE MESSAGE PER ORDER ───────────────────────────────────────────────────
 * The row is written by `INSERT … SELECT … WHERE NOT EXISTS` in ONE batch with
 * its outbox rows (and the no-address alert), each of those conditioned on
 * THIS row being the one stored. A second message — sequential or concurrent —
 * writes nothing and is answered with the first one's receipt, byte for byte.
 */

export { WITHDRAWAL_MAX_AGE_DAYS };

/** The outbox effect type of the two mails (a type of its own: see the report). */
export const WITHDRAWAL_EMAIL_EFFECT = "withdrawal_email";

/** Whether the outbox consumer runs this effect yet (it does once wired). */
export function isWithdrawalEmailEffectRunnable(): boolean {
  return (OUTBOX_EFFECT_TYPES as readonly string[]).includes(WITHDRAWAL_EMAIL_EFFECT);
}

export const WITHDRAWAL_ALERT_KIND = "withdrawal_shop_unnotified";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_ORDER_NUMBER_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
const MAX_SHOP_NAME_LENGTH = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_GLOBAL = /[\u0000-\u001f\u007f]+/g;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── the request ─────────────────────────────────────────────────────────────

export interface WithdrawalInput {
  /** Trimmed, lower case. */
  contactEmail: string;
  /** Trimmed. */
  name: string;
  /** Trimmed, one leading `#` removed, as typed otherwise. */
  orderNumber: string;
}

const BODY_KEYS = ["orderNumber", "statement"];
const STATEMENT_KEYS = ["contactEmail", "name"];

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `{ orderNumber, statement: { name, contactEmail } }` — the source's guest
 * call and the page's three fields, nothing else (no shop id: the tenant is
 * the hostname's; no time: the time is the server's). Null for anything else;
 * the route answers every null with the same 400.
 */
export function parseWithdrawalInput(body: unknown): WithdrawalInput | null {
  if (!isRecord(body) || !hasOnlyKeys(body, BODY_KEYS) || !isRecord(body.statement)) {
    return null;
  }
  const statement = body.statement;
  if (
    !hasOnlyKeys(statement, STATEMENT_KEYS) ||
    typeof body.orderNumber !== "string" ||
    typeof statement.name !== "string" ||
    typeof statement.contactEmail !== "string"
  ) {
    return null;
  }

  // Buyers type "#…", lower case, or with spaces around it (source rule).
  const orderNumber = body.orderNumber.trim().replace(/^#/, "").trim();
  const name = statement.name.trim();
  const contactEmail = statement.contactEmail.trim().toLowerCase();
  if (
    orderNumber.length === 0 ||
    orderNumber.length > MAX_ORDER_NUMBER_LENGTH ||
    CONTROL.test(orderNumber) ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    CONTROL.test(name) ||
    contactEmail.length > 254 ||
    !EMAIL_PATTERN.test(contactEmail)
  ) {
    return null;
  }
  return { contactEmail, name, orderNumber };
}


// ── the answer ──────────────────────────────────────────────────────────────

export interface WithdrawalAnswer {
  acknowledgement: WithdrawalAcknowledgement;
  /** True when this message found an earlier one on record (nothing written). */
  alreadyReceived: boolean;
  eligible: boolean;
  reason: WithdrawalReason | null;
}

export type SubmitWithdrawalResult =
  | { status: "not_found" }
  | { outboxIds: string[]; status: "created"; withdrawal: WithdrawalAnswer }
  | { status: "existing"; withdrawal: WithdrawalAnswer };

interface WithdrawalRow {
  consumer_name: string;
  contact_email: string;
  eligible: number;
  exempt_items_json: string;
  order_id: string;
  reason: WithdrawalReason | null;
  received_at: string;
  shop_name: string | null;
  shop_notice_email: string | null;
  withdrawal_id: string;
  withdrawn_items_json: string;
}

interface LineRow {
  item_index: number;
  name: string;
  quantity: number;
  sku: string;
}

const WITHDRAWAL_COLUMNS = `withdrawal_id, order_id, eligible, reason, withdrawn_items_json,
  exempt_items_json, consumer_name, contact_email, shop_name, shop_notice_email, received_at`;

/** Control characters out, trimmed, bounded; a line always has a name. */
function cleanText(value: string, max: number): string {
  return value.replace(CONTROL_GLOBAL, " ").trim().slice(0, max).trim();
}

function receiptLine(line: LineRow): WithdrawalLine {
  const name = cleanText(line.name, MAX_LINE_NAME_LENGTH);
  return {
    name: name === "" ? "–" : name,
    quantity: Math.min(Math.max(1, Math.trunc(line.quantity)), 999),
    sku: cleanText(line.sku, MAX_LINE_SKU_LENGTH),
  };
}

function indexesOf(json: string): Set<number> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is number => Number.isSafeInteger(value)) : []);
  } catch {
    return new Set();
  }
}

/** The source's statement, verbatim in wording: the buyer's message with its time. */
export function withdrawalStatement(name: string, orderNumber: string, receivedAt: string): string {
  return (
    `Jag, ${name}, ångrar härmed mitt köp av order ${orderNumber}. ` +
    `Detta meddelande togs emot ${receivedAt}.`
  );
}

/** The receipt, from the immutable row and the order's frozen lines only. */
function acknowledgementOf(
  row: WithdrawalRow,
  orderNumber: string,
  lines: readonly LineRow[],
): WithdrawalAcknowledgement {
  const withdrawn = indexesOf(row.withdrawn_items_json);
  const exempt = indexesOf(row.exempt_items_json);
  return {
    consumerName: row.consumer_name,
    contactEmail: row.contact_email,
    exemptItems: lines.filter((line) => exempt.has(line.item_index)).map(receiptLine),
    orderNumber,
    shopName: row.shop_name,
    statement: withdrawalStatement(row.consumer_name, orderNumber, row.received_at),
    submittedAt: row.received_at,
    withdrawnItems: lines.filter((line) => withdrawn.has(line.item_index)).map(receiptLine),
  };
}

function answerOf(
  row: WithdrawalRow,
  orderNumber: string,
  lines: readonly LineRow[],
  alreadyReceived: boolean,
): WithdrawalAnswer {
  return {
    acknowledgement: acknowledgementOf(row, orderNumber, lines),
    alreadyReceived,
    eligible: row.eligible === 1,
    reason: row.eligible === 1 ? null : row.reason,
  };
}

async function readWithdrawalByOrder(
  db: D1Database,
  tenantId: string,
  orderId: string,
): Promise<WithdrawalRow | null> {
  return db
    .prepare(`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE tenant_id = ? AND order_id = ? LIMIT 1`)
    .bind(tenantId, orderId)
    .first<WithdrawalRow>();
}

async function readLines(db: D1Database, tenantId: string, orderId: string): Promise<LineRow[]> {
  const rows = await db
    .prepare(
      `SELECT item_index, name, sku, quantity FROM order_items
       WHERE tenant_id = ? AND order_id = ?
       ORDER BY item_index ASC
       LIMIT ${MAX_WITHDRAWAL_LINES}`,
    )
    .bind(tenantId, orderId)
    .all<LineRow>();
  return rows.results;
}

interface OrderFacts {
  consent_json: string | null;
  created_at: number;
  is_personalized: number;
  order_number: string;
  shop_name: string | null;
  support_email: string | null;
}

async function readOrderFacts(db: D1Database, tenantId: string, orderId: string): Promise<OrderFacts | null> {
  return db
    .prepare(
      `SELECT o.order_number, o.created_at, o.is_personalized, o.consent_json,
              t.shop_name, t.support_email
       FROM orders AS o JOIN tenants AS t ON t.tenant_id = o.tenant_id
       WHERE o.order_id = ? AND o.tenant_id = ?
       LIMIT 1`,
    )
    .bind(orderId, tenantId)
    .first<OrderFacts>();
}

/** The personalised line indexes whose right the buyer waived; none when unreadable. */
function waivedLineIndexes(order: OrderFacts): Set<number> {
  if (order.is_personalized !== 1) {
    return new Set();
  }
  const consent = readFrozenConsent(order.consent_json);
  // Unreadable consent: the consumer-safe reading — no line is exempt.
  return consent !== null && consent.withdrawal.waived
    ? new Set(consent.withdrawal.personalizedItems)
    : new Set();
}

function shopNoticeAddress(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    return normalizedWithdrawalEmail(value);
  } catch {
    return null;
  }
}

function shopNameSnapshot(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const name = cleanText(value, MAX_SHOP_NAME_LENGTH);
  return name === "" ? null : name;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** An outbox row of the mail effect, written only if `withdrawalId` is the row stored. */
function mailOutboxStatement(
  db: D1Database,
  input: { kind: WithdrawalEmailKind; now: number; outboxId: string; tenantId: string; withdrawalId: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox_events (
         outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
         dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at
       )
       SELECT ?, ?, ?, 'withdrawal', ?, ?, ?, 'pending', ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM withdrawals WHERE withdrawal_id = ?)`,
    )
    .bind(
      input.outboxId,
      input.tenantId,
      WITHDRAWAL_EMAIL_EFFECT,
      input.withdrawalId,
      `${WITHDRAWAL_EMAIL_EFFECT}:${input.kind}:${input.withdrawalId}`,
      // Ids and the kind only: the recipient is the withdrawal row's.
      JSON.stringify({ kind: input.kind, withdrawalId: input.withdrawalId }),
      input.now,
      input.now,
      input.now,
      input.withdrawalId,
    );
}

/**
 * The withdrawal function's one write. See the module header for the rules.
 * `tenantId` is the hostname's; nothing the caller sends names a shop.
 */
export async function submitWithdrawal(
  db: D1Database,
  tenantId: string,
  input: WithdrawalInput,
  now: number,
): Promise<SubmitWithdrawalResult> {
  // ── the lookup: one statement and one comparison, whatever it finds ──────
  // As typed, or upper case: the form every generated number has (source rule).
  const upper = input.orderNumber.toUpperCase();
  const candidate = await db
    .prepare(
      `SELECT order_id, customer_email FROM orders
       WHERE tenant_id = ? AND order_number IN (?, ?)
       ORDER BY order_number = ? DESC
       LIMIT 1`,
    )
    .bind(tenantId, input.orderNumber, upper, input.orderNumber)
    .first<{ customer_email: string; order_id: string }>();
  const purchaseAddress = (candidate?.customer_email ?? "").trim().toLowerCase();
  const addressMatches = await secretMatches(input.contactEmail, purchaseAddress);
  if (candidate === null || !addressMatches) {
    return { status: "not_found" };
  }
  const orderId = candidate.order_id;

  // ── a message already on record: its receipt, nothing written ────────────
  const existing = await readWithdrawalByOrder(db, tenantId, orderId);
  const order = await readOrderFacts(db, tenantId, orderId);
  if (order === null) {
    // Unreachable: the order was just read under the same tenant.
    return { status: "not_found" };
  }
  const lines = await readLines(db, tenantId, orderId);
  if (existing !== null) {
    return { status: "existing", withdrawal: answerOf(existing, order.order_number, lines, true) };
  }

  // ── what the function answers ─────────────────────────────────────────────
  const waived = waivedLineIndexes(order);
  const exemptIndexes = lines.filter((line) => waived.has(line.item_index)).map((line) => line.item_index);
  const coveredIndexes = lines.filter((line) => !waived.has(line.item_index)).map((line) => line.item_index);
  const ageDays = (now - order.created_at) / DAY_MS;
  const reason: WithdrawalReason | null =
    lines.length > 0 && coveredIndexes.length === 0
      ? "personalized_exempt"
      : ageDays > WITHDRAWAL_MAX_AGE_DAYS
        ? "window_passed"
        : null;

  const withdrawalId = crypto.randomUUID();
  const receivedAt = iso(now);
  const shopNotice = shopNoticeAddress(order.support_email);
  const receiptOutboxId = crypto.randomUUID();
  const noticeOutboxId = crypto.randomUUID();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO withdrawals (
           withdrawal_id, tenant_id, order_id, eligible, reason,
           withdrawn_items_json, exempt_items_json, consumer_name, contact_email,
           shop_name, shop_notice_email, received_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM withdrawals WHERE order_id = ?)`,
      )
      .bind(
        withdrawalId,
        tenantId,
        orderId,
        reason === null ? 1 : 0,
        reason,
        JSON.stringify(reason === null ? coveredIndexes : []),
        JSON.stringify(exemptIndexes),
        input.name,
        input.contactEmail,
        shopNameSnapshot(order.shop_name),
        shopNotice,
        receivedAt,
        orderId,
      ),
    mailOutboxStatement(db, {
      kind: "withdrawal_receipt",
      now,
      outboxId: receiptOutboxId,
      tenantId,
      withdrawalId,
    }),
  ];
  if (shopNotice !== null) {
    statements.push(
      mailOutboxStatement(db, {
        kind: "withdrawal_notice",
        now,
        outboxId: noticeOutboxId,
        tenantId,
        withdrawalId,
      }),
    );
  } else {
    // The shop cannot be mailed: the platform is told, by ids only.
    statements.push(
      alertStatement(
        db,
        {
          id: `${WITHDRAWAL_ALERT_KIND}:${withdrawalId}`,
          kind: WITHDRAWAL_ALERT_KIND,
          message: `Withdrawal ${withdrawalId} for order ${orderId} of shop ${tenantId} was received, but the shop has no support address to notify.`,
          nowMs: now,
          resourceId: withdrawalId,
          resourceType: "withdrawal",
          severity: "warning",
          tenantId,
        },
        { binds: [withdrawalId], sql: "EXISTS (SELECT 1 FROM withdrawals WHERE withdrawal_id = ?)" },
      ),
    );
  }
  await db.batch(statements);

  const stored = await readWithdrawalByOrder(db, tenantId, orderId);
  if (stored === null) {
    throw new Error("withdrawal was not stored");
  }
  if (stored.withdrawal_id !== withdrawalId) {
    // A concurrent first message won: its record is the one, and nothing of
    // this call was written (every statement above was conditioned on it).
    return { status: "existing", withdrawal: answerOf(stored, order.order_number, lines, true) };
  }
  return {
    outboxIds: shopNotice === null ? [receiptOutboxId] : [receiptOutboxId, noticeOutboxId],
    status: "created",
    withdrawal: answerOf(stored, order.order_number, lines, false),
  };
}

// ── the admin order read ────────────────────────────────────────────────────

export interface AdminOrderWithdrawal {
  consumerName: string;
  contactEmail: string;
  eligible: boolean;
  exemptItems: WithdrawalLine[];
  /** Whole days between the order and the message, for the shop's assessment. */
  orderAgeDays: number;
  reason: WithdrawalReason | null;
  receivedAt: string;
  /** False when the shop had no support address (an alert was raised). */
  shopNotified: boolean;
  statement: string;
  withdrawalId: string;
  withdrawnItems: WithdrawalLine[];
}

/**
 * The withdrawal on record for one order of this shop, or null. For the shop's
 * own admin order read (`GET /v1/admin/orders/:orderId`, reviewer wiring):
 * the buyer's name and purchase address are the shop's own customer data.
 */
export async function readAdminOrderWithdrawal(
  db: D1Database,
  tenantId: string,
  orderId: string,
): Promise<AdminOrderWithdrawal | null> {
  const row = await readWithdrawalByOrder(db, tenantId, orderId);
  if (row === null) {
    return null;
  }
  const order = await readOrderFacts(db, tenantId, orderId);
  if (order === null) {
    return null;
  }
  const lines = await readLines(db, tenantId, orderId);
  const ack = acknowledgementOf(row, order.order_number, lines);
  return {
    consumerName: ack.consumerName,
    contactEmail: ack.contactEmail,
    eligible: row.eligible === 1,
    exemptItems: ack.exemptItems,
    orderAgeDays: Math.max(0, Math.floor((Date.parse(row.received_at) - order.created_at) / DAY_MS)),
    reason: row.eligible === 1 ? null : row.reason,
    receivedAt: row.received_at,
    shopNotified: row.shop_notice_email !== null,
    statement: ack.statement,
    withdrawalId: row.withdrawal_id,
    withdrawnItems: ack.withdrawnItems,
  };
}

// ── the `withdrawal_email` outbox effect ────────────────────────────────────

/** The ledger's rule: a job lives at most 24 hours. */
const JOB_LIFETIME_MS = 24 * 60 * 60 * 1_000;
/** Enqueue only with room left for the consumer to deliver. */
const MIN_REMAINING_LIFETIME_MS = 10 * 60 * 1_000;

function parsePayload(payloadJson: string): { kind: WithdrawalEmailKind; withdrawalId: string } | null {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (
      isRecord(payload) &&
      Object.keys(payload).length === 2 &&
      isWithdrawalEmailKind(payload.kind) &&
      typeof payload.withdrawalId === "string"
    ) {
      return { kind: payload.kind, withdrawalId: payload.withdrawalId };
    }
  } catch {
    // fall through
  }
  return null;
}

async function failWithdrawalEmail(
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
          message: `Withdrawal email effect ${row.outbox_id} (${row.dedupe_key.split(":").slice(0, 2).join(":")}) for withdrawal ${row.aggregate_id} failed (${error}); the mail was not sent. The withdrawal itself is recorded.`,
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

async function buildWithdrawalEmailJob(
  ctx: EffectContext,
  kind: WithdrawalEmailKind,
  withdrawalId: string,
  tenantId: string,
): Promise<WithdrawalEmailJob | "invalid" | "not_found"> {
  const { env, row } = ctx;
  const withdrawal = await env.DB.prepare(
    `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE withdrawal_id = ? AND tenant_id = ? LIMIT 1`,
  )
    .bind(withdrawalId, tenantId)
    .first<WithdrawalRow>();
  if (withdrawal === null) {
    return "not_found";
  }
  const order = await readOrderFacts(env.DB, tenantId, withdrawal.order_id);
  if (order === null) {
    return "not_found";
  }
  const lines = await readLines(env.DB, tenantId, withdrawal.order_id);
  const recipient = kind === "withdrawal_receipt" ? withdrawal.contact_email : withdrawal.shop_notice_email;
  if (recipient === null) {
    return "invalid";
  }
  const answer = answerOf(withdrawal, order.order_number, lines, false);
  try {
    return createWithdrawalEmailJob({
      createdAt: row.created_at,
      deliveryId: await deliveryIdFromKey(row.dedupe_key),
      expiresAt: row.created_at + JOB_LIFETIME_MS,
      kind,
      recipient,
      tenantId,
      withdrawal: {
        acknowledgement: answer.acknowledgement,
        eligible: answer.eligible,
        reason: answer.reason,
      },
    });
  } catch {
    return "invalid";
  }
}

/**
 * Turns a `withdrawal_email` outbox row into ONE job on EMAIL_QUEUE, ledgered,
 * exactly as the order confirmation effect does (src/outbox/email-effect.ts):
 * the ledger row and the move to `submitting` in one batch under the claim,
 * then the enqueue, then `done`. The job is deterministic (delivery id from the
 * dedupe key, createdAt from the outbox row, content from the immutable
 * withdrawal row and the order's frozen lines), so a retry after a crash
 * enqueues the identical job and the ledger sends it at most once. No
 * `frozen_json` is needed: nothing the job renders is live (the shop's name
 * and address were snapshotted onto the withdrawal row).
 *
 * A failure here never touches the withdrawal: it is recorded before any of
 * this runs. A run that cannot deliver within the ledger's 24 hours fails with
 * an `outbox_failed` alert.
 */
export async function runWithdrawalEmailEffect(ctx: EffectContext): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;
  const payload = parsePayload(row.payload_json);
  if (
    payload === null ||
    row.tenant_id === null ||
    row.aggregate_type !== "withdrawal" ||
    payload.withdrawalId !== row.aggregate_id
  ) {
    return failWithdrawalEmail(ctx, "invalid_payload", true);
  }

  const queue = env.EMAIL_QUEUE;
  if (queue === undefined) {
    return failWithdrawalEmail(ctx, "email_queue_not_configured", false);
  }

  if (ctx.clock() > row.created_at + JOB_LIFETIME_MS - MIN_REMAINING_LIFETIME_MS) {
    return failWithdrawalEmail(ctx, "email_expired", true);
  }

  const job = await buildWithdrawalEmailJob(ctx, payload.kind, payload.withdrawalId, row.tenant_id);
  if (job === "not_found") {
    return failWithdrawalEmail(ctx, "withdrawal_not_found", true);
  }
  if (job === "invalid") {
    return failWithdrawalEmail(ctx, "invalid_email_content", true);
  }

  const now = ctx.clock();
  const recordLedger = await prepareWithdrawalEmailDeliveryRecord(env.DB, job, now);
  const submitting = await markSubmitting(env.DB, claim, {
    now,
    withTransition: (guard) => [recordLedger(guard)],
  });
  if (submitting === null) {
    return { kind: "lost_claim" };
  }

  try {
    await queue.send(job, { contentType: "json" });
  } catch {
    return failWithdrawalEmail(ctx, "email_queue_error", false);
  }

  const doneAt = ctx.clock();
  return outcomeOf(await complete(env.DB, claim, { now: doneAt, resultRef: job.deliveryId }), doneAt);
}
