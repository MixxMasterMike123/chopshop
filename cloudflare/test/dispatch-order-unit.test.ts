import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ORDER_SUBMITTING, orderSubmitGuard, PRINTER_HOLD_UNTIL_MS } from "../src/dispatch/dispatch-effect";
import { CANVAS_HOLD_UNTIL_MS } from "../src/dispatch/print-canvas";
import { PRODIGI_FETCH_OVERRIDE } from "../src/dispatch/prodigi-client";
import { processOutboxRowById } from "../src/outbox/effects";
import { claimById, fail, markSubmitting, newClaimToken } from "../src/outbox/outbox";
import { setCommerceCronsLoader } from "../src/outbox/scheduled";
import { runOutboxSweep } from "../src/outbox/sweeper";
import { acquireCanvasJob, completeCanvasJob, releaseSettledCanvasHolds } from "../src/pod/print-canvas-jobs";
import {
  alertsFor,
  type LineSpec,
  lineRow,
  outboxRow,
  printerJobs,
  quietEnv,
  seedOrder,
  seedTenant,
} from "./dispatch-fixtures";

/**
 * CP11 unit U12 (D4) — an ORDER-unit printer (Prodigi) through the real outbox
 * path: the dispatch rows stay one per line, and one Prodigi order carries
 * every dispatchable line of the order.
 *
 * Prodigi is a fake behind PRODIGI_FETCH_OVERRIDE that behaves like the
 * sandbox did on 2026-10-19: an idempotency key it has seen answers 200
 * `AlreadyExists` with the SAME order. Every request is recorded, so "exactly
 * one POST" is counted, not assumed.
 */

const TENANT = "tenant-order-unit";
const KEY_TEE = "GLOBAL-TEE-GIL-64000.black.m";
const KEY_HOOD = "GLOBAL-HOOD-GIL-18500.heather-navy.2xl";
const MIN = 60_000;

const STAGING_PRODIGI: Record<PropertyKey, unknown> = {
  APP_ENV: "staging",
  PRODIGI_API_BASE_URL: "https://api.sandbox.prodigi.com",
  PRODIGI_API_TOKEN: "test_only-not-a-real-prodigi-key-0000",
  PRODIGI_SUBMIT_ENABLED: "true",
};

type Fault = "deliver" | "lose" | "unreachable";

/** A fake Prodigi keyed on idempotencyKey, with a fault per call. */
function prodigiServer(fault: (call: number) => Fault = () => "deliver") {
  const orders = new Map<string, string>();
  const bodies: Array<{ idempotencyKey: string; items: Array<Record<string, unknown>> }> = [];
  let calls = 0;
  const fetcher = async (request: Request): Promise<Response> => {
    calls += 1;
    const which = fault(calls);
    if (which === "unreachable") {
      throw new Error("connection refused");
    }
    const body = (await request.clone().json()) as { idempotencyKey: string; items: Array<Record<string, unknown>> };
    bodies.push(body);
    const existing = orders.get(body.idempotencyKey);
    const id = existing ?? `ord_${1186010 + orders.size}`;
    orders.set(body.idempotencyKey, id);
    if (which === "lose") {
      throw new Error("connection reset");
    }
    return Response.json({ order: { id }, outcome: existing === undefined ? "Created" : "AlreadyExists" }, { status: 200 });
  };
  return { bodies, fetcher, get calls() { return calls; } };
}

function prodigiEnv(fetcher: ((request: Request) => Promise<Response>) | null, overrides: Record<PropertyKey, unknown> = {}) {
  return quietEnv({
    ...STAGING_PRODIGI,
    ...(fetcher === null ? {} : { [PRODIGI_FETCH_OVERRIDE]: fetcher }),
    ...overrides,
  });
}

