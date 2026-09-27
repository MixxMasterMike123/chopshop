import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { nextRecovery } from "../src/commerce/stripe-events";
import {
  next,
  openAlerts,
  orderMoney,
  payCheckout,
  paymentEventRow,
  postEvent,
  seedCheckout,
  seedTenant,
} from "./money-fixtures";

/**
 * The event matrix (src/commerce/stripe-events.ts): every type other than
 * payment_intent.succeeded, each idempotent through the payment_events ledger,
 * each a D1-only fact — the Stripe-side money moves a dispute needs are queued
 * as recovery states for the reconciliation cron (test/money-crons.test.ts).
 */

const TENANT = "tenant-events";
let accountId: string;

beforeAll(async () => {
  accountId = (await seedTenant(TENANT)) as string;
});

async function checkoutState(checkoutId: string) {
  return env.DB.prepare(
    "SELECT status, payment_intent_status, payment_intent_status_at FROM checkouts WHERE checkout_id = ?",
  )
    .bind(checkoutId)
    .first<{ payment_intent_status: string | null; payment_intent_status_at: number | null; status: string }>();
}

async function paidOrder(): Promise<{ chargeId: string; orderId: string; paymentIntentId: string }> {
  const chargeId = next("ch");
  const checkout = await seedCheckout({
    connect: { accountId, feeMinor: 1_000, withheldMinor: 0 },
    tenantId: TENANT,
    unitPriceMinor: 20_000,
  });
  const orderId = await payCheckout(checkout, TENANT, { latestCharge: chargeId });
  return { chargeId, orderId, paymentIntentId: checkout.paymentIntentId as string };
}

function dispute(
  order: { chargeId: string; paymentIntentId: string },
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    amount: 20_000,
    charge: order.chargeId,
    currency: "sek",
    id: "dp_events_1",
    object: "dispute",
    payment_intent: order.paymentIntentId,
    reason: "fraudulent",
    status,
    ...overrides,
  };
}

describe("payment_intent.payment_failed / payment_intent.canceled", () => {
  it("records a failed attempt as the intent's state — not terminal", async () => {
    const checkout = await seedCheckout({ tenantId: TENANT });
    const before = Date.now();

    const { eventId, response } = await postEvent("payment_intent.payment_failed", {
      id: checkout.paymentIntentId,
      object: "payment_intent",
      status: "requires_payment_method",
    });

    expect(response.status).toBe(200);
    const state = await checkoutState(checkout.checkoutId);
    expect(state).toMatchObject({ payment_intent_status: "requires_payment_method", status: "open" });
    expect(state?.payment_intent_status_at).toBeGreaterThanOrEqual(before);
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({ outcome: "processed", tenant_id: TENANT });
  });

  it("records a cancel, and a later failure never regresses it", async () => {
    const checkout = await seedCheckout({ tenantId: TENANT });

    await postEvent("payment_intent.canceled", { id: checkout.paymentIntentId, status: "canceled" });
    await postEvent("payment_intent.payment_failed", {
      id: checkout.paymentIntentId,
      status: "requires_payment_method",
    });

    await expect(checkoutState(checkout.checkoutId)).resolves.toMatchObject({
      payment_intent_status: "canceled",
    });
  });

  it("never regresses a succeeded intent", async () => {
    const order = await paidOrder();
    const checkout = await env.DB.prepare("SELECT checkout_id FROM orders WHERE order_id = ?")
      .bind(order.orderId)
      .first<{ checkout_id: string }>();

    await postEvent("payment_intent.payment_failed", {
      id: order.paymentIntentId,
      status: "requires_payment_method",
    });

    await expect(checkoutState(checkout?.checkout_id as string)).resolves.toMatchObject({
      payment_intent_status: "succeeded",
      status: "completed",
    });
  });

  it("ignores an intent no checkout claims, and rejects a malformed one", async () => {
    const unknown = await postEvent("payment_intent.canceled", { id: next("pi_unknown") });
    await expect(paymentEventRow(unknown.eventId)).resolves.toMatchObject({
      outcome: "ignored",
      reason_code: "unknown_payment_intent",
    });
    const malformed = await postEvent("payment_intent.payment_failed", { id: 7 });
    await expect(paymentEventRow(malformed.eventId)).resolves.toMatchObject({
      outcome: "rejected",
      reason_code: "malformed_object",
    });
  });
});

