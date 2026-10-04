import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { insertRenderJobStatement } from "../src/pod/render-jobs";

import { CANVAS_HOLD_UNTIL_MS, CANVAS_MAX_INPUT_BYTES, type CanvasSpec, SNAPWEAR_MAX_CANVAS_BYTES } from "../src/dispatch/print-canvas";
import {
  acquireCanvasJob,
  type CanvasJobLease,
  completeCanvasJob,
  ensureCanvasJobStatements,
  failCanvasJob,
  readLineCanvases,
} from "../src/pod/print-canvas-jobs";
import { outboxRow, quietEnv, seedOrder, seedTenant } from "./dispatch-fixtures";

/**
 * CP6-PS2 — the canvas job queue (src/pod/print-canvas-jobs.ts), driven
 * directly: ensure, acquire, complete, fail, the reaper, and the release of the
 * line's parked dispatch row in every settling batch.
 */

const TENANT = "tenant-canvas-jobs";
const MINUTE = 60_000;
const SPEC: CanvasSpec = {
  background: "transparent",
  canvasPx: { h: 5_787, w: 4_606 },
  dpi: 300,
  motifPx: { h: 4_708, w: 3_531 },
  offsetPx: { left: 537, top: 539 },
  sourcePx: { h: 4_724, w: 3_543 },
  version: 1,
};

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Made {
  dispatchId: string;
  jobIds: string[];
  orderId: string;
}

/** An order line parked for its canvases, with one queued job per slot. */
async function makeJobs(slots: Array<"back" | "front"> = ["front"], inputBytes = 10): Promise<Made> {
  const order = await seedOrder(TENANT, { lines: [{ printFiles: slots.map((slot) => ({ slot })) }] });
  const dispatchId = order.dispatchIds[0] as string;
  await env.DB.prepare("UPDATE outbox_events SET next_attempt_at = ? WHERE outbox_id = ?")
    .bind(CANVAS_HOLD_UNTIL_MS, dispatchId)
    .run();
  const { jobIds, statements } = ensureCanvasJobStatements(env.DB, {
    lineNo: 1,
    now: Date.now(),
    orderId: order.orderId,
    slots: slots.map((location) => ({
      inputBytes,
      inputKey: `pod/${TENANT}/print/motif-${location}.png`,
      inputSha256: "a".repeat(64),
      location,
      spec: SPEC,
    })),
    tenantId: TENANT,
  });
  await env.DB.batch(statements);
  return { dispatchId, jobIds, orderId: order.orderId };
}

async function acquire(at = Date.now()): Promise<CanvasJobLease> {
  const lease = await acquireCanvasJob(quietEnv().env, env.DB, at);
  if (lease === null) {
    throw new Error("nothing to acquire");
  }
  return lease;
}

async function putAttempt(lease: CanvasJobLease, text = `canvas ${lease.jobId}`) {
  const bytes = new TextEncoder().encode(text);
  const key = `${lease.outputPrefix}canvas.png`;
  await env.PRIVATE_BUCKET.put(key, bytes);
  return { bytes: bytes.length, key, sha256: await sha256Hex(bytes) };
}

function okBody(lease: CanvasJobLease, canvasPng: { bytes: number; key: string; sha256: string }) {
  return { attempt: lease.attempt, leaseToken: lease.leaseToken, ok: true, outputs: { canvasPng } };
}

async function job(jobId: string) {
  return env.DB.prepare(
    "SELECT state, attempt, error, canvas_sha256, canvas_bytes, canvas_key FROM print_canvas_jobs WHERE id = ?",
  )
    .bind(jobId)
    .first<{
      attempt: number;
      canvas_bytes: number | null;
      canvas_key: string;
      canvas_sha256: string | null;
      error: string | null;
      state: string;
    }>();
}

function released(row: { next_attempt_at: number }): boolean {
  return row.next_attempt_at !== CANVAS_HOLD_UNTIL_MS && row.next_attempt_at <= Date.now();
}

beforeAll(async () => {
  await seedTenant(TENANT);
});

// The acquire takes the oldest job of ANY test: settle whatever a test left.
afterEach(async () => {
  for (let i = 0; i < 20; i += 1) {
    const lease = await acquireCanvasJob(quietEnv().env, env.DB, Date.now());
    if (lease === null) {
      return;
    }
    await failCanvasJob(quietEnv().env, env.DB, lease.jobId, {
      attempt: lease.attempt,
      error: "test_cleanup",
      leaseToken: lease.leaseToken,
    }, Date.now());
  }
});

