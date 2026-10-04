import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { runReconciliation } from "../src/commerce/crons";
import {
  parseProductionStatusInput,
  PRINTER_EXCEPTION_ALERT_KIND,
  printerExceptionAlertId,
  recordProductionStatus,
} from "../src/dispatch/production-status";
import { printerJobId } from "../src/dispatch/snapwear-wire";
import { processOutboxRowById } from "../src/outbox/effects";
import {
  alertsFor,
  grantAccess,
  quietEnv,
  seedOrder,
  sessionRequest,
  signUp,
  type SignedUpUser,
} from "./dispatch-fixtures";
import type { Admin } from "./money-fixtures";
import {
  adminRequest,
  FakeMoneyStripe,
  moneyEnv,
  next,
  orderMoney,
  payCheckout,
  seedCheckout,
  seedTenant,
  signUpAdmin,
} from "./money-fixtures";
import { expectNoCostKeys } from "./pod-fixtures";

/**
 * CP6-PS3 part 2 (LAUNCH_TODO A7) — the printer's "out of stock" after it
 * accepted (and charged) a job: migration 0054, the two exception bodies of
 * POST /v1/platform/print-jobs/:jobId/status (src/dispatch/production-status.ts),
 * the seller's word, the platform's list, the alert ONCE, and the order's
 * fulfilment: an OPEN exception holds the order (no "shipped" mail for a parcel
 * missing an item), a RESOLVED one lets it go on. No money moves.
 */

const TENANT = "tenant-ps3-oos";
const PLATFORM_HOST = "https://platform.ps3.test";
const PRICE = 20_000;
const FEE = 13_300;
const WITHHELD = 12_300;

let platform: SignedUpUser;
let admin: Admin;
let accountId: string;

beforeAll(async () => {
  accountId = (await seedTenant(TENANT)) as string;
  admin = await signUpAdmin("ps3-admin@example.test", TENANT);
  platform = await signUp("ps3-platform@example.test");
  await grantAccess(platform.userId, "platform_admin");
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM outbox_events WHERE event_type = 'dispatch'").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── helpers ────────────────────────────────────────────────────────────────

const job = (orderId: string, lineNo = 1) => printerJobId(orderId, lineNo);

function post(
  jobId: string,
  body: unknown,
  options: { cookie?: string | null } = {},
  targetEnv: Env = quietEnv().env,
): Promise<Response> {
  return worker.fetch(
    sessionRequest(`${PLATFORM_HOST}/v1/platform/print-jobs/${jobId}/status`, "POST", {
      body,
      cookie: options.cookie === null ? undefined : (options.cookie ?? platform.cookie),
    }),
    targetEnv,
  );
}

interface StatusBody {
  changed: boolean;
  job: {
    exception: string | null;
    exceptionResolvedAt: string | null;
    jobId: string;
    state: string | null;
    trackingNumber: string | null;
  };
  orderShipped: boolean;
}

async function ok(jobId: string, body: unknown, targetEnv?: Env): Promise<StatusBody> {
  const response = await post(jobId, body, {}, targetEnv);
  expect(response.status, JSON.stringify(body)).toBe(200);
  return response.json<StatusBody>();
}

async function refusal(jobId: string, body: unknown): Promise<string> {
  const response = await post(jobId, body);
  expect(response.status, JSON.stringify(body)).toBe(409);
  const json = await response.json<{ error: { code: string; reason: string } }>();
  expect(json.error.code).toBe("print_job_status_not_allowed");
  return json.error.reason;
}

const OUT_OF_STOCK = { exception: "out_of_stock" };
const RESOLVED = { exception: "resolved" };

/** Marks the order's POD lines accepted, as the dispatch does (or a human resolves). */
async function accept(orderId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE order_items SET dispatch_state = 'accepted', printer_job_ref = 'SWX-' || item_index,
       dispatched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE order_id = ? AND production_json IS NOT NULL`,
  )
    .bind(orderId)
    .run();
}

async function line(orderId: string, lineNo = 1) {
  const row = await env.DB.prepare(
    `SELECT dispatch_state, production_state, printer_exception, printer_exception_resolved_at
     FROM order_items WHERE order_id = ? AND item_index = ?`,
  )
    .bind(orderId, lineNo - 1)
    .first<{
      dispatch_state: string | null;
      printer_exception: string | null;
      printer_exception_resolved_at: string | null;
      production_state: string | null;
    }>();
  if (row === null) {
    throw new Error("no line");
  }
  return row;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? -1;
}

const audits = (jobId: string) =>
  count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_type = 'print_job' AND resource_id = ?", jobId);

const statusMails = (orderId: string) =>
  count(
    "SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'email.order_status' AND aggregate_id = ?",
    orderId,
  );

async function fulfilment(orderId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT fulfilment_status FROM orders WHERE order_id = ?")
    .bind(orderId)
    .first<{ fulfilment_status: string }>();
  return row?.fulfilment_status ?? "";
}

function seller(orderId: string, body: unknown, path: "cancel" | "fulfilment" = "fulfilment"): Promise<Response> {
  return worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}/${path}`, "POST", {
      body,
      cookie: admin.cookie,
      idempotencyKey: path === "fulfilment" ? crypto.randomUUID() : null,
      shopId: TENANT,
    }),
    quietEnv().env,
  );
}

