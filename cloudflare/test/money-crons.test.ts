import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runReconciliation, runRetentionSweep } from "../src/commerce/crons";
import { computePayout, refreshPayoutStates } from "../src/commerce/payouts";
import type { TransferReversalView } from "../src/commerce/stripe-client";
import type { SnapshotLine } from "./money-fixtures";
import {
  DAY_MS,
  FakeMoneyStripe,
  moneyEnv,
  next,
  openAlerts,
  orderMoney,
  payCheckout,
  postEvent,
  refundOps,
  seedCheckout,
  seedTenant,
  snapshotJson,
} from "./money-fixtures";

/**
 * The two money crons CP2-B's scheduled() calls every 15 minutes.
 *
 * RETENTION (PLAN §2.3): purge a snapshot only on a CONFIRMED cancel or a
 * committed order; requires_payment_method is not terminal; >= 7 days after the
 * intent's last change; cancel through Stripe FIRST — and the late
 * payment_intent.succeeded racing the sweep.
 *
 * RECONCILIATION (PLAN §2.2): Stripe ↔ orders ↔ refunds ↔ dispatch, alerts for
 * anything stranded > 30 min, idempotent; plus the dispute money moves the
 * webhook queued and the payout-state refresh.
 *
 * Time moves by passing a later `now`; seeded rows sit in the real past.
 */

const TENANT = "tenant-crons";
const MIN = 60 * 1_000;
let accountId: string;
let stripe: FakeMoneyStripe;

const LINE: SnapshotLine = {
  lineNo: 1,
  productionCostMinor: 9_840,
  quantity: 1,
  sku: "2500170",
  withholdMinor: 12_300,
};

beforeAll(async () => {
  accountId = (await seedTenant(TENANT)) as string;
});

beforeEach(() => {
  stripe = new FakeMoneyStripe();
});

async function checkoutRow(checkoutId: string) {
  return env.DB.prepare(
    `SELECT status, payment_intent_status, payment_intent_status_at,
            production_snapshot_json, snapshot_purged_at
     FROM checkouts WHERE checkout_id = ?`,
  )
    .bind(checkoutId)
    .first<{
      payment_intent_status: string | null;
      payment_intent_status_at: number | null;
      production_snapshot_json: string | null;
      snapshot_purged_at: number | null;
      status: string;
    }>();
}

/** An abandoned POD checkout whose intent last changed `ageMs` ago. */
async function staleCheckout(ageMs: number, intentStatus = "requires_payment_method") {
  const at = Date.now() - ageMs;
  const checkout = await seedCheckout({
    connect: { accountId, feeMinor: 13_300, withheldMinor: 12_300 },
    expiresAt: at + DAY_MS / 24,
    paymentIntentStatus: "requires_payment_method",
    paymentIntentStatusAt: at,
    snapshot: snapshotJson([LINE]),
    tenantId: TENANT,
    updatedAt: at,
  });
  stripe.addIntent({
    amount: checkout.totalMinor,
    id: checkout.paymentIntentId as string,
    metadata: { checkout_id: checkout.checkoutId, tenant_id: TENANT },
    status: intentStatus,
  });
  return checkout;
}

// ═══════════════════════════════════════════════════════════════════════════
// RETENTION
// ═══════════════════════════════════════════════════════════════════════════

