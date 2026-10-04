import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import type { TenantAdminPrincipal } from "../src/auth/live-authorization";
import { applyRefundFact, requestRefund } from "../src/commerce/refunds";
import type { Admin } from "./money-fixtures";
import {
  adminRequest,
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
 * PLAN §2.3 "Refunds — reserve before Stripe", every sentence of it:
 *  - one batch reserves (op 'reserved' + orders.refund_reserved_minor under
 *    the refund_version guard); zero rows ⇒ re-read and retry;
 *  - Stripe is called with idempotency key = operation id,
 *    refund_application_fee false (D9), reverse_transfer true;
 *  - the response moves the op to 'submitted' with the refund id; settlement
 *    (API or refund/charge webhooks) is DEDUPED BY stripe_refund_id and moves
 *    reserved → succeeded; a failure releases the reservation;
 *  - a dashboard refund arrives as a webhook with no op ⇒ an op is created
 *    from it and reconciled;
 *  - two concurrent partial refunds can never over-refund (interleavings).
 * Plus the admin order read and the seller-sees-one-number rule on it.
 */

const TENANT_A = "tenant-refund-a";
const TENANT_B = "tenant-refund-b";
let accountA: string;
let adminA: Admin;
let adminB: Admin;
let stripe: FakeMoneyStripe;

beforeAll(async () => {
  accountA = (await seedTenant(TENANT_A)) as string;
  await seedTenant(TENANT_B);
  adminA = await signUpAdmin("refund-admin-a@example.test", TENANT_A);
  adminB = await signUpAdmin("refund-admin-b@example.test", TENANT_B);
});

beforeEach(() => {
  stripe = new FakeMoneyStripe();
});

interface PaidOrder {
  orderId: string;
  paymentIntentId: string;
}

/** A POD order paid through the real webhook: 20 000 charged, 13 300 fee. */
async function paidOrder(tenantId = TENANT_A): Promise<PaidOrder> {
  const checkout = await seedCheckout({
    connect: { accountId: accountA, feeMinor: 13_300, withheldMinor: 12_300 },
    snapshot: snapshotJson([
      { lineNo: 1, productionCostMinor: 9_840, quantity: 1, sku: "2500170", withholdMinor: 12_300 },
    ]),
    tenantId,
    unitPriceMinor: 20_000,
  });
  const orderId = await payCheckout(checkout, tenantId);
  const paymentIntentId = checkout.paymentIntentId as string;
  stripe.addIntent({ amount: 20_000, id: paymentIntentId, status: "succeeded" });
  return { orderId, paymentIntentId };
}

async function refund(
  orderId: string,
  body: unknown,
  options: { admin?: Admin; env?: Env; origin?: string | null; shopId?: string | null } = {},
): Promise<Response> {
  return worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}/refunds`, "POST", {
      body,
      cookie: (options.admin ?? adminA).cookie,
      origin: options.origin,
      shopId: options.shopId === undefined ? TENANT_A : options.shopId,
    }),
    options.env ?? moneyEnv(stripe),
  );
}

async function readOrder(orderId: string, options: { admin?: Admin; shopId?: string } = {}) {
  return worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}`, "GET", {
      cookie: (options.admin ?? adminA).cookie,
      origin: null,
      shopId: options.shopId ?? TENANT_A,
    }),
    moneyEnv(stripe),
  );
}

function principalA(): TenantAdminPrincipal {
  return { accountType: "tenant_admin", role: "admin", tenantId: TENANT_A, userId: adminA.userId };
}