describe("ensure", () => {
  it("makes one row per slot once; a second ensure (another spec, another input) changes nothing", async () => {
    const made = await makeJobs(["front"]);
    const again = ensureCanvasJobStatements(env.DB, {
      lineNo: 1,
      now: Date.now(),
      orderId: made.orderId,
      slots: [{
        inputBytes: 99,
        inputKey: `pod/${TENANT}/print/other.png`,
        inputSha256: "b".repeat(64),
        location: "front",
        spec: { ...SPEC, dpi: 150 },
      }],
      tenantId: TENANT,
    });
    await env.DB.batch(again.statements);
    const canvases = await readLineCanvases(env.DB, TENANT, made.orderId, 1);
    expect(canvases).toEqual([
      {
        canvasKey: `pod/${TENANT}/print/orders/${made.orderId}/1-front.png`,
        canvasSha256: null,
        error: null,
        id: made.jobIds[0],
        inputKey: `pod/${TENANT}/print/motif-front.png`,
        inputSha256: "a".repeat(64),
        slot: "front",
        state: "queued",
      },
    ]);
  });
});

describe("acquire", () => {
  it("leases the oldest job with the canvas envelope: frozen spec, input sha256, presigned R2 URLs", async () => {
    const made = await makeJobs(["front"], 5_000);
    const lease = await acquire();
    expect(lease).toMatchObject({
      attempt: 1,
      contract: 1,
      input: { maxBytes: 5_000, sha256: "a".repeat(64) },
      jobId: made.jobIds[0],
      jobType: "pod.print_canvas",
      outputPrefix: `pod/${TENANT}/render/canvas/${made.orderId}/1/front/attempt-1/`,
      spec: SPEC,
    });
    expect(lease.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const url of [lease.input.url, lease.output.canvasPngPutUrl]) {
      expect(new URL(url).hostname.endsWith(".r2.cloudflarestorage.com")).toBe(true);
    }
    expect(lease.input.url).toContain(encodeURI(`motif-front.png`));
    expect(decodeURIComponent(lease.output.canvasPngPutUrl)).toContain(`${lease.outputPrefix}canvas.png`);
  });

  it("caps the input download at the canvas ceiling", async () => {
    await makeJobs(["front"], CANVAS_MAX_INPUT_BYTES + 1);
    expect((await acquire()).input.maxBytes).toBe(CANVAS_MAX_INPUT_BYTES);
  });

  it("answers null when nothing waits", async () => {
    expect(await acquireCanvasJob(quietEnv().env, env.DB, Date.now())).toBeNull();
  });
});

