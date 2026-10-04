import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { insertRenderJobStatement, RENDER_JOB_LEASE_MS } from "../src/pod/render-jobs";
import { WAKE_RETRY_DELAY_SECONDS } from "../src/pod/render-jobs-queue";
import {
  classifyHealth,
  type ContainerHealth,
  RenderLifecycle,
} from "../src/render/lifecycle";
import {
  RENDER_CONTAINER_INSTANCE,
  renderContainerEnvVars,
} from "../src/render/render-container";
import {
  ACQUIRE_BODY,
  API_LEASE_MS,
  CANVAS_JOB_TYPE as CONTAINER_CANVAS_JOB_TYPE,
  CANVAS_MAX_INPUT_BYTES as CONTAINER_CANVAS_MAX_INPUT_BYTES,
  canvasCompletionBody,
  canvasOutputKey,
  canvasReportPath,
  completionBody,
  failureBody,
  JOB_TYPE as CONTAINER_JOB_TYPE,
  outputKeys,
  parseCanvasLease,
  parseLease,
} from "../render/src/contract";
import { CANVAS_MAX_INPUT_BYTES } from "../src/dispatch/print-canvas";
import { CANVAS_JOB_TYPE, ensureCanvasJobStatements } from "../src/pod/print-canvas-jobs";
import { JOB_TYPE } from "../src/pod/render-farm-client";
import { seedOrder, seedTenant } from "./dispatch-fixtures";

/**
 * CP1-D, the Worker's half of the render container:
 *   1. the -render-jobs consumer wakes the container (fake Durable Object
 *      namespace — a Container DO cannot be instantiated without the
 *      containers runtime, which the pool does not have);
 *   2. the container's env contract;
 *   3. THE CROSS-PACKAGE CONTRACT: the container's own wire module
 *      (render/src/contract.ts) parses the REAL acquire response and its report
 *      bodies are accepted by the REAL complete / fail routes. A drift between
 *      the two deploy units fails here.
 */

function envWith(overrides: Record<PropertyKey, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

interface Recorded {
  acks: string[];
  retries: Array<{ delaySeconds?: number; id: string }>;
}

async function deliver(messages: Array<{ body: unknown; id: string }>, targetEnv: Env): Promise<Recorded> {
  const recorded: Recorded = { acks: [], retries: [] };
  const batch = {
    ackAll() {
      throw new Error("never acks a whole batch");
    },
    messages: messages.map((message) => ({
      ack: () => recorded.acks.push(message.id),
      attempts: 1,
      body: message.body,
      id: message.id,
      retry: (options?: QueueRetryOptions) => recorded.retries.push({ id: message.id, ...options }),
      timestamp: new Date(),
    })),
    queue: "chopshop-stg-render-jobs",
    retryAll() {
      throw new Error("never holds the batch");
    },
  } as unknown as MessageBatch<unknown>;
  await worker.queue(batch, targetEnv);
  return recorded;
}

function fakeNamespace(wake: () => Promise<unknown> = async () => ({ polling: true, startMs: 1 })) {
  const calls: string[] = [];
  const namespace = {
    get(id: { name: string }) {
      calls.push(`get:${id.name}`);
      return {
        async wake() {
          calls.push("wake");
          return wake();
        },
      };
    },
    idFromName(name: string) {
      calls.push(`idFromName:${name}`);
      return { name };
    },
  };
  return { calls, namespace };
}

const nudge = () => ({ renderJobId: crypto.randomUUID() });

describe("the -render-jobs consumer wakes the render container", () => {
  it("wakes the singleton ONCE per batch and acks every message", async () => {
    const { calls, namespace } = fakeNamespace();
    const result = await deliver(
      [
        { body: nudge(), id: "a" },
        { body: nudge(), id: "b" },
        { body: { renderJobId: "x", secret: "should-not-appear" }, id: "bad" },
      ],
      envWith({ RENDER_CONTAINER: namespace }),
    );
    expect(calls).toStrictEqual([`idFromName:${RENDER_CONTAINER_INSTANCE}`, "get:render", "wake"]);
    expect(result.acks.sort()).toStrictEqual(["a", "b", "bad"]);
    expect(result.retries).toStrictEqual([]);
  });

  it("without the binding it acks and logs container_not_bound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await deliver([{ body: nudge(), id: "a" }], envWith({ RENDER_CONTAINER: undefined }));
    expect(result).toStrictEqual({ acks: ["a"], retries: [] });
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("container_not_bound");
    warn.mockRestore();
  });

  it("does not start a container when /v1/render is dark here (render_not_configured)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { calls, namespace } = fakeNamespace();
    const result = await deliver(
      [{ body: nudge(), id: "a" }],
      envWith({ RENDER_CONTAINER: namespace, RENDER_FARM_TOKEN: "too-short-for-the-pull-surface" }),
    );
    expect(calls).toStrictEqual([]);
    expect(result).toStrictEqual({ acks: ["a"], retries: [] });
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("render_not_configured");
    warn.mockRestore();
  });

  it("retries the nudges (never the malformed) when the wake fails, and logs no body", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { namespace } = fakeNamespace(async () => {
      throw new Error("There is no Container instance available at this time");
    });
    const result = await deliver(
      [
        { body: nudge(), id: "a" },
        { body: "should-not-appear", id: "bad" },
      ],
      envWith({ RENDER_CONTAINER: namespace }),
    );
    expect(result).toStrictEqual({
      acks: ["bad"],
      retries: [{ delaySeconds: WAKE_RETRY_DELAY_SECONDS, id: "a" }],
    });
    const logged = [...error.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join("\n");
    expect(logged).toContain("render container wake failed");
    expect(logged).not.toContain("should-not-appear");
    error.mockRestore();
    warn.mockRestore();
  });
});

