import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { insertRenderJobStatement } from "../src/pod/render-jobs";
import { WAKE_RETRY_DELAY_SECONDS } from "../src/pod/render-jobs-queue";
import {
  RENDER_CONTAINER_INSTANCE,
  renderContainerEnvVars,
} from "../src/render/render-container";
import {
  completionBody,
  failureBody,
  outputKeys,
  parseLease,
} from "../render/src/contract";

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