async function sellerRefusal(orderId: string, body: unknown): Promise<string> {
  const response = await seller(orderId, body);
  expect(response.status, JSON.stringify(body)).toBe(409);
  return (await response.json<{ error: { reason: string } }>()).error.reason;
}

async function sellerGet(path: string): Promise<string> {
  const response = await worker.fetch(
    adminRequest(path, "GET", { cookie: admin.cookie, origin: null, shopId: TENANT }),
    quietEnv().env,
  );
  expect(response.status).toBe(200);
  return response.text();
}

async function podWords(orderId: string): Promise<string[]> {
  const body = JSON.parse(await sellerGet(`/v1/admin/orders/${orderId}`)) as {
    order: { items: Array<{ podState: string }> };
  };
  return body.order.items.map((item) => item.podState);
}

// ═══════════════════════════════════════════════════════════════════════════
describe("recording the printer's out of stock", () => {
  it("records it on an accepted line (not yet made, or in production): audited, one critical alert, the job answered", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);

    const body = await ok(job(order.orderId), OUT_OF_STOCK);

    expect(body).toMatchObject({
      changed: true,
      job: { exception: "out_of_stock", exceptionResolvedAt: null, jobId: job(order.orderId), state: null },
      orderShipped: false,
    });
    expect(await line(order.orderId)).toMatchObject({
      dispatch_state: "accepted",
      printer_exception: "out_of_stock",
      printer_exception_resolved_at: null,
      production_state: null,
    });
    const audit = await env.DB.prepare(
      "SELECT action, actor_user_id, tenant_id, metadata_json FROM audit_events WHERE resource_type = 'print_job' AND resource_id = ?",
    )
      .bind(job(order.orderId))
      .first<{ action: string; actor_user_id: string; metadata_json: string; tenant_id: string }>();
    expect(audit).toMatchObject({ action: "print_job.exception", actor_user_id: platform.userId, tenant_id: TENANT });
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toStrictEqual({
      exception: "out_of_stock",
      lineNo: 1,
      orderId: order.orderId,
      source: "platform",
      state: null,
    });
    const alerts = await alertsFor(job(order.orderId));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: printerExceptionAlertId(job(order.orderId)),
      kind: PRINTER_EXCEPTION_ALERT_KIND,
      resolved_at: null,
      severity: "critical",
    });
    // Ids and codes only (0017): no address, no amount.
    expect(alerts[0]?.message).toContain(job(order.orderId));
    expect(alerts[0]?.message).not.toMatch(/https?:|@|\d{4,}\s?(kr|SEK)/);

    const inProduction = await seedOrder(TENANT);
    await accept(inProduction.orderId);
    await ok(job(inProduction.orderId), { state: "in_production" });
    expect((await ok(job(inProduction.orderId), OUT_OF_STOCK)).job).toMatchObject({
      exception: "out_of_stock",
      state: "in_production",
    });
  });

  it("a repeat is a 200 no-op: no second audit row, no second alert, even with the first alert resolved", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    await ok(job(order.orderId), OUT_OF_STOCK);
    await env.DB.prepare("UPDATE alerts SET resolved_at = ? WHERE resource_id = ?")
      .bind(new Date(Date.now() + 1_000).toISOString(), job(order.orderId))
      .run();

    const again = await ok(job(order.orderId), OUT_OF_STOCK);

    expect(again.changed).toBe(false);
    expect(again.job.exception).toBe("out_of_stock");
    expect(await audits(job(order.orderId))).toBe(1);
    expect(await alertsFor(job(order.orderId))).toHaveLength(1);
  });

  it("two operators recording it at once: one change, one audit row, one alert", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);

    const results = await Promise.all([ok(job(order.orderId), OUT_OF_STOCK), ok(job(order.orderId), OUT_OF_STOCK)]);

    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(await audits(job(order.orderId))).toBe(1);
    expect(await alertsFor(job(order.orderId))).toHaveLength(1);
  });

  it("an exception recorded meanwhile (between the read and the batch): this request writes nothing and answers unchanged", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    const racingDb = racing(async (target) => {
      await target
        .prepare("UPDATE order_items SET printer_exception = 'out_of_stock' WHERE order_id = ?")
        .bind(order.orderId)
        .run();
    });

    const result = await recordProductionStatus(
      racingDb,
      platform.userId,
      job(order.orderId),
      parseProductionStatusInput(OUT_OF_STOCK)!,
      Date.now(),
    );

    expect(result).toMatchObject({ status: "unchanged" });
    expect(await audits(job(order.orderId))).toBe(0);
    expect(await alertsFor(job(order.orderId))).toHaveLength(0);
  });

  it("refuses a line the printer has not accepted, one already produced or shipped, a cancelled or refunded order; writes nothing", async () => {
    const cases: Array<[string, string]> = [];
    for (const dispatchState of [null, "pending", "submitting", "unknown", "failed"]) {
      const order = await seedOrder(TENANT);
      await env.DB.prepare("UPDATE order_items SET dispatch_state = ? WHERE order_id = ?")
        .bind(dispatchState, order.orderId)
        .run();
      cases.push([order.orderId, "not_accepted"]);
    }
    for (const state of ["produced", "shipped"]) {
      const order = await seedOrder(TENANT);
      await accept(order.orderId);
      await ok(job(order.orderId), { state });
      cases.push([order.orderId, "produced"]);
    }
    const cancelled = await seedOrder(TENANT);
    await accept(cancelled.orderId);
    expect((await seller(cancelled.orderId, { reason: "Kunden ångrade sig" }, "cancel")).status).toBe(200);
    cases.push([cancelled.orderId, "cancelled"]);
    const lineCancelled = await seedOrder(TENANT);
    await env.DB.prepare("UPDATE order_items SET dispatch_state = 'cancelled' WHERE order_id = ?")
      .bind(lineCancelled.orderId)
      .run();
    cases.push([lineCancelled.orderId, "cancelled"]);
    const refunded = await seedOrder(TENANT);
    await accept(refunded.orderId);
    await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE order_id = ?").bind(refunded.orderId).run();
    cases.push([refunded.orderId, "refunded"]);

    for (const [orderId, reason] of cases) {
      const before = await audits(job(orderId));
      expect(await refusal(job(orderId), OUT_OF_STOCK), reason).toBe(reason);
      expect((await line(orderId)).printer_exception).toBeNull();
      expect(await audits(job(orderId))).toBe(before);
      expect(await alertsFor(job(orderId))).toHaveLength(0);
    }
  });

  it("takes exactly one key with a known value (else 400), behind the platform route's own gate (else 404)", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    for (const body of [
      { exception: "OUT_OF_STOCK" },
      { exception: "damaged" },
      { exception: "" },
      { exception: null },
      { exception: 1 },
      { exception: "out_of_stock", state: "shipped" },
      { exception: "resolved", note: "x" },
      { exception: ["out_of_stock"] },
    ]) {
      expect((await post(job(order.orderId), body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(job(order.orderId), OUT_OF_STOCK, { cookie: null })).status).toBe(404);
    expect((await post(job(order.orderId), OUT_OF_STOCK, { cookie: admin.cookie })).status).toBe(404);
    expect((await line(order.orderId)).printer_exception).toBeNull();
    expect(await audits(job(order.orderId))).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("after the exception", () => {
  it("only the printer's 'shipped' (a restock) may follow; the seller then reads 'sent'", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    await ok(job(order.orderId), OUT_OF_STOCK);
    expect(await podWords(order.orderId)).toEqual(["failed"]);

    expect(await refusal(job(order.orderId), { state: "in_production" })).toBe("out_of_stock");
    expect(await refusal(job(order.orderId), { state: "produced" })).toBe("out_of_stock");
    const shipped = await ok(job(order.orderId), { carrier: "DPD", state: "shipped", trackingNumber: "RS1SE" });

    expect(shipped.job).toMatchObject({ exception: "out_of_stock", state: "shipped", trackingNumber: "RS1SE" });
    expect(await podWords(order.orderId)).toEqual(["sent"]);
    // Nothing to resolve once it was sent.
    expect(await refusal(job(order.orderId), RESOLVED)).toBe("produced");
  });

  it("an open exception holds the order: the seller gets printer_ships and no automatic 'shipped' mail goes out", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "shipping", lines: [{}, {}] });
    await accept(order.orderId);
    await ok(job(order.orderId, 1), OUT_OF_STOCK);

    const other = await ok(job(order.orderId, 2), { state: "shipped", trackingNumber: "RS2SE" });

    expect(other.orderShipped).toBe(false);
    expect(await fulfilment(order.orderId)).toBe("unfulfilled");
    expect(await statusMails(order.orderId)).toBe(0);
    expect(await sellerRefusal(order.orderId, { to: "shipped", trackingNumber: "OWN1" })).toBe("printer_ships");

    const pickup = await seedOrder(TENANT, { deliveryMethod: "pickup" });
    await accept(pickup.orderId);
    await ok(job(pickup.orderId), OUT_OF_STOCK);
    expect(await sellerRefusal(pickup.orderId, { to: "ready_for_pickup" })).toBe("printer_ships");
    // `processing` is always the seller's.
    expect((await seller(pickup.orderId, { to: "processing" })).status).toBe(200);
  });

  it("restocked: the out-of-stock line shipped last ships the all-printer parcel order, with ONE mail", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "shipping", lines: [{}, {}] });
    await accept(order.orderId);
    await ok(job(order.orderId, 1), OUT_OF_STOCK);
    expect((await ok(job(order.orderId, 2), { state: "shipped" })).orderShipped).toBe(false);

    const q = quietEnv();
    const restocked = await ok(job(order.orderId, 1), { state: "shipped" }, q.env);

    expect(restocked.orderShipped).toBe(true);
    expect(await fulfilment(order.orderId)).toBe("shipped");
    expect(await statusMails(order.orderId)).toBe(1);
    expect(q.nudges.sent.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("resolving it (the printer will not send the line)", () => {
  it("resolves an open exception: audited; the line stops holding the order back; the seller still reads 'failed'", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "shipping", lines: [{ production: "none" }, {}] });
    await accept(order.orderId);
    await ok(job(order.orderId, 2), OUT_OF_STOCK);
    expect(await sellerRefusal(order.orderId, { to: "shipped", trackingNumber: "OWN2" })).toBe("printer_ships");

    const resolved = await ok(job(order.orderId, 2), RESOLVED);

    expect(resolved.changed).toBe(true);
    // A mixed order is the seller's to ship: nothing is shipped for them.
    expect(resolved.orderShipped).toBe(false);
    expect(resolved.job.exceptionResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await line(order.orderId, 2)).printer_exception_resolved_at).toBe(resolved.job.exceptionResolvedAt);
    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events
       WHERE resource_type = 'print_job' AND resource_id = ? AND action = 'print_job.exception_resolved'`,
    )
      .bind(job(order.orderId, 2))
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toStrictEqual({
      exception: "out_of_stock",
      lineNo: 2,
      orderId: order.orderId,
      source: "platform",
      state: null,
    });
    expect(await podWords(order.orderId)).toEqual(["none", "failed"]);
    expect(await statusMails(order.orderId)).toBe(0);

    expect((await seller(order.orderId, { to: "shipped", trackingNumber: "OWN2" })).status).toBe(200);
    expect(await statusMails(order.orderId)).toBe(1);
  });

  it("resolving the last unsent line of an all-printer parcel order records it shipped, with ONE mail; nothing sent, no mail", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "shipping", lines: [{}, {}] });
    await accept(order.orderId);
    await ok(job(order.orderId, 1), OUT_OF_STOCK);
    await ok(job(order.orderId, 2), { state: "shipped" });

    const q = quietEnv();
    const resolved = await ok(job(order.orderId, 1), RESOLVED, q.env);

    expect(resolved.orderShipped).toBe(true);
    expect(await fulfilment(order.orderId)).toBe("shipped");
    expect(await statusMails(order.orderId)).toBe(1);
    const mail = await env.DB.prepare(
      "SELECT outbox_id FROM outbox_events WHERE event_type = 'email.order_status' AND aggregate_id = ?",
    )
      .bind(order.orderId)
      .first<{ outbox_id: string }>();
    expect(q.nudges.sent).toContainEqual({ outboxId: mail?.outbox_id });
    const history = await env.DB.prepare(
      "SELECT from_status, to_status, actor_user_id FROM order_status_history WHERE order_id = ? AND track = 'fulfilment'",
    )
      .bind(order.orderId)
      .all();
    expect(history.results).toStrictEqual([
      { actor_user_id: platform.userId, from_status: "unfulfilled", to_status: "shipped" },
    ]);

    // Nothing was sent at all: the resolution ships nothing and mails nothing.
    const nothing = await seedOrder(TENANT, { deliveryMethod: "shipping" });
    await accept(nothing.orderId);
    await ok(job(nothing.orderId), OUT_OF_STOCK);
    expect((await ok(job(nothing.orderId), RESOLVED)).orderShipped).toBe(false);
    expect(await fulfilment(nothing.orderId)).toBe("unfulfilled");
    expect(await statusMails(nothing.orderId)).toBe(0);
  });

  it("a repeat is a no-op; refused without an exception; allowed on a closed order (bookkeeping); nothing follows it", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    expect(await refusal(job(order.orderId), RESOLVED)).toBe("no_exception");
    expect((await line(order.orderId)).printer_exception_resolved_at).toBeNull();

    await ok(job(order.orderId), OUT_OF_STOCK);
    const first = await ok(job(order.orderId), RESOLVED);
    const again = await ok(job(order.orderId), RESOLVED);
    expect(again.changed).toBe(false);
    expect(again.job.exceptionResolvedAt).toBe(first.job.exceptionResolvedAt);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'print_job.exception_resolved'",
        job(order.orderId),
      ),
    ).toBe(1);
    for (const state of ["in_production", "produced", "shipped"]) {
      expect(await refusal(job(order.orderId), { state }), state).toBe("exception_resolved");
    }
    expect((await ok(job(order.orderId), OUT_OF_STOCK)).changed).toBe(false);

    // A real acceptance (the fake printer), then the seller cancels the order:
    // the job is the printer's (a printer cancellation), the order is closed.
    const closed = await seedOrder(TENANT);
    await processOutboxRowById(quietEnv().env, closed.dispatchIds[0] as string);
    expect((await line(closed.orderId)).dispatch_state).toBe("accepted");
    await ok(job(closed.orderId), OUT_OF_STOCK);
    expect((await seller(closed.orderId, { reason: "Slut i lager" }, "cancel")).status).toBe(200);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'printer_cancellation' AND aggregate_id = ?",
        closed.orderId,
      ),
    ).toBe(1);
    expect((await ok(job(closed.orderId), RESOLVED)).changed).toBe(true);
    expect(await refusal(job(closed.orderId), { state: "shipped" })).toBe("cancelled");
  });

  it("a state racing a newly recorded exception is decided again (no trigger abort): out_of_stock, nothing written", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    const racingDb = racing(async (target) => {
      await target
        .prepare("UPDATE order_items SET printer_exception = 'out_of_stock' WHERE order_id = ?")
        .bind(order.orderId)
        .run();
    });

    const result = await recordProductionStatus(
      racingDb,
      platform.userId,
      job(order.orderId),
      parseProductionStatusInput({ state: "in_production" })!,
      Date.now(),
    );

    expect(result).toStrictEqual({ reason: "out_of_stock", status: "refused" });
    expect((await line(order.orderId)).production_state).toBeNull();
    expect(await audits(job(order.orderId))).toBe(0);
  });
});

/** The database, with `before` run once just before the first batch (a concurrent writer). */
function racing(before: (target: D1Database) => Promise<void>): D1Database {
  let raced = false;
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await before(target);
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
describe("no money moves", () => {
  /** A POD order paid through the real webhook, its print file in R2, accepted by the fake printer. */
  async function acceptedPaidOrder(stripe: FakeMoneyStripe): Promise<string> {
    const bytes = new TextEncoder().encode(`print-${next("ps3")}`);
    const r2Key = `pod/${TENANT}/print/${next("file")}.png`;
    await env.PRIVATE_BUCKET.put(r2Key, bytes, { sha256: await crypto.subtle.digest("SHA-256", bytes) });
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const checkout = await seedCheckout({
      connect: { accountId, feeMinor: FEE, withheldMinor: WITHHELD },
      snapshot: JSON.stringify({
        lines: [
          {
            lineNo: 1,
            printFiles: [{ heightMm: 350, r2Key, sha256: digest, slot: "front", widthMm: 250 }],
            productionCostMinor: 9_840,
            quantity: 1,
            sku: "2500170",
            withholdMinor: WITHHELD,
          },
        ],
        printer: "fake-printer",
        totals: { productionCostMinor: 9_840, withholdMinor: WITHHELD },
      }),
      tenantId: TENANT,
      unitPriceMinor: PRICE,
    });
    const orderId = await payCheckout(checkout, TENANT, { latestCharge: next("ch") });
    stripe.addIntent({ amount: PRICE, id: checkout.paymentIntentId as string, status: "succeeded" });
    const dispatch = await env.DB.prepare(
      "SELECT outbox_id FROM outbox_events WHERE event_type = 'dispatch' AND aggregate_id = ?",
    )
      .bind(orderId)
      .first<{ outbox_id: string }>();
    await processOutboxRowById(moneyEnv(stripe, quietEnv().env), dispatch?.outbox_id ?? "");
    expect((await line(orderId)).dispatch_state).toBe("accepted");
    return orderId;
  }

  it("recording and resolving change no amount; the withholding is never released; a full refund still settles and asks for the printer's cancellation", async () => {
    const stripe = new FakeMoneyStripe();
    const orderId = await acceptedPaidOrder(stripe);
    const before = await orderMoney(orderId);
    const lineMoney = () =>
      env.DB.prepare(
        "SELECT unit_price_minor, line_total_minor, production_json FROM order_items WHERE order_id = ?",
      )
        .bind(orderId)
        .first();
    const lineBefore = await lineMoney();

    await ok(job(orderId), OUT_OF_STOCK);
    await ok(job(orderId), RESOLVED);

    // A pickup order: the resolution ships nothing, so the order row is untouched.
    expect(JSON.stringify(await orderMoney(orderId))).toBe(JSON.stringify(before));
    expect(JSON.stringify(await lineMoney())).toBe(JSON.stringify(lineBefore));
    expect(before.withheld_minor).toBe(WITHHELD);
    let summary = await runReconciliation(moneyEnv(stripe, quietEnv().env), Date.now());
    expect(summary.withholding.discovered).toBe(0);

    const refund = await worker.fetch(
      adminRequest(`/v1/admin/orders/${orderId}/refunds`, "POST", {
        body: { amountMinor: PRICE, reason: "Slut i lager hos tryckeriet" },
        cookie: admin.cookie,
        shopId: TENANT,
      }),
      moneyEnv(stripe, quietEnv().env),
    );
    expect(refund.status).toBe(201);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'printer_cancellation' AND aggregate_id = ?",
        orderId,
      ),
    ).toBe(1);
    summary = await runReconciliation(moneyEnv(stripe, quietEnv().env), Date.now());
    expect(summary.withholding.discovered).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM withholding_releases WHERE order_id = ?", orderId)).toBe(0);
    expect((await orderMoney(orderId)).withheld_minor).toBe(WITHHELD);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("what the seller and the platform read", () => {
  it("the seller reads one existing word per line and nothing of the exception, the printer, the job or the cost", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "shipping", lines: [{}, {}, {}] });
    await accept(order.orderId);
    for (const lineNo of [1, 2, 3]) {
      await ok(job(order.orderId, lineNo), OUT_OF_STOCK);
    }
    await ok(job(order.orderId, 2), RESOLVED);
    await ok(job(order.orderId, 3), { carrier: "PRINTER-CARRIER-Y", state: "shipped", trackingNumber: "PRINTER-TRACK-Y" });

    const detail = await sellerGet(`/v1/admin/orders/${order.orderId}`);
    const list = await sellerGet("/v1/admin/orders?limit=100");
    expect(
      (JSON.parse(detail) as { order: { items: Array<{ podState: string }> } }).order.items.map((item) => item.podState),
    ).toEqual(["failed", "failed", "sent"]);

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
    const bodies = [JSON.parse(detail), JSON.parse(list)] as unknown[];
    bodies.forEach(walk);
    bodies.forEach((body) => expectNoCostKeys(body));
    for (const key of keys) {
      for (const denied of [
        "withh", "production", "cost", "commission", "snapshot", "printer", "job", "dispatch", "exception",
      ]) {
        expect(key.toLowerCase(), key).not.toContain(denied);
      }
    }
    const text = `${detail}${list}`;
    for (const secret of [
      "out_of_stock", "exception", "resolved", "print-job-out-of-stock", "SWX-", "PRINTER-TRACK-Y", "PRINTER-CARRIER-Y",
      "fake-printer",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("the platform's list carries the exception and its resolution, and filters on it", async () => {
    const order = await seedOrder(TENANT, { lines: [{}, {}, {}] });
    await accept(order.orderId);
    await ok(job(order.orderId, 1), OUT_OF_STOCK);
    await ok(job(order.orderId, 2), OUT_OF_STOCK);
    const resolved = await ok(job(order.orderId, 2), RESOLVED);

    const list = async (query: string) => {
      const response = await worker.fetch(
        sessionRequest(`${PLATFORM_HOST}/v1/platform/print-jobs${query}`, "GET", { cookie: platform.cookie, origin: null }),
        quietEnv().env,
      );
      expect(response.status, query).toBe(200);
      const body = await response.json<{
        jobs: Array<{ exception: string | null; exceptionResolvedAt: string | null; jobId: string }>;
      }>();
      return body.jobs.filter((row) => row.jobId.startsWith(order.orderId));
    };

    expect(await list(`?tenantId=${TENANT}&limit=100`)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exception: "out_of_stock", exceptionResolvedAt: null, jobId: job(order.orderId, 1) }),
        expect.objectContaining({
          exception: "out_of_stock",
          exceptionResolvedAt: resolved.job.exceptionResolvedAt,
          jobId: job(order.orderId, 2),
        }),
        expect.objectContaining({ exception: null, exceptionResolvedAt: null, jobId: job(order.orderId, 3) }),
      ]),
    );
    expect((await list(`?tenantId=${TENANT}&exception=out_of_stock&limit=100`)).map((row) => row.jobId)).toEqual([
      job(order.orderId, 1),
      job(order.orderId, 2),
    ]);
    expect((await list(`?tenantId=${TENANT}&exception=none&limit=100`)).map((row) => row.jobId)).toEqual([
      job(order.orderId, 3),
    ]);
    for (const query of ["?exception=", "?exception=OUT_OF_STOCK", "?exception=resolved", "?exception=none&exception=none"]) {
      const response = await worker.fetch(
        sessionRequest(`${PLATFORM_HOST}/v1/platform/print-jobs${query}`, "GET", { cookie: platform.cookie, origin: null }),
        quietEnv().env,
      );
      expect(response.status, query).toBe(400);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("migration 0054's backstops", () => {
  async function acceptedLine(): Promise<string> {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    return order.orderId;
  }

  const set = (orderId: string, sql: string) =>
    env.DB.prepare(`UPDATE order_items SET ${sql} WHERE order_id = ? AND item_index = 0`).bind(orderId).run();

  it("no line is born with an exception or a resolution", async () => {
    const orderId = await acceptedLine();
    for (const column of ["printer_exception", "printer_exception_resolved_at"]) {
      const value = column === "printer_exception" ? "'out_of_stock'" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
      await expect(
        env.DB.prepare(
          `INSERT INTO order_items (
             order_item_id, order_id, tenant_id, item_index, product_id, variant_id, sku, name,
             quantity, unit_price_minor, line_total_minor, created_at, updated_at, production_json, ${column}
           )
           SELECT ?, order_id, tenant_id, 50, product_id, variant_id, sku, name,
                  quantity, unit_price_minor, line_total_minor, created_at, updated_at, production_json, ${value}
           FROM order_items WHERE order_id = ? AND item_index = 0`,
        )
          .bind(crypto.randomUUID(), orderId)
          .run(),
        column,
      ).rejects.toThrow(/never at insert/);
    }
  });

  it("the exception: only 'out_of_stock', only on an accepted printer line not yet produced, never changed or cleared", async () => {
    await expect(set(await acceptedLine(), "printer_exception = 'damaged'")).rejects.toThrow(/CHECK/);

    const notAccepted = await seedOrder(TENANT);
    await expect(set(notAccepted.orderId, "printer_exception = 'out_of_stock'")).rejects.toThrow(/written once/);
    const notPod = await seedOrder(TENANT, { lines: [{ production: "none" }] });
    await set(notPod.orderId, "dispatch_state = 'accepted'");
    await expect(set(notPod.orderId, "printer_exception = 'out_of_stock'")).rejects.toThrow(/written once/);
    for (const state of ["produced", "shipped"]) {
      const orderId = await acceptedLine();
      await set(orderId, `production_state = '${state}'`);
      await expect(set(orderId, "printer_exception = 'out_of_stock'"), state).rejects.toThrow(/written once/);
    }

    const orderId = await acceptedLine();
    await set(orderId, "printer_exception = 'out_of_stock'");
    await expect(set(orderId, "printer_exception = NULL")).rejects.toThrow(/written once/);
    // The same value again is not a change.
    await set(orderId, "printer_exception = 'out_of_stock'");
  });

  it("the resolution: only with the exception, on a line not sent, ISO, once", async () => {
    const without = await acceptedLine();
    await expect(set(without, "printer_exception_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")).rejects.toThrow(
      /resolved once/,
    );
    const shipped = await acceptedLine();
    await set(shipped, "printer_exception = 'out_of_stock'");
    await set(shipped, "production_state = 'shipped'");
    await expect(set(shipped, "printer_exception_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")).rejects.toThrow(
      /resolved once/,
    );

    const orderId = await acceptedLine();
    await set(orderId, "printer_exception = 'out_of_stock'");
    await expect(set(orderId, "printer_exception_resolved_at = '2026-10-04 18:00:00'")).rejects.toThrow(/CHECK/);
    await set(orderId, "printer_exception_resolved_at = '2026-10-04T18:00:00.000Z'");
    await expect(set(orderId, "printer_exception_resolved_at = '2026-10-04T19:00:00.000Z'")).rejects.toThrow(
      /resolved once/,
    );
    await expect(set(orderId, "printer_exception_resolved_at = NULL")).rejects.toThrow(/resolved once/);
  });

  it("a line with an exception moves only to 'shipped', and a resolved one not at all", async () => {
    const orderId = await acceptedLine();
    await set(orderId, "printer_exception = 'out_of_stock'");
    for (const state of ["in_production", "produced"]) {
      await expect(set(orderId, `production_state = '${state}'`), state).rejects.toThrow(/moves only to shipped/);
    }
    await set(orderId, "production_state = 'shipped'");

    const resolved = await acceptedLine();
    await set(resolved, "printer_exception = 'out_of_stock'");
    await set(resolved, "printer_exception_resolved_at = '2026-10-04T18:00:00.000Z'");
    await expect(set(resolved, "production_state = 'shipped'")).rejects.toThrow(/moves only to shipped/);
  });
});
