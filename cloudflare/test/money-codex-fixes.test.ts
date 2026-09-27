import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { runReconciliation } from "../src/commerce/crons";
import { handleStripeWebhookEvent } from "../src/commerce/webhook";
import { applyRefundFact } from "../src/commerce/refunds";
import { guardedDispatchCancellationStatements } from "../src/commerce/refund-dispatch-stop";
import { derivePayoutState, refreshPayoutStates } from "../src/commerce/payouts";
import { collectPages } from "../src/commerce/stripe-client";
import { dispatchCancellationStatements } from "../src/dispatch/cancellation";
import type { Admin } from "./money-fixtures";
import {
  adminRequest,
  DAY_MS,
  FakeMoneyStripe,
  moneyEnv,
  next,
  openAlerts,
  orderMoney,
  payCheckout,
  paymentEventRow,
  postEvent,
  refundOps,
  seedCheckout,
  seedTenant,
  signUpAdmin,
  snapshotJson,
} from "./money-fixtures";

/**
 * Regression tests for the six Codex findings on CP2-A (report "Codex fixes"):
 *   P1-1  refund/dispute events that arrive before their order are deferred
 *         and replayed, never lost
 *   P1-2  the full-refund dispatch stop is decided inside the settlement batch
 *   P1-3  a dispute reversal whose answer was lost is found at Stripe, never
 *         repeated and never mistaken for "nothing to return"
 *   P2-4  account.updated applies only strictly newer events
 *   P2-5  refund listings are paged; an incomplete one never proves absence
 *   P2-6  the payout refresh cannot be starved by persistently blocked orders
 */

const TENANT = "tenant-codex";
const MIN = 60 * 1_000;
let accountId: string;
let admin: Admin;
let stripe: FakeMoneyStripe;

beforeAll(async () => {
  accountId = (await seedTenant(TENANT)) as string;
  admin = await signUpAdmin("codex-admin@example.test", TENANT);
});

beforeEach(() => {
  stripe = new FakeMoneyStripe();
});

/** A seeded, unpaid POD checkout with its intent known to the fake. */
async function podCheckout() {
  const checkout = await seedCheckout({
    connect: { accountId, feeMinor: 13_300, withheldMinor: 12_300 },
    snapshot: snapshotJson([
      { lineNo: 1, productionCostMinor: 9_840, quantity: 1, sku: "2500170", withholdMinor: 12_300 },
    ]),
    tenantId: TENANT,
    unitPriceMinor: 20_000,
  });
  stripe.addIntent({ amount: 20_000, id: checkout.paymentIntentId as string, status: "succeeded" });
  return checkout;
}

async function dispatchRow(orderId: string) {
  return env.DB.prepare(
    `SELECT status, cancel_requested FROM outbox_events
     WHERE event_type = 'dispatch' AND aggregate_id = ?`,
  )
    .bind(orderId)
    .first<{ cancel_requested: number; status: string }>();
}

async function orderOf(checkoutId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT order_id FROM orders WHERE checkout_id = ?")
    .bind(checkoutId)
    .first<{ order_id: string }>();
  return row?.order_id ?? null;
}

async function deferredRows(paymentIntentId: string) {
  const rows = await env.DB.prepare(
    "SELECT event_id, kind, applied_at FROM deferred_payment_events WHERE payment_intent_id = ?",
  )
    .bind(paymentIntentId)
    .all<{ applied_at: string | null; event_id: string; kind: string }>();
  return rows.results;
}

function refundObject(id: string, amount: number, paymentIntentId: string, status = "succeeded") {
  return { amount, currency: "sek", id, metadata: {}, object: "refund", payment_intent: paymentIntentId, status };
}

// ═══════════════════════════════════════════════════════════════════════════
// P1-1
// ═══════════════════════════════════════════════════════════════════════════

