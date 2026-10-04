import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { runReconciliation } from "../src/commerce/crons";
import {
  decideProductionStatus,
  parseProductionStatusInput,
  recordProductionStatus,
} from "../src/dispatch/production-status";
import { printerJobId } from "../src/dispatch/snapwear-wire";
import type { AuthEmailJob } from "../src/email/auth-email-job";
import { renderAuthEmail } from "../src/email/auth-email-job";
import { processOutboxRowById } from "../src/outbox/effects";
import {
  grantAccess,
  lineRow,
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
  payCheckout,
  seedCheckout,
  seedTenant,
  signUpAdmin,
} from "./money-fixtures";

/**
 * CP6-PS1 part 2 — the printer's production status intake: the ONE writer of
 * `order_items.production_state` (src/dispatch/production-status.ts) and its
 * platform route `POST /v1/platform/print-jobs/:jobId/status`.
 *
 * Every rule of the brief, each with its test: only an ACCEPTED job moves;
 * forward only (a repeat is a 200 no-op, a step back is refused); a cancelled
 * or refunded order is refused; the three guards that read the state
 * (cancellation, the full refund's dispatch stop, the withholding release);
 * the seller's fulfilment; and the buyer's shipped mail, ONCE.
 */

const TENANT = "tenant-ps1-status";
const OTHER = "tenant-ps1-other";
const PLATFORM_HOST = "https://platform.ps1.test";
const PRICE = 20_000;
const FEE = 13_300;
const WITHHELD = 12_300;

let platform: SignedUpUser;
let admin: Admin;
let otherAdmin: Admin;
let accountId: string;