describe("complete", () => {
  it("promotes the canvas, records its sha256 and bytes, releases the parked dispatch row and nudges it", async () => {
    const made = await makeJobs(["front"]);
    const lease = await acquire();
    const output = await putAttempt(lease);
    const quiet = quietEnv();
    const result = await completeCanvasJob(quiet.env, env.DB, lease.jobId, okBody(lease, output), Date.now());
    expect(result).toEqual({ status: "completed" });

    const row = await job(lease.jobId);
    expect(row).toMatchObject({ canvas_bytes: output.bytes, canvas_sha256: output.sha256, error: null, state: "completed" });
    const canonical = await env.PRIVATE_BUCKET.head(row?.canvas_key ?? "");
    expect(canonical?.checksums.toJSON().sha256).toBe(output.sha256);
    expect(await env.PRIVATE_BUCKET.head(output.key)).toBeNull();
    expect(released(await outboxRow(made.dispatchId))).toBe(true);
    expect(quiet.nudges.sent).toEqual([{ outboxId: made.dispatchId }]);

    // The same report again (an answer lost on the way back) is answered alike.
    expect(await completeCanvasJob(quiet.env, env.DB, lease.jobId, okBody(lease, output), Date.now())).toEqual({
      status: "completed",
    });
  });

  it("releases the dispatch row only when the LAST canvas of the line is made", async () => {
    const made = await makeJobs(["front", "back"]);
    const first = await acquire();
    await completeCanvasJob(quietEnv().env, env.DB, first.jobId, okBody(first, await putAttempt(first)), Date.now());
    expect((await outboxRow(made.dispatchId)).next_attempt_at).toBe(CANVAS_HOLD_UNTIL_MS);
    const second = await acquire();
    await completeCanvasJob(quietEnv().env, env.DB, second.jobId, okBody(second, await putAttempt(second)), Date.now());
    expect(released(await outboxRow(made.dispatchId))).toBe(true);
  });

  it("a refusal (ok:false) ends the job at once with its code and releases the row even with a sibling pending", async () => {
    const made = await makeJobs(["front", "back"]);
    const lease = await acquire();
    const result = await completeCanvasJob(quietEnv().env, env.DB, lease.jobId, {
      attempt: lease.attempt,
      leaseToken: lease.leaseToken,
      ok: false,
      reasons: [{ code: "input_mismatch", message: "the downloaded file is not the frozen print master" }],
    }, Date.now());
    expect(result).toEqual({ status: "refused" });
    expect(await job(lease.jobId)).toMatchObject({ canvas_sha256: null, error: "input_mismatch", state: "failed" });
    expect(released(await outboxRow(made.dispatchId))).toBe(true);
  });

  it("C3 size: a canvas over SNAPWEAR_MAX_CANVAS_BYTES is never promoted; the job fails and the row is released", async () => {
    const made = await makeJobs(["front"]);
    const lease = await acquire();
    const output = await putAttempt(lease);
    const result = await completeCanvasJob(quietEnv().env, env.DB, lease.jobId, okBody(lease, {
      ...output,
      bytes: SNAPWEAR_MAX_CANVAS_BYTES + 1,
    }), Date.now());
    expect(result).toEqual({ status: "too_large" });
    const row = await job(lease.jobId);
    expect(row).toMatchObject({ error: "print_canvas_too_large", state: "failed" });
    expect(await env.PRIVATE_BUCKET.head(row?.canvas_key ?? "")).toBeNull();
    expect(released(await outboxRow(made.dispatchId))).toBe(true);
  });

  it("an output that is not there requeues the attempt; the third such attempt ends the job and releases the row", async () => {
    const made = await makeJobs(["front"]);
    for (const attempt of [1, 2, 3]) {
      const lease = await acquire();
      expect(lease.attempt).toBe(attempt);
      const result = await completeCanvasJob(quietEnv().env, env.DB, lease.jobId, okBody(lease, {
        bytes: 9,
        key: `${lease.outputPrefix}canvas.png`,
        sha256: "c".repeat(64),
      }), Date.now());
      expect(result).toEqual({ status: "outputs_unverified" });
      expect((await job(lease.jobId))?.state).toBe(attempt < 3 ? "queued" : "failed");
      expect(released(await outboxRow(made.dispatchId))).toBe(attempt === 3);
    }
  });

  it("a different canvas already at the canonical key is a conflict, never overwritten", async () => {
    const made = await makeJobs(["front"]);
    const lease = await acquire();
    const canonicalKey = `pod/${TENANT}/print/orders/${made.orderId}/1-front.png`;
    await env.PRIVATE_BUCKET.put(canonicalKey, new TextEncoder().encode("someone else's canvas"));
    const result = await completeCanvasJob(quietEnv().env, env.DB, lease.jobId, okBody(lease, await putAttempt(lease)), Date.now());
    expect(result).toEqual({ status: "canonical_conflict" });
    expect(await job(lease.jobId)).toMatchObject({ error: "canonical_conflict", state: "failed" });
    expect(await (await env.PRIVATE_BUCKET.get(canonicalKey))?.text()).toBe("someone else's canvas");
  });

  it("refuses bodies that point elsewhere or carry other keys, leaving the lease as it was", async () => {
    await makeJobs(["front"]);
    const lease = await acquire();
    const output = await putAttempt(lease);
    const bad: unknown[] = [
      okBody(lease, { ...output, key: `pod/${TENANT}/print/orders/x/1-front.png` }),
      okBody(lease, { ...output, sha256: "Z".repeat(64) }),
      { ...okBody(lease, output), outputs: { canvasPng: output, extra: output } },
      { ...okBody(lease, output), fields: {} },
      { ...okBody(lease, output), reasons: [] },
      { attempt: lease.attempt, leaseToken: lease.leaseToken, ok: false, reasons: [{ code: "has space" }] },
      { attempt: lease.attempt, leaseToken: lease.leaseToken, ok: false, reasons: [] },
    ];
    for (const body of bad) {
      expect(await completeCanvasJob(quietEnv().env, env.DB, lease.jobId, body, Date.now())).toEqual({ status: "invalid" });
    }
    expect((await job(lease.jobId))?.state).toBe("leased");
    // A wrong token is stale, and an unknown job is not found.
    expect(await completeCanvasJob(quietEnv().env, env.DB, lease.jobId, { ...okBody(lease, output), leaseToken: "x".repeat(43) }, Date.now())).toEqual({ status: "stale" });
    expect(await completeCanvasJob(quietEnv().env, env.DB, crypto.randomUUID(), okBody(lease, output), Date.now())).toEqual({ status: "not_found" });
    expect(await completeCanvasJob(quietEnv().env, env.DB, lease.jobId, okBody(lease, output), Date.now())).toEqual({ status: "completed" });
  });
});