describe("P1-1: a refund that arrives before its order is deferred, then applied", () => {
  it("refund.created first, then payment_intent.succeeded ⇒ fully refunded, dispatch superseded", async () => {
    const checkout = await podCheckout();
    const pi = checkout.paymentIntentId as string;

    const early = await postEvent("refund.created", refundObject(next("re_early"), 20_000, pi));

    expect(early.response.status).toBe(200);
    expect(await orderOf(checkout.checkoutId)).toBeNull();
    await expect(paymentEventRow(early.eventId)).resolves.toMatchObject({
      outcome: "processed",
      reason_code: "deferred_until_order",
      tenant_id: TENANT,
    });
    expect(await deferredRows(pi)).toEqual([
      { applied_at: null, event_id: early.eventId, kind: "refund" },
    ]);

    const orderId = await payCheckout(checkout, TENANT);

    await expect(orderMoney(orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 20_000,
      status: "refunded",
    });
    await expect(dispatchRow(orderId)).resolves.toEqual({ cancel_requested: 1, status: "superseded" });
    expect((await refundOps(orderId))[0]).toMatchObject({ origin: "stripe", state: "succeeded" });
    expect((await deferredRows(pi))[0]?.applied_at).not.toBeNull();
  });

  it("pending then succeeded, both early, apply in arrival order", async () => {
    const checkout = await podCheckout();
    const pi = checkout.paymentIntentId as string;
    const refundId = next("re_two");

    await postEvent("refund.created", refundObject(refundId, 8_000, pi, "pending"));
    await postEvent("refund.updated", refundObject(refundId, 8_000, pi, "succeeded"));
    const orderId = await payCheckout(checkout, TENANT);

    await expect(orderMoney(orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 8_000,
      status: "partially_refunded",
    });
    await expect(dispatchRow(orderId)).resolves.toMatchObject({ status: "pending" });
  });

  it("charge.refunded first: recorded on the order once it exists, settled by reconciliation", async () => {
    const checkout = await podCheckout();
    const pi = checkout.paymentIntentId as string;
    stripe.addDashboardRefund(pi, 20_000);

    const early = await postEvent("charge.refunded", {
      amount: 20_000,
      amount_refunded: 20_000,
      id: next("ch_early"),
      payment_intent: pi,
    });
    await expect(paymentEventRow(early.eventId)).resolves.toMatchObject({
      reason_code: "deferred_until_order",
    });

    const orderId = await payCheckout(checkout, TENANT);
    await expect(orderMoney(orderId)).resolves.toMatchObject({ stripe_amount_refunded_minor: 20_000 });

    await runReconciliation(moneyEnv(stripe), Date.now());

    await expect(orderMoney(orderId)).resolves.toMatchObject({
      refund_succeeded_minor: 20_000,
      status: "refunded",
    });
    await expect(dispatchRow(orderId)).resolves.toMatchObject({ status: "superseded" });
  });

  it("a dispute that arrives first blocks the payout once the order exists", async () => {
    const checkout = await podCheckout();
    const pi = checkout.paymentIntentId as string;

    await postEvent("charge.dispute.created", {
      amount: 20_000,
      charge: next("ch_disp"),
      id: "dp_codex_early",
      payment_intent: pi,
      status: "needs_response",
    });
    const orderId = await payCheckout(checkout, TENANT);

    await expect(orderMoney(orderId)).resolves.toMatchObject({
      dispute_id: "dp_codex_early",
      dispute_recovery: "reversal_pending",
      payout_state: "blocked",
    });
  });

  it("still ignores an intent no checkout owns (another integration)", async () => {
    const foreign = next("pi_foreign");
    const { eventId } = await postEvent("refund.created", refundObject(next("re_f"), 100, foreign));

    await expect(paymentEventRow(eventId)).resolves.toMatchObject({
      outcome: "ignored",
      reason_code: "unknown_payment_intent",
    });
    expect(await deferredRows(foreign)).toHaveLength(0);
  });

  it("closes the race: the order commits between the deferral's read and write", async () => {
    const checkout = await podCheckout();
    const pi = checkout.paymentIntentId as string;
    let orderId: string | null = null;

    // The first batch the refund handler issues is the deferral. Before it
    // runs, the whole order webhook runs to completion — including its own
    // replay, which finds nothing parked yet.
    let firstBatch = true;
    const racing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (firstBatch) {
              firstBatch = false;
              orderId = await payCheckout(checkout, TENANT);
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as Function).bind(target) : value;
      },
    }) as D1Database;

    await handleStripeWebhookEvent(
      racing,
      {
        created: Math.floor(Date.now() / 1_000),
        data: { object: refundObject(next("re_race"), 20_000, pi) },
        id: next("evt_race"),
        type: "refund.created",
      },
      Date.now(),
    );

    expect(orderId).not.toBeNull();
    await expect(orderMoney(orderId as unknown as string)).resolves.toMatchObject({
      refund_succeeded_minor: 20_000,
      status: "refunded",
    });
    await expect(dispatchRow(orderId as unknown as string)).resolves.toMatchObject({ status: "superseded" });
  });

  it("reconciliation replays a parked fact left behind, and alerts on one whose order never came", async () => {
    // Left behind: the order exists, the fact is still unapplied.
    const checkout = await podCheckout();
    const pi = checkout.paymentIntentId as string;
    const orderId = await payCheckout(checkout, TENANT);
    await env.DB.prepare(
      `INSERT INTO deferred_payment_events (event_id, tenant_id, payment_intent_id, kind, fact_json, created_at)
       VALUES (?, ?, ?, 'refund', ?, ?)`,
    )
      .bind(
        next("evt_left"),
        TENANT,
        pi,
        JSON.stringify({ amount: 5_000, operationId: null, paymentIntentId: pi, status: "succeeded", stripeRefundId: next("re_left") }),
        new Date().toISOString(),
      )
      .run();

    // Never: a checkout whose payment never produced an order.
    const orphan = await podCheckout();
    await postEvent("refund.created", refundObject(next("re_orphan"), 1_000, orphan.paymentIntentId as string));

    const summary = await runReconciliation(moneyEnv(stripe), Date.now() + 31 * MIN);

    expect(summary.deferred.replayed).toBeGreaterThanOrEqual(1);
    await expect(orderMoney(orderId)).resolves.toMatchObject({ refund_succeeded_minor: 5_000 });
    expect(await openAlerts("payment_event_deferred_30m", orphan.paymentIntentId as string)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P1-2
// ═══════════════════════════════════════════════════════════════════════════

/** Holds the first `count` batches until all have been issued. */
function gatedDb(count: number): D1Database {
  const waiting: Array<() => void> = [];
  let batches = 0;
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batches += 1;
          if (batches <= count) {
            await new Promise<void>((resolve) => {
              waiting.push(resolve);
              if (waiting.length === count) {
                for (const release of waiting) {
                  release();
                }
              }
            });
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as Function).bind(target) : value;
    },
  }) as D1Database;
}