describe("retention: cancel through Stripe first, purge only what is terminal", () => {
  it("keeps a requires_payment_method intent's snapshot within 7 days (not terminal)", async () => {
    const checkout = await staleCheckout(3 * DAY_MS);

    await runRetentionSweep(moneyEnv(stripe), Date.now());

    expect(stripe.cancelCalls).not.toContain(checkout.paymentIntentId);
    await expect(checkoutRow(checkout.checkoutId)).resolves.toMatchObject({
      payment_intent_status: "requires_payment_method",
      snapshot_purged_at: null,
      status: "open",
    });
    expect((await checkoutRow(checkout.checkoutId))?.production_snapshot_json).not.toBeNull();
  });

  it("cancels after 7 days, then purges only 7 days after the cancel", async () => {
    const checkout = await staleCheckout(8 * DAY_MS);
    const now = Date.now();

    const first = await runRetentionSweep(moneyEnv(stripe), now);

    expect(first.canceled).toBeGreaterThanOrEqual(1);
    expect(stripe.cancelCalls).toContain(checkout.paymentIntentId);
    let row = await checkoutRow(checkout.checkoutId);
    expect(row).toMatchObject({ payment_intent_status: "canceled", status: "abandoned" });
    expect(row?.payment_intent_status_at).toBe(now);
    // The cancel is itself a state change: the snapshot is still there.
    expect(row?.production_snapshot_json).not.toBeNull();

    await runRetentionSweep(moneyEnv(stripe), now + 6 * DAY_MS);
    expect((await checkoutRow(checkout.checkoutId))?.production_snapshot_json).not.toBeNull();

    await runRetentionSweep(moneyEnv(stripe), now + 7 * DAY_MS + MIN);
    row = await checkoutRow(checkout.checkoutId);
    expect(row?.production_snapshot_json).toBeNull();
    expect(row?.snapshot_purged_at).toBe(now + 7 * DAY_MS + MIN);
  });

  it("THE RACE: a late success wins — the cancel is refused, nothing is purged, the order gets the snapshot", async () => {
    const checkout = await staleCheckout(8 * DAY_MS);
    // The buyer paid moments ago; Stripe has it as succeeded, but the webhook
    // has not been processed yet.
    stripe.setIntentStatus(checkout.paymentIntentId as string, "succeeded");
    const snapshotBefore = (await checkoutRow(checkout.checkoutId))?.production_snapshot_json;

    const summary = await runRetentionSweep(moneyEnv(stripe), Date.now());

    expect(stripe.cancelCalls).toContain(checkout.paymentIntentId);
    expect(summary.skippedSucceeded).toBeGreaterThanOrEqual(1);
    await expect(checkoutRow(checkout.checkoutId)).resolves.toMatchObject({
      payment_intent_status: "succeeded",
      snapshot_purged_at: null,
      status: "open",
    });

    // Now the delayed webhook lands: the order is created WITH the snapshot.
    const orderId = await payCheckout(checkout, TENANT);
    const order = await env.DB.prepare(
      "SELECT production_snapshot_json FROM orders WHERE order_id = ?",
    )
      .bind(orderId)
      .first<{ production_snapshot_json: string }>();
    expect(order?.production_snapshot_json).toBe(snapshotBefore);
    const dispatch = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'dispatch' AND aggregate_id = ?",
    )
      .bind(orderId)
      .first<{ n: number }>();
    expect(dispatch?.n).toBe(1);

    // And the checkout's copy goes only once the order holds it for 7 days.
    await runRetentionSweep(moneyEnv(stripe), Date.now());
    expect((await checkoutRow(checkout.checkoutId))?.production_snapshot_json).not.toBeNull();
    await runRetentionSweep(moneyEnv(stripe), Date.now() + 7 * DAY_MS + MIN);
    await expect(checkoutRow(checkout.checkoutId)).resolves.toMatchObject({
      production_snapshot_json: null,
      status: "completed",
    });
  });

  it("leaves a processing intent alone", async () => {
    const checkout = await staleCheckout(8 * DAY_MS, "processing");

    const summary = await runRetentionSweep(moneyEnv(stripe), Date.now());

    expect(summary.skippedLive).toBeGreaterThanOrEqual(1);
    await expect(checkoutRow(checkout.checkoutId)).resolves.toMatchObject({
      payment_intent_status: "processing",
      snapshot_purged_at: null,
      status: "open",
    });
  });

  it("never cancels a checkout whose quote is still live", async () => {
    const at = Date.now() - 8 * DAY_MS;
    const checkout = await seedCheckout({
      expiresAt: Date.now() + DAY_MS,
      paymentIntentStatus: "requires_payment_method",
      paymentIntentStatusAt: at,
      snapshot: snapshotJson([LINE]),
      tenantId: TENANT,
      updatedAt: at,
    });
    stripe.addIntent({ amount: checkout.totalMinor, id: checkout.paymentIntentId as string });

    await runRetentionSweep(moneyEnv(stripe), Date.now());

    expect(stripe.cancelCalls).not.toContain(checkout.paymentIntentId);
  });

  it("purges a snapshot whose intent was canceled by webhook 7+ days ago, without calling Stripe", async () => {
    const checkout = await staleCheckout(8 * DAY_MS);
    await postEvent("payment_intent.canceled", { id: checkout.paymentIntentId, status: "canceled" });
    const canceledAt = (await checkoutRow(checkout.checkoutId))?.payment_intent_status_at as number;

    await runRetentionSweep(moneyEnv(stripe, { STRIPE_SECRET_KEY: undefined }), canceledAt + 7 * DAY_MS + MIN);

    expect(stripe.cancelCalls).toHaveLength(0);
    await expect(checkoutRow(checkout.checkoutId)).resolves.toMatchObject({
      production_snapshot_json: null,
      status: "abandoned",
    });
  });

  it("purges an expired checkout that never had an intent, 7 days after its expiry", async () => {
    const at = Date.now() - 9 * DAY_MS;
    const checkout = await seedCheckout({
      expiresAt: at + DAY_MS,
      paymentIntentId: null,
      snapshot: snapshotJson([LINE]),
      tenantId: TENANT,
      updatedAt: at,
    });

    await runRetentionSweep(moneyEnv(stripe), Date.now());

    await expect(checkoutRow(checkout.checkoutId)).resolves.toMatchObject({
      production_snapshot_json: null,
      status: "abandoned",
    });
  });

  it("counts an unreachable Stripe as an error and changes nothing", async () => {
    const checkout = await staleCheckout(8 * DAY_MS);
    const broken = new FakeMoneyStripe();
    broken.cancelPaymentIntent = async () => {
      throw new Error("network");
    };
    broken.retrievePaymentIntent = async () => {
      throw new Error("network");
    };

    const summary = await runRetentionSweep(moneyEnv(broken), Date.now());

    expect(summary.errors).toBeGreaterThanOrEqual(1);
    await expect(checkoutRow(checkout.checkoutId)).resolves.toMatchObject({
      payment_intent_status: "requires_payment_method",
      status: "open",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════

async function paidOrder(options: { chargeId?: string; pod?: boolean } = {}) {
  const chargeId = options.chargeId ?? next("ch");
  const withheld = options.pod === false ? 0 : 12_300;
  const checkout = await seedCheckout({
    connect: { accountId, feeMinor: 1_000 + withheld, withheldMinor: withheld },
    snapshot: options.pod === false ? null : snapshotJson([LINE]),
    tenantId: TENANT,
    unitPriceMinor: 20_000,
  });
  const orderId = await payCheckout(checkout, TENANT, { latestCharge: chargeId });
  const paymentIntentId = checkout.paymentIntentId as string;
  stripe.addIntent({
    amount: 20_000,
    id: paymentIntentId,
    metadata: { checkout_id: checkout.checkoutId, tenant_id: TENANT },
    status: "succeeded",
  });
  return { chargeId, checkoutId: checkout.checkoutId, orderId, paymentIntentId };
}

async function openDispute(
  order: { chargeId: string; paymentIntentId: string },
  disputeId: string,
): Promise<void> {
  await postEvent("charge.dispute.created", {
    amount: 20_000,
    charge: order.chargeId,
    id: disputeId,
    payment_intent: order.paymentIntentId,
    status: "needs_response",
  });
}

async function payoutOf(orderId: string, now = Date.now()) {
  const row = await env.DB.prepare(
    `SELECT o.*, t.stripe_payouts_enabled FROM orders o JOIN tenants t ON t.tenant_id = o.tenant_id
     WHERE o.order_id = ?`,
  )
    .bind(orderId)
    .first<Parameters<typeof computePayout>[0] & { stripe_payouts_enabled: number }>();
  return computePayout(row!, now, row!.stripe_payouts_enabled === 1);
}

describe("reconciliation: dispute recovery (the money the webhook queued)", () => {
  it("reverses the destination transfer in full, fee kept, keyed on the dispute", async () => {
    const order = await paidOrder({ pod: false });
    stripe.addCharge({ id: order.chargeId, payment_intent: order.paymentIntentId, transfer: "tr_rec_1" }, 20_000);
    await openDispute(order, "dp_rec_1");

    const summary = await runReconciliation(moneyEnv(stripe), Date.now());

    expect(summary.disputes.recovered).toBeGreaterThanOrEqual(1);
    expect(stripe.reversalCalls).toEqual([
      {
        idempotencyKey: "dispute-reversal:dp_rec_1",
        metadata: { dispute_id: "dp_rec_1", order_id: order.orderId, reason: "dispute_recovery" },
        refundApplicationFee: false,
        transferId: "tr_rec_1",
      },
    ]);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      dispute_recovery: "recovered",
      payout_state: "blocked",
      stripe_transfer_id: "tr_rec_1",
      transfer_reversed_minor: 20_000,
    });
    // The shop nets the non-refundable fee as a debt: 20 000 − 1 000 − 20 000.
    await expect(payoutOf(order.orderId)).resolves.toMatchObject({ amountMinor: -1_000, state: "blocked" });

    // Idempotent: nothing moves on the next run.
    await runReconciliation(moneyEnv(stripe), Date.now());
    expect(stripe.reversalCalls).toHaveLength(1);
  });

  it("sends a won dispute's reversed funds back, exactly what was reversed", async () => {
    const order = await paidOrder({ pod: false });
    stripe.addCharge({ id: order.chargeId, payment_intent: order.paymentIntentId, transfer: "tr_won_1" }, 20_000);
    await openDispute(order, "dp_won_1");
    await runReconciliation(moneyEnv(stripe), Date.now());

    await postEvent("charge.dispute.closed", {
      amount: 20_000,
      charge: order.chargeId,
      id: "dp_won_1",
      payment_intent: order.paymentIntentId,
      status: "won",
    });
    await runReconciliation(moneyEnv(stripe), Date.now());

    expect(stripe.transferCalls).toEqual([
      {
        amount: 20_000,
        currency: "sek",
        destination: accountId,
        idempotencyKey: "dispute-retransfer:dp_won_1",
        metadata: { dispute_id: "dp_won_1", order_id: order.orderId, reason: "dispute_won_retransfer" },
        transferGroup: "dispute_retransfer_dp_won_1",
      },
    ]);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      dispute_recovery: "returned_won",
      dispute_retransferred_minor: 20_000,
      payout_state: "pending",
    });
    await expect(payoutOf(order.orderId)).resolves.toMatchObject({ amountMinor: 19_000 });

    await runReconciliation(moneyEnv(stripe), Date.now());
    expect(stripe.transferCalls).toHaveLength(1);
  });

  it("a dispute won while the reversal is in flight is sent straight back", async () => {
    const order = await paidOrder({ pod: false });
    stripe.addCharge({ id: order.chargeId, payment_intent: order.paymentIntentId, transfer: "tr_race_1" }, 20_000);
    await openDispute(order, "dp_race_1");
    const original = stripe.createTransferReversal.bind(stripe);
    stripe.createTransferReversal = async (params): Promise<TransferReversalView> => {
      const reversal = await original(params);
      // The dispute closes won between Stripe's answer and the cron's commit.
      await postEvent("charge.dispute.closed", {
        amount: 20_000,
        charge: order.chargeId,
        id: "dp_race_1",
        payment_intent: order.paymentIntentId,
        status: "won",
      });
      return reversal;
    };

    await runReconciliation(moneyEnv(stripe), Date.now());
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      dispute_recovery: "retransfer_pending",
      transfer_reversed_minor: 20_000,
    });

    await runReconciliation(moneyEnv(stripe), Date.now());
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      dispute_recovery: "returned_won",
      dispute_retransferred_minor: 20_000,
    });
  });

  it("records a shortfall and alerts when Stripe refuses the reversal", async () => {
    const order = await paidOrder({ pod: false });
    stripe.addCharge({ id: order.chargeId, payment_intent: order.paymentIntentId, transfer: "tr_short" }, 20_000);
    stripe.reversalBehaviour = "reject";
    await openDispute(order, "dp_short");

    await runReconciliation(moneyEnv(stripe), Date.now());

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ dispute_recovery: "shortfall" });
    const alerts = await openAlerts("dispute_recovery_failed", order.orderId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "critical", tenant_id: TENANT });
    // Alert messages carry ids and codes, never amounts.
    expect(alerts[0]?.message).not.toMatch(/20000|20 000/);
  });

  it("alerts when the charge has no transfer to reverse", async () => {
    const order = await paidOrder({ pod: false });
    stripe.addCharge({ id: order.chargeId, payment_intent: order.paymentIntentId, transfer: null });
    await openDispute(order, "dp_notr");

    await runReconciliation(moneyEnv(stripe), Date.now());

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ dispute_recovery: "no_transfer" });
    expect(await openAlerts("dispute_recovery_failed", order.orderId)).toHaveLength(1);
  });

  it("retries a reversal whose outcome was unknown on the next run", async () => {
    const order = await paidOrder({ pod: false });
    stripe.addCharge({ id: order.chargeId, payment_intent: order.paymentIntentId, transfer: "tr_retry" }, 20_000);
    await openDispute(order, "dp_retry");
    stripe.reversalBehaviour = "unavailable";

    const first = await runReconciliation(moneyEnv(stripe), Date.now());
    expect(first.disputes.errors).toBeGreaterThanOrEqual(1);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ dispute_recovery: "reversal_pending" });

    stripe.reversalBehaviour = "ok";
    await runReconciliation(moneyEnv(stripe), Date.now());
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ dispute_recovery: "recovered" });
  });
});

