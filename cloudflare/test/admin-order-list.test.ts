import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { SKU, seedOrder } from "./dispatch-fixtures";
import type { Admin } from "./money-fixtures";
import { adminRequest, seedTenant, signUpAdmin } from "./money-fixtures";

/**
 * CP5-WB — `GET /v1/admin/orders` (src/commerce/admin-order-list.ts) and the
 * mount order of the five order routes: the list, the detail, the refunds,
 * the cancellation and the fulfilment change never shadow one another.
 */

const TENANT_A = "tenant-wb-list-a";
const TENANT_B = "tenant-wb-list-b";
let adminA: Admin;
let adminB: Admin;

const DAY = 24 * 60 * 60 * 1_000;
const T0 = Date.parse("2026-09-01T10:00:00.000Z");

interface ListBody {
  count: number;
  nextCursor: string | null;
  orders: Array<Record<string, unknown> & { orderId: string; orderNumber: string }>;
  totalMinor: number;
}

async function list(
  query = "",
  options: { admin?: Admin | null; method?: string; shopId?: string | null } = {},
): Promise<Response> {
  const admin = options.admin === undefined ? adminA : options.admin;
  return worker.fetch(
    adminRequest(`/v1/admin/orders${query}`, options.method ?? "GET", {
      cookie: admin?.cookie,
      origin: options.method === undefined ? null : undefined,
      shopId: options.shopId === undefined ? TENANT_A : options.shopId,
    }),
    env,
  );
}

async function listBody(query = ""): Promise<ListBody> {
  const response = await list(query);
  expect(response.status).toBe(200);
  return response.json<ListBody>();
}

let first: Awaited<ReturnType<typeof seedOrder>>;
let second: Awaited<ReturnType<typeof seedOrder>>;
let third: Awaited<ReturnType<typeof seedOrder>>;
let foreign: Awaited<ReturnType<typeof seedOrder>>;

beforeAll(async () => {
  await seedTenant(TENANT_A, { connect: false });
  await seedTenant(TENANT_B, { connect: false });
  adminA = await signUpAdmin("wb-list-a@example.test", TENANT_A);
  adminB = await signUpAdmin("wb-list-b@example.test", TENANT_B);

  // Oldest first: a POD pickup order, a plain parcel of two lines, a plain
  // pickup order. Prices 29 900 per unit, parcel carriage 4 900.
  first = await seedOrder(TENANT_A, {
    createdAt: T0,
    customerEmail: "first@example.test",
  });
  second = await seedOrder(TENANT_A, {
    createdAt: T0 + DAY,
    customerEmail: "second@example.test",
    deliveryMethod: "shipping",
    lines: [{ production: "none", quantity: 2 }, { production: "none" }],
  });
  third = await seedOrder(TENANT_A, {
    createdAt: T0 + 2 * DAY,
    customerEmail: "third@example.test",
    lines: [{ production: "none" }],
  });
  foreign = await seedOrder(TENANT_B, { createdAt: T0 + 3 * DAY, lines: [{ production: "none" }] });

  // The third order's recipient (D98): a pickup place.
  await env.DB.prepare(
    `INSERT INTO order_recipients (
       order_id, tenant_id, delivery_method, name, pickup_location_id,
       pickup_location_name, created_at
     ) VALUES (?, ?, 'pickup', 'Kim Köpare', 'butiken', 'Butiken på torget', ?)`,
  )
    .bind(third.orderId, TENANT_A, new Date(T0).toISOString())
    .run();
  // The second is cancelled, the first is being processed.
  await env.DB.prepare(
    "UPDATE orders SET cancelled_at = ?, cancel_reason = 'buyer asked' WHERE order_id = ?",
  )
    .bind(new Date(T0 + DAY).toISOString(), second.orderId)
    .run();
  await env.DB.prepare("UPDATE orders SET fulfilment_status = 'processing' WHERE order_id = ?")
    .bind(first.orderId)
    .run();
});