describe("nextRecovery (the Firebase dispute rules)", () => {
  it.each([
    // current,            status,            next
    [null, "needs_response", "reversal_pending"],
    [null, "warning_needs_response", "reversal_pending"],
    ["reversal_pending", "under_review", "reversal_pending"],
    ["recovered", "under_review", "recovered"],
    ["recovered", "won", "retransfer_pending"],
    ["reversal_pending", "won", "won_no_reversal"],
    ["shortfall", "won", "won_no_reversal"],
    ["no_transfer", "won", "won_no_reversal"],
    [null, "won", "won_no_reversal"],
    ["retransfer_pending", "won", "retransfer_pending"],
    ["returned_won", "won", "returned_won"],
    ["pending_outcome", "lost", "reversal_pending"],
    [null, "lost", "reversal_pending"],
    ["recovered", "lost", "recovered"],
    ["reversal_pending", "lost", "reversal_pending"],
    ["shortfall", "lost", "shortfall"],
    // Deliberate difference from Firebase: an inquiry that closed took no
    // money from anyone, so a reversal made on creation goes back.
    ["recovered", "warning_closed", "retransfer_pending"],
    ["recovered", "prevented", "retransfer_pending"],
    // An unknown status is OPEN.
    [null, "some_new_status", "reversal_pending"],
  ] as const)("%s + %s → %s", (current, status, expected) => {
    expect(nextRecovery(current, status)).toBe(expected);
  });
});

describe("charge.dispute.*", () => {
  it("created: records the dispute, blocks the payout, queues the reversal", async () => {
    const order = await paidOrder();

    const { eventId, response } = await postEvent(
      "charge.dispute.created",
      dispute(order, "needs_response", { id: "dp_created_1" }),
    );

    expect(response.status).toBe(200);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      dispute_amount_minor: 20_000,
      dispute_id: "dp_created_1",
      dispute_recovery: "reversal_pending",
      dispute_status: "needs_response",
      payout_state: "blocked",
      stripe_charge_id: order.chargeId,
    });
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({
      object_id: "dp_created_1",
      outcome: "processed",
      tenant_id: TENANT,
    });
  });

  it("finds the order by charge when the dispute carries no intent", async () => {
    const order = await paidOrder();

    await postEvent("charge.dispute.created", dispute(order, "needs_response", {
      id: "dp_by_charge",
      payment_intent: null,
    }));

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ dispute_id: "dp_by_charge" });
  });

  it("updated: refreshes status and amount, leaves recovery alone", async () => {
    const order = await paidOrder();
    await postEvent("charge.dispute.created", dispute(order, "needs_response", { id: "dp_upd" }));

    await postEvent("charge.dispute.updated", dispute(order, "under_review", { amount: 15_000, id: "dp_upd" }));

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      dispute_amount_minor: 15_000,
      dispute_recovery: "reversal_pending",
      dispute_status: "under_review",
      payout_state: "blocked",
    });
  });

  it("closed won after the reversal: queues the re-transfer and keeps the payout blocked until it lands", async () => {
    const order = await paidOrder();
    await postEvent("charge.dispute.created", dispute(order, "needs_response", { id: "dp_won" }));
    await env.DB.prepare(
      "UPDATE orders SET dispute_recovery = 'recovered', transfer_reversed_minor = 20000 WHERE order_id = ?",
    )
      .bind(order.orderId)
      .run();

    await postEvent("charge.dispute.closed", dispute(order, "won", { id: "dp_won" }));

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      dispute_recovery: "retransfer_pending",
      dispute_status: "won",
      payout_state: "blocked",
    });
  });

  it("closed won before the cron reversed anything: nothing moves, the payout unblocks", async () => {
    const order = await paidOrder();
    await postEvent("charge.dispute.created", dispute(order, "needs_response", { id: "dp_won_early" }));

    await postEvent("charge.dispute.closed", dispute(order, "won", { id: "dp_won_early" }));

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      dispute_recovery: "won_no_reversal",
      dispute_status: "won",
      payout_state: "pending",
    });
  });

  it("closed lost after the reversal: final, nothing more to move", async () => {
    const order = await paidOrder();
    await postEvent("charge.dispute.created", dispute(order, "needs_response", { id: "dp_lost" }));
    await env.DB.prepare("UPDATE orders SET dispute_recovery = 'recovered' WHERE order_id = ?")
      .bind(order.orderId)
      .run();

    await postEvent("charge.dispute.closed", dispute(order, "lost", { id: "dp_lost" }));

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      dispute_recovery: "recovered",
      dispute_status: "lost",
      payout_state: "pending",
    });
  });

  it("never reopens a closed dispute on a late event", async () => {
    const order = await paidOrder();
    await postEvent("charge.dispute.created", dispute(order, "needs_response", { id: "dp_late" }));
    await postEvent("charge.dispute.closed", dispute(order, "won", { id: "dp_late" }));

    await postEvent("charge.dispute.updated", dispute(order, "under_review", { id: "dp_late" }));

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      dispute_recovery: "won_no_reversal",
      dispute_status: "won",
    });
  });

  it("is idempotent per event id", async () => {
    const order = await paidOrder();
    const eventId = next("evt_dp");
    const object = dispute(order, "needs_response", { id: "dp_replay" });

    await postEvent("charge.dispute.created", object, { eventId });
    await env.DB.prepare("UPDATE orders SET dispute_recovery = 'recovered' WHERE order_id = ?")
      .bind(order.orderId)
      .run();
    const replay = await postEvent("charge.dispute.created", object, { eventId });

    expect(replay.response.status).toBe(200);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ dispute_recovery: "recovered" });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_events WHERE event_id = ?")
      .bind(eventId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("ignores a dispute on a charge that is not an order here", async () => {
    const { eventId } = await postEvent("charge.dispute.created", {
      amount: 100,
      charge: next("ch_foreign"),
      id: "dp_foreign",
      payment_intent: next("pi_foreign"),
      status: "needs_response",
    });
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({
      outcome: "ignored",
      reason_code: "unknown_order",
    });
  });

  it("refuses a second dispute id on an already disputed charge, and alerts", async () => {
    const order = await paidOrder();
    await postEvent("charge.dispute.created", dispute(order, "needs_response", { id: "dp_first" }));

    const { eventId } = await postEvent("charge.dispute.created", dispute(order, "needs_response", { id: "dp_second" }));

    await expect(paymentEventRow(eventId)).resolves.toMatchObject({ outcome: "rejected" });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ dispute_id: "dp_first" });
    expect(await openAlerts("dispute_recovery_failed", order.orderId)).toHaveLength(1);
  });

  it("rejects a malformed dispute", async () => {
    const { eventId } = await postEvent("charge.dispute.created", { id: "dp_bad", status: "needs_response" });
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({
      outcome: "rejected",
      reason_code: "malformed_object",
    });
  });
});

