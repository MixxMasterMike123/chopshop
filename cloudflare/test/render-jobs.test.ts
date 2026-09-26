import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { deleteArtwork } from "../src/pod/artwork-store";
import {
  R2_PRESIGNER_OVERRIDE,
  type R2Presigner,
} from "../src/pod/render-farm-client";
import {
  attemptOutputKeys,
  canonicalOutputKeys,
  insertRenderJobStatement,
  RENDER_JOB_LEASE_MS,
  type RenderJobLease,
} from "../src/pod/render-jobs";
import { RENDER_API_IP_LIMIT } from "../src/routes/render-jobs";

/**
 * The render-job pull contract (PLAN §2.6): acquire / complete / fail with
 * lease fencing, attempt-specific outputs, verified promotion to immutable
 * canonical keys, three attempts then an alert.
 *
 * Jobs are seeded with the production insert statement (insertRenderJobStatement)
 * rather than through the admin route, so each case controls exactly the
 * rows it starts from; the admin → job path is covered in pod-artwork.test.ts.
 * Real clock throughout; lease expiry is simulated by moving `lease_until`.
 */

const API = "https://api.renderjobs.test";
const TENANT_A = "tenant-renderjobs-a";
const TENANT_B = "tenant-renderjobs-b";
const SEED_NOW = 1_700_000_000_000;

const PROFILE = {
  accepted_formats: [{ ext: "png" }, { ext: "jpg" }],
  id: "apparel_dtg",
  max_file_mb: 50,
  min_dpi: 300,
  print_area_mm: { h: 400, w: 300 },
};

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// ── seeding ─────────────────────────────────────────────────────────────────

async function seedTenant(tenantId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenants (tenant_id, status, shop_name, default_locale,
       default_currency, created_at, updated_at)
     VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(tenantId, `Shop ${tenantId}`, SEED_NOW, SEED_NOW)
    .run();
}

interface SeededJob {
  artworkId: string;
  jobId: string;
  objectId: string;
  tenantId: string;
}

/** An active original, a 'processing' artwork and its 'queued' job. */
async function seedJob(
  options: { createdAt?: number; sizeBytes?: number; tenantId?: string } = {},
): Promise<SeededJob> {
  const tenantId = options.tenantId ?? TENANT_A;
  const objectId = crypto.randomUUID();
  const artworkId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const createdAt = options.createdAt ?? Date.now();
  const sizeBytes = options.sizeBytes ?? 4_000_000;
  const objectKey = `shops/${tenantId}/artwork_original/${objectId}/v1/motif.png`;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stored_objects (object_id, tenant_id, bucket, object_key, kind,
         content_type, size_bytes, sha256, status, immutable, created_at, updated_at)
       VALUES (?, ?, 'private', ?, 'artwork_original', 'image/png', ?, ?, 'active', 0, ?, ?)`,
    ).bind(objectId, tenantId, objectKey, sizeBytes, "a".repeat(64), SEED_NOW, SEED_NOW),
    env.DB.prepare(
      `INSERT INTO pod_artwork (artwork_id, tenant_id, original_object_id,
         profile_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'apparel_dtg', 'processing', ?, ?)`,
    ).bind(artworkId, tenantId, objectId, SEED_NOW, SEED_NOW),
    insertRenderJobStatement(env.DB, {
      artworkId,
      inputBytes: sizeBytes,
      inputKey: objectKey,
      jobId,
      now: createdAt,
      profile: PROFILE,
      tenantId,
    }),
  ]);

  return { artworkId, jobId, objectId, tenantId };
}

async function jobRow(jobId: string) {
  return env.DB.prepare(
    `SELECT state, attempt, lease_token_hash, lease_until, error, completed_at
     FROM render_jobs WHERE id = ?`,
  )
    .bind(jobId)
    .first<{
      attempt: number;
      completed_at: string | null;
      error: string | null;
      lease_token_hash: string | null;
      lease_until: string | null;
      state: string;
    }>();
}

async function artworkRow(artworkId: string) {
  return env.DB.prepare("SELECT * FROM pod_artwork WHERE artwork_id = ?")
    .bind(artworkId)
    .first<Record<string, unknown>>();
}

async function expireLease(jobId: string): Promise<void> {
  await env.DB.prepare("UPDATE render_jobs SET lease_until = ? WHERE id = ?")
    .bind(iso(Date.now() - 1_000), jobId)
    .run();
}

// ── the fake presigner and the farm's side of the wire ─────────────────────

const presignedGets: Array<{ key: string; ttl: number | undefined }> = [];

function createFakePresigner(): R2Presigner {
  const base = "https://testaccount.r2.cloudflarestorage.com/meteorshop-test-private";
  return {
    async presignGet(objectKey: string, ttlSeconds?: number): Promise<string> {
      presignedGets.push({ key: objectKey, ttl: ttlSeconds });
      return `${base}/${objectKey}?X-Amz-Expires=${ttlSeconds ?? 900}&X-Amz-Signature=fake`;
    },
    async presignPut(objectKey: string, contentType: string): Promise<string> {
      return `${base}/${objectKey}?X-Amz-Expires=900&X-Amz-Signature=fake&ct=${encodeURIComponent(contentType)}`;
    },
  };
}

function renderEnv(overrides: Record<PropertyKey, unknown> = {}): Env {
  return {
    ...env,
    [R2_PRESIGNER_OVERRIDE]: createFakePresigner(),
    ...overrides,
  } as unknown as Env;
}

function keyFromPresignedUrl(raw: string): string {
  const path = new URL(raw).pathname.replace(/^\/+/, "");
  return decodeURIComponent(path.slice(path.indexOf("/") + 1));
}

interface FarmRequestOptions {
  authorization?: string | null;
  body?: unknown;
  ip?: string;
  method?: string;
}

function farmRequest(path: string, options: FarmRequestOptions = {}): Request {
  const headers: Record<string, string> = {
    "cf-connecting-ip": options.ip ?? nextIp(),
  };
  const authorization =
    options.authorization === undefined
      ? `Bearer ${env.RENDER_FARM_TOKEN}`
      : options.authorization;
  if (authorization !== null) {
    headers.authorization = authorization;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return new Request(`${API}${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method ?? "POST",
  });
}

async function acquire(
  targetEnv: Env = renderEnv(),
): Promise<RenderJobLease | null> {
  const response = await worker.fetch(farmRequest("/v1/render/jobs/acquire"), targetEnv);
  if (response.status === 204) {
    return null;
  }
  expect(response.status).toBe(200);
  return response.json<RenderJobLease>();
}

interface Uploaded {
  preview: { bytes: number; key: string; sha256: string };
  print: { bytes: number; key: string; sha256: string };
}

