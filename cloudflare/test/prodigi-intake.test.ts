import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import {
  PRODIGI_FETCH_OVERRIDE,
  PRODIGI_READ_MAX_BYTES,
  prodigiSubmitConfig,
  readProdigiOrder,
} from "../src/dispatch/prodigi-client";
import { printerOrderIssuesAlertId } from "../src/dispatch/printer-order-alerts";
import {
  isAcceptedContentType,
  PRINTER_ORDER_CANCELLED_ALERT_KIND,
  printerOrderCancelledAlertId,
  PRODIGI_WEBHOOK_BODY_MAX_BYTES,
  PRODIGI_WEBHOOK_IP_LIMIT,
  PRODIGI_WEBHOOK_PATH,
  prodigiLineFact,
  prodigiOrderIdOfEvent,
  prodigiOrderIssueCodes,
} from "../src/dispatch/prodigi-intake";
import { printerJobId } from "../src/dispatch/snapwear-wire";
import { processOutboxRowById } from "../src/outbox/effects";
import { alertsFor, AUTH_ORIGIN, type LineSpec, lineRow, quietEnv, seedOrder, seedTenant } from "./dispatch-fixtures";

/**
 * CP11 unit U3 — POST /v1/webhooks/prodigi (src/dispatch/prodigi-intake.ts).
 *
 * The orders are real: seeded as the webhook batch leaves them, then
 * dispatched through the real outbox path to a fake Prodigi behind
 * PRODIGI_FETCH_OVERRIDE, so both lines carry the one `ord_…` reference
 * exactly as U12 writes it. The same fake answers the intake's read-back
 * `GET /v4.0/orders/{id}`, with a stage and shipments each test sets. Every
 * request the fake sees is recorded, so "no re-read" is counted.
 */

const TENANT = "tenant-prodigi-intake";
const OTHER_TENANT = "tenant-prodigi-intake-other";
const KEY_TEE = "GLOBAL-TEE-GIL-64000.black.m";
const KEY_HOOD = "GLOBAL-HOOD-GIL-18500.heather-navy.2xl";
const TWO_LINES: LineSpec[] = [{ sku: KEY_TEE }, { sku: KEY_HOOD }];

const STAGING_PRODIGI: Record<PropertyKey, unknown> = {
  APP_ENV: "staging",
  PRODIGI_API_BASE_URL: "https://api.sandbox.prodigi.com",
  PRODIGI_API_TOKEN: "test_only-not-a-real-prodigi-key-0000",
  PRODIGI_SUBMIT_ENABLED: "true",
};

let ordCounter = 2_000_000;
let ipCounter = 0;

/** A fresh client address per test, so no test shares another's rate-limit bucket. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

interface FakeOrder {
  id: string;
  items: Array<{ attributes: unknown; id: string; merchantReference: string; sku: string }>;
  merchantReference: string;
  shipments: unknown[];
  status: { details: Record<string, string>; issues: unknown[]; stage: string };
}

type ReadFault = "network" | number | null;

/** Prodigi as the sandbox behaved: POST creates (or AlreadyExists), GET reads back. */
function fakeProdigi() {
  const orders = new Map<string, FakeOrder>();
  const byKey = new Map<string, string>();
  const requests: Array<{ apiKey: string | null; method: string; redirect: string; url: string }> = [];
  const state = { readFault: null as ReadFault };
  const fetcher = async (request: Request): Promise<Response> => {
    requests.push({
      apiKey: request.headers.get("x-api-key"),
      method: request.method,
      redirect: request.redirect,
      url: request.url,
    });
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v4.0/orders") {
      const body = (await request.clone().json()) as {
        idempotencyKey: string;
        items: Array<{ attributes: unknown; merchantReference: string; sku: string }>;
        merchantReference: string;
      };
      const existing = byKey.get(body.idempotencyKey);
      if (existing !== undefined) {
        return Response.json({ order: { id: existing }, outcome: "AlreadyExists" });
      }
      ordCounter += 1;
      const id = `ord_${ordCounter}`;
      byKey.set(body.idempotencyKey, id);
      orders.set(id, {
        id,
        items: body.items.map((item, index) => ({
          attributes: item.attributes,
          id: `ori_${ordCounter}${index}`,
          merchantReference: item.merchantReference,
          sku: item.sku,
        })),
        merchantReference: body.merchantReference,
        shipments: [],
        status: {
          details: {
            allocateProductionLocation: "NotStarted",
            downloadAssets: "NotStarted",
            inProduction: "NotStarted",
            printReadyAssetsPrepared: "NotStarted",
            shipping: "NotStarted",
          },
          issues: [],
          stage: "InProgress",
        },
      });
      return Response.json({ order: { id }, outcome: "Created" });
    }
    const match = /^\/v4\.0\/orders\/(ord_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (request.method === "GET" && match !== null) {
      if (state.readFault === "network") {
        throw new Error("connection reset");
      }
      if (typeof state.readFault === "number") {
        return Response.json({ outcome: "Error" }, { status: state.readFault });
      }
      const order = orders.get(match[1]!);
      return order === undefined
        ? Response.json({ outcome: "NotFound" }, { status: 404 })
        : Response.json({ order, outcome: "Ok" });
    }
    return new Response("unexpected", { status: 418 });
  };
  const reads = () => requests.filter((request) => request.method === "GET").length;
  return { fetcher, orders, reads, requests, state };
}

