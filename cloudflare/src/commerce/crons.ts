import { nudgeOutbox } from "../outbox/nudge";
import type { ConnectGateway } from "./connect-gateway";
import { disabledReasonFrom, requirementsFrom, resolveConnectGateway } from "./connect-gateway";
import { pendingPrinterCancellationIds, releaseDispatchHolds } from "./dispatch-hold";
import { raiseAlert } from "./money-alerts";
import { DAY_MS, refreshPayoutStates } from "./payouts";
import { releaseCanceledHoldStatement, replayDeferredPaymentEvents } from "./stripe-events";
import {
  applyRefundFact,
  refundFactFrom,
  releaseReservation,
} from "./refunds";
import type {
  PaymentIntentView,
  StripeMoneyGateway,
  TransferReversalView,
  TransferView,
} from "./stripe-client";
import {
  isStripeConfigured,
  resolveStripeFeeRefundGateway,
  resolveStripeMoneyGateway,
  StripeGatewayError,
} from "./stripe-client";
import type { StripeFeeRefundGateway } from "./stripe-client";
import type { WithholdingReleaseSummary } from "./withholding-release";
import {
  discoverWithholdingReleases,
  emptyWithholdingReleaseSummary,
  executeWithholdingReleases,
} from "./withholding-release";

/**
 * D40 (CP2-D2): the 15-minute platform alert digest. Exported here with the
 * other crons for `scheduled()` (the reviewer wires it AFTER reconciliation,
 * so a tick's own alerts are in its digest); implemented in alert-digest.ts.
 */
export { runAlertDigest } from "./alert-digest";

/**
 * The money crons (PLAN §2.2, §2.3). CP2-B owns the `scheduled()` export and
 * calls both every 15 minutes; each returns a JSON-serialisable summary and
 * throws only on a D1 fault (the next run retries). Stripe failures are per
 * item: counted, skipped, retried on the next run.
 *
 * `now` is epoch milliseconds (ScheduledController.scheduledTime).
 */

/** A snapshot is kept at least this long after the intent's last change. */
export const RETENTION_MS = 7 * DAY_MS;

/** Stranded work older than this raises an alert (PLAN §2.2 SLA). */
export const STRANDED_MS = 30 * 60 * 1_000;

/** How far back reconciliation lists PaymentIntents from Stripe. */
export const PAYMENT_INTENT_LOOKBACK_MS = 3 * DAY_MS;

const SWEEP_BATCH = 50;
const RECONCILE_BATCH = 50;
const PAYMENT_INTENT_PAGES = 5;
const PAYMENT_INTENT_PAGE_SIZE = 100;

/** Outbox statuses in which a dispatch row is settled (0021). */
const DISPATCH_SETTLED = ["done", "superseded"] as const;

function gatewayFor(env: Env): StripeMoneyGateway | null {
  return isStripeConfigured(env) ? resolveStripeMoneyGateway(env) : null;
}