describe("reconciliation: refunds", () => {
  async function reserve(orderId: string, amount: number, opId = crypto.randomUUID()) {
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE orders SET refund_reserved_minor = refund_reserved_minor + ?,
           refund_version = refund_version + 1, last_refund_op_id = ? WHERE order_id = ?`,
      ).bind(amount, opId, orderId),
      env.DB.prepare(
        `INSERT INTO refund_operations (id, tenant_id, order_id, amount_minor, state, origin,
           reason, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'reserved', 'admin', 'r', 'user-x', ?, ?)`,
      ).bind(opId, TENANT, orderId, amount, nowIso, nowIso),
    ]);
    return opId;
  }

  it("settles a reserved operation Stripe did create (response and webhook both lost)", async () => {
    const order = await paidOrder({ pod: false });
    const opId = await reserve(order.orderId, 5_000);
    const atStripe = await stripe.createRefund({
      amount: 5_000,
      idempotencyKey: opId,
      metadata: { order_id: order.orderId, refund_operation_id: opId, tenant_id: TENANT },
      paymentIntentId: order.paymentIntentId,
      refundApplicationFee: false,
      reverseTransfer: true,
    });

    // Not yet stale: untouched.
    await runReconciliation(moneyEnv(stripe), Date.now());
    expect((await refundOps(order.orderId))[0]?.state).toBe("reserved");

    const summary = await runReconciliation(moneyEnv(stripe), Date.now() + 31 * MIN);

    expect(summary.refunds.settled).toBeGreaterThanOrEqual(1);
    expect((await refundOps(order.orderId))[0]).toMatchObject({
      id: opId,
      state: "succeeded",
      stripe_refund_id: atStripe.id,
    });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 5_000,
    });
  });

  it("releases a reservation Stripe never received", async () => {
    const order = await paidOrder({ pod: false });
    const opId = await reserve(order.orderId, 5_000);

    const summary = await runReconciliation(moneyEnv(stripe), Date.now() + 31 * MIN);

    expect(summary.refunds.released).toBeGreaterThanOrEqual(1);
    expect((await refundOps(order.orderId))[0]).toMatchObject({ id: opId, state: "released" });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 0,
    });
    expect(await openAlerts("refund_unsettled_30m", opId)).toHaveLength(0);
  });

  it("does NOT release when Stripe cannot be asked", async () => {
    const order = await paidOrder({ pod: false });
    const opId = await reserve(order.orderId, 5_000);
    stripe.listBehaviour = "unavailable";

    await runReconciliation(moneyEnv(stripe), Date.now() + 31 * MIN);

    expect((await refundOps(order.orderId))[0]?.state).toBe("reserved");
    expect(await openAlerts("refund_unsettled_30m", opId)).toHaveLength(1);
  });

  it("alerts once for a refund still pending at Stripe after 30 minutes, again only after resolution", async () => {
    const order = await paidOrder({ pod: false });
    const opId = await reserve(order.orderId, 5_000);
    stripe.refundStatus = "pending";
    const pending = await stripe.createRefund({
      amount: 5_000,
      idempotencyKey: opId,
      metadata: { refund_operation_id: opId },
      paymentIntentId: order.paymentIntentId,
      refundApplicationFee: false,
      reverseTransfer: true,
    });
    expect(pending.status).toBe("pending");

    // First stale run: Stripe has it, so the op moves to 'submitted' — that
    // is progress, and its 30-minute clock restarts from here.
    const later = Date.now() + 31 * MIN;
    await runReconciliation(moneyEnv(stripe), later);
    expect((await refundOps(order.orderId))[0]?.state).toBe("submitted");
    expect(await openAlerts("refund_unsettled_30m", opId)).toHaveLength(0);

    // Still pending at Stripe 30 minutes later: one alert, however many runs.
    await runReconciliation(moneyEnv(stripe), later + 31 * MIN);
    await runReconciliation(moneyEnv(stripe), later + 46 * MIN);
    const alerts = await openAlerts("refund_unsettled_30m", opId);
    expect(alerts).toHaveLength(1);

    // Resolved by an operator while still true: the next run raises a new one.
    await env.DB.prepare("UPDATE alerts SET resolved_at = ? WHERE id = ?")
      .bind(new Date(later + 50 * MIN).toISOString(), alerts[0]?.id)
      .run();
    await runReconciliation(moneyEnv(stripe), later + 61 * MIN);
    const reraised = await openAlerts("refund_unsettled_30m", opId);
    expect(reraised).toHaveLength(1);
    expect(reraised[0]?.id).not.toBe(alerts[0]?.id);
  });

  it("finds dashboard refunds that only charge.refunded reported, and settles them", async () => {
    const order = await paidOrder({ pod: false });
    const dash = stripe.addDashboardRefund(order.paymentIntentId, 3_000);
    await postEvent("charge.refunded", {
      amount: 20_000,
      amount_refunded: 3_000,
      id: order.chargeId,
      payment_intent: order.paymentIntentId,
    });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_succeeded_minor: 0,
      stripe_amount_refunded_minor: 3_000,
    });

    await runReconciliation(moneyEnv(stripe), Date.now());

    expect((await refundOps(order.orderId))[0]).toMatchObject({
      origin: "stripe",
      state: "succeeded",
      stripe_refund_id: dash.id,
    });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ refund_succeeded_minor: 3_000 });
    expect(await openAlerts("refund_unsettled_30m", order.orderId)).toHaveLength(0);
  });
});

describe("reconciliation: Stripe ↔ orders ↔ dispatch ↔ payouts", () => {
  it("alerts once for a succeeded intent with no order after 30 minutes", async () => {
    const now = Date.now();
    const stranded = await seedCheckout({ tenantId: TENANT });
    stripe.addIntent({
      amount: stranded.totalMinor,
      chargeCreated: Math.floor((now - 40 * MIN) / 1_000),
      id: stranded.paymentIntentId as string,
      status: "succeeded",
    });
    const fresh = await seedCheckout({ tenantId: TENANT });
    stripe.addIntent({
      amount: fresh.totalMinor,
      chargeCreated: Math.floor((now - 10 * MIN) / 1_000),
      id: fresh.paymentIntentId as string,
      status: "succeeded",
    });
    const foreignId = next("pi_foreign");
    stripe.addIntent({ amount: 100, chargeCreated: Math.floor((now - DAY_MS) / 1_000), id: foreignId, status: "succeeded" });
    const fine = await paidOrder({ pod: false });

    const summary = await runReconciliation(moneyEnv(stripe), now);
    await runReconciliation(moneyEnv(stripe), now + 15 * MIN);

    expect(summary.paymentIntents.missingOrders).toBe(1);
    const alerts = await openAlerts("order_missing_for_succeeded_pi", stranded.paymentIntentId as string);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ resource_type: "payment_intent", severity: "critical", tenant_id: TENANT });
    expect(await openAlerts("order_missing_for_succeeded_pi", fresh.paymentIntentId as string)).toHaveLength(0);
    expect(await openAlerts("order_missing_for_succeeded_pi", foreignId)).toHaveLength(0);
    expect(await openAlerts("order_missing_for_succeeded_pi", fine.paymentIntentId)).toHaveLength(0);
  });

  it("alerts for a dispatch not settled 30 minutes after the order, never for a settled one", async () => {
    const stuck = await paidOrder();
    const settled = await paidOrder();
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE outbox_events SET status = 'superseded', resolved_at = ?, updated_at = ?
       WHERE event_type = 'dispatch' AND aggregate_id = ?`,
    )
      .bind(now, now, settled.orderId)
      .run();

    await runReconciliation(moneyEnv(stripe), now + 10 * MIN);
    const stuckRow = await env.DB.prepare(
      "SELECT outbox_id FROM outbox_events WHERE event_type = 'dispatch' AND aggregate_id = ?",
    )
      .bind(stuck.orderId)
      .first<{ outbox_id: string }>();
    expect(await openAlerts("dispatch_stranded_30m", stuckRow?.outbox_id)).toHaveLength(0);

    await runReconciliation(moneyEnv(stripe), now + 31 * MIN);
    await runReconciliation(moneyEnv(stripe), now + 46 * MIN);

    expect(await openAlerts("dispatch_stranded_30m", stuckRow?.outbox_id)).toHaveLength(1);
    const settledRow = await env.DB.prepare(
      "SELECT outbox_id FROM outbox_events WHERE event_type = 'dispatch' AND aggregate_id = ?",
    )
      .bind(settled.orderId)
      .first<{ outbox_id: string }>();
    expect(await openAlerts("dispatch_stranded_30m", settledRow?.outbox_id)).toHaveLength(0);
    // Email rows are not dispatch.
    const emailRow = await env.DB.prepare(
      "SELECT outbox_id FROM outbox_events WHERE event_type = 'email' AND aggregate_id = ?",
    )
      .bind(stuck.orderId)
      .first<{ outbox_id: string }>();
    expect(await openAlerts("dispatch_stranded_30m", emailRow?.outbox_id)).toHaveLength(0);
  });

  it("alerts once for a payout blocked by an open dispute after 30 minutes", async () => {
    const order = await paidOrder({ pod: false });
    stripe.addCharge({ id: order.chargeId, payment_intent: order.paymentIntentId, transfer: "tr_blk" }, 20_000);
    await openDispute(order, "dp_blocked");
    const now = Date.now();

    await runReconciliation(moneyEnv(stripe), now);
    expect(await openAlerts("payout_blocked_dispute", order.orderId)).toHaveLength(0);

    await runReconciliation(moneyEnv(stripe), now + 31 * MIN);
    await runReconciliation(moneyEnv(stripe), now + 46 * MIN);
    const alerts = await openAlerts("payout_blocked_dispute", order.orderId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ resource_type: "order", tenant_id: TENANT });
  });

  it("moves payouts to eligible after the 14-day window, and blocks them while the shop's payouts are off", async () => {
    const order = await paidOrder({ pod: false });
    const now = Date.now();

    await refreshPayoutStates(env.DB, now + 13 * DAY_MS);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ payout_state: "pending" });

    await refreshPayoutStates(env.DB, now + 14 * DAY_MS + MIN);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ payout_state: "eligible" });

    // Distinct event times: account.updated applies strictly newer events.
    const second = Math.floor(Date.now() / 1_000) + 3_600;
    await postEvent(
      "account.updated",
      { charges_enabled: true, id: accountId, payouts_enabled: false },
      { created: second },
    );
    await refreshPayoutStates(env.DB, now + 14 * DAY_MS + 2 * MIN);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ payout_state: "blocked" });

    await postEvent(
      "account.updated",
      { charges_enabled: true, id: accountId, payouts_enabled: true },
      { created: second + 1 },
    );
    await refreshPayoutStates(env.DB, now + 14 * DAY_MS + 3 * MIN);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ payout_state: "eligible" });
  });

  it("runs dark but safe without Stripe", async () => {
    const summary = await runReconciliation(moneyEnv(stripe, { STRIPE_SECRET_KEY: undefined }), Date.now());
    expect(summary.stripe).toBe("unconfigured");
    expect(stripe.reversalCalls).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });
});

