import { RETURN_CASE_ORDER_STATUSES } from "../dispatch/cancellation";
import type { MoneyAlert } from "./money-alerts";
import { raiseAlertStatement } from "./money-alerts";
import type { HandleWebhookEventResult } from "./payment-events";
import {
  REASON_ALREADY_APPLIED,
  REASON_MALFORMED_OBJECT,
  REASON_REFUND_AMOUNT_MISMATCH,
  REASON_UNKNOWN_ORDER,
  recordOnly,
} from "./payment-events";
import type {
  ApplicationFeeRefundView,
  StripeFeeRefundGateway,
  VerifiedStripeEvent,
} from "./stripe-client";
import { StripeGatewayError } from "./stripe-client";

/**
 * Releasing the production withholding (DECISIONS D36, CP2-D2).
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * The application fee of a POD charge is commission + the frozen production
 * cost the platform keeps to pay the printer (`orders.withheld_minor`). D9
 * makes the fee non-refundable (`refund_application_fee = false`), which is
 * right for the commission and wrong for the withholding when production
 * NEVER happens: the platform would keep printer money it never pays, and the
 * shop's payout would sit negative by that amount.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * When an order's production can provably never happen — fully refunded or
 * cancelled, and every dispatch row superseded BEFORE submission (see
 * releasableSql) — the platform refunds EXACTLY `withheld_minor` of the
 * application fee to the shop (`POST /v1/application_fees/{fee}/refunds`,
 * `amount`). The commission stays (D9). If a printer job was ever accepted,
 * may have been (submitted / unknown), or anything was produced, nothing is
 * released: the printer may be owed.
 *
 * ── RESERVE FIRST (migration 0028) ──────────────────────────────────────────
 *   decide   one `reserved` row per order, born IN THE BATCH that supersedes
 *            the dispatch (refund settlement: refund-dispatch-stop.ts), or by
 *            the reconciliation discovery for the paths that supersede
 *            elsewhere (the cancel route; an in-flight dispatch that honoured
 *            its cancellation later). Same predicate, same statement shape,
 *            idempotent (`order_id` UNIQUE).
 *   execute  reconciliation only (D38's precedent: money moves in the cron):
 *            resolve the charge's application fee; a `submitted` row first
 *            asks Stripe (list the fee's refunds for our metadata) so a lost
 *            answer is found, never repeated; write-ahead `submitted`; create
 *            with idempotency key = the row id.
 *   settle   the API response, `application_fee.refunded` or
 *            `application_fee.refund.updated` (stripe-events.ts) — one batch
 *            moves the row to `succeeded` and writes
 *            `orders.withholding_released_minor`; deduped by the fee refund id.
 */

// ── eligibility ─────────────────────────────────────────────────────────────

/**
 * TRUE when the order (alias `o`) may have its withholding released. Every
 * clause is a fact that cannot be undone (0021: `superseded` is final and
 * `submitted_at` / `unknown_since` are one-way), so an order that is eligible
 * once stays eligible.
 */
export function releasableSql(o: string): string {
  const returnCase = RETURN_CASE_ORDER_STATUSES.map((status) => `'${status}'`).join(", ");
  return `(
    ${o}.withheld_minor > 0
    AND ${o}.withholding_released_minor = 0
    AND (${o}.cancelled_at IS NOT NULL
         OR (${o}.charged_minor > 0 AND ${o}.refund_succeeded_minor >= ${o}.charged_minor))
    AND ${o}.status NOT IN (${returnCase})
    AND EXISTS (
      SELECT 1 FROM outbox_events AS wr_d
      WHERE wr_d.event_type = 'dispatch'
        AND wr_d.aggregate_id = ${o}.order_id AND wr_d.tenant_id = ${o}.tenant_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM outbox_events AS wr_d
      WHERE wr_d.event_type = 'dispatch'
        AND wr_d.aggregate_id = ${o}.order_id AND wr_d.tenant_id = ${o}.tenant_id
        AND (wr_d.status <> 'superseded'
             OR wr_d.submitted_at IS NOT NULL
             OR wr_d.unknown_since IS NOT NULL)
    )
    AND NOT EXISTS (
      SELECT 1 FROM outbox_events AS wr_c
      WHERE wr_c.event_type = 'printer_cancellation' AND wr_c.aggregate_id = ${o}.order_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM order_items AS wr_i
      WHERE wr_i.order_id = ${o}.order_id AND wr_i.tenant_id = ${o}.tenant_id
        AND (wr_i.dispatch_state IN ('submitting', 'accepted', 'unknown', 'failed')
             OR wr_i.printer_job_ref IS NOT NULL
             OR wr_i.dispatched_at IS NOT NULL
             OR wr_i.production_state IS NOT NULL)
    )
  )`;
}