/** D36's application-fee calls: their own seam (stripe-client.ts). */
function feeGatewayFor(env: Env): StripeFeeRefundGateway | null {
  return isStripeConfigured(env) ? resolveStripeFeeRefundGateway(env) : null;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════
// RETENTION (PLAN §2.3 "Retention (abandoned checkouts)")
// ═══════════════════════════════════════════════════════════════════════════

export interface RetentionSummary {
  canceled: number;
  errors: number;
  examined: number;
  purged: number;
  skippedLive: number;
  skippedSucceeded: number;
  stripe: "configured" | "unconfigured";
}

/**
 * The rules, exactly as PLAN §2.3 states them:
 *  - a checkout's production snapshot is purged ONLY when (a) its
 *    PaymentIntent is `canceled` — confirmed by the cancel API response or by
 *    `payment_intent.canceled` — or (b) the snapshot is already held by the
 *    committed order the checkout became;
 *  - `requires_payment_method` is NOT terminal;
 *  - the snapshot is kept >= 7 days after the intent's last state change
 *    (`payment_intent_status_at`; the checkout's `updated_at` when no change
 *    was ever recorded). The sweep's own cancel IS a state change, so a
 *    snapshot is purged at the earliest one retention period after the cancel;
 *  - the sweep cancels through Stripe FIRST, which Stripe refuses for an intent
 *    that has already succeeded, and only a confirmed `canceled` makes the
 *    checkout purgeable. A late `payment_intent.succeeded` racing the sweep
 *    therefore finds its checkout still open with its snapshot intact.
 *
 * A checkout that never got an intent is terminal by construction once it has
 * expired (the payment route refuses an expired checkout), so it is purged one
 * retention period after its expiry.
 */
export async function runRetentionSweep(
  env: Env,
  now: number,
): Promise<RetentionSummary> {
  const db = env.DB;
  const gateway = gatewayFor(env);
  const cutoff = now - RETENTION_MS;
  const summary: RetentionSummary = {
    canceled: 0,
    errors: 0,
    examined: 0,
    purged: 0,
    skippedLive: 0,
    skippedSucceeded: 0,
    stripe: gateway === null ? "unconfigured" : "configured",
  };

  // ── Step 1: cancel stale, non-terminal intents through Stripe. ───────────
  if (gateway !== null) {
    const stale = await db
      .prepare(
        `SELECT checkout_id, payment_intent_id
         FROM checkouts
         WHERE status IN ('open', 'expired')
           AND payment_intent_id IS NOT NULL
           AND (payment_intent_status IS NULL
                OR payment_intent_status NOT IN ('succeeded', 'canceled'))
           AND expires_at <= ?
           AND COALESCE(payment_intent_status_at, updated_at) <= ?
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .bind(now, cutoff, SWEEP_BATCH)
      .all<{ checkout_id: string; payment_intent_id: string }>();

    for (const checkout of stale.results) {
      summary.examined += 1;
      const intent = await cancelOrRead(
        gateway,
        checkout.payment_intent_id,
        checkout.checkout_id,
      );
      if (intent === null) {
        summary.errors += 1;
        continue;
      }

      const status = /^[a-z_]{1,40}$/.test(intent.status) ? intent.status : null;
      if (status === null) {
        summary.errors += 1;
        continue;
      }

      // Record what Stripe says the intent IS — canceled (by us or already),
      // succeeded (the late-success race: the webhook will make the order), or
      // still live (processing, requires_capture). Only canceled marks the
      // checkout abandoned. Guarded so a webhook that completed the checkout in
      // the meantime is never overwritten. CP8-DC: a confirmed cancel also
      // releases the checkout's discount hold (0055), in the same batch; the
      // release reads the status this update wrote, so it matches nothing
      // otherwise (a late success leaves the hold to the webhook).
      await db.batch([
        db
          .prepare(
            `UPDATE checkouts
             SET payment_intent_status = ?,
                 payment_intent_status_at = ?,
                 status = CASE WHEN ? = 'canceled' THEN 'abandoned' ELSE status END,
                 updated_at = MAX(updated_at, ?)
             WHERE checkout_id = ?
               AND status IN ('open', 'expired')
               AND (payment_intent_status IS NULL
                    OR payment_intent_status NOT IN ('succeeded', 'canceled'))`,
          )
          .bind(status, now, status, now, checkout.checkout_id),
        releaseCanceledHoldStatement(db, checkout.checkout_id, now),
      ]);

      if (status === "canceled") {
        summary.canceled += 1;
      } else if (status === "succeeded") {
        summary.skippedSucceeded += 1;
      } else {
        summary.skippedLive += 1;
      }
    }
  }

  // ── Step 2: purge snapshots whose checkout is terminal for >= 7 days. ─────
  const purgeable = await db
    .prepare(
      `SELECT checkout_id
       FROM checkouts
       WHERE production_snapshot_json IS NOT NULL
         AND (
           (payment_intent_status = 'canceled'
              AND payment_intent_status_at <= ?1)
           OR (status = 'completed'
              AND COALESCE(payment_intent_status_at, updated_at) <= ?1
              AND EXISTS (SELECT 1 FROM orders
                          WHERE orders.checkout_id = checkouts.checkout_id))
           OR (payment_intent_id IS NULL AND expires_at <= ?1)
         )
       LIMIT ?2`,
    )
    .bind(cutoff, SWEEP_BATCH)
    .all<{ checkout_id: string }>();

  for (const checkout of purgeable.results) {
    // The same conditions again, in the write itself: the purge happens only
    // if the checkout is STILL terminal at the moment it runs.
    const result = await db
      .prepare(
        `UPDATE checkouts
         SET production_snapshot_json = NULL,
             snapshot_purged_at = ?2,
             status = CASE WHEN status IN ('open', 'expired') THEN 'abandoned'
                           ELSE status END,
             updated_at = MAX(updated_at, ?2)
         WHERE checkout_id = ?3
           AND production_snapshot_json IS NOT NULL
           AND (
             (payment_intent_status = 'canceled'
                AND payment_intent_status_at <= ?1)
             OR (status = 'completed'
                AND COALESCE(payment_intent_status_at, updated_at) <= ?1
                AND EXISTS (SELECT 1 FROM orders
                            WHERE orders.checkout_id = checkouts.checkout_id))
             OR (payment_intent_id IS NULL AND expires_at <= ?1)
           )`,
      )
      .bind(cutoff, now, checkout.checkout_id)
      .run();
    summary.purged += result.meta.changes;
  }

  return summary;
}

/**
 * Cancels an intent; when Stripe refuses (already succeeded, processing, …) or
 * the answer is lost, reads it instead. Null when Stripe cannot be reached.
 */
async function cancelOrRead(
  gateway: StripeMoneyGateway,
  paymentIntentId: string,
  checkoutId: string,
): Promise<PaymentIntentView | null> {
  try {
    return await gateway.cancelPaymentIntent(
      paymentIntentId,
      `retention-cancel:${checkoutId}`,
    );
  } catch {
    // Refused (the intent succeeded, or is processing) or unknown: whichever,
    // the intent's own state decides, never the error.
  }

  try {
    return await gateway.retrievePaymentIntent(paymentIntentId);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RECONCILIATION (PLAN §2.2: Stripe ↔ orders ↔ refunds ↔ dispatch, alerts for
// anything stranded > 30 min)
// ═══════════════════════════════════════════════════════════════════════════

export interface ReconciliationSummary {
  alertsRaised: number;
  accounts: { errors: number; resynced: number };
  deferred: { errors: number; released: number; replayed: number; waiting: number };
  dispatch: { stranded: number };
  disputes: { blocked: number; errors: number; recovered: number; retransferred: number; failed: number };
  paymentIntents: { errors: number; listed: number; missingOrders: number };
  payouts: { examined: number; updated: number };
  refunds: {
    errors: number;
    incompleteListings: number;
    released: number;
    settled: number;
    unsettled: number;
  };
  retention: { snapshotsWithoutTerminalIntent: number };
  stripe: "configured" | "unconfigured";
  /** D36: production withholdings returned to shops (withholding-release.ts). */
  withholding: WithholdingReleaseSummary;
}

export async function runReconciliation(
  env: Env,
  now: number,
): Promise<ReconciliationSummary> {
  const db = env.DB;
  const gateway = gatewayFor(env);
  const summary: ReconciliationSummary = {
    alertsRaised: 0,
    accounts: { errors: 0, resynced: 0 },
    deferred: { errors: 0, released: 0, replayed: 0, waiting: 0 },
    dispatch: { stranded: 0 },
    disputes: { blocked: 0, errors: 0, failed: 0, recovered: 0, retransferred: 0 },
    paymentIntents: { errors: 0, listed: 0, missingOrders: 0 },
    payouts: { examined: 0, updated: 0 },
    refunds: { errors: 0, incompleteListings: 0, released: 0, settled: 0, unsettled: 0 },
    retention: { snapshotsWithoutTerminalIntent: 0 },
    stripe: gateway === null ? "unconfigured" : "configured",
    withholding: emptyWithholdingReleaseSummary(),
  };
  const alert = async (...args: Parameters<typeof raiseAlert>) => {
    if (await raiseAlert(...args)) {
      summary.alertsRaised += 1;
    }
  };

  // First, and without Stripe: facts that arrived before their order (0026).
  // A replayed dispute may queue a recovery the step below then performs.
  const deferred = await replayDeferred(env, now);
  summary.deferred = { ...summary.deferred, ...deferred };
  await detectWaitingDeferred(db, now, summary, alert);

  if (gateway !== null) {
    await resyncConnectAccounts(db, gateway, now, summary, alert, resolveConnectGateway(env));
    await recoverDisputes(db, gateway, now, summary, alert);
    await reconcileRefunds(db, gateway, now, summary, alert);
    await reconcilePaymentIntents(db, gateway, now, summary, alert);

    // Refunds just settled may explain what held an order's print job.
    const released = await releaseDispatchHolds(db, { now, paymentIntentId: null });
    summary.deferred.released += released.length;
    await nudgeOutbox(env, released);
  }

  // A full refund of an accepted job queued a printer cancellation: tell the
  // outbox consumer now rather than at its next sweep.
  await nudgeOutbox(env, await pendingPrinterCancellationIds(db, null));

  // D36: production that can never happen returns its withholding to the
  // shop. Discovery (D1 only) after the refunds above settled — it catches
  // what no settlement batch reserved (the cancel route, an in-flight
  // dispatch that honoured its cancellation later); then the Stripe calls.
  summary.withholding.discovered = await discoverWithholdingReleases(db, now);
  const feeGateway = feeGatewayFor(env);
  if (feeGateway !== null) {
    await executeWithholdingReleases(db, feeGateway, now, summary.withholding, (raised) =>
      alert(db, raised, now),
    );
  }

  // Payout states after the money moves above, so they see the new facts.
  summary.payouts = await refreshPayoutStates(db, now);

  await detectStrandedDispatch(db, now, summary, alert);
  await detectBlockedDisputes(db, now, summary, alert);

  // The retention listing (PLAN §2.3): snapshots whose intent is not terminal.
  const listing = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM checkouts
       WHERE production_snapshot_json IS NOT NULL
         AND status <> 'completed'
         AND (payment_intent_status IS NULL
              OR payment_intent_status NOT IN ('succeeded', 'canceled'))`,
    )
    .first<{ n: number }>();
  summary.retention.snapshotsWithoutTerminalIntent = listing?.n ?? 0;

  return summary;
}

// ── deferred payment events (0026) ──────────────────────────────────────────

export interface ReplayDeferredSummary {
  errors: number;
  released: number;
  replayed: number;
}

/**
 * Replays facts parked before their order existed, for every intent whose
 * order now exists, then releases dispatch rows no longer held and nudges
 * them. D1 only, and safe to run as often as wanted.
 *
 * Exported for `scheduled()` to run BEFORE the outbox sweep (review round,
 * P2): a fully refunded order's refund is applied — and its dispatch
 * superseded — before the sweep could claim it. (The hold in dispatch-hold.ts
 * already makes the claim impossible; this makes the order right, promptly.)
 *
 * Each intent is isolated: one that throws is counted and skipped, never the
 * rest of the tick (review round, P3).
 */
export async function replayDeferred(
  env: Env,
  now: number,
): Promise<ReplayDeferredSummary> {
  const db = env.DB;
  const summary: ReplayDeferredSummary = { errors: 0, released: 0, replayed: 0 };
  const ready = await db
    .prepare(
      `SELECT DISTINCT d.payment_intent_id
       FROM deferred_payment_events AS d
       WHERE d.applied_at IS NULL
         AND EXISTS (SELECT 1 FROM orders AS o WHERE o.payment_intent_id = d.payment_intent_id)
       LIMIT ?`,
    )
    .bind(RECONCILE_BATCH)
    .all<{ payment_intent_id: string }>();

  const toNudge: string[] = [];
  const orderIds: string[] = [];
  for (const row of ready.results) {
    try {
      const result = await replayDeferredPaymentEvents(db, row.payment_intent_id, now);
      summary.replayed += result.applied;
      toNudge.push(...result.released);
      if (result.orderId !== null) {
        orderIds.push(result.orderId);
      }
    } catch (error) {
      summary.errors += 1;
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.name : "unknown",
          message: "deferred payment events could not be replayed for one intent",
        }),
      );
    }
  }

  // Holds whose facts were applied by an earlier replay that died before
  // releasing them.
  const released = await releaseDispatchHolds(db, { now, paymentIntentId: null });
  toNudge.push(...released);
  summary.released = new Set(toNudge).size;

  await nudgeOutbox(env, [...toNudge, ...(await pendingPrinterCancellationIds(db, orderIds))]);
  return summary;
}

