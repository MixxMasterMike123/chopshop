import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { handleOutboxQueueBatch, parseOutboxNudge } from "../src/outbox/consumer";
import { processOutboxRowById } from "../src/outbox/effects";
import { nudgeOutbox } from "../src/outbox/nudge";
import {
  alertStatement,
  CLAIM_TTL_MS,
  claimById,
  claimNext,
  complete,
  existsGuard,
  fail,
  fenceGuard,
  markSubmitting,
  markUnknown,
  newClaimToken,
  outboxRetryDelayMs,
  supersede,
} from "../src/outbox/outbox";
import {
  handleScheduled,
  loadCommerceCrons,
  OUTBOX_SWEEP_CRON,
  setCommerceCronsLoader,
} from "../src/outbox/scheduled";
import { runOutboxSweep, UNKNOWN_ALERT_AFTER_MS } from "../src/outbox/sweeper";
import {
  alertsFor,
  outboxInsert,
  outboxRow,
  quietEnv,
  recordingQueue,
  seedTenant,
} from "./dispatch-fixtures";

/**
 * The outbox with claims (PLAN §2.2): claiming, every transition and its fence,
 * the schema's own guarantees, the `-outbox` nudge consumer, the 15-minute
 * sweeper and the scheduled() routing. Dispatch and email effects have their
 * own suites (dispatch.test.ts, outbox-email.test.ts).
 */

const TENANT = "tenant-outbox-core";
const T0 = 1_790_000_000_000;

let seq = 0;

/** A bare row of a known type; its effect is never run in the core tests. */
async function insertRow(
  overrides: { eventType?: string; nextAttemptAt?: number; now?: number } = {},
): Promise<string> {
  seq += 1;
  const outboxId = `core-${seq}-${crypto.randomUUID().slice(0, 8)}`;
  const now = overrides.now ?? T0;
  await outboxInsert({
    aggregateId: `agg-${seq}`,
    dedupeKey: `core:${outboxId}`,
    eventType: overrides.eventType ?? "email",
    now,
    outboxId,
    payload: { n: seq },
    tenantId: TENANT,
  }).run();
  if (overrides.nextAttemptAt !== undefined) {
    await env.DB.prepare("UPDATE outbox_events SET next_attempt_at = ? WHERE outbox_id = ?")
      .bind(overrides.nextAttemptAt, outboxId)
      .run();
  }
  return outboxId;
}

async function claim(outboxId: string, now = T0) {
  const token = newClaimToken();
  const row = await claimById(env.DB, { claimedBy: token, now, outboxId });
  expect(row).not.toBeNull();
  return { claim: { claimedBy: token, outboxId }, row: row! };
}

beforeAll(async () => {
  await seedTenant(TENANT);
});

beforeEach(async () => {
  // Claims are global (oldest first), so each test starts from an empty outbox.
  await env.DB.prepare("DELETE FROM outbox_events").run();
});

beforeEach(() => {
  // The real money crons are CP2-A's to test; here only the ordering matters.
  setCommerceCronsLoader(() => Promise.resolve(null));
});