type Prodigi = ReturnType<typeof fakeProdigi>;

function prodigiEnv(prodigi: Prodigi, overrides: Record<PropertyKey, unknown> = {}): Env {
  return quietEnv({ ...STAGING_PRODIGI, [PRODIGI_FETCH_OVERRIDE]: prodigi.fetcher, ...overrides }).env;
}

/** A shipped order to the `prodigi` printer, dispatched: every line accepted under one ord_ reference. */
async function acceptedOrder(prodigi: Prodigi, lines: LineSpec[] = TWO_LINES, tenantId = TENANT) {
  const order = await seedOrder(tenantId, {
    deliveryMethod: "shipping",
    lines,
    printer: "prodigi",
    printerProvider: "prodigi",
    snapshotProvider: "prodigi",
  });
  await env.DB.prepare(
    `INSERT INTO order_recipients (
       order_id, tenant_id, delivery_method, name, phone, address_line1,
       address_line2, postal_code, city, country, created_at
     ) VALUES (?, ?, 'shipping', 'Test Köpare', NULL, 'Storgatan 1', NULL, '264 33', 'Klippan', 'SE', ?)`,
  )
    .bind(order.orderId, tenantId, new Date().toISOString())
    .run();
  const outcome = await processOutboxRowById(prodigiEnv(prodigi), order.dispatchIds[0]!);
  expect(outcome).toEqual({ kind: "ran", outcome: { kind: "done" } });
  const ordId = (await lineRow(order.orderId, 1)).printer_job_ref as string;
  expect(ordId).toMatch(/^ord_\d+$/);
  for (let lineNo = 1; lineNo <= lines.length; lineNo += 1) {
    expect(await lineRow(order.orderId, lineNo)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: ordId });
  }
  const fake = prodigi.orders.get(ordId)!;
  return { fake, ordId, orderId: order.orderId };
}

function cloudEvent(ordId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: { order: { id: ordId } },
    datacontenttype: "application/json",
    id: `evt_${ordId}`,
    source: "http://api.prodigi.com/v4.0/Orders/",
    specversion: "1.0",
    subject: ordId,
    time: "2026-10-19T20:00:00Z",
    type: "com.prodigi.order.status.stage.changed#InProgress",
    ...extra,
  };
}

interface CallbackOptions {
  body?: BodyInit;
  contentType?: string | null;
  ip?: string;
  method?: string;
}

function callback(target: Env, event: unknown, options: CallbackOptions = {}): Promise<Response> {
  const method = options.method ?? "POST";
  const headers = new Headers({ "cf-connecting-ip": options.ip ?? nextIp() });
  const contentType = options.contentType === undefined ? "application/cloudevents+json" : options.contentType;
  if (contentType !== null) {
    headers.set("content-type", contentType);
  }
  return worker.fetch(
    new Request(`${AUTH_ORIGIN}${PRODIGI_WEBHOOK_PATH}`, {
      body: method === "GET" || method === "HEAD" ? undefined : (options.body ?? JSON.stringify(event)),
      headers,
      method,
    }),
    target,
  );
}

async function expectOpaque404(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: "not_found", message: "Route not found" } });
}

async function trackingOf(orderId: string, lineNo: number) {
  return env.DB.prepare(
    `SELECT production_state, printer_tracking_number, printer_tracking_url, printer_carrier
     FROM order_items WHERE order_id = ? AND item_index = ?`,
  )
    .bind(orderId, lineNo - 1)
    .first<{
      printer_carrier: string | null;
      printer_tracking_number: string | null;
      printer_tracking_url: string | null;
      production_state: string | null;
    }>();
}

async function statusAudits(orderId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audit_events
     WHERE action = 'print_job.status' AND resource_id LIKE ? AND actor_user_id IS NULL`,
  )
    .bind(`${orderId}-%`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function fulfilmentOf(orderId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT fulfilment_status FROM orders WHERE order_id = ?`)
    .bind(orderId)
    .first<{ fulfilment_status: string | null }>();
  return row?.fulfilment_status ?? null;
}