/**
 * A fact still waiting 30 minutes after it arrived means a paid order that
 * never appeared: alerted per intent.
 */
async function detectWaitingDeferred(
  db: D1Database,
  now: number,
  summary: ReconciliationSummary,
  alert: Alert,
): Promise<void> {
  const waiting = await db
    .prepare(
      `SELECT payment_intent_id, tenant_id, COUNT(*) AS n
       FROM deferred_payment_events
       WHERE applied_at IS NULL AND created_at <= ?
       GROUP BY payment_intent_id, tenant_id
       LIMIT ?`,
    )
    .bind(iso(now - STRANDED_MS), RECONCILE_BATCH)
    .all<{ n: number; payment_intent_id: string; tenant_id: string }>();
  for (const row of waiting.results) {
    summary.deferred.waiting += row.n;
    await alert(db, {
      kind: "payment_event_deferred_30m",
      message: `payment intent ${row.payment_intent_id}: refund or dispute events have waited over 30 minutes for an order that does not exist`,
      resourceId: row.payment_intent_id,
      resourceType: "payment_intent",
      severity: "critical",
      tenantId: row.tenant_id,
    }, now);
  }
}

// ── Connect account resync (0027) ───────────────────────────────────────────

/**
 * Shops whose last two `account.updated` events could not be ordered (same
 * second, different flags): the account is retrieved from Stripe — the
 * current truth, whatever order events arrive in — and its flags written.
 * Guarded on the event time read before the call, so an ordered event that
 * lands meanwhile is never overwritten. A failed retrieval raises an alert
 * (one while open) and is retried every run.
 *
 * THE WATERMARK IS SECOND-ALIGNED (Codex review of f5a93e7, P2). Events are
 * ordered by `event.created × 1000` — whole seconds. Writing the resync's
 * millisecond `now` made every later event created in that SAME second
 * compare as older and be dropped as stale, with nothing left to repair it
 * (a restriction at S+500 ms after a resync at S+100 ms was lost). The resync
 * is therefore recorded "as of the start of its second": an event of that
 * second is a TIE, which stripe-events.ts merges fail-closed and marks for
 * another resync when it disagrees — never silently discarded.
 */