describe("computePayout — recorded facts only", () => {
  const base = {
    application_fee_minor: 13_300,
    charged_minor: 20_000,
    dispute_recovery: null,
    dispute_retransferred_minor: 0,
    dispute_status: null,
    paid_at: Date.UTC(2026, 8, 1),
    payout_state: "pending",
    refund_succeeded_minor: 0,
    transfer_reversed_minor: 0,
  };

  it.each([
    ["an untouched POD order", {}, 6_700],
    ["a partial refund (fee not returned, D9)", { refund_succeeded_minor: 5_000 }, 1_700],
    ["a full refund (the shop owes the fee)", { refund_succeeded_minor: 20_000 }, -13_300],
    ["a lost dispute after the reversal", { transfer_reversed_minor: 20_000, dispute_status: "lost" }, -13_300],
    ["a won dispute sent back", { dispute_retransferred_minor: 20_000, transfer_reversed_minor: 20_000 }, 6_700],
  ])("%s", (_label, facts, amount) => {
    expect(computePayout({ ...base, ...facts }, base.paid_at, true).amountMinor).toBe(amount);
  });

  it("is blocked while a dispute is open or its money is still moving, and when payouts are off", () => {
    const at = base.paid_at + 20 * DAY_MS;
    expect(computePayout({ ...base, dispute_status: "needs_response" }, at, true).state).toBe("blocked");
    expect(computePayout({ ...base, dispute_status: "some_new_status" }, at, true).state).toBe("blocked");
    expect(computePayout({ ...base, dispute_recovery: "retransfer_pending", dispute_status: "won" }, at, true).state).toBe("blocked");
    expect(computePayout(base, at, false).state).toBe("blocked");
    expect(computePayout({ ...base, dispute_status: "won" }, at, true).state).toBe("eligible");
    expect(computePayout(base, base.paid_at + 14 * DAY_MS - 1, true).state).toBe("pending");
    expect(computePayout(base, base.paid_at + 14 * DAY_MS, true)).toEqual({
      amountMinor: 6_700,
      eligibleAt: new Date(base.paid_at + 14 * DAY_MS).toISOString(),
      state: "eligible",
    });
    expect(computePayout({ ...base, payout_state: "paid", dispute_status: "needs_response" }, at, true).state).toBe("paid");
  });
});