const CAUSE_SQL = (o: string) =>
  `CASE WHEN ${o}.charged_minor > 0 AND ${o}.refund_succeeded_minor >= ${o}.charged_minor
        THEN 'full_refund' ELSE 'order_cancelled' END`;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The reservation, for a batch that may just have superseded the order's
 * dispatch: inserts the `reserved` row iff the order is releasable when the
 * statement runs (so it must come AFTER the supersede statements). A no-op
 * otherwise, and on every repeat.
 */
export function reserveReleaseStatement(
  db: D1Database,
  input: { nowMs: number; orderId: string; tenantId: string },
): D1PreparedStatement {
  const now = iso(input.nowMs);
  return db
    .prepare(
      `INSERT INTO withholding_releases (
         id, tenant_id, order_id, amount_minor, state, cause, attempts,
         created_at, updated_at
       )
       SELECT ?, o.tenant_id, o.order_id, o.withheld_minor, 'reserved',
              ${CAUSE_SQL("o")}, 0, ?, ?
       FROM orders AS o
       WHERE o.order_id = ? AND o.tenant_id = ? AND ${releasableSql("o")}
       ON CONFLICT(order_id) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), now, now, input.orderId, input.tenantId);
}

/**
 * Reconciliation's net under every path: reserves a release for each
 * releasable order that has none. The first WHERE clauses repeat 0028's
 * partial index predicate verbatim, so the scan is over that index only.
 */
export async function discoverWithholdingReleases(
  db: D1Database,
  nowMs: number,
  limit = 50,
): Promise<number> {
  const now = iso(nowMs);
  const result = await db
    .prepare(
      `INSERT INTO withholding_releases (
         id, tenant_id, order_id, amount_minor, state, cause, attempts,
         created_at, updated_at
       )
       SELECT lower(hex(randomblob(16))), o.tenant_id, o.order_id, o.withheld_minor,
              'reserved', ${CAUSE_SQL("o")}, 0, ?, ?
       FROM orders AS o
       WHERE o.withheld_minor > 0
         AND o.withholding_released_minor = 0
         AND (o.cancelled_at IS NOT NULL OR (o.charged_minor > 0 AND o.refund_succeeded_minor >= o.charged_minor))
         AND NOT EXISTS (SELECT 1 FROM withholding_releases AS w WHERE w.order_id = o.order_id)
         AND ${releasableSql("o")}
       ORDER BY o.paid_at
       LIMIT ?
       ON CONFLICT(order_id) DO NOTHING`,
    )
    .bind(now, now, limit)
    .run();
  return result.meta.changes;
}

// ── settlement ──────────────────────────────────────────────────────────────

export type ReleaseState = "failed" | "reserved" | "submitted" | "succeeded";

interface ReleaseRow {
  amount_minor: number;
  id: string;
  order_id: string;
  state: ReleaseState;
  stripe_application_fee_id: string | null;
  stripe_fee_refund_id: string | null;
  tenant_id: string;
}

const RELEASE_COLUMNS = `id, tenant_id, order_id, amount_minor, state,
  stripe_application_fee_id, stripe_fee_refund_id`;

/**
 * The one batch that settles a release: the row to `succeeded` (only from
 * reserved/submitted — a replay changes nothing) and the order's payout fact
 * from the succeeded row itself, so the money can never be counted twice.
 */
function settleStatements(
  db: D1Database,
  input: { feeId: string | null; feeRefundId: string; nowMs: number; orderId: string; releaseId: string },
): D1PreparedStatement[] {
  const now = iso(input.nowMs);
  const succeeded = `SELECT w.amount_minor FROM withholding_releases AS w
                     WHERE w.order_id = orders.order_id AND w.state = 'succeeded'`;
  return [
    db
      .prepare(
        `UPDATE withholding_releases
         SET state = 'succeeded',
             stripe_fee_refund_id = ?,
             stripe_application_fee_id = COALESCE(stripe_application_fee_id, ?),
             settled_at = MAX(?, created_at),
             last_error = NULL,
             updated_at = MAX(updated_at, ?)
         WHERE id = ? AND state IN ('reserved', 'submitted')`,
      )
      .bind(input.feeRefundId, input.feeId, now, now, input.releaseId),
    db
      .prepare(
        `UPDATE orders
         SET withholding_released_minor = (${succeeded}),
             updated_at = MAX(updated_at, ?)
         WHERE order_id = ?
           AND withholding_released_minor = 0
           AND EXISTS (${succeeded})`,
      )
      .bind(input.nowMs, input.orderId),
  ];
}

export interface FeeRefundFact {
  amount: number;
  /** The application fee it refunds, when the object names it. */
  feeId: string | null;
  id: string;
  /** metadata.withholding_release_id — set on every refund this worker makes. */
  releaseId: string | null;
}

function stripeIdOf(value: unknown): string | null {
  const id =
    typeof value === "object" && value !== null ? (value as { id?: unknown }).id : value;
  return typeof id === "string" && /^[A-Za-z0-9_]{3,255}$/.test(id) ? id : null;
}

/** A `fee_refund` object (event payload or API response) as a fact, or null. */
export function feeRefundFactFrom(value: unknown): FeeRefundFact | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = stripeIdOf(candidate.id);
  const amount = candidate.amount;
  if (id === null || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }
  const metadata =
    typeof candidate.metadata === "object" && candidate.metadata !== null
      ? (candidate.metadata as Record<string, unknown>)
      : {};
  const releaseId = metadata.withholding_release_id;
  return {
    amount,
    feeId: stripeIdOf(candidate.fee),
    id,
    releaseId: typeof releaseId === "string" && releaseId.length > 0 ? releaseId : null,
  };
}

function viewFact(view: ApplicationFeeRefundView): FeeRefundFact | null {
  return feeRefundFactFrom({
    amount: view.amount,
    fee: view.fee,
    id: view.id,
    metadata: view.metadata,
  });
}

export type FeeRefundFactResult =
  | { result: "amount_mismatch"; tenantId: string }
  | { result: "applied"; tenantId: string }
  | { result: "unchanged"; tenantId: string }
  | { result: "unknown" };

async function findReleaseForFact(
  db: D1Database,
  fact: FeeRefundFact,
): Promise<ReleaseRow | null> {
  const byRefund = await db
    .prepare(`SELECT ${RELEASE_COLUMNS} FROM withholding_releases WHERE stripe_fee_refund_id = ? LIMIT 1`)
    .bind(fact.id)
    .first<ReleaseRow>();
  if (byRefund !== null || fact.releaseId === null) {
    return byRefund;
  }
  return db
    .prepare(
      `SELECT ${RELEASE_COLUMNS} FROM withholding_releases
       WHERE id = ? AND stripe_fee_refund_id IS NULL LIMIT 1`,
    )
    .bind(fact.releaseId)
    .first<ReleaseRow>();
}

/**
 * Applies one Stripe fact about one fee refund. Idempotent: the same fact
 * twice, or the API response racing the webhook, settle at most once.
 */
export async function applyFeeRefundFact(
  db: D1Database,
  fact: FeeRefundFact,
  nowMs: number,
): Promise<FeeRefundFactResult> {
  const release = await findReleaseForFact(db, fact);
  if (release === null) {
    return { result: "unknown" };
  }

  if (release.state === "succeeded") {
    return { result: "unchanged", tenantId: release.tenant_id };
  }

  if (release.amount_minor !== fact.amount || release.state === "failed") {
    // Asked for exactly amount_minor under an idempotency key, or already
    // given up on (refused, or out of attempts): a fee refund that disagrees
    // is outside this design. No money is recorded on a guess; a human
    // reconciles. A late fact on a FAILED release gets its own alert kind, so
    // the release's open `withholding_release_failed` alert cannot hide that
    // Stripe did make it after all.
    const late = release.state === "failed" && release.amount_minor === fact.amount;
    await raiseAlertStatement(
      db,
      {
        kind: late ? "withholding_release_unmatched" : "withholding_release_failed",
        message: late
          ? `withholding release ${release.id} was marked failed, but Stripe reports fee refund ${fact.id} for it: the shop HAS received it — record it by hand`
          : `withholding release ${release.id}: Stripe fee refund ${fact.id} does not match it (${release.state === "failed" ? "the release had failed" : "different amount"}); reconcile by hand`,
        resourceId: release.id,
        resourceType: "withholding_release",
        severity: "critical",
        tenantId: release.tenant_id,
      },
      nowMs,
    ).run();
    return { result: "amount_mismatch", tenantId: release.tenant_id };
  }

  const results = await db.batch(
    settleStatements(db, {
      feeId: fact.feeId ?? release.stripe_application_fee_id,
      feeRefundId: fact.id,
      nowMs,
      orderId: release.order_id,
      releaseId: release.id,
    }),
  );
  return results[0]?.meta.changes === 1
    ? { result: "applied", tenantId: release.tenant_id }
    : { result: "unchanged", tenantId: release.tenant_id };
}

// ── the webhook: application_fee.refunded / application_fee.refund.updated ──

/**
 * D1 only, like every handler in stripe-events.ts. `application_fee.refund.
 * updated` carries one `fee_refund`; `application_fee.refunded` carries the
 * ApplicationFee with its latest refunds embedded (`refunds.data`, up to 10 —
 * the executor's listing covers anything beyond). A fee refund on one of our
 * orders' fees that no release made (the Stripe dashboard) raises a warning:
 * the payout facts do not include it.
 */
export async function handleApplicationFeeEvent(
  db: D1Database,
  event: VerifiedStripeEvent,
  nowMs: number,
): Promise<HandleWebhookEventResult> {
  const object = event.data.object;
  if (typeof object !== "object" || object === null || Array.isArray(object)) {
    return recordOnly(db, event, null, null, "rejected", REASON_MALFORMED_OBJECT, nowMs);
  }
  const record = object as Record<string, unknown>;

  let facts: FeeRefundFact[];
  let objectId: string;
  let chargeId: string | null = null;
  if (event.type === "application_fee.refund.updated") {
    const fact = feeRefundFactFrom(record);
    if (fact === null) {
      return recordOnly(db, event, null, null, "rejected", REASON_MALFORMED_OBJECT, nowMs);
    }
    facts = [fact];
    objectId = fact.id;
  } else {
    const feeId = stripeIdOf(record.id);
    if (feeId === null) {
      return recordOnly(db, event, null, null, "rejected", REASON_MALFORMED_OBJECT, nowMs);
    }
    const embedded = record.refunds;
    const list =
      typeof embedded === "object" &&
      embedded !== null &&
      Array.isArray((embedded as { data?: unknown }).data)
        ? (embedded as { data: unknown[] }).data
        : [];
    facts = list
      .map((refund) => feeRefundFactFrom(refund))
      .filter((fact): fact is FeeRefundFact => fact !== null)
      .map((fact) => ({ ...fact, feeId: fact.feeId ?? feeId }));
    objectId = feeId;
    chargeId = stripeIdOf(record.charge);
  }

  const results: FeeRefundFactResult[] = [];
  for (const fact of facts) {
    results.push(await applyFeeRefundFact(db, fact, nowMs));
  }

  const known = results.find(
    (result): result is Exclude<FeeRefundFactResult, { result: "unknown" }> =>
      result.result !== "unknown",
  );
  let tenantId = known?.tenantId ?? null;

  // A fee refund we did not make, on the fee of one of our orders.
  if (results.some((result) => result.result === "unknown") && chargeId !== null) {
    const order = await db
      .prepare("SELECT order_id, tenant_id FROM orders WHERE stripe_charge_id = ? LIMIT 1")
      .bind(chargeId)
      .first<{ order_id: string; tenant_id: string }>();
    if (order !== null) {
      tenantId = tenantId ?? order.tenant_id;
      await raiseAlertStatement(
        db,
        {
          kind: "withholding_release_unmatched",
          message: `order ${order.order_id}: application fee ${objectId} was refunded outside the withholding release; the payout facts do not include it`,
          resourceId: order.order_id,
          resourceType: "order",
          severity: "warning",
          tenantId: order.tenant_id,
        },
        nowMs,
      ).run();
    }
  }

  if (tenantId === null) {
    return recordOnly(db, event, null, objectId, "ignored", REASON_UNKNOWN_ORDER, nowMs);
  }
  if (results.some((result) => result.result === "amount_mismatch")) {
    return recordOnly(db, event, tenantId, objectId, "rejected", REASON_REFUND_AMOUNT_MISMATCH, nowMs);
  }
  const applied = results.some((result) => result.result === "applied");
  return recordOnly(
    db,
    event,
    tenantId,
    objectId,
    "processed",
    applied ? null : REASON_ALREADY_APPLIED,
    nowMs,
  );
}

// ── execution (reconciliation) ──────────────────────────────────────────────

/** Stranded work older than this raises an alert (PLAN §2.2 SLA). */
const STRANDED_MS = 30 * 60 * 1_000;
const EXECUTE_BATCH = 50;

/**
 * Attempts per release before it is given up (`failed` + a critical alert).
 * With RELEASE_RETRY_BASE_MS doubling to the cap: 10 attempts span about 30
 * hours — a Stripe outage longer than that is a human's anyway, and the
 * 30-minute stranded alert told one long before.
 */
export const MAX_RELEASE_ATTEMPTS = 10;
/**
 * The first retry: under the 15-minute cron cadence, so the very next tick
 * retries even when its clock runs a little early.
 */
export const RELEASE_RETRY_BASE_MS = 10 * 60 * 1_000;
export const RELEASE_RETRY_CAP_MS = 6 * 60 * 60 * 1_000;

/** Delay after attempt number `attempt` (1-based): 10, 20, 40 … min, ≤ 6 h. */
export function releaseRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(Math.floor(attempt) - 1, 20));
  return Math.min(RELEASE_RETRY_BASE_MS * 2 ** exponent, RELEASE_RETRY_CAP_MS);
}

export interface WithholdingReleaseSummary {
  discovered: number;
  errors: number;
  failed: number;
  /** Rows given up after MAX_RELEASE_ATTEMPTS (also counted in `failed`). */
  gaveUp: number;
  released: number;
  /** "unavailable": no fee-refund gateway (Stripe unconfigured / a fake without it). */
  stripe: "configured" | "unavailable";
  unsettled: number;
}

export function emptyWithholdingReleaseSummary(): WithholdingReleaseSummary {
  return {
    discovered: 0,
    errors: 0,
    failed: 0,
    gaveUp: 0,
    released: 0,
    stripe: "unavailable",
    unsettled: 0,
  };
}

interface ExecutableRow extends ReleaseRow {
  attempts: number;
  payment_intent_id: string;
  stripe_charge_id: string | null;
}

/**
 * The attempt stamp — FIRST, before any Stripe call, on every row the run
 * touches (Codex CP2-D2 P2: rows that failed early used to keep their place
 * at the head of the queue forever). A CAS on the attempts count read by the
 * selection, so it doubles as this run's claim: a concurrent run, or a row
 * settled meanwhile, makes it a no-op. Returns the attempt number, or null.
 */
async function stampAttempt(
  db: D1Database,
  row: ExecutableRow,
  nowMs: number,
): Promise<number | null> {
  const attempt = row.attempts + 1;
  const result = await db
    .prepare(
      `UPDATE withholding_releases
       SET attempts = attempts + 1,
           last_attempt_at = ?1,
           next_attempt_at = ?2,
           updated_at = MAX(updated_at, ?1)
       WHERE id = ?3 AND attempts = ?4
         AND state IN ('reserved', 'submitted')
         AND next_attempt_at <= ?1`,
    )
    .bind(iso(nowMs), iso(nowMs + releaseRetryDelayMs(attempt)), row.id, row.attempts)
    .run();
  return result.meta.changes === 1 ? attempt : null;
}

async function markSubmitted(
  db: D1Database,
  row: ExecutableRow,
  feeId: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE withholding_releases
       SET state = 'submitted',
           stripe_application_fee_id = COALESCE(stripe_application_fee_id, ?),
           updated_at = MAX(updated_at, ?)
       WHERE id = ? AND state IN ('reserved', 'submitted')`,
    )
    .bind(feeId, iso(nowMs), row.id)
    .run();
  return result.meta.changes === 1;
}

