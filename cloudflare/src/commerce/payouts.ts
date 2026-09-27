/**
 * Payout facts — what the shop nets from one order, from RECORDED facts only.
 *
 * On a destination charge Stripe moves the money itself: the whole charge
 * transfers to the shop's connected account at charge time, the application
 * fee is collected back from it, and Stripe pays the account's balance out on
 * the account's own schedule. So `payout` here is not a payment instruction; it
 * is the order's contribution to that balance and whether the platform
 * considers it settled — the "payout card" of the admin order view.
 *
 *   amount = charged
 *          − refund_succeeded        (each refund reversed its share of the
 *                                     transfer: transfer = gross ⇒ = refund)
 *          − application_fee         (D9: never returned, so never added back)
 *          − transfer_reversed       (dispute recovery reversals)
 *          + dispute_retransferred   (a won dispute's funds sent back)
 *
 * It can be NEGATIVE: a fully refunded order leaves the shop owing the
 * non-refundable fee, and a lost dispute leaves it owing the fee too. That is
 * the honest figure — the connected account's balance goes negative the same
 * way (Firebase's summarizeConnectBalance "negative" risk signal).
 *
 * THE SELLER SEES ONE NUMBER (memory seller-sees-one-number, LAUNCH_TODO A13):
 * the fee is reported as one figure; its split into commission and withheld
 * production is never part of any tenant-admin output.
 */

export const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The right-of-withdrawal window (ångerrätt, 14 days) counted from `paid_at`,
 * after which an order's payout is no longer expected to move back.
 */
export const WITHDRAWAL_WINDOW_MS = 14 * DAY_MS;

export type PayoutState = "blocked" | "eligible" | "paid" | "pending";

/**
 * Dispute statuses that END a dispute. Everything else — including a status
 * Stripe adds later — counts as OPEN, which blocks the payout (fail closed).
 * `warning_closed` is an inquiry that closed without a chargeback; `prevented`
 * a dispute Stripe's prevention stopped.
 */
const CLOSED_DISPUTE_STATUSES: ReadonlySet<string> = new Set([
  "lost",
  "prevented",
  "warning_closed",
  "won",
]);

/** Closed in the SHOP's favour: the money stays with (or returns to) the shop. */
const FAVOURABLE_DISPUTE_STATUSES: ReadonlySet<string> = new Set([
  "prevented",
  "warning_closed",
  "won",
]);

export function isDisputeOpen(status: string | null): boolean {
  return status !== null && !CLOSED_DISPUTE_STATUSES.has(status);
}

export function isDisputeClosed(status: string | null): boolean {
  return status !== null && CLOSED_DISPUTE_STATUSES.has(status);
}

export function isDisputeFavourable(status: string | null): boolean {
  return status !== null && FAVOURABLE_DISPUTE_STATUSES.has(status);
}

/**
 * Whether a dispute stops a refund. Stripe refuses to refund a charge that is
 * being or has been charged back (`needs_response`, `under_review`, `lost`).
 * An inquiry (`warning_*`) leaves the charge refundable — refunding is the
 * usual way to settle one — and so do a won or prevented dispute. An unknown
 * status blocks (fail closed).
 */
export function disputeBlocksRefund(status: string | null): boolean {
  return (
    status !== null &&
    !status.startsWith("warning_") &&
    !FAVOURABLE_DISPUTE_STATUSES.has(status)
  );
}

/** Recovery states that are still waiting for the cron to move money. */
const RECOVERY_IN_FLIGHT: ReadonlySet<string> = new Set([
  "pending_outcome",
  "reversal_pending",
  "retransfer_pending",
]);

export interface PayoutFacts {
  application_fee_minor: number;
  charged_minor: number;
  dispute_recovery: string | null;
  dispute_retransferred_minor: number;
  dispute_status: string | null;
  paid_at: number;
  payout_state: string;
  refund_succeeded_minor: number;
  transfer_reversed_minor: number;
}

export interface Payout {
  amountMinor: number;
  eligibleAt: string;
  state: PayoutState;
}

export function computePayoutAmount(facts: PayoutFacts): number {
  return (
    facts.charged_minor -
    facts.refund_succeeded_minor -
    facts.application_fee_minor -
    facts.transfer_reversed_minor +
    facts.dispute_retransferred_minor
  );
}