function shipment(itemIds: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    carrier: { name: "Asendia", service: "e-PAQ Plus" },
    dispatchDate: "2026-10-21T09:00:00Z",
    fulfillmentLocation: { countryCode: "PL", labCode: "pl1" },
    id: "shp_1",
    items: itemIds.map((itemId) => ({ itemId })),
    status: "Shipped",
    tracking: { number: "LX123456789PL", url: "https://track.asendia.example/LX123456789PL" },
    ...extra,
  };
}

beforeAll(async () => {
  await seedTenant(TENANT);
  await seedTenant(OTHER_TENANT);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM outbox_events").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("refusals: the opaque 404, and nothing re-read", () => {
  it("another method is a 404 (onMethods falls through to the router's 404)", async () => {
    const prodigi = fakeProdigi();
    const { ordId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      await expectOpaque404(await callback(target, cloudEvent(ordId), { method }));
    }
    expect(prodigi.reads()).toBe(0);
  });

  it("a content type other than application/json or application/cloudevents+json is a 404", async () => {
    const prodigi = fakeProdigi();
    const { ordId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    for (const contentType of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp", "json"]) {
      await expectOpaque404(await callback(target, cloudEvent(ordId), { contentType }));
    }
    expect(prodigi.reads()).toBe(0);
    // The parameters and the case of an accepted type do not matter.
    expect(isAcceptedContentType("Application/JSON; charset=utf-8")).toBe(true);
    expect(isAcceptedContentType("application/cloudevents+json")).toBe(true);
  });

  it("a body over 64 KiB is a 404, unread by the parser and never re-read", async () => {
    const prodigi = fakeProdigi();
    const { ordId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    const padded = JSON.stringify(cloudEvent(ordId, { padding: "x".repeat(PRODIGI_WEBHOOK_BODY_MAX_BYTES) }));
    expect(padded.length).toBeGreaterThan(PRODIGI_WEBHOOK_BODY_MAX_BYTES);
    await expectOpaque404(await callback(target, null, { body: padded }));
    // A stream with no declared length is cut off at the cap too.
    const bytes = new TextEncoder().encode(padded);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 8_192) {
          controller.enqueue(bytes.slice(offset, offset + 8_192));
        }
        controller.close();
      },
    });
    await expectOpaque404(await callback(target, null, { body: stream }));
    expect(prodigi.reads()).toBe(0);
    // Just under the cap is read.
    const fits = JSON.stringify(cloudEvent(ordId, { padding: "" }));
    expect((await callback(target, null, { body: fits })).status).toBe(200);
  });

  it("not a Prodigi CloudEvent is a 404", async () => {
    const prodigi = fakeProdigi();
    const { ordId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    const bodies: string[] = [
      "not json",
      "",
      JSON.stringify([cloudEvent(ordId)]),
      JSON.stringify({ subject: ordId }),
      JSON.stringify({ ...cloudEvent(ordId), type: "com.example.order.shipped" }),
      JSON.stringify({ ...cloudEvent(ordId), type: "com.prodigi" }),
      JSON.stringify({ ...cloudEvent(ordId), type: 42 }),
      JSON.stringify({ ...cloudEvent(ordId), type: `com.prodigi.${"x".repeat(200)}` }),
    ];
    for (const body of bodies) {
      await expectOpaque404(await callback(target, null, { body }));
    }
    expect(prodigi.reads()).toBe(0);
  });

  it("no usable ord_ id (bad shape, or two different ids) is a 404", async () => {
    const prodigi = fakeProdigi();
    const { ordId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    const bad = ["ord_", "ORD_123", "ord_12/../34", "ord_12 34", `ord_${"1".repeat(65)}`, "ord_1%2F2", 1186010];
    for (const id of bad) {
      await expectOpaque404(await callback(target, { ...cloudEvent(ordId), data: { order: { id } }, subject: id }));
    }
    // Two different well-formed ids: which one is meant is not ours to guess.
    await expectOpaque404(
      await callback(target, { ...cloudEvent(ordId), data: { order: { id: "ord_999" } }, subject: ordId }),
    );
    expect(prodigi.reads()).toBe(0);
    // The id is found in any one of the three places.
    expect(prodigiOrderIdOfEvent({ subject: ordId, type: "com.prodigi.x" })).toBe(ordId);
    expect(prodigiOrderIdOfEvent({ data: { id: ordId }, type: "com.prodigi.x" })).toBe(ordId);
    expect(prodigiOrderIdOfEvent({ data: { order: { id: ordId } }, type: "com.prodigi.x" })).toBe(ordId);
    expect(prodigiOrderIdOfEvent({ data: { id: ordId }, subject: "something else", type: "com.prodigi.x" })).toBe(ordId);
  });

  it("an id Prodigi does not know, an order of nobody here, or one whose lines carry another reference: 404", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);

    // Prodigi answers 404 under our key (a forged id).
    await expectOpaque404(await callback(target, cloudEvent("ord_404404")));
    expect(prodigi.reads()).toBe(1);

    // Prodigi knows it, but its merchantReference names no order of ours.
    prodigi.orders.set("ord_777001", { ...fake, id: "ord_777001", merchantReference: crypto.randomUUID() });
    await expectOpaque404(await callback(target, cloudEvent("ord_777001")));

    // An order of ours, but no line of it carries this ord_ reference.
    prodigi.orders.set("ord_777002", { ...fake, id: "ord_777002", merchantReference: orderId });
    await expectOpaque404(await callback(target, cloudEvent("ord_777002")));

    // A merchantReference that is not a string.
    prodigi.orders.set("ord_777003", { ...fake, id: "ord_777003", merchantReference: 5 as unknown as string });
    await expectOpaque404(await callback(target, cloudEvent("ord_777003")));

    // Nothing moved on our lines.
    expect((await lineRow(orderId, 1)).production_state).toBeNull();
    expect((await lineRow(orderId, 2)).production_state).toBeNull();
    expect(ordId).not.toBe("ord_777002");
  });

  it("the gate off is a 404 before anything is read: no client, no route", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId } = await acceptedOrder(prodigi);
    fake.shipments = [shipment([fake.items[0]!.id])];
    const offs: Array<Record<PropertyKey, unknown>> = [
      { PRODIGI_SUBMIT_ENABLED: undefined },
      { PRODIGI_SUBMIT_ENABLED: "false" },
      { PRODIGI_API_TOKEN: undefined },
      { PRODIGI_API_TOKEN: "live-only-not-a-real-prodigi-key-0000" }, // a live key on staging
      { PRODIGI_API_BASE_URL: "https://api.prodigi.com" }, // the live host on staging
      { APP_ENV: "development" },
    ];
    for (const off of offs) {
      const target = prodigiEnv(prodigi, off);
      expect(prodigiSubmitConfig(target)).toBeNull();
      await expectOpaque404(await callback(target, cloudEvent(ordId)));
    }
    expect(prodigi.reads()).toBe(0);
  });

  it("more than 60 a minute from one address: 429 with Retry-After; another address is not affected", async () => {
    const prodigi = fakeProdigi();
    const target = prodigiEnv(prodigi);
    const ip = "203.0.113.77";
    for (let i = 0; i < PRODIGI_WEBHOOK_IP_LIMIT; i += 1) {
      // An unknown id: a full pass through the route each time.
      expect((await callback(target, cloudEvent("ord_404404"), { ip })).status).toBe(404);
    }
    const limited = await callback(target, cloudEvent("ord_404404"), { ip });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(prodigi.reads()).toBe(PRODIGI_WEBHOOK_IP_LIMIT);
    expect((await callback(target, cloudEvent("ord_404404"), { ip: "203.0.113.78" })).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the re-read decides", () => {
  it("a shipped callback moves the shipped line to shipped with its tracking; the other line stays", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    // Line 1's parcel is out; line 2's is still being prepared (not Shipped).
    fake.shipments = [shipment([fake.items[0]!.id]), { ...shipment([fake.items[1]!.id]), id: "shp_2", status: "Processing", tracking: null }];

    const response = await callback(target, cloudEvent(ordId, { type: "com.prodigi.order.shipments.shipment.shipped" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    // The re-read went to OUR origin, with OUR key, no redirect followed.
    const read = prodigi.requests.find((request) => request.method === "GET")!;
    expect(read).toEqual({
      apiKey: "test_only-not-a-real-prodigi-key-0000",
      method: "GET",
      redirect: "manual",
      url: `https://api.sandbox.prodigi.com/v4.0/orders/${ordId}`,
    });

    expect(await trackingOf(orderId, 1)).toEqual({
      printer_carrier: "Asendia",
      printer_tracking_number: "LX123456789PL",
      printer_tracking_url: "https://track.asendia.example/LX123456789PL",
      production_state: "shipped",
    });
    expect(await trackingOf(orderId, 2)).toEqual({
      printer_carrier: null,
      printer_tracking_number: null,
      printer_tracking_url: null,
      production_state: null,
    });
    // One printer line still unsent: the order is not shipped, no mail.
    expect(await fulfilmentOf(orderId)).not.toBe("shipped");
    expect(await statusAudits(orderId)).toBe(1);
  });

  it("the same callback again is a 200 and changes nothing", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    fake.shipments = [shipment([fake.items[0]!.id])];

    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);
    const before = await trackingOf(orderId, 1);
    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);
    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);
    expect(await trackingOf(orderId, 1)).toEqual(before);
    expect(await statusAudits(orderId)).toBe(1);
  });

  it("an in-production re-read after shipped does not move the line back; the other line goes in production", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    fake.shipments = [shipment([fake.items[0]!.id])];
    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);

    // Prodigi's answer no longer lists the shipment (an out-of-order read).
    fake.shipments = [];
    fake.status.details.inProduction = "InProgress";
    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);
    expect((await trackingOf(orderId, 1))?.production_state).toBe("shipped");
    expect((await trackingOf(orderId, 1))?.printer_tracking_number).toBe("LX123456789PL");
    expect((await trackingOf(orderId, 2))?.production_state).toBe("in_production");
  });

  it("every line shipped: the all-printer parcel order is recorded shipped, by the printer, with its one mail", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    fake.status.stage = "Complete";
    fake.shipments = [shipment([fake.items[0]!.id, fake.items[1]!.id])];

    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);
    expect((await trackingOf(orderId, 1))?.production_state).toBe("shipped");
    expect((await trackingOf(orderId, 2))?.production_state).toBe("shipped");
    expect(await fulfilmentOf(orderId)).toBe("shipped");
    const mails = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'email.order_status' AND aggregate_id = ?`,
    )
      .bind(orderId)
      .first<{ n: number }>();
    expect(mails?.n).toBe(1);
    // A replay sends no second mail.
    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);
    const again = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'email.order_status' AND aggregate_id = ?`,
    )
      .bind(orderId)
      .first<{ n: number }>();
    expect(again?.n).toBe(1);
  });

  it("the payload's own status is ignored: it says Shipped, the re-read says InProgress → in_production only", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    fake.status.details.inProduction = "InProgress";

    const lying = cloudEvent(ordId, {
      data: {
        order: {
          id: ordId,
          shipments: [shipment(fake.items.map((item) => item.id), { tracking: { number: "FORGED", url: "https://evil.example/x" } })],
          status: { details: { inProduction: "Complete", shipping: "Complete" }, stage: "Complete" },
        },
      },
      type: "com.prodigi.order.status.stage.changed#Complete",
    });
    expect((await callback(target, lying)).status).toBe(200);
    for (const lineNo of [1, 2]) {
      expect(await trackingOf(orderId, lineNo)).toEqual({
        printer_carrier: null,
        printer_tracking_number: null,
        printer_tracking_url: null,
        production_state: "in_production",
      });
    }
    expect(await fulfilmentOf(orderId)).not.toBe("shipped");
  });

  it("a stage still InProgress with nothing in production: 200, nothing moves", async () => {
    const prodigi = fakeProdigi();
    const { ordId, orderId } = await acceptedOrder(prodigi);
    expect((await callback(prodigiEnv(prodigi), cloudEvent(ordId))).status).toBe(200);
    expect((await lineRow(orderId, 1)).production_state).toBeNull();
    expect(await statusAudits(orderId)).toBe(0);
  });

  it("a tracking field 0051 would refuse is dropped alone; the line is still shipped", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    fake.shipments = [shipment([fake.items[0]!.id], { tracking: { number: "LX1", url: "http://insecure.example/LX1" } })];
    expect((await callback(prodigiEnv(prodigi), cloudEvent(ordId))).status).toBe(200);
    expect(await trackingOf(orderId, 1)).toEqual({
      printer_carrier: "Asendia",
      printer_tracking_number: "LX1",
      printer_tracking_url: null,
      production_state: "shipped",
    });
  });

  it("the re-read failing is a 503 so Prodigi retries (500, 503, 401, 429, a network error); the retry then lands", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    fake.shipments = [shipment([fake.items[0]!.id])];
    for (const fault of [500, 503, 401, 429, "network"] as const) {
      prodigi.state.readFault = fault;
      const response = await callback(target, cloudEvent(ordId));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "unavailable", message: "Try again later" } });
    }
    expect((await lineRow(orderId, 1)).production_state).toBeNull();

    prodigi.state.readFault = null;
    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);
    expect((await lineRow(orderId, 1)).production_state).toBe("shipped");
  });

  it("a line cancelled on our side is refused by recordProductionStatus; the route still answers 200", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    await env.DB.prepare(`UPDATE orders SET cancelled_at = ?, cancel_reason = 'test' WHERE order_id = ?`)
      .bind(new Date().toISOString(), orderId)
      .run();
    fake.status.details.inProduction = "InProgress";
    expect((await callback(prodigiEnv(prodigi), cloudEvent(ordId))).status).toBe(200);
    expect((await lineRow(orderId, 1)).production_state).toBeNull();
  });

  it("nothing of the payload or the order is logged", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    const prodigi = fakeProdigi();
    const { fake, ordId } = await acceptedOrder(prodigi);
    for (const spy of spies) {
      spy.mockClear();
    }
    const target = prodigiEnv(prodigi);
    fake.shipments = [shipment([fake.items[0]!.id])];
    await callback(target, cloudEvent(ordId));
    prodigi.state.readFault = 500;
    await callback(target, cloudEvent(ordId));
    await callback(target, cloudEvent("ord_404404"));
    await callback(target, null, { body: "not json" });
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Prodigi cancelled the order", () => {
  it("no state change; one critical alert per accepted line, ids only, raised once", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    const target = prodigiEnv(prodigi);
    fake.status.stage = "Cancelled";
    // Left over from before it stopped: never read as in production.
    fake.status.details.inProduction = "InProgress";

    expect((await callback(target, cloudEvent(ordId, { type: "com.prodigi.order.status.stage.changed#Cancelled" }))).status).toBe(200);
    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);

    for (const lineNo of [1, 2]) {
      const jobId = printerJobId(orderId, lineNo);
      expect((await lineRow(orderId, lineNo)).production_state).toBeNull();
      const alerts = await alertsFor(jobId);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        id: printerOrderCancelledAlertId(jobId),
        kind: PRINTER_ORDER_CANCELLED_ALERT_KIND,
        resolved_at: null,
        severity: "critical",
      });
      expect(alerts[0]!.message).toContain(ordId);
      expect(alerts[0]!.message).toContain(jobId);
      expect(alerts[0]!.message).not.toMatch(/Storgatan|Klippan|Köpare|https?:/);
    }
    expect(await statusAudits(orderId)).toBe(0);
  });

  it("no alert for an order cancelled on our side (that cancellation has its own flow)", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    await env.DB.prepare(`UPDATE orders SET cancelled_at = ?, cancel_reason = 'buyer' WHERE order_id = ?`)
      .bind(new Date().toISOString(), orderId)
      .run();
    fake.status.stage = "Cancelled";
    expect((await callback(prodigiEnv(prodigi), cloudEvent(ordId))).status).toBe(200);
    expect(await alertsFor(printerJobId(orderId, 1))).toHaveLength(0);
    expect(await alertsFor(printerJobId(orderId, 2))).toHaveLength(0);
  });

  it("a shipment that went out before the cancel still records shipped for its line", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    fake.status.stage = "Cancelled";
    fake.shipments = [shipment([fake.items[0]!.id])];
    expect((await callback(prodigiEnv(prodigi), cloudEvent(ordId))).status).toBe(200);
    expect((await lineRow(orderId, 1)).production_state).toBe("shipped");
    expect(await alertsFor(printerJobId(orderId, 1))).toHaveLength(0);
    expect(await alertsFor(printerJobId(orderId, 2))).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the mapping, pure (prodigiLineFact)", () => {
  const base = () => ({
    id: "ord_1",
    items: [
      { id: "ori_a", merchantReference: "1" },
      { id: "ori_b", merchantReference: "2" },
    ],
    merchantReference: "x",
    shipments: [] as unknown[],
    status: { details: { inProduction: "NotStarted" }, stage: "InProgress" } as Record<string, unknown>,
  });

  it("matches the shipment by the item's id (ori_…), NOT by its merchantReference", () => {
    const order = base();
    order.shipments = [{ items: [{ itemId: "1" }, { itemId: "2" }], status: "Shipped" }];
    expect(prodigiLineFact(order, 1)).toEqual({ kind: "none" });
    order.shipments = [{ items: [{ itemId: "ori_b" }], status: "shipped" }];
    expect(prodigiLineFact(order, 1)).toEqual({ kind: "none" });
    expect(prodigiLineFact(order, 2)).toEqual({
      input: { carrier: null, state: "shipped", trackingNumber: null, trackingUrl: null },
      kind: "shipped",
    });
  });

  it("a shipment not yet Shipped does not ship the line", () => {
    const order = base();
    order.shipments = [{ items: [{ itemId: "ori_a" }], status: "Processing", tracking: { number: "X" } }];
    expect(prodigiLineFact(order, 1)).toEqual({ kind: "none" });
  });

  it("in production: details.inProduction InProgress / Complete (any case), or stage Complete", () => {
    for (const [inProduction, stage, kind] of [
      ["InProgress", "InProgress", "in_production"],
      ["inprogress", "InProgress", "in_production"],
      ["Complete", "InProgress", "in_production"],
      ["NotStarted", "Complete", "in_production"],
      ["NotStarted", "InProgress", "none"],
      ["Error", "InProgress", "none"],
      ["InProgress", "Cancelled", "cancelled"],
      ["NotStarted", "cancelled", "cancelled"],
    ] as const) {
      const order = base();
      order.status = { details: { inProduction }, stage };
      expect(prodigiLineFact(order, 1), `${inProduction}/${stage}`).toEqual(
        kind === "cancelled" ? { kind, scope: "order" } : { kind },
      );
    }
  });

  it("a line whose number no item carries, or a malformed order, is nothing", () => {
    expect(prodigiLineFact(base(), 3)).toEqual({ kind: "none" });
    expect(prodigiLineFact({ id: "ord_1" }, 1)).toEqual({ kind: "none" });
    expect(prodigiLineFact({ items: "x", shipments: {}, status: "Complete" }, 1)).toEqual({ kind: "none" });
    // merchantReference is compared as the string we sent.
    expect(prodigiLineFact({ items: [{ id: "ori_a", merchantReference: 1 }], status: { stage: "Complete" } }, 1)).toEqual({ kind: "none" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("readProdigiOrder (prodigi-client.ts)", () => {
  function configured(fetcher: (request: Request) => Promise<Response>) {
    const target = quietEnv({ ...STAGING_PRODIGI, [PRODIGI_FETCH_OVERRIDE]: fetcher }).env;
    return { config: prodigiSubmitConfig(target)!, target };
  }

  it("a redirect is never followed: it is a failed read", async () => {
    const seen: Request[] = [];
    const { config, target } = configured(async (request) => {
      seen.push(request);
      return new Response(null, { headers: { location: "https://elsewhere.example/" }, status: 307 });
    });
    expect(await readProdigiOrder(target, config, "ord_1")).toEqual({ status: "failed" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("manual");
    expect(seen[0]!.signal).toBeDefined();
  });

  it("only a 200 naming the same order is a read; 400/404 are not_found; the rest failed", async () => {
    const answer = (status: number, body: unknown) => async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    const cases: Array<[number, unknown, string]> = [
      [200, { order: { id: "ord_1" }, outcome: "Ok" }, "ok"],
      [200, { order: { id: "ord_2" }, outcome: "Ok" }, "failed"],
      [200, { outcome: "Ok" }, "failed"],
      [200, { order: [] }, "failed"],
      [200, "not json", "failed"],
      [404, { outcome: "NotFound" }, "not_found"],
      [400, {}, "not_found"],
      [401, {}, "failed"],
      [403, {}, "failed"],
      [408, {}, "failed"],
      [429, {}, "failed"],
      [500, {}, "failed"],
      [502, {}, "failed"],
      [201, { order: { id: "ord_1" } }, "failed"],
    ];
    for (const [status, body, expected] of cases) {
      const { config, target } = configured(answer(status, body));
      expect((await readProdigiOrder(target, config, "ord_1")).status, `${status} ${JSON.stringify(body)}`).toBe(expected);
    }
  });

  it("an answer over the cap is a failed read", async () => {
    const { config, target } = configured(async () =>
      new Response(JSON.stringify({ order: { id: "ord_1", pad: "x".repeat(PRODIGI_READ_MAX_BYTES) } }), { status: 200 }),
    );
    expect(await readProdigiOrder(target, config, "ord_1")).toEqual({ status: "failed" });
  });

  it("an id that is not ord_… never reaches the network", async () => {
    let calls = 0;
    const { config, target } = configured(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    for (const id of ["ord_1/../x", "ord_", "x", "ord_1?a=b"]) {
      expect(await readProdigiOrder(target, config, id)).toEqual({ status: "not_found" });
    }
    expect(calls).toBe(0);
  });

  it("a network error or timeout is a failed read, carrying nothing", async () => {
    const { config, target } = configured(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    expect(await readProdigiOrder(target, config, "ord_1")).toEqual({ status: "failed" });
  });
});

// The other tenant exists so an order of one shop is never confused with another's.
describe("tenancy", () => {
  it("the tenant comes from the order row: two shops' Prodigi orders each move only their own lines", async () => {
    const prodigi = fakeProdigi();
    const a = await acceptedOrder(prodigi, [{ sku: KEY_TEE }], TENANT);
    const b = await acceptedOrder(prodigi, [{ sku: KEY_TEE }], OTHER_TENANT);
    a.fake.shipments = [shipment([a.fake.items[0]!.id])];
    b.fake.status.details.inProduction = "InProgress";
    const target = prodigiEnv(prodigi);
    expect((await callback(target, cloudEvent(a.ordId))).status).toBe(200);
    expect((await callback(target, cloudEvent(b.ordId))).status).toBe(200);
    expect((await lineRow(a.orderId, 1)).production_state).toBe("shipped");
    expect((await lineRow(b.orderId, 1)).production_state).toBe("in_production");
    const audits = await env.DB.prepare(
      `SELECT tenant_id FROM audit_events WHERE action = 'print_job.status' AND resource_id IN (?, ?) ORDER BY tenant_id`,
    )
      .bind(printerJobId(a.orderId, 1), printerJobId(b.orderId, 1))
      .all<{ tenant_id: string }>();
    expect(audits.results.map((row) => row.tenant_id)).toEqual([TENANT, OTHER_TENANT].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CP11 U7 — the Codex audit of 2026-10-19, F5 and F6, each reproduction case
// inverted: what the audit saw end `ok` with nothing raised now raises.
describe("CP11 U7 · F6: a cancelled shipment is not in production", () => {
  it("one shipment cancelled under an InProgress order: that line alerts and stays out of production; the other moves", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    fake.status.details.inProduction = "InProgress";
    fake.shipments = [
      shipment([fake.items[0]!.id], { id: "shp_c", status: "Cancelled", tracking: null }),
      shipment([fake.items[1]!.id], { id: "shp_p", status: "Processing" }),
    ];
    const target = prodigiEnv(prodigi);
    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);
    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);

    expect((await lineRow(orderId, 1)).production_state).toBeNull();
    const jobId = printerJobId(orderId, 1);
    const alerts = await alertsFor(jobId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: printerOrderCancelledAlertId(jobId),
      kind: PRINTER_ORDER_CANCELLED_ALERT_KIND,
      severity: "critical",
    });
    expect(alerts[0]!.message).toContain("shipment of this line");
    expect(alerts[0]!.message).not.toMatch(/Storgatan|Klippan|Köpare|https?:/);
    expect((await lineRow(orderId, 2)).production_state).toBe("in_production");
    expect(await alertsFor(printerJobId(orderId, 2))).toHaveLength(0);
  });

  it("pure: a Cancelled shipment listing the item wins over the aggregate; a Shipped one still wins over both", () => {
    const order = {
      id: "ord_1",
      items: [{ id: "ori_a", merchantReference: "1" }, { id: "ori_b", merchantReference: "2" }],
      shipments: [{ items: [{ itemId: "ori_a" }], status: "cancelled" }],
      status: { details: { inProduction: "Complete" }, stage: "InProgress" },
    };
    expect(prodigiLineFact(order, 1)).toEqual({ kind: "cancelled", scope: "shipment" });
    expect(prodigiLineFact(order, 2)).toEqual({ kind: "in_production" });
    const reshipped = { ...order, shipments: [...order.shipments, { items: [{ itemId: "ori_a" }], status: "Shipped" }] };
    expect(prodigiLineFact(reshipped, 1)).toMatchObject({ kind: "shipped" });
  });
});

describe("CP11 U7 · F5: provider issues on a re-read raise alerts", () => {
  async function issueAlerts(orderId: string) {
    const rows = await env.DB.prepare(
      `SELECT id, message, severity FROM alerts WHERE kind = 'printer_order_issues' AND resource_id = ? ORDER BY id`,
    )
      .bind(orderId)
      .all<{ id: string; message: string; severity: string }>();
    return rows.results;
  }

  it("an exhausted asset download, downloadAssets Error and an asset in Error: one alert per code, deduplicated, no state change", async () => {
    const prodigi = fakeProdigi();
    const { fake, ordId, orderId } = await acceptedOrder(prodigi);
    fake.status.issues = [
      { description: "We could not download https://r2.example/x.png", errorCode: "items.assets.FailedToDownloaded", objectId: "ast_1" },
    ];
    fake.status.details.downloadAssets = "Error";
    (fake.items[0] as Record<string, unknown>).assets = [{ id: "ast_1", printArea: "front", status: "Error" }];
    const target = prodigiEnv(prodigi);

    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);
    expect((await callback(target, cloudEvent(ordId))).status).toBe(200);

    const alerts = await issueAlerts(orderId);
    expect(alerts.map((alert) => alert.id)).toEqual(
      ["asset_error", "details_downloadAssets_error", "items.assets.FailedToDownloaded"]
        .map((code) => printerOrderIssuesAlertId(orderId, code))
        .sort(),
    );
    for (const alert of alerts) {
      expect(alert.severity).toBe("critical");
      expect(alert.message).toContain(ordId);
      expect(alert.message).not.toMatch(/https?:|r2\.example|Storgatan|Köpare/);
    }
    for (const lineNo of [1, 2]) {
      expect(await lineRow(orderId, lineNo)).toMatchObject({ dispatch_state: "accepted", production_state: null });
    }
  });

  it("a clean re-read raises nothing", async () => {
    const prodigi = fakeProdigi();
    const { ordId, orderId } = await acceptedOrder(prodigi);
    expect((await callback(prodigiEnv(prodigi), cloudEvent(ordId))).status).toBe(200);
    expect(await issueAlerts(orderId)).toHaveLength(0);
  });

  it("pure: the codes, bounded and named by codes only", () => {
    expect(prodigiOrderIssueCodes({ status: { details: { inProduction: "InProgress" }, issues: [], stage: "InProgress" } })).toEqual([]);
    expect(
      prodigiOrderIssueCodes({
        items: [{ status: "Invalid" }, { assets: [{ status: "error" }, { status: "Complete" }], status: "Ok" }],
        status: { details: { shipping: "ERROR" }, issues: [{ errorCode: "x y" }, {}], stage: "InProgress" },
      }),
    ).toEqual(["x_y", "issue_unreadable", "details_shipping_error", "item_invalid", "asset_error"]);
    const many = { status: { issues: Array.from({ length: 30 }, (_, index) => ({ errorCode: `code${index}` })) } };
    expect(prodigiOrderIssueCodes(many)).toHaveLength(10);
  });
});
