import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { DISPATCH_PRINT_URL_TTL_SECONDS } from "../src/dispatch/dispatch-effect";
import { FAKE_PRINTER_FETCH_OVERRIDE } from "../src/dispatch/printer-client";
import { printerJobId } from "../src/dispatch/snapwear-wire";
import { handleFakePrinterRoute } from "../src/routes/fake-printer";
import { R2_PRESIGNER_OVERRIDE } from "../src/pod/render-farm-client";
import { processOutboxRowById } from "../src/outbox/effects";
import { nudgeOutbox } from "../src/outbox/nudge";
import {
  CLAIM_TTL_MS,
  claimById,
  markSubmitting,
  newClaimToken,
  outboxRetryDelayMs,
} from "../src/outbox/outbox";
import { OUTBOX_SWEEP_CRON, setCommerceCronsLoader } from "../src/outbox/scheduled";
import { runOutboxSweep, UNKNOWN_ALERT_AFTER_MS } from "../src/outbox/sweeper";
import {
  alertsFor,
  envWith,
  grantAccess,
  grantMembership,
  lineRow,
  outboxRow,
  printerJobs,
  quietEnv,
  seedOrder,
  seedTenant,
  sessionRequest,
  signUp,
  type SignedUpUser,
} from "./dispatch-fixtures";

/**
 * The dispatch effect against the staging fake printer (PLAN §2.3), with the
 * CP2 failure injections that concern dispatch, the four cancellation paths,
 * and the platform's manual resolution of lost printer answers.
 *
 * "One accepted printer job per eligible order, zero for pre-dispatch
 * cancellations" is asserted against `fake_printer_jobs`, the fake's own record
 * of every submission it accepted.
 */

const TENANT_A = "tenant-dispatch-a";
const TENANT_B = "tenant-dispatch-b";
const ADMIN_HOST = "https://admin.dispatch.test";
const PLATFORM_HOST = "https://platform.dispatch.test";

let adminA: SignedUpUser;
let adminB: SignedUpUser;
let platform: SignedUpUser;

beforeAll(async () => {
  await seedTenant(TENANT_A);
  await seedTenant(TENANT_B);
  adminA = await signUp("admin-a@dispatch.test");
  adminB = await signUp("admin-b@dispatch.test");
  platform = await signUp("platform@dispatch.test");
  await grantAccess(adminA.userId, "tenant_admin");
  await grantAccess(adminB.userId, "tenant_admin");
  await grantAccess(platform.userId, "platform_admin");
  await grantMembership(adminA.userId, TENANT_A);
  await grantMembership(adminB.userId, TENANT_B);
});

beforeEach(async () => {
  // Sweeps claim the oldest due row of ANY order; start each test clean.
  await env.DB.prepare("DELETE FROM outbox_events").run();
});

afterEach(() => {
  setCommerceCronsLoader(null);
  vi.restoreAllMocks();
});

function dispatch(targetEnv: Env, outboxId: string, clock?: () => number) {
  return processOutboxRowById(targetEnv, outboxId, clock);
}

function later(ms: number): () => number {
  return () => Date.now() + ms;
}

async function cancel(
  orderId: string,
  options: {
    body?: unknown;
    cookie?: string;
    origin?: string | null;
    shopId?: string | null;
    targetEnv?: Env;
  } = {},
): Promise<Response> {
  return worker.fetch(
    sessionRequest(`${ADMIN_HOST}/v1/admin/orders/${orderId}/cancel`, "POST", {
      body: options.body ?? { reason: "Kunden ångrade sig" },
      cookie: options.cookie ?? adminA.cookie,
      origin: options.origin,
      shopId: options.shopId === undefined ? TENANT_A : options.shopId,
    }),
    options.targetEnv ?? quietEnv().env,
  );
}

async function resolve(
  outboxId: string,
  body: unknown,
  options: { cookie?: string; origin?: string | null; targetEnv?: Env } = {},
): Promise<Response> {
  return worker.fetch(
    sessionRequest(`${PLATFORM_HOST}/v1/platform/dispatch/${outboxId}/resolve`, "POST", {
      body,
      cookie: options.cookie ?? platform.cookie,
      origin: options.origin,
    }),
    options.targetEnv ?? quietEnv().env,
  );
}