/** `now` (ms) floored to its second: the resolution Stripe orders events in. */
export function secondWatermark(now: number): number {
  return Math.floor(now / 1_000) * 1_000;
}

async function resyncConnectAccounts(
  db: D1Database,
  gateway: StripeMoneyGateway,
  now: number,
  summary: ReconciliationSummary,
  alert: Alert,
  // CP3-F review round 1: the Connect onboarding gateway's status read also
  // returns the requirement list and the disabled reason (the money gateway's
  // AccountView carries the flags only). When it is available — every
  // deployed Worker with a Stripe key — the resync reads through it and writes
  // those two facts in the SAME guarded statement as the flags; when it is not
  // (a test env with only the money fake) the money gateway reads the flags
  // and the two facts stay as they are.
  connect: ConnectGateway | null = null,
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT tenant_id, stripe_account_id, stripe_account_synced_at
       FROM tenants
       WHERE stripe_account_resync_needed = 1 AND stripe_account_id IS NOT NULL
       LIMIT ?`,
    )
    .bind(RECONCILE_BATCH)
    .all<{ stripe_account_id: string; stripe_account_synced_at: number | null; tenant_id: string }>();

  for (const row of rows.results) {
    let account: { charges_enabled: boolean; details_submitted: boolean; payouts_enabled: boolean };
    let facts: { disabledReason: string | null; requirementsJson: string } | null = null;
    try {
      // Reviewer (consolidation): the CAPABILITY FLAGS gate payments, so their
      // re-read must not depend on the newer Connect gateway being able to
      // read this account. When that read fails for any reason, the money
      // gateway — the one this resync was proven with — reads the flags alone
      // and the seller's two facts stay as they are.
      let read = null;
      if (connect !== null) {
        try {
          read = await connect.retrieveAccount(row.stripe_account_id);
          if (read.accountId !== row.stripe_account_id) {
            read = null;
          }
        } catch {
          read = null;
        }
      }
      if (read === null) {
        account = await gateway.retrieveAccount(row.stripe_account_id);
      } else {
        account = {
          charges_enabled: read.chargesEnabled,
          details_submitted: read.detailsSubmitted,
          payouts_enabled: read.payoutsEnabled,
        };
        facts = {
          disabledReason: disabledReasonFrom(read.disabledReason),
          requirementsJson: JSON.stringify(requirementsFrom(read.requirementsDue)),
        };
      }
    } catch {
      summary.accounts.errors += 1;
      await alert(db, {
        kind: "connect_account_resync_failed",
        message: `shop ${row.tenant_id}: its Stripe account's capabilities could not be re-read after two same-second updates; payments may be wrongly disabled`,
        resourceId: row.tenant_id,
        resourceType: "tenant",
        severity: "critical",
        tenantId: row.tenant_id,
      }, now);
      continue;
    }

    const result = await db
      .prepare(
        `UPDATE tenants
         SET stripe_charges_enabled = ?,
             stripe_payouts_enabled = ?,
             stripe_details_submitted = ?,
             stripe_requirements_due_json = CASE WHEN ? = 1 THEN ? ELSE stripe_requirements_due_json END,
             stripe_disabled_reason = CASE WHEN ? = 1 THEN ? ELSE stripe_disabled_reason END,
             stripe_account_synced_at = MAX(COALESCE(stripe_account_synced_at, 0), ?),
             stripe_account_resync_needed = 0,
             updated_at = MAX(updated_at, ?)
         WHERE tenant_id = ? AND stripe_account_id = ?
           AND stripe_account_resync_needed = 1
           AND stripe_account_synced_at IS ?`,
      )
      .bind(
        account.charges_enabled ? 1 : 0,
        account.payouts_enabled ? 1 : 0,
        account.details_submitted ? 1 : 0,
        facts === null ? 0 : 1,
        facts?.requirementsJson ?? null,
        facts === null ? 0 : 1,
        facts?.disabledReason ?? null,
        secondWatermark(now),
        now,
        row.tenant_id,
        row.stripe_account_id,
        row.stripe_account_synced_at,
      )
      .run();
    summary.accounts.resynced += result.meta.changes;
  }
}