/** What the real farm does before it reports: PUT both outputs to the URLs. */
async function upload(
  lease: RenderJobLease,
  options: { fill?: number; previewBytes?: number; printBytes?: number } = {},
): Promise<Uploaded> {
  const printBytes = new Uint8Array(options.printBytes ?? 50_000).fill(options.fill ?? 7);
  const previewBytes = new Uint8Array(options.previewBytes ?? 2_000).fill(options.fill ?? 9);
  const printKey = keyFromPresignedUrl(lease.output.printPngPutUrl);
  const previewKey = keyFromPresignedUrl(lease.output.previewWebpPutUrl);

  await env.PRIVATE_BUCKET.put(printKey, printBytes, {
    httpMetadata: { contentType: "image/png" },
  });
  await env.PRIVATE_BUCKET.put(previewKey, previewBytes, {
    httpMetadata: { contentType: "image/webp" },
  });

  return {
    preview: { bytes: previewBytes.length, key: previewKey, sha256: await sha256Hex(previewBytes) },
    print: { bytes: printBytes.length, key: printKey, sha256: await sha256Hex(printBytes) },
  };
}

function okBody(lease: RenderJobLease, uploaded: Uploaded, extra: Record<string, unknown> = {}) {
  return {
    attempt: lease.attempt,
    fields: {
      effectiveDpi: 325,
      heightPx: 3200,
      maxPrintMm: { h: 250, w: 250 },
      pipelineVersion: 1,
      profileId: lease.profile.id,
      widthPx: 3200,
    },
    leaseToken: lease.leaseToken,
    notices: [{ code: "opaque", message: "Bilden saknar transparent bakgrund." }],
    ok: true,
    outputs: {
      previewWebp: uploaded.preview,
      printPng: uploaded.print,
    },
    ...extra,
  };
}

function complete(jobId: string, body: unknown, targetEnv: Env = renderEnv()) {
  return worker.fetch(farmRequest(`/v1/render/jobs/${jobId}/complete`, { body }), targetEnv);
}

function fail(jobId: string, body: unknown, targetEnv: Env = renderEnv()) {
  return worker.fetch(farmRequest(`/v1/render/jobs/${jobId}/fail`, { body }), targetEnv);
}

async function objectExists(key: string): Promise<boolean> {
  return (await env.PRIVATE_BUCKET.head(key)) !== null;
}

beforeAll(async () => {
  await seedTenant(TENANT_A);
  await seedTenant(TENANT_B);
});