beforeAll(async () => {
  accountId = (await seedTenant(TENANT)) as string;
  await seedTenant(OTHER);
  admin = await signUpAdmin("ps1-admin@example.test", TENANT);
  otherAdmin = await signUpAdmin("ps1-other@example.test", OTHER);
  platform = await signUp("ps1-platform@example.test");
  await grantAccess(platform.userId, "platform_admin");
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM outbox_events WHERE event_type = 'dispatch'").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── helpers ────────────────────────────────────────────────────────────────

function status(
  jobId: string,
  body: unknown,
  options: { cookie?: string | null; method?: string; origin?: string | null; shopId?: string } = {},
  targetEnv: Env = quietEnv().env,
): Promise<Response> {
  return worker.fetch(
    sessionRequest(`${PLATFORM_HOST}/v1/platform/print-jobs/${jobId}/status`, options.method ?? "POST", {
      body,
      cookie: options.cookie === null ? undefined : (options.cookie ?? platform.cookie),
      origin: options.origin,
      shopId: options.shopId,
    }),
    targetEnv,
  );
}

interface StatusBody {
  changed: boolean;
  job: {
    carrier: string | null;
    exception: string | null;
    exceptionResolvedAt: string | null;
    jobId: string;
    lineNo: number;
    orderId: string;
    state: string | null;
    tenantId: string;
    trackingNumber: string | null;
    trackingUrl: string | null;
  };
  orderShipped: boolean;
}

async function statusOk(jobId: string, body: unknown, targetEnv?: Env): Promise<StatusBody> {
  const response = await status(jobId, body, {}, targetEnv);
  expect(response.status, JSON.stringify(body)).toBe(200);
  return response.json<StatusBody>();
}

async function refusal(jobId: string, body: unknown): Promise<string> {
  const response = await status(jobId, body);
  expect(response.status, JSON.stringify(body)).toBe(409);
  const json = await response.json<{ error: { code: string; reason: string } }>();
  expect(json.error.code).toBe("print_job_status_not_allowed");
  return json.error.reason;
}

/** Marks the order's POD lines accepted, as the dispatch does (or a human resolves). */
async function accept(orderId: string, lineNos?: number[]): Promise<void> {
  await env.DB.prepare(
    `UPDATE order_items SET dispatch_state = 'accepted', printer_job_ref = 'SW-' || item_index,
       dispatched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE order_id = ? AND production_json IS NOT NULL
       ${lineNos === undefined ? "" : `AND item_index + 1 IN (${lineNos.join(", ")})`}`,
  )
    .bind(orderId)
    .run();
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? -1;
}

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

function seller(
  orderId: string,
  body: unknown,
  path: "cancel" | "fulfilment" = "fulfilment",
): Promise<Response> {
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

async function sellerRead(orderId: string): Promise<string> {
  const response = await worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}`, "GET", { cookie: admin.cookie, origin: null, shopId: TENANT }),
    quietEnv().env,
  );
  expect(response.status).toBe(200);
  return response.text();
}

const job = (orderId: string, lineNo = 1) => printerJobId(orderId, lineNo);

// ═══════════════════════════════════════════════════════════════════════════
describe("the route's refusals: the opaque 404, the 400, and nothing written", () => {
  it("answers the opaque 404 to every wrong caller, request and job", async () => {
    const order = await seedOrder(TENANT, { lines: [{}, { production: "none" }] });
    await accept(order.orderId);
    const body = { state: "in_production" };
    const cases: Array<[string, Promise<Response>]> = [
      ["no session", status(job(order.orderId), body, { cookie: null })],
      ["a shop's admin", status(job(order.orderId), body, { cookie: admin.cookie })],
      ["X-Shop-Id on a platform route", status(job(order.orderId), body, { shopId: TENANT })],
      ["a foreign origin", status(job(order.orderId), body, { origin: "https://evil.test" })],
      ["no origin", status(job(order.orderId), body, { origin: null })],
      ["GET", status(job(order.orderId), undefined, { method: "GET" })],
      ["PUT", status(job(order.orderId), body, { method: "PUT" })],
      ["DELETE", status(job(order.orderId), undefined, { method: "DELETE" })],
      ["not a job id", status("nope", body)],
      ["line 0", status(`${order.orderId}-0`, body)],
      ["a padded line", status(`${order.orderId}-01`, body)],
      ["an upper-case id", status(`${order.orderId.toUpperCase()}-1`, body)],
      ["an encoded slash", status(`${order.orderId}%2F1`, body)],
      ["an unknown order", status(job(crypto.randomUUID()), body)],
      ["an unknown line", status(job(order.orderId, 7), body)],
      ["a line that is not a printer line", status(job(order.orderId, 2), body)],
    ];
    for (const [label, pending] of cases) {
      expect((await pending).status, label).toBe(404);
    }
    expect((await lineRow(order.orderId)).production_state).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ?", job(order.orderId))).toBe(0);
  });

  it("answers 400 to a body that is not exactly the shape, and writes nothing", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    for (const body of [
      undefined,
      "shipped",
      [],
      {},
      { state: "printed" },
      { state: "SHIPPED" },
      { state: "shipped", note: "x" },
      { state: "in_production", trackingNumber: "RR1SE" },
      { state: "produced", carrier: "PostNord" },
      { state: "shipped", trackingNumber: "" },
      { state: "shipped", trackingNumber: "x".repeat(101) },
      { state: "shipped", trackingNumber: "RR1\nSE" },
      { state: "shipped", carrier: "x".repeat(61) },
      { state: "shipped", trackingNumber: 123 },
      { state: "shipped", trackingUrl: "http://track.test/RR1SE" },
      { state: "shipped", trackingUrl: "https://user:pw@track.test/x" },
      { state: "shipped", trackingUrl: "javascript:alert(1)" },
      { state: "shipped", trackingUrl: `https://track.test/${"x".repeat(500)}` },
    ]) {
      const response = await status(job(order.orderId), body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await lineRow(order.orderId)).production_state).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the rules", () => {
  it("moves an accepted job forward, records who/when, and answers the job", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);

    const steps = [
      { state: "in_production" },
      { state: "produced" },
      { carrier: "DPD", state: "shipped", trackingNumber: "RR123SE", trackingUrl: "https://track.test/RR123SE" },
    ];
    for (const step of steps) {
      const body = await statusOk(job(order.orderId), step);
      expect(body).toStrictEqual({
        changed: true,
        job: {
          carrier: step.carrier ?? null,
          exception: null,
          exceptionResolvedAt: null,
          jobId: job(order.orderId),
          lineNo: 1,
          orderId: order.orderId,
          state: step.state,
          tenantId: TENANT,
          trackingNumber: step.trackingNumber ?? null,
          trackingUrl: step.trackingUrl ?? null,
        },
        // A pickup order: the seller hands it over, nothing is shipped for them.
        orderShipped: false,
      });
    }

    const line = await env.DB.prepare(
      `SELECT production_state, printer_tracking_number, printer_carrier, printer_tracking_url
       FROM order_items WHERE order_id = ?`,
    )
      .bind(order.orderId)
      .first();
    expect(line).toStrictEqual({
      printer_carrier: "DPD",
      printer_tracking_number: "RR123SE",
      printer_tracking_url: "https://track.test/RR123SE",
      production_state: "shipped",
    });
    const audits = await env.DB.prepare(
      `SELECT tenant_id, actor_user_id, action, resource_type, metadata_json FROM audit_events
       WHERE resource_id = ? ORDER BY created_at, rowid`,
    )
      .bind(job(order.orderId))
      .all<{ action: string; actor_user_id: string; metadata_json: string; resource_type: string; tenant_id: string }>();
    expect(audits.results.map((row) => JSON.parse(row.metadata_json))).toEqual([
      { from: null, lineNo: 1, orderId: order.orderId, source: "platform", to: "in_production" },
      { from: "in_production", lineNo: 1, orderId: order.orderId, source: "platform", to: "produced" },
      { from: "produced", lineNo: 1, orderId: order.orderId, source: "platform", to: "shipped" },
    ]);
    expect(
      audits.results.every(
        (row) =>
          row.action === "print_job.status" &&
          row.resource_type === "print_job" &&
          row.actor_user_id === platform.userId &&
          row.tenant_id === TENANT &&
          !row.metadata_json.includes("RR123SE"),
      ),
    ).toBe(true);
  });

  it("may skip a state (the printer's mail may only ever say shipped)", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    expect((await statusOk(job(order.orderId), { state: "shipped" })).job.state).toBe("shipped");
  });

  it("a repeat of the same state with the same facts is a 200 no-op, writing nothing", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    const shipped = { carrier: "DPD", state: "shipped", trackingNumber: "RR9SE" };
    await statusOk(job(order.orderId), shipped);
    const audits = await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ?", job(order.orderId));

    const again = await statusOk(job(order.orderId), shipped);

    expect(again.changed).toBe(false);
    expect(again.orderShipped).toBe(false);
    expect(again.job).toMatchObject({ carrier: "DPD", state: "shipped", trackingNumber: "RR9SE" });
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ?", job(order.orderId))).toBe(audits);
  });

  it("refuses a job the printer has not accepted, in every dispatch state but accepted", async () => {
    for (const dispatchState of [null, "pending", "submitting", "unknown", "failed"]) {
      const order = await seedOrder(TENANT);
      await env.DB.prepare("UPDATE order_items SET dispatch_state = ? WHERE order_id = ?")
        .bind(dispatchState, order.orderId)
        .run();
      expect(await refusal(job(order.orderId), { state: "in_production" }), String(dispatchState)).toBe("not_accepted");
      expect((await lineRow(order.orderId)).production_state).toBeNull();
    }
  });

  it("a job resolved accepted by a human (no printer reference) moves like any other", async () => {
    const order = await seedOrder(TENANT);
    await env.DB.prepare("UPDATE order_items SET dispatch_state = 'accepted' WHERE order_id = ?")
      .bind(order.orderId)
      .run();
    expect((await statusOk(job(order.orderId), { state: "produced" })).changed).toBe(true);
  });

  it("refuses a step back, and a repeat that names other tracking", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    await statusOk(job(order.orderId), { state: "produced" });
    expect(await refusal(job(order.orderId), { state: "in_production" })).toBe("backwards");

    await statusOk(job(order.orderId), { state: "shipped", trackingNumber: "RR1SE" });
    expect(await refusal(job(order.orderId), { state: "produced" })).toBe("backwards");
    expect(await refusal(job(order.orderId), { state: "shipped", trackingNumber: "RR2SE" })).toBe("tracking_differs");
    expect(await refusal(job(order.orderId), { state: "shipped" })).toBe("tracking_differs");
    expect(await lineRow(order.orderId)).toMatchObject({ production_state: "shipped" });
  });

  it("refuses a cancelled order, a cancelled line and a refunded order, with the reason", async () => {
    const cancelled = await seedOrder(TENANT);
    await accept(cancelled.orderId);
    expect((await seller(cancelled.orderId, { reason: "Kunden ångrade sig" }, "cancel")).status).toBe(200);
    expect(await refusal(job(cancelled.orderId), { state: "in_production" })).toBe("cancelled");

    const line = await seedOrder(TENANT);
    await env.DB.prepare("UPDATE order_items SET dispatch_state = 'cancelled' WHERE order_id = ?")
      .bind(line.orderId)
      .run();
    expect(await refusal(job(line.orderId), { state: "in_production" })).toBe("cancelled");

    const refunded = await seedOrder(TENANT);
    await accept(refunded.orderId);
    await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE order_id = ?").bind(refunded.orderId).run();
    expect(await refusal(job(refunded.orderId), { state: "shipped" })).toBe("refunded");

    for (const order of [cancelled, line, refunded]) {
      expect((await lineRow(order.orderId)).production_state).toBeNull();
    }
  });

  it("a cancellation landing between the read and the batch: nothing written, decided again", async () => {
    const order = await seedOrder(TENANT);
    await accept(order.orderId);
    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await target
                .prepare("UPDATE orders SET cancelled_at = ?, cancel_reason = 'race' WHERE order_id = ?")
                .bind(new Date().toISOString(), order.orderId)
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    const result = await recordProductionStatus(
      racingDb,
      platform.userId,
      job(order.orderId),
      parseProductionStatusInput({ state: "shipped" })!,
      Date.now(),
    );

    expect(result).toStrictEqual({ reason: "cancelled", status: "refused" });
    expect((await lineRow(order.orderId)).production_state).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ?", job(order.orderId))).toBe(0);
  });

  it("decides a repeat from what is recorded, even after the order closed", () => {
    const facts = {
      cancelled: false,
      carrier: null,
      dispatchState: "accepted",
      exception: null,
      exceptionResolvedAt: null,
      refunded: true,
      state: "shipped" as const,
      trackingNumber: null,
      trackingUrl: null,
    };
    const input = parseProductionStatusInput({ state: "shipped" })!;
    expect(decideProductionStatus(facts, input)).toBe("unchanged");
    expect(decideProductionStatus({ ...facts, state: "produced" }, input)).toBe("refunded");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("what a written state does to the three guards", () => {
  it("cancellation: produced or shipped is a return case; in production still cancels (printer cancellation)", async () => {
    for (const [state, expected] of [
      ["produced", 409],
      ["shipped", 409],
      ["in_production", 200],
    ] as const) {
      const order = await seedOrder(TENANT);
      const dispatchId = order.dispatchIds[0]!;
      await processOutboxRowById(quietEnv().env, dispatchId); // the fake printer accepts
      expect((await lineRow(order.orderId)).dispatch_state).toBe("accepted");
      await statusOk(job(order.orderId), { state });

      const response = await seller(order.orderId, { reason: "Kunden ångrade sig" }, "cancel");

      expect(response.status, state).toBe(expected);
      const cancellations = await count(
        "SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'printer_cancellation' AND aggregate_id = ?",
        order.orderId,
      );
      expect(cancellations, state).toBe(expected === 200 ? 1 : 0);
    }
  });

  /** A POD order paid through the real webhook, its print file in R2, accepted by the fake printer. */
  async function acceptedPaidOrder(stripe: FakeMoneyStripe): Promise<string> {
    const bytes = new TextEncoder().encode(`print-${next("ps1")}`);
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
    expect((await lineRow(orderId)).dispatch_state).toBe("accepted");
    return orderId;
  }

  it("a full refund: still settles; queues no printer cancellation once produced/shipped; never releases the withholding", async () => {
    for (const [state, cancellationsExpected] of [
      ["shipped", 0],
      ["produced", 0],
      ["in_production", 1],
    ] as const) {
      const stripe = new FakeMoneyStripe();
      const orderId = await acceptedPaidOrder(stripe);
      await statusOk(job(orderId), { state });

      const refund = await worker.fetch(
        adminRequest(`/v1/admin/orders/${orderId}/refunds`, "POST", {
          body: { amountMinor: PRICE, reason: "buyer" },
          cookie: admin.cookie,
          shopId: TENANT,
        }),
        moneyEnv(stripe, quietEnv().env),
      );
      expect(refund.status, state).toBe(201);
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'printer_cancellation' AND aggregate_id = ?",
          orderId,
        ),
        state,
      ).toBe(cancellationsExpected);

      const summary = await runReconciliation(moneyEnv(stripe, quietEnv().env), Date.now());
      expect(summary.withholding.discovered, state).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM withholding_releases WHERE order_id = ?", orderId)).toBe(0);
      // A refunded order takes no further step (a shipped line has none left).
      if (state !== "shipped") {
        expect(await refusal(job(orderId), { state: "shipped", trackingNumber: "LATE1" })).toBe("refunded");
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the seller's fulfilment and the buyer's mail", () => {
  it("an all-printer parcel order: shipped by the LAST line, with ONE mail, never per line", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "shipping", lines: [{}, {}] });
    await accept(order.orderId);

    const first = await statusOk(job(order.orderId, 1), { state: "shipped", trackingNumber: "RR1SE" });
    expect(first.orderShipped).toBe(false);
    expect(await fulfilment(order.orderId)).toBe("unfulfilled");
    expect(await statusMails(order.orderId)).toBe(0);
    // The seller still cannot ship it: line 2 is at the printer.
    const early = await seller(order.orderId, { to: "shipped", trackingNumber: "X" });
    expect(early.status).toBe(409);
    expect((await early.json<{ error: { reason: string } }>()).error.reason).toBe("printer_ships");

    const q = quietEnv();
    const last = await statusOk(job(order.orderId, 2), { carrier: "DPD", state: "shipped", trackingNumber: "RR2SE" }, q.env);
    expect(last.orderShipped).toBe(true);
    expect(await fulfilment(order.orderId)).toBe("shipped");
    expect(await statusMails(order.orderId)).toBe(1);
    // The route nudged the mail at once.
    const mail = await env.DB.prepare(
      "SELECT outbox_id, payload_json FROM outbox_events WHERE event_type = 'email.order_status' AND aggregate_id = ?",
    )
      .bind(order.orderId)
      .first<{ outbox_id: string; payload_json: string }>();
    expect(q.nudges.sent).toContainEqual({ outboxId: mail?.outbox_id });
    const historyId = (JSON.parse(mail?.payload_json ?? "{}") as { historyId: string }).historyId;
    expect(JSON.parse(mail?.payload_json ?? "{}")).toStrictEqual({ historyId, orderId: order.orderId });

    // One history row, by the platform, from unfulfilled; no shipment row.
    const history = await env.DB.prepare(
      `SELECT from_status, to_status, actor_user_id, track FROM order_status_history
       WHERE order_id = ? AND track = 'fulfilment'`,
    )
      .bind(order.orderId)
      .all();
    expect(history.results).toStrictEqual([
      { actor_user_id: platform.userId, from_status: "unfulfilled", to_status: "shipped", track: "fulfilment" },
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM order_shipments WHERE order_id = ?", order.orderId)).toBe(0);

    // The mail itself: "Skickad", and no printer tracking in it.
    const sent = quietEnv();
    expect(await processOutboxRowById(sent.env, mail?.outbox_id ?? "")).toEqual({
      kind: "ran",
      outcome: { kind: "done" },
    });
    expect(sent.emails.sent).toHaveLength(1);
    const rendered = renderAuthEmail(sent.emails.sent[0] as AuthEmailJob);
    expect(rendered.text).toContain("Skickad");
    expect(rendered.text).not.toContain("Spårningsnummer");
    expect(`${rendered.text}${rendered.html}`).not.toContain("RR2SE");

    // Repeats and the seller's own marks never send that mail again.
    expect((await statusOk(job(order.orderId, 2), { carrier: "DPD", state: "shipped", trackingNumber: "RR2SE" })).changed).toBe(false);
    const again = await seller(order.orderId, { to: "shipped" });
    expect(again.status).toBe(409);
    expect((await again.json<{ error: { reason: string } }>()).error.reason).toBe("tracking_required");
    expect(await statusMails(order.orderId)).toBe(1);
    // The order goes on as the seller's: delivered is theirs (a different mail).
    expect((await seller(order.orderId, { to: "delivered" })).status).toBe(200);
    expect(await statusMails(order.orderId)).toBe(2);
  });

  it("from processing too, and two last lines racing still ship the order once", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "shipping", lines: [{}, {}] });
    await accept(order.orderId);
    expect((await seller(order.orderId, { to: "processing" })).status).toBe(200);

    const results = await Promise.all([
      statusOk(job(order.orderId, 1), { state: "shipped" }),
      statusOk(job(order.orderId, 2), { state: "shipped" }),
    ]);

    expect(results.filter((result) => result.orderShipped)).toHaveLength(1);
    expect(await fulfilment(order.orderId)).toBe("shipped");
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM order_status_history
         WHERE order_id = ? AND track = 'fulfilment' AND to_status = 'shipped'`,
        order.orderId,
      ),
    ).toBe(1);
    expect(await statusMails(order.orderId)).toBe(2); // processing + shipped
  });

  it("a line cancelled before the printer took it does not hold the order back", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "shipping", lines: [{}, {}] });
    await accept(order.orderId, [1]);
    await env.DB.prepare("UPDATE order_items SET dispatch_state = 'cancelled' WHERE order_id = ? AND item_index = 1")
      .bind(order.orderId)
      .run();
    expect((await statusOk(job(order.orderId, 1), { state: "shipped" })).orderShipped).toBe(true);
  });

  it("a mixed parcel order waits for the seller: the printer's line lets them ship, ONE mail (theirs)", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "shipping", lines: [{ production: "none" }, {}] });
    await accept(order.orderId);
    expect((await seller(order.orderId, { to: "shipped", trackingNumber: "OWN1" })).status).toBe(409);

    const body = await statusOk(job(order.orderId, 2), { state: "shipped", trackingNumber: "RR5SE" });

    expect(body.orderShipped).toBe(false);
    expect(await fulfilment(order.orderId)).toBe("unfulfilled");
    expect(await statusMails(order.orderId)).toBe(0);
    expect((await seller(order.orderId, { to: "shipped", trackingNumber: "OWN1" })).status).toBe(200);
    expect(await statusMails(order.orderId)).toBe(1);
  });

  it("a pickup order waits for the seller: the print went to the shop, they make it ready (ONE mail)", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "pickup" });
    await accept(order.orderId);
    expect((await seller(order.orderId, { to: "ready_for_pickup" })).status).toBe(409);

    expect((await statusOk(job(order.orderId), { state: "shipped" })).orderShipped).toBe(false);

    expect(await statusMails(order.orderId)).toBe(0);
    expect((await seller(order.orderId, { to: "ready_for_pickup" })).status).toBe(200);
    expect(await statusMails(order.orderId)).toBe(1);
  });

  it("the seller reads one word per line and never the printer's job reference or tracking", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "shipping", lines: [{}, {}] });
    await accept(order.orderId);
    await statusOk(job(order.orderId, 1), { state: "produced" });
    await statusOk(job(order.orderId, 2), {
      carrier: "PRINTER-CARRIER-X",
      state: "shipped",
      trackingNumber: "PRINTER-TRACK-SECRET",
      trackingUrl: "https://track.test/PRINTER-TRACK-SECRET",
    });

    const text = await sellerRead(order.orderId);
    const items = (JSON.parse(text) as { order: { items: Array<{ podState: string }> } }).order.items;
    expect(items.map((item) => item.podState)).toEqual(["in_production", "sent"]);
    for (const secret of ["PRINTER-TRACK-SECRET", "PRINTER-CARRIER-X", "track.test", "SW-0", "SW-1"]) {
      expect(text).not.toContain(secret);
    }
    // Another shop's admin cannot reach the order at all.
    const foreign = await worker.fetch(
      adminRequest(`/v1/admin/orders/${order.orderId}`, "GET", { cookie: otherAdmin.cookie, origin: null, shopId: OTHER }),
      quietEnv().env,
    );
    expect(foreign.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("migration 0051's backstops", () => {
  async function seeded(state: string | null): Promise<string> {
    const order = await seedOrder(TENANT);
    if (state !== null) {
      await env.DB.prepare("UPDATE order_items SET production_state = ? WHERE order_id = ?")
        .bind(state, order.orderId)
        .run();
    }
    return order.orderId;
  }

  it("the state never goes back and is never cleared", async () => {
    const orderId = await seeded("shipped");
    for (const sql of [
      "UPDATE order_items SET production_state = 'produced' WHERE order_id = ?",
      "UPDATE order_items SET production_state = 'in_production' WHERE order_id = ?",
      "UPDATE order_items SET production_state = NULL WHERE order_id = ?",
    ]) {
      await expect(env.DB.prepare(sql).bind(orderId).run()).rejects.toThrow(/only moves forward/);
    }
  });

  it("the tracking is written with 'shipped' only, and never changed after", async () => {
    const produced = await seeded("produced");
    await expect(
      env.DB.prepare("UPDATE order_items SET printer_tracking_number = 'X' WHERE order_id = ?").bind(produced).run(),
    ).rejects.toThrow(/written once/);

    const shipped = await seeded(null);
    await env.DB.prepare(
      "UPDATE order_items SET production_state = 'shipped', printer_tracking_number = 'T1' WHERE order_id = ?",
    )
      .bind(shipped)
      .run();
    for (const sql of [
      "UPDATE order_items SET printer_tracking_number = 'T2' WHERE order_id = ?",
      "UPDATE order_items SET printer_tracking_number = NULL WHERE order_id = ?",
      "UPDATE order_items SET printer_carrier = 'DPD' WHERE order_id = ?",
    ]) {
      await expect(env.DB.prepare(sql).bind(shipped).run()).rejects.toThrow(/written once/);
    }
    await expect(
      env.DB.prepare("UPDATE order_items SET printer_tracking_url = 'http://x.test/a' WHERE order_id = ?")
        .bind(shipped)
        .run(),
    ).rejects.toThrow();
  });
});