/** A fake-printer transport that delivers the request and then loses the answer. */
function losingTransport(onDelivered?: () => Promise<void>) {
  return async (request: Request): Promise<Response> => {
    await handleFakePrinterRoute(env as unknown as Env, request);
    await onDelivered?.();
    throw new Error("connection reset");
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("dispatch: one order line → one printer job", () => {
  it("submits the frozen line with the stable job id and records the printer's id", async () => {
    const order = await seedOrder(TENANT_A, { lines: [{ quantity: 2 }] });
    const dispatchId = order.dispatchIds[0] as string;

    const result = await dispatch(quietEnv().env, dispatchId);

    expect(result).toEqual({ kind: "ran", outcome: { kind: "done" } });
    const jobs = await printerJobs(order.orderId);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.job_id).toBe(printerJobId(order.orderId, 1));
    const payload = JSON.parse(job.payload_json) as {
      artworks: Array<{ url: string }>;
      items: Array<{ quantity: number; sku: string }>;
      layouts: Array<{ location: string }>;
    };
    expect(payload.items).toEqual([{ quantity: 2, sku: expect.any(String) }]);
    expect(payload.layouts).toEqual([{ location: "front" }]);
    const url = new URL(payload.artworks[0]!.url);
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toContain(`/pod/${TENANT_A}/print/`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(DISPATCH_PRINT_URL_TTL_SECONDS));

    expect(await outboxRow(dispatchId)).toMatchObject({ result_ref: job.id, status: "done" });
    const line = await lineRow(order.orderId);
    expect(line).toMatchObject({ dispatch_state: "accepted", printer_job_ref: job.id });
    expect(line.dispatched_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("sends front before back for a two-sided print", async () => {
    const order = await seedOrder(TENANT_A, {
      lines: [{ printFiles: [{ slot: "back" }, { slot: "front" }] }],
    });

    await dispatch(quietEnv().env, order.dispatchIds[0]!);

    const payload = JSON.parse((await printerJobs(order.orderId))[0]!.payload_json) as {
      artworks: Array<{ url: string }>;
      layouts: Array<{ location: string }>;
    };
    expect(payload.layouts).toEqual([{ location: "front" }, { location: "back" }]);
    expect(payload.artworks[0]!.url).toContain("-front.png");
    expect(payload.artworks[1]!.url).toContain("-back.png");
  });

  it("dispatches each POD line of an order separately, never a non-POD line", async () => {
    const order = await seedOrder(TENANT_A, {
      lines: [{}, { production: "none" }, {}],
    });
    expect(order.dispatchIds).toHaveLength(2);

    for (const id of order.dispatchIds) {
      await dispatch(quietEnv().env, id);
    }

    expect((await printerJobs(order.orderId)).map((job) => job.job_id).sort()).toEqual(
      [printerJobId(order.orderId, 1), printerJobId(order.orderId, 3)].sort(),
    );
    expect((await lineRow(order.orderId, 2)).dispatch_state).toBeNull();
  });

  it("runs end to end from the cron: every line dispatched, the confirmation queued", async () => {
    const order = await seedOrder(TENANT_A, { lines: [{}, {}] });
    const { emails, env: quiet } = quietEnv();
    // CP2-A's money crons run after the sweep; they are theirs to test.
    setCommerceCronsLoader(() => Promise.resolve(null));

    await worker.scheduled(
      { cron: OUTBOX_SWEEP_CRON, noRetry: () => undefined, scheduledTime: Date.now() } as ScheduledController,
      quiet,
    );

    expect(await printerJobs(order.orderId)).toHaveLength(2);
    expect((await outboxRow(order.emailId)).status).toBe("done");
    expect(emails.sent).toHaveLength(1);
  });

  it("runs end to end from a real queue nudge", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;

    // The pool delivers chopshop-test-outbox to the Worker's queue() export.
    await nudgeOutbox(env as unknown as Env, [dispatchId]);

    const deadline = Date.now() + 10_000;
    while ((await outboxRow(dispatchId)).status !== "done" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await outboxRow(dispatchId)).status).toBe("done");
    expect(await printerJobs(order.orderId)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("dispatch: what is refused before any printer call", () => {
  const CASES: Array<[string, Parameters<typeof seedOrder>[1], string]> = [
    ["an order routed to another printer", { printer: "snapwear" }, "printer_mismatch"],
    ["an order without a production snapshot", { printer: null }, "production_snapshot_missing"],
    ["a slot SnapWear cannot print", { lines: [{ printFiles: [{ slot: "sleeve" }] }] }, "print_slot_unsupported"],
    [
      "a print file outside the tenant's keys",
      { lines: [{ printFiles: [{ r2Key: `pod/${TENANT_B}/print/stolen.png`, slot: "front" }] }] },
      "production_line_invalid",
    ],
    ["a missing print file", { lines: [{ printFiles: [{ present: false, slot: "front" }] }] }, "print_file_missing"],
    [
      "a print file whose bytes are not the snapshot's",
      { lines: [{ printFiles: [{ sha256: "b".repeat(64), slot: "front" }] }] },
      "print_file_mismatch",
    ],
    [
      "a print file stored without a checksum",
      { lines: [{ printFiles: [{ slot: "front", unverified: true }] }] },
      "print_file_unverified",
    ],
  ];

  for (const [label, options, code] of CASES) {
    it(`fails ${label} at once, with an alert and no printer job`, async () => {
      const order = await seedOrder(TENANT_A, options);
      const dispatchId = order.dispatchIds[0]!;

      const result = await dispatch(quietEnv().env, dispatchId);

      expect(result).toEqual({ kind: "ran", outcome: { kind: "failed" } });
      expect(await outboxRow(dispatchId)).toMatchObject({ last_error: code, status: "failed", submitted_at: null });
      expect((await lineRow(order.orderId)).dispatch_state).toBe("failed");
      expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).toEqual(["dispatch_failed"]);
      expect(await printerJobs(order.orderId)).toHaveLength(0);
    });
  }

  it("fails a printer rejection (422) with an alert", async () => {
    const order = await seedOrder(TENANT_A, { lines: [{ sku: "not-a-snapwear-sku" }] });
    const dispatchId = order.dispatchIds[0]!;

    await dispatch(quietEnv().env, dispatchId);

    expect(await outboxRow(dispatchId)).toMatchObject({
      last_error: "rejected_validation_failed",
      status: "failed",
    });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("failed");
    expect((await alertsFor(dispatchId))[0]?.kind).toBe("dispatch_failed");
    expect(await printerJobs(order.orderId)).toHaveLength(0);
  });

  it("the SnapWear stub (A6 unbuilt) never pretends to submit: retried, the line back to pending", async () => {
    const order = await seedOrder(TENANT_A, { printer: "snapwear" });
    const dispatchId = order.dispatchIds[0]!;

    const result = await dispatch(quietEnv({ DISPATCH_TARGET: "snapwear" }).env, dispatchId);

    expect(result).toMatchObject({ kind: "ran", outcome: { kind: "retry" } });
    expect(await outboxRow(dispatchId)).toMatchObject({
      last_error: "printer_client_error",
      status: "pending",
    });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("pending");
    expect(await printerJobs(order.orderId)).toHaveLength(0);
  });

  it("holds (retries with backoff) when this environment has no usable printer", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;

    const result = await dispatch(quietEnv({ DISPATCH_TARGET: undefined }).env, dispatchId);

    expect(result).toMatchObject({ kind: "ran", outcome: { kind: "retry" } });
    expect(await outboxRow(dispatchId)).toMatchObject({
      attempts: 1,
      last_error: "printer_not_configured",
      status: "pending",
      submitted_at: null,
    });
    expect(await alertsFor(dispatchId)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("failure injection", () => {
  it("duplicate delivery: two consumers racing on one row submit ONE job", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;

    const results = await Promise.all([
      dispatch(quietEnv().env, dispatchId),
      dispatch(quietEnv().env, dispatchId),
      dispatch(quietEnv().env, dispatchId),
    ]);

    expect(results.filter((result) => result.kind === "ran")).toHaveLength(1);
    expect(await printerJobs(order.orderId)).toHaveLength(1);
    expect((await outboxRow(dispatchId)).status).toBe("done");
  });

  it("lost printer response → unknown → the same job id re-submitted → duplicate 400 → done, one job", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;

    const first = await dispatch(
      quietEnv({ [FAKE_PRINTER_FETCH_OVERRIDE]: losingTransport() }).env,
      dispatchId,
    );

    expect(first).toEqual({
      kind: "ran",
      outcome: { delayMs: outboxRetryDelayMs(1), kind: "unknown" },
    });
    expect(await outboxRow(dispatchId)).toMatchObject({
      last_error: "unknown_network",
      status: "unknown",
    });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("unknown");
    expect(await printerJobs(order.orderId)).toHaveLength(1);

    // Not before the backoff…
    expect(await dispatch(quietEnv().env, dispatchId)).toMatchObject({ kind: "later" });
    // …then the re-submit: the fake answers 400 duplicate, which is "accepted".
    const second = await dispatch(quietEnv().env, dispatchId, later(outboxRetryDelayMs(1) + 1_000));

    expect(second).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(await outboxRow(dispatchId)).toMatchObject({ attempts: 2, result_ref: null, status: "done" });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("accepted");
    expect(await printerJobs(order.orderId)).toHaveLength(1);
  });

  it("crash after the printer accepted, before the local commit → re-claimed after the claim expires → duplicate → done, one job", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;
    let crashed = false;
    const dyingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch" && crashed) {
          return () => Promise.reject(new Error("worker died"));
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const crashingEnv = quietEnv({
      DB: dyingDb,
      [FAKE_PRINTER_FETCH_OVERRIDE]: async (request: Request) => {
        const response = await handleFakePrinterRoute(env as unknown as Env, request);
        crashed = true;
        return response;
      },
    }).env;

    await expect(dispatch(crashingEnv, dispatchId)).rejects.toThrow("worker died");
    expect(await outboxRow(dispatchId)).toMatchObject({ status: "submitting" });
    expect(await printerJobs(order.orderId)).toHaveLength(1);

    // The sweeper re-claims the expired claim and re-submits the same id.
    const summary = await runOutboxSweep(quietEnv().env, Date.now() + CLAIM_TTL_MS + 1_000);

    expect(summary.processed).toBeGreaterThanOrEqual(1);
    expect(await outboxRow(dispatchId)).toMatchObject({ attempts: 2, status: "done" });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("accepted");
    expect(await printerJobs(order.orderId)).toHaveLength(1);
  });

  it("a stale worker's late result cannot overwrite the row a newer claim completed", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;
    const now = Date.now();
    const stale = { claimedBy: newClaimToken(), outboxId: dispatchId };
    await claimById(env.DB, { claimedBy: stale.claimedBy, now, outboxId: dispatchId });

    // The stale worker stalls past its claim; a fresh run completes the row.
    await dispatch(quietEnv().env, dispatchId, later(CLAIM_TTL_MS + 1_000));
    expect((await outboxRow(dispatchId)).status).toBe("done");

    expect(await markSubmitting(env.DB, stale, { now: now + CLAIM_TTL_MS + 2_000 })).toBeNull();
    expect(await printerJobs(order.orderId)).toHaveLength(1);
  });

  it("an unknown older than 30 minutes alerts, and a human resolves it as accepted (who/when/why recorded)", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;
    await dispatch(quietEnv({ [FAKE_PRINTER_FETCH_OVERRIDE]: losingTransport() }).env, dispatchId);
    // Automatic re-submits keep losing their answer too.
    await env.DB.prepare("UPDATE outbox_events SET cancel_requested = 0 WHERE outbox_id = ?")
      .bind(dispatchId)
      .run();
    await runOutboxSweep(
      quietEnv({ [FAKE_PRINTER_FETCH_OVERRIDE]: losingTransport() }).env,
      Date.now() + UNKNOWN_ALERT_AFTER_MS + 60_000,
    );

    expect((await outboxRow(dispatchId)).status).toBe("unknown");
    expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).toEqual(["dispatch_unknown_30m"]);

    const response = await resolve(dispatchId, {
      note: "Found in the SnapWear dashboard",
      outcome: "accepted",
      printerJobRef: "SW-4711",
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ dispatch: Record<string, unknown> }>();
    expect(body.dispatch).toMatchObject({
      orderId: order.orderId,
      outboxId: dispatchId,
      printerJobRef: "SW-4711",
      state: "done",
    });
    expect(await lineRow(order.orderId)).toMatchObject({
      dispatch_state: "accepted",
      printer_job_ref: "SW-4711",
    });
    expect((await alertsFor(dispatchId)).every((alert) => alert.resolved_at !== null)).toBe(true);
    const audit = await env.DB.prepare(
      `SELECT actor_user_id, action, reason, tenant_id, metadata_json, created_at
       FROM audit_events WHERE resource_id = ? AND action = 'dispatch.resolve'`,
    )
      .bind(dispatchId)
      .all<{ action: string; actor_user_id: string; created_at: number; metadata_json: string; reason: string; tenant_id: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]).toMatchObject({
      actor_user_id: platform.userId,
      reason: "Found in the SnapWear dashboard",
      tenant_id: TENANT_A,
    });
    expect(JSON.parse(audit.results[0]!.metadata_json)).toMatchObject({
      from: "unknown",
      outcome: "accepted",
      printerJobRef: "SW-4711",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("cancellation vs dispatch (§2.3, the four paths)", () => {
  it("PATH 1 — before claim: superseded in the cancel's own batch, line cancelled, ZERO printer jobs", async () => {
    const order = await seedOrder(TENANT_A, { lines: [{}, {}] });

    const response = await cancel(order.orderId);

    expect(response.status).toBe(200);
    const body = await response.json<{
      cancellation: { cancelledAt: string; lines: unknown[]; orderId: string; reason: string };
    }>();
    expect(body.cancellation).toMatchObject({ orderId: order.orderId, reason: "Kunden ångrade sig" });
    expect(body.cancellation.lines).toEqual([
      { jobId: printerJobId(order.orderId, 1), lineNo: 1, outcome: "cancelled" },
      { jobId: printerJobId(order.orderId, 2), lineNo: 2, outcome: "cancelled" },
    ]);
    for (const id of order.dispatchIds) {
      expect(await outboxRow(id)).toMatchObject({ cancel_requested: 1, status: "superseded" });
      expect(await dispatch(quietEnv().env, id)).toEqual({ kind: "settled" });
    }
    await runOutboxSweep(quietEnv().env, Date.now() + 60 * 60_000);
    expect(await printerJobs(order.orderId)).toHaveLength(0);
    expect((await lineRow(order.orderId, 1)).dispatch_state).toBe("cancelled");

    const recorded = await env.DB.prepare(
      "SELECT cancelled_at, cancel_reason, status FROM orders WHERE order_id = ?",
    )
      .bind(order.orderId)
      .first<{ cancel_reason: string; cancelled_at: string; status: string }>();
    // Cancelling moves no money and leaves the money status to CP2-A.
    expect(recorded).toMatchObject({ cancel_reason: "Kunden ångrade sig", status: "paid" });
    expect(recorded?.cancelled_at).toBe(body.cancellation.cancelledAt);
  });

  it("is idempotent: a repeat answers the recorded cancellation and audits once", async () => {
    const order = await seedOrder(TENANT_A);
    const first = await (await cancel(order.orderId)).json<{ cancellation: unknown }>();

    const again = await cancel(order.orderId, { body: { reason: "Andra gången" } });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    const audits = await env.DB.prepare(
      "SELECT actor_user_id, reason FROM audit_events WHERE resource_id = ? AND action = 'order.cancel'",
    )
      .bind(order.orderId)
      .all<{ actor_user_id: string; reason: string }>();
    expect(audits.results).toEqual([{ actor_user_id: adminA.userId, reason: "Kunden ångrade sig" }]);
  });

  it("PATH 2a — while claimed, before the call: the re-check stops it, ZERO printer jobs", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;
    const now = Date.now();
    const token = newClaimToken();
    const claimed = await claimById(env.DB, { claimedBy: token, now, outboxId: dispatchId });

    const response = await cancel(order.orderId);
    const body = await response.json<{ cancellation: { lines: Array<{ outcome: string }> } }>();
    expect(body.cancellation.lines[0]?.outcome).toBe("cancel_requested");

    // The worker that held the claim carries on — and stops at the re-check.
    const { runClaimedOutboxRow } = await import("../src/outbox/effects");
    const outcome = await runClaimedOutboxRow(quietEnv().env, claimed!, Date.now);

    expect(outcome).toEqual({ kind: "superseded" });
    expect(await outboxRow(dispatchId)).toMatchObject({ status: "superseded", submitted_at: null });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("cancelled");
    expect(await printerJobs(order.orderId)).toHaveLength(0);
  });

  it("PATH 2b — while submitting, the call already out: accepted → a printer_cancellation in the same batch", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;
    const quiet = quietEnv({
      [FAKE_PRINTER_FETCH_OVERRIDE]: async (request: Request) => {
        // The admin cancels while the request is on the wire.
        const cancelled = await cancel(order.orderId);
        const body = await cancelled.json<{ cancellation: { lines: Array<{ outcome: string }> } }>();
        expect(body.cancellation.lines[0]?.outcome).toBe("cancel_requested");
        return handleFakePrinterRoute(env as unknown as Env, request);
      },
    });

    const result = await dispatch(quiet.env, dispatchId);

    expect(result).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(await printerJobs(order.orderId)).toHaveLength(1);
    const followUp = `printer-cancellation:${dispatchId}`;
    expect(await outboxRow(followUp)).toMatchObject({
      dedupe_key: `printer_cancellation:${order.orderId}:1`,
      event_type: "printer_cancellation",
      status: "pending",
    });
    expect(quiet.nudges.sent).toContainEqual({ outboxId: followUp });

    await dispatch(quietEnv().env, followUp);
    const alerts = await alertsFor(followUp);
    expect(alerts.map((alert) => [alert.kind, alert.severity])).toEqual([
      ["printer_cancellation_needed", "critical"],
    ]);
    expect(alerts[0]?.message).toContain(printerJobId(order.orderId, 1));
    expect(await outboxRow(followUp)).toMatchObject({ result_ref: alerts[0]?.id, status: "done" });
  });

  it("PATH 2c — while submitting, the printer rejects: superseded, nothing to undo, no alert", async () => {
    const order = await seedOrder(TENANT_A, { lines: [{ sku: "not-a-snapwear-sku" }] });
    const dispatchId = order.dispatchIds[0]!;
    const quiet = quietEnv({
      [FAKE_PRINTER_FETCH_OVERRIDE]: async (request: Request) => {
        await cancel(order.orderId);
        return handleFakePrinterRoute(env as unknown as Env, request);
      },
    });

    expect(await dispatch(quiet.env, dispatchId)).toEqual({ kind: "ran", outcome: { kind: "superseded" } });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("cancelled");
    expect(await alertsFor(dispatchId)).toHaveLength(0);
  });

  it("PATH 2d — a worker died mid-submit and the order was cancelled: never re-submitted, a human is asked", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;
    const now = Date.now();
    const token = newClaimToken();
    await claimById(env.DB, { claimedBy: token, now, outboxId: dispatchId });
    await markSubmitting(env.DB, { claimedBy: token, outboxId: dispatchId }, { now });
    await cancel(order.orderId);

    const result = await dispatch(quietEnv().env, dispatchId, later(CLAIM_TTL_MS + 1_000));

    expect(result).toEqual({ kind: "ran", outcome: { delayMs: null, kind: "unknown" } });
    expect(await outboxRow(dispatchId)).toMatchObject({ cancel_requested: 1, status: "unknown" });
    expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).toEqual(["dispatch_cancel_unconfirmed"]);
    expect(await printerJobs(order.orderId)).toHaveLength(0);
    // No automatic re-submit, however long it waits.
    expect(await dispatch(quietEnv().env, dispatchId, later(48 * 60 * 60_000))).toEqual({ kind: "settled" });

    // The human finds nothing at the printer.
    const response = await resolve(dispatchId, { note: "Not in the dashboard", outcome: "failed" });
    expect(response.status).toBe(200);
    expect((await lineRow(order.orderId)).dispatch_state).toBe("cancelled");
    expect(await printerJobs(order.orderId)).toHaveLength(0);
  });

  it("PATH 2e — cancelled while the printer's answer is unknown: stops auto re-submit; resolved accepted → printer_cancellation", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;
    await dispatch(quietEnv({ [FAKE_PRINTER_FETCH_OVERRIDE]: losingTransport() }).env, dispatchId);

    const response = await cancel(order.orderId);
    const body = await response.json<{ cancellation: { lines: Array<{ outcome: string }> } }>();

    expect(body.cancellation.lines[0]?.outcome).toBe("awaiting_resolution");
    expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).toEqual(["dispatch_cancel_unconfirmed"]);
    expect(await dispatch(quietEnv().env, dispatchId, later(24 * 60 * 60_000))).toEqual({ kind: "settled" });

    const quiet = quietEnv();
    const resolved = await resolve(
      dispatchId,
      { note: "It is at SnapWear", outcome: "accepted" },
      { targetEnv: quiet.env },
    );
    expect(resolved.status).toBe(200);
    expect(await outboxRow(`printer-cancellation:${dispatchId}`)).toMatchObject({ status: "pending" });
    expect(quiet.nudges.sent).toEqual([{ outboxId: `printer-cancellation:${dispatchId}` }]);
    expect(await printerJobs(order.orderId)).toHaveLength(1);
  });

  it("PATH 3 — after acceptance: a printer_cancellation effect → human-action alert, exactly once", async () => {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;
    await dispatch(quietEnv().env, dispatchId);
    const quiet = quietEnv();

    const response = await cancel(order.orderId, { targetEnv: quiet.env });
    await cancel(order.orderId);

    const body = await response.json<{ cancellation: { lines: Array<{ outcome: string }> } }>();
    expect(body.cancellation.lines[0]?.outcome).toBe("printer_cancellation");
    const followUp = `printer-cancellation:${dispatchId}`;
    expect(quiet.nudges.sent).toEqual([{ outboxId: followUp }]);
    const row = await outboxRow(followUp);
    expect(JSON.parse(row.payload_json)).toMatchObject({
      dispatchOutboxId: dispatchId,
      jobId: printerJobId(order.orderId, 1),
      lineNo: 1,
      orderId: order.orderId,
      printerJobRef: (await outboxRow(dispatchId)).result_ref,
    });

    await dispatch(quietEnv().env, followUp);
    await dispatch(quietEnv().env, followUp);
    expect((await alertsFor(followUp)).map((alert) => alert.kind)).toEqual(["printer_cancellation_needed"]);
    // The accepted job is the printer's; only the human cancels it there.
    expect(await printerJobs(order.orderId)).toHaveLength(1);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'printer_cancellation' AND aggregate_id = ?",
    )
      .bind(order.orderId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("PATH 4 — after production: refused as a return case, nothing changes", async () => {
    const order = await seedOrder(TENANT_A, { lines: [{}, {}] });
    await dispatch(quietEnv().env, order.dispatchIds[0]!);
    await env.DB.prepare(
      "UPDATE order_items SET production_state = 'produced' WHERE order_id = ? AND item_index = 0",
    )
      .bind(order.orderId)
      .run();
    const before = await Promise.all(order.dispatchIds.map(outboxRow));

    const response = await cancel(order.orderId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "return_case", message: "The order has been produced; handle it as a return" },
    });
    expect(await Promise.all(order.dispatchIds.map(outboxRow))).toEqual(before);
    const recorded = await env.DB.prepare("SELECT cancelled_at FROM orders WHERE order_id = ?")
      .bind(order.orderId)
      .first<{ cancelled_at: string | null }>();
    expect(recorded?.cancelled_at).toBeNull();
    const audits = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ?")
      .bind(order.orderId)
      .first<{ n: number }>();
    expect(audits?.n).toBe(0);
  });

  it("PATH 4 — an order already shipped is a return case too", async () => {
    const order = await seedOrder(TENANT_A);
    await env.DB.prepare("UPDATE orders SET status = 'shipped' WHERE order_id = ?")
      .bind(order.orderId)
      .run();

    expect((await cancel(order.orderId)).status).toBe(409);
    expect((await outboxRow(order.dispatchIds[0]!)).status).toBe("pending");
  });

  it("does not touch the order confirmation email", async () => {
    const order = await seedOrder(TENANT_A);
    await cancel(order.orderId);
    expect(await outboxRow(order.emailId)).toMatchObject({ cancel_requested: 0, status: "pending" });
  });

  it("guards the route: other shop, no session, cross-origin, wrong method, bad body", async () => {
    const order = await seedOrder(TENANT_A);

    expect((await cancel(order.orderId, { cookie: adminB.cookie, shopId: TENANT_B })).status).toBe(404);
    expect((await cancel(order.orderId, { cookie: adminB.cookie })).status).toBe(404);
    expect((await cancel(order.orderId, { cookie: "" })).status).toBe(404);
    expect((await cancel(order.orderId, { origin: "https://evil.test" })).status).toBe(404);
    expect((await cancel(order.orderId, { origin: null })).status).toBe(404);
    expect((await cancel("not-a-uuid")).status).toBe(404);
    expect((await cancel(crypto.randomUUID())).status).toBe(404);
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: 5 }, { reason: "x", extra: 1 }, { reason: "a\nb" }]) {
      expect((await cancel(order.orderId, { body })).status).toBe(400);
    }
    const get = await worker.fetch(
      sessionRequest(`${ADMIN_HOST}/v1/admin/orders/${order.orderId}/cancel`, "GET", {
        cookie: adminA.cookie,
        shopId: TENANT_A,
      }),
      quietEnv().env,
    );
    expect(get.status).toBe(404);
    expect((await outboxRow(order.dispatchIds[0]!)).status).toBe("pending");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("platform: dispatches needing a human", () => {
  async function unknownDispatch(): Promise<{ dispatchId: string; orderId: string }> {
    const order = await seedOrder(TENANT_A);
    const dispatchId = order.dispatchIds[0]!;
    await dispatch(quietEnv({ [FAKE_PRINTER_FETCH_OVERRIDE]: losingTransport() }).env, dispatchId);
    return { dispatchId, orderId: order.orderId };
  }

  function list(query: string, cookie = platform.cookie): Promise<Response> {
    return worker.fetch(
      sessionRequest(`${PLATFORM_HOST}/v1/platform/dispatch${query}`, "GET", { cookie, origin: null }),
      quietEnv().env,
    );
  }

  it("lists unknown and failed dispatches, cursor-paged", async () => {
    const first = await unknownDispatch();
    const second = await unknownDispatch();
    const failedOrder = await seedOrder(TENANT_B, { printer: "snapwear" });
    await dispatch(quietEnv().env, failedOrder.dispatchIds[0]!);

    const page1 = await (await list("?state=unknown&limit=1")).json<{
      dispatches: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>();
    expect(page1.dispatches).toHaveLength(1);
    expect(page1.dispatches[0]).toMatchObject({
      cancelRequested: false,
      jobId: printerJobId(first.orderId, 1),
      lastError: "unknown_network",
      lineNo: 1,
      orderId: first.orderId,
      outboxId: first.dispatchId,
      state: "unknown",
      tenantId: TENANT_A,
    });
    expect(page1.dispatches[0]?.unknownSince).toMatch(/Z$/);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await (
      await list(`?state=unknown&limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`)
    ).json<{ dispatches: Array<{ outboxId: string }>; nextCursor: string | null }>();
    expect(page2.dispatches.map((row) => row.outboxId)).toEqual([second.dispatchId]);
    expect(page2.nextCursor).toBeNull();

    const failed = await (await list("?state=failed")).json<{ dispatches: Array<{ outboxId: string }> }>();
    expect(failed.dispatches.map((row) => row.outboxId)).toEqual([failedOrder.dispatchIds[0]]);
  });

  it("refuses bad queries and anyone who is not a platform user", async () => {
    for (const query of ["", "?state=done", "?state=unknown&limit=0", "?state=unknown&limit=500", "?state=unknown&x=1", "?state=unknown&cursor=bad"]) {
      expect((await list(query)).status).toBe(400);
    }
    expect((await list("?state=unknown", adminA.cookie)).status).toBe(404);
    expect((await list("?state=unknown", "")).status).toBe(404);
  });

  it("resolves a failed dispatch as accepted after all, or acknowledges it", async () => {
    const order = await seedOrder(TENANT_A, { printer: "snapwear" });
    const dispatchId = order.dispatchIds[0]!;
    await dispatch(quietEnv().env, dispatchId);
    expect((await outboxRow(dispatchId)).status).toBe("failed");

    const acknowledged = await resolve(dispatchId, { note: "Known: routing fixed", outcome: "failed" });
    expect(acknowledged.status).toBe(200);
    expect(await outboxRow(dispatchId)).toMatchObject({ last_error: "resolved_failed", status: "failed" });
    expect((await alertsFor(dispatchId)).every((alert) => alert.resolved_at !== null)).toBe(true);

    const accepted = await resolve(dispatchId, { note: "Submitted by hand", outcome: "accepted", printerJobRef: "SW-1" });
    expect(accepted.status).toBe(200);
    expect(await outboxRow(dispatchId)).toMatchObject({ result_ref: "SW-1", status: "done" });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("accepted");
  });

  it("answers 409 for a dispatch not awaiting a human, and never touches it", async () => {
    const pending = await seedOrder(TENANT_A);
    const done = await seedOrder(TENANT_A);
    await dispatch(quietEnv().env, done.dispatchIds[0]!);

    for (const id of [pending.dispatchIds[0]!, done.dispatchIds[0]!]) {
      const before = await outboxRow(id);
      const response = await resolve(id, { note: "x", outcome: "accepted" });
      expect(response.status).toBe(409);
      expect(await outboxRow(id)).toEqual(before);
    }
  });

  it("guards resolution: platform only, same-origin, dispatch rows only, strict body", async () => {
    const { dispatchId } = await unknownDispatch();
    const order = await seedOrder(TENANT_A);

    expect((await resolve(dispatchId, { note: "x", outcome: "failed" }, { cookie: adminA.cookie })).status).toBe(404);
    expect((await resolve(dispatchId, { note: "x", outcome: "failed" }, { origin: "https://evil.test" })).status).toBe(404);
    expect((await resolve(order.emailId, { note: "x", outcome: "failed" })).status).toBe(404);
    expect((await resolve("no-such-row", { note: "x", outcome: "failed" })).status).toBe(404);
    for (const body of [
      {},
      { outcome: "accepted" },
      { note: "", outcome: "accepted" },
      { note: "x", outcome: "done" },
      { note: "x", outcome: "failed", printerJobRef: "SW-1" },
      { note: "x", outcome: "accepted", extra: true },
    ]) {
      expect((await resolve(dispatchId, body)).status).toBe(400);
    }
    expect((await outboxRow(dispatchId)).status).toBe("unknown");
  });

  it("a row that moves between the operator's read and the write is refused whole (the in-batch check)", async () => {
    const { dispatchId, orderId } = await unknownDispatch();
    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property === "batch" && !raced) {
          return async (statements: D1PreparedStatement[]) => {
            raced = true;
            // The automatic re-submit claims the row right before the write.
            await claimById(target, {
              claimedBy: newClaimToken(),
              now: Date.now() + outboxRetryDelayMs(1) + 1_000,
              outboxId: dispatchId,
            });
            return target.batch(statements);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const response = await resolve(
      dispatchId,
      { note: "racing", outcome: "accepted", printerJobRef: "SW-9" },
      { targetEnv: quietEnv({ DB: racingDb }).env },
    );

    expect(response.status).toBe(409);
    expect(await outboxRow(dispatchId)).toMatchObject({ result_ref: null, status: "claimed" });
    expect((await lineRow(orderId)).dispatch_state).toBe("unknown");
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'dispatch.resolve'",
    )
      .bind(dispatchId)
      .first<{ n: number }>();
    expect(audits?.n).toBe(0);
  });

  it("a resolution racing the automatic re-submit is refused, not applied twice", async () => {
    const { dispatchId } = await unknownDispatch();
    // The automatic re-submit wins the race (duplicate → done)…
    await dispatch(quietEnv().env, dispatchId, later(outboxRetryDelayMs(1) + 1_000));
    // …and the human's late resolution changes nothing.
    const response = await resolve(dispatchId, { note: "late", outcome: "failed" });
    expect(response.status).toBe(409);
    expect((await outboxRow(dispatchId)).status).toBe("done");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the line follows an exhausted row (Codex P2)", () => {
  async function onLastAttempt(outboxId: string): Promise<void> {
    await env.DB.prepare("UPDATE outbox_events SET attempts = max_attempts - 1 WHERE outbox_id = ?")
      .bind(outboxId)
      .run();
  }

  const failingBucket = new Proxy(env.PRIVATE_BUCKET, {
    get(target, property) {
      if (property === "head") {
        return () => Promise.reject(new Error("R2 unavailable"));
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const PATHS: Array<[string, Record<PropertyKey, unknown>, string, string | null]> = [
    // [label, env overrides, error code, printer the order was routed to]
    ["a printer-client exception (the SnapWear stub)", { DISPATCH_TARGET: "snapwear" }, "printer_client_error", "snapwear"],
    ["no usable printer (before any call)", { DISPATCH_TARGET: undefined }, "printer_not_configured", null],
    ["storage not configured (before any call)", { PRIVATE_BUCKET: undefined }, "storage_not_configured", null],
    ["a storage error (before any call)", { PRIVATE_BUCKET: failingBucket }, "storage_error", null],
    [
      "a presigning failure (before any call)",
      {
        [R2_PRESIGNER_OVERRIDE]: {
          presignGet: () => Promise.reject(new Error("no signature")),
          presignPut: () => Promise.reject(new Error("no signature")),
        },
      },
      "presign_failed",
      null,
    ],
  ];

  for (const [label, overrides, code, printer] of PATHS) {
    it(`exhausting on ${label} fails the row AND the line, with one alert`, async () => {
      const order = await seedOrder(TENANT_A, printer === null ? {} : { printer });
      const dispatchId = order.dispatchIds[0]!;
      await onLastAttempt(dispatchId);

      const result = await dispatch(quietEnv(overrides).env, dispatchId);

      expect(result).toEqual({ kind: "ran", outcome: { kind: "failed" } });
      expect(await outboxRow(dispatchId)).toMatchObject({ last_error: code, status: "failed" });
      expect((await lineRow(order.orderId)).dispatch_state).toBe("failed");
      expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).toEqual(["dispatch_failed"]);
      expect(await printerJobs(order.orderId)).toHaveLength(0);
    });

    it(`${label} with attempts left keeps the row pending and the line not failed`, async () => {
      const order = await seedOrder(TENANT_A, printer === null ? {} : { printer });
      const dispatchId = order.dispatchIds[0]!;

      await dispatch(quietEnv(overrides).env, dispatchId);

      expect(await outboxRow(dispatchId)).toMatchObject({ last_error: code, status: "pending" });
      // Before the call the line was never touched; after it, it is pending again.
      expect((await lineRow(order.orderId)).dispatch_state).toBe(
        code === "printer_client_error" ? "pending" : null,
      );
    });
  }

  it("the sweeper settles an exhausted in-flight dispatch with its line: unknown if it may have been sent, failed if not", async () => {
    const sent = await seedOrder(TENANT_A);
    const unsent = await seedOrder(TENANT_A);
    const now = Date.now();
    for (const order of [sent, unsent]) {
      await onLastAttempt(order.dispatchIds[0]!);
    }
    const sentClaim = { claimedBy: newClaimToken(), outboxId: sent.dispatchIds[0]! };
    await claimById(env.DB, { ...sentClaim, now });
    await markSubmitting(env.DB, sentClaim, { now });
    await env.DB.prepare("UPDATE order_items SET dispatch_state = 'submitting' WHERE order_id = ?")
      .bind(sent.orderId)
      .run();
    await claimById(env.DB, { claimedBy: newClaimToken(), now, outboxId: unsent.dispatchIds[0]! });

    await runOutboxSweep(quietEnv().env, now + CLAIM_TTL_MS + 1_000);

    expect((await outboxRow(sent.dispatchIds[0]!)).status).toBe("unknown");
    expect((await lineRow(sent.orderId)).dispatch_state).toBe("unknown");
    expect((await outboxRow(unsent.dispatchIds[0]!)).status).toBe("failed");
    expect((await lineRow(unsent.orderId)).dispatch_state).toBe("failed");
  });

  it("resolving as failed sets the line failed — on an unknown row and on an acknowledged failed one", async () => {
    const unknownOrder = await seedOrder(TENANT_A);
    const unknownId = unknownOrder.dispatchIds[0]!;
    await dispatch(quietEnv({ [FAKE_PRINTER_FETCH_OVERRIDE]: losingTransport() }).env, unknownId);
    expect((await lineRow(unknownOrder.orderId)).dispatch_state).toBe("unknown");

    expect((await resolve(unknownId, { note: "Not at the printer", outcome: "failed" })).status).toBe(200);
    expect((await lineRow(unknownOrder.orderId)).dispatch_state).toBe("failed");

    // A failed row whose line still shows where the last attempt left it.
    const failedOrder = await seedOrder(TENANT_A, { printer: "snapwear" });
    const failedId = failedOrder.dispatchIds[0]!;
    await dispatch(quietEnv().env, failedId);
    await env.DB.prepare("UPDATE order_items SET dispatch_state = 'pending' WHERE order_id = ?")
      .bind(failedOrder.orderId)
      .run();

    expect((await resolve(failedId, { note: "Acknowledged", outcome: "failed" })).status).toBe(200);
    expect((await lineRow(failedOrder.orderId)).dispatch_state).toBe("failed");
  });

  it("resolving as accepted sets the line accepted with the printer reference", async () => {
    const order = await seedOrder(TENANT_A, { printer: "snapwear" });
    const dispatchId = order.dispatchIds[0]!;
    await dispatch(quietEnv().env, dispatchId);

    expect(
      (await resolve(dispatchId, { note: "Placed by hand", outcome: "accepted", printerJobRef: "SW-77" })).status,
    ).toBe(200);
    expect(await lineRow(order.orderId)).toMatchObject({
      dispatch_state: "accepted",
      printer_job_ref: "SW-77",
    });
  });
});

describe("envWith is a copy", () => {
  it("never mutates the shared env", () => {
    const copy = envWith({ DISPATCH_TARGET: "snapwear" });
    expect(copy.DISPATCH_TARGET).toBe("snapwear");
    expect(env.DISPATCH_TARGET).toBe("fake-printer");
  });
});