describe("account.updated", () => {
  it("mirrors the connected account's capabilities onto its shop", async () => {
    const tenantId = next("tenant-acct").toLowerCase().replace(/_/g, "-");
    const account = (await seedTenant(tenantId, { chargesEnabled: false, payoutsEnabled: false })) as string;

    const { eventId } = await postEvent("account.updated", {
      charges_enabled: true,
      details_submitted: true,
      id: account,
      object: "account",
      payouts_enabled: false,
    });

    const row = await env.DB.prepare(
      `SELECT stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted,
              stripe_account_synced_at FROM tenants WHERE tenant_id = ?`,
    )
      .bind(tenantId)
      .first<Record<string, number | null>>();
    expect(row).toMatchObject({
      stripe_charges_enabled: 1,
      stripe_details_submitted: 1,
      stripe_payouts_enabled: 0,
    });
    expect(row?.stripe_account_synced_at).toBeGreaterThan(0);
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({ outcome: "processed", tenant_id: tenantId });
  });

  it("ignores an account no shop holds (never trusts account metadata)", async () => {
    const { eventId } = await postEvent("account.updated", {
      charges_enabled: true,
      id: "acct_nobodyshere",
      metadata: { shopId: TENANT },
    });
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({
      outcome: "ignored",
      reason_code: "unknown_account",
    });
    const row = await env.DB.prepare("SELECT stripe_account_id FROM tenants WHERE tenant_id = ?")
      .bind(TENANT)
      .first<{ stripe_account_id: string }>();
    expect(row?.stripe_account_id).toBe(accountId);
  });
});

describe("unknown types", () => {
  it("acknowledges and records, never refuses", async () => {
    const { eventId, response } = await postEvent("balance.available", { object: "balance" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({
      outcome: "ignored",
      reason_code: "unhandled_event_type",
    });
  });
});