describe("fail and the reaper", () => {
  it("a failed attempt requeues; on the last attempt the job ends and the row is released", async () => {
    const made = await makeJobs(["front"]);
    for (const attempt of [1, 2, 3]) {
      const lease = await acquire();
      const result = await failCanvasJob(quietEnv().env, env.DB, lease.jobId, {
        attempt: lease.attempt,
        error: "pipeline_crashed",
        leaseToken: lease.leaseToken,
      }, Date.now());
      expect(result).toEqual({ status: attempt < 3 ? "queued" : "failed" });
      expect(released(await outboxRow(made.dispatchId))).toBe(attempt === 3);
    }
    expect(await job(made.jobIds[0] as string)).toMatchObject({ attempt: 3, error: "pipeline_crashed", state: "failed" });
  });

  it("an expired lease on the last attempt is ended by the next acquire, which releases the row", async () => {
    const made = await makeJobs(["front"]);
    const now = Date.now();
    for (const at of [now - 40 * MINUTE, now - 29 * MINUTE, now - 18 * MINUTE]) {
      await acquire(at);
    }
    expect((await job(made.jobIds[0] as string))?.attempt).toBe(3);
    const quiet = quietEnv();
    expect(await acquireCanvasJob(quiet.env, env.DB, now)).toBeNull();
    expect(await job(made.jobIds[0] as string)).toMatchObject({ error: "lease_expired", state: "failed" });
    expect(released(await outboxRow(made.dispatchId))).toBe(true);
    expect(quiet.nudges.sent).toEqual([{ outboxId: made.dispatchId }]);
  });

  it("refuses an invalid failure report", async () => {
    await makeJobs(["front"]);
    const lease = await acquire();
    for (const body of [
      { attempt: lease.attempt, error: "has space", leaseToken: lease.leaseToken },
      { attempt: lease.attempt, leaseToken: lease.leaseToken },
      { attempt: 4, error: "x", leaseToken: lease.leaseToken },
    ]) {
      expect(await failCanvasJob(quietEnv().env, env.DB, lease.jobId, body, Date.now())).toEqual({ status: "invalid" });
    }
  });
});

// ── the /v1/render routes ───────────────────────────────────────────────────

const API = "https://api.canvasjobs.test";
let ipCounter = 0;