// ── dispute recovery: the money moves the dispute webhooks queued ───────────

interface RecoveryRow {
  connect_account_id: string | null;
  currency: string;
  dispute_id: string | null;
  dispute_recovery: string;
  dispute_retransferred_minor: number;
  dispute_reversal_id: string | null;
  order_id: string;
  paid_at: number;
  stripe_charge_id: string | null;
  stripe_transfer_id: string | null;
  tenant_id: string;
  transfer_reversed_minor: number;
}

/** The transfer_group a won dispute's re-transfer carries, to find it again. */
export function retransferGroup(disputeId: string): string {
  return `dispute_retransfer_${disputeId}`;
}

type Alert = (
  db: D1Database,
  alert: Parameters<typeof raiseAlert>[1],
  now: number,
) => Promise<void>;

/**
 * Performs the Stripe calls the dispute handlers recorded as pending, exactly
 * as Firebase does them inline (functions/src/payment/stripeWebhook.ts:54-131,
 * connectParams.buildDisputeReversalParams / buildDisputeReTransferParams):
 *
 *  reversal_pending   reverse the destination transfer IN FULL (no amount:
 *                     whatever remains of it), refund_application_fee FALSE,
 *                     idempotency key `dispute-reversal:{disputeId}`.
 *                     ok → recovered; Stripe refused → shortfall + alert (the
 *                     shop's balance could not cover it); no transfer → alert.
 *  retransfer_pending the dispute closed in the shop's favour: transfer back
 *                     exactly what was reversed, idempotency key
 *                     `dispute-retransfer:{disputeId}`, transfer_group
 *                     retransferGroup(disputeId). Nothing reversed ⇒
 *                     won_no_reversal.
 *
 * STRIPE IS ASKED FIRST (Codex CP2-A P1). A reversal or re-transfer whose
 * answer was lost, or whose D1 write never landed, still EXISTS at Stripe.
 * Before creating one, the run lists the transfer's reversals (metadata
 * dispute_id) or the transfers of the dispute's transfer_group, and records
 * what it finds instead. So a lost answer can neither be repeated after the
 * 24-hour idempotency window nor be mistaken for "nothing was reversed" when
 * the dispute is later won. A listing that is not complete never proves an
 * absence: the row waits for the next run.
 */