/**
 * The payout state the facts imply at `now`.
 *
 *   paid      recorded once and final (no writer yet: a Stripe payout
 *             reconciliation is a later checkpoint)
 *   blocked   a dispute is open, its recovery is still moving money, or the
 *             shop's connected account has payouts disabled
 *   eligible  the 14-day withdrawal window from paid_at has passed
 *   pending   otherwise
 */
export function derivePayoutState(
  facts: PayoutFacts,
  now: number,
  payoutsEnabled: boolean,
): PayoutState {
  if (facts.payout_state === "paid") {
    return "paid";
  }

  if (
    isDisputeOpen(facts.dispute_status) ||
    (facts.dispute_recovery !== null &&
      RECOVERY_IN_FLIGHT.has(facts.dispute_recovery)) ||
    !payoutsEnabled
  ) {
    return "blocked";
  }

  return now >= facts.paid_at + WITHDRAWAL_WINDOW_MS ? "eligible" : "pending";
}

export function computePayout(
  facts: PayoutFacts,
  now: number,
  payoutsEnabled: boolean,
): Payout {
  return {
    amountMinor: computePayoutAmount(facts),
    eligibleAt: new Date(facts.paid_at + WITHDRAWAL_WINDOW_MS).toISOString(),
    state: derivePayoutState(facts, now, payoutsEnabled),
  };
}

export const PAYOUT_FACT_COLUMNS = `o.charged_minor, o.refund_succeeded_minor,
  o.application_fee_minor, o.transfer_reversed_minor,
  o.dispute_retransferred_minor, o.dispute_status, o.dispute_recovery,
  o.paid_at, o.payout_state`;

/**
 * derivePayoutState, as SQL over an `orders` row (alias `o`) — the SAME rules,
 * so the refresh can select exactly the rows whose stored state is wrong.
 * test/money-codex-fixes.test.ts ("P2-6") pins SQL = JS over the whole input matrix.
 */
export function derivedPayoutStateSql(nowParam: string, windowMs: number): string {
  const closed = [...CLOSED_DISPUTE_STATUSES].map((s) => `'${s}'`).join(", ");
  const inFlight = [...RECOVERY_IN_FLIGHT].map((s) => `'${s}'`).join(", ");
  return `CASE
    WHEN o.payout_state = 'paid' THEN 'paid'
    WHEN (o.dispute_status IS NOT NULL AND o.dispute_status NOT IN (${closed}))
      OR o.dispute_recovery IN (${inFlight})
      OR COALESCE((SELECT t.stripe_payouts_enabled FROM tenants AS t
                   WHERE t.tenant_id = o.tenant_id), 0) <> 1
      THEN 'blocked'
    WHEN ${nowParam} >= o.paid_at + ${windowMs} THEN 'eligible'
    ELSE 'pending'
  END`;
}

/**
 * Brings stored `payout_state` in line with the facts.
 *
 * Only rows whose stored state DIFFERS from the derived one are touched, and
 * every touched row is corrected, so it drops out of the next selection. The
 * first version selected "the 500 oldest pending-past-window or blocked
 * orders" and re-read the same persistently blocked ones every run, starving
 * newer orders behind them (Codex CP2-A P2). Now a run either corrects `limit`
 * stale rows or all of them; nothing can be selected twice without changing.
 */
export async function refreshPayoutStates(
  db: D1Database,
  now: number,
  limit = 500,
): Promise<{ examined: number; updated: number }> {
  const derived = derivedPayoutStateSql("?1", WITHDRAWAL_WINDOW_MS);
  const result = await db
    .prepare(
      `UPDATE orders AS o
       SET payout_state = ${derived},
           updated_at = MAX(o.updated_at, ?1)
       WHERE o.order_id IN (
         SELECT o.order_id FROM orders AS o
         WHERE o.payout_state <> 'paid'
           AND o.payout_state <> ${derived}
         ORDER BY o.paid_at ASC
         LIMIT ?2
       )`,
    )
    .bind(now, limit)
    .run();

  return { examined: result.meta.changes, updated: result.meta.changes };
}
