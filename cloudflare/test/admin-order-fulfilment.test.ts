import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import type { FulfilmentFacts, FulfilmentState, FulfilmentTarget } from "../src/commerce/fulfilment";
import { decideFulfilment, FULFILMENT_STATES } from "../src/commerce/fulfilment";
import { SKU, seedOrder } from "./dispatch-fixtures";
import type { Admin } from "./money-fixtures";
import {
  adminRequest,
  FakeMoneyStripe,
  moneyEnv,
  payCheckout,
  seedCheckout,
  seedTenant,
  signUpAdmin,
} from "./money-fixtures";

/**
 * CP5-WB — `POST /v1/admin/orders/:orderId/fulfilment` (src/commerce/fulfilment.ts),
 * the order read's new fields, and migration 0046.
 *
 * The rule the unit exists for: a refund never erases that an order was
 * shipped, and a shipment never erases that it was refunded or cancelled.
 */

const TENANT_A = "tenant-wb-ful-a";
const TENANT_B = "tenant-wb-ful-b";
let accountA: string;
let adminA: Admin;
let adminB: Admin;
let stripe: FakeMoneyStripe;

beforeAll(async () => {
  accountA = (await seedTenant(TENANT_A)) as string;
  await seedTenant(TENANT_B);
  adminA = await signUpAdmin("wb-ful-a@example.test", TENANT_A);
  adminB = await signUpAdmin("wb-ful-b@example.test", TENANT_B);
});

beforeEach(() => {
  stripe = new FakeMoneyStripe();
});

interface ChangeBody {
  fulfilment: {
    at: string;
    from: string;
    orderId: string;
    shipment: { carrier: string | null; createdAt: string; trackingNumber: string | null } | null;
    to: string;
  };
}

async function move(
  orderId: string,
  body: unknown,
  options: {
    admin?: Admin | null;
    key?: string | null;
    origin?: string | null;
    shopId?: string | null;
  } = {},
): Promise<Response> {
  const admin = options.admin === undefined ? adminA : options.admin;
  return worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}/fulfilment`, "POST", {
      body,
      cookie: admin?.cookie,
      idempotencyKey: options.key === undefined ? crypto.randomUUID() : options.key,
      origin: options.origin,
      shopId: options.shopId === undefined ? TENANT_A : options.shopId,
    }),
    moneyEnv(stripe),
  );
}

async function moveOk(orderId: string, body: unknown, key?: string): Promise<ChangeBody> {
  const response = await move(orderId, body, { key });
  expect(response.status, JSON.stringify(body)).toBe(200);
  return response.json<ChangeBody>();
}

async function refusal(orderId: string, body: unknown): Promise<string> {
  const response = await move(orderId, body);
  expect(response.status, JSON.stringify(body)).toBe(409);
  const json = await response.json<{ error: { code: string; reason: string } }>();
  expect(json.error.code).toBe("fulfilment_not_allowed");
  return json.error.reason;
}

async function orderRow(orderId: string) {
  return env.DB.prepare(
    "SELECT status, fulfilment_status, cancelled_at FROM orders WHERE order_id = ?",
  )
    .bind(orderId)
    .first<{ cancelled_at: string | null; fulfilment_status: string; status: string }>();
}

async function readOrder(orderId: string, admin: Admin = adminA, shopId = TENANT_A) {
  const response = await worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}`, "GET", { cookie: admin.cookie, origin: null, shopId }),
    moneyEnv(stripe),
  );
  expect(response.status).toBe(200);
  return response;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? -1;
}

/** A plain (non-POD) order, parcel or pickup. */
function plainOrder(deliveryMethod: "pickup" | "shipping", tenantId = TENANT_A) {
  return seedOrder(tenantId, { deliveryMethod, lines: [{ production: "none" }] });
}

/** A paid, Connect-charged pickup order through the real webhook (refundable). */
async function paidOrder(): Promise<string> {
  const checkout = await seedCheckout({
    connect: { accountId: accountA, feeMinor: 1_500, withheldMinor: 0 },
    tenantId: TENANT_A,
    unitPriceMinor: 20_000,
  });
  const orderId = await payCheckout(checkout, TENANT_A);
  stripe.addIntent({ amount: 20_000, id: checkout.paymentIntentId as string, status: "succeeded" });
  return orderId;
}

