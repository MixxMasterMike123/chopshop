import type { EffectContext, OutboxRunOutcome } from "../outbox/outbox";
import { fenceGuard } from "../outbox/outbox";

/**
 * The dispatch HOLD: an order's print job may not go out while payment facts
 * about it are still unsettled here.
 *
 * ── WHY (review round, P2) ──────────────────────────────────────────────────
 * A refund that arrives before its order is parked (0026) and replayed right
 * after the order batch. If that replay fails — a transient D1 error, the
 * isolate dying after the commit — the next 15-minute tick runs the outbox
 * sweep BEFORE reconciliation replays the fact, and a fully refunded order is
 * printed. The same holds for `charge.refunded` reporting refunds that no
 * refund event has explained yet.
 *
 * So the order is HELD while either is true:
 *   - a parked fact for its payment intent has not been applied, or
 *   - Stripe's cumulative `amount_refunded` exceeds what is settled + reserved.
 *
 * ── HOW, IN CODE THIS MODULE'S OWNER CONTROLS ───────────────────────────────
 * An `outbox_events` dispatch row becomes claimable only when
 * `next_attempt_at <= now` (CP2-B's claimableGuard). A held row carries
 * `next_attempt_at = DISPATCH_HOLD_UNTIL_MS` (year 9999), so neither the queue
 * consumer nor the sweeper can claim it, whatever order the crons run in:
 *   - the ORDER BATCH inserts dispatch rows already held when a parked fact
 *     exists for the intent (webhook.ts);
 *   - a DEFERRAL, and a `charge.refunded` that leaves refunds unexplained,
 *     hold the order's pending/unknown dispatch rows in their own batch
 *     (stripe-events.ts) — covering an order that committed in between;
 *   - RELEASE (back to `next_attempt_at = now`) happens only in a statement
 *     that re-checks the same condition, after a replay, after a refund
 *     settles, and on every reconciliation / replayDeferred run. A full
 *     refund supersedes the held rows instead (refund-dispatch-stop.ts).
 * Changing `next_attempt_at` on a pending or unknown row is not a status
 * transition, so CP2-B's outbox triggers allow it.
 *
 * ── FOR CP2-B's DISPATCH EFFECT (defence in depth) ──────────────────────────
 * A row claimed BEFORE the hold landed is already past `next_attempt_at`.
 * `noUnappliedDeferredEventsGuard(orderId)` is the same condition as a SQL
 * guard (true ⇔ the order may be dispatched) and `dispatchHeldForPayment` its
 * read; the CP2-A report gives the one-line check for dispatch-effect.ts.
 */

/** 9999-12-31T23:59:59.000Z — "not before this is released". */
export const DISPATCH_HOLD_UNTIL_MS = 253_402_300_799_000;

export interface SqlGuard {
  binds: unknown[];
  sql: string;
}

/**
 * TRUE while the order `orderIdSql` names must not be dispatched. The order id
 * is referenced twice, so a bound `?` needs its value twice.
 */
function heldSql(orderIdSql: string): string {
  return `(
    EXISTS (
      SELECT 1 FROM deferred_payment_events AS hold_d
      JOIN orders AS hold_o ON hold_o.payment_intent_id = hold_d.payment_intent_id
      WHERE hold_o.order_id = ${orderIdSql} AND hold_d.applied_at IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM orders AS hold_r
      WHERE hold_r.order_id = ${orderIdSql}
        AND hold_r.stripe_amount_refunded_minor
            > hold_r.refund_succeeded_minor + hold_r.refund_reserved_minor
    )
  )`;
}

/**
 * The guard CP2-B's dispatch can put in a WHERE: holds (is TRUE) exactly when
 * no parked payment fact for the order is unapplied and every refund Stripe
 * reported is settled or reserved here.
 */
export function noUnappliedDeferredEventsGuard(orderId: string): SqlGuard {
  return { binds: [orderId, orderId], sql: `NOT ${heldSql("?")}` };
}

/** The same condition as a read: true ⇒ do not send this order's job yet. */
export async function dispatchHeldForPayment(
  db: D1Database,
  orderId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT ${heldSql("?")} AS held`)
    .bind(orderId, orderId)
    .first<{ held: number }>();
  return row?.held === 1;
}

/**
 * `next_attempt_at` for a dispatch row inserted in the order batch: held if a
 * parked fact already exists for the order (inserted earlier in that batch).
 */
export function initialDispatchAttemptSql(): string {
  return `CASE WHEN ${heldSql("?")} THEN ${DISPATCH_HOLD_UNTIL_MS} ELSE ? END`;
}

/**
 * Holds the not-yet-sent dispatch rows of the order paid by `paymentIntentId`,
 * if the hold condition is true when the statement runs. No order yet ⇒ no-op.
 */
export function holdDispatchStatement(
  db: D1Database,
  input: { now: number; paymentIntentId: string },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE outbox_events
       SET next_attempt_at = ${DISPATCH_HOLD_UNTIL_MS},
           updated_at = MAX(updated_at, ?)
       WHERE event_type = 'dispatch'
         AND status IN ('pending', 'unknown')
         AND next_attempt_at <> ${DISPATCH_HOLD_UNTIL_MS}
         AND aggregate_id IN (SELECT order_id FROM orders WHERE payment_intent_id = ?)
         AND ${heldSql("outbox_events.aggregate_id")}`,
    )
    .bind(input.now, input.paymentIntentId);
}