function refundObject(
  refund: { amount: number; id: string; metadata?: Record<string, string>; status: string },
  paymentIntentId: string,
) {
  return {
    amount: refund.amount,
    currency: "sek",
    id: refund.id,
    metadata: refund.metadata ?? {},
    object: "refund",
    payment_intent: paymentIntentId,
    status: refund.status,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("the refund route's guards", () => {
  it("404s without a session, for another shop, cross-site, and for a foreign order", async () => {
    const order = await paidOrder();
    const body = { amountMinor: 1_000, reason: "damaged" };

    const anonymous = await worker.fetch(
      adminRequest(`/v1/admin/orders/${order.orderId}/refunds`, "POST", { body, shopId: TENANT_A }),
      moneyEnv(stripe),
    );
    expect(anonymous.status).toBe(404);
    // Admin B naming shop A.
    expect((await refund(order.orderId, body, { admin: adminB })).status).toBe(404);
    // Admin B on their own shop, naming A's order.
    expect((await refund(order.orderId, body, { admin: adminB, shopId: TENANT_B })).status).toBe(404);
    // Cross-site and missing Origin.
    expect((await refund(order.orderId, body, { origin: "https://evil.example" })).status).toBe(404);
    expect((await refund(order.orderId, body, { origin: null })).status).toBe(404);
    // No X-Shop-Id.
    expect((await refund(order.orderId, body, { shopId: null })).status).toBe(404);

    expect(stripe.refundCalls).toHaveLength(0);
    expect(await refundOps(order.orderId)).toHaveLength(0);
  });

  it("404s a malformed order id and wrong methods", async () => {
    const body = { amountMinor: 1_000, reason: "damaged" };
    expect((await refund("not-a-uuid", body)).status).toBe(404);
    const order = await paidOrder();
    const get = await worker.fetch(
      adminRequest(`/v1/admin/orders/${order.orderId}/refunds`, "GET", {
        cookie: adminA.cookie,
        shopId: TENANT_A,
      }),
      moneyEnv(stripe),
    );
    expect(get.status).toBe(404);
  });

  it("is dark while Stripe is unconfigured", async () => {
    const order = await paidOrder();
    const response = await refund(
      order.orderId,
      { amountMinor: 1_000, reason: "damaged" },
      { env: moneyEnv(stripe, { STRIPE_SECRET_KEY: undefined }) },
    );
    expect(response.status).toBe(404);
    expect(stripe.refundCalls).toHaveLength(0);
  });

  it.each([
    ["an extra key", { amountMinor: 100, extra: 1, reason: "r" }],
    ["no reason", { amountMinor: 100 }],
    ["no amount", { reason: "r" }],
    ["a zero amount", { amountMinor: 0, reason: "r" }],
    ["a negative amount", { amountMinor: -100, reason: "r" }],
    ["a fractional amount", { amountMinor: 10.5, reason: "r" }],
    ["a string amount", { amountMinor: "100", reason: "r" }],
    ["an empty reason", { amountMinor: 100, reason: "   " }],
    ["a long reason", { amountMinor: 100, reason: "x".repeat(501) }],
    ["a control character", { amountMinor: 100, reason: "a\u0007b" }],
    ["an array", [1]],
    ["not JSON", "{"],
  ])("400s %s", async (_label, body) => {
    const order = await paidOrder();
    expect((await refund(order.orderId, body)).status).toBe(400);
    expect(await refundOps(order.orderId)).toHaveLength(0);
  });
});

describe("reserve, then Stripe", () => {
  it("refunds in full: one Stripe call keyed by the operation, fee kept, transfer reversed", async () => {
    const order = await paidOrder();

    const response = await refund(order.orderId, { amountMinor: 20_000, reason: "Buyer withdrew" });

    expect(response.status).toBe(201);
    const body = await response.json<{ refund: { amountMinor: number; refundId: string; state: string } }>();
    expect(body.refund).toMatchObject({ amountMinor: 20_000, state: "succeeded" });

    expect(stripe.refundCalls).toEqual([
      {
        amount: 20_000,
        idempotencyKey: body.refund.refundId,
        metadata: {
          order_id: order.orderId,
          refund_operation_id: body.refund.refundId,
          tenant_id: TENANT_A,
        },
        paymentIntentId: order.paymentIntentId,
        refundApplicationFee: false,
        reverseTransfer: true,
      },
    ]);

    const money = await orderMoney(order.orderId);
    expect(money).toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 20_000,
      refunded_total_minor: 20_000,
      status: "refunded",
    });
    expect(money.refund_version).toBe(2); // reserve + settle
    const ops = await refundOps(order.orderId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      amount_minor: 20_000,
      created_by: adminA.userId,
      id: body.refund.refundId,
      origin: "admin",
      reason: "Buyer withdrew",
      state: "succeeded",
    });
    expect(ops[0]?.stripe_refund_id).toMatch(/^re_/);

    const history = await env.DB.prepare(
      `SELECT from_status, to_status, actor_user_id, reason FROM order_status_history
       WHERE order_id = ? ORDER BY created_at, history_id`,
    )
      .bind(order.orderId)
      .all<{ actor_user_id: string | null; from_status: string | null; reason: string; to_status: string }>();
    expect(history.results.at(-1)).toEqual({
      actor_user_id: adminA.userId,
      from_status: "paid",
      reason: "refund",
      to_status: "refunded",
    });

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, resource_id, request_id, metadata_json FROM audit_events
       WHERE action = 'order.refund.requested' AND resource_id = ?`,
    )
      .bind(order.orderId)
      .first<{ actor_user_id: string; metadata_json: string; request_id: string }>();
    expect(audit).toMatchObject({ actor_user_id: adminA.userId, request_id: body.refund.refundId });
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toEqual({
      amountMinor: 20_000,
      refundId: body.refund.refundId,
    });
  });

  it("marks a partial refund and keeps the rest refundable", async () => {
    const order = await paidOrder();

    expect((await refund(order.orderId, { amountMinor: 5_000, reason: "goodwill" })).status).toBe(201);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_succeeded_minor: 5_000,
      status: "partially_refunded",
    });

    expect((await refund(order.orderId, { amountMinor: 15_000, reason: "rest" })).status).toBe(201);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_succeeded_minor: 20_000,
      status: "refunded",
    });
  });

  it("refuses more than remains, before Stripe", async () => {
    const order = await paidOrder();
    expect((await refund(order.orderId, { amountMinor: 12_000, reason: "a" })).status).toBe(201);

    const response = await refund(order.orderId, { amountMinor: 8_001, reason: "b" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "refund_not_allowed", message: "The order cannot be refunded by this amount" },
    });
    expect(stripe.refundCalls).toHaveLength(1);
    expect(await refundOps(order.orderId)).toHaveLength(1);
  });

  it("goes to 'submitted' while Stripe's refund is pending, holding the reservation", async () => {
    const order = await paidOrder();
    stripe.refundStatus = "pending";

    const response = await refund(order.orderId, { amountMinor: 7_000, reason: "a" });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ refund: { state: "submitted" } });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 7_000,
      refund_succeeded_minor: 0,
      status: "paid",
    });
    // What is reserved cannot be refunded twice.
    expect((await refund(order.orderId, { amountMinor: 13_001, reason: "b" })).status).toBe(409);
  });

  it("releases the reservation when Stripe refuses", async () => {
    const order = await paidOrder();
    stripe.refundBehaviour = "reject";

    const response = await refund(order.orderId, { amountMinor: 7_000, reason: "a" });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ refund: { state: "failed" } });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 0,
      status: "paid",
    });
    expect((await refundOps(order.orderId))[0]).toMatchObject({ stripe_refund_id: null, state: "failed" });
  });

  it("answers 202 and HOLDS the reservation when Stripe's outcome is unknown", async () => {
    const order = await paidOrder();
    stripe.refundBehaviour = "unavailable";

    const response = await refund(order.orderId, { amountMinor: 7_000, reason: "a" });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ refund: { amountMinor: 7_000, state: "reserved" } });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ refund_reserved_minor: 7_000 });
    expect((await refund(order.orderId, { amountMinor: 13_001, reason: "b" })).status).toBe(409);
  });

  it("settles a refund whose response was lost when its webhook names the operation", async () => {
    const order = await paidOrder();
    stripe.loseRefundResponse = true;

    const response = await refund(order.orderId, { amountMinor: 7_000, reason: "a" });
    expect(response.status).toBe(202);
    const { refund: pending } = await response.json<{ refund: { refundId: string } }>();

    // Stripe DID create it (idempotency key = op id); its webhook arrives.
    const atStripe = [...stripe.refunds.values()][0];
    expect(atStripe?.metadata.refund_operation_id).toBe(pending.refundId);
    const { eventId, response: hook } = await postEvent(
      "refund.created",
      refundObject({ ...atStripe!, status: "succeeded" }, order.paymentIntentId),
    );

    expect(hook.status).toBe(200);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 7_000,
    });
    const ops = await refundOps(order.orderId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: pending.refundId, state: "succeeded", stripe_refund_id: atStripe?.id });
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({ outcome: "processed", tenant_id: TENANT_A });
  });

  it("refuses a refund on a charged-back order", async () => {
    const order = await paidOrder();
    await env.DB.prepare("UPDATE orders SET dispute_status = 'needs_response' WHERE order_id = ?")
      .bind(order.orderId)
      .run();

    expect((await refund(order.orderId, { amountMinor: 1_000, reason: "a" })).status).toBe(409);
    expect(stripe.refundCalls).toHaveLength(0);
  });

  it("allows a refund during an inquiry (warning_*)", async () => {
    const order = await paidOrder();
    await env.DB.prepare("UPDATE orders SET dispute_status = 'warning_needs_response' WHERE order_id = ?")
      .bind(order.orderId)
      .run();

    expect((await refund(order.orderId, { amountMinor: 1_000, reason: "a" })).status).toBe(201);
  });
});

/**
 * A D1 whose first `count` batches are held until all of them have been
 * issued, so the callers race past their reads and then commit in turn —
 * the interleaving a single-threaded test cannot otherwise force.
 */
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

describe("two concurrent partial refunds can never over-refund", () => {
  it("interleaved: the second arrives while the first is between reservation and Stripe", async () => {
    const order = await paidOrder();
    let second: Response | null = null;
    stripe.beforeRefund = async () => {
      stripe.beforeRefund = null;
      second = await refund(order.orderId, { amountMinor: 15_000, reason: "second" });
    };

    const first = await refund(order.orderId, { amountMinor: 15_000, reason: "first" });

    expect(first.status).toBe(201);
    expect((second as Response | null)?.status).toBe(409);
    expect(stripe.refundCalls).toHaveLength(1);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 15_000,
    });
  });

  it("interleaved: both read the same version, then write in turn", async () => {
    const order = await paidOrder();

    // Hold both reservation batches until both requests have issued theirs,
    // so both are built from the same read of refund_version.
    const gated = gatedDb(2);

    const [a, b] = await Promise.all([
      requestRefund(gated, stripe, principalA(), order.orderId, { amountMinor: 12_000, reason: "a" }, Date.now()),
      requestRefund(gated, stripe, principalA(), order.orderId, { amountMinor: 12_000, reason: "b" }, Date.now()),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["created", "not_allowed"]);
    expect(stripe.refundCalls).toHaveLength(1);
    const money = await orderMoney(order.orderId);
    expect(money.refund_succeeded_minor + money.refund_reserved_minor).toBe(12_000);
    expect(await refundOps(order.orderId)).toHaveLength(1);
  });

  it("interleaved: two that both fit both land, each reserved exactly once", async () => {
    const order = await paidOrder();
    const [a, b] = await Promise.all([
      refund(order.orderId, { amountMinor: 9_000, reason: "a" }),
      refund(order.orderId, { amountMinor: 11_000, reason: "b" }),
    ]);

    expect([a.status, b.status]).toEqual([201, 201]);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 20_000,
      status: "refunded",
    });
  });

  it("a stampede of partial refunds stops exactly at the charge", async () => {
    const order = await paidOrder();
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => refund(order.orderId, { amountMinor: 5_000, reason: `r${i}` })),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 201, 409, 409]);
    expect(stripe.refundCalls.reduce((sum, call) => sum + call.amount, 0)).toBe(20_000);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 20_000,
    });
  });
});

describe("a full refund stops production (PLAN §2.3: refund before claim → superseded)", () => {
  async function dispatchState(orderId: string) {
    const row = await env.DB.prepare(
      `SELECT status, cancel_requested FROM outbox_events
       WHERE event_type = 'dispatch' AND aggregate_id = ?`,
    )
      .bind(orderId)
      .first<{ cancel_requested: number; status: string }>();
    const line = await env.DB.prepare(
      "SELECT dispatch_state FROM order_items WHERE order_id = ? AND item_index = 0",
    )
      .bind(orderId)
      .first<{ dispatch_state: string | null }>();
    return { ...row, line: line?.dispatch_state ?? null };
  }

  it("supersedes the unclaimed dispatch in the settlement batch", async () => {
    const order = await paidOrder();
    expect(await dispatchState(order.orderId)).toMatchObject({ status: "pending" });

    expect((await refund(order.orderId, { amountMinor: 20_000, reason: "cancelled order" })).status).toBe(201);

    await expect(dispatchState(order.orderId)).resolves.toEqual({
      cancel_requested: 1,
      line: "cancelled",
      status: "superseded",
    });
  });

  it("leaves production alone for a partial refund", async () => {
    const order = await paidOrder();
    await refund(order.orderId, { amountMinor: 19_999, reason: "goodwill" });

    await expect(dispatchState(order.orderId)).resolves.toMatchObject({
      cancel_requested: 0,
      line: null,
      status: "pending",
    });
  });

  it("stops production when the refund that completes it comes from the dashboard", async () => {
    const order = await paidOrder();
    await refund(order.orderId, { amountMinor: 5_000, reason: "part" });
    const dash = stripe.addDashboardRefund(order.paymentIntentId, 15_000);

    await postEvent("refund.created", refundObject(dash, order.paymentIntentId));

    await expect(dispatchState(order.orderId)).resolves.toMatchObject({ status: "superseded" });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ status: "refunded" });
  });

  it("never cancels a shipped order's production (a return case)", async () => {
    const order = await paidOrder();
    await env.DB.prepare("UPDATE orders SET status = 'shipped' WHERE order_id = ?")
      .bind(order.orderId)
      .run();

    await refund(order.orderId, { amountMinor: 20_000, reason: "returned" });

    await expect(dispatchState(order.orderId)).resolves.toMatchObject({
      cancel_requested: 0,
      status: "pending",
    });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ status: "refunded" });
  });
});

describe("settlement is deduped by the Stripe refund id", () => {
  it("applies a pending refund's success once, whichever events carry it", async () => {
    const order = await paidOrder();
    stripe.refundStatus = "pending";
    const response = await refund(order.orderId, { amountMinor: 6_000, reason: "a" });
    const { refund: created } = await response.json<{ refund: { refundId: string } }>();
    const atStripe = stripe.setRefundStatus([...stripe.refunds.keys()][0] as string, "succeeded");
    const object = refundObject(atStripe, order.paymentIntentId);

    const updated = await postEvent("refund.updated", object);
    const replay = await postEvent("refund.updated", object, { eventId: updated.eventId });
    const other = await postEvent("charge.refunded", {
      amount: 20_000,
      amount_refunded: 6_000,
      id: next("ch"),
      object: "charge",
      payment_intent: order.paymentIntentId,
      refunds: { data: [object], object: "list" },
    });

    for (const r of [updated.response, replay.response, other.response]) {
      expect(r.status).toBe(200);
    }
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 6_000,
      refunded_total_minor: 6_000,
      stripe_amount_refunded_minor: 6_000,
    });
    const ops = await refundOps(order.orderId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: created.refundId, state: "succeeded" });
    await expect(paymentEventRow(updated.eventId)).resolves.toMatchObject({ outcome: "processed", reason_code: null });
  });

  it("two facts racing past the same read settle the refund exactly once", async () => {
    const order = await paidOrder();
    stripe.refundStatus = "pending";
    await refund(order.orderId, { amountMinor: 6_000, reason: "a" });
    const atStripe = stripe.setRefundStatus([...stripe.refunds.keys()][0] as string, "succeeded");
    const fact = {
      amount: 6_000,
      operationId: null,
      paymentIntentId: order.paymentIntentId,
      status: "succeeded",
      stripeRefundId: atStripe.id,
    };

    // Both read the op as 'submitted'; both commit a transition batch.
    const gated = gatedDb(2);
    const results = await Promise.all([
      applyRefundFact(gated, fact, Date.now()),
      applyRefundFact(gated, fact, Date.now()),
    ]);

    expect(results.map((r) => r.result).sort()).toEqual(["applied", "unchanged"]);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 6_000,
      refunded_total_minor: 6_000,
    });
  });

  it("releases a submitted refund that fails at Stripe", async () => {
    const order = await paidOrder();
    stripe.refundStatus = "pending";
    await refund(order.orderId, { amountMinor: 6_000, reason: "a" });
    const failed = stripe.setRefundStatus([...stripe.refunds.keys()][0] as string, "failed");

    await postEvent("refund.failed", refundObject(failed, order.paymentIntentId));

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 0,
      status: "paid",
    });
    expect((await refundOps(order.orderId))[0]?.state).toBe("failed");
  });

  it("walks the money back when a refund fails AFTER succeeding, and alerts", async () => {
    const order = await paidOrder();
    await refund(order.orderId, { amountMinor: 20_000, reason: "a" });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ status: "refunded" });
    const failed = stripe.setRefundStatus([...stripe.refunds.keys()][0] as string, "failed");

    await postEvent("refund.failed", refundObject(failed, order.paymentIntentId));

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_succeeded_minor: 0,
      refunded_total_minor: 0,
      status: "paid",
    });
    const opId = (await refundOps(order.orderId))[0]?.id as string;
    expect(await openAlerts("refund_failed_after_success", opId)).toHaveLength(1);
  });

  it("refuses to move money when Stripe reports a different amount for the operation", async () => {
    const order = await paidOrder();
    stripe.refundStatus = "pending";
    await refund(order.orderId, { amountMinor: 6_000, reason: "a" });
    const atStripe = [...stripe.refunds.values()][0]!;

    const { eventId } = await postEvent(
      "refund.updated",
      refundObject({ ...atStripe, amount: 6_001, status: "succeeded" }, order.paymentIntentId),
    );

    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 6_000,
      refund_succeeded_minor: 0,
    });
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({
      outcome: "rejected",
      reason_code: "refund_amount_mismatch",
    });
    const opId = (await refundOps(order.orderId))[0]?.id as string;
    expect(await openAlerts("refund_unsettled_30m", opId)).toHaveLength(1);
  });
});

describe("dashboard refunds (no operation here)", () => {
  it("creates the operation from the event and reconciles the order", async () => {
    const order = await paidOrder();
    const dash = stripe.addDashboardRefund(order.paymentIntentId, 4_000);

    const { eventId, response } = await postEvent("refund.created", refundObject(dash, order.paymentIntentId));

    expect(response.status).toBe(200);
    const ops = await refundOps(order.orderId);
    expect(ops).toEqual([
      {
        amount_minor: 4_000,
        created_by: null,
        id: ops[0]?.id,
        origin: "stripe",
        reason: "stripe_dashboard",
        state: "succeeded",
        stripe_refund_id: dash.id,
      },
    ]);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_succeeded_minor: 4_000,
      status: "partially_refunded",
    });
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({ outcome: "processed", tenant_id: TENANT_A });

    // The same refund again, as another event: nothing more.
    await postEvent("refund.updated", refundObject(dash, order.paymentIntentId));
    expect(await refundOps(order.orderId)).toHaveLength(1);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ refund_succeeded_minor: 4_000 });
  });

  it("holds a pending dashboard refund as a reservation until it settles", async () => {
    const order = await paidOrder();
    const dash = stripe.addDashboardRefund(order.paymentIntentId, 4_000, "pending");

    await postEvent("refund.created", refundObject(dash, order.paymentIntentId));
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 4_000,
      refund_succeeded_minor: 0,
    });
    // The admin cannot refund into it.
    expect((await refund(order.orderId, { amountMinor: 16_001, reason: "x" })).status).toBe(409);

    await postEvent("refund.updated", refundObject({ ...dash, status: "succeeded" }, order.paymentIntentId));
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      refund_reserved_minor: 0,
      refund_succeeded_minor: 4_000,
    });
  });

  it("concurrent deliveries of one dashboard refund create one operation", async () => {
    const order = await paidOrder();
    const dash = stripe.addDashboardRefund(order.paymentIntentId, 3_000);
    const object = refundObject(dash, order.paymentIntentId);

    await Promise.all([
      postEvent("refund.created", object),
      postEvent("refund.updated", object),
      postEvent("charge.refunded", {
        amount: 20_000,
        amount_refunded: 3_000,
        id: next("ch"),
        payment_intent: order.paymentIntentId,
        refunds: { data: [object] },
      }),
    ]);

    expect(await refundOps(order.orderId)).toHaveLength(1);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ refund_succeeded_minor: 3_000 });
  });

  it("ignores a refund on an intent that is not an order here", async () => {
    const { eventId } = await postEvent(
      "refund.created",
      refundObject({ amount: 100, id: next("re_x"), status: "succeeded" }, next("pi_foreign")),
    );
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({
      outcome: "ignored",
      reason_code: "unknown_payment_intent",
    });
  });

  it("rejects a malformed refund object", async () => {
    const { eventId } = await postEvent("refund.updated", { id: 42, object: "refund" });
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({
      outcome: "rejected",
      reason_code: "malformed_object",
    });
  });
});

describe("GET /v1/admin/orders/:orderId", () => {
  it("returns the money facts with ONE fee figure and the payout card", async () => {
    const order = await paidOrder();
    await refund(order.orderId, { amountMinor: 5_000, reason: "goodwill" });

    const response = await readOrder(order.orderId);

    expect(response.status).toBe(200);
    const body = await response.json<{ order: Record<string, unknown> }>();
    const paidAt = body.order.paidAt as string;
    expect(body).toEqual({
      order: {
        // CP2-E: the buyer's consent facts (none on a seeded checkout).
        consent: null,
        // D98: no recipient on a seeded checkout (as before 0045).
        recipient: null,
        // CP5-WB: the buyer, the delivery, the fulfilment, the lines, the
        // parcels and the history (payment track: the webhook, the refund).
        cancelledAt: null,
        createdAt: paidAt,
        customerEmail: expect.stringMatching(/@example\.test$/) as unknown as string,
        deliveryMethod: "pickup",
        fulfilment: "unfulfilled",
        items: [
          {
            lineNo: 1,
            lineTotalMinor: 20_000,
            name: "Tee 0",
            podState: "queued",
            quantity: 1,
            sku: expect.stringMatching(/^SKU-prod_/) as unknown as string,
            unitPriceMinor: 20_000,
            variantLabel: null,
          },
        ],
        shipments: [],
        shippingCountry: null,
        statusHistory: [
          {
            at: paidAt,
            by: "system",
            from: null,
            reason: "stripe.payment_intent.succeeded",
            to: "paid",
            track: "payment",
          },
          {
            at: expect.any(String) as unknown as string,
            by: "admin",
            from: "paid",
            reason: "refund",
            to: "partially_refunded",
            track: "payment",
          },
        ],
        currency: "SEK",
        money: {
          chargedMinor: 20_000,
          dispute: null,
          feeMinor: 13_300,
          refundableMinor: 15_000,
          refundedMinor: 5_000,
          refundPendingMinor: 0,
        },
        orderId: order.orderId,
        orderNumber: expect.any(String) as unknown as string,
        paidAt,
        payout: {
          // 20 000 − 5 000 refunded − 13 300 fee (D9: never returned).
          amountMinor: 1_700,
          eligibleAt: new Date(Date.parse(paidAt) + 14 * 24 * 60 * 60 * 1_000).toISOString(),
          state: "pending",
        },
        refunds: [
          {
            amountMinor: 5_000,
            createdAt: expect.any(String) as unknown as string,
            origin: "admin",
            reason: "goodwill",
            refundId: expect.any(String) as unknown as string,
            state: "succeeded",
          },
        ],
        status: "partially_refunded",
        totals: {
          discountMinor: 0,
          shippingMinor: 0,
          subtotalMinor: 20_000,
          totalMinor: 20_000,
          vatMinor: 0,
        },
        withdrawal: { waived: false },
        // CP4-G: no withdrawal is on record for this order.
        withdrawalRequest: null,
      },
    });
  });

  it("never exposes the fee's breakdown (the seller sees ONE number)", async () => {
    const order = await paidOrder();
    // CP5-WB: the walk below covers the new fields — the lines (with the POD
    // line's seller word), a parcel's shipment, the status history — and the
    // order list, not only the money.
    await env.DB.prepare(
      "UPDATE order_items SET dispatch_state = 'accepted', printer_job_ref = 'JOBREF-DENY-1' WHERE order_id = ?",
    )
      .bind(order.orderId)
      .run();
    const fulfilment = await worker.fetch(
      adminRequest(`/v1/admin/orders/${order.orderId}/fulfilment`, "POST", {
        body: { note: "packas", to: "processing" },
        cookie: adminA.cookie,
        idempotencyKey: crypto.randomUUID(),
        shopId: TENANT_A,
      }),
      moneyEnv(stripe),
    );
    expect(fulfilment.status).toBe(200);
    const response = await readOrder(order.orderId);
    const listResponse = await worker.fetch(
      adminRequest("/v1/admin/orders", "GET", { cookie: adminA.cookie, origin: null, shopId: TENANT_A }),
      moneyEnv(stripe),
    );
    expect(listResponse.status).toBe(200);
    const detailText = await response.text();
    const listText = await listResponse.text();
    const text = `${detailText}${listText}`;
    const body = [JSON.parse(detailText), JSON.parse(listText)] as unknown;
    const detail = JSON.parse(detailText) as {
      order: { items: unknown[]; statusHistory: unknown[] };
    };
    expect(detail.order.items).toHaveLength(1);
    expect(detail.order.statusHistory.length).toBeGreaterThanOrEqual(2);
    expect((JSON.parse(listText) as { orders: unknown[] }).orders.length).toBeGreaterThanOrEqual(1);

    const DENYLIST = [
      "withh", "production", "cost", "commission", "bps", "snapshot",
      "printer", "connect", "transfer", "stripe", "applicationfee", "application_fee",
    ];
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key);
          walk(inner);
        }
      }
    };
    walk(body);
    for (const key of keys) {
      for (const denied of DENYLIST) {
        expect(key.toLowerCase()).not.toContain(denied);
      }
    }

    // Neither half of the 13 300 fee may appear anywhere: not the 12 300
    // withheld, not the 1 000 commission, not the per-line 9 840 cost.
    // As a number of its own: the text also holds random ids and addresses,
    // whose digits can spell either figure by chance.
    expect(text).not.toMatch(/[^0-9A-Za-z_-]12300[^0-9A-Za-z_-]/);
    expect(text).not.toMatch(/[^0-9A-Za-z_-]9840[^0-9A-Za-z_-]/);
    // (the detail only: the list legitimately shows other orders' 1 000 refunds)
    expect(detailText).not.toMatch(/[^0-9]1000[^0-9]/);
    expect(text).not.toContain(accountA);
    expect(text).not.toContain(order.paymentIntentId);
    expect(text).not.toContain("2500170");
    // CP5-WB: no printer job reference, no user id (the history says a kind).
    expect(text).not.toContain("JOBREF-DENY-1");
    expect(text).not.toContain(adminA.userId);
  });

  it("404s another shop's order and a malformed id", async () => {
    const order = await paidOrder();
    expect((await readOrder(order.orderId, { admin: adminB, shopId: TENANT_B })).status).toBe(404);
    expect((await readOrder(order.orderId, { admin: adminB, shopId: TENANT_A })).status).toBe(404);
    expect((await readOrder("nope")).status).toBe(404);
  });

  it("reports a dispute and blocks refunds while it is open", async () => {
    const order = await paidOrder();
    await env.DB.prepare(
      "UPDATE orders SET dispute_status = 'needs_response', dispute_amount_minor = 20000, payout_state = 'blocked' WHERE order_id = ?",
    )
      .bind(order.orderId)
      .run();

    const body = await (await readOrder(order.orderId)).json<{
      order: { money: { dispute: unknown; refundableMinor: number }; payout: { state: string } };
    }>();
    expect(body.order.money.dispute).toEqual({ amountMinor: 20_000, status: "needs_response" });
    expect(body.order.money.refundableMinor).toBe(0);
    expect(body.order.payout.state).toBe("blocked");
  });
});

describe("schema backstops", () => {
  it("refuses an illegal state transition, a delete, and an amount change", async () => {
    const order = await paidOrder();
    await refund(order.orderId, { amountMinor: 1_000, reason: "a" });
    const opId = (await refundOps(order.orderId))[0]?.id as string;

    await expect(
      env.DB.prepare("UPDATE refund_operations SET state = 'reserved' WHERE id = ?").bind(opId).run(),
    ).rejects.toThrow(/not allowed/);
    await expect(
      env.DB.prepare("UPDATE refund_operations SET amount_minor = 2 WHERE id = ?").bind(opId).run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.DB.prepare("DELETE FROM refund_operations WHERE id = ?").bind(opId).run(),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses an operation filed under another shop, and refunds above the charge", async () => {
    const order = await paidOrder();
    const now = new Date().toISOString();
    await expect(
      env.DB.prepare(
        `INSERT INTO refund_operations (id, tenant_id, order_id, amount_minor, state, origin,
           reason, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 100, 'reserved', 'admin', 'x', 'u', ?, ?)`,
      )
        .bind(next("op"), TENANT_B, order.orderId, now, now)
        .run(),
    ).rejects.toThrow(/tenant_id must match/);
    await expect(
      env.DB.prepare(
        "UPDATE orders SET refund_succeeded_minor = 20001, refunded_total_minor = 20001 WHERE order_id = ?",
      )
        .bind(order.orderId)
        .run(),
    ).rejects.toThrow(/bounds/);
    await expect(
      env.DB.prepare("UPDATE orders SET refund_succeeded_minor = 5 WHERE order_id = ?")
        .bind(order.orderId)
        .run(),
    ).rejects.toThrow(/bounds/);
  });
});