async function recoverDisputes(
  db: D1Database,
  gateway: StripeMoneyGateway,
  now: number,
  summary: ReconciliationSummary,
  alert: Alert,
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT order_id, tenant_id, dispute_id, dispute_recovery, currency,
              stripe_charge_id, stripe_transfer_id, connect_account_id,
              transfer_reversed_minor, dispute_retransferred_minor,
              dispute_reversal_id, paid_at
       FROM orders
       WHERE dispute_recovery IN ('reversal_pending', 'retransfer_pending')
       ORDER BY dispute_updated_at ASC
       LIMIT ?`,
    )
    .bind(RECONCILE_BATCH)
    .all<RecoveryRow>();

  const failed = async (
    row: RecoveryRow,
    from: string,
    to: "no_transfer" | "retransfer_failed" | "shortfall",
    message: string,
  ) => {
    await db
      .prepare(
        `UPDATE orders SET dispute_recovery = ?, dispute_updated_at = ?,
                updated_at = MAX(updated_at, ?)
         WHERE order_id = ? AND dispute_recovery = ?`,
      )
      .bind(to, now, now, row.order_id, from)
      .run();
    summary.disputes.failed += 1;
    await alert(db, {
      kind: "dispute_recovery_failed",
      message,
      resourceId: row.order_id,
      resourceType: "order",
      severity: "critical",
      tenantId: row.tenant_id,
    }, now);
  };

  for (const row of rows.results) {
    const disputeId = row.dispute_id ?? row.order_id;

    // ── the transfer, and what Stripe already reversed of it for us ────────
    let transferId = row.stripe_transfer_id;
    if (transferId === null && row.stripe_charge_id !== null) {
      try {
        transferId = (await gateway.retrieveCharge(row.stripe_charge_id)).transfer;
      } catch {
        summary.disputes.errors += 1;
        continue;
      }
    }

    let reversalsComplete = true;
    if (transferId !== null && row.dispute_reversal_id === null) {
      let listing;
      try {
        listing = await gateway.listTransferReversals(transferId);
      } catch {
        summary.disputes.errors += 1;
        continue;
      }

      reversalsComplete = listing.complete;
      const made = listing.data.find((reversal) => reversal.metadata.dispute_id === disputeId);
      if (made !== undefined) {
        // An earlier run's reversal: record it (once) instead of making one.
        const recorded = await recordReversal(db, row.order_id, transferId, made, now);
        if (recorded) {
          row.dispute_reversal_id = made.id;
          row.transfer_reversed_minor += made.amount;
          summary.disputes.recovered += 1;
        }
        if (row.dispute_recovery === "reversal_pending") {
          continue;
        }
      }
    }

    if (row.dispute_recovery === "reversal_pending") {
      if (row.dispute_reversal_id !== null) {
        continue;
      }

      if (transferId === null) {
        await failed(
          row,
          "reversal_pending",
          "no_transfer",
          `order ${row.order_id}: dispute ${disputeId} has no destination transfer to reverse; reconcile manually`,
        );
        continue;
      }

      if (!reversalsComplete) {
        // Cannot rule out a reversal hidden past the page bound; creating one
        // blind could double it. Next run.
        summary.disputes.errors += 1;
        continue;
      }

      try {
        const reversal = await gateway.createTransferReversal({
          idempotencyKey: `dispute-reversal:${disputeId}`,
          metadata: {
            dispute_id: disputeId,
            order_id: row.order_id,
            reason: "dispute_recovery",
          },
          refundApplicationFee: false,
          transferId,
        });
        await recordReversal(db, row.order_id, transferId, reversal, now);
        summary.disputes.recovered += 1;
      } catch (error) {
        if (error instanceof StripeGatewayError && error.rejected) {
          await db
            .prepare("UPDATE orders SET stripe_transfer_id = COALESCE(stripe_transfer_id, ?) WHERE order_id = ?")
            .bind(transferId, row.order_id)
            .run();
          await failed(
            row,
            "reversal_pending",
            "shortfall",
            `order ${row.order_id}: Stripe refused the transfer reversal for dispute ${disputeId} (possible shortfall on the connected account)`,
          );
        } else {
          // Unknown outcome: stays reversal_pending; the next run asks Stripe
          // first, so a reversal that did happen is found, not repeated.
          summary.disputes.errors += 1;
        }
      }
      continue;
    }

    // ── retransfer_pending ──────────────────────────────────────────────────
    const amount = row.transfer_reversed_minor - row.dispute_retransferred_minor;
    if (amount <= 0) {
      if (!reversalsComplete) {
        summary.disputes.errors += 1;
        continue;
      }

      // Stripe holds no reversal for this dispute (or there is no transfer at
      // all): nothing was taken from the shop, so nothing goes back.
      await db
        .prepare(
          `UPDATE orders SET dispute_recovery = 'won_no_reversal', dispute_updated_at = ?,
                  updated_at = MAX(updated_at, ?)
           WHERE order_id = ? AND dispute_recovery = 'retransfer_pending'
             AND transfer_reversed_minor <= dispute_retransferred_minor`,
        )
        .bind(now, now, row.order_id)
        .run();
      continue;
    }

    if (row.connect_account_id === null) {
      await failed(
        row,
        "retransfer_pending",
        "retransfer_failed",
        `order ${row.order_id}: dispute ${disputeId} closed in the shop's favour but has no destination to re-transfer to`,
      );
      continue;
    }

    // An earlier re-transfer whose answer was lost: by this dispute's
    // transfer_group, and — for one made before transfers carried a group —
    // by metadata among the transfers to the shop since the order was paid.
    let found: TransferView | undefined;
    let verified = true;
    try {
      const byGroup = await gateway.listTransfersByGroup(retransferGroup(disputeId));
      found = byGroup.data.find((transfer) => transfer.metadata.dispute_id === disputeId);
      verified = byGroup.complete;
      if (found === undefined) {
        const toShop = await gateway.listTransfersToDestination({
          createdGte: Math.floor(row.paid_at / 1_000),
          destination: row.connect_account_id,
        });
        found = toShop.data.find(
          (transfer) =>
            transfer.metadata.dispute_id === disputeId &&
            transfer.metadata.reason === "dispute_won_retransfer",
        );
        verified = verified && toShop.complete;
      }
    } catch {
      summary.disputes.errors += 1;
      continue;
    }

    if (found === undefined && !verified) {
      // Cannot rule out an earlier re-transfer past the listing bound; sending
      // again blind could pay the shop twice. A human decides.
      summary.disputes.errors += 1;
      await alert(db, {
        kind: "dispute_recovery_failed",
        message: `order ${row.order_id}: could not verify that dispute ${disputeId}'s funds were not already re-transferred (listing incomplete)`,
        resourceId: row.order_id,
        resourceType: "order",
        severity: "warning",
        tenantId: row.tenant_id,
      }, now);
      continue;
    }

    try {
      const transfer =
        found ??
        (await gateway.createTransfer({
          amount,
          currency: row.currency.toLowerCase(),
          destination: row.connect_account_id,
          // v2: the request now carries transfer_group; reusing the v1 key of
          // an earlier group-less attempt would be refused by Stripe (400,
          // same key with different parameters) within 24 hours.
          idempotencyKey: `dispute-retransfer:v2:${disputeId}`,
          metadata: {
            dispute_id: disputeId,
            order_id: row.order_id,
            reason: "dispute_won_retransfer",
          },
          transferGroup: retransferGroup(disputeId),
        }));
      await db
        .prepare(
          `UPDATE orders
           SET dispute_retransferred_minor = dispute_retransferred_minor + ?,
               dispute_retransfer_id = ?,
               dispute_recovery = 'returned_won',
               dispute_updated_at = ?,
               updated_at = MAX(updated_at, ?)
           WHERE order_id = ?
             AND dispute_recovery = 'retransfer_pending'
             AND dispute_retransfer_id IS NULL`,
        )
        .bind(transfer.amount, transfer.id, now, now, row.order_id)
        .run();
      summary.disputes.retransferred += 1;
    } catch (error) {
      if (error instanceof StripeGatewayError && error.rejected) {
        await failed(
          row,
          "retransfer_pending",
          "retransfer_failed",
          `order ${row.order_id}: Stripe refused re-transferring the reversed funds for dispute ${disputeId}`,
        );
      } else {
        summary.disputes.errors += 1;
      }
    }
  }
}

/**
 * Records a reversal made for the order's dispute, once (guarded on no
 * reversal recorded yet). If the dispute closed in the shop's favour meanwhile
 * the state is already retransfer_pending and stays there, now with an amount
 * to return; an open or lost dispute moves to recovered.
 */