/**
 * PARKS a dispatch row the effect already CLAIMED when it finds the order held
 * (Codex review of f5a93e7, P2).
 *
 * `holdDispatchStatement` only reaches rows that are not in flight, so a hold
 * that lands after the claim is discovered by the effect's own
 * `dispatchHeldForPayment` check. Treating that as an ordinary retry (the
 * effect's retryLater) put the row back on a 1, 2, 4 … minute backoff, and
 * every re-claim while the payment facts were still unsettled spent an
 * attempt — ten of them and the job went `failed` for good, which
 * releaseDispatchHolds cannot revive.
 *
 * Instead the claimed row goes back to exactly the HELD state the order batch
 * and holdDispatchStatement produce: `pending`, claim released,
 * `next_attempt_at` = DISPATCH_HOLD_UNTIL_MS. Nothing can claim it until
 * releaseDispatchHolds un-parks it (its existing condition matches it), so no
 * further attempt is spent however long the hold lasts; the attempt that
 * discovered the hold is the only one (0021 makes `attempts` one-way). The
 * order line goes back from a previous attempt's 'submitting' to 'pending',
 * as retryLater does.
 *
 * Atomic with its own re-checks, under the claim's fence: the row must still
 * be ours and `claimed` (never a `submitting` one — its call may be out), the
 * order must STILL be held, and an attempt must remain (a row parked on its
 * last attempt could never be claimed again). Otherwise null, and the caller
 * falls back to its ordinary retry — a released hold then just retries soon,
 * and an exhausted row fails with its alert.
 */
export async function parkForHold(
  ctx: EffectContext,
  line: { orderItemId: string; tenantId: string },
): Promise<OutboxRunOutcome | null> {
  const { claim, env } = ctx;
  const now = ctx.clock();
  const fence = fenceGuard(claim, now);
  const parkable = {
    binds: fence.binds,
    sql: `${fence.sql} AND status = 'claimed' AND attempts < max_attempts
          AND ${heldSql("outbox_events.aggregate_id")}`,
  };

  const results = await env.DB.batch([
    // First, while the row is still claimed: the line.
    env.DB.prepare(
      `UPDATE order_items
       SET dispatch_state = CASE WHEN dispatch_state = 'submitting' THEN 'pending'
                                 ELSE dispatch_state END
       WHERE order_item_id = ? AND tenant_id = ?
         AND EXISTS (SELECT 1 FROM outbox_events WHERE ${parkable.sql})`,
    ).bind(line.orderItemId, line.tenantId, ...parkable.binds),
    env.DB.prepare(
      `UPDATE outbox_events
       SET status = 'pending',
           next_attempt_at = ${DISPATCH_HOLD_UNTIL_MS},
           last_error = 'payment_facts_pending',
           claimed_by = NULL, claim_expires_at = NULL,
           updated_at = MAX(updated_at, ?)
       WHERE ${parkable.sql}
       RETURNING outbox_id`,
    ).bind(now, ...parkable.binds),
  ]);

  return (results[1]?.results.length ?? 0) === 1
    ? { delayMs: DISPATCH_HOLD_UNTIL_MS - now, kind: "retry" }
    : null;
}

/**
 * Releases held dispatch rows whose order is no longer held — of one intent's
 * order, or (null) of every order. Returns the released outbox ids, so a
 * caller holding `env` can nudge the outbox queue at once.
 */
export async function releaseDispatchHolds(
  db: D1Database,
  input: { now: number; paymentIntentId: string | null },
): Promise<string[]> {
  const scope =
    input.paymentIntentId === null
      ? ""
      : "AND aggregate_id IN (SELECT order_id FROM orders WHERE payment_intent_id = ?)";
  const result = await db
    .prepare(
      `UPDATE outbox_events
       SET next_attempt_at = ?, updated_at = MAX(updated_at, ?)
       WHERE event_type = 'dispatch'
         AND status IN ('pending', 'unknown')
         AND next_attempt_at = ${DISPATCH_HOLD_UNTIL_MS}
         ${scope}
         AND NOT ${heldSql("outbox_events.aggregate_id")}
       RETURNING outbox_id`,
    )
    .bind(
      input.now,
      input.now,
      ...(input.paymentIntentId === null ? [] : [input.paymentIntentId]),
    )
    .all<{ outbox_id: string }>();
  return result.results.map((row) => row.outbox_id);
}

/**
 * The outbox ids to nudge after money moved for these orders: pending
 * printer cancellations (a full refund of an accepted job) — so the human is
 * told now, not at the next 15-minute sweep.
 */
export async function pendingPrinterCancellationIds(
  db: D1Database,
  orderIds: readonly string[] | null,
): Promise<string[]> {
  if (orderIds !== null && orderIds.length === 0) {
    return [];
  }

  const scope =
    orderIds === null ? "" : `AND aggregate_id IN (${orderIds.map(() => "?").join(", ")})`;
  const rows = await db
    .prepare(
      `SELECT outbox_id FROM outbox_events
       WHERE event_type = 'printer_cancellation' AND status = 'pending' ${scope}
       LIMIT 100`,
    )
    .bind(...(orderIds ?? []))
    .all<{ outbox_id: string }>();
  return rows.results.map((row) => row.outbox_id);
}