describe("the list's refusals", () => {
  it("404s without a session, without X-Shop-Id, and for another shop", async () => {
    expect((await list("", { admin: null })).status).toBe(404);
    expect((await list("", { shopId: null })).status).toBe(404);
    expect((await list("", { admin: adminB, shopId: TENANT_A })).status).toBe(404);
  });

  it("answers no other method (the opaque 404)", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await list("", { method })).status).toBe(404);
    }
  });

  it("refuses an unknown, repeated or malformed parameter", async () => {
    for (const query of [
      "?tenantId=tenant-wb-list-b",
      "?limit=0",
      "?limit=101",
      "?limit=abc",
      "?status=lost",
      "?fulfilment=sent",
      "?since=yesterday",
      "?until=2026-09-01",
      "?cursor=nope",
      "?cursor=123~not-a-uuid",
      "?q=",
      "?q=a%25b",
      "?q=not@an@email",
      "?status=paid&status=refunded",
    ]) {
      const response = await list(query);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_request", message: "Request is not valid" },
      });
    }
  });
});

describe("the list", () => {
  it("lists only the shop's own orders, newest first, field by field", async () => {
    const body = await listBody();
    expect(body.orders.map((order) => order.orderId)).toEqual([
      third.orderId,
      second.orderId,
      first.orderId,
    ]);
    expect(body.orders.map((order) => order.orderId)).not.toContain(foreign.orderId);
    expect(body.count).toBe(3);
    // 29 900 + (2 × 29 900 + 29 900 + 4 900) + 29 900
    expect(body.totalMinor).toBe(29_900 + 94_600 + 29_900);
    expect(body.nextCursor).toBeNull();

    expect(body.orders[0]).toEqual({
      cancelledAt: null,
      createdAt: new Date(T0 + 2 * DAY).toISOString(),
      currency: "SEK",
      customerEmail: "third@example.test",
      deliveryMethod: "pickup",
      fulfilment: "unfulfilled",
      itemCount: 1,
      orderId: third.orderId,
      orderNumber: third.orderNumber,
      paidAt: new Date(T0 + 2 * DAY).toISOString(),
      pickupPlace: "Butiken på torget",
      recipientName: "Kim Köpare",
      refundedMinor: 0,
      status: "paid",
      totalMinor: 29_900,
    });
    expect(body.orders[1]).toMatchObject({
      cancelledAt: new Date(T0 + DAY).toISOString(),
      deliveryMethod: "shipping",
      itemCount: 3,
      pickupPlace: null,
      recipientName: null,
      totalMinor: 94_600,
    });
    expect(body.orders[2]).toMatchObject({ fulfilment: "processing", itemCount: 1 });
  });

  it("pages by cursor; the counters stay the window's", async () => {
    const page1 = await listBody("?limit=2");
    expect(page1.orders.map((order) => order.orderId)).toEqual([third.orderId, second.orderId]);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.count).toBe(3);

    const page2 = await listBody(`?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`);
    expect(page2.orders.map((order) => order.orderId)).toEqual([first.orderId]);
    expect(page2.nextCursor).toBeNull();
    expect(page2.count).toBe(3);
    expect(page2.totalMinor).toBe(page1.totalMinor);
  });

  it("filters by fulfilment, status, window, order number and e-mail address", async () => {
    const ids = async (query: string) =>
      (await listBody(query)).orders.map((order) => order.orderId);

    expect(await ids("?fulfilment=processing")).toEqual([first.orderId]);
    expect(await ids("?fulfilment=shipped")).toEqual([]);
    expect(await ids("?status=cancelled")).toEqual([second.orderId]);
    expect(await ids("?status=paid")).toEqual([third.orderId, second.orderId, first.orderId]);
    expect(
      await ids(
        `?since=${new Date(T0 + DAY).toISOString()}&until=${new Date(T0 + 2 * DAY).toISOString()}`,
      ),
    ).toEqual([second.orderId]);
    expect(await ids(`?q=${second.orderNumber}`)).toEqual([second.orderId]);
    expect(await ids(`?q=${second.orderNumber.slice(0, 3).toLowerCase()}`)).toHaveLength(3);
    expect(await ids("?q=FIRST%40Example.test")).toEqual([first.orderId]);
    // Exact, not a prefix or a part.
    expect(await ids("?q=first%40example.tes")).toEqual([]);
    expect(await ids(`?q=${foreign.orderNumber}`)).not.toContain(foreign.orderId);

    const window = await listBody("?status=cancelled");
    expect(window.count).toBe(1);
    expect(window.totalMinor).toBe(94_600);
  });

  it("never names a fee, a printer, a job or a cost (the seller sees ONE number)", async () => {
    await env.DB.prepare(
      "UPDATE order_items SET dispatch_state = 'accepted', printer_job_ref = 'JOBREF-WB-LIST' WHERE order_id = ?",
    )
      .bind(first.orderId)
      .run();
    const response = await list();
    const text = await response.text();
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
      "fee", "job", "payout", "dispatch", "actor", "user",
    ];
    for (const key of keys) {
      for (const denied of DENYLIST) {
        expect(key.toLowerCase()).not.toContain(denied);
      }
    }
    expect(text).not.toContain("JOBREF-WB-LIST");
    expect(text).not.toContain("fake-printer");
    expect(text).not.toContain(SKU);
    // The seeded production cost and withholding (9 000 each), as a number.
    expect(text).not.toMatch(/[:,[]9000[,\]}]/);
    expect(text).not.toContain(adminA.userId);
  });
});