async function adminRefund(orderId: string, amountMinor: number) {
  return worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}/refunds`, "POST", {
      body: { amountMinor, reason: "codex" },
      cookie: admin.cookie,
      shopId: TENANT,
    }),
    moneyEnv(stripe),
  );
}

describe("P1-2: whichever settlement completes the full refund stops dispatch", () => {
  it("two concurrent partial settlements that together cover the charge", async () => {
    const checkout = await podCheckout();
    const orderId = await payCheckout(checkout, TENANT);
    stripe.refundStatus = "pending";
    expect((await adminRefund(orderId, 12_000)).status).toBe(201);
    expect((await adminRefund(orderId, 8_000)).status).toBe(201);
    const [first, second] = [...stripe.refunds.values()].filter(
      (r) => r.payment_intent === checkout.paymentIntentId,
    );

    // Both succeed at Stripe; both facts read the order BEFORE either commits.
    const gated = gatedDb(2);
    const results = await Promise.all(
      [first!, second!].map((refund) =>
        applyRefundFact(
          gated,
          {
            amount: refund.amount,
            operationId: refund.metadata.refund_operation_id ?? null,
            paymentIntentId: checkout.paymentIntentId,
            status: "succeeded",
            stripeRefundId: refund.id,
          },
          Date.now(),
        ),
      ),
    );

    expect(results.map((r) => r.result)).toEqual(["applied", "applied"]);
    await expect(orderMoney(orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 20_000,
      status: "refunded",
    });
    await expect(dispatchRow(orderId)).resolves.toEqual({ cancel_requested: 1, status: "superseded" });
  });

  it("a settlement that does NOT complete the charge leaves dispatch alone, even racing", async () => {
    const checkout = await podCheckout();
    const orderId = await payCheckout(checkout, TENANT);
    stripe.refundStatus = "pending";
    await adminRefund(orderId, 6_000);
    await adminRefund(orderId, 7_000);
    const refunds = [...stripe.refunds.values()].filter((r) => r.payment_intent === checkout.paymentIntentId);

    const gated = gatedDb(2);
    await Promise.all(
      refunds.map((refund) =>
        applyRefundFact(
          gated,
          {
            amount: refund.amount,
            operationId: refund.metadata.refund_operation_id ?? null,
            paymentIntentId: checkout.paymentIntentId,
            status: "succeeded",
            stripeRefundId: refund.id,
          },
          Date.now(),
        ),
      ),
    );

    await expect(orderMoney(orderId)).resolves.toMatchObject({ refund_succeeded_minor: 13_000 });
    await expect(dispatchRow(orderId)).resolves.toEqual({ cancel_requested: 0, status: "pending" });
  });
});

describe("P1-2 parity: the guarded statements are CP2-B's statements plus the guard", () => {
  type DispatchState = "claimed" | "done" | "failed" | "pending" | "submitting" | "unknown";

  async function orderInState(state: DispatchState, orderStatus = "paid"): Promise<string> {
    const checkout = await podCheckout();
    const orderId = await payCheckout(checkout, TENANT);
    const now = Date.now();
    const claim = (extra: string, binds: unknown[]) =>
      env.DB.prepare(
        `UPDATE outbox_events SET status = 'claimed', claimed_by = ?, claim_expires_at = ?,
           attempts = attempts + 1, updated_at = ? ${extra}
         WHERE event_type = 'dispatch' AND aggregate_id = ?`,
      ).bind("claim-token-0123456789", now + MIN, now, ...binds, orderId);
    const move = (sql: string, binds: unknown[]) =>
      env.DB.prepare(`UPDATE outbox_events SET ${sql}, updated_at = ?
                      WHERE event_type = 'dispatch' AND aggregate_id = ?`).bind(...binds, now, orderId);

    if (state !== "pending") {
      await claim("", []).run();
    }
    if (state === "submitting") {
      await move("status = 'submitting', submitted_at = ?", [now]).run();
    } else if (state === "unknown") {
      await move(
        "status = 'unknown', submitted_at = ?, unknown_since = ?, claimed_by = NULL, claim_expires_at = NULL",
        [now, now],
      ).run();
    } else if (state === "failed") {
      await move(
        "status = 'failed', resolved_at = ?, last_error = 'rejected', claimed_by = NULL, claim_expires_at = NULL",
        [now],
      ).run();
    } else if (state === "done") {
      await move(
        "status = 'done', submitted_at = ?, resolved_at = ?, result_ref = 'job-ref', claimed_by = NULL, claim_expires_at = NULL",
        [now, now],
      ).run();
    }
    if (orderStatus !== "paid") {
      await env.DB.prepare("UPDATE orders SET status = ? WHERE order_id = ?").bind(orderStatus, orderId).run();
    }
    return orderId;
  }

  async function snapshot(orderId: string) {
    const dispatch = await env.DB.prepare(
      `SELECT status, cancel_requested, last_error, resolved_at IS NOT NULL AS resolved
       FROM outbox_events WHERE event_type = 'dispatch' AND aggregate_id = ?`,
    )
      .bind(orderId)
      .first();
    const line = await env.DB.prepare("SELECT dispatch_state FROM order_items WHERE order_id = ?")
      .bind(orderId)
      .first();
    const printerCancellations = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'printer_cancellation' AND aggregate_id = ?",
    )
      .bind(orderId)
      .first<{ n: number }>();
    const alerts = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM alerts WHERE kind = 'dispatch_cancel_unconfirmed'
         AND resource_id IN (SELECT outbox_id FROM outbox_events WHERE aggregate_id = ?)`,
    )
      .bind(orderId)
      .first<{ n: number }>();
    return { alerts: alerts?.n, dispatch, line, printerCancellations: printerCancellations?.n };
  }

  it.each([
    ["pending", "paid"],
    ["claimed", "paid"],
    ["submitting", "paid"],
    ["unknown", "paid"],
    ["failed", "paid"],
    ["done", "paid"],
    ["pending", "shipped"],
    ["done", "printed"],
  ] as const)("dispatch %s, order %s: identical effects", async (state, orderStatus) => {
    const theirs = await orderInState(state, orderStatus);
    const ours = await orderInState(state, orderStatus);
    const now = Date.now();

    await env.DB.batch(dispatchCancellationStatements(env.DB, { nowMs: now, orderId: theirs, tenantId: TENANT }));
    await env.DB.batch(
      guardedDispatchCancellationStatements(env.DB, { nowMs: now, orderId: ours, tenantId: TENANT }, { binds: [], sql: "1" }),
    );

    expect(await snapshot(ours)).toEqual(await snapshot(theirs));
  });

  it("a guard that does not hold changes nothing", async () => {
    const orderId = await orderInState("pending");
    const before = await snapshot(orderId);

    await env.DB.batch(
      guardedDispatchCancellationStatements(env.DB, { nowMs: Date.now(), orderId, tenantId: TENANT }, { binds: [], sql: "0" }),
    );

    expect(await snapshot(orderId)).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P1-3
// ═══════════════════════════════════════════════════════════════════════════

describe("P1-3: a reversal whose answer was lost is found at Stripe, never repeated or forgotten", () => {
  async function disputedOrder(disputeId: string) {
    const checkout = await seedCheckout({
      connect: { accountId, feeMinor: 1_000, withheldMinor: 0 },
      tenantId: TENANT,
      unitPriceMinor: 20_000,
    });
    const chargeId = next("ch_p13");
    const orderId = await payCheckout(checkout, TENANT, { latestCharge: chargeId });
    const pi = checkout.paymentIntentId as string;
    const transferId = next("tr_p13");
    stripe.addCharge({ id: chargeId, payment_intent: pi, transfer: transferId }, 20_000);
    const dispute = (status: string) => ({
      amount: 20_000,
      charge: chargeId,
      id: disputeId,
      payment_intent: pi,
      status,
    });
    await postEvent("charge.dispute.created", dispute("needs_response"));
    return { dispute, orderId, transferId };
  }

  it("lost answer, then WON: the reversal is found and exactly it is sent back", async () => {
    const { dispute, orderId } = await disputedOrder("dp_p13_won");
    stripe.loseReversalResponse = true;

    await runReconciliation(moneyEnv(stripe), Date.now());
    // Stripe reversed; this platform does not know it.
    await expect(orderMoney(orderId)).resolves.toMatchObject({
      dispute_recovery: "reversal_pending",
      transfer_reversed_minor: 0,
    });

    await postEvent("charge.dispute.closed", dispute("won"));
    await expect(orderMoney(orderId)).resolves.toMatchObject({ dispute_recovery: "retransfer_pending" });

    stripe.loseReversalResponse = false;
    await runReconciliation(moneyEnv(stripe), Date.now());

    expect(stripe.reversalCalls).toHaveLength(1);
    expect(stripe.transferCalls).toHaveLength(1);
    expect(stripe.transferCalls[0]).toMatchObject({ amount: 20_000, destination: accountId });
    await expect(orderMoney(orderId)).resolves.toMatchObject({
      dispute_recovery: "returned_won",
      dispute_retransferred_minor: 20_000,
      transfer_reversed_minor: 20_000,
      payout_state: "pending",
    });
  });

  it("lost D1 write (a reversal from an earlier run): recorded, not made again", async () => {
    const { orderId, transferId } = await disputedOrder("dp_p13_write");
    // An earlier run's reversal that never reached D1 — after the 24-hour
    // idempotency window a blind retry would be a second reversal.
    await stripe.createTransferReversal({
      idempotencyKey: "an-expired-key",
      metadata: { dispute_id: "dp_p13_write", order_id: orderId, reason: "dispute_recovery" },
      refundApplicationFee: false,
      transferId,
    });

    await runReconciliation(moneyEnv(stripe), Date.now());

    expect(stripe.reversalCalls).toHaveLength(1);
    await expect(orderMoney(orderId)).resolves.toMatchObject({
      dispute_recovery: "recovered",
      stripe_transfer_id: transferId,
      transfer_reversed_minor: 20_000,
    });
  });

  it("WON before any reversal: Stripe has none ⇒ nothing moves, the payout unblocks", async () => {
    const { dispute, orderId } = await disputedOrder("dp_p13_none");
    await postEvent("charge.dispute.closed", dispute("won"));

    await runReconciliation(moneyEnv(stripe), Date.now());

    expect(stripe.reversalCalls).toHaveLength(0);
    expect(stripe.transferCalls).toHaveLength(0);
    await expect(orderMoney(orderId)).resolves.toMatchObject({
      dispute_recovery: "won_no_reversal",
      payout_state: "pending",
    });
  });

  it("a lost re-transfer answer is found by its transfer_group, not sent twice", async () => {
    const { dispute, orderId } = await disputedOrder("dp_p13_rt");
    await runReconciliation(moneyEnv(stripe), Date.now());
    await postEvent("charge.dispute.closed", dispute("won"));
    stripe.loseTransferResponse = true;

    await runReconciliation(moneyEnv(stripe), Date.now());
    await expect(orderMoney(orderId)).resolves.toMatchObject({ dispute_recovery: "retransfer_pending" });

    stripe.loseTransferResponse = false;
    await runReconciliation(moneyEnv(stripe), Date.now());

    expect(stripe.transferCalls).toHaveLength(1);
    await expect(orderMoney(orderId)).resolves.toMatchObject({
      dispute_recovery: "returned_won",
      dispute_retransferred_minor: 20_000,
    });
  });

  it("an incomplete reversal listing never leads to a blind reversal", async () => {
    const { orderId, transferId } = await disputedOrder("dp_p13_inc");
    for (let i = 0; i < 3; i += 1) {
      stripe.reversalsByTransfer.set(transferId, [
        ...(stripe.reversalsByTransfer.get(transferId) ?? []),
        { amount: 1, id: next("trr_other"), metadata: {} },
      ]);
    }
    stripe.listPageSize = 1;
    stripe.listMaxPages = 2;

    const summary = await runReconciliation(moneyEnv(stripe), Date.now());

    expect(summary.disputes.errors).toBeGreaterThanOrEqual(1);
    expect(stripe.reversalCalls).toHaveLength(0);
    await expect(orderMoney(orderId)).resolves.toMatchObject({ dispute_recovery: "reversal_pending" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2-4
// ═══════════════════════════════════════════════════════════════════════════

describe("P2-4: account.updated applies only strictly newer events", () => {
  async function freshShop() {
    const tenantId = next("tenant-acct-order").toLowerCase().replace(/_/g, "-");
    const account = (await seedTenant(tenantId, { chargesEnabled: false, payoutsEnabled: false })) as string;
    return { account, tenantId };
  }

  async function flags(tenantId: string) {
    return env.DB.prepare(
      "SELECT stripe_charges_enabled AS c, stripe_payouts_enabled AS p, stripe_account_synced_at AS at FROM tenants WHERE tenant_id = ?",
    )
      .bind(tenantId)
      .first<{ at: number; c: number; p: number }>();
  }

  const base = Math.floor(Date.now() / 1_000);

  it("newer, then older: the older changes nothing", async () => {
    const { account, tenantId } = await freshShop();
    await postEvent("account.updated", { charges_enabled: false, id: account, payouts_enabled: false }, { created: base + 20 });
    const { eventId } = await postEvent(
      "account.updated",
      { charges_enabled: true, id: account, payouts_enabled: true },
      { created: base + 10 },
    );

    await expect(flags(tenantId)).resolves.toEqual({ at: (base + 20) * 1_000, c: 0, p: 0 });
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({ outcome: "processed", reason_code: "stale_event" });
  });

  it("older, then newer: the newer wins", async () => {
    const { account, tenantId } = await freshShop();
    await postEvent("account.updated", { charges_enabled: false, id: account, payouts_enabled: false }, { created: base + 10 });
    await postEvent("account.updated", { charges_enabled: true, id: account, payouts_enabled: true }, { created: base + 20 });

    await expect(flags(tenantId)).resolves.toEqual({ at: (base + 20) * 1_000, c: 1, p: 1 });
  });

  it("the same second, in either order: merged fail-closed", async () => {
    const one = await freshShop();
    await postEvent("account.updated", { charges_enabled: true, id: one.account, payouts_enabled: true }, { created: base + 30 });
    await postEvent("account.updated", { charges_enabled: false, id: one.account, payouts_enabled: true }, { created: base + 30 });
    await expect(flags(one.tenantId)).resolves.toMatchObject({ c: 0, p: 1 });

    const two = await freshShop();
    await postEvent("account.updated", { charges_enabled: false, id: two.account, payouts_enabled: true }, { created: base + 30 });
    await postEvent("account.updated", { charges_enabled: true, id: two.account, payouts_enabled: true }, { created: base + 30 });
    await expect(flags(two.tenantId)).resolves.toMatchObject({ c: 0, p: 1 });
  });

  it("rejects an event without a creation time", async () => {
    const { account, tenantId } = await freshShop();
    const payload = JSON.stringify({
      data: { object: { charges_enabled: true, id: account } },
      id: next("evt_nocreated"),
      object: "event",
      type: "account.updated",
    });
    const result = await handleStripeWebhookEvent(env.DB, JSON.parse(payload), Date.now());

    expect(result).toMatchObject({ outcome: "rejected", reasonCode: "malformed_object" });
    await expect(flags(tenantId)).resolves.toMatchObject({ c: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2-5
// ═══════════════════════════════════════════════════════════════════════════

describe("P2-5: refund listings are paged; an incomplete one never proves absence", () => {
  const pages = (items: string[], size: number) => async (after: string | null) => {
    const start = after === null ? 0 : items.indexOf(after) + 1;
    return {
      data: items.slice(start, start + size).map((id) => ({ id })),
      hasMore: start + size < items.length,
    };
  };

  it("collectPages reads to the end, or says it stopped short", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `re_${i}`);
    await expect(collectPages(pages(ids, 3), 20)).resolves.toEqual({
      complete: true,
      data: ids.map((id) => ({ id })),
    });
    await expect(collectPages(pages(ids, 3), 2)).resolves.toEqual({
      complete: false,
      data: ids.slice(0, 6).map((id) => ({ id })),
    });
    await expect(collectPages(pages([], 3), 2)).resolves.toEqual({ complete: true, data: [] });
    await expect(collectPages(pages(ids, 7), 1)).resolves.toMatchObject({ complete: true });
  });

  async function staleReservation() {
    const checkout = await podCheckout();
    const orderId = await payCheckout(checkout, TENANT);
    const pi = checkout.paymentIntentId as string;
    const opId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE orders SET refund_reserved_minor = refund_reserved_minor + 1000,
           refund_version = refund_version + 1, last_refund_op_id = ? WHERE order_id = ?`,
      ).bind(opId, orderId),
      env.DB.prepare(
        `INSERT INTO refund_operations (id, tenant_id, order_id, amount_minor, state, origin,
           reason, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 1000, 'reserved', 'admin', 'r', 'user-x', ?, ?)`,
      ).bind(opId, TENANT, orderId, nowIso, nowIso),
    ]);
    // Three older refunds at Stripe that are not this operation.
    for (let i = 0; i < 3; i += 1) {
      stripe.addDashboardRefund(pi, 100, "succeeded");
    }
    return { opId, orderId };
  }

  it("does NOT release a reservation when the listing stopped short", async () => {
    const { opId, orderId } = await staleReservation();
    stripe.listPageSize = 1;
    stripe.listMaxPages = 2;

    const summary = await runReconciliation(moneyEnv(stripe), Date.now() + 31 * MIN);

    expect(summary.refunds.incompleteListings).toBeGreaterThanOrEqual(1);
    const op = (await refundOps(orderId)).find((o) => o.id === opId);
    expect(op?.state).toBe("reserved");
    expect(await openAlerts("refund_unsettled_30m", opId)).toHaveLength(1);
    // What WAS listed still settles.
    await expect(orderMoney(orderId)).resolves.toMatchObject({ refund_succeeded_minor: 200 });
  });

  it("releases it once the listing is complete and the operation is absent", async () => {
    const { opId, orderId } = await staleReservation();
    stripe.listPageSize = 1;
    stripe.listMaxPages = 20;

    await runReconciliation(moneyEnv(stripe), Date.now() + 31 * MIN);

    const op = (await refundOps(orderId)).find((o) => o.id === opId);
    expect(op?.state).toBe("released");
    await expect(orderMoney(orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 300,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2-6
// ═══════════════════════════════════════════════════════════════════════════

describe("P2-6: the payout refresh cannot be starved", () => {
  let counter = 0;

  /** A bare order row (and its checkout) — hundreds of them, fast. */
  function orderStatements(
    tenantId: string,
    options: {
      disputeRecovery?: string | null;
      disputeStatus?: string | null;
      paidAt: number;
      payoutState: string;
    },
  ): { orderId: string; statements: D1PreparedStatement[] } {
    counter += 1;
    const checkoutId = `ck-starve-${counter}-${Math.floor(Math.random() * 1e6)}`;
    const orderId = crypto.randomUUID();
    const at = options.paidAt;
    return {
      orderId,
      statements: [
        env.DB.prepare(
          `INSERT INTO checkouts (checkout_id, tenant_id, status, customer_email, currency,
             delivery_method, shipping_country, subtotal_minor, shipping_minor, vat_minor,
             vat_rate_bp, discount_minor, total_minor, payment_intent_id,
             idempotency_key_hash, expires_at, created_at, updated_at)
           VALUES (?, ?, 'completed', 'b@example.test', 'SEK', 'pickup', NULL, 1000, 0, 0,
             2500, 0, 1000, ?, ?, ?, ?, ?)`,
        ).bind(checkoutId, tenantId, `pi_${checkoutId}`.replace(/-/g, "_"), `h-${checkoutId}`, at + DAY_MS, at, at),
        env.DB.prepare(
          `INSERT INTO orders (order_id, tenant_id, checkout_id, payment_intent_id, order_number,
             status, customer_email, currency, delivery_method, shipping_country, subtotal_minor,
             shipping_minor, vat_minor, vat_rate_bp, discount_minor, total_minor, captured_minor,
             charged_minor, refunded_total_minor, stripe_event_id, paid_at, created_at, updated_at,
             payout_state, dispute_status, dispute_recovery)
           VALUES (?, ?, ?, ?, ?, 'paid', 'b@example.test', 'SEK', 'pickup', NULL, 1000, 0, 0,
             2500, 0, 1000, 1000, 1000, 0, 'evt_x', ?, ?, ?, ?, ?, ?)`,
        ).bind(
          orderId,
          tenantId,
          checkoutId,
          `pi_${checkoutId}`.replace(/-/g, "_"),
          `S-${counter}`,
          at,
          at,
          at,
          options.payoutState,
          options.disputeStatus ?? null,
          options.disputeRecovery ?? null,
        ),
      ],
    };
  }

  async function insertAll(statements: D1PreparedStatement[]): Promise<void> {
    for (let i = 0; i < statements.length; i += 100) {
      await env.DB.batch(statements.slice(i, i + 100));
    }
  }

  it("600 persistently blocked orders do not starve a newer one that became eligible", async () => {
    const blockedShop = next("tenant-starve-b").toLowerCase().replace(/_/g, "-");
    await seedTenant(blockedShop, { payoutsEnabled: false });
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 600; i += 1) {
      // Older than the newer order, so a paid_at-ordered scan meets them first.
      statements.push(...orderStatements(blockedShop, { paidAt: now - 60 * DAY_MS + i, payoutState: "blocked" }).statements);
    }
    const newer = orderStatements(TENANT, { paidAt: now - 20 * DAY_MS, payoutState: "pending" });
    statements.push(...newer.statements);
    await insertAll(statements);

    const result = await refreshPayoutStates(env.DB, now, 500);

    await expect(orderMoney(newer.orderId)).resolves.toMatchObject({ payout_state: "eligible" });
    // Nothing that was already right was touched.
    expect(result.updated).toBeLessThan(500);
  });

  it("the SQL derivation equals derivePayoutState over the whole input matrix", async () => {
    const enabledShop = next("tenant-matrix-on").toLowerCase().replace(/_/g, "-");
    const disabledShop = next("tenant-matrix-off").toLowerCase().replace(/_/g, "-");
    await seedTenant(enabledShop, { payoutsEnabled: true });
    await seedTenant(disabledShop, { payoutsEnabled: false });
    const now = Date.now();
    const rows: Array<{ enabled: boolean; facts: Parameters<typeof derivePayoutState>[0]; orderId: string }> = [];
    const statements: D1PreparedStatement[] = [];
    for (const shop of [enabledShop, disabledShop]) {
      for (const stored of ["pending", "eligible", "blocked", "paid"]) {
        for (const disputeStatus of [null, "needs_response", "won", "lost", "warning_closed", "brand_new_status"]) {
          for (const recovery of [null, "reversal_pending", "retransfer_pending", "recovered", "won_no_reversal"]) {
            for (const age of [2 * DAY_MS, 20 * DAY_MS]) {
              const made = orderStatements(shop, {
                disputeRecovery: recovery,
                disputeStatus,
                paidAt: now - age,
                payoutState: stored,
              });
              statements.push(...made.statements);
              rows.push({
                enabled: shop === enabledShop,
                facts: {
                  application_fee_minor: 0,
                  charged_minor: 1_000,
                  dispute_recovery: recovery,
                  dispute_retransferred_minor: 0,
                  dispute_status: disputeStatus,
                  paid_at: now - age,
                  payout_state: stored,
                  refund_succeeded_minor: 0,
                  transfer_reversed_minor: 0,
                },
                orderId: made.orderId,
              });
            }
          }
        }
      }
    }
    await insertAll(statements);

    await refreshPayoutStates(env.DB, now, 10_000);

    for (const row of rows) {
      const stored = await env.DB.prepare("SELECT payout_state FROM orders WHERE order_id = ?")
        .bind(row.orderId)
        .first<{ payout_state: string }>();
      expect({ order: row.facts, state: stored?.payout_state }).toEqual({
        order: row.facts,
        state: derivePayoutState(row.facts, now, row.enabled),
      });
    }

    // A second run finds nothing left to correct.
    await expect(refreshPayoutStates(env.DB, now, 10_000)).resolves.toMatchObject({ updated: 0 });
  });
});