describe("the container's environment", () => {
  it("is the API's canonical origin, the farm token and the loop settings", () => {
    expect(renderContainerEnvVars(env as unknown as Env)).toStrictEqual({
      IDLE_EXIT_SECONDS: "120",
      MAX_CONCURRENT_JOBS: "1",
      RENDER_API_URL: "https://api.test.invalid",
      RENDER_FARM_TOKEN: env.RENDER_FARM_TOKEN,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a farm token under 32 characters", { RENDER_FARM_TOKEN: "x".repeat(31) }],
    ["no farm token", { RENDER_FARM_TOKEN: undefined }],
    ["malformed canonical origins", { CANONICAL_ORIGINS: { api: "http://api.test.invalid", web: "https://web.test.invalid" } }],
  ])("is null (the container is never started) with %s", (_label, overrides) => {
    expect(renderContainerEnvVars(envWith(overrides))).toBeNull();
  });
});

// ── the cross-package contract ──────────────────────────────────────────────

const API = "https://api.rendercontainer.test";
const TENANT = "tenant-rendercontainer";
const SEED_NOW = 1_700_000_000_000;
const PROFILE = {
  accepted_formats: [{ ext: "png" }, { ext: "jpg" }],
  id: "apparel_dtg",
  max_file_mb: 50,
  min_dpi: 300,
  print_area_mm: { h: 400, w: 300 },
};
let ipCounter = 0;

async function seedJob(): Promise<{ artworkId: string; jobId: string }> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tenants (tenant_id, status, shop_name, default_locale,
       default_currency, created_at, updated_at)
     VALUES (?, 'active', 'Render container shop', 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(TENANT, SEED_NOW, SEED_NOW)
    .run();

  const objectId = crypto.randomUUID();
  const artworkId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const objectKey = `shops/${TENANT}/artwork_original/${objectId}/v1/motif.png`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stored_objects (object_id, tenant_id, bucket, object_key, kind,
         content_type, size_bytes, sha256, status, immutable, created_at, updated_at)
       VALUES (?, ?, 'private', ?, 'artwork_original', 'image/png', 1000, ?, 'active', 0, ?, ?)`,
    ).bind(objectId, TENANT, objectKey, "a".repeat(64), SEED_NOW, SEED_NOW),
    env.DB.prepare(
      `INSERT INTO pod_artwork (artwork_id, tenant_id, original_object_id,
         profile_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'apparel_dtg', 'processing', ?, ?)`,
    ).bind(artworkId, TENANT, objectId, SEED_NOW, SEED_NOW),
    insertRenderJobStatement(env.DB, {
      artworkId,
      inputBytes: 1000,
      inputKey: objectKey,
      jobId,
      now: Date.now(),
      profile: PROFILE,
      tenantId: TENANT,
    }),
  ]);
  return { artworkId, jobId };
}

async function call(path: string, body?: unknown): Promise<Response> {
  ipCounter += 1;
  return worker.fetch(
    new Request(`${API}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization: `Bearer ${env.RENDER_FARM_TOKEN}`,
        "cf-connecting-ip": `203.0.113.${ipCounter % 250}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method: "POST",
    }),
    env,
  );
}

async function acquireLease() {
  const response = await call("/v1/render/jobs/acquire");
  expect(response.status).toBe(200);
  const parsed = parseLease(await response.json());
  if (!parsed.ok) {
    throw new Error("the container refused the API's own acquire response");
  }
  return parsed.lease;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("the container's wire module against the real /v1/render routes", () => {
  it("parses the real acquire (real SigV4 URLs on the EU host) and a success completes the job", async () => {
    const { artworkId, jobId } = await seedJob();
    const lease = await acquireLease();
    expect(lease.jobId).toBe(jobId);
    expect(new URL(lease.inputUrl).hostname).toMatch(/\.eu\.r2\.cloudflarestorage\.com$/);

    // The container would PUT these through the presigned URLs; here they go
    // straight into the bucket at the attempt keys the lease names.
    const print = new TextEncoder().encode("print-bytes-from-the-container");
    const preview = new TextEncoder().encode("preview-bytes");
    const keys = outputKeys(lease.outputPrefix);
    await env.PRIVATE_BUCKET.put(keys.printKey, print);
    await env.PRIVATE_BUCKET.put(keys.previewKey, preview);

    const response = await call(
      `/v1/render/jobs/${lease.jobId}/complete`,
      completionBody(
        lease,
        {
          meta: {
            effectiveDpi: 325,
            heightPx: 3200,
            maxPrintMm: { h: 300, w: 300 },
            pipelineVersion: 1,
            profileId: "apparel_dtg",
            widthPx: 3200,
          },
          notices: [{ code: "opaque", message: "Bilden saknar transparent bakgrund" }],
          ok: true,
          outputs: {
            previewWebp: { bytes: preview.length, sha256: await sha256Hex(preview) },
            printPng: { bytes: print.length, sha256: await sha256Hex(print) },
          },
        },
        { peakRssMb: 812, wallMs: 41_250 },
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ status: "completed" });

    const artwork = await env.DB.prepare(
      "SELECT status, effective_dpi, print_sha256 FROM pod_artwork WHERE artwork_id = ?",
    )
      .bind(artworkId)
      .first<{ effective_dpi: number; print_sha256: string; status: string }>();
    expect(artwork).toStrictEqual({
      effective_dpi: 325,
      print_sha256: await sha256Hex(print),
      status: "ready",
    });
  });

  it("a rejection completes the job with the reasons", async () => {
    const { artworkId } = await seedJob();
    const lease = await acquireLease();
    const response = await call(
      `/v1/render/jobs/${lease.jobId}/complete`,
      completionBody(
        lease,
        { ok: false, reasons: [{ code: "resolution_too_low", message: "Motivet är 900 × 900 px." }] },
        { wallMs: 900 },
      ),
    );
    expect(response.status).toBe(200);
    const artwork = await env.DB.prepare("SELECT status FROM pod_artwork WHERE artwork_id = ?")
      .bind(artworkId)
      .first<{ status: string }>();
    expect(artwork?.status).toBe("rejected");
  });

  it("every failure code the container sends is accepted and requeues the job", async () => {
    for (const code of [
      "completion_invalid",
      "input_fetch_failed",
      "input_too_large",
      "invalid_envelope",
      "output_put_failed",
      "pipeline_crashed",
    ] as const) {
      const { jobId } = await seedJob();
      const lease = await acquireLease();
      expect(lease.jobId).toBe(jobId);
      const response = await call(`/v1/render/jobs/${lease.jobId}/fail`, failureBody(lease, code));
      expect(response.status, code).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({ status: "queued" });
      // Park it so the next iteration's acquire gets the next seeded job.
      await env.DB.prepare("UPDATE render_jobs SET state = 'failed', error = 'test' WHERE id = ?")
        .bind(jobId)
        .run();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Codex fixes. The Durable Object's wake / sleep decisions (src/render/lifecycle.ts),
// against a FAKE container: the pool has no Containers runtime.

interface FakeContainer {
  armed: boolean;
  destroys: number;
  draining: boolean;
  starts: number;
  stops: number;
}

function newFakeContainer(): FakeContainer {
  return { armed: false, destroys: 0, draining: false, starts: 0, stops: 0 };
}

function wakeOps(container: FakeContainer, options: { startGate?: Promise<void> } = {}) {
  return {
    async postWake(): Promise<Response> {
      if (!container.draining) {
        container.armed = true;
      }
      return Response.json({ ok: !container.draining, polling: container.armed });
    },
    async start(): Promise<void> {
      container.starts += 1;
      await options.startGate;
    },
  };
}

/**
 * /healthz whose answer is OBSERVED when asked but DELIVERED only when the gate
 * opens — the stale answer Codex described.
 */
function expiryOps(container: FakeContainer, gate?: Promise<void>) {
  return {
    async destroy(): Promise<void> {
      container.destroys += 1;
    },
    async health(): Promise<ContainerHealth> {
      const observed: ContainerHealth = container.armed ? "busy" : "idle";
      await gate;
      return observed;
    },
    async stop(): Promise<void> {
      container.stops += 1;
      container.armed = false;
      container.draining = true;
    },
  };
}

function gate(): { open: () => void; promise: Promise<void> } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

describe("the sleep decision (Codex P2: a stale health answer must not stop)", () => {
  it("a health answer delayed ACROSS a wake is discarded: the re-armed container keeps running", async () => {
    const lifecycle = new RenderLifecycle();
    const container = newFakeContainer();
    const healthGate = gate();

    // /healthz is asked while the loop is idle (it will answer "idle")...
    const expiring = lifecycle.expire(expiryOps(container, healthGate.promise));
    // ...a nudge wakes and re-arms it before that answer arrives...
    await expect(lifecycle.wake(wakeOps(container))).resolves.toMatchObject({ polling: true });
    expect(container.armed).toBe(true);
    // ...then the stale "idle" is delivered.
    healthGate.open();

    await expect(expiring).resolves.toBe("keep");
    expect(container.stops).toBe(0);
    expect(container.armed).toBe(true);
  });

  it("a wake still in flight when the answer arrives also keeps it", async () => {
    const lifecycle = new RenderLifecycle();
    const container = newFakeContainer();
    const startGate = gate();
    const waking = lifecycle.wake(wakeOps(container, { startGate: startGate.promise }));

    await expect(lifecycle.expire(expiryOps(container))).resolves.toBe("keep");
    expect(container.stops).toBe(0);

    startGate.open();
    await waking;
    expect(container.armed).toBe(true);
  });

  it("with no wake in between, an idle container is stopped (the control case)", async () => {
    const lifecycle = new RenderLifecycle();
    const container = newFakeContainer();
    await expect(lifecycle.expire(expiryOps(container))).resolves.toBe("stop");
    expect(container.stops).toBe(1);
  });

  it("a busy container is kept; two unanswered checks in a row destroy it", async () => {
    const lifecycle = new RenderLifecycle();
    const container = newFakeContainer();
    container.armed = true;
    await expect(lifecycle.expire(expiryOps(container))).resolves.toBe("keep");

    const unanswered = {
      ...expiryOps(container),
      health: async (): Promise<ContainerHealth> => "unanswered",
    };
    await expect(lifecycle.expire(unanswered)).resolves.toBe("stop");
    await expect(lifecycle.expire(unanswered)).resolves.toBe("destroy");
    expect(container.destroys).toBe(1);
  });

  it.each<[string, boolean, unknown, ContainerHealth]>([
    ["polling", true, { inFlight: 0, leaseHoldMs: 0, polling: true }, "busy"],
    ["a job in flight", true, { inFlight: 1, leaseHoldMs: 0, polling: false }, "busy"],
    // Codex P1: a container holding for a possibly-leased job is busy.
    ["a lease hold", true, { inFlight: 0, leaseHoldMs: 30_000, polling: false }, "busy"],
    ["nothing", true, { inFlight: 0, leaseHoldMs: 0, polling: false }, "idle"],
    ["a non-200", false, { polling: true }, "unanswered"],
    ["a non-object", true, "yes", "unanswered"],
  ])("classifies /healthz with %s as %s", (_label, ok, body, expected) => {
    expect(classifyHealth(ok, body)).toBe(expected);
  });
});

describe("a draining container is not woken (Codex P2)", () => {
  it("/wake answering 200 with polling:false is a wake FAILURE", async () => {
    const lifecycle = new RenderLifecycle();
    const container = newFakeContainer();
    container.draining = true;
    await expect(lifecycle.wake(wakeOps(container))).rejects.toThrow("render_wake_not_polling");
  });

  it.each<[string, () => Response]>([
    ["a non-200", () => new Response("no", { status: 503 })],
    ["an unreadable body", () => new Response("{", { status: 200 })],
    ["no polling field", () => Response.json({ ok: true })],
  ])("%s is a wake failure too", async (_label, answer) => {
    const lifecycle = new RenderLifecycle();
    await expect(
      lifecycle.wake({ postWake: async () => answer(), start: async () => undefined }),
    ).rejects.toThrow(/render_wake_/);
  });

  it("so the consumer RETRIES the nudges instead of acking them", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lifecycle = new RenderLifecycle();
    const container = newFakeContainer();
    container.draining = true;
    const { namespace } = fakeNamespace(() => lifecycle.wake(wakeOps(container)));

    const result = await deliver(
      [{ body: nudge(), id: "a" }, { body: nudge(), id: "b" }],
      envWith({ RENDER_CONTAINER: namespace }),
    );
    expect(result.acks).toStrictEqual([]);
    expect(result.retries.map((retry) => retry.id).sort()).toStrictEqual(["a", "b"]);
    expect(result.retries.every((retry) => retry.delaySeconds === WAKE_RETRY_DELAY_SECONDS)).toBe(true);
    error.mockRestore();
  });
});

describe("the container's assumed lease matches the API's", () => {
  it("API_LEASE_MS (render/src/contract.ts) === RENDER_JOB_LEASE_MS (src/pod/render-jobs.ts)", () => {
    expect(API_LEASE_MS).toBe(RENDER_JOB_LEASE_MS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CP6-PS2: the canvas job through the container's own wire module.
// ═══════════════════════════════════════════════════════════════════════════

describe("the canvas job: the container's wire module against the real routes", () => {
  const CANVAS_TENANT = "tenant-rendercontainer-canvas";

  async function seedCanvasJob(): Promise<{ jobId: string; orderId: string }> {
    await seedTenant(CANVAS_TENANT);
    const order = await seedOrder(CANVAS_TENANT);
    const { jobIds, statements } = ensureCanvasJobStatements(env.DB, {
      lineNo: 1,
      now: Date.now(),
      orderId: order.orderId,
      slots: [{
        inputBytes: 1234,
        inputKey: `pod/${CANVAS_TENANT}/print/motif.png`,
        inputSha256: "a".repeat(64),
        location: "front",
        spec: {
          background: "transparent",
          canvasPx: { h: 5_787, w: 4_606 },
          dpi: 300,
          motifPx: { h: 4_134, w: 2_953 },
          offsetPx: { left: 826, top: 826 },
          sourcePx: { h: 4_134, w: 2_953 },
          version: 1,
        },
      }],
      tenantId: CANVAS_TENANT,
    });
    await env.DB.batch(statements);
    return { jobId: jobIds[0] as string, orderId: order.orderId };
  }

  it("pins the two deploy units' shared values equal", () => {
    expect(CONTAINER_JOB_TYPE).toBe(JOB_TYPE);
    expect(CONTAINER_CANVAS_JOB_TYPE).toBe(CANVAS_JOB_TYPE);
    expect(CONTAINER_CANVAS_MAX_INPUT_BYTES).toBe(CANVAS_MAX_INPUT_BYTES);
  });

  it("an OLD container (no acquire body) is never handed the canvas job; the new one parses it and completes it", async () => {
    const { jobId } = await seedCanvasJob();
    expect((await call("/v1/render/jobs/acquire")).status).toBe(204);

    const response = await call("/v1/render/jobs/acquire", ACQUIRE_BODY);
    expect(response.status).toBe(200);
    const parsed = parseCanvasLease(await response.json());
    if (!parsed.ok) {
      throw new Error("the container refused the API's own canvas acquire response");
    }
    expect(parsed.lease.jobId).toBe(jobId);
    expect(new URL(parsed.lease.inputUrl).hostname).toMatch(/\.eu\.r2\.cloudflarestorage\.com$/);
    expect(parsed.lease.inputMaxBytes).toBe(1234);

    const canvas = new TextEncoder().encode("canvas-bytes-from-the-container");
    await env.PRIVATE_BUCKET.put(canvasOutputKey(parsed.lease.outputPrefix), canvas);
    const done = await call(
      canvasReportPath(parsed.lease.jobId, "complete"),
      canvasCompletionBody(parsed.lease, { ok: true, output: { bytes: canvas.length, sha256: await sha256Hex(canvas) } }, { wallMs: 900 }),
    );
    expect(done.status).toBe(200);
    await expect(done.json()).resolves.toStrictEqual({ status: "completed" });
    const row = await env.DB.prepare("SELECT state, canvas_sha256 FROM print_canvas_jobs WHERE id = ?")
      .bind(jobId)
      .first();
    expect(row).toStrictEqual({ canvas_sha256: await sha256Hex(canvas), state: "completed" });
  });

  it("every failure code the container sends on the canvas path is accepted and requeues the job; a refusal ends it", async () => {
    const { jobId } = await seedCanvasJob();
    const take = async () => {
      const parsed = parseCanvasLease(await (await call("/v1/render/jobs/acquire", ACQUIRE_BODY)).json());
      if (!parsed.ok) throw new Error("unparsable canvas lease");
      return parsed.lease;
    };
    const first = await take();
    expect(first.jobId).toBe(jobId);
    const failed = await call(canvasReportPath(first.jobId, "fail"), failureBody(first, "input_fetch_failed"));
    await expect(failed.json()).resolves.toStrictEqual({ status: "queued" });
    const second = await take();
    const refused = await call(
      canvasReportPath(second.jobId, "complete"),
      canvasCompletionBody(second, { ok: false, reasons: [{ code: "dims_mismatch", message: "x" }] }, {}),
    );
    expect(refused.status).toBe(200);
    const row = await env.DB.prepare("SELECT state, error FROM print_canvas_jobs WHERE id = ?").bind(jobId).first();
    expect(row).toStrictEqual({ error: "dims_mismatch", state: "failed" });
  });
});
