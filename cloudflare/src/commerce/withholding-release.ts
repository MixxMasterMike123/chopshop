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
    // Asked for exactly amount_minor under an idempotency key, or refused by
    // Stripe: a fee refund that disagrees is outside this design. No money
    // is recorded on a guess; a human reconciles.
    await raiseAlertStatement(
      db,
      {
        kind: "withholding_release_failed",
        message: `withholding release ${release.id}: Stripe fee refund ${fact.id} does not match it (${release.state === "failed" ? "the release was refused" : "different amount"}); reconcile by hand`,
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

export interface WithholdingReleaseSummary {
  discovered: number;
  errors: number;
  failed: number;
  released: number;
  /** "unavailable": no fee-refund gateway (Stripe unconfigured / a fake without it). */
  stripe: "configured" | "unavailable";
  unsettled: number;
}

export function emptyWithholdingReleaseSummary(): WithholdingReleaseSummary {
  return { discovered: 0, errors: 0, failed: 0, released: 0, stripe: "unavailable", unsettled: 0 };
}

interface ExecutableRow extends ReleaseRow {
  payment_intent_id: string;
  stripe_charge_id: string | null;
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
           attempts = attempts + 1,
           stripe_application_fee_id = COALESCE(stripe_application_fee_id, ?),
           updated_at = MAX(updated_at, ?)
       WHERE id = ? AND state IN ('reserved', 'submitted')`,
    )
    .bind(feeId, iso(nowMs), row.id)
    .run();
  return result.meta.changes === 1;
}

async function markFailed(
  db: D1Database,
  row: ExecutableRow,
  feeId: string | null,
  error: string,
  nowMs: number,
): Promise<boolean> {
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
      .bind(feeId, error, iso(nowMs), iso(nowMs), row.id),
    raiseAlertStatement(
      db,
      {
        kind: "withholding_release_failed",
        message: `withholding release ${row.id} for order ${row.order_id}: Stripe refused the application-fee refund (${error}); the shop has not received it — reconcile by hand`,
        resourceId: row.id,
        resourceType: "withholding_release",
        severity: "critical",
        tenantId: row.tenant_id,
      },
      nowMs,
    ),
  ]);
  return results[0]?.meta.changes === 1;
}

/**
 * Performs every reserved/submitted release (bounded), then alerts for any
 * still unsettled 30 minutes after it was decided. Stripe failures are per
 * row: counted, skipped, retried next run.
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
      `SELECT w.id, w.tenant_id, w.order_id, w.amount_minor, w.state,
              w.stripe_application_fee_id, w.stripe_fee_refund_id,
              o.stripe_charge_id, o.payment_intent_id
       FROM withholding_releases AS w
       JOIN orders AS o ON o.order_id = w.order_id
       WHERE w.state IN ('reserved', 'submitted')
       ORDER BY w.updated_at ASC
       LIMIT ?`,
    )
    .bind(EXECUTE_BATCH)
    .all<ExecutableRow>();

  for (const row of rows.results) {
    // ── the fee ──────────────────────────────────────────────────────────
    let feeId = row.stripe_application_fee_id;
    if (feeId === null) {
      try {
        feeId = await gateway.retrieveChargeApplicationFee({
          chargeId: row.stripe_charge_id,
          paymentIntentId: row.payment_intent_id,
        });
      } catch {
        summary.errors += 1;
        continue;
      }
      if (feeId === null || !/^[A-Za-z0-9_]{3,255}$/.test(feeId)) {
        // A charge with an application_fee_amount always carries a fee; its
        // absence is not something a retry fixes by itself — but it is not
        // Stripe refusing either. Left for the stranded alert.
        summary.errors += 1;
        continue;
      }
    }

    // ── a previous create whose answer was lost: ask Stripe first ────────
    if (row.state === "submitted") {
      let listing;
      try {
        listing = await gateway.listApplicationFeeRefunds(feeId);
      } catch {
        summary.errors += 1;
        continue;
      }
      const made = listing.data.find((refund) => refund.metadata.withholding_release_id === row.id);
      if (made !== undefined) {
        const fact = viewFact(made);
        if (fact !== null) {
          const applied = await applyFeeRefundFact(db, { ...fact, feeId, releaseId: row.id }, nowMs);
          if (applied.result === "applied") {
            summary.released += 1;
          }
        }
        continue;
      }
      if (!listing.complete) {
        // Cannot rule out a refund past the page bound; creating one blind
        // could release twice once the idempotency key has expired.
        summary.errors += 1;
        continue;
      }
    }

    // ── write-ahead, then the call ───────────────────────────────────────
    if (!(await markSubmitted(db, row, feeId, nowMs))) {
      continue;
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
        if (await markFailed(db, row, feeId, "stripe_refused", nowMs)) {
          summary.failed += 1;
        }
      } else {
        // Unknown outcome: stays `submitted`; the next run lists first.
        summary.errors += 1;
      }
      continue;
    }

    const fact = viewFact(refund);
    if (fact === null) {
      summary.errors += 1;
      continue;
    }
    const applied = await applyFeeRefundFact(db, { ...fact, feeId, releaseId: row.id }, nowMs);
    if (applied.result === "applied") {
      summary.released += 1;
    }
  }

  const stranded = await db
    .prepare(
      `SELECT id, tenant_id, order_id FROM withholding_releases
       WHERE state IN ('reserved', 'submitted') AND created_at <= ?
       ORDER BY created_at ASC
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