beforeEach(async () => {
  presignedGets.length = 0;
  // Storage persists across the tests of one file (and is isolated per file),
  // and acquire is GLOBAL across tenants — a leftover queued job from an
  // earlier case would be leased by the next one.
  await env.DB.prepare("DELETE FROM render_jobs").run();
  await env.DB.prepare("DELETE FROM pod_artwork").run();
  await env.DB.prepare("DELETE FROM rate_limit_windows").run();
  for (const tenant of [TENANT_A, TENANT_B]) {
    const listed = await env.PRIVATE_BUCKET.list({ prefix: `pod/${tenant}/` });
    await Promise.all(listed.objects.map((object) => env.PRIVATE_BUCKET.delete(object.key)));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the dark surface and authentication", () => {
  const ROUTES = [
    "/v1/render/jobs/acquire",
    `/v1/render/jobs/${crypto.randomUUID()}/complete`,
    `/v1/render/jobs/${crypto.randomUUID()}/fail`,
  ];

  const DARK: Array<[string, Record<string, unknown>]> = [
    ["RENDER_FARM_TOKEN is unset", { RENDER_FARM_TOKEN: undefined }],
    ["RENDER_FARM_TOKEN is 31 characters", { RENDER_FARM_TOKEN: "x".repeat(31) }],
    ["the R2 credentials are unset", { R2_ACCESS_KEY_ID: undefined }],
    ["the private bucket is unbound", { PRIVATE_BUCKET: undefined }],
    ["the jurisdiction is unknown", { R2_JURISDICTION: "us" }],
  ];

  for (const [label, overrides] of DARK) {
    it(`404s every route, before D1, while ${label}`, async () => {
      await seedJob();
      for (const path of ROUTES) {
        const response = await worker.fetch(
          farmRequest(path, { body: {} }),
          renderEnv(overrides),
        );
        expect(response.status, path).toBe(404);
        expect(await response.json()).toStrictEqual({
          error: { code: "not_found", message: "Route not found" },
        });
      }

      // The gate ran before the limiter: nothing was counted, nothing leased.
      const counted = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM rate_limit_windows WHERE scope = 'render-api-ip'",
      ).first<{ n: number }>();
      expect(counted?.n).toBe(0);
      const leased = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM render_jobs WHERE state <> 'queued'",
      ).first<{ n: number }>();
      expect(leased?.n).toBe(0);
    });
  }

  it("does not need RENDER_FARM_URL: the pull surface never calls the farm", async () => {
    await seedJob();
    const lease = await acquire(renderEnv({ RENDER_FARM_URL: undefined }));
    expect(lease?.attempt).toBe(1);
  });

  const BAD_CREDENTIALS: Array<[string, string | null]> = [
    ["no Authorization header", null],
    ["a wrong token", `Bearer ${"w".repeat(36)}`],
    ["the token with a trailing character", `Bearer ${env.RENDER_FARM_TOKEN}x`],
    ["a lowercase scheme", `bearer ${env.RENDER_FARM_TOKEN}`],
    ["Basic credentials", `Basic ${btoa(`farm:${env.RENDER_FARM_TOKEN}`)}`],
    ["two spaces", `Bearer  ${env.RENDER_FARM_TOKEN}`],
  ];

  for (const [label, authorization] of BAD_CREDENTIALS) {
    it(`answers the opaque 404 for ${label}, and leases nothing`, async () => {
      const seeded = await seedJob();
      const response = await worker.fetch(
        farmRequest("/v1/render/jobs/acquire", { authorization }),
        renderEnv(),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toStrictEqual({
        error: { code: "not_found", message: "Route not found" },
      });
      expect((await jobRow(seeded.jobId))?.state).toBe("queued");
    });
  }

  it("a tenant session is not a credential here", async () => {
    await seedJob();
    const response = await worker.fetch(
      new Request(`${API}/v1/render/jobs/acquire`, {
        headers: { cookie: "better-auth.session_token=anything", "x-shop-id": TENANT_A },
        method: "POST",
      }),
      renderEnv(),
    );
    expect(response.status).toBe(404);
  });

  it("wrong methods, unknown paths and malformed job ids are 404s", async () => {
    const seeded = await seedJob();
    const cases: Array<[string, string]> = [
      ["GET", "/v1/render/jobs/acquire"],
      ["PUT", "/v1/render/jobs/acquire"],
      ["POST", "/v1/render/jobs"],
      ["POST", "/v1/render/jobs/acquire/extra"],
      ["POST", "/v1/render/"],
      ["POST", `/v1/render/jobs/${seeded.jobId}`],
      ["POST", `/v1/render/jobs/${seeded.jobId}/promote`],
      ["POST", "/v1/render/jobs/not-a-uuid/complete"],
      ["POST", `/v1/render/jobs/${seeded.jobId.toUpperCase()}/complete`],
      ["POST", `/v1/render/jobs/${seeded.jobId}/complete/x`],
    ];
    for (const [method, path] of cases) {
      const response = await worker.fetch(
        farmRequest(path, { body: method === "GET" ? undefined : {}, method }),
        renderEnv(),
      );
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect((await jobRow(seeded.jobId))?.state).toBe("queued");
  });

  it("an unknown job id is a 404 naming the job, not the route", async () => {
    const response = await complete(crypto.randomUUID(), {
      attempt: 1,
      leaseToken: "A".repeat(43),
      ok: false,
      reasons: [{ code: "x", message: "y" }],
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "not_found", message: "Job not found" },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("acquire", () => {
  it("answers 204 with no body when nothing is queued", async () => {
    const response = await worker.fetch(farmRequest("/v1/render/jobs/acquire"), renderEnv());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("leases the job with the contract-v0 envelope plus the lease", async () => {
    const seeded = await seedJob({ sizeBytes: 1_048_576 });
    const before = Date.now();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }

    expect(Object.keys(lease).sort()).toStrictEqual([
      "attempt",
      "contract",
      "input",
      "jobId",
      "jobType",
      "leaseToken",
      "leaseUntil",
      "output",
      "outputPrefix",
      "profile",
    ]);
    expect(lease.contract).toBe(1);
    expect(lease.jobType).toBe("pod.process_artwork");
    expect(lease.jobId).toBe(seeded.jobId);
    expect(lease.attempt).toBe(1);
    expect(lease.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(lease.profile).toStrictEqual(PROFILE);
    expect(lease.input.maxBytes).toBe(1_048_576);

    const leaseUntil = Date.parse(lease.leaseUntil);
    expect(leaseUntil).toBeGreaterThanOrEqual(before + RENDER_JOB_LEASE_MS);
    expect(leaseUntil).toBeLessThanOrEqual(Date.now() + RENDER_JOB_LEASE_MS);

    const prefix = `pod/${TENANT_A}/render/${seeded.artworkId}/1/attempt-1/`;
    expect(lease.outputPrefix).toBe(prefix);
    expect(keyFromPresignedUrl(lease.output.printPngPutUrl)).toBe(`${prefix}print.png`);
    expect(keyFromPresignedUrl(lease.output.previewWebpPutUrl)).toBe(`${prefix}preview.webp`);
    expect(lease.output.printPngPutUrl).toContain("image%2Fpng");
    expect(lease.output.previewWebpPutUrl).toContain("image%2Fwebp");

    // The input is a SHORT-lived presigned GET on the original.
    expect(presignedGets).toStrictEqual([
      {
        key: `shops/${TENANT_A}/artwork_original/${seeded.objectId}/v1/motif.png`,
        ttl: 300,
      },
    ]);

    // The row holds the token's HASH, never the token.
    const row = await jobRow(seeded.jobId);
    expect(row?.state).toBe("leased");
    expect(row?.attempt).toBe(1);
    expect(row?.lease_until).toBe(lease.leaseUntil);
    expect(row?.lease_token_hash).toBe(await sha256Hex(lease.leaseToken));
  });

  it("signs with the real presigner when none is injected", async () => {
    await seedJob();
    const lease = await acquire({ ...env } as unknown as Env);
    const input = new URL(lease?.input.url ?? "");
    const put = new URL(lease?.output.printPngPutUrl ?? "");

    expect(input.hostname).toBe(`${env.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`);
    expect(input.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(input.searchParams.get("X-Amz-Signature")).not.toBeNull();
    expect(put.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(put.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
  });

  it("leases the OLDEST acquirable job first", async () => {
    const now = Date.now();
    const newer = await seedJob({ createdAt: now - 1_000 });
    const older = await seedJob({ createdAt: now - 5_000 });

    expect((await acquire())?.jobId).toBe(older.jobId);
    expect((await acquire())?.jobId).toBe(newer.jobId);
    expect(await acquire()).toBeNull();
  });

  it("two concurrent acquires lease two DIFFERENT jobs", async () => {
    const now = Date.now();
    const first = await seedJob({ createdAt: now - 2_000 });
    const second = await seedJob({ createdAt: now - 1_000, tenantId: TENANT_B });

    const leases = await Promise.all([acquire(), acquire()]);
    const ids = leases.map((lease) => lease?.jobId).sort();
    expect(ids).toStrictEqual([first.jobId, second.jobId].sort());
    expect(leases[0]?.leaseToken).not.toBe(leases[1]?.leaseToken);
    expect(await acquire()).toBeNull();
  });

  it("with one job, concurrent acquires give it to exactly one farm", async () => {
    await seedJob();
    const leases = await Promise.all([acquire(), acquire(), acquire(), acquire()]);
    expect(leases.filter((lease) => lease !== null)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("complete — the happy path", () => {
  it("promotes verified outputs, readies the artwork and closes the job in one step", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(lease);

    const response = await complete(seeded.jobId, okBody(lease, uploaded));
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: "completed" });

    const job = await jobRow(seeded.jobId);
    expect(job?.state).toBe("completed");
    expect(job?.completed_at).not.toBeNull();

    const canonical = canonicalOutputKeys(TENANT_A, seeded.artworkId);
    const artwork = await artworkRow(seeded.artworkId);
    expect(artwork).toMatchObject({
      effective_dpi: 325,
      height_px: 3200,
      max_print_h_mm: 250,
      max_print_w_mm: 250,
      pipeline_version: 1,
      preview_bytes: uploaded.preview.bytes,
      preview_object_key: canonical.previewKey,
      preview_sha256: uploaded.preview.sha256,
      print_bytes: uploaded.print.bytes,
      print_object_key: canonical.printKey,
      print_sha256: uploaded.print.sha256,
      reasons_json: null,
      status: "ready",
      width_px: 3200,
    });
    expect(JSON.parse(String(artwork?.notices_json))).toStrictEqual([
      { code: "opaque", message: "Bilden saknar transparent bakgrund." },
    ]);

    // The canonical objects carry the sha256 R2 itself verified on the copy.
    const print = await env.PRIVATE_BUCKET.head(canonical.printKey);
    const preview = await env.PRIVATE_BUCKET.head(canonical.previewKey);
    expect(print?.checksums.toJSON().sha256).toBe(uploaded.print.sha256);
    expect(print?.httpMetadata?.contentType).toBe("image/png");
    expect(preview?.checksums.toJSON().sha256).toBe(uploaded.preview.sha256);
    expect(preview?.httpMetadata?.contentType).toBe("image/webp");

    // The attempt prefix is garbage once promoted.
    expect(await objectExists(uploaded.print.key)).toBe(false);
    expect(await objectExists(uploaded.preview.key)).toBe(false);

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, tenant_id, metadata_json FROM audit_events
       WHERE action = 'pod.artwork.ready' AND resource_id = ?`,
    )
      .bind(seeded.artworkId)
      .all<{ actor_user_id: string | null; metadata_json: string; tenant_id: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]?.actor_user_id).toBeNull();
    expect(audit.results[0]?.tenant_id).toBe(TENANT_A);
    expect(JSON.parse(audit.results[0]?.metadata_json ?? "{}")).toStrictEqual({
      attempt: 1,
      effectiveDpi: 325,
      noticeCodes: ["opaque"],
      profileId: "apparel_dtg",
      renderJobId: seeded.jobId,
    });
  });

  it("a rejection verdict completes the job and rejects the artwork with its reasons", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }

    const response = await complete(seeded.jobId, {
      attempt: lease.attempt,
      leaseToken: lease.leaseToken,
      ok: false,
      reasons: [{ code: "resolution_too_low", message: "För låg upplösning." }],
    });

    expect(response.status).toBe(200);
    expect((await jobRow(seeded.jobId))?.state).toBe("completed");
    const artwork = await artworkRow(seeded.artworkId);
    expect(artwork?.status).toBe("rejected");
    expect(artwork?.print_object_key).toBeNull();
    expect(JSON.parse(String(artwork?.reasons_json))).toStrictEqual([
      { code: "resolution_too_low", message: "För låg upplösning." },
    ]);
    const canonical = canonicalOutputKeys(TENANT_A, seeded.artworkId);
    expect(await objectExists(canonical.printKey)).toBe(false);
  });

  it("a repeated completion of the accepted attempt is an idempotent 200", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const body = okBody(lease, await upload(lease));

    expect((await complete(seeded.jobId, body)).status).toBe(200);
    const replay = await complete(seeded.jobId, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toStrictEqual({ status: "completed" });

    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'pod.artwork.ready' AND resource_id = ?",
    )
      .bind(seeded.artworkId)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it("logs metrics as numbers keyed by job, never the token", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await complete(
      seeded.jobId,
      okBody(lease, await upload(lease), { metrics: { peakRssMb: 812, wallMs: 41_250 } }),
    );

    expect(response.status).toBe(200);
    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain(seeded.jobId);
    expect(logged).toContain("41250");
    expect(logged).not.toContain(lease.leaseToken);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("fencing", () => {
  it("an expired lease is re-acquired as attempt 2; the old lease's completion is refused and swept", async () => {
    const seeded = await seedJob();
    const first = await acquire();
    if (first === null) {
      throw new Error("expected a lease");
    }
    await expireLease(seeded.jobId);

    const second = await acquire();
    if (second === null) {
      throw new Error("expected a re-lease");
    }
    expect(second.jobId).toBe(seeded.jobId);
    expect(second.attempt).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.outputPrefix).toMatch(/\/attempt-2\/$/);
    const released = await jobRow(seeded.jobId);
    expect(released?.error).toBe("lease_expired");
    expect(released?.lease_token_hash).toBe(await sha256Hex(second.leaseToken));

    // The stalled first farm finishes AFTER losing its lease: its outputs land
    // under attempt-1 and its report is refused.
    const stale = await upload(first, { fill: 1 });
    const refused = await complete(seeded.jobId, okBody(first, stale));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toStrictEqual({
      error: { code: "lease_lost", message: "The lease on this job is no longer held" },
    });
    expect(await objectExists(stale.print.key)).toBe(false);
    expect(await objectExists(stale.preview.key)).toBe(false);
    expect((await artworkRow(seeded.artworkId))?.status).toBe("processing");

    // The current holder completes normally, with its own bytes.
    const fresh = await upload(second, { fill: 2 });
    expect((await complete(seeded.jobId, okBody(second, fresh))).status).toBe(200);
    const artwork = await artworkRow(seeded.artworkId);
    expect(artwork?.status).toBe("ready");
    expect(artwork?.print_sha256).toBe(fresh.print.sha256);

    // Even now, the first lease stays refused.
    expect((await complete(seeded.jobId, okBody(first, stale))).status).toBe(409);
  });

  it("the holder's own late report is refused and swept even before anyone re-acquires", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(lease);
    await expireLease(seeded.jobId);

    expect((await complete(seeded.jobId, okBody(lease, uploaded))).status).toBe(409);
    expect(await objectExists(uploaded.print.key)).toBe(false);
    expect((await acquire())?.attempt).toBe(2);
  });

  it("a wrong token on the CURRENT attempt is refused WITHOUT deleting the holder's bytes", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(lease);

    const forged = await complete(
      seeded.jobId,
      okBody({ ...lease, leaseToken: "Z".repeat(43) }, uploaded),
    );
    expect(forged.status).toBe(409);
    expect(await objectExists(uploaded.print.key)).toBe(true);
    expect((await jobRow(seeded.jobId))?.state).toBe("leased");

    expect((await complete(seeded.jobId, okBody(lease, uploaded))).status).toBe(200);
  });

  it("an attempt number ahead of the job is refused", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(lease);
    const response = await complete(seeded.jobId, okBody({ ...lease, attempt: 2 }, uploaded));
    expect(response.status).toBe(409);
    expect(await objectExists(uploaded.print.key)).toBe(true);
  });

  it("a failure report on an expired lease is refused too", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    await expireLease(seeded.jobId);

    const response = await fail(seeded.jobId, {
      attempt: lease.attempt,
      error: "input_fetch_failed",
      leaseToken: lease.leaseToken,
    });
    expect(response.status).toBe(409);
    expect((await jobRow(seeded.jobId))?.state).toBe("leased");
  });

  /**
   * The promotion window. A completion is checked fresh, then copies to R2,
   * then commits — and the commit must RE-CHECK the fence against the clock at
   * that moment. These cases make the commit-time fence the sole defence by
   * moving the clock (and, in the second, letting another farm re-lease the
   * job) from inside the first R2 `put` of the promotion.
   */
  function bucketHookedOnFirstPut(onFirstPut: () => Promise<void>): R2Bucket {
    const real = env.PRIVATE_BUCKET;
    let fired = false;
    return {
      delete: real.delete.bind(real),
      get: real.get.bind(real),
      head: real.head.bind(real),
      list: real.list.bind(real),
      async put(...args: Parameters<R2Bucket["put"]>) {
        const result = await real.put(...args);
        if (!fired) {
          fired = true;
          await onFirstPut();
        }
        return result;
      },
    } as unknown as R2Bucket;
  }

  it("a lease that runs out during promotion makes the commit refuse", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(lease);
    const later = Date.now() + RENDER_JOB_LEASE_MS + 60_000;

    const response = await complete(
      seeded.jobId,
      okBody(lease, uploaded),
      renderEnv({
        PRIVATE_BUCKET: bucketHookedOnFirstPut(async () => {
          vi.spyOn(Date, "now").mockReturnValue(later);
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect((await jobRow(seeded.jobId))?.state).toBe("leased");
    expect((await artworkRow(seeded.artworkId))?.status).toBe("processing");
  });

  it("a farm that re-leases the job during a slow promotion keeps it; the slow commit is refused", async () => {
    const seeded = await seedJob();
    const first = await acquire();
    if (first === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(first);
    const later = Date.now() + RENDER_JOB_LEASE_MS + 60_000;
    let second: RenderJobLease | null = null;

    const response = await complete(
      seeded.jobId,
      okBody(first, uploaded),
      renderEnv({
        PRIVATE_BUCKET: bucketHookedOnFirstPut(async () => {
          vi.spyOn(Date, "now").mockReturnValue(later);
          second = await acquire();
        }),
      }),
    );

    expect(response.status).toBe(409);
    const secondLease = second as RenderJobLease | null;
    expect(secondLease?.attempt).toBe(2);
    const row = await jobRow(seeded.jobId);
    expect(row?.state).toBe("leased");
    expect(row?.attempt).toBe(2);
    expect(row?.lease_token_hash).toBe(await sha256Hex(secondLease?.leaseToken ?? ""));
    expect((await artworkRow(seeded.artworkId))?.status).toBe("processing");
  });

  /**
   * Holds the canonical `put` for `key`: the promoter has already checked
   * head() (absent) and read its source, and stalls right before writing — the
   * window Codex CP1-C P1 names. `whileStalled` runs in that window; then the
   * held bytes are written with the ORIGINAL options (incl. the precondition).
   */
  function bucketStallingPut(key: string, whileStalled: () => Promise<void>): R2Bucket {
    const real = env.PRIVATE_BUCKET;
    let fired = false;
    return {
      delete: real.delete.bind(real),
      get: real.get.bind(real),
      head: real.head.bind(real),
      list: real.list.bind(real),
      async put(target: string, value: unknown, options?: R2PutOptions) {
        if (target !== key || fired) {
          return real.put(target, value as ArrayBuffer, options);
        }
        fired = true;
        const held = await new Response(value as ReadableStream).arrayBuffer();
        await whileStalled();
        return real.put(target, held, options);
      },
    } as unknown as R2Bucket;
  }

  it("a promotion stalled past its lease cannot overwrite the NEWER attempt's canonical bytes (Codex P1)", async () => {
    const seeded = await seedJob();
    const first = await acquire();
    if (first === null) {
      throw new Error("expected a lease");
    }
    const firstOut = await upload(first, { fill: 1 });
    const canonical = canonicalOutputKeys(TENANT_A, seeded.artworkId);
    const later = Date.now() + RENDER_JOB_LEASE_MS + 60_000;
    let secondOut: Uploaded | null = null;
    let secondStatus = 0;

    const response = await complete(
      seeded.jobId,
      okBody(first, firstOut),
      renderEnv({
        PRIVATE_BUCKET: bucketStallingPut(canonical.printKey, async () => {
          // Attempt 1's lease runs out; attempt 2 is leased, renders
          // DIFFERENT bytes and completes, all before attempt 1 writes.
          vi.spyOn(Date, "now").mockReturnValue(later);
          const second = await acquire();
          if (second === null) {
            throw new Error("expected attempt 2");
          }
          expect(second.attempt).toBe(2);
          secondOut = await upload(second, { fill: 2 });
          secondStatus = (await complete(seeded.jobId, okBody(second, secondOut))).status;
        }),
      }),
    );

    const winner = secondOut as Uploaded | null;
    expect(secondStatus).toBe(200);
    // The stale attempt is refused…
    expect(response.status).toBe(409);
    // …and the canonical bytes are still attempt 2's.
    const print = await env.PRIVATE_BUCKET.head(canonical.printKey);
    expect(print?.checksums.toJSON().sha256).toBe(winner?.print.sha256);
    expect(print?.checksums.toJSON().sha256).not.toBe(firstOut.print.sha256);
    const artwork = await artworkRow(seeded.artworkId);
    expect(artwork?.status).toBe("ready");
    expect(artwork?.print_sha256).toBe(winner?.print.sha256);
    const row = await jobRow(seeded.jobId);
    expect(row?.state).toBe("completed");
    expect(row?.attempt).toBe(2);
    // The dead attempt left nothing behind (attempt 2's acquire swept its
    // prefix), and no alert was raised for it.
    expect(await objectExists(firstOut.print.key)).toBe(false);
    expect(await objectExists(firstOut.preview.key)).toBe(false);
    const alerts = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE resource_id = ?")
      .bind(seeded.jobId)
      .first<{ n: number }>();
    expect(alerts?.n).toBe(0);
  });

  it("different bytes created between head() and put() are a conflict, never overwritten", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(lease, { fill: 7 });
    const canonical = canonicalOutputKeys(TENANT_A, seeded.artworkId);
    const squatter = new Uint8Array(50_000).fill(42);

    const response = await complete(
      seeded.jobId,
      okBody(lease, uploaded),
      renderEnv({
        PRIVATE_BUCKET: bucketStallingPut(canonical.printKey, async () => {
          await env.PRIVATE_BUCKET.put(canonical.printKey, squatter, {
            sha256: await sha256Hex(squatter),
          });
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
      "canonical_conflict",
    );
    const kept = await env.PRIVATE_BUCKET.head(canonical.printKey);
    expect(kept?.checksums.toJSON().sha256).toBe(await sha256Hex(squatter));
    expect((await jobRow(seeded.jobId))?.state).toBe("failed");
  });

  it("identical bytes created between head() and put() are accepted as this output", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(lease, { fill: 7 });
    const canonical = canonicalOutputKeys(TENANT_A, seeded.artworkId);

    const response = await complete(
      seeded.jobId,
      okBody(lease, uploaded),
      renderEnv({
        PRIVATE_BUCKET: bucketStallingPut(canonical.printKey, async () => {
          const same = new Uint8Array(50_000).fill(7);
          await env.PRIVATE_BUCKET.put(canonical.printKey, same, {
            sha256: await sha256Hex(same),
          });
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect((await artworkRow(seeded.artworkId))?.status).toBe("ready");
  });

  it("two overlapping completions of one attempt write exactly ONE audit row (Codex P2)", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const body = okBody(lease, await upload(lease));
    let innerStatus = 0;

    // The farm resends while its first request is mid-promotion: both pass the
    // fence-and-extend, the duplicate commits first, then the original commits.
    const outer = await complete(
      seeded.jobId,
      body,
      renderEnv({
        PRIVATE_BUCKET: bucketHookedOnFirstPut(async () => {
          innerStatus = (await complete(seeded.jobId, body)).status;
        }),
      }),
    );

    expect(innerStatus).toBe(200);
    expect(outer.status).toBe(200);
    const audits = await env.DB.prepare(
      `SELECT event_id FROM audit_events
       WHERE action = 'pod.artwork.ready' AND resource_id = ?`,
    )
      .bind(seeded.artworkId)
      .all<{ event_id: string }>();
    expect(audits.results.map((row) => row.event_id)).toStrictEqual([
      `render-job-completed:${seeded.jobId}`,
    ]);
    expect((await artworkRow(seeded.artworkId))?.status).toBe("ready");
  });

  it("deleting the artwork mid-render ends the job; the farm's report is refused and swept", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }

    const deleted = await deleteArtwork(
      renderEnv(),
      env.DB,
      { accountType: "tenant_admin", role: "admin", tenantId: TENANT_A, userId: "user-render-jobs" },
      seeded.artworkId,
      Date.now(),
    );
    expect(deleted.status).toBe("ok");
    const ended = await jobRow(seeded.jobId);
    expect(ended?.state).toBe("failed");
    expect(ended?.error).toBe("artwork_deleted");

    const uploaded = await upload(lease);
    expect((await complete(seeded.jobId, okBody(lease, uploaded))).status).toBe(409);
    expect(await objectExists(uploaded.print.key)).toBe(false);
    expect(await acquire()).toBeNull();
    // A user's own cancellation is not an operator alert.
    const alerts = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE resource_id = ?")
      .bind(seeded.jobId)
      .first<{ n: number }>();
    expect(alerts?.n).toBe(0);
  });

  it("deleting a still-QUEUED artwork ends its job before any farm sees it", async () => {
    const seeded = await seedJob();
    await deleteArtwork(
      renderEnv(),
      env.DB,
      { accountType: "tenant_admin", role: "admin", tenantId: TENANT_A, userId: "user-render-jobs" },
      seeded.artworkId,
      Date.now(),
    );
    expect(await acquire()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("failures and the three-attempt limit", () => {
  it("a failure report requeues the job, stores the code and sweeps the attempt", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const partial = await upload(lease);

    const response = await fail(seeded.jobId, {
      attempt: 1,
      error: "input_fetch_failed",
      leaseToken: lease.leaseToken,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: "queued" });

    const row = await jobRow(seeded.jobId);
    expect(row).toMatchObject({
      attempt: 1,
      error: "input_fetch_failed",
      lease_token_hash: null,
      lease_until: null,
      state: "queued",
    });
    expect(await objectExists(partial.print.key)).toBe(false);
    expect((await artworkRow(seeded.artworkId))?.status).toBe("processing");

    expect((await acquire())?.attempt).toBe(2);
  });

  it("three failed attempts end the job: failed, alert, artwork row removed", async () => {
    const seeded = await seedJob();
    const answers: unknown[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease = await acquire();
      expect(lease?.attempt).toBe(attempt);
      const response = await fail(seeded.jobId, {
        attempt,
        error: "pipeline_crashed",
        leaseToken: lease?.leaseToken,
      });
      answers.push(await response.json());
    }

    expect(answers).toStrictEqual([
      { status: "queued" },
      { status: "queued" },
      { status: "failed" },
    ]);
    const row = await jobRow(seeded.jobId);
    expect(row?.state).toBe("failed");
    expect(row?.error).toBe("pipeline_crashed");
    expect(await acquire()).toBeNull();

    const alert = await env.DB.prepare("SELECT * FROM alerts WHERE id = ?")
      .bind(`render-job-failed:${seeded.jobId}`)
      .first<Record<string, unknown>>();
    expect(alert).toMatchObject({
      kind: "render_job_failed",
      resolved_at: null,
      resource_id: seeded.jobId,
      resource_type: "render_job",
      severity: "critical",
      tenant_id: TENANT_A,
    });
    expect(String(alert?.message)).toContain("pipeline_crashed");

    // "Replay is the retry": the processing row is gone, so the same upload
    // can be posted again; the audit trail says why.
    expect(await artworkRow(seeded.artworkId)).toBeNull();
    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE event_id = ?",
    )
      .bind(`render-job-failed:${seeded.jobId}`)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toStrictEqual({
      attempt: 3,
      error: "pipeline_crashed",
      renderJobId: seeded.jobId,
    });
  });

  it("three expired leases: the fourth acquisition ends the job instead of leasing it", async () => {
    const seeded = await seedJob();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await acquire())?.attempt).toBe(attempt);
      await expireLease(seeded.jobId);
    }

    expect(await acquire()).toBeNull();
    const row = await jobRow(seeded.jobId);
    expect(row?.state).toBe("failed");
    expect(row?.attempt).toBe(3);
    expect(row?.error).toBe("lease_expired");
    const alert = await env.DB.prepare("SELECT kind FROM alerts WHERE id = ?")
      .bind(`render-job-failed:${seeded.jobId}`)
      .first<{ kind: string }>();
    expect(alert?.kind).toBe("render_job_failed");
    expect(await artworkRow(seeded.artworkId)).toBeNull();
  });

  it("an exhausted job is ended AND the next queued job is still leased in the same call", async () => {
    const now = Date.now();
    const exhausted = await seedJob({ createdAt: now - 10_000 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await acquire();
      await expireLease(exhausted.jobId);
    }
    const waiting = await seedJob({ createdAt: now });

    expect((await acquire())?.jobId).toBe(waiting.jobId);
    expect((await jobRow(exhausted.jobId))?.state).toBe("failed");
  });

  const UNVERIFIED: Array<[string, (lease: RenderJobLease) => Promise<Record<string, unknown>>]> = [
    [
      "the reported size disagrees with R2",
      async (lease) => {
        const uploaded = await upload(lease);
        return okBody(lease, {
          ...uploaded,
          print: { ...uploaded.print, bytes: uploaded.print.bytes + 1 },
        });
      },
    ],
    [
      "the farm never uploaded",
      async (lease) =>
        okBody(lease, {
          preview: { bytes: 2_000, key: keyFromPresignedUrl(lease.output.previewWebpPutUrl), sha256: "b".repeat(64) },
          print: { bytes: 50_000, key: keyFromPresignedUrl(lease.output.printPngPutUrl), sha256: "c".repeat(64) },
        }),
    ],
    [
      "the reported sha256 does not match the bytes (R2 refuses the copy)",
      async (lease) => {
        const uploaded = await upload(lease);
        return okBody(lease, {
          ...uploaded,
          print: { ...uploaded.print, sha256: "c".repeat(64) },
        });
      },
    ],
  ];

  for (const [label, makeBody] of UNVERIFIED) {
    it(`422 and a requeue when ${label}`, async () => {
      const seeded = await seedJob();
      const lease = await acquire();
      if (lease === null) {
        throw new Error("expected a lease");
      }

      const response = await complete(seeded.jobId, await makeBody(lease));
      expect(response.status).toBe(422);
      expect(await response.json()).toStrictEqual({
        error: {
          code: "outputs_unverified",
          message: "The reported outputs could not be verified",
        },
      });

      const row = await jobRow(seeded.jobId);
      expect(row?.state).toBe("queued");
      expect(row?.error).toBe("outputs_unverified");
      expect((await artworkRow(seeded.artworkId))?.status).toBe("processing");
      const canonical = canonicalOutputKeys(TENANT_A, seeded.artworkId);
      expect(await objectExists(canonical.printKey)).toBe(false);
      const attemptKeys = attemptOutputKeys(`pod/${TENANT_A}/render/${seeded.artworkId}/1/`, 1);
      expect(await objectExists(attemptKeys.printKey)).toBe(false);
    });
  }

  const INVALID: Array<[string, (lease: RenderJobLease, uploaded: Uploaded) => unknown]> = [
    ["a missing lease token", (lease, uploaded) => ({ ...okBody(lease, uploaded), leaseToken: undefined })],
    ["attempt 0", (lease, uploaded) => okBody({ ...lease, attempt: 0 }, uploaded)],
    ["attempt 4", (lease, uploaded) => okBody({ ...lease, attempt: 4 }, uploaded)],
    ["an unknown top-level key", (lease, uploaded) => okBody(lease, uploaded, { printKey: "pod/x" })],
    ["ok:true without outputs", (lease, uploaded) => ({ ...okBody(lease, uploaded), outputs: undefined })],
    ["ok:false with no reasons", (lease) => ({ attempt: lease.attempt, leaseToken: lease.leaseToken, ok: false, reasons: [] })],
    [
      "an output key outside this attempt (the canonical key)",
      (lease, uploaded) =>
        okBody(lease, {
          ...uploaded,
          print: { ...uploaded.print, key: uploaded.print.key.replace("/render/", "/print/") },
        }),
    ],
    [
      "an output key of ANOTHER attempt",
      (lease, uploaded) =>
        okBody(lease, {
          ...uploaded,
          print: { ...uploaded.print, key: uploaded.print.key.replace("attempt-1", "attempt-2") },
        }),
    ],
    ["a non-numeric metric", (lease, uploaded) => okBody(lease, uploaded, { metrics: { wallMs: "fast" } })],
    ["an array body", () => []],
  ];

  for (const [label, makeBody] of INVALID) {
    it(`400 for ${label}, leaving the lease and the outputs alone`, async () => {
      const seeded = await seedJob();
      const lease = await acquire();
      if (lease === null) {
        throw new Error("expected a lease");
      }
      const uploaded = await upload(lease);

      const response = await complete(seeded.jobId, makeBody(lease, uploaded));
      expect(response.status).toBe(400);
      expect((await jobRow(seeded.jobId))?.state).toBe("leased");
      expect(await objectExists(uploaded.print.key)).toBe(true);
    });
  }

  it("a failure report must carry an error CODE, not text", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    for (const error of ["", "fetch failed for https://x.r2.cloudflarestorage.com/a?sig", "a".repeat(101), 42]) {
      const response = await fail(seeded.jobId, {
        attempt: 1,
        error,
        leaseToken: lease?.leaseToken,
      });
      expect(response.status, String(error)).toBe(400);
    }
    expect((await jobRow(seeded.jobId))?.state).toBe("leased");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("promotion to the canonical keys", () => {
  it("refuses to overwrite a canonical key holding different bytes, and ends the job", async () => {
    const seeded = await seedJob();
    const canonical = canonicalOutputKeys(TENANT_A, seeded.artworkId);
    const squatter = new Uint8Array(50_000).fill(42);
    await env.PRIVATE_BUCKET.put(canonical.printKey, squatter, {
      sha256: await sha256Hex(squatter),
    });

    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(lease, { fill: 7 });

    const response = await complete(seeded.jobId, okBody(lease, uploaded));
    expect(response.status).toBe(409);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "canonical_conflict",
        message: "The canonical outputs already exist with different content",
      },
    });

    // The existing bytes are untouched.
    const kept = await env.PRIVATE_BUCKET.get(canonical.printKey);
    expect(new Uint8Array(await (kept as R2ObjectBody).arrayBuffer())[0]).toBe(42);

    const row = await jobRow(seeded.jobId);
    expect(row?.state).toBe("failed");
    expect(row?.error).toBe("canonical_conflict");
    const alert = await env.DB.prepare("SELECT kind FROM alerts WHERE id = ?")
      .bind(`render-job-failed:${seeded.jobId}`)
      .first<{ kind: string }>();
    expect(alert?.kind).toBe("render_job_failed");
    expect(await objectExists(uploaded.print.key)).toBe(false);
    expect(await artworkRow(seeded.artworkId)).toBeNull();
  });

  it("an existing canonical object WITHOUT a recorded sha256 is a conflict too (fail closed)", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(lease, { fill: 7 });
    const canonical = canonicalOutputKeys(TENANT_A, seeded.artworkId);
    await env.PRIVATE_BUCKET.put(canonical.printKey, new Uint8Array(50_000).fill(7));

    expect((await complete(seeded.jobId, okBody(lease, uploaded))).status).toBe(409);
  });

  it("identical bytes already at the canonical key are accepted as this output", async () => {
    const seeded = await seedJob();
    const lease = await acquire();
    if (lease === null) {
      throw new Error("expected a lease");
    }
    const uploaded = await upload(lease, { fill: 7 });
    const canonical = canonicalOutputKeys(TENANT_A, seeded.artworkId);
    const same = new Uint8Array(50_000).fill(7);
    await env.PRIVATE_BUCKET.put(canonical.printKey, same, { sha256: await sha256Hex(same) });

    expect((await complete(seeded.jobId, okBody(lease, uploaded))).status).toBe(200);
    expect((await artworkRow(seeded.artworkId))?.status).toBe("ready");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the rate limiter", () => {
  it(`allows ${RENDER_API_IP_LIMIT} requests a minute per IP, then 429s — before the token is checked`, async () => {
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let index = 0; index < RENDER_API_IP_LIMIT; index += 1) {
      const response = await worker.fetch(
        farmRequest("/v1/render/jobs/acquire", { authorization: `Bearer ${"w".repeat(40)}`, ip }),
        renderEnv(),
      );
      statuses.push(response.status);
    }
    expect(new Set(statuses)).toStrictEqual(new Set([404]));

    const limited = await worker.fetch(
      farmRequest("/v1/render/jobs/acquire", { ip }),
      renderEnv(),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).not.toBeNull();

    // Another address is unaffected.
    const other = await worker.fetch(farmRequest("/v1/render/jobs/acquire"), renderEnv());
    expect(other.status).toBe(204);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the -render-jobs queue", () => {
  it("acks every nudge, valid or malformed, and never logs a body", async () => {
    const acks: string[] = [];
    const retries: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const messages = [
      { body: { renderJobId: crypto.randomUUID() }, id: "valid" },
      { body: { renderJobId: "not-a-uuid", secret: "should-not-appear" }, id: "malformed" },
      { body: "should-not-appear", id: "string" },
    ];
    const batch = {
      ackAll() {
        throw new Error("never acks a whole batch");
      },
      messages: messages.map((message) => ({
        ack: () => acks.push(message.id),
        attempts: 1,
        body: message.body,
        id: message.id,
        retry: () => retries.push(message.id),
        timestamp: new Date(),
      })),
      queue: "chopshop-stg-render-jobs",
      retryAll() {
        throw new Error("never holds the batch");
      },
    } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, env);

    expect(acks).toStrictEqual(["valid", "malformed", "string"]);
    expect(retries).toStrictEqual([]);
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("should-not-appear");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the schema", () => {
  it("freezes a terminal job", async () => {
    const seeded = await seedJob();
    await env.DB.prepare(
      "UPDATE render_jobs SET state = 'failed', error = 'x', updated_at = ? WHERE id = ?",
    )
      .bind(iso(Date.now()), seeded.jobId)
      .run();

    await expect(
      env.DB.prepare("UPDATE render_jobs SET state = 'queued', error = NULL WHERE id = ?")
        .bind(seeded.jobId)
        .run(),
    ).rejects.toThrow(/render job is terminal/);
  });

  it("never lets an attempt count go down", async () => {
    const seeded = await seedJob();
    await acquire();
    await expect(
      env.DB.prepare("UPDATE render_jobs SET attempt = 0 WHERE id = ?").bind(seeded.jobId).run(),
    ).rejects.toThrow(/attempt cannot decrease/);
  });

  it("never completes a job that was not leased", async () => {
    const seeded = await seedJob();
    await expect(
      env.DB.prepare(
        "UPDATE render_jobs SET state = 'completed', attempt = 1, completed_at = ? WHERE id = ?",
      )
        .bind(iso(Date.now()), seeded.jobId)
        .run(),
    ).rejects.toThrow(/must be leased/);
  });

  it("refuses a job for another tenant's artwork", async () => {
    const seeded = await seedJob({ tenantId: TENANT_A });
    await expect(
      insertRenderJobStatement(env.DB, {
        artworkId: seeded.artworkId,
        inputBytes: 10,
        inputKey: `shops/${TENANT_B}/artwork_original/x/v1/m.png`,
        jobId: crypto.randomUUID(),
        now: Date.now(),
        profile: PROFILE,
        tenantId: TENANT_B,
      }).run(),
    ).rejects.toThrow(/same tenant/);
  });

  it("pins the output prefix and the input key to the job's own tenant", async () => {
    const seeded = await seedJob();
    await expect(
      env.DB.prepare(
        `INSERT INTO render_jobs (id, tenant_id, artwork_id, version, attempt, state,
           input_key, input_bytes, profile_json, output_prefix, created_at, updated_at)
         VALUES (?, ?, ?, 2, 0, 'queued', ?, 10, '{}', ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          TENANT_A,
          seeded.artworkId,
          `shops/${TENANT_A}/x`,
          `pod/${TENANT_B}/render/${seeded.artworkId}/2/`,
          iso(Date.now()),
          iso(Date.now()),
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO render_jobs (id, tenant_id, artwork_id, version, attempt, state,
           input_key, input_bytes, profile_json, output_prefix, created_at, updated_at)
         VALUES (?, ?, ?, 2, 0, 'queued', ?, 10, '{}', ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          TENANT_A,
          seeded.artworkId,
          `shops/${TENANT_B}/x`,
          `pod/${TENANT_A}/render/${seeded.artworkId}/2/`,
          iso(Date.now()),
          iso(Date.now()),
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("allows one job per artwork version", async () => {
    const seeded = await seedJob();
    await expect(
      insertRenderJobStatement(env.DB, {
        artworkId: seeded.artworkId,
        inputBytes: 10,
        inputKey: `shops/${TENANT_A}/x`,
        jobId: crypto.randomUUID(),
        now: Date.now(),
        profile: PROFILE,
        tenantId: TENANT_A,
      }).run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("keeps alerts append-only with a final resolution", async () => {
    const id = `test-alert-${crypto.randomUUID()}`;
    const now = iso(Date.now());
    await env.DB.prepare(
      `INSERT INTO alerts (id, tenant_id, kind, severity, message, resource_type, resource_id, created_at)
       VALUES (?, NULL, 'test_kind', 'warning', 'm', NULL, NULL, ?)`,
    )
      .bind(id, now)
      .run();

    await expect(
      env.DB.prepare("DELETE FROM alerts WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("UPDATE alerts SET message = 'changed' WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/immutable/);

    await env.DB.prepare("UPDATE alerts SET resolved_at = ? WHERE id = ?").bind(now, id).run();
    await expect(
      env.DB.prepare("UPDATE alerts SET resolved_at = ? WHERE id = ?")
        .bind(iso(Date.now() + 1_000), id)
        .run(),
    ).rejects.toThrow(/resolution is final/);
  });
});