async function call(path: string, body?: string | Record<string, unknown>): Promise<Response> {
  ipCounter += 1;
  return worker.fetch(
    new Request(`${API}${path}`, {
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      headers: {
        authorization: `Bearer ${env.RENDER_FARM_TOKEN}`,
        "cf-connecting-ip": `198.51.100.${ipCounter % 250}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method: "POST",
    }),
    quietEnv().env,
  );
}

const BOTH = { jobTypes: ["pod.process_artwork", "pod.print_canvas"] };

async function seedArtworkJob(): Promise<string> {
  const objectId = crypto.randomUUID();
  const artworkId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const objectKey = `shops/${TENANT}/artwork_original/${objectId}/v1/motif.png`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stored_objects (object_id, tenant_id, bucket, object_key, kind,
         content_type, size_bytes, sha256, status, immutable, created_at, updated_at)
       VALUES (?, ?, 'private', ?, 'artwork_original', 'image/png', 1000, ?, 'active', 0, ?, ?)`,
    ).bind(objectId, TENANT, objectKey, "a".repeat(64), Date.now(), Date.now()),
    env.DB.prepare(
      `INSERT INTO pod_artwork (artwork_id, tenant_id, original_object_id,
         profile_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'apparel_dtg', 'processing', ?, ?)`,
    ).bind(artworkId, TENANT, objectId, Date.now(), Date.now()),
    insertRenderJobStatement(env.DB, {
      artworkId,
      inputBytes: 1000,
      inputKey: objectKey,
      jobId,
      now: Date.now(),
      profile: {
        accepted_formats: [{ ext: "png" }],
        id: "apparel_dtg",
        max_file_mb: 50,
        min_dpi: 300,
        print_area_mm: { h: 400, w: 300 },
      },
      tenantId: TENANT,
    }),
  ]);
  return jobId;
}

describe("the /v1/render routes (CP6-PS2)", () => {
  it("an acquire without a body (every older container image) is never handed a canvas job", async () => {
    await makeJobs(["front"]);
    const response = await call("/v1/render/jobs/acquire");
    expect(response.status).toBe(204);
    const asArtworkOnly = await call("/v1/render/jobs/acquire", { jobTypes: ["pod.process_artwork"] });
    expect(asArtworkOnly.status).toBe(204);
  });

  it("an acquire naming canvases gets one, and artwork jobs go first", async () => {
    const made = await makeJobs(["front"]);
    const artworkJobId = await seedArtworkJob();
    const first = (await (await call("/v1/render/jobs/acquire", BOTH)).json()) as { jobId: string; jobType: string };
    expect(first).toMatchObject({ jobId: artworkJobId, jobType: "pod.process_artwork" });
    await env.DB.prepare("UPDATE render_jobs SET state = 'failed', error = 'test' WHERE id = ?").bind(artworkJobId).run();
    const second = (await (await call("/v1/render/jobs/acquire", BOTH)).json()) as { jobId: string; jobType: string };
    expect(second).toMatchObject({ jobId: made.jobIds[0], jobType: "pod.print_canvas" });
  });

  it("refuses a malformed acquire body with 400 and leases nothing", async () => {
    const made = await makeJobs(["front"]);
    for (const body of [
      "{",
      "[]",
      JSON.stringify({ jobTypes: [] }),
      JSON.stringify({ jobTypes: ["pod.other"] }),
      JSON.stringify({ jobTypes: ["pod.print_canvas", "pod.print_canvas"] }),
      JSON.stringify({ jobTypes: ["pod.print_canvas"], extra: 1 }),
      JSON.stringify({ jobTypes: "pod.print_canvas" }),
      JSON.stringify({ jobTypes: ["pod.print_canvas"], pad: "x".repeat(2_000) }),
    ]) {
      expect((await call("/v1/render/jobs/acquire", body)).status, body.slice(0, 40)).toBe(400);
    }
    expect((await job(made.jobIds[0] as string))?.state).toBe("queued");
  });

  it("maps canvas reports to the container's answers; an artwork report path never touches a canvas job", async () => {
    const made = await makeJobs(["front"]);
    const lease = (await (await call("/v1/render/jobs/acquire", { jobTypes: ["pod.print_canvas"] })).json()) as CanvasJobLease;
    const output = await putAttempt(lease);
    // The artwork path does not know this id.
    expect((await call(`/v1/render/jobs/${lease.jobId}/complete`, okBody(lease, output))).status).toBe(404);
    expect((await call(`/v1/render/canvas-jobs/${lease.jobId}/complete`, { attempt: 1 })).status).toBe(400);
    expect((await call(`/v1/render/canvas-jobs/${crypto.randomUUID()}/complete`, okBody(lease, output))).status).toBe(404);
    const done = await call(`/v1/render/canvas-jobs/${lease.jobId}/complete`, okBody(lease, output));
    expect(done.status).toBe(200);
    await expect(done.json()).resolves.toEqual({ status: "completed" });
    expect(released(await outboxRow(made.dispatchId))).toBe(true);
    // Late, with another token: the lease is lost.
    const late = await call(`/v1/render/canvas-jobs/${lease.jobId}/fail`, {
      attempt: 1,
      error: "pipeline_crashed",
      leaseToken: "y".repeat(43),
    });
    expect(late.status).toBe(409);
  });

  it("a refusal is answered 200 failed, a failure 200 queued, an unverifiable output 422", async () => {
    await makeJobs(["front"]);
    await makeJobs(["front"]);
    const take = async () =>
      (await (await call("/v1/render/jobs/acquire", { jobTypes: ["pod.print_canvas"] })).json()) as CanvasJobLease;
    const a = await take();
    const refused = await call(`/v1/render/canvas-jobs/${a.jobId}/complete`, {
      attempt: a.attempt,
      leaseToken: a.leaseToken,
      ok: false,
      reasons: [{ code: "dims_mismatch" }],
    });
    await expect(refused.json()).resolves.toEqual({ status: "failed" });
    const b = await take();
    const unverified = await call(`/v1/render/canvas-jobs/${b.jobId}/complete`, okBody(b, {
      bytes: 3,
      key: `${b.outputPrefix}canvas.png`,
      sha256: "d".repeat(64),
    }));
    expect(unverified.status).toBe(422);
    const b2 = await take();
    expect(b2.jobId).toBe(b.jobId);
    const failed = await call(`/v1/render/canvas-jobs/${b2.jobId}/fail`, {
      attempt: b2.attempt,
      error: "input_fetch_failed",
      leaseToken: b2.leaseToken,
    });
    await expect(failed.json()).resolves.toEqual({ status: "queued" });
  });
});