async function refund(orderId: string, amountMinor: number): Promise<void> {
  const response = await worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}/refunds`, "POST", {
      body: { amountMinor, reason: "buyer" },
      cookie: adminA.cookie,
      shopId: TENANT_A,
    }),
    moneyEnv(stripe),
  );
  expect(response.status).toBe(201);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("the fulfilment route's refusals", () => {
  it("404s without a session, for another shop, cross-site, without an origin and for a foreign order", async () => {
    const order = await plainOrder("shipping");
    const foreign = await plainOrder("shipping", TENANT_B);
    const body = { to: "processing" };

    expect((await move(order.orderId, body, { admin: null })).status).toBe(404);
    expect((await move(order.orderId, body, { shopId: null })).status).toBe(404);
    expect((await move(order.orderId, body, { admin: adminB })).status).toBe(404);
    expect((await move(order.orderId, body, { origin: "https://evil.test" })).status).toBe(404);
    expect((await move(order.orderId, body, { origin: null })).status).toBe(404);
    expect((await move(foreign.orderId, body)).status).toBe(404);
    expect((await move(order.orderId, body, { admin: adminB, shopId: TENANT_B })).status).toBe(404);
    for (const malformed of ["nope", order.orderId.toUpperCase(), `${order.orderId}x`]) {
      expect((await move(malformed, body)).status).toBe(404);
    }
    // Nothing moved.
    expect((await orderRow(order.orderId))?.fulfilment_status).toBe("unfulfilled");
    expect((await orderRow(foreign.orderId))?.fulfilment_status).toBe("unfulfilled");
  });

  it("demands an Idempotency-Key and exactly the body's shape", async () => {
    const order = await plainOrder("shipping");
    for (const key of [null, "not-a-uuid"]) {
      const response = await move(order.orderId, { to: "processing" }, { key });
      expect(response.status).toBe(400);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
        "idempotency_key_required",
      );
    }
    for (const body of [
      undefined,
      "processing",
      [],
      {},
      { to: "unfulfilled" },
      { to: "sent" },
      { status: "shipped" },
      { to: "shipped", extra: 1 },
      { to: "processing", trackingNumber: "RR123SE" },
      { to: "processing", carrier: "PostNord" },
      { to: "shipped", trackingNumber: "" },
      { to: "shipped", trackingNumber: "x".repeat(101) },
      { to: "shipped", carrier: "line\nbreak" },
      { to: "shipped", trackingNumber: 123 },
      { note: "x".repeat(501), to: "processing" },
    ]) {
      const response = await move(order.orderId, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await orderRow(order.orderId))?.fulfilment_status).toBe("unfulfilled");
  });
});

describe("the transition table", () => {
  /** The table, written out independently of the module's. */
  const ALLOWED: Record<FulfilmentState, FulfilmentTarget[]> = {
    completed: [],
    delivered: ["completed"],
    processing: ["shipped", "ready_for_pickup"],
    ready_for_pickup: ["delivered", "completed"],
    shipped: ["shipped", "delivered", "completed"],
    unfulfilled: ["processing", "shipped", "ready_for_pickup"],
  };
  const TARGETS: FulfilmentTarget[] = ["processing", "shipped", "ready_for_pickup", "delivered", "completed"];
  const open = (fulfilment: FulfilmentState, deliveryMethod: string): FulfilmentFacts => ({
    cancelledAt: null,
    chargedMinor: 10_000,
    deliveryMethod,
    fulfilment,
    refundSucceededMinor: 0,
    status: "paid",
    unsentPodLines: 0,
  });

  it("decides every edge of both delivery methods as the table says", () => {
    for (const deliveryMethod of ["shipping", "pickup"]) {
      for (const from of FULFILMENT_STATES) {
        for (const to of TARGETS) {
          const decision = decideFulfilment(open(from, deliveryMethod), { to, trackingNumber: "T1" });
          const expected =
            (to === "shipped" && deliveryMethod !== "shipping") ||
            (to === "ready_for_pickup" && deliveryMethod !== "pickup")
              ? "delivery_method"
              : ALLOWED[from].includes(to)
                ? null
                : "transition";
          expect(decision, `${deliveryMethod}: ${from} → ${to}`).toBe(expected);
        }
      }
    }
  });

  it("closes every edge of a cancelled or fully refunded order, and keeps a partly refunded one open", () => {
    for (const from of FULFILMENT_STATES) {
      for (const to of TARGETS) {
        const base = open(from, "shipping");
        expect(decideFulfilment({ ...base, cancelledAt: "2026-10-01T00:00:00.000Z" }, { to, trackingNumber: "T" })).toBe("order_closed");
        expect(decideFulfilment({ ...base, status: "refunded" }, { to, trackingNumber: "T" })).toBe("order_closed");
        expect(decideFulfilment({ ...base, refundSucceededMinor: 10_000 }, { to, trackingNumber: "T" })).toBe("order_closed");
      }
    }
    expect(
      decideFulfilment({ ...open("unfulfilled", "shipping"), refundSucceededMinor: 1, status: "partially_refunded" }, { to: "shipped", trackingNumber: null }),
    ).toBeNull();
  });

  it("refuses shipped → shipped without a tracking number, and a POD line the printer has not sent", () => {
    expect(decideFulfilment(open("shipped", "shipping"), { to: "shipped", trackingNumber: null })).toBe("tracking_required");
    const pod = { ...open("processing", "shipping"), unsentPodLines: 1 };
    expect(decideFulfilment(pod, { to: "shipped", trackingNumber: "T" })).toBe("printer_ships");
    expect(decideFulfilment({ ...pod, deliveryMethod: "pickup" }, { to: "ready_for_pickup", trackingNumber: null })).toBe("printer_ships");
    expect(decideFulfilment({ ...pod, fulfilment: "unfulfilled" }, { to: "processing", trackingNumber: null })).toBeNull();
  });

  it("walks a parcel through every step over the route, and refuses what the table refuses", async () => {
    const order = await plainOrder("shipping");
    expect(await refusal(order.orderId, { to: "ready_for_pickup" })).toBe("delivery_method");
    expect(await refusal(order.orderId, { to: "delivered" })).toBe("transition");
    expect(await refusal(order.orderId, { to: "completed" })).toBe("transition");

    expect((await moveOk(order.orderId, { to: "processing" })).fulfilment).toMatchObject({
      from: "unfulfilled",
      orderId: order.orderId,
      shipment: null,
      to: "processing",
    });
    expect(await refusal(order.orderId, { to: "processing" })).toBe("transition");

    const shipped = await moveOk(order.orderId, { carrier: "PostNord", to: "shipped", trackingNumber: "RR123456785SE" });
    expect(shipped.fulfilment).toMatchObject({
      from: "processing",
      shipment: { carrier: "PostNord", trackingNumber: "RR123456785SE" },
      to: "shipped",
    });
    expect(shipped.fulfilment.shipment?.createdAt).toBe(shipped.fulfilment.at);
    expect(await refusal(order.orderId, { to: "shipped" })).toBe("tracking_required");
    expect(await refusal(order.orderId, { to: "processing" })).toBe("transition");
    // A second parcel.
    await moveOk(order.orderId, { to: "shipped", trackingNumber: "RR999999995SE" });
    await moveOk(order.orderId, { to: "delivered" });
    expect(await refusal(order.orderId, { to: "shipped", trackingNumber: "X1" })).toBe("transition");
    await moveOk(order.orderId, { note: "Klart", to: "completed" });
    for (const to of ["processing", "shipped", "delivered", "completed"]) {
      expect(await refusal(order.orderId, to === "shipped" ? { to, trackingNumber: "X" } : { to })).toBe("transition");
    }
    expect(await orderRow(order.orderId)).toEqual({ cancelled_at: null, fulfilment_status: "completed", status: "paid" });
  });

  it("walks a pickup order: ready for pickup, then handed over", async () => {
    const order = await plainOrder("pickup");
    expect(await refusal(order.orderId, { to: "shipped" })).toBe("delivery_method");
    await moveOk(order.orderId, { to: "ready_for_pickup" });
    expect(await refusal(order.orderId, { to: "shipped", trackingNumber: "X" })).toBe("delivery_method");
    expect(await refusal(order.orderId, { to: "processing" })).toBe("transition");
    await moveOk(order.orderId, { to: "completed" });
    expect((await orderRow(order.orderId))?.fulfilment_status).toBe("completed");
  });
});

describe("the printer ships every POD line", () => {
  it("a parcel with an unsent POD line cannot be shipped by the seller until the printer sent it", async () => {
    const order = await seedOrder(TENANT_A, {
      deliveryMethod: "shipping",
      lines: [{ production: "none" }, { production: "pod" }],
    });
    await moveOk(order.orderId, { to: "processing" });
    expect(await refusal(order.orderId, { to: "shipped", trackingNumber: "RR1SE" })).toBe("printer_ships");
    expect(await count("SELECT COUNT(*) AS n FROM order_shipments WHERE order_id = ?", order.orderId)).toBe(0);

    await env.DB.prepare(
      "UPDATE order_items SET production_state = 'shipped' WHERE order_id = ? AND production_json IS NOT NULL",
    )
      .bind(order.orderId)
      .run();
    await moveOk(order.orderId, { to: "shipped", trackingNumber: "RR1SE" });
  });

  it("a pickup order's POD line must have left the printer before the order is ready for pickup", async () => {
    const order = await seedOrder(TENANT_A, { deliveryMethod: "pickup" });
    expect(await refusal(order.orderId, { to: "ready_for_pickup" })).toBe("printer_ships");
    await env.DB.prepare("UPDATE order_items SET production_state = 'shipped' WHERE order_id = ?")
      .bind(order.orderId)
      .run();
    await moveOk(order.orderId, { to: "ready_for_pickup" });
  });
});

describe("one batch: history, shipment, audit, outbox, order", () => {
  it("writes each of them once, carrying ids only to the outbox, and never touches status", async () => {
    const order = await plainOrder("shipping");
    const key = crypto.randomUUID();
    const change = await moveOk(
      order.orderId,
      { carrier: "DHL", note: "Packad", to: "shipped", trackingNumber: "JD0001" },
      key,
    );

    const history = await env.DB.prepare(
      `SELECT history_id, from_status, to_status, actor_user_id, reason, created_at, track, client_key
       FROM order_status_history WHERE order_id = ? AND track = 'fulfilment'`,
    )
      .bind(order.orderId)
      .all<Record<string, unknown> & { history_id: string }>();
    expect(history.results).toHaveLength(1);
    const historyId = history.results[0]?.history_id as string;
    expect(history.results[0]).toEqual({
      actor_user_id: adminA.userId,
      client_key: key,
      created_at: Date.parse(change.fulfilment.at),
      from_status: "unfulfilled",
      history_id: historyId,
      reason: "Packad",
      to_status: "shipped",
      track: "fulfilment",
    });

    const shipment = await env.DB.prepare(
      "SELECT tenant_id, history_id, tracking_number, carrier, created_at, created_by FROM order_shipments WHERE order_id = ?",
    )
      .bind(order.orderId)
      .all();
    expect(shipment.results).toEqual([
      {
        carrier: "DHL",
        created_at: change.fulfilment.at,
        created_by: adminA.userId,
        history_id: historyId,
        tenant_id: TENANT_A,
        tracking_number: "JD0001",
      },
    ]);

    const audit = await env.DB.prepare(
      "SELECT tenant_id, actor_user_id, action, resource_type, reason, metadata_json FROM audit_events WHERE resource_id = ? AND action = 'order.fulfilment'",
    )
      .bind(order.orderId)
      .all<{ metadata_json: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]).toMatchObject({
      action: "order.fulfilment",
      actor_user_id: adminA.userId,
      reason: "Packad",
      resource_type: "order",
      tenant_id: TENANT_A,
    });
    expect(JSON.parse(audit.results[0]?.metadata_json as string)).toEqual({
      from: "unfulfilled",
      historyId,
      to: "shipped",
    });

    const outbox = await env.DB.prepare(
      "SELECT outbox_id, tenant_id, aggregate_type, aggregate_id, dedupe_key, payload_json, status FROM outbox_events WHERE event_type = 'email.order_status' AND aggregate_id = ?",
    )
      .bind(order.orderId)
      .all<{ payload_json: string }>();
    expect(outbox.results).toHaveLength(1);
    expect(outbox.results[0]).toMatchObject({
      aggregate_type: "order",
      dedupe_key: `email.order_status:${historyId}`,
      outbox_id: `email-order-status:${historyId}`,
      status: "pending",
      tenant_id: TENANT_A,
    });
    expect(JSON.parse(outbox.results[0]?.payload_json as string)).toEqual({ historyId, orderId: order.orderId });

    expect(await orderRow(order.orderId)).toEqual({ cancelled_at: null, fulfilment_status: "shipped", status: "paid" });
  });

  it("a refused change writes nothing", async () => {
    const order = await plainOrder("pickup");
    await refusal(order.orderId, { to: "shipped" });
    expect(await count("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ? AND track = 'fulfilment'", order.orderId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'order.fulfilment'", order.orderId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ? AND event_type = 'email.order_status'", order.orderId)).toBe(0);
  });
});

describe("idempotency", () => {
  it("a retry with the same key and request replays the first change; nothing is written twice", async () => {
    const order = await plainOrder("shipping");
    const key = crypto.randomUUID();
    const body = { to: "shipped", trackingNumber: "RR5SE" };
    const first = await move(order.orderId, body, { key });
    const again = await move(order.orderId, body, { key: key.toUpperCase() });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(first.headers.get("Idempotent-Replayed")).toBeNull();
    expect(await again.json()).toEqual(await first.json());
    expect(await count("SELECT COUNT(*) AS n FROM order_shipments WHERE order_id = ?", order.orderId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ? AND event_type = 'email.order_status'", order.orderId)).toBe(1);
  });

  it("the same key for another request or another order is a 409 conflict", async () => {
    const order = await plainOrder("shipping");
    const other = await plainOrder("shipping");
    const key = crypto.randomUUID();
    await moveOk(order.orderId, { to: "processing" }, key);
    for (const [orderId, body] of [
      [order.orderId, { note: "x", to: "processing" }],
      [order.orderId, { to: "shipped" }],
      [other.orderId, { to: "processing" }],
    ] as const) {
      const response = await move(orderId, body, { key });
      expect(response.status).toBe(409);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("conflict");
    }
    expect((await orderRow(other.orderId))?.fulfilment_status).toBe("unfulfilled");
  });

  it("two concurrent requests with one key make one change, and both see it", async () => {
    const order = await plainOrder("shipping");
    const key = crypto.randomUUID();
    const responses = await Promise.all([
      move(order.orderId, { to: "processing" }, { key }),
      move(order.orderId, { to: "processing" }, { key }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await count("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ? AND track = 'fulfilment'", order.orderId)).toBe(1);
  });

  it("two concurrent different changes from one state: one wins, the other is decided again", async () => {
    const order = await plainOrder("shipping");
    const responses = await Promise.all([
      move(order.orderId, { to: "processing" }),
      move(order.orderId, { to: "processing" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await count("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ? AND track = 'fulfilment'", order.orderId)).toBe(1);
  });
});

describe("money and fulfilment never erase each other", () => {
  it("a full refund keeps that the order was made ready; the order then takes no change", async () => {
    const orderId = await paidOrder();
    await moveOk(orderId, { to: "ready_for_pickup" });
    await refund(orderId, 20_000);
    expect(await orderRow(orderId)).toEqual({ cancelled_at: null, fulfilment_status: "ready_for_pickup", status: "refunded" });
    expect(await refusal(orderId, { to: "completed" })).toBe("order_closed");
  });

  it("a fulfilment change keeps a partial refund; a refund after it keeps the step", async () => {
    const orderId = await paidOrder();
    await refund(orderId, 5_000);
    await moveOk(orderId, { to: "processing" });
    expect(await orderRow(orderId)).toEqual({ cancelled_at: null, fulfilment_status: "processing", status: "partially_refunded" });
    await moveOk(orderId, { to: "ready_for_pickup" });
    await refund(orderId, 5_000);
    expect(await orderRow(orderId)).toEqual({ cancelled_at: null, fulfilment_status: "ready_for_pickup", status: "partially_refunded" });

    const history = await env.DB.prepare(
      "SELECT track, from_status, to_status FROM order_status_history WHERE order_id = ? ORDER BY created_at, rowid",
    )
      .bind(orderId)
      .all();
    expect(history.results).toEqual([
      { from_status: null, to_status: "paid", track: "payment" },
      { from_status: "paid", to_status: "partially_refunded", track: "payment" },
      { from_status: "unfulfilled", to_status: "processing", track: "fulfilment" },
      { from_status: "processing", to_status: "ready_for_pickup", track: "fulfilment" },
    ]);
  });

  it("a cancelled order takes no change", async () => {
    const order = await plainOrder("shipping");
    await moveOk(order.orderId, { to: "processing" });
    const cancel = await worker.fetch(
      adminRequest(`/v1/admin/orders/${order.orderId}/cancel`, "POST", {
        body: { reason: "buyer asked" },
        cookie: adminA.cookie,
        shopId: TENANT_A,
      }),
      env,
    );
    expect(cancel.status).toBe(200);
    expect(await refusal(order.orderId, { to: "shipped", trackingNumber: "RR1SE" })).toBe("order_closed");
    expect((await orderRow(order.orderId))?.fulfilment_status).toBe("processing");
  });

  it("the cancellation's return case reads the fulfilment column", async () => {
    const cancel = (orderId: string) =>
      worker.fetch(
        adminRequest(`/v1/admin/orders/${orderId}/cancel`, "POST", {
          body: { reason: "too late?" },
          cookie: adminA.cookie,
          shopId: TENANT_A,
        }),
        env,
      );
    for (const steps of [
      [{ to: "shipped", trackingNumber: "RR2SE" }],
      [{ to: "shipped", trackingNumber: "RR3SE" }, { to: "delivered" }],
      [{ to: "shipped", trackingNumber: "RR4SE" }, { to: "completed" }],
    ]) {
      const order = await plainOrder("shipping");
      for (const step of steps) {
        await moveOk(order.orderId, step);
      }
      const response = await cancel(order.orderId);
      expect(response.status).toBe(409);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("return_case");
      expect((await orderRow(order.orderId))?.cancelled_at).toBeNull();
    }

    const ready = await plainOrder("pickup");
    await moveOk(ready.orderId, { to: "ready_for_pickup" });
    expect((await cancel(ready.orderId)).status).toBe(409);

    // Processing is not past the shop: it still cancels.
    const processing = await plainOrder("pickup");
    await moveOk(processing.orderId, { to: "processing" });
    expect((await cancel(processing.orderId)).status).toBe(200);
  });
});

describe("acting-as", () => {
  it("an operator under a grant may change it; the audit names the grant and the history says 'platform'", async () => {
    const operator = await signUpAdmin("wb-ful-operator@example.test", null);
    const now = Date.now();
    const grantId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("UPDATE identity_access SET account_type = 'platform_admin' WHERE user_id = ?").bind(operator.userId),
      env.DB.prepare(
        `INSERT INTO acting_as_grants (id, platform_user_id, tenant_id, created_at, expires_at, reason)
         VALUES (?, ?, ?, ?, ?, 'support')`,
      ).bind(grantId, operator.userId, TENANT_A, new Date(now).toISOString(), new Date(now + 3_600_000).toISOString()),
    ]);

    const order = await plainOrder("shipping");
    await moveOk(order.orderId, { to: "processing" });
    const response = await move(order.orderId, { to: "shipped", trackingNumber: "OP1" }, { admin: operator });
    expect(response.status).toBe(200);

    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE resource_id = ? AND actor_user_id = ? AND action = 'order.fulfilment'",
    )
      .bind(order.orderId, operator.userId)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit?.metadata_json as string)).toMatchObject({ actingAsGrantId: grantId });

    const detail = await (await readOrder(order.orderId)).json<{
      order: { statusHistory: Array<{ by: string; to: string; track: string }> };
    }>();
    expect(detail.order.statusHistory.map((row) => [row.track, row.to, row.by])).toEqual([
      ["fulfilment", "processing", "admin"],
      ["fulfilment", "shipped", "platform"],
    ]);
  });
});

describe("the order read", () => {
  it("adds the lines, the buyer, the delivery, the fulfilment, the shipments and the history", async () => {
    const order = await seedOrder(TENANT_A, {
      customerEmail: "reader@example.test",
      deliveryMethod: "shipping",
      lines: [{ production: "none", quantity: 2, unitPriceMinor: 10_000 }, { production: "pod" }],
    });
    await env.DB.prepare(
      `INSERT INTO order_status_history (history_id, order_id, tenant_id, from_status, to_status, actor_user_id, reason, created_at)
       VALUES (?, ?, ?, NULL, 'paid', NULL, 'stripe.payment_intent.succeeded', ?)`,
    )
      .bind(crypto.randomUUID(), order.orderId, TENANT_A, 1)
      .run();
    await env.DB.prepare(
      "UPDATE order_items SET production_state = 'shipped' WHERE order_id = ? AND production_json IS NOT NULL",
    )
      .bind(order.orderId)
      .run();
    await moveOk(order.orderId, { to: "shipped", trackingNumber: "RR7SE" });

    const body = await (await readOrder(order.orderId)).json<{ order: Record<string, unknown> }>();
    expect(body.order).toMatchObject({
      cancelledAt: null,
      customerEmail: "reader@example.test",
      deliveryMethod: "shipping",
      fulfilment: "shipped",
      shippingCountry: "SE",
      status: "paid",
    });
    expect(typeof body.order.createdAt).toBe("string");
    expect(body.order.items).toEqual([
      {
        lineNo: 1,
        lineTotalMinor: 20_000,
        name: "Tröja 1",
        podState: "none",
        quantity: 2,
        sku: expect.stringMatching(/^sku-prod-cp2b-/) as unknown as string,
        unitPriceMinor: 10_000,
        variantLabel: null,
      },
      {
        lineNo: 2,
        lineTotalMinor: 29_900,
        name: "Tröja 2",
        podState: "sent",
        quantity: 1,
        sku: expect.stringMatching(/^sku-prod-cp2b-/) as unknown as string,
        unitPriceMinor: 29_900,
        variantLabel: null,
      },
    ]);
    expect(body.order.shipments).toEqual([
      { carrier: null, createdAt: expect.any(String) as unknown as string, trackingNumber: "RR7SE" },
    ]);
    expect(body.order.statusHistory).toEqual([
      { at: new Date(1).toISOString(), by: "system", from: null, reason: "stripe.payment_intent.succeeded", to: "paid", track: "payment" },
      { at: expect.any(String) as unknown as string, by: "admin", from: "unfulfilled", reason: null, to: "shipped", track: "fulfilment" },
    ]);
  });

  it("gives each POD line one seller-safe word, from the dispatch", async () => {
    const order = await seedOrder(TENANT_A, { lines: [{}, {}, {}, {}, {}, {}] });
    const set = (index: number, sql: string) =>
      env.DB.prepare(`UPDATE order_items SET ${sql} WHERE order_id = ? AND item_index = ?`)
        .bind(order.orderId, index)
        .run();
    // 0 stays queued (no dispatch yet).
    await set(1, "dispatch_state = 'submitting'");
    await set(2, "dispatch_state = 'accepted', printer_job_ref = 'JOBREF-WB-SECRET'");
    await set(3, "dispatch_state = 'failed'");
    await set(4, "dispatch_state = 'cancelled'");
    await set(5, "dispatch_state = 'accepted', production_state = 'produced'");

    const text = await (await readOrder(order.orderId)).text();
    const items = (JSON.parse(text) as { order: { items: Array<{ podState: string }> } }).order.items;
    expect(items.map((item) => item.podState)).toEqual([
      "queued",
      "queued",
      "in_production",
      "failed",
      "cancelled",
      "in_production",
    ]);
    expect(text).not.toContain("JOBREF-WB-SECRET");
  });

  it("never names a fee's part, a printer, a job, a cost or a person (the seller sees ONE number)", async () => {
    const order = await seedOrder(TENANT_A, { deliveryMethod: "shipping", lines: [{ production: "none" }, {}] });
    await env.DB.prepare(
      "UPDATE order_items SET dispatch_state = 'accepted', printer_job_ref = 'JOBREF-WB-DENY', production_state = 'shipped' WHERE order_id = ? AND production_json IS NOT NULL",
    )
      .bind(order.orderId)
      .run();
    await moveOk(order.orderId, { carrier: "PostNord", note: "ok", to: "shipped", trackingNumber: "RR8SE" });

    const text = await (await readOrder(order.orderId)).text();
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
    walk(JSON.parse(text));
    const DENYLIST = [
      "withh", "production", "cost", "commission", "bps", "snapshot",
      "printer", "connect", "transfer", "stripe", "applicationfee", "application_fee",
      "job", "dispatch", "actor", "user", "createdby", "created_by", "clientkey", "client_key", "hash",
    ];
    for (const key of keys) {
      for (const denied of DENYLIST) {
        expect(key.toLowerCase(), key).not.toContain(denied);
      }
    }
    expect(text).not.toContain("JOBREF-WB-DENY");
    expect(text).not.toContain("fake-printer");
    expect(text).not.toContain(SKU);
    expect(text).not.toMatch(/[:,[]9000[,\]}]/);
    expect(text).not.toContain(adminA.userId);
  });
});

describe("migration 0046", () => {
  it("backfills the fulfilment from a status that was a fulfilment one, and leaves status alone", async () => {
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name === "0046_order_fulfilment.sql");
    const backfill = migration?.queries.find((query) => query.trimStart().startsWith("UPDATE orders"));
    expect(backfill).toBeDefined();

    const cases: Array<["pickup" | "shipping", string, string]> = [
      ["shipping", "paid", "unfulfilled"],
      ["shipping", "partially_refunded", "unfulfilled"],
      ["shipping", "refunded", "unfulfilled"],
      ["shipping", "cancelled", "unfulfilled"],
      ["shipping", "processing", "processing"],
      ["shipping", "printed", "processing"],
      ["shipping", "shipped", "shipped"],
      ["pickup", "shipped", "processing"],
      ["pickup", "ready_for_pickup", "ready_for_pickup"],
      ["shipping", "ready_for_pickup", "processing"],
      ["shipping", "delivered", "delivered"],
      ["pickup", "completed", "completed"],
    ];
    const seeded: string[] = [];
    for (const [deliveryMethod, status] of cases) {
      const order = await seedOrder(TENANT_B, { deliveryMethod, lines: [{ production: "none" }] });
      await env.DB.prepare("UPDATE orders SET status = ? WHERE order_id = ?").bind(status, order.orderId).run();
      seeded.push(order.orderId);
    }
    await env.DB.prepare(backfill as string).run();
    for (const [index, [, status, expected]] of cases.entries()) {
      const row = await orderRow(seeded[index] as string);
      expect(row, `${cases[index]?.join(" ")}`).toMatchObject({ fulfilment_status: expected, status });
    }
  });

  it("refuses a shipment's update, delete or replacement, an incoherent step, and a malformed history row", async () => {
    const order = await plainOrder("shipping");
    await moveOk(order.orderId, { to: "shipped", trackingNumber: "RR9SE" });
    const shipment = await env.DB.prepare(
      "SELECT shipment_id, history_id, created_at FROM order_shipments WHERE order_id = ?",
    )
      .bind(order.orderId)
      .first<{ created_at: string; history_id: string; shipment_id: string }>();

    await expect(
      env.DB.prepare("UPDATE order_shipments SET tracking_number = 'X' WHERE shipment_id = ?").bind(shipment?.shipment_id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM order_shipments WHERE shipment_id = ?").bind(shipment?.shipment_id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO order_shipments (shipment_id, tenant_id, order_id, history_id, tracking_number, carrier, created_at, created_by)
         VALUES (?, ?, ?, ?, 'FORGED', NULL, ?, 'x')`,
      )
        .bind(shipment?.shipment_id, TENANT_A, order.orderId, shipment?.history_id, shipment?.created_at)
        .run(),
    ).rejects.toThrow(/never replaced/);

    const pickup = await plainOrder("pickup");
    await expect(
      env.DB.prepare("UPDATE orders SET fulfilment_status = 'shipped' WHERE order_id = ?").bind(pickup.orderId).run(),
    ).rejects.toThrow(/not allowed/);
    await expect(
      env.DB.prepare("UPDATE orders SET fulfilment_status = 'unfulfilled' WHERE order_id = ?").bind(order.orderId).run(),
    ).rejects.toThrow(/not allowed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO order_status_history (history_id, order_id, tenant_id, from_status, to_status, created_at, track)
         VALUES (?, ?, ?, 'unfulfilled', 'shipped', 1, 'fulfilment')`,
      )
        .bind(crypto.randomUUID(), order.orderId, TENANT_A)
        .run(),
    ).rejects.toThrow(/does not match its track/);
  });
});
