import { raiseAlert } from "./money-alerts";
import { DAY_MS, refreshPayoutStates } from "./payouts";
import {
  applyRefundFact,
  refundFactFrom,
  releaseReservation,
} from "./refunds";
import type {
  PaymentIntentView,
  StripeMoneyGateway,
} from "./stripe-client";
import {
  isStripeConfigured,
  resolveStripeMoneyGateway,
  StripeGatewayError,
} from "./stripe-client";

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
      // the meantime is never overwritten.
      await db
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
        .bind(status, now, status, now, checkout.checkout_id)
        .run();

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
  dispatch: { stranded: number };
  disputes: { blocked: number; errors: number; recovered: number; retransferred: number; failed: number };
  paymentIntents: { errors: number; listed: number; missingOrders: number };
  payouts: { examined: number; updated: number };
  refunds: { errors: number; released: number; settled: number; unsettled: number };
  retention: { snapshotsWithoutTerminalIntent: number };
  stripe: "configured" | "unconfigured";
}

export async function runReconciliation(
  env: Env,
  now: number,
): Promise<ReconciliationSummary> {
  const db = env.DB;
  const gateway = gatewayFor(env);
  const summary: ReconciliationSummary = {
    alertsRaised: 0,
    dispatch: { stranded: 0 },
    disputes: { blocked: 0, errors: 0, failed: 0, recovered: 0, retransferred: 0 },
    paymentIntents: { errors: 0, listed: 0, missingOrders: 0 },
    payouts: { examined: 0, updated: 0 },
    refunds: { errors: 0, released: 0, settled: 0, unsettled: 0 },
    retention: { snapshotsWithoutTerminalIntent: 0 },
    stripe: gateway === null ? "unconfigured" : "configured",
  };
  const alert = async (...args: Parameters<typeof raiseAlert>) => {
    if (await raiseAlert(...args)) {
      summary.alertsRaised += 1;
    }
  };

  if (gateway !== null) {
    await recoverDisputes(db, gateway, now, summary, alert);
    await reconcileRefunds(db, gateway, now, summary, alert);
    await reconcilePaymentIntents(db, gateway, now, summary, alert);
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

type Alert = (
  db: D1Database,
  alert: Parameters<typeof raiseAlert>[1],
  now: number,
) => Promise<void>;

// ── dispute recovery: the money moves the dispute webhooks queued ───────────

interface RecoveryRow {
  connect_account_id: string | null;
  currency: string;
  dispute_id: string | null;
  dispute_recovery: string;
  dispute_retransferred_minor: number;
  order_id: string;
  stripe_charge_id: string | null;
  stripe_transfer_id: string | null;
  tenant_id: string;
  transfer_reversed_minor: number;
}

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
 *  retransfer_pending the dispute closed in the shop's favour after a
 *                     reversal: transfer exactly what was reversed back,
 *                     idempotency key `dispute-retransfer:{disputeId}`.
 *
 * Every commit is guarded so a replay after a lost D1 write converges: the
 * idempotency key returns the same Stripe object, and the guarded UPDATE
 * applies it once.
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
              transfer_reversed_minor, dispute_retransferred_minor
       FROM orders
       WHERE dispute_recovery IN ('reversal_pending', 'retransfer_pending')
       ORDER BY dispute_updated_at ASC
       LIMIT ?`,
    )
    .bind(RECONCILE_BATCH)
    .all<RecoveryRow>();

  for (const row of rows.results) {
    const disputeId = row.dispute_id ?? row.order_id;

    if (row.dispute_recovery === "reversal_pending") {
      let transferId = row.stripe_transfer_id;
      if (transferId === null && row.stripe_charge_id !== null) {
        try {
          transferId = (await gateway.retrieveCharge(row.stripe_charge_id)).transfer;
        } catch {
          summary.disputes.errors += 1;
          continue;
        }
      }

      if (transferId === null) {
        await db
          .prepare(
            `UPDATE orders SET dispute_recovery = 'no_transfer', dispute_updated_at = ?,
                    updated_at = MAX(updated_at, ?)
             WHERE order_id = ? AND dispute_recovery = 'reversal_pending'`,
          )
          .bind(now, now, row.order_id)
          .run();
        summary.disputes.failed += 1;
        await alert(db, {
          kind: "dispute_recovery_failed",
          message: `order ${row.order_id}: dispute ${disputeId} has no destination transfer to reverse; reconcile manually`,
          resourceId: row.order_id,
          resourceType: "order",
          severity: "critical",
          tenantId: row.tenant_id,
        }, now);
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
        // If the dispute was won between the read and here, the reversal
        // still happened: it is recorded and queued straight back.
        await db
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
          .bind(reversal.amount, reversal.id, transferId, now, now, row.order_id)
          .run();
        summary.disputes.recovered += 1;
      } catch (error) {
        if (error instanceof StripeGatewayError && error.rejected) {
          await db
            .prepare(
              `UPDATE orders SET dispute_recovery = 'shortfall', dispute_updated_at = ?,
                      stripe_transfer_id = COALESCE(stripe_transfer_id, ?),
                      updated_at = MAX(updated_at, ?)
               WHERE order_id = ? AND dispute_recovery = 'reversal_pending'`,
            )
            .bind(now, transferId, now, row.order_id)
            .run();
          summary.disputes.failed += 1;
          await alert(db, {
            kind: "dispute_recovery_failed",
            message: `order ${row.order_id}: Stripe refused the transfer reversal for dispute ${disputeId} (possible shortfall on the connected account)`,
            resourceId: row.order_id,
            resourceType: "order",
            severity: "critical",
            tenantId: row.tenant_id,
          }, now);
        } else {
          summary.disputes.errors += 1;
        }
      }
      continue;
    }

    // retransfer_pending
    const amount = row.transfer_reversed_minor - row.dispute_retransferred_minor;
    if (amount <= 0 || row.connect_account_id === null) {
      await db
        .prepare(
          `UPDATE orders SET dispute_recovery = 'retransfer_failed', dispute_updated_at = ?,
                  updated_at = MAX(updated_at, ?)
           WHERE order_id = ? AND dispute_recovery = 'retransfer_pending'`,
        )
        .bind(now, now, row.order_id)
        .run();
      summary.disputes.failed += 1;
      await alert(db, {
        kind: "dispute_recovery_failed",
        message: `order ${row.order_id}: dispute ${disputeId} closed in the shop's favour but nothing can be re-transferred automatically`,
        resourceId: row.order_id,
        resourceType: "order",
        severity: "critical",
        tenantId: row.tenant_id,
      }, now);
      continue;
    }

    try {
      const transfer = await gateway.createTransfer({
        amount,
        currency: row.currency.toLowerCase(),
        destination: row.connect_account_id,
        idempotencyKey: `dispute-retransfer:${disputeId}`,
        metadata: {
          dispute_id: disputeId,
          order_id: row.order_id,
          reason: "dispute_won_retransfer",
        },
      });
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
        await db
          .prepare(
            `UPDATE orders SET dispute_recovery = 'retransfer_failed', dispute_updated_at = ?,
                    updated_at = MAX(updated_at, ?)
             WHERE order_id = ? AND dispute_recovery = 'retransfer_pending'`,
          )
          .bind(now, now, row.order_id)
          .run();
        summary.disputes.failed += 1;
        await alert(db, {
          kind: "dispute_recovery_failed",
          message: `order ${row.order_id}: Stripe refused re-transferring the reversed funds for dispute ${disputeId}`,
          resourceId: row.order_id,
          resourceType: "order",
          severity: "critical",
          tenantId: row.tenant_id,
        }, now);
      } else {
        summary.disputes.errors += 1;
      }
    }
  }
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
  const listedIntents = new Set<string>();

  for (const intentId of intents) {
    let refunds;
    try {
      refunds = await gateway.listRefunds(intentId);
    } catch {
      summary.refunds.errors += 1;
      continue;
    }

    listedIntents.add(intentId);
    for (const refund of refunds) {
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
      listedIntents.has(op.payment_intent_id) &&
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
      `SELECT outbox_id, tenant_id, aggregate_id, status
       FROM outbox_events
       WHERE event_type = 'dispatch'
         AND status NOT IN (${settled})
         AND created_at <= ?
       ORDER BY created_at ASC
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