describe("the five order routes do not shadow one another", () => {
  it("each path reaches its own handler", async () => {
    const orderId = third.orderId;

    // GET /v1/admin/orders → the list.
    expect(Object.keys(await listBody()).sort()).toEqual(["count", "nextCursor", "orders", "totalMinor"]);

    // GET /v1/admin/orders/:orderId → the detail, not the list.
    const detail = await worker.fetch(
      adminRequest(`/v1/admin/orders/${orderId}`, "GET", { cookie: adminA.cookie, origin: null, shopId: TENANT_A }),
      env,
    );
    expect(detail.status).toBe(200);
    expect((await detail.json<{ order: { orderId: string } }>()).order.orderId).toBe(orderId);

    // POST …/refunds → the refund route (it demands its key before anything).
    const refund = await worker.fetch(
      adminRequest(`/v1/admin/orders/${orderId}/refunds`, "POST", {
        body: { amountMinor: 1, reason: "x" },
        cookie: adminA.cookie,
        idempotencyKey: null,
        shopId: TENANT_A,
      }),
      env,
    );
    expect(refund.status).toBe(400);
    expect((await refund.json<{ error: { code: string } }>()).error.code).toBe("idempotency_key_required");

    // POST …/fulfilment → the fulfilment route (its own key rule, its own body).
    const noKey = await worker.fetch(
      adminRequest(`/v1/admin/orders/${orderId}/fulfilment`, "POST", {
        body: { to: "processing" },
        cookie: adminA.cookie,
        shopId: TENANT_A,
      }),
      env,
    );
    expect(noKey.status).toBe(400);
    expect((await noKey.json<{ error: { code: string } }>()).error.code).toBe("idempotency_key_required");
    const fulfilment = await worker.fetch(
      adminRequest(`/v1/admin/orders/${orderId}/fulfilment`, "POST", {
        body: { to: "processing" },
        cookie: adminA.cookie,
        idempotencyKey: crypto.randomUUID(),
        shopId: TENANT_A,
      }),
      env,
    );
    expect(fulfilment.status).toBe(200);
    expect(await fulfilment.json()).toMatchObject({ fulfilment: { from: "unfulfilled", to: "processing" } });

    // POST …/cancel → the cancellation (a reason body; 200 with its record).
    const cancel = await worker.fetch(
      adminRequest(`/v1/admin/orders/${orderId}/cancel`, "POST", {
        body: { reason: "route check" },
        cookie: adminA.cookie,
        shopId: TENANT_A,
      }),
      env,
    );
    expect(cancel.status).toBe(200);
    expect((await cancel.json<{ cancellation: { orderId: string } }>()).cancellation.orderId).toBe(orderId);
  });

  it("the other methods of each path stay the opaque 404, and no near path is served", async () => {
    const orderId = first.orderId;
    const cases: Array<[string, string]> = [
      ["GET", `/v1/admin/orders/${orderId}/fulfilment`],
      ["PUT", `/v1/admin/orders/${orderId}/fulfilment`],
      ["DELETE", `/v1/admin/orders/${orderId}/fulfilment`],
      ["POST", `/v1/admin/orders/${orderId}`],
      ["DELETE", `/v1/admin/orders/${orderId}`],
      ["GET", "/v1/admin/orders/"],
      ["GET", `/v1/admin/orders/${orderId}/fulfilment/x`],
      ["POST", "/v1/admin/orders/fulfilment"],
    ];
    for (const [method, path] of cases) {
      const response = await worker.fetch(
        adminRequest(path, method, {
          body: method === "GET" || method === "DELETE" ? undefined : { to: "processing" },
          cookie: adminA.cookie,
          idempotencyKey: crypto.randomUUID(),
          shopId: TENANT_A,
        }),
        env,
      );
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});