afterEach(() => {
  setCommerceCronsLoader(null);
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("claiming", () => {
  it("claims the oldest due row atomically: claimed, token, 5-minute expiry, attempts + 1", async () => {
    const older = await insertRow({ now: T0 - 2_000 });
    await insertRow({ now: T0 - 1_000 });
    const token = newClaimToken();

    const row = await claimNext(env.DB, { claimedBy: token, now: T0 });

    expect(row).toMatchObject({
      attempts: 1,
      claim_expires_at: T0 + CLAIM_TTL_MS,
      claimed_by: token,
      last_attempt_at: T0,
      outbox_id: older,
      status: "claimed",
    });
  });

  it("never claims a row that is not due, of an unknown type, or already claimed", async () => {
    await insertRow({ nextAttemptAt: T0 + 1 });
    await insertRow({ eventType: "tenant.created" });
    const live = await insertRow();
    await claim(live);

    expect(await claimNext(env.DB, { claimedBy: newClaimToken(), now: T0 })).toBeNull();
    expect(await claimById(env.DB, { claimedBy: newClaimToken(), now: T0, outboxId: live })).toBeNull();
  });

  it("lets exactly one of many concurrent claims win", async () => {
    const outboxId = await insertRow();
    const tokens = Array.from({ length: 6 }, () => newClaimToken());

    const results = await Promise.all(
      tokens.map((claimedBy) => claimById(env.DB, { claimedBy, now: T0, outboxId })),
    );

    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect((await outboxRow(outboxId)).attempts).toBe(1);
  });

  it("filters by type", async () => {
    await insertRow({ eventType: "email" });
    const dispatch = await insertRow({ eventType: "printer_cancellation" });

    const row = await claimNext(env.DB, {
      claimedBy: newClaimToken(),
      now: T0,
      type: "printer_cancellation",
    });

    expect(row?.outbox_id).toBe(dispatch);
  });

  it("re-claims an EXPIRED claim (the worker died) — claimed or submitting", async () => {
    const claimedRow = await insertRow();
    const submittingRow = await insertRow();
    await claim(claimedRow);
    const second = await claim(submittingRow);
    await markSubmitting(env.DB, second.claim, { now: T0 });

    const later = T0 + CLAIM_TTL_MS + 1;
    const first = await claimById(env.DB, { claimedBy: newClaimToken(), now: later, outboxId: claimedRow });
    const again = await claimById(env.DB, { claimedBy: newClaimToken(), now: later, outboxId: submittingRow });

    expect(first).toMatchObject({ attempts: 2, status: "claimed" });
    // A re-claimed submitting row keeps the fact that it may have gone out.
    expect(again).toMatchObject({ attempts: 2, status: "claimed", submitted_at: T0 });
  });

  it("stops claiming at max_attempts", async () => {
    const outboxId = await insertRow();
    await env.DB.prepare("UPDATE outbox_events SET attempts = max_attempts WHERE outbox_id = ?")
      .bind(outboxId)
      .run();

    expect(await claimById(env.DB, { claimedBy: newClaimToken(), now: T0, outboxId })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("transitions and the fence", () => {
  it("claimed → submitting → done records the result and clears the claim", async () => {
    const outboxId = await insertRow();
    const { claim: held } = await claim(outboxId);

    const submitting = await markSubmitting(env.DB, held, { now: T0 + 10 });
    const done = await complete(env.DB, held, { now: T0 + 20, resultRef: "printer-123" });

    expect(submitting).toMatchObject({ status: "submitting", submitted_at: T0 + 10 });
    expect(done).toMatchObject({
      claim_expires_at: null,
      claimed_by: null,
      resolved_at: T0 + 20,
      result_ref: "printer-123",
      status: "done",
    });
  });

  it("rejects a stale worker's late completion once its claim expired", async () => {
    const outboxId = await insertRow();
    const { claim: stale } = await claim(outboxId);

    const late = await complete(env.DB, stale, { now: T0 + CLAIM_TTL_MS + 1, resultRef: "late" });

    expect(late).toBeNull();
    expect(await outboxRow(outboxId)).toMatchObject({ result_ref: null, status: "claimed" });
  });

  it("rejects the stale worker after a re-claim, and accepts only the new token", async () => {
    const outboxId = await insertRow();
    const { claim: stale } = await claim(outboxId);
    const later = T0 + CLAIM_TTL_MS + 1;
    const { claim: fresh } = await claim(outboxId, later);

    expect(await complete(env.DB, stale, { now: later + 1, resultRef: "stale" })).toBeNull();
    expect(await fail(env.DB, stale, { backoffMs: 0, error: "x", now: later + 1 })).toBeNull();
    expect(await markUnknown(env.DB, stale, { backoffMs: 0, error: "x", now: later + 1 })).toBeNull();
    expect(await supersede(env.DB, stale, { now: later + 1, reason: "x" })).toBeNull();
    expect(await markSubmitting(env.DB, stale, { now: later + 1 })).toBeNull();

    const done = await complete(env.DB, fresh, { now: later + 2, resultRef: "fresh" });
    expect(done).toMatchObject({ result_ref: "fresh", status: "done" });
  });

  it("commits statements handed to a transition only when the fence holds", async () => {
    const outboxId = await insertRow();
    const { claim: stale } = await claim(outboxId);
    const alertId = `fence-probe-${outboxId}`;
    const withAlert = (guard: { binds: unknown[]; sql: string }) => [
      alertStatement(
        env.DB,
        {
          id: alertId,
          kind: "probe",
          message: "probe",
          nowMs: T0,
          resourceId: outboxId,
          resourceType: "outbox_event",
          severity: "info",
          tenantId: TENANT,
        },
        guard,
      ),
    ];

    await complete(env.DB, stale, {
      now: T0 + CLAIM_TTL_MS + 1,
      resultRef: null,
      withTransition: withAlert,
    });
    expect(await alertsFor(outboxId)).toHaveLength(0);

    const { claim: fresh } = await claim(outboxId, T0 + CLAIM_TTL_MS + 1);
    await complete(env.DB, fresh, { now: T0 + CLAIM_TTL_MS + 2, resultRef: null, withTransition: withAlert });
    expect(await alertsFor(outboxId)).toHaveLength(1);
  });

  it("markSubmitting is refused once cancellation is requested (the re-check before the call)", async () => {
    const outboxId = await insertRow();
    const { claim: held } = await claim(outboxId);
    await env.DB.prepare("UPDATE outbox_events SET cancel_requested = 1 WHERE outbox_id = ?")
      .bind(outboxId)
      .run();

    expect(await markSubmitting(env.DB, held, { now: T0 + 1 })).toBeNull();
    expect(await outboxRow(outboxId)).toMatchObject({ status: "claimed", submitted_at: null });
  });

  it("a retryable failure returns the row to pending after the backoff", async () => {
    const outboxId = await insertRow();
    const { claim: held } = await claim(outboxId);

    const row = await fail(env.DB, held, { backoffMs: 60_000, error: "http_503", now: T0 + 5 });

    expect(row).toMatchObject({
      claimed_by: null,
      last_error: "http_503",
      next_attempt_at: T0 + 60_005,
      resolved_at: null,
      status: "pending",
    });
    expect(await claimNext(env.DB, { claimedBy: newClaimToken(), now: T0 + 60_004 })).toBeNull();
    expect(await claimNext(env.DB, { claimedBy: newClaimToken(), now: T0 + 60_005 })).not.toBeNull();
  });

  it("goes failed with ONE alert when attempts run out", async () => {
    const outboxId = await insertRow();
    await env.DB.prepare("UPDATE outbox_events SET attempts = max_attempts - 1 WHERE outbox_id = ?")
      .bind(outboxId)
      .run();
    const { claim: held } = await claim(outboxId);
    const onFailed = (guard: { binds: unknown[]; sql: string }) => [
      alertStatement(
        env.DB,
        {
          id: `exhausted:${outboxId}`,
          kind: "outbox_failed",
          message: "gave up",
          nowMs: T0,
          resourceId: outboxId,
          resourceType: "outbox_event",
          severity: "warning",
          tenantId: TENANT,
        },
        guard,
      ),
    ];

    const row = await fail(env.DB, held, { backoffMs: 1, error: "http_503", now: T0 + 1, onFailed });

    expect(row).toMatchObject({ resolved_at: T0 + 1, status: "failed" });
    expect((await alertsFor(outboxId)).map((alert) => alert.kind)).toEqual(["outbox_failed"]);
  });

  it("a retryable failure below the limit raises no alert", async () => {
    const outboxId = await insertRow();
    const { claim: held } = await claim(outboxId);
    const onFailed = (guard: { binds: unknown[]; sql: string }) => [
      alertStatement(
        env.DB,
        {
          id: `never:${outboxId}`,
          kind: "outbox_failed",
          message: "x",
          nowMs: T0,
          resourceId: outboxId,
          resourceType: "outbox_event",
          severity: "warning",
          tenantId: TENANT,
        },
        guard,
      ),
    ];

    await fail(env.DB, held, { backoffMs: 1, error: "x", now: T0 + 1, onFailed });

    expect(await alertsFor(outboxId)).toHaveLength(0);
  });

  it("a terminal failure is failed at once", async () => {
    const outboxId = await insertRow();
    const { claim: held } = await claim(outboxId);

    expect(await fail(env.DB, held, { backoffMs: 1, error: "invalid", now: T0 + 1, terminal: true })).toMatchObject({
      attempts: 1,
      status: "failed",
    });
  });

  it("unknown: re-claimable when due unless cancellation was requested", async () => {
    const outboxId = await insertRow();
    const { claim: held } = await claim(outboxId);
    await markSubmitting(env.DB, held, { now: T0 });

    const row = await markUnknown(env.DB, held, { backoffMs: 1_000, error: "network", now: T0 + 1 });
    expect(row).toMatchObject({ next_attempt_at: T0 + 1_001, status: "unknown", unknown_since: T0 + 1 });

    expect(await claimById(env.DB, { claimedBy: newClaimToken(), now: T0 + 1_000, outboxId })).toBeNull();
    const again = await claimById(env.DB, { claimedBy: newClaimToken(), now: T0 + 1_001, outboxId });
    expect(again).toMatchObject({ status: "claimed", unknown_since: T0 + 1 });

    const second = { claimedBy: again!.claimed_by!, outboxId };
    await markUnknown(env.DB, second, { backoffMs: 0, error: "network", now: T0 + 2_000 });
    await env.DB.prepare("UPDATE outbox_events SET cancel_requested = 1 WHERE outbox_id = ?")
      .bind(outboxId)
      .run();
    expect(await claimById(env.DB, { claimedBy: newClaimToken(), now: T0 + 9_999_999, outboxId })).toBeNull();
    // The first unknown instant is kept across the cycle.
    expect((await outboxRow(outboxId)).unknown_since).toBe(T0 + 1);
  });

  it("supersede ends the row; done and superseded rows are frozen", async () => {
    const one = await insertRow();
    const two = await insertRow();
    const a = await claim(one);
    const b = await claim(two);
    await supersede(env.DB, a.claim, { now: T0 + 1, reason: "cancelled" });
    await complete(env.DB, b.claim, { now: T0 + 1, resultRef: null });

    for (const outboxId of [one, two]) {
      await expect(
        env.DB.prepare("UPDATE outbox_events SET cancel_requested = 1 WHERE outbox_id = ?")
          .bind(outboxId)
          .run(),
      ).rejects.toThrow(/final/);
    }
    expect(await outboxRow(one)).toMatchObject({ last_error: "cancelled", status: "superseded" });
  });

  it("backs off 1, 2, 4 … minutes, capped at an hour", () => {
    expect([1, 2, 3, 4, 7, 8, 30].map(outboxRetryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    expect(outboxRetryDelayMs(0)).toBe(60_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the schema (0021)", () => {
  async function update(sql: string, ...binds: unknown[]) {
    return env.DB.prepare(sql).bind(...binds).run();
  }

  it("refuses edges outside the state machine", async () => {
    const outboxId = await insertRow();
    await expect(
      update("UPDATE outbox_events SET status = 'done', resolved_at = 1 WHERE outbox_id = ?", outboxId),
    ).rejects.toThrow(/transition not allowed/);
    await expect(
      update(
        "UPDATE outbox_events SET status = 'submitting', submitted_at = 1, claimed_by = ?, claim_expires_at = 1 WHERE outbox_id = ?",
        newClaimToken(),
        outboxId,
      ),
    ).rejects.toThrow(/transition not allowed/);
  });

  it("keeps one-way facts one-way", async () => {
    const outboxId = await insertRow();
    const { claim: held } = await claim(outboxId);
    await markSubmitting(env.DB, held, { now: T0 });
    await update("UPDATE outbox_events SET cancel_requested = 1 WHERE outbox_id = ?", outboxId);

    await expect(update("UPDATE outbox_events SET submitted_at = NULL WHERE outbox_id = ?", outboxId)).rejects.toThrow(/one-way/);
    await expect(update("UPDATE outbox_events SET cancel_requested = 0 WHERE outbox_id = ?", outboxId)).rejects.toThrow(/one-way/);
    await expect(update("UPDATE outbox_events SET attempts = 0 WHERE outbox_id = ?", outboxId)).rejects.toThrow(/one-way/);
  });

  it("freezes what the effect is", async () => {
    const outboxId = await insertRow();
    for (const [column, value] of [
      ["payload_json", "{}"],
      ["dedupe_key", "other"],
      ["aggregate_id", "other"],
      ["event_type", "dispatch"],
    ] as const) {
      await expect(
        update(`UPDATE outbox_events SET ${column} = ? WHERE outbox_id = ?`, value, outboxId),
      ).rejects.toThrow(/identity is immutable/);
    }
  });

  it("requires a claim exactly while claimed/submitting, and pins the retired lease columns", async () => {
    const outboxId = await insertRow();
    await expect(
      update("UPDATE outbox_events SET status = 'claimed' WHERE outbox_id = ?", outboxId),
    ).rejects.toThrow(/CHECK/);
    await expect(
      update("UPDATE outbox_events SET claimed_by = ?, claim_expires_at = 1 WHERE outbox_id = ?", newClaimToken(), outboxId),
    ).rejects.toThrow(/CHECK/);
    await expect(
      update("UPDATE outbox_events SET lease_token = 'x' WHERE outbox_id = ?", outboxId),
    ).rejects.toThrow(/CHECK/);
    await expect(
      update("UPDATE outbox_events SET last_error = 'has spaces' WHERE outbox_id = ?", outboxId),
    ).rejects.toThrow(/CHECK/);
  });

  it("keeps dedupe_key unique and accepts the webhook's exact insert", async () => {
    await insertRow();
    await expect(
      outboxInsert({
        aggregateId: "x",
        dedupeKey: `core:core-${seq}-dupe`,
        eventType: "dispatch",
        now: T0,
        outboxId: "a",
        payload: {},
        tenantId: TENANT,
      }).run(),
    ).resolves.toBeDefined();
    await expect(
      outboxInsert({
        aggregateId: "x",
        dedupeKey: `core:core-${seq}-dupe`,
        eventType: "dispatch",
        now: T0,
        outboxId: "b",
        payload: {},
        tenantId: TENANT,
      }).run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("nudgeOutbox", () => {
  it("sends one { outboxId } per id, deduplicated, in batches", async () => {
    const recording = recordingQueue();
    await nudgeOutbox({ ...env, OUTBOX_QUEUE: recording.queue } as Env, ["a", "b", "a"]);
    expect(recording.sent).toEqual([{ outboxId: "a" }, { outboxId: "b" }]);
  });

  it("never throws: a queue failure is logged and the sweeper is the backstop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      nudgeOutbox({ ...env, OUTBOX_QUEUE: recordingQueue({ fail: true }).queue } as Env, ["a"]),
    ).resolves.toBeUndefined();
    await expect(nudgeOutbox({ ...env, OUTBOX_QUEUE: undefined } as Env, ["a"])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the -outbox consumer", () => {
  interface Recorded {
    acks: string[];
    retries: Array<{ delaySeconds?: number; id: string }>;
  }

  async function run(bodies: Array<{ body: unknown; id: string }>, targetEnv: Env): Promise<Recorded> {
    const recorded: Recorded = { acks: [], retries: [] };
    const batch = {
      messages: bodies.map((message) => ({
        ack: () => recorded.acks.push(message.id),
        attempts: 1,
        body: message.body,
        id: message.id,
        retry: (options?: QueueRetryOptions) => recorded.retries.push({ id: message.id, ...options }),
        timestamp: new Date(),
      })),
      queue: "chopshop-test-outbox",
      retryAll: () => {
        throw new Error("never retries a whole batch");
      },
    } as unknown as MessageBatch<unknown>;
    await worker.queue(batch, targetEnv);
    return recorded;
  }

  it("parses only exact nudges", () => {
    expect(parseOutboxNudge({ outboxId: "abc-1" })).toBe("abc-1");
    for (const bad of [null, [], "x", {}, { outboxId: 1 }, { outboxId: "a b" }, { outboxId: "a", x: 1 }]) {
      expect(parseOutboxNudge(bad)).toBeNull();
    }
  });

  it("acks malformed nudges without logging their body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env: quiet } = quietEnv();
    const result = await run([{ body: { secret: "should-not-appear" }, id: "m1" }], quiet);
    expect(result.acks).toEqual(["m1"]);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("should-not-appear");
  });

  it("runs the named row's effect and acks when it is done", async () => {
    const outboxId = await insertRow({ eventType: "printer_cancellation", now: Date.now() });
    const { env: quiet } = quietEnv();

    const result = await run([{ body: { outboxId }, id: "m1" }], quiet);

    expect(result.acks).toEqual(["m1"]);
    expect((await outboxRow(outboxId)).status).toBe("done");
  });

  it("acks a nudge for a settled or missing row, and a duplicate delivery never runs twice", async () => {
    const outboxId = await insertRow({ eventType: "printer_cancellation", now: Date.now() });
    const { env: quiet } = quietEnv();

    const result = await run(
      [
        { body: { outboxId }, id: "m1" },
        { body: { outboxId }, id: "m2" },
        { body: { outboxId: "missing-row" }, id: "m3" },
      ],
      quiet,
    );

    expect(result.acks).toEqual(["m1", "m2", "m3"]);
    expect(await alertsFor(outboxId)).toHaveLength(1);
  });

  it("retries a nudge for a row claimed elsewhere until that claim could expire", async () => {
    const now = Date.now();
    const outboxId = await insertRow({ eventType: "printer_cancellation", now });
    await claimById(env.DB, { claimedBy: newClaimToken(), now, outboxId });
    const { env: quiet } = quietEnv();

    const result = await run([{ body: { outboxId }, id: "m1" }], quiet);

    expect(result.acks).toEqual([]);
    expect(result.retries).toHaveLength(1);
    expect(result.retries[0]?.delaySeconds).toBeGreaterThan(250);
    expect(result.retries[0]?.delaySeconds).toBeLessThanOrEqual(300);
  });

  it("retries a nudge for a row not yet due by the time until it is", async () => {
    const now = Date.now();
    const outboxId = await insertRow({ eventType: "printer_cancellation", nextAttemptAt: now + 90_000, now });
    const { env: quiet } = quietEnv();

    const result = await run([{ body: { outboxId }, id: "m1" }], quiet);

    expect(result.retries[0]?.delaySeconds).toBeGreaterThan(80);
    expect(result.retries[0]?.delaySeconds).toBeLessThanOrEqual(90);
  });

  it("is what the -outbox suffix routes to", async () => {
    const outboxId = await insertRow({ eventType: "printer_cancellation", now: Date.now() });
    const recorded: string[] = [];
    await handleOutboxQueueBatch(
      {
        messages: [
          {
            ack: () => recorded.push("ack"),
            attempts: 1,
            body: { outboxId },
            id: "x",
            retry: () => recorded.push("retry"),
            timestamp: new Date(),
          },
        ],
        queue: "chopshop-prod-outbox",
      } as unknown as MessageBatch<unknown>,
      quietEnv().env,
    );
    expect(recorded).toEqual(["ack"]);
  });

  it("reports the row's state for a nudge it cannot claim", async () => {
    const outboxId = await insertRow({ now: Date.now() });
    const { claim: held } = await claim(outboxId, Date.now());
    await complete(env.DB, held, { now: Date.now(), resultRef: null });

    expect(await processOutboxRowById(quietEnv().env, outboxId)).toEqual({ kind: "settled" });
    expect(await processOutboxRowById(quietEnv().env, "nope")).toEqual({ kind: "missing" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the 15-minute sweeper", () => {
  it("drains due rows inline and nudges the rest", async () => {
    const now = Date.now();
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      ids.push(await insertRow({ eventType: "printer_cancellation", now: now - 1_000 + index }));
    }
    const { env: quiet, nudges } = quietEnv();

    const summary = await runOutboxSweep(quiet, now);

    expect(summary.processed).toBe(10);
    const states = await Promise.all(ids.map(async (id) => (await outboxRow(id)).status));
    expect(states.filter((state) => state === "done")).toHaveLength(10);
    expect(nudges.sent).toEqual(ids.slice(10).map((outboxId) => ({ outboxId })));
  });

  it("settles a claim that expired on its last attempt: failed if never sent, unknown if it may have been", async () => {
    const now = Date.now();
    const never = await insertRow({ now });
    const maybe = await insertRow({ now });
    for (const id of [never, maybe]) {
      await env.DB.prepare("UPDATE outbox_events SET attempts = max_attempts - 1 WHERE outbox_id = ?")
        .bind(id)
        .run();
    }
    await claim(never, now);
    const sent = await claim(maybe, now);
    await markSubmitting(env.DB, sent.claim, { now });

    const summary = await runOutboxSweep(quietEnv().env, now + CLAIM_TTL_MS + 1);

    expect(summary.settled).toBe(2);
    expect(await outboxRow(never)).toMatchObject({ last_error: "attempts_exhausted", status: "failed" });
    expect(await outboxRow(maybe)).toMatchObject({ status: "unknown", unknown_since: now + CLAIM_TTL_MS + 1 });
    expect((await alertsFor(never)).map((alert) => alert.kind)).toEqual(["outbox_exhausted"]);
    expect((await alertsFor(maybe))[0]?.message).toContain("may have reached the receiver");
  });

  it("alerts once on a dispatch unknown for 30 minutes, not before", async () => {
    const now = Date.now();
    const outboxId = await insertRow({ eventType: "dispatch", now });
    const { claim: held } = await claim(outboxId, now);
    await markSubmitting(env.DB, held, { now });
    // Unknown, with automatic retries over (so the sweep does not re-run it).
    await markUnknown(env.DB, held, { backoffMs: 0, error: "network", now });
    await env.DB.prepare("UPDATE outbox_events SET cancel_requested = 1 WHERE outbox_id = ?")
      .bind(outboxId)
      .run();

    // (The sweep's clock runs on from `now`, hence a margin rather than -1 ms.)
    await runOutboxSweep(quietEnv().env, now + UNKNOWN_ALERT_AFTER_MS - 5_000);
    expect(await alertsFor(outboxId)).toHaveLength(0);

    await runOutboxSweep(quietEnv().env, now + UNKNOWN_ALERT_AFTER_MS);
    await runOutboxSweep(quietEnv().env, now + UNKNOWN_ALERT_AFTER_MS + 900_000);
    const alerts = await alertsFor(outboxId);
    expect(alerts.map((alert) => [alert.kind, alert.severity])).toEqual([
      ["dispatch_unknown_30m", "critical"],
    ]);
    expect(alerts[0]?.message).not.toMatch(/https?:/);
  });

  it("re-nudges the render container for a render job stuck in queued or on an expired lease", async () => {
    const now = Date.now();
    await env.DB.prepare("DELETE FROM render_jobs").run();
    const { env: quiet, renders } = quietEnv();

    expect((await runOutboxSweep(quiet, now)).renderNudged).toBe(false);

    const jobId = crypto.randomUUID();
    const objectId = crypto.randomUUID();
    const artworkId = crypto.randomUUID();
    const objectKey = `shops/${TENANT}/artwork_original/${objectId}/v1/motif.png`;
    const created = new Date(now - 10 * 60_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO stored_objects (object_id, tenant_id, bucket, object_key, kind,
           content_type, size_bytes, sha256, status, immutable, created_at, updated_at)
         VALUES (?, ?, 'private', ?, 'artwork_original', 'image/png', 10, ?, 'active', 0, ?, ?)`,
      ).bind(objectId, TENANT, objectKey, "a".repeat(64), now, now),
      env.DB.prepare(
        `INSERT INTO pod_artwork (artwork_id, tenant_id, original_object_id,
           profile_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'apparel_dtg', 'processing', ?, ?)`,
      ).bind(artworkId, TENANT, objectId, now, now),
      env.DB.prepare(
        `INSERT INTO render_jobs (id, tenant_id, artwork_id, version, attempt, state,
           input_key, input_bytes, profile_json, output_prefix, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, 'queued', ?, 10, '{}', ?, ?, ?)`,
      ).bind(jobId, TENANT, artworkId, objectKey, `pod/${TENANT}/render/${artworkId}/1/`, created, created),
    ]);

    expect((await runOutboxSweep(quiet, now)).renderNudged).toBe(true);
    expect(renders.sent).toEqual([{ renderJobId: jobId }]);
    await env.DB.prepare("DELETE FROM render_jobs").run();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("scheduled()", () => {
  it("runs the sweep for the 15-minute cron through the Worker's scheduled export", async () => {
    const outboxId = await insertRow({ eventType: "printer_cancellation", now: Date.now() - 1 });

    await worker.scheduled(
      { cron: OUTBOX_SWEEP_CRON, noRetry: () => undefined, scheduledTime: Date.now() } as ScheduledController,
      quietEnv().env,
    );

    expect((await outboxRow(outboxId)).status).toBe("done");
  });

  it("ignores a cron it does not know", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outboxId = await insertRow({ eventType: "printer_cancellation", now: Date.now() - 1 });

    await handleScheduled({ cron: "0 3 * * *", scheduledTime: Date.now() }, quietEnv().env);

    expect((await outboxRow(outboxId)).status).toBe("pending");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("runs CP2-A's reconciliation and retention AFTER the sweep, each isolated, and fails the invocation if one failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const order: string[] = [];
    const outboxId = await insertRow({ eventType: "printer_cancellation", now: Date.now() - 1 });
    setCommerceCronsLoader(() =>
      Promise.resolve({
        runReconciliation: async () => {
          order.push(`reconciliation:${(await outboxRow(outboxId)).status}`);
          throw new Error("stripe down");
        },
        runRetentionSweep: async () => {
          order.push("retention");
        },
      }),
    );

    await expect(
      handleScheduled({ cron: OUTBOX_SWEEP_CRON, scheduledTime: Date.now() }, quietEnv().env),
    ).rejects.toThrow(/runReconciliation/);
    expect(order).toEqual(["reconciliation:done", "retention"]);
  });

  it("still runs the commerce steps when the sweep itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ran: string[] = [];
    setCommerceCronsLoader(() =>
      Promise.resolve({ runReconciliation: async () => void ran.push("reconciliation") }),
    );
    const broken = { ...quietEnv().env, DB: undefined } as unknown as Env;

    await expect(
      handleScheduled({ cron: OUTBOX_SWEEP_CRON, scheduledTime: Date.now() }, broken),
    ).rejects.toThrow(/outbox_sweep/);
    expect(ran).toEqual(["reconciliation"]);
  });

  it("is wired to CP2-A's src/commerce/crons.ts by default", async () => {
    setCommerceCronsLoader(null);
    const crons = await loadCommerceCrons();
    expect(typeof crons?.runReconciliation).toBe("function");
    expect(typeof crons?.runRetentionSweep).toBe("function");
  });

  it("existsGuard/fenceGuard compose into a WHERE", () => {
    const guard = existsGuard(fenceGuard({ claimedBy: "t".repeat(36), outboxId: "o" }, 5));
    expect(guard.sql).toMatch(/^EXISTS \(SELECT 1 FROM outbox_events WHERE/);
    expect(guard.binds).toEqual(["o", "t".repeat(36), 5]);
  });
});