/** A shipped order routed to the `prodigi` printer, with its frozen recipient. */
async function prodigiOrder(lines: LineSpec[]) {
  const order = await seedOrder(TENANT, {
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
    .bind(order.orderId, TENANT, new Date().toISOString())
    .run();
  return order;
}

const TWO_LINES: LineSpec[] = [{ sku: KEY_TEE }, { printFiles: [{ slot: "front" }, { slot: "back" }], quantity: 2, sku: KEY_HOOD }];

function run(target: Env, outboxId: string, clock?: () => number) {
  return processOutboxRowById(target, outboxId, clock);
}

beforeAll(async () => {
  await seedTenant(TENANT);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM outbox_events").run();
});

afterEach(() => {
  setCommerceCronsLoader(null);
});

// ═══════════════════════════════════════════════════════════════════════════
describe("one Prodigi order per order (D4)", () => {
  it("a two-line order: exactly ONE POST, both lines accepted with the same ord_ reference, the second row without a call", async () => {
    const order = await prodigiOrder(TWO_LINES);
    const [first, second] = order.dispatchIds as [string, string];
    const prodigi = prodigiServer();
    const quiet = prodigiEnv(prodigi.fetcher);

    expect(await run(quiet.env, first)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(1);
    const body = prodigi.bodies[0]!;
    expect(body.idempotencyKey).toBe(order.orderId);
    expect(body.items.map((item) => [item.merchantReference, item.sku, item.copies, item.attributes])).toEqual([
      ["1", "GLOBAL-TEE-GIL-64000", 1, { color: "black", size: "m" }],
      ["2", "GLOBAL-HOOD-GIL-18500", 2, { color: "heather navy", size: "2xl" }],
    ]);
    expect((body.items[1]!.assets as Array<{ printArea: string }>).map((asset) => asset.printArea)).toEqual(["front", "back"]);

    // D4.4: every carried line accepted with the reference, in the row's own batch.
    expect(await lineRow(order.orderId, 1)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: "ord_1186010" });
    expect(await lineRow(order.orderId, 2)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: "ord_1186010" });
    expect(await outboxRow(first)).toMatchObject({ result_ref: "ord_1186010", status: "done" });
    // The sibling is woken (due now) and nudged, to adopt it.
    expect((await outboxRow(second)).next_attempt_at).toBeLessThanOrEqual(Date.now());
    expect(quiet.nudges.sent).toContainEqual({ outboxId: second });

    // D4.2: the second row adopts — done as a duplicate, no HTTP call.
    expect(await run(quiet.env, second)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(1);
    expect(await outboxRow(second)).toMatchObject({ result_ref: "ord_1186010", status: "done", submitted_at: null });
    expect(await printerJobs(order.orderId)).toHaveLength(0); // the staging fake saw nothing
    expect(await alertsFor(first)).toHaveLength(0);
  });

  it("whichever row runs first speaks for the order (the second line's row first)", async () => {
    const order = await prodigiOrder(TWO_LINES);
    const [first, second] = order.dispatchIds as [string, string];
    const prodigi = prodigiServer();
    const target = prodigiEnv(prodigi.fetcher).env;

    await run(target, second);
    await run(target, first);
    expect(prodigi.calls).toBe(1);
    expect(prodigi.bodies[0]!.items.map((item) => item.merchantReference)).toEqual(["1", "2"]);
    expect(await outboxRow(first)).toMatchObject({ result_ref: "ord_1186010", status: "done" });
  });

  it("AlreadyExists adopts the reference: a lost answer, then the sibling's call settles both", async () => {
    const order = await prodigiOrder(TWO_LINES);
    const [first, second] = order.dispatchIds as [string, string];
    // Call 1 reaches Prodigi and the answer is lost; call 2 meets AlreadyExists.
    const prodigi = prodigiServer((call) => (call === 1 ? "lose" : "deliver"));
    const target = prodigiEnv(prodigi.fetcher).env;

    expect(await run(target, first)).toMatchObject({ outcome: { kind: "unknown" } });
    expect((await lineRow(order.orderId, 1)).dispatch_state).toBe("unknown");

    // The sibling row is not blocked by an UNKNOWN row (only by a submitting one).
    expect(await run(target, second)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(2);
    expect(prodigi.bodies.map((body) => body.idempotencyKey)).toEqual([order.orderId, order.orderId]);
    expect(await outboxRow(second)).toMatchObject({ result_ref: "ord_1186010", status: "done" });
    expect(await lineRow(order.orderId, 1)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: "ord_1186010" });
    expect(await lineRow(order.orderId, 2)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: "ord_1186010" });

    // The unknown row, due again (woken by the sibling), adopts without a call.
    expect(await run(target, first, () => Date.now() + 2 * MIN)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(2);
    expect(await outboxRow(first)).toMatchObject({ result_ref: "ord_1186010", status: "done" });
  });

  it("a cancelled or failed sibling is left out of the body", async () => {
    const order = await prodigiOrder([{ sku: KEY_TEE }, { sku: KEY_HOOD }, { sku: KEY_TEE }]);
    const [first, second, third] = order.dispatchIds as [string, string, string];
    // The third row failed (pending → claimed → failed, along the outbox's machine).
    const claimedBy = newClaimToken();
    await claimById(env.DB, { claimedBy, now: Date.now(), outboxId: third });
    await fail(env.DB, { claimedBy, outboxId: third }, { backoffMs: 0, error: "rejected_x", now: Date.now(), terminal: true });
    await env.DB.batch([
      env.DB.prepare("UPDATE outbox_events SET status = 'superseded', resolved_at = 1, last_error = 'cancelled' WHERE outbox_id = ?").bind(second),
      env.DB.prepare("UPDATE order_items SET dispatch_state = 'cancelled' WHERE order_id = ? AND item_index = 1").bind(order.orderId),
      env.DB.prepare("UPDATE order_items SET dispatch_state = 'failed' WHERE order_id = ? AND item_index = 2").bind(order.orderId),
    ]);
    const prodigi = prodigiServer();

    expect(await run(prodigiEnv(prodigi.fetcher).env, first)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.bodies[0]!.items.map((item) => item.merchantReference)).toEqual(["1"]);
    // The left-out lines keep their states; the reference is not written on them.
    expect(await lineRow(order.orderId, 2)).toMatchObject({ dispatch_state: "cancelled", printer_job_ref: null });
    expect(await lineRow(order.orderId, 3)).toMatchObject({ dispatch_state: "failed", printer_job_ref: null });
  });

  it("a sibling accepted WITHOUT a reference (placed by hand) is left out of the body and untouched by the accepting batch", async () => {
    const order = await prodigiOrder([{ sku: KEY_TEE }, { sku: KEY_HOOD }]);
    const [first] = order.dispatchIds as [string, string];
    // A human resolved line 2 as accepted with no printer reference (resolution.ts).
    await env.DB.prepare(
      "UPDATE order_items SET dispatch_state = 'accepted', dispatched_at = '2026-10-19T12:00:00.000Z' WHERE order_id = ? AND item_index = 1",
    )
      .bind(order.orderId)
      .run();
    const prodigi = prodigiServer();

    expect(await run(prodigiEnv(prodigi.fetcher).env, first)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(1);
    expect(prodigi.bodies[0]!.items.map((item) => item.merchantReference)).toEqual(["1"]);
    expect(await lineRow(order.orderId, 1)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: "ord_1186010" });
    expect(await lineRow(order.orderId, 2)).toMatchObject({
      dispatch_state: "accepted",
      dispatched_at: "2026-10-19T12:00:00.000Z",
      printer_job_ref: null,
    });
  });

  it("Codex P1: a sibling accepted with a reference set BY HAND (no done row) is neither adopted nor carried", async () => {
    const order = await prodigiOrder([{ sku: KEY_TEE }, { sku: KEY_HOOD }]);
    const [first, second] = order.dispatchIds as [string, string];
    // A human placed line 2 by hand and recorded a reference on the LINE.
    await env.DB.prepare(
      "UPDATE order_items SET dispatch_state = 'accepted', printer_job_ref = 'hand-placed-2' WHERE order_id = ? AND item_index = 1",
    )
      .bind(order.orderId)
      .run();
    // Its row was resolved by hand without a submission (failed → done).
    const claimedBy = newClaimToken();
    await claimById(env.DB, { claimedBy, now: Date.now(), outboxId: second });
    await fail(env.DB, { claimedBy, outboxId: second }, { backoffMs: 0, error: "x", now: Date.now(), terminal: true });
    await env.DB.prepare("UPDATE outbox_events SET status = 'done', result_ref = 'hand-placed-2' WHERE outbox_id = ?")
      .bind(second)
      .run();
    const prodigi = prodigiServer();

    expect(await run(prodigiEnv(prodigi.fetcher).env, first)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(1);
    expect(prodigi.bodies[0]!.items.map((item) => item.merchantReference)).toEqual(["1"]);
    expect(await outboxRow(first)).toMatchObject({ result_ref: "ord_1186010", status: "done" });
    expect(await lineRow(order.orderId, 1)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: "ord_1186010" });
    expect(await lineRow(order.orderId, 2)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: "hand-placed-2" });
  });

  it("Codex P2: A's answer lost, then B's REFUSAL is held unknown (A may hold B's line), never failed", async () => {
    const order = await prodigiOrder(TWO_LINES);
    const [first, second] = order.dispatchIds as [string, string];
    let call = 0;
    const fetcher = async (): Promise<Response> => {
      call += 1;
      if (call === 1) {
        throw new Error("connection reset");
      }
      return Response.json({ failures: { "items[1].sku": [] }, outcome: "ValidationFailed" }, { status: 400 });
    };
    const target = prodigiEnv(fetcher).env;

    expect(await run(target, first)).toMatchObject({ outcome: { kind: "unknown" } });
    expect(await outboxRow(second)).toMatchObject({ unknown_since: null });
    expect(await run(target, second)).toMatchObject({ outcome: { kind: "unknown" } });
    expect(await outboxRow(second)).toMatchObject({
      last_error: "unknown_rejected_after_unknown_items_1_.sku",
      status: "unknown",
    });
    expect((await lineRow(order.orderId, 2)).dispatch_state).toBe("unknown");
    expect((await alertsFor(second)).map((alert) => alert.kind)).not.toContain("dispatch_failed");
  });

  it("Codex P2: with no lost answer anywhere in the order, a refusal fails as before", async () => {
    const order = await prodigiOrder(TWO_LINES);
    const [first] = order.dispatchIds as [string, string];
    const fetcher = async () =>
      Response.json({ failures: { "items[0].sku": [] }, outcome: "ValidationFailed" }, { status: 400 });
    await run(prodigiEnv(fetcher).env, first);
    expect(await outboxRow(first)).toMatchObject({ last_error: "rejected_items_0_.sku", status: "failed" });
  });

  it("Codex round 2: both sibling submissions explicitly REJECTED → both rows failed with their alerts, nothing held unknown", async () => {
    const order = await prodigiOrder(TWO_LINES);
    const [first, second] = order.dispatchIds as [string, string];
    const fetcher = async () =>
      Response.json({ failures: { "recipient.name": [] }, outcome: "ValidationFailed" }, { status: 400 });
    const target = prodigiEnv(fetcher).env;

    expect(await run(target, first)).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    expect(await run(target, second)).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    for (const [id, lineNo] of [[first, 1], [second, 2]] as const) {
      expect(await outboxRow(id)).toMatchObject({ last_error: "rejected_recipient.name", status: "failed", unknown_since: null });
      expect((await lineRow(order.orderId, lineNo)).dispatch_state).toBe("failed");
      expect((await alertsFor(id)).map((alert) => alert.kind)).toEqual(["dispatch_failed"]);
    }
  });

  it("Codex P3: an invalid SKU key fails ITS line; the good line waits, then goes alone", async () => {
    const order = await prodigiOrder([{ sku: KEY_TEE }, { sku: "GLOBAL-HOOD-GIL-18500" }]);
    const [first, second] = order.dispatchIds as [string, string];
    const prodigi = prodigiServer();
    const target = prodigiEnv(prodigi.fetcher).env;

    expect(await run(target, first)).toMatchObject({ outcome: { kind: "retry" } });
    expect(await outboxRow(first)).toMatchObject({ last_error: "sibling_sku_invalid", status: "pending" });
    expect(await run(target, second)).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    expect(await outboxRow(second)).toMatchObject({ last_error: "sku_invalid", status: "failed" });
    expect((await alertsFor(second)).map((alert) => alert.kind)).toEqual(["dispatch_failed"]);
    expect(prodigi.calls).toBe(0);

    expect(await run(target, first, () => Date.now() + 2 * MIN)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(1);
    expect(prodigi.bodies[0]!.items.map((item) => item.merchantReference)).toEqual(["1"]);
  });

  it("a sibling's bad data never fails this row: it waits, the sibling's own row fails, then the good line goes alone", async () => {
    const order = await prodigiOrder([{ sku: KEY_TEE }, { printFiles: [{ slot: "sleeve" }], sku: KEY_HOOD }]);
    const [first, second] = order.dispatchIds as [string, string];
    const prodigi = prodigiServer();
    const target = prodigiEnv(prodigi.fetcher).env;

    expect(await run(target, first)).toMatchObject({ outcome: { kind: "retry" } });
    expect(await outboxRow(first)).toMatchObject({ last_error: "sibling_print_slot_unsupported", status: "pending" });
    expect((await lineRow(order.orderId, 1)).dispatch_state).toBeNull();

    expect(await run(target, second)).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    expect(await outboxRow(second)).toMatchObject({ last_error: "print_slot_unsupported", status: "failed" });

    expect(await run(target, first, () => Date.now() + 2 * MIN)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(1);
    expect(prodigi.bodies[0]!.items.map((item) => item.merchantReference)).toEqual(["1"]);
    expect((await lineRow(order.orderId, 2)).dispatch_state).toBe("failed");
  });

  it("a line whose SKU key does not split fails with its alert, never sent", async () => {
    const order = await prodigiOrder([{ sku: "2700003" }]);
    const prodigi = prodigiServer();
    await run(prodigiEnv(prodigi.fetcher).env, order.dispatchIds[0]!);
    expect(prodigi.calls).toBe(0);
    // Codex round 1, P3: judged in preparation, on the line itself.
    expect(await outboxRow(order.dispatchIds[0]!)).toMatchObject({ last_error: "sku_invalid", status: "failed" });
    expect((await alertsFor(order.dispatchIds[0]!)).map((alert) => alert.kind)).toEqual(["dispatch_failed"]);
  });

  it("a collected order is refused ship_to_missing, Prodigi never called", async () => {
    const order = await seedOrder(TENANT, { lines: [{ sku: KEY_TEE }], printer: "prodigi", printerProvider: "prodigi" });
    const prodigi = prodigiServer();
    await run(prodigiEnv(prodigi.fetcher).env, order.dispatchIds[0]!);
    expect(prodigi.calls).toBe(0);
    expect(await outboxRow(order.dispatchIds[0]!)).toMatchObject({ last_error: "rejected_ship_to_missing", status: "failed" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("never two calls at once (D4.3)", () => {
  it("the SQL guard: two rows claimed, one proceeds to submitting, the other is refused", async () => {
    const order = await prodigiOrder(TWO_LINES);
    const [first, second] = order.dispatchIds as [string, string];
    const now = Date.now();
    const claims = [];
    for (const outboxId of [first, second]) {
      const claimedBy = newClaimToken();
      expect(await claimById(env.DB, { claimedBy, now, outboxId })).not.toBeNull();
      claims.push({ claimedBy, outboxId });
    }
    const [a, b] = claims as [(typeof claims)[0], (typeof claims)[0]];
    const guard = (outboxId: string) => orderSubmitGuard(TENANT, order.orderId, outboxId);

    expect(await markSubmitting(env.DB, a, { guard: guard(first), now })).toMatchObject({ status: "submitting" });
    expect(await markSubmitting(env.DB, b, { guard: guard(second), now })).toBeNull();
    expect(await outboxRow(second)).toMatchObject({ status: "claimed" });
  });

  it("the guard also refuses once another row of the order holds the printer order (done, after a submission)", async () => {
    const order = await prodigiOrder(TWO_LINES);
    const [first, second] = order.dispatchIds as [string, string];
    const now = Date.now();
    const guard = orderSubmitGuard(TENANT, order.orderId, first);
    const claimedBy = newClaimToken();
    await claimById(env.DB, { claimedBy, now, outboxId: first });

    // Codex round 1, P1: a reference typed on a LINE by hand does not block.
    await env.DB.prepare(
      "UPDATE order_items SET dispatch_state = 'accepted', printer_job_ref = 'hand-77' WHERE order_id = ? AND item_index = 1",
    )
      .bind(order.orderId)
      .run();
    const free = await env.DB.prepare(`SELECT 1 AS ok WHERE ${guard.sql}`).bind(...guard.binds).first();
    expect(free).not.toBeNull();

    // The sibling row submitted the order and is done with its reference: blocked.
    const siblingClaim = newClaimToken();
    await claimById(env.DB, { claimedBy: siblingClaim, now, outboxId: second });
    await markSubmitting(env.DB, { claimedBy: siblingClaim, outboxId: second }, { now });
    await env.DB.prepare(
      "UPDATE outbox_events SET status = 'done', resolved_at = 1, result_ref = 'ord_77', claimed_by = NULL, claim_expires_at = NULL WHERE outbox_id = ?",
    )
      .bind(second)
      .run();
    expect(await markSubmitting(env.DB, { claimedBy, outboxId: first }, { guard, now })).toBeNull();
  });

  it("through the dispatcher: a sibling at the printer makes this row wait, without a call; then it adopts", async () => {
    const order = await prodigiOrder(TWO_LINES);
    const [first, second] = order.dispatchIds as [string, string];
    const claimedBy = newClaimToken();
    await claimById(env.DB, { claimedBy, now: Date.now(), outboxId: second });
    await markSubmitting(env.DB, { claimedBy, outboxId: second }, { now: Date.now() });
    const prodigi = prodigiServer();
    const target = prodigiEnv(prodigi.fetcher).env;

    expect(await run(target, first)).toMatchObject({ outcome: { kind: "retry" } });
    expect(await outboxRow(first)).toMatchObject({ last_error: ORDER_SUBMITTING, status: "pending" });
    expect(prodigi.calls).toBe(0);

    // The sibling's call came back accepted (recorded as its batch would).
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE order_items SET dispatch_state = 'accepted', printer_job_ref = 'ord_5' WHERE order_id = ?",
      ).bind(order.orderId),
      env.DB.prepare(
        "UPDATE outbox_events SET status = 'done', resolved_at = 1, result_ref = 'ord_5', claimed_by = NULL, claim_expires_at = NULL WHERE outbox_id = ?",
      ).bind(second),
    ]);
    expect(await run(target, first, () => Date.now() + 2 * MIN)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(0);
    expect(await outboxRow(first)).toMatchObject({ result_ref: "ord_5", status: "done" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a sibling's canvas holds the row (D4.1, CP6-PS2's park on the order)", () => {
  const CANVAS = { frameMm: { h: 490, w: 390 }, frameProvisional: false, sourcePx: { h: 4_134, w: 2_953 } };

  async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /** The container's part for ONE queued canvas job (bytes stand in for pixels). */
  async function renderOne(target: Env): Promise<boolean> {
    const lease = await acquireCanvasJob(target, env.DB, Date.now());
    if (lease === null) {
      return false;
    }
    const bytes = new TextEncoder().encode(`canvas png of ${lease.jobId}`);
    const key = `${lease.outputPrefix}canvas.png`;
    await env.PRIVATE_BUCKET.put(key, bytes);
    expect(
      await completeCanvasJob(
        target,
        env.DB,
        lease.jobId,
        {
          attempt: lease.attempt,
          leaseToken: lease.leaseToken,
          ok: true,
          outputs: { canvasPng: { bytes: bytes.length, key, sha256: await sha256Hex(bytes) } },
        },
        Date.now(),
      ),
    ).toEqual({ status: "completed" });
    return true;
  }

  it("parks on ANY line's pending canvas; the backstop does not wake it early; the last canvas wakes it; one POST with the canvases", async () => {
    const order = await prodigiOrder([
      { printFiles: [{ canvas: CANVAS, slot: "front" }], sku: KEY_TEE },
      { printFiles: [{ canvas: CANVAS, slot: "front" }], sku: KEY_HOOD },
    ]);
    const [first, second] = order.dispatchIds as [string, string];
    const prodigi = prodigiServer();
    const quiet = prodigiEnv(prodigi.fetcher, { PRINT_CANVAS_ENABLED: "true" });

    // Row 1 ensures the canvases of BOTH lines and parks on the order.
    expect(await run(quiet.env, first)).toMatchObject({ outcome: { kind: "retry" } });
    expect(await outboxRow(first)).toMatchObject({ next_attempt_at: CANVAS_HOLD_UNTIL_MS, status: "pending" });
    const jobs = await env.DB.prepare("SELECT line_no, state FROM print_canvas_jobs WHERE order_id = ? ORDER BY line_no")
      .bind(order.orderId)
      .all<{ line_no: number; state: string }>();
    expect(jobs.results).toEqual([
      { line_no: 1, state: "queued" },
      { line_no: 2, state: "queued" },
    ]);
    expect(prodigi.calls).toBe(0);

    // Line 1's canvas is made; line 2's still pending. Line 1's settling may
    // wake its own row once (the line release); run, it parks again on the
    // order, with no call.
    expect(await renderOne(quiet.env)).toBe(true);
    if ((await outboxRow(first)).next_attempt_at !== CANVAS_HOLD_UNTIL_MS) {
      expect(await run(quiet.env, first)).toMatchObject({ outcome: { kind: "retry" } });
    }
    expect(await outboxRow(first)).toMatchObject({ next_attempt_at: CANVAS_HOLD_UNTIL_MS, status: "pending" });
    expect(prodigi.calls).toBe(0);
    // The order-wide backstop leaves it parked while line 2 pends (a line-wide
    // one would wake it every sweep, each wake a claim, each claim an attempt).
    expect(await releaseSettledCanvasHolds(env.DB, Date.now(), 100)).not.toContain(first);

    // The last canvas of the order: its settling batch wakes the order's parked row.
    expect(await renderOne(quiet.env)).toBe(true);
    expect((await outboxRow(first)).next_attempt_at).toBeLessThan(CANVAS_HOLD_UNTIL_MS);

    expect(await run(quiet.env, first)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(1);
    const urls = prodigi.bodies[0]!.items.map((item) =>
      decodeURIComponent(new URL((item.assets as Array<{ url: string }>)[0]!.url).pathname),
    );
    expect(urls.every((path) => path.endsWith("-front.png") && path.includes(`/print/orders/${order.orderId}/`))).toBe(true);
    expect(await run(quiet.env, second)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(prodigi.calls).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("holding per provider (D1/D2)", () => {
  it("no Prodigi client parks the job; the sweeper releases it only when PRODIGI resolves, never for another provider", async () => {
    setCommerceCronsLoader(() => Promise.resolve(null));
    const prodigiHeld = await prodigiOrder([{ sku: KEY_TEE }]);
    const fakeHeld = await seedOrder(TENANT, { lines: [{}] });
    const off = prodigiEnv(null, { FAKE_PRINTER_TOKEN: undefined, PRODIGI_SUBMIT_ENABLED: undefined }).env;
    for (const id of [prodigiHeld.dispatchIds[0]!, fakeHeld.dispatchIds[0]!]) {
      expect(await run(off, id)).toMatchObject({ outcome: { kind: "retry" } });
      expect(await outboxRow(id)).toMatchObject({ last_error: "printer_not_configured", next_attempt_at: PRINTER_HOLD_UNTIL_MS });
    }

    // Prodigi on, the fake still off: only the Prodigi order is released and sent.
    const prodigi = prodigiServer();
    const summary = await runOutboxSweep(
      prodigiEnv(prodigi.fetcher, { FAKE_PRINTER_TOKEN: undefined }).env,
      Date.now() + 60 * MIN,
    );
    expect(summary.printerReleased).toBe(1);
    expect(prodigi.calls).toBe(1);
    expect(await outboxRow(prodigiHeld.dispatchIds[0]!)).toMatchObject({ attempts: 2, status: "done" });
    expect(await outboxRow(fakeHeld.dispatchIds[0]!)).toMatchObject({
      attempts: 1,
      next_attempt_at: PRINTER_HOLD_UNTIL_MS,
      status: "pending",
    });
  });

  it("a printer re-pointed at another provider after the sale is refused, never sent (printer_mismatch)", async () => {
    const order = await seedOrder(TENANT, {
      deliveryMethod: "shipping",
      lines: [{ sku: KEY_TEE }],
      printer: "prodigi",
      printerProvider: "prodigi",
      snapshotProvider: "fake",
    });
    const prodigi = prodigiServer();
    await run(prodigiEnv(prodigi.fetcher).env, order.dispatchIds[0]!);
    expect(prodigi.calls).toBe(0);
    expect(await outboxRow(order.dispatchIds[0]!)).toMatchObject({ last_error: "printer_mismatch", status: "failed" });
  });
});