async function recordReversal(
  db: D1Database,
  orderId: string,
  transferId: string,
  reversal: TransferReversalView,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE orders
       SET transfer_reversed_minor = transfer_reversed_minor + ?,
           dispute_reversal_id = ?,
           stripe_transfer_id = COALESCE(stripe_transfer_id, ?),
           dispute_recovery = CASE dispute_recovery
             WHEN 'reversal_pending' THEN 'recovered'
             WHEN 'won_no_reversal' THEN 'retransfer_pending'
             ELSE dispute_recovery END,
           dispute_updated_at = ?,
           updated_at = MAX(updated_at, ?)
       WHERE order_id = ? AND dispute_reversal_id IS NULL`,
    )
    .bind(reversal.amount, reversal.id, transferId, now, now, orderId)
    .run();
  return result.meta.changes === 1;
}

// ── refunds ─────────────────────────────────────────────────────────────────

/**
 * Settles what the webhooks did not:
 *  1. operations 'reserved'/'submitted' for > 30 min and orders whose Stripe
 *     `amount_refunded` exceeds what is settled: the intent's refunds are
 *     listed from Stripe and applied as facts (the same deduped path the
 *     webhook uses);
 *  2. an operation still 'reserved' after that, with no refund at Stripe
 *     carrying its id, never reached Stripe — its reservation is released;
 *  3. anything still unsettled raises `refund_unsettled_30m`.
 */
async function reconcileRefunds(
  db: D1Database,
  gateway: StripeMoneyGateway,
  now: number,
  summary: ReconciliationSummary,
  alert: Alert,
): Promise<void> {
  const cutoff = iso(now - STRANDED_MS);
  const staleOps = await db
    .prepare(
      `SELECT r.id, r.tenant_id, r.order_id, r.state, o.payment_intent_id
       FROM refund_operations AS r
       JOIN orders AS o ON o.order_id = r.order_id
       WHERE r.state IN ('reserved', 'submitted') AND r.updated_at <= ?
       ORDER BY r.updated_at ASC
       LIMIT ?`,
    )
    .bind(cutoff, RECONCILE_BATCH)
    .all<{ id: string; order_id: string; payment_intent_id: string; state: string; tenant_id: string }>();
  const unexplained = await db
    .prepare(
      `SELECT order_id, tenant_id, payment_intent_id FROM orders
       WHERE stripe_amount_refunded_minor > refund_succeeded_minor + refund_reserved_minor
       LIMIT ?`,
    )
    .bind(RECONCILE_BATCH)
    .all<{ order_id: string; payment_intent_id: string; tenant_id: string }>();

  const intents = new Set<string>([
    ...staleOps.results.map((op) => op.payment_intent_id),
    ...unexplained.results.map((order) => order.payment_intent_id),
  ]);
  const seenOperationIds = new Set<string>();
  // Intents whose refunds were listed TO COMPLETION: only for these may an
  // operation's absence at Stripe prove it was never received (Codex CP2-A
  // P2 — a truncated listing once looked exhaustive).
  const completelyListed = new Set<string>();

  for (const intentId of intents) {
    let refunds;
    try {
      refunds = await gateway.listRefunds(intentId);
    } catch {
      summary.refunds.errors += 1;
      continue;
    }

    if (refunds.complete) {
      completelyListed.add(intentId);
    } else {
      summary.refunds.incompleteListings += 1;
    }

    for (const refund of refunds.data) {
      const fact = refundFactFrom(refund);
      if (fact === null) {
        continue;
      }

      if (fact.operationId !== null) {
        seenOperationIds.add(fact.operationId);
      }

      const result = await applyRefundFact(
        db,
        { ...fact, paymentIntentId: fact.paymentIntentId ?? intentId },
        now,
      );
      if (result.result === "applied") {
        summary.refunds.settled += 1;
      }
    }
  }

  for (const op of staleOps.results) {
    if (
      op.state === "reserved" &&
      completelyListed.has(op.payment_intent_id) &&
      !seenOperationIds.has(op.id) &&
      (await releaseReservation(db, op.id, now))
    ) {
      summary.refunds.released += 1;
    }
  }

  // What is STILL unsettled after all of that is a human's.
  const still = await db
    .prepare(
      `SELECT id, tenant_id FROM refund_operations
       WHERE state IN ('reserved', 'submitted') AND updated_at <= ?
       LIMIT ?`,
    )
    .bind(cutoff, RECONCILE_BATCH)
    .all<{ id: string; tenant_id: string }>();
  for (const op of still.results) {
    summary.refunds.unsettled += 1;
    await alert(db, {
      kind: "refund_unsettled_30m",
      message: `refund operation ${op.id} has not settled for over 30 minutes`,
      resourceId: op.id,
      resourceType: "refund_operation",
      severity: "warning",
      tenantId: op.tenant_id,
    }, now);
  }

  const stillUnexplained = await db
    .prepare(
      `SELECT order_id, tenant_id FROM orders
       WHERE stripe_amount_refunded_minor > refund_succeeded_minor + refund_reserved_minor
       LIMIT ?`,
    )
    .bind(RECONCILE_BATCH)
    .all<{ order_id: string; tenant_id: string }>();
  for (const order of stillUnexplained.results) {
    summary.refunds.unsettled += 1;
    await alert(db, {
      kind: "refund_unsettled_30m",
      message: `order ${order.order_id}: Stripe reports refunds this platform has not recorded`,
      resourceId: order.order_id,
      resourceType: "order",
      severity: "warning",
      tenantId: order.tenant_id,
    }, now);
  }
}

// ── PaymentIntents ↔ orders ─────────────────────────────────────────────────

/**
 * Lists the last three days of PaymentIntents from Stripe and alerts for every
 * succeeded one this platform created (it names a checkout here) that has no
 * order more than 30 minutes after its charge — a webhook that never arrived
 * or kept failing.
 */
async function reconcilePaymentIntents(
  db: D1Database,
  gateway: StripeMoneyGateway,
  now: number,
  summary: ReconciliationSummary,
  alert: Alert,
): Promise<void> {
  let startingAfter: string | null = null;
  const createdGte = Math.floor((now - PAYMENT_INTENT_LOOKBACK_MS) / 1_000);
  const threshold = now - STRANDED_MS;

  for (let page = 0; page < PAYMENT_INTENT_PAGES; page += 1) {
    let result;
    try {
      result = await gateway.listPaymentIntents({
        createdGte,
        limit: PAYMENT_INTENT_PAGE_SIZE,
        startingAfter,
      });
    } catch {
      summary.paymentIntents.errors += 1;
      return;
    }

    for (const intent of result.data) {
      summary.paymentIntents.listed += 1;
      if (intent.status !== "succeeded") {
        continue;
      }

      const succeededAt = (intent.chargeCreated ?? intent.created) * 1_000;
      if (succeededAt > threshold) {
        continue;
      }

      const row = await db
        .prepare(
          `SELECT c.tenant_id,
                  EXISTS (SELECT 1 FROM orders AS o WHERE o.payment_intent_id = ?1) AS has_order
           FROM checkouts AS c
           WHERE c.payment_intent_id = ?1
           LIMIT 1`,
        )
        .bind(intent.id)
        .first<{ has_order: number; tenant_id: string }>();
      if (row === null || row.has_order === 1) {
        // Not ours (a shared account), or fine.
        continue;
      }

      summary.paymentIntents.missingOrders += 1;
      await alert(db, {
        kind: "order_missing_for_succeeded_pi",
        message: `payment intent ${intent.id} succeeded over 30 minutes ago and has no order`,
        resourceId: intent.id,
        resourceType: "payment_intent",
        severity: "critical",
        tenantId: row.tenant_id,
      }, now);
    }

    const last = result.data[result.data.length - 1];
    if (!result.hasMore || last === undefined) {
      return;
    }

    startingAfter = last.id;
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────

/**
 * Every dispatch outbox row not settled (`done`/`superseded`) more than 30
 * minutes after the order created it: a paid POD line that has not provably
 * reached the printer. CP2-B's sweeper separately alerts on `unknown` rows;
 * this is the order-level net under all of them, including `failed`.
 *
 * NOT stranded (CP2-E, CP2-D1 finding 5), so never re-alerted:
 *   - a failure a human already decided: `last_error = 'resolved_failed'`
 *     (POST /v1/platform/dispatch/:id/resolve, outcome failed — who/when/why
 *     are in its audit row);
 *   - a line whose order is `cancelled` or fully `refunded`: nothing is owed
 *     to the printer any more (an in-flight `unknown` there still has the
 *     sweeper's own dispatch_unknown_30m alert).
 * Excluding them in SQL also keeps them from filling the LIMIT and starving
 * newer stranded rows.
 */
async function detectStrandedDispatch(
  db: D1Database,
  now: number,
  summary: ReconciliationSummary,
  alert: Alert,
): Promise<void> {
  const settled = DISPATCH_SETTLED.map((s) => `'${s}'`).join(", ");
  const rows = await db
    .prepare(
      `SELECT e.outbox_id, e.tenant_id, e.aggregate_id, e.status
       FROM outbox_events AS e
       WHERE e.event_type = 'dispatch'
         AND e.status NOT IN (${settled})
         AND e.created_at <= ?
         AND (e.last_error IS NULL OR e.last_error <> 'resolved_failed')
         AND NOT EXISTS (
           SELECT 1 FROM orders AS o
           WHERE o.order_id = e.aggregate_id
             AND o.tenant_id = e.tenant_id
             AND o.status IN ('cancelled', 'refunded')
         )
       ORDER BY e.created_at ASC
       LIMIT ?`,
    )
    .bind(now - STRANDED_MS, 100)
    .all<{ aggregate_id: string; outbox_id: string; status: string; tenant_id: string | null }>();

  for (const row of rows.results) {
    summary.dispatch.stranded += 1;
    await alert(db, {
      kind: "dispatch_stranded_30m",
      message: `dispatch ${row.outbox_id} for order ${row.aggregate_id} is '${row.status}' after 30 minutes`,
      resourceId: row.outbox_id,
      resourceType: "outbox_event",
      severity: "critical",
      tenantId: row.tenant_id,
    }, now);
  }
}

// ── disputes blocking payouts ───────────────────────────────────────────────

async function detectBlockedDisputes(
  db: D1Database,
  now: number,
  summary: ReconciliationSummary,
  alert: Alert,
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT order_id, tenant_id, dispute_id, dispute_status
       FROM orders
       WHERE payout_state = 'blocked'
         AND dispute_status IS NOT NULL
         AND dispute_status NOT IN ('won', 'lost', 'warning_closed', 'prevented')
         AND dispute_updated_at <= ?
       LIMIT ?`,
    )
    .bind(now - STRANDED_MS, 100)
    .all<{ dispute_id: string | null; dispute_status: string; order_id: string; tenant_id: string }>();

  for (const row of rows.results) {
    summary.disputes.blocked += 1;
    await alert(db, {
      kind: "payout_blocked_dispute",
      message: `order ${row.order_id}: payout blocked by open dispute ${row.dispute_id ?? "unknown"} (${row.dispute_status})`,
      resourceId: row.order_id,
      resourceType: "order",
      severity: "warning",
      tenantId: row.tenant_id,
    }, now);
  }
}