/**
 * → failed, and its critical alert IN THE SAME BATCH, the alert conditioned
 * on this batch's transition (the settled_at it stamped — NULL until a row
 * settles, 0028) and deduped on an open alert for the release — so a failure
 * is never recorded without its alert, and never alerted twice.
 */
async function markFailed(
  db: D1Database,
  row: ExecutableRow,
  feeId: string | null,
  error: string,
  message: string,
  nowMs: number,
): Promise<boolean> {
  const now = iso(nowMs);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE withholding_releases
         SET state = 'failed',
             stripe_application_fee_id = COALESCE(stripe_application_fee_id, ?),
             last_error = ?,
             settled_at = MAX(?, created_at),
             updated_at = MAX(updated_at, ?)
         WHERE id = ? AND state IN ('reserved', 'submitted')`,
      )
      .bind(feeId, error, now, now, row.id),
    db
      .prepare(
        `INSERT INTO alerts (
           id, tenant_id, kind, severity, message, resource_type, resource_id, created_at
         )
         SELECT ?, ?, 'withholding_release_failed', 'critical', ?, 'withholding_release', ?, ?
         WHERE EXISTS (
             SELECT 1 FROM withholding_releases
             WHERE id = ? AND state = 'failed' AND last_error = ? AND settled_at = MAX(?, created_at)
           )
           AND NOT EXISTS (
             SELECT 1 FROM alerts
             WHERE kind = 'withholding_release_failed'
               AND resource_type = 'withholding_release'
               AND resource_id = ? AND resolved_at IS NULL
           )`,
      )
      .bind(
        `withholding_release_failed:${crypto.randomUUID()}`,
        row.tenant_id,
        message.slice(0, 1_000),
        row.id,
        now,
        row.id,
        error,
        now,
        row.id,
      ),
  ]);
  return results[0]?.meta.changes === 1;
}

type AttemptOutcome =
  | { kind: "failed" }
  | { kind: "released" }
  | { kind: "retry"; error: string }
  | { kind: "skipped" };

/** One attempt at one (already stamped) release. Never throws on Stripe. */
async function attemptRelease(
  db: D1Database,
  gateway: StripeFeeRefundGateway,
  row: ExecutableRow,
  nowMs: number,
): Promise<AttemptOutcome> {
  // ── the fee ────────────────────────────────────────────────────────────
  let feeId = row.stripe_application_fee_id;
  if (feeId === null) {
    try {
      feeId = await gateway.retrieveChargeApplicationFee({
        chargeId: row.stripe_charge_id,
        paymentIntentId: row.payment_intent_id,
      });
    } catch {
      return { error: "fee_lookup_failed", kind: "retry" };
    }
    if (feeId === null || !/^[A-Za-z0-9_]{3,255}$/.test(feeId)) {
      // A charge with an application_fee_amount always carries a fee; its
      // absence is not Stripe refusing, so it is retried — and given up with
      // an alert after the last attempt.
      return { error: "fee_not_found", kind: "retry" };
    }
  }

  // ── a previous create whose answer was lost: ask Stripe first ──────────
  if (row.state === "submitted") {
    let listing;
    try {
      listing = await gateway.listApplicationFeeRefunds(feeId);
    } catch {
      return { error: "fee_refund_listing_failed", kind: "retry" };
    }
    const made = listing.data.find((refund) => refund.metadata.withholding_release_id === row.id);
    if (made !== undefined) {
      const fact = viewFact(made);
      if (fact === null) {
        return { error: "fee_refund_unreadable", kind: "retry" };
      }
      const applied = await applyFeeRefundFact(db, { ...fact, feeId, releaseId: row.id }, nowMs);
      return applied.result === "applied" ? { kind: "released" } : { kind: "skipped" };
    }
    if (!listing.complete) {
      // Cannot rule out a refund past the page bound; creating one blind
      // could release twice once the idempotency key has expired.
      return { error: "fee_refund_listing_incomplete", kind: "retry" };
    }
  }

  // ── write-ahead, then the call ─────────────────────────────────────────
  if (!(await markSubmitted(db, row, feeId, nowMs))) {
    return { kind: "skipped" };
  }

  let refund: ApplicationFeeRefundView;
  try {
    refund = await gateway.createApplicationFeeRefund({
      amount: row.amount_minor,
      applicationFeeId: feeId,
      idempotencyKey: row.id,
      // Join keys only.
      metadata: {
        order_id: row.order_id,
        tenant_id: row.tenant_id,
        withholding_release_id: row.id,
      },
    });
  } catch (error) {
    if (error instanceof StripeGatewayError && error.rejected) {
      return (await markFailed(
        db,
        row,
        feeId,
        "stripe_refused",
        `withholding release ${row.id} for order ${row.order_id}: Stripe refused the application-fee refund (stripe_refused); the shop has not received it — reconcile by hand`,
        nowMs,
      ))
        ? { kind: "failed" }
        : { kind: "skipped" };
    }
    // Unknown outcome: stays `submitted`; the next attempt lists first.
    return { error: "fee_refund_outcome_unknown", kind: "retry" };
  }

  const fact = viewFact(refund);
  if (fact === null) {
    return { error: "fee_refund_unreadable", kind: "retry" };
  }
  const applied = await applyFeeRefundFact(db, { ...fact, feeId, releaseId: row.id }, nowMs);
  return applied.result === "applied" ? { kind: "released" } : { kind: "skipped" };
}

/**
 * Performs the DUE reserved/submitted releases (bounded, least recently
 * attempted first), then alerts for any still unsettled 30 minutes after it
 * was decided. Every attempted row is stamped first (attempts,
 * last_attempt_at, a backed-off next_attempt_at) whatever happens next, so a
 * row that keeps failing moves to the back of the queue and can never starve
 * the others; after MAX_RELEASE_ATTEMPTS it is given up with an alert.
 */
export async function executeWithholdingReleases(
  db: D1Database,
  gateway: StripeFeeRefundGateway,
  nowMs: number,
  summary: WithholdingReleaseSummary,
  raise: (alert: MoneyAlert) => Promise<void>,
): Promise<void> {
  summary.stripe = "configured";
  const rows = await db
    .prepare(
      `SELECT w.id, w.tenant_id, w.order_id, w.amount_minor, w.state, w.attempts,
              w.stripe_application_fee_id, w.stripe_fee_refund_id,
              o.stripe_charge_id, o.payment_intent_id
       FROM withholding_releases AS w
       JOIN orders AS o ON o.order_id = w.order_id
       WHERE w.state IN ('reserved', 'submitted')
         AND w.next_attempt_at <= ?
       ORDER BY w.next_attempt_at ASC, w.created_at ASC, w.id ASC
       LIMIT ?`,
    )
    .bind(iso(nowMs), EXECUTE_BATCH)
    .all<ExecutableRow>();

  for (const row of rows.results) {
    const attempt = await stampAttempt(db, row, nowMs);
    if (attempt === null) {
      continue;
    }

    const outcome = await attemptRelease(db, gateway, row, nowMs);
    if (outcome.kind === "released") {
      summary.released += 1;
      continue;
    }
    if (outcome.kind === "failed") {
      summary.failed += 1;
      continue;
    }
    if (outcome.kind === "skipped") {
      continue;
    }

    summary.errors += 1;
    if (attempt >= MAX_RELEASE_ATTEMPTS) {
      const gaveUp = await markFailed(
        db,
        row,
        null,
        "attempts_exhausted",
        `withholding release ${row.id} for order ${row.order_id}: given up after ${attempt} attempts (last: ${outcome.error}); the shop has not received it${row.state === "submitted" ? " unless Stripe holds a fee refund made by an earlier attempt — check the application fee" : ""} — reconcile by hand`,
        nowMs,
      );
      if (gaveUp) {
        summary.failed += 1;
        summary.gaveUp += 1;
      }
    }
  }

  // One alert per stranded release: rows that already have an open one are
  // not selected, so more than a batch of stranded rows cannot starve the
  // newer ones of theirs either.
  const stranded = await db
    .prepare(
      `SELECT w.id, w.tenant_id, w.order_id FROM withholding_releases AS w
       WHERE w.state IN ('reserved', 'submitted') AND w.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM alerts AS a
           WHERE a.kind = 'withholding_release_unsettled_30m'
             AND a.resource_type = 'withholding_release'
             AND a.resource_id = w.id AND a.resolved_at IS NULL
         )
       ORDER BY w.created_at ASC
       LIMIT ?`,
    )
    .bind(iso(nowMs - STRANDED_MS), EXECUTE_BATCH)
    .all<{ id: string; order_id: string; tenant_id: string }>();
  for (const row of stranded.results) {
    summary.unsettled += 1;
    await raise({
      kind: "withholding_release_unsettled_30m",
      message: `withholding release ${row.id} for order ${row.order_id} has not settled for over 30 minutes`,
      resourceId: row.id,
      resourceType: "withholding_release",
      severity: "warning",
      tenantId: row.tenant_id,
    });
  }
}
