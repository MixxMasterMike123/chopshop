import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";
import type { TenantAdminPrincipal } from "../src/auth/live-authorization";
import { createArtwork, SYNC_RENDER_FALLBACK } from "../src/pod/artwork-store";
import {
  R2_PRESIGNER_OVERRIDE,
  RENDER_FARM_OVERRIDE,
  type JobEnvelope,
  type JobResult,
  type R2Presigner,
  type RenderFarmClient,
} from "../src/pod/render-farm-client";
import type { RenderJobLease } from "../src/pod/render-jobs";

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const HOST_A = "https://admin-a.podartwork.test";
const HOST_B = "https://admin-b.podartwork.test";
const TENANT_A = "tenant-podartwork-a";
const TENANT_B = "tenant-podartwork-b";

// A fixed past instant for SEED rows only. Never written into a row a live
// route created with the real clock — the checkpoint-24.1 fixture trap: once
// the real date overtakes a future constant, `CHECK (updated_at >= created_at)`
// starts failing on rows the route stamped with Date.now().
const SEED_NOW = 1_700_000_000_000;

// ── module-level counters (checkpoint-24 fixture trap) ──────────────────────
// The fake farm is rebuilt per test but D1 is NOT, so a per-instance counter
// would hand every test the same ids and collide on UNIQUE columns. These live
// at module scope for the same reason the payment suite's intent ids do.
let farmCallCount = 0;
let lastEnvelope: JobEnvelope | null = null;
let envelopeViolations: string[] = [];
let presignCallCount = 0;

interface SignedUpUser {
  cookie: string;
  userId: string;
}

const FIXTURE_PASSWORD = "test-password-long-enough";

let adminA: SignedUpUser;
let adminB: SignedUpUser;
let platformAdmin: SignedUpUser;

async function signUp(email: string): Promise<SignedUpUser> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();

  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email, name: email, password: FIXTURE_PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  const body = await response.json<{ user: { id: string } }>();
  expect(response.status).toBe(200);

  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const signedIn = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  const setCookie = signedIn.headers.get("set-cookie");
  expect(signedIn.status).toBe(200);
  if (setCookie === null) {
    throw new Error("sign-in did not return a session cookie");
  }
  const cookie = setCookie.split(";", 1)[0];
  if (cookie === undefined) {
    throw new Error("invalid session cookie");
  }

  return { cookie, userId: body.user.id };
}

async function seedAccess(userId: string, accountType: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(userId, accountType, SEED_NOW, SEED_NOW)
    .run();
}

async function seedTenant(tenantId: string, hostname: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (tenant_id, status, shop_name, default_locale,
         default_currency, created_at, updated_at)
       VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, `Shop ${tenantId}`, SEED_NOW, SEED_NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (domain_id, tenant_id, hostname, kind, status,
         created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, SEED_NOW, SEED_NOW),
  ]);
}

async function seedMembership(userId: string, tenantId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (membership_id, tenant_id, user_id, role,
       status, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
  )
    .bind(`membership-${tenantId}-${userId}`, tenantId, userId, SEED_NOW, SEED_NOW)
    .run();
}

/** An ACTIVE artwork_original stored object owned by `tenantId`. */
async function seedOriginal(
  tenantId: string,
  objectId: string,
  sizeBytes = 4_000_000,
): Promise<string> {
  const objectKey = `shops/${tenantId}/artwork_original/${objectId}/v1/motif.png`;
  await env.DB.prepare(
    `INSERT INTO stored_objects (object_id, tenant_id, bucket, object_key, kind,
       content_type, size_bytes, sha256, status, immutable, created_at, updated_at)
     VALUES (?, ?, 'private', ?, 'artwork_original', 'image/png', ?, ?, 'active', 0, ?, ?)`,
  )
    .bind(
      objectId,
      tenantId,
      objectKey,
      sizeBytes,
      "a".repeat(64),
      SEED_NOW,
      SEED_NOW,
    )
    .run();

  return objectKey;
}

async function seedProfile(
  profileId: string,
  overrides: Partial<{
    active: number;
    maxFileMb: number;
    minDpi: number;
  }> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pod_profiles (profile_id, label, min_dpi, print_area_w_mm,
       print_area_h_mm, max_file_mb, accepted_formats_json, sort_order, active,
       created_at, updated_at)
     VALUES (?, ?, ?, 300, 400, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(
      profileId,
      `Label ${profileId}`,
      overrides.minDpi ?? 300,
      overrides.maxFileMb ?? 50,
      JSON.stringify([{ ext: "png" }, { ext: "jpg" }]),
      overrides.active ?? 1,
      SEED_NOW,
      SEED_NOW,
    )
    .run();
}

// ── the fake farm ───────────────────────────────────────────────────────────

/**
 * THE WIRE-FORMAT PIN.
 *
 * The fake validates the envelope it receives against contract v0 EXACTLY as
 * the deployed farm's own validator does (functions/src/render-farm/
 * processArtworkJob.ts: isValidEnvelope + isValidProfile + parseAllowedUrl).
 * That duplication is the entire point — the two sides deploy separately and
 * nothing at build time connects them, so a drift in the envelope this worker
 * produces is invisible until it becomes a 400 in production. Here it becomes a
 * failing test.
 *
 * Violations are collected rather than thrown so a test can assert on the whole
 * list and see every drift at once.
 */
function validateEnvelope(envelope: unknown): string[] {
  const violations: string[] = [];
  const record = envelope as Record<string, unknown>;

  if (record.contract !== 1) {
    violations.push("contract must be exactly 1");
  }
  if (record.jobType !== "pod.process_artwork") {
    violations.push("jobType must be pod.process_artwork");
  }
  if (typeof record.jobId !== "string" || record.jobId.length === 0) {
    violations.push("jobId must be a non-empty string");
  }

  // ---- input ----
  const input = record.input as Record<string, unknown> | undefined;
  if (typeof input !== "object" || input === null) {
    violations.push("input must be an object");
  } else {
    if (typeof input.url !== "string") {
      violations.push("input.url must be a string");
    } else {
      violations.push(...validateR2Url(input.url, "input.url"));
    }
    const maxBytes = input.maxBytes;
    if (
      typeof maxBytes !== "number" ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0
    ) {
      violations.push("input.maxBytes must be a positive safe integer");
    } else if (maxBytes > 200 * 1024 * 1024) {
      violations.push("input.maxBytes exceeds the farm's 200MB ceiling");
    }
  }

  // ---- profile: the FIVE fields, and only shapes the core accepts ----
  const profile = record.profile as Record<string, unknown> | undefined;
  if (typeof profile !== "object" || profile === null) {
    violations.push("profile must be an object");
  } else {
    if (typeof profile.id !== "string" || profile.id.length === 0) {
      violations.push("profile.id must be a non-empty string");
    }
    if (
      typeof profile.min_dpi !== "number" ||
      !Number.isSafeInteger(profile.min_dpi) ||
      profile.min_dpi <= 0
    ) {
      violations.push("profile.min_dpi must be a positive safe integer");
    }
    const area = profile.print_area_mm as Record<string, unknown> | undefined;
    if (typeof area !== "object" || area === null) {
      violations.push("profile.print_area_mm must be an object");
    } else {
      if (typeof area.w !== "number" || !(area.w > 0)) {
        violations.push("profile.print_area_mm.w must be a positive number");
      }
      if (typeof area.h !== "number" || !(area.h > 0)) {
        violations.push("profile.print_area_mm.h must be a positive number");
      }
    }
    if (
      profile.max_file_mb !== undefined &&
      (typeof profile.max_file_mb !== "number" || !(profile.max_file_mb > 0))
    ) {
      violations.push("profile.max_file_mb must be a positive number");
    }
    if (profile.accepted_formats !== undefined) {
      if (!Array.isArray(profile.accepted_formats)) {
        violations.push("profile.accepted_formats must be an array");
      } else if (
        !profile.accepted_formats.every(
          (entry: unknown) =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { ext?: unknown }).ext === "string" &&
            (entry as { ext: string }).ext.length > 0,
        )
      ) {
        violations.push("profile.accepted_formats entries need a string ext");
      }
    }
    // The farm never receives presentation fields. This is not the farm's own
    // check — its validator ignores extras — but sending them would mean the
    // worker leaked its display model into the compute contract.
    for (const forbidden of ["label", "active", "sortOrder", "sort_order"]) {
      if (forbidden in profile) {
        violations.push(`profile must not carry ${forbidden}`);
      }
    }
  }

  // ---- output: BOTH PUT urls, allowlist-checked ----
  const output = record.output as Record<string, unknown> | undefined;
  if (typeof output !== "object" || output === null) {
    violations.push("output must be an object");
  } else {
    if (typeof output.printPngPutUrl !== "string") {
      violations.push("output.printPngPutUrl must be a string");
    } else {
      violations.push(
        ...validateR2Url(output.printPngPutUrl, "output.printPngPutUrl"),
      );
    }
    if (typeof output.previewWebpPutUrl !== "string") {
      violations.push("output.previewWebpPutUrl must be a string");
    } else {
      violations.push(
        ...validateR2Url(output.previewWebpPutUrl, "output.previewWebpPutUrl"),
      );
    }
  }

  return violations;
}

/**
 * The farm's own SSRF allowlist, reproduced: https only, and a suffix match on
 * the PARSED hostname (never the raw string). That combination is what defeats
 * `https://evil.com/?x=.r2.cloudflarestorage.com`.
 */
function validateR2Url(raw: string, label: string): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [`${label} is not a valid URL`];
  }

  const violations: string[] = [];
  if (url.protocol !== "https:") {
    violations.push(`${label} must be https`);
  }
  if (!url.hostname.toLowerCase().endsWith(".r2.cloudflarestorage.com")) {
    violations.push(`${label} host is not on the R2 allowlist`);
  }
  return violations;
}

interface FakeFarmOptions {
  /** Bytes the fake actually PUTs, so R2 HEAD sees a real object. */
  previewBytes?: number;
  printBytes?: number;
  /** What the fake REPORTS, which may deliberately disagree with what it PUT. */
  reportedPreviewBytes?: number;
  reportedPrintBytes?: number;
  result?: "failed" | "ok" | "rejected";
  /** Skip the PUTs entirely — the farm that lies about having uploaded. */
  skipUpload?: boolean;
}

/**
 * A fake farm that VALIDATES the envelope and then behaves like the real one.
 *
 * ── WHAT THIS COVERS, AND WHAT IT HONESTLY DOES NOT ────────────────────────
 * COVERED: the wire format (checked field by field against the deployed
 * validator), the response shapes, and — because the fake writes real bytes
 * into the miniflare R2 binding at the keys derived from the presigned URLs —
 * the verify-before-ready path runs for REAL. A HEAD against a missing or
 * wrong-sized object is a genuine R2 answer, not a stub.
 *
 * NOT COVERED, and only a live smoke can: whether R2's S3 endpoint ACCEPTS the
 * SigV4 signature this worker produces. The fake parses the key out of the URL
 * path rather than dereferencing it, so a malformed signature, a wrong region
 * or service name, or a mis-set X-Amz-Expires would pass every test here and
 * fail on the first real dispatch. The handover records this as the one thing
 * staging must prove.
 */
function createFakeFarm(options: FakeFarmOptions = {}): RenderFarmClient {
  const {
    previewBytes = 2_000,
    printBytes = 500_000,
    result = "ok",
    skipUpload = false,
  } = options;

  return {
    async dispatch(envelope: JobEnvelope): Promise<JobResult> {
      farmCallCount += 1;
      lastEnvelope = envelope;
      envelopeViolations = validateEnvelope(envelope);

      if (result === "failed") {
        return { status: "failed" };
      }

      if (result === "rejected") {
        return {
          reasons: [
            {
              code: "resolution_too_low",
              message:
                "Motivet är 900 × 900 px. I sin största tryckstorlek 25 × 25 cm blir det 91 DPI — minimikravet är 300 DPI.",
            },
          ],
          status: "rejected",
        };
      }

      // The real farm PUTs both outputs BEFORE answering 200. The fake does the
      // same, through the binding, at the keys the presigned URLs name — so the
      // verification step afterwards is exercising real R2 state.
      if (!skipUpload) {
        const bucket = env.PRIVATE_BUCKET;
        await bucket.put(
          keyFromPresignedUrl(envelope.output.printPngPutUrl),
          new Uint8Array(printBytes),
          { httpMetadata: { contentType: "image/png" } },
        );
        await bucket.put(
          keyFromPresignedUrl(envelope.output.previewWebpPutUrl),
          new Uint8Array(previewBytes),
          { httpMetadata: { contentType: "image/webp" } },
        );
      }

      return {
        meta: {
          effectiveDpi: 325,
          heightPx: 3200,
          maxPrintMm: { h: 250, w: 250 },
          pipelineVersion: 1,
          profileId: envelope.profile.id,
          widthPx: 3200,
        },
        notices: [
          {
            code: "opaque",
            message: "Bilden saknar transparent bakgrund — hela rektangeln trycks.",
          },
        ],
        outputs: {
          previewWebp: {
            bytes: options.reportedPreviewBytes ?? previewBytes,
            sha256: "b".repeat(64),
          },
          printPng: {
            bytes: options.reportedPrintBytes ?? printBytes,
            sha256: "c".repeat(64),
          },
        },
        status: "ok",
      };
    },
  };
}

/**
 * Recover the object key from a presigned URL.
 *
 * The URL is path-style `https://{account}.r2.cloudflarestorage.com/{bucket}/{key}`,
 * so the key is everything after the bucket segment. This is what lets the fake
 * write to the same keys the binding reads — it stands in for R2 honouring the
 * signature, which is precisely the part only a live smoke can prove.
 */
function keyFromPresignedUrl(raw: string): string {
  const url = new URL(raw);
  const path = url.pathname.replace(/^\/+/, "");
  const firstSlash = path.indexOf("/");
  return decodeURIComponent(path.slice(firstSlash + 1));
}

/**
 * A presigner that produces REAL-SHAPED R2 URLs without credentials.
 *
 * Used so tests assert on URL shape deterministically. The default (real,
 * aws4fetch-backed) presigner is exercised by its own dedicated tests below —
 * this override exists for the route tests, not to avoid the real one.
 */
function createFakePresigner(): R2Presigner {
  const base = "https://testaccount.r2.cloudflarestorage.com/meteorshop-test-private";
  return {
    async presignGet(objectKey: string, ttlSeconds = 900): Promise<string> {
      presignCallCount += 1;
      return `${base}/${objectKey}?X-Amz-Expires=${ttlSeconds}&X-Amz-Signature=fake`;
    },
    async presignPut(objectKey: string, contentType: string): Promise<string> {
      presignCallCount += 1;
      return `${base}/${objectKey}?X-Amz-Expires=900&X-Amz-Signature=fake&ct=${encodeURIComponent(contentType)}`;
    },
  };
}

function podEnv(overrides: Record<PropertyKey, unknown> = {}): Env {
  return {
    ...env,
    [R2_PRESIGNER_OVERRIDE]: createFakePresigner(),
    [RENDER_FARM_OVERRIDE]: createFakeFarm(),
    ...overrides,
  } as unknown as Env;
}

// ── the farm's side of the pull contract (CP1-C) ───────────────────────────

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

interface FarmRun {
  lease: RenderJobLease | null;
  report: Response | null;
}

/**
 * One pass of a pull-based farm through the REAL /v1/render surface: acquire
 * (validating the envelope exactly as createFakeFarm does for the synchronous
 * dispatch), then behave per `options` — PUT the outputs to the attempt keys and
 * complete, complete with a rejection, or report a failure. Reported sha256s
 * are the real hashes of the bytes PUT, because promotion now has R2 verify
 * them; `reported*Bytes` still lets a case lie about sizes.
 */
async function runFarm(
  options: FakeFarmOptions & {
    beforeReport?: (lease: RenderJobLease) => Promise<void>;
  } = {},
  targetEnv: Env = podEnv(),
): Promise<FarmRun> {
  const farmHeaders = () => ({
    authorization: `Bearer ${env.RENDER_FARM_TOKEN}`,
    "cf-connecting-ip": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
    "content-type": "application/json",
  });
  const acquired = await worker.fetch(
    new Request(`${HOST_A}/v1/render/jobs/acquire`, {
      headers: farmHeaders(),
      method: "POST",
    }),
    targetEnv,
  );
  if (acquired.status === 204) {
    return { lease: null, report: null };
  }
  expect(acquired.status).toBe(200);

  const lease = await acquired.json<RenderJobLease>();
  farmCallCount += 1;
  lastEnvelope = lease;
  envelopeViolations = validateEnvelope(lease);

  await options.beforeReport?.(lease);

  const {
    previewBytes = 2_000,
    printBytes = 500_000,
    result = "ok",
    skipUpload = false,
  } = options;
  const report = (action: "complete" | "fail", body: unknown) =>
    worker.fetch(
      new Request(`${HOST_A}/v1/render/jobs/${lease.jobId}/${action}`, {
        body: JSON.stringify(body),
        headers: farmHeaders(),
        method: "POST",
      }),
      targetEnv,
    );
  const claim = { attempt: lease.attempt, leaseToken: lease.leaseToken };

  if (result === "failed") {
    return { lease, report: await report("fail", { ...claim, error: "job_failed" }) };
  }

  if (result === "rejected") {
    return {
      lease,
      report: await report("complete", {
        ...claim,
        ok: false,
        reasons: [
          {
            code: "resolution_too_low",
            message:
              "Motivet är 900 × 900 px. I sin största tryckstorlek 25 × 25 cm blir det 91 DPI — minimikravet är 300 DPI.",
          },
        ],
      }),
    };
  }

  const printData = new Uint8Array(printBytes);
  const previewData = new Uint8Array(previewBytes);
  const printKey = keyFromPresignedUrl(lease.output.printPngPutUrl);
  const previewKey = keyFromPresignedUrl(lease.output.previewWebpPutUrl);
  if (!skipUpload) {
    await env.PRIVATE_BUCKET.put(printKey, printData, {
      httpMetadata: { contentType: "image/png" },
    });
    await env.PRIVATE_BUCKET.put(previewKey, previewData, {
      httpMetadata: { contentType: "image/webp" },
    });
  }

  return {
    lease,
    report: await report("complete", {
      ...claim,
      fields: {
        effectiveDpi: 325,
        heightPx: 3200,
        maxPrintMm: { h: 250, w: 250 },
        pipelineVersion: 1,
        profileId: lease.profile.id,
        widthPx: 3200,
      },
      notices: [
        {
          code: "opaque",
          message: "Bilden saknar transparent bakgrund — hela rektangeln trycks.",
        },
      ],
      ok: true,
      outputs: {
        previewWebp: {
          bytes: options.reportedPreviewBytes ?? previewBytes,
          key: previewKey,
          sha256: await sha256Hex(previewData),
        },
        printPng: {
          bytes: options.reportedPrintBytes ?? printBytes,
          key: printKey,
          sha256: await sha256Hex(printData),
        },
      },
    }),
  };
}

async function renderJobCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM render_jobs").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

/** An env with one POD config value removed — the dark-surface fixture. */
function envMissing(key: string): Env {
  const stripped = { ...podEnv() } as Record<string, unknown>;
  stripped[key] = undefined;
  return stripped as unknown as Env;
}

interface RequestOptions {
  body?: unknown;
  cookie?: string;
  host?: string;
  method?: string;
  origin?: string | null;
  shopId?: string | null;
}

/**
 * Admin routes take the active shop from `X-Shop-Id` (PLAN §2.1), never from
 * the hostname. Each fixture host stands for one shop, so the helper names the
 * shop its host stands for; `shopId` overrides that and `null` omits it.
 * A platform route is never called in a shop's context (DECISIONS D70: a
 * request naming a shop is refused there), so for `/v1/platform/**` the
 * default is NO header, as a platform client sends it.
 */
const SHOP_BY_HOST: Record<string, string> = {
  [new URL(HOST_A).host]: TENANT_A,
  [new URL(HOST_B).host]: TENANT_B,
};

function podRequest(path: string, options: RequestOptions = {}): Request {
  const {
    body,
    cookie,
    host = HOST_A,
    method = "GET",
    origin = host,
  } = options;
  const shopId =
    options.shopId !== undefined
      ? options.shopId
      : path.startsWith("/v1/platform/")
        ? null
        : SHOP_BY_HOST[new URL(host).host];

  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (shopId !== undefined && shopId !== null) {
    headers["x-shop-id"] = shopId;
  }
  if (origin !== null) {
    headers.origin = origin;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  // A distinct IP per request so the dispatch limiter (5/min) does not turn
  // unrelated cases into misleading 429s. Tests that exercise the limiter set
  // this deliberately.
  headers["cf-connecting-ip"] = `10.0.0.${Math.floor(Math.random() * 250) + 1}`;

  return new Request(`${host}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
  });
}

beforeAll(async () => {
  adminA = await signUp("pod-admin-a@example.test");
  adminB = await signUp("pod-admin-b@example.test");
  platformAdmin = await signUp("pod-platform@example.test");

  await seedTenant(TENANT_A, "admin-a.podartwork.test");
  await seedTenant(TENANT_B, "admin-b.podartwork.test");

  await seedAccess(adminA.userId, "tenant_admin");
  await seedAccess(adminB.userId, "tenant_admin");
  await seedAccess(platformAdmin.userId, "platform_admin");

  await seedMembership(adminA.userId, TENANT_A);
  await seedMembership(adminB.userId, TENANT_B);
});

beforeEach(async () => {
  farmCallCount = 0;
  lastEnvelope = null;
  envelopeViolations = [];
  presignCallCount = 0;
  // Before pod_artwork, and for a sharper reason than tidiness: acquire is
  // GLOBAL, so a queued job left by one case would be leased by the next.
  await env.DB.prepare("DELETE FROM render_jobs").run();
  await env.DB.prepare("DELETE FROM pod_artwork").run();
  await env.DB.prepare("DELETE FROM pod_profiles").run();
  await env.DB.prepare("DELETE FROM rate_limit_windows").run();

  // ── FIXTURE TRAP, recorded ────────────────────────────────────────────────
  // The miniflare R2 bucket PERSISTS across tests in a file while D1 is
  // truncated above, so object counts accumulate and any `toHaveLength(2)`
  // assertion silently drifts upward. Four tests failed on this and NONE of
  // them was a product defect — the same class as checkpoint 24's per-instance
  // counter and checkpoint 22's frozen-NOW window. Anything that asserts on
  // bucket CONTENTS must start from a known-empty bucket.
  for (const prefix of [`pod/${TENANT_A}/`, `pod/${TENANT_B}/`]) {
    const listed = await env.PRIVATE_BUCKET.list({ prefix });
    await Promise.all(
      listed.objects.map((object) => env.PRIVATE_BUCKET.delete(object.key)),
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the dark surface", () => {
  // Every one of the six values, individually. The gate is all-or-nothing, and
  // a test per value is what proves it rather than one test proving the
  // easiest case.
  // RENDER_FARM_URL is NOT in this list any more: the async pull model
  // (CP1-C/D) never calls a farm URL, so its absence must not darken the
  // surface — pinned by the test after this loop.
  const CONFIG_KEYS = [
    "RENDER_FARM_TOKEN",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ACCOUNT_ID",
    "R2_PRIVATE_BUCKET_NAME",
  ];

  const ROUTES: Array<[string, string]> = [
    ["GET", "/v1/admin/pod/profiles"],
    ["GET", "/v1/admin/pod/artwork"],
    ["POST", "/v1/admin/pod/artwork"],
    ["GET", "/v1/admin/pod/artwork/some-id"],
    ["DELETE", "/v1/admin/pod/artwork/some-id"],
    ["PUT", "/v1/platform/pod/profiles"],
  ];

  it("stays UP without RENDER_FARM_URL (the pull model needs no farm URL)", async () => {
    const response = await worker.fetch(
      podRequest("/v1/admin/pod/profiles", { cookie: adminA.cookie, method: "GET" }),
      envMissing("RENDER_FARM_URL"),
    );
    expect(response.status).toBe(200);
  });

  for (const key of CONFIG_KEYS) {
    for (const [method, path] of ROUTES) {
      it(`404s ${method} ${path} while ${key} is missing`, async () => {
        const response = await worker.fetch(
          podRequest(path, {
            body: method === "GET" || method === "DELETE" ? undefined : {},
            cookie: adminA.cookie,
            method,
          }),
          envMissing(key),
        );

        expect(response.status).toBe(404);
        expect(farmCallCount).toBe(0);
      });
    }
  }

  it("gates BEFORE the session guard, the method check and D1", async () => {
    // An authenticated admin with a well-formed body still sees 404, and a
    // completely unauthenticated caller sees the identical answer — so an
    // unconfigured deployment is indistinguishable from one where the route was
    // never written.
    const authed = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId: "x", profileId: "y", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      envMissing("RENDER_FARM_TOKEN"),
    );
    const anonymous = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId: "x", profileId: "y", rightsConfirmed: true },
        method: "POST",
      }),
      envMissing("RENDER_FARM_TOKEN"),
    );

    expect(authed.status).toBe(404);
    expect(anonymous.status).toBe(404);
    expect(await authed.json()).toStrictEqual(await anonymous.json());
  });

  // Codex CP1-C P2: the admin surface used to need only a ≥16-character farm
  // token while the pull surface needs ≥32, so a 16–31-character token queued
  // artworks no farm could ever acquire — 'processing' forever.
  it("a farm token the pull surface refuses (16–31 chars) darkens creation: 404, nothing queued", async () => {
    await seedProfile("apparel_dtg");
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const twentyCharToken = { ...podEnv(), RENDER_FARM_TOKEN: "t".repeat(20) } as unknown as Env;

    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      twentyCharToken,
    );
    expect(created.status).toBe(404);
    expect(await renderJobCount()).toBe(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM pod_artwork").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(0);

    // The same configuration really cannot serve a farm: the pull surface is dark.
    const acquire = await worker.fetch(
      new Request(`${HOST_A}/v1/render/jobs/acquire`, {
        headers: { authorization: `Bearer ${"t".repeat(20)}` },
        method: "POST",
      }),
      twentyCharToken,
    );
    expect(acquire.status).toBe(404);
  });

  it("creation is dark while the private bucket is unbound (completion could never promote)", async () => {
    await seedProfile("apparel_dtg");
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      { ...podEnv(), PRIVATE_BUCKET: undefined } as unknown as Env,
    );
    expect(created.status).toBe(404);
    expect(await renderJobCount()).toBe(0);
  });

  it("a too-short secret counts as absent", async () => {
    const response = await worker.fetch(
      podRequest("/v1/admin/pod/profiles", { cookie: adminA.cookie }),
      { ...podEnv(), RENDER_FARM_TOKEN: "short" } as unknown as Env,
    );

    expect(response.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("profiles", () => {
  it("platform PUT replaces the list and tenant GET sees the active ones", async () => {
    const replace = await worker.fetch(
      podRequest("/v1/platform/pod/profiles", {
        body: {
          profiles: [
            {
              acceptedFormats: [{ ext: "png" }, { ext: "jpg" }],
              active: true,
              label: "Textil (DTG)",
              maxFileMb: 50,
              minDpi: 300,
              printAreaMm: { h: 400, w: 300 },
              profileId: "apparel_dtg",
              sortOrder: 0,
            },
            {
              acceptedFormats: [{ ext: "png" }],
              active: false,
              label: "Retired",
              maxFileMb: 50,
              minDpi: 300,
              printAreaMm: { h: 250, w: 250 },
              profileId: "bag_dtg",
              sortOrder: 1,
            },
          ],
        },
        cookie: platformAdmin.cookie,
        method: "PUT",
      }),
      podEnv(),
    );

    expect(replace.status).toBe(200);

    const list = await worker.fetch(
      podRequest("/v1/admin/pod/profiles", { cookie: adminA.cookie }),
      podEnv(),
    );
    const body = await list.json<{ profiles: Array<{ profileId: string }> }>();

    expect(list.status).toBe(200);
    // The inactive one is filtered out — a retired profile must not appear in a
    // picker that would let a tenant produce artwork under a dead spec.
    expect(body.profiles.map((profile) => profile.profileId)).toStrictEqual([
      "apparel_dtg",
    ]);
  });

  it("a full replace retires profiles absent from the new list", async () => {
    await seedProfile("old_one");
    await seedProfile("old_two");

    const replace = await worker.fetch(
      podRequest("/v1/platform/pod/profiles", {
        body: {
          profiles: [
            {
              acceptedFormats: [{ ext: "png" }],
              active: true,
              label: "Only",
              maxFileMb: 10,
              minDpi: 300,
              printAreaMm: { h: 100, w: 100 },
              profileId: "only_one",
              sortOrder: 0,
            },
          ],
        },
        cookie: platformAdmin.cookie,
        method: "PUT",
      }),
      podEnv(),
    );

    expect(replace.status).toBe(200);

    const rows = await env.DB.prepare(
      "SELECT profile_id FROM pod_profiles ORDER BY profile_id",
    ).all<{ profile_id: string }>();

    expect(rows.results.map((row) => row.profile_id)).toStrictEqual([
      "only_one",
    ]);
  });

  it("an empty list is accepted and makes every upload impossible", async () => {
    await seedProfile("apparel_dtg");

    const replace = await worker.fetch(
      podRequest("/v1/platform/pod/profiles", {
        body: { profiles: [] },
        cookie: platformAdmin.cookie,
        method: "PUT",
      }),
      podEnv(),
    );

    expect(replace.status).toBe(200);

    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const dispatch = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );

    expect(dispatch.status).toBe(404);
    expect(farmCallCount).toBe(0);
  });

  const INVALID_PROFILE_BODIES: Array<[string, unknown]> = [
    ["a bare array instead of {profiles}", [{ profileId: "x" }]],
    ["an unknown top-level key", { extra: 1, profiles: [] }],
    [
      "an unknown profile key",
      {
        profiles: [
          {
            acceptedFormats: [{ ext: "png" }],
            active: true,
            colorMode: "rgb",
            label: "X",
            maxFileMb: 10,
            minDpi: 300,
            printAreaMm: { h: 10, w: 10 },
            profileId: "x",
            sortOrder: 0,
          },
        ],
      },
    ],
    [
      "a zero print area",
      {
        profiles: [
          {
            acceptedFormats: [{ ext: "png" }],
            active: true,
            label: "X",
            maxFileMb: 10,
            minDpi: 300,
            printAreaMm: { h: 0, w: 10 },
            profileId: "x",
            sortOrder: 0,
          },
        ],
      },
    ],
    [
      "a format sharp cannot rasterize",
      {
        profiles: [
          {
            acceptedFormats: [{ ext: "pdf" }],
            active: true,
            label: "X",
            maxFileMb: 10,
            minDpi: 300,
            printAreaMm: { h: 10, w: 10 },
            profileId: "x",
            sortOrder: 0,
          },
        ],
      },
    ],
    [
      "an empty accepted-formats list",
      {
        profiles: [
          {
            acceptedFormats: [],
            active: true,
            label: "X",
            maxFileMb: 10,
            minDpi: 300,
            printAreaMm: { h: 10, w: 10 },
            profileId: "x",
            sortOrder: 0,
          },
        ],
      },
    ],
    [
      "bare string formats instead of the contract shape",
      {
        profiles: [
          {
            acceptedFormats: ["png"],
            active: true,
            label: "X",
            maxFileMb: 10,
            minDpi: 300,
            printAreaMm: { h: 10, w: 10 },
            profileId: "x",
            sortOrder: 0,
          },
        ],
      },
    ],
    [
      "duplicate profile ids",
      {
        profiles: [
          {
            acceptedFormats: [{ ext: "png" }],
            active: true,
            label: "X",
            maxFileMb: 10,
            minDpi: 300,
            printAreaMm: { h: 10, w: 10 },
            profileId: "dup",
            sortOrder: 0,
          },
          {
            acceptedFormats: [{ ext: "png" }],
            active: true,
            label: "Y",
            maxFileMb: 10,
            minDpi: 300,
            printAreaMm: { h: 10, w: 10 },
            profileId: "dup",
            sortOrder: 1,
          },
        ],
      },
    ],
  ];

  for (const [label, body] of INVALID_PROFILE_BODIES) {
    it(`rejects ${label}`, async () => {
      const response = await worker.fetch(
        podRequest("/v1/platform/pod/profiles", {
          body,
          cookie: platformAdmin.cookie,
          method: "PUT",
        }),
        podEnv(),
      );

      expect(response.status).toBe(400);
    });
  }

  it("a tenant admin cannot replace the platform profile list", async () => {
    const response = await worker.fetch(
      podRequest("/v1/platform/pod/profiles", {
        body: { profiles: [] },
        cookie: adminA.cookie,
        method: "PUT",
      }),
      podEnv(),
    );

    expect(response.status).toBe(404);
  });

  it("an anonymous caller cannot read the profile list", async () => {
    await seedProfile("apparel_dtg");

    const response = await worker.fetch(
      podRequest("/v1/admin/pod/profiles"),
      podEnv(),
    );

    expect(response.status).toBe(404);
  });

  it("a cross-site PUT is refused before the body is parsed", async () => {
    const response = await worker.fetch(
      podRequest("/v1/platform/pod/profiles", {
        body: "not-even-an-object",
        cookie: platformAdmin.cookie,
        method: "PUT",
        origin: "https://evil.test",
      }),
      podEnv(),
    );

    // 404, not 400: a malformed body from a cross-site caller must not reveal
    // that the parser ran.
    expect(response.status).toBe(404);
  });

  it("records an audit row naming the profile ids and no dimensions", async () => {
    await worker.fetch(
      podRequest("/v1/platform/pod/profiles", {
        body: {
          profiles: [
            {
              acceptedFormats: [{ ext: "png" }],
              active: true,
              label: "Textil",
              maxFileMb: 50,
              minDpi: 300,
              printAreaMm: { h: 400, w: 300 },
              profileId: "apparel_dtg",
              sortOrder: 0,
            },
          ],
        },
        cookie: platformAdmin.cookie,
        method: "PUT",
      }),
      podEnv(),
    );

    // Newest first: audit_events is APPEND-ONLY by trigger, so earlier tests'
    // rows are still there and a bare LIMIT 1 would read one of theirs.
    const audit = await env.DB.prepare(
      `SELECT tenant_id, metadata_json FROM audit_events
       WHERE action = 'pod.profiles.replace'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).first<{ metadata_json: string; tenant_id: string | null }>();

    expect(audit).not.toBeNull();
    // Platform action, so no tenant.
    expect(audit?.tenant_id).toBeNull();
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toStrictEqual({
      count: 1,
      profileIds: ["apparel_dtg"],
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CP1-C: creation is ASYNCHRONOUS. The POST answers 202 with a 'processing'
// artwork and a queued render job; the farm pulls the job through /v1/render
// (runFarm above, the real routes); the detail GET is the poll. The sync
// dispatch's assertions are kept below in their async form — same envelope
// pin, same persisted facts, same verify-before-ready — and the synchronous
// code path itself is pinned by the "synchronous fallback" block.
describe("creation — queued, then polled", () => {
  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  it("answers 202 with a processing artwork and a queued job, and nudges the queue", async () => {
    const objectId = crypto.randomUUID();
    const originalKey = await seedOriginal(TENANT_A, objectId);
    const sent: unknown[] = [];

    const response = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv({
        RENDER_JOBS_QUEUE: {
          send: async (body: unknown) => {
            sent.push(body);
          },
        },
      }),
    );

    expect(response.status).toBe(202);
    const body = await response.json<{ artwork: Record<string, unknown> }>();
    expect(body.artwork.status).toBe("processing");
    expect(body.artwork.effectiveDpi).toBeNull();
    // Creation only queues: no farm was called, nothing was presigned.
    expect(farmCallCount).toBe(0);
    expect(presignCallCount).toBe(0);

    const jobs = await env.DB.prepare(
      `SELECT id, tenant_id, artwork_id, version, attempt, state, input_key,
              input_bytes, profile_json
       FROM render_jobs`,
    ).all<Record<string, unknown>>();
    expect(jobs.results).toHaveLength(1);
    const job = jobs.results[0];
    expect(job).toMatchObject({
      artwork_id: body.artwork.artworkId,
      attempt: 0,
      input_bytes: 4_000_000,
      input_key: originalKey,
      state: "queued",
      tenant_id: TENANT_A,
      version: 1,
    });
    // The profile is FROZEN into the job: every attempt measures under it.
    expect(JSON.parse(String(job?.profile_json))).toStrictEqual({
      accepted_formats: [{ ext: "png" }, { ext: "jpg" }],
      id: "apparel_dtg",
      max_file_mb: 50,
      min_dpi: 300,
      print_area_mm: { h: 400, w: 300 },
    });
    expect(sent).toStrictEqual([{ renderJobId: job?.id }]);

    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action = 'pod.artwork.dispatch' AND resource_id = ?`,
    )
      .bind(body.artwork.artworkId as string)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toStrictEqual({
      profileId: "apparel_dtg",
      renderJobId: job?.id,
      rightsConfirmed: true,
    });
  });

  it("the detail GET is the poll: processing, then the verdict", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    const { artwork } = await created.json<{ artwork: { artworkId: string } }>();
    const poll = async () => {
      const response = await worker.fetch(
        podRequest(`/v1/admin/pod/artwork/${artwork.artworkId}`, { cookie: adminA.cookie }),
        podEnv(),
      );
      return response.json<{ artwork: { status: string }; previewUrl: string | null }>();
    };

    const before = await poll();
    expect(before.artwork.status).toBe("processing");
    expect(before.previewUrl).toBeNull();

    const { report } = await runFarm();
    expect(report?.status).toBe(200);

    const after = await poll();
    expect(after.artwork.status).toBe("ready");
    expect(after.previewUrl).toContain("X-Amz-Expires=300");
  });

  it("a queue that refuses the nudge does not fail the request: the row is the truth", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv({
        RENDER_JOBS_QUEUE: {
          send: async () => {
            throw new Error("queue unavailable");
          },
        },
      }),
    );
    warn.mockRestore();

    expect(response.status).toBe(202);
    const { report } = await runFarm();
    expect(report?.status).toBe(200);
  });

  it("the synchronous fallback is switched off", () => {
    expect(SYNC_RENDER_FALLBACK).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("render — the happy path", () => {
  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  async function post(objectId: string): Promise<Response> {
    return worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
  }

  it("hands the farm an envelope that satisfies its validator exactly", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    expect((await post(objectId)).status).toBe(202);
    const { report } = await runFarm();

    expect(report?.status).toBe(200);
    // THE PIN. Any drift in the envelope this worker builds shows up here as a
    // named violation rather than as a 400 in production.
    expect(envelopeViolations).toStrictEqual([]);
    expect(farmCallCount).toBe(1);

    expect(lastEnvelope?.contract).toBe(1);
    expect(lastEnvelope?.jobType).toBe("pod.process_artwork");
    // The profile carries exactly the five fields the pure core consumes.
    expect(Object.keys(lastEnvelope?.profile ?? {}).sort()).toStrictEqual([
      "accepted_formats",
      "id",
      "max_file_mb",
      "min_dpi",
      "print_area_mm",
    ]);
  });

  it("bounds maxBytes by the object's real size, not the profile's cap", async () => {
    const objectId = crypto.randomUUID();
    // 1 MB object under a 50 MB profile: the envelope must ask for 1 MB.
    await seedOriginal(TENANT_A, objectId, 1_048_576);

    await post(objectId);
    await runFarm();

    expect(lastEnvelope?.input.maxBytes).toBe(1_048_576);
  });

  it("persists the exact verdict facts including sha256 and bytes", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    await post(objectId);
    const { report } = await runFarm();
    expect(report?.status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT status, width_px, height_px, effective_dpi, max_print_w_mm,
              max_print_h_mm, pipeline_version, print_sha256, print_bytes,
              preview_sha256, preview_bytes, print_object_key,
              preview_object_key, notices_json, reasons_json, tenant_id
       FROM pod_artwork LIMIT 1`,
    ).first<Record<string, unknown>>();

    expect(row?.status).toBe("ready");
    expect(row?.width_px).toBe(3200);
    expect(row?.height_px).toBe(3200);
    expect(row?.effective_dpi).toBe(325);
    expect(row?.max_print_w_mm).toBe(250);
    expect(row?.max_print_h_mm).toBe(250);
    expect(row?.pipeline_version).toBe(1);
    // Real hashes of the bytes the farm PUT: promotion has R2 verify them, so
    // the fixed placeholder hashes the synchronous tests used cannot pass.
    expect(row?.print_sha256).toBe(await sha256Hex(new Uint8Array(500_000)));
    expect(row?.print_bytes).toBe(500_000);
    expect(row?.preview_sha256).toBe(await sha256Hex(new Uint8Array(2_000)));
    expect(row?.preview_bytes).toBe(2_000);
    expect(row?.reasons_json).toBeNull();
    expect(JSON.parse(String(row?.notices_json))).toStrictEqual([
      {
        code: "opaque",
        message: "Bilden saknar transparent bakgrund — hela rektangeln trycks.",
      },
    ]);
    // The row lands under the OWNER tenant.
    expect(row?.tenant_id).toBe(TENANT_A);
    // Output keys live under the dedicated pod/ prefix, never shops/ — and are
    // the canonical keys, not the attempt keys the farm wrote to.
    expect(String(row?.print_object_key)).toMatch(
      new RegExp(`^pod/${TENANT_A}/print/[0-9a-f-]+\\.png$`),
    );
    expect(String(row?.preview_object_key)).toMatch(
      new RegExp(`^pod/${TENANT_A}/preview/[0-9a-f-]+\\.webp$`),
    );
  });

  it("pins the output content types into the presigned PUT urls", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    await post(objectId);
    await runFarm();

    expect(lastEnvelope?.output.printPngPutUrl).toContain("image%2Fpng");
    expect(lastEnvelope?.output.previewWebpPutUrl).toContain("image%2Fwebp");
  });

  it("both outputs actually exist in R2 after a ready verdict, and nothing else does", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    await post(objectId);
    await runFarm();

    const row = await env.DB.prepare(
      "SELECT print_object_key, preview_object_key FROM pod_artwork LIMIT 1",
    ).first<{ preview_object_key: string; print_object_key: string }>();

    const print = await env.PRIVATE_BUCKET.head(row?.print_object_key ?? "");
    const preview = await env.PRIVATE_BUCKET.head(row?.preview_object_key ?? "");

    expect(print?.size).toBe(500_000);
    expect(preview?.size).toBe(2_000);
    // The attempt copies were swept after promotion.
    const listed = await env.PRIVATE_BUCKET.list({ prefix: `pod/${TENANT_A}/` });
    expect(listed.objects.map((object) => object.key).sort()).toStrictEqual(
      [row?.preview_object_key, row?.print_object_key].sort(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("render — verdicts and failures", () => {
  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  async function post(objectId: string, profileId = "apparel_dtg"): Promise<Response> {
    return worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId, rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
  }

  it("a rejection persists reasons and KEEPS the original", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    const created = await post(objectId);
    const { artwork } = await created.json<{ artwork: { artworkId: string } }>();
    const { report } = await runFarm({ result: "rejected" });
    // The farm's report is accepted: the request was correct and the artwork
    // is what failed.
    expect(report?.status).toBe(200);

    const detail = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artwork.artworkId}`, { cookie: adminA.cookie }),
      podEnv(),
    );
    const body = await detail.json<{
      artwork: { reasons: Array<{ code: string }>; status: string };
    }>();
    expect(body.artwork.status).toBe("rejected");
    expect(body.artwork.reasons[0]?.code).toBe("resolution_too_low");

    const row = await env.DB.prepare(
      "SELECT status, reasons_json, print_object_key FROM pod_artwork LIMIT 1",
    ).first<Record<string, unknown>>();
    expect(row?.status).toBe("rejected");
    expect(row?.print_object_key).toBeNull();
    expect(JSON.parse(String(row?.reasons_json))).toHaveLength(1);

    // THE DIVERGENCE FROM PROD, pinned: prod's new-upload mode deletes a
    // rejected upload's original. Here the original is a checkpoint-16 object
    // owned by another module, so it survives and its owner decides.
    const original = await env.DB.prepare(
      "SELECT status FROM stored_objects WHERE object_id = ?",
    )
      .bind(objectId)
      .first<{ status: string }>();
    expect(original?.status).toBe("active");
  });

  it("three farm failures end the job, leave NO stuck processing row, and a retry succeeds", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    expect((await post(objectId)).status).toBe(202);

    // Attempts 1 and 2 requeue; the artwork keeps saying 'processing'.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const { report } = await runFarm({ result: "failed" });
      expect(await report?.json()).toStrictEqual({ status: "queued" });
      const row = await env.DB.prepare("SELECT status FROM pod_artwork").first<{ status: string }>();
      expect(row?.status).toBe("processing");
    }

    const { report } = await runFarm({ result: "failed" });
    expect(await report?.json()).toStrictEqual({ status: "failed" });

    const stuck = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pod_artwork",
    ).first<{ n: number }>();
    expect(stuck?.n).toBe(0);
    const alerts = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM alerts WHERE kind = 'render_job_failed' AND tenant_id = ?",
    )
      .bind(TENANT_A)
      .first<{ n: number }>();
    expect(alerts?.n).toBeGreaterThanOrEqual(1);

    // REPLAY IS THE RETRY: the identical request now works, because the row the
    // failed job would have left behind does not occupy the UNIQUE triple.
    expect((await post(objectId)).status).toBe(202);
    expect((await runFarm()).report?.status).toBe(200);
  });

  it("a size disagreement does NOT mark ready", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    await post(objectId);

    // The farm PUTs 500_000 bytes but claims it wrote 999_999 — exactly the
    // shape a truncated upload takes.
    const { report } = await runFarm({ printBytes: 500_000, reportedPrintBytes: 999_999 });
    expect(report?.status).toBe(422);

    const row = await env.DB.prepare(
      "SELECT status, print_object_key FROM pod_artwork",
    ).first<{ print_object_key: string | null; status: string }>();
    expect(row?.status).toBe("processing");
    expect(row?.print_object_key).toBeNull();
    // The job goes back to the queue for another attempt.
    const job = await env.DB.prepare("SELECT state FROM render_jobs").first<{ state: string }>();
    expect(job?.state).toBe("queued");
  });

  it("a farm that never uploaded does NOT mark ready", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    await post(objectId);

    const { report } = await runFarm({ skipUpload: true });
    expect(report?.status).toBe(422);

    const row = await env.DB.prepare("SELECT status FROM pod_artwork").first<{ status: string }>();
    expect(row?.status).toBe("processing");
  });

  it("sweeps half-written outputs when verification fails", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    await post(objectId);

    const { report } = await runFarm({ previewBytes: 1_000, reportedPreviewBytes: 7 });
    expect(report?.status).toBe(422);

    // Nothing must be left at a key no row claims.
    const listed = await env.PRIVATE_BUCKET.list({ prefix: `pod/${TENANT_A}/` });
    expect(listed.objects).toHaveLength(0);
  });

  it("two racing creations produce ONE row and ONE job", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    const [first, second] = await Promise.all([post(objectId), post(objectId)]);
    const statuses = [first.status, second.status].sort();

    // One winner, one conflict — the UNIQUE triple arbitrates before anything
    // is queued, so the loser leaves no job behind.
    expect(statuses).toStrictEqual([202, 409]);
    expect(await renderJobCount()).toBe(1);

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pod_artwork",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("the same original under a DIFFERENT profile is allowed", async () => {
    await seedProfile("bag_dtg");
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    expect((await post(objectId, "apparel_dtg")).status).toBe(202);
    expect((await post(objectId, "bag_dtg")).status).toBe(202);
    expect(await renderJobCount()).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the synchronous fallback (SYNC_RENDER_FALLBACK = true path)", () => {
  // The route no longer reaches createArtwork (the constant is false); these
  // cases call it directly so the kept code stays proven until it is deleted.
  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  function principalA(): TenantAdminPrincipal {
    return {
      accountType: "tenant_admin",
      role: "admin",
      tenantId: TENANT_A,
      userId: adminA.userId,
    };
  }

  it("dispatches synchronously and writes a ready verdict", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    const result = await createArtwork(
      podEnv(),
      env.DB,
      createFakeFarm(),
      createFakePresigner(),
      principalA(),
      { label: null, objectId, profileId: "apparel_dtg" },
      Date.now(),
    );

    expect(result.status).toBe("created");
    expect(envelopeViolations).toStrictEqual([]);
    expect(farmCallCount).toBe(1);
    expect(await renderJobCount()).toBe(0);
    const row = await env.DB.prepare(
      "SELECT status, print_sha256, print_object_key FROM pod_artwork",
    ).first<Record<string, unknown>>();
    expect(row?.status).toBe("ready");
    expect(row?.print_sha256).toBe("c".repeat(64));
    expect(String(row?.print_object_key)).toMatch(new RegExp(`^pod/${TENANT_A}/print/`));
  });

  it("persists a synchronous rejection", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    const result = await createArtwork(
      podEnv(),
      env.DB,
      createFakeFarm({ result: "rejected" }),
      createFakePresigner(),
      principalA(),
      { label: null, objectId, profileId: "apparel_dtg" },
      Date.now(),
    );

    expect(result.status).toBe("rejected");
  });

  it("deletes its row on a farm failure", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    const result = await createArtwork(
      podEnv(),
      env.DB,
      createFakeFarm({ result: "failed" }),
      createFakePresigner(),
      principalA(),
      { label: null, objectId, profileId: "apparel_dtg" },
      Date.now(),
    );

    expect(result.status).toBe("farm_error");
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM pod_artwork").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("creation — ownership and validation", () => {
  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  it("another tenant's original is an opaque 404", async () => {
    const objectId = crypto.randomUUID();
    // Owned by B; A asks for it.
    await seedOriginal(TENANT_B, objectId);

    const response = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );

    expect(response.status).toBe(404);
    expect(await renderJobCount()).toBe(0);
  });

  it("a PENDING original is refused — its bytes may not exist", async () => {
    const objectId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO stored_objects (object_id, tenant_id, bucket, object_key, kind,
         content_type, size_bytes, sha256, status, immutable, created_at, updated_at)
       VALUES (?, ?, 'private', ?, 'artwork_original', 'image/png', 100, ?, 'pending', 0, ?, ?)`,
    )
      .bind(
        objectId,
        TENANT_A,
        `shops/${TENANT_A}/artwork_original/${objectId}/v1/x.png`,
        "a".repeat(64),
        SEED_NOW,
        SEED_NOW,
      )
      .run();

    const response = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );

    expect(response.status).toBe(404);
    expect(await renderJobCount()).toBe(0);
  });

  it("an object of the wrong KIND is refused", async () => {
    const objectId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO stored_objects (object_id, tenant_id, bucket, object_key, kind,
         content_type, size_bytes, sha256, status, immutable, created_at, updated_at)
       VALUES (?, ?, 'private', ?, 'document', 'application/pdf', 100, ?, 'active', 0, ?, ?)`,
    )
      .bind(
        objectId,
        TENANT_A,
        `shops/${TENANT_A}/document/${objectId}/v1/x.pdf`,
        "a".repeat(64),
        SEED_NOW,
        SEED_NOW,
      )
      .run();

    const response = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );

    expect(response.status).toBe(404);
    expect(await renderJobCount()).toBe(0);
  });

  it("a retired profile is refused", async () => {
    await seedProfile("retired_one", { active: 0 });
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    const response = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "retired_one", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );

    expect(response.status).toBe(404);
    expect(await renderJobCount()).toBe(0);
  });

  const INVALID_BODIES: Array<[string, unknown]> = [
    ["a missing profileId", { objectId: "x", rightsConfirmed: true }],
    ["a missing objectId", { profileId: "y", rightsConfirmed: true }],
    ["an extra steering key", { maxBytes: 999, objectId: "x", profileId: "y", rightsConfirmed: true }],
    ["a printKey the caller invented", { objectId: "x", printKey: "pod/x", profileId: "y", rightsConfirmed: true }],
    ["a non-string objectId", { objectId: 12, profileId: "y", rightsConfirmed: true }],
    ["an empty objectId", { objectId: "", profileId: "y", rightsConfirmed: true }],
    ["an array body", []],
  ];

  for (const [label, body] of INVALID_BODIES) {
    it(`rejects ${label} without queueing anything`, async () => {
      const response = await worker.fetch(
        podRequest("/v1/admin/pod/artwork", {
          body,
          cookie: adminA.cookie,
          method: "POST",
        }),
        podEnv(),
      );

      expect(response.status).toBe(400);
      expect(await renderJobCount()).toBe(0);
    });
  }

  it("an anonymous creation is a 404 and queues nothing", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    const response = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        method: "POST",
      }),
      podEnv(),
    );

    expect(response.status).toBe(404);
    expect(await renderJobCount()).toBe(0);
  });

  it("a cross-site dispatch is refused before the body is parsed", async () => {
    const response = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: "not-an-object",
        cookie: adminA.cookie,
        method: "POST",
        origin: "https://evil.test",
      }),
      podEnv(),
    );

    expect(response.status).toBe(404);
    expect(await renderJobCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the rate limiter", () => {
  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  it("counts the dispatch route and refuses the sixth attempt", async () => {
    const responses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const objectId = crypto.randomUUID();
      await seedOriginal(TENANT_A, objectId);

      const request = new Request(`${HOST_A}/v1/admin/pod/artwork`, {
        body: JSON.stringify({ objectId, profileId: "apparel_dtg", rightsConfirmed: true }),
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          "content-type": "application/json",
          cookie: adminA.cookie,
          origin: HOST_A,
          "x-shop-id": TENANT_A,
        },
        method: "POST",
      });

      responses.push((await worker.fetch(request, podEnv())).status);
    }

    expect(responses.slice(0, 5)).toStrictEqual([202, 202, 202, 202, 202]);
    expect(responses[5]).toBe(429);
    // The sixth request queued nothing.
    expect(await renderJobCount()).toBe(5);
  });

  it("runs BEFORE the farm is touched, even for an invalid body", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const objectId = crypto.randomUUID();
      await seedOriginal(TENANT_A, objectId);
      await worker.fetch(
        new Request(`${HOST_A}/v1/admin/pod/artwork`, {
          body: JSON.stringify({ objectId, profileId: "apparel_dtg", rightsConfirmed: true }),
          headers: {
            "cf-connecting-ip": "203.0.113.10",
            "content-type": "application/json",
            cookie: adminA.cookie,
            origin: HOST_A,
            "x-shop-id": TENANT_A,
          },
          method: "POST",
        }),
        podEnv(),
      );
    }

    const overLimit = await worker.fetch(
      new Request(`${HOST_A}/v1/admin/pod/artwork`, {
        body: JSON.stringify({ nonsense: true }),
        headers: {
          "cf-connecting-ip": "203.0.113.10",
          "content-type": "application/json",
          cookie: adminA.cookie,
          origin: HOST_A,
          "x-shop-id": TENANT_A,
        },
        method: "POST",
      }),
      podEnv(),
    );

    // 429 rather than 400: the limiter decided before the parser ran.
    expect(overLimit.status).toBe(429);
    expect(overLimit.headers.get("Retry-After")).not.toBeNull();
  });

  it("does not limit the read routes", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await worker.fetch(
        new Request(`${HOST_A}/v1/admin/pod/artwork`, {
          headers: {
            "cf-connecting-ip": "203.0.113.11",
            cookie: adminA.cookie,
            "x-shop-id": TENANT_A,
          },
          method: "GET",
        }),
        podEnv(),
      );
      expect(response.status).toBe(200);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("list, detail and delete", () => {
  async function createReadyArtwork(
    tenantId: string,
    cookie: string,
    host: string,
  ): Promise<string> {
    const objectId = crypto.randomUUID();
    await seedOriginal(tenantId, objectId);

    const response = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie,
        host,
        method: "POST",
      }),
      podEnv(),
    );

    const body = await response.json<{ artwork: { artworkId: string } }>();
    expect(response.status).toBe(202);
    const { report } = await runFarm();
    expect(report?.status).toBe(200);
    return body.artwork.artworkId;
  }

  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  it("lists only the caller's own tenant artwork", async () => {
    await createReadyArtwork(TENANT_A, adminA.cookie, HOST_A);
    await createReadyArtwork(TENANT_B, adminB.cookie, HOST_B);

    const listA = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", { cookie: adminA.cookie }),
      podEnv(),
    );
    const bodyA = await listA.json<{ artwork: unknown[] }>();

    expect(listA.status).toBe(200);
    expect(bodyA.artwork).toHaveLength(1);
  });

  it("detail returns the facts plus a short-TTL preview URL", async () => {
    const artworkId = await createReadyArtwork(TENANT_A, adminA.cookie, HOST_A);

    const response = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artworkId}`, {
        cookie: adminA.cookie,
      }),
      podEnv(),
    );
    const body = await response.json<{
      artwork: Record<string, unknown>;
      previewUrl: string | null;
    }>();

    expect(response.status).toBe(200);
    expect(body.artwork.effectiveDpi).toBe(325);
    expect(body.artwork.status).toBe("ready");
    expect(body.previewUrl).toContain("X-Amz-Expires=300");
    // THE OUTPUT KEYS ARE NEVER SERIALIZED — a key is internal addressing.
    expect(Object.keys(body.artwork)).not.toContain("printObjectKey");
    expect(Object.keys(body.artwork)).not.toContain("previewObjectKey");
    expect(JSON.stringify(body.artwork)).not.toContain("pod/");
  });

  it("a rejected artwork has no preview URL", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    const { artwork } = await created.json<{
      artwork: { artworkId: string };
    }>();
    await runFarm({ result: "rejected" });

    const detail = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artwork.artworkId}`, {
        cookie: adminA.cookie,
      }),
      podEnv(),
    );
    const body = await detail.json<{ previewUrl: string | null }>();

    expect(body.previewUrl).toBeNull();
  });

  it("cross-tenant detail is an opaque 404", async () => {
    const artworkId = await createReadyArtwork(TENANT_A, adminA.cookie, HOST_A);

    const response = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artworkId}`, {
        cookie: adminB.cookie,
        host: HOST_B,
      }),
      podEnv(),
    );

    expect(response.status).toBe(404);
  });

  it("delete removes the row and BOTH outputs", async () => {
    const artworkId = await createReadyArtwork(TENANT_A, adminA.cookie, HOST_A);

    const before = await env.PRIVATE_BUCKET.list({
      prefix: `pod/${TENANT_A}/`,
    });
    expect(before.objects).toHaveLength(2);

    const response = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artworkId}`, {
        cookie: adminA.cookie,
        method: "DELETE",
      }),
      podEnv(),
    );

    expect(response.status).toBe(204);

    const after = await env.PRIVATE_BUCKET.list({ prefix: `pod/${TENANT_A}/` });
    expect(after.objects).toHaveLength(0);

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pod_artwork",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("delete NEVER touches the original object", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    const { artwork } = await created.json<{
      artwork: { artworkId: string };
    }>();

    await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artwork.artworkId}`, {
        cookie: adminA.cookie,
        method: "DELETE",
      }),
      podEnv(),
    );

    const original = await env.DB.prepare(
      "SELECT status FROM stored_objects WHERE object_id = ?",
    )
      .bind(objectId)
      .first<{ status: string }>();

    expect(original?.status).toBe("active");
  });

  it("cross-tenant delete is a 404 and removes nothing", async () => {
    const artworkId = await createReadyArtwork(TENANT_A, adminA.cookie, HOST_A);

    const response = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artworkId}`, {
        cookie: adminB.cookie,
        host: HOST_B,
        method: "DELETE",
      }),
      podEnv(),
    );

    expect(response.status).toBe(404);

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pod_artwork",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);

    // And tenant A's bytes are untouched.
    const listed = await env.PRIVATE_BUCKET.list({ prefix: `pod/${TENANT_A}/` });
    expect(listed.objects).toHaveLength(2);
  });

  /**
   * MUTATION-DRIVEN (M9). The cross-tenant delete test above passes even with
   * the tenant binding stripped from the DELETE statement, because the
   * preceding row read already 404s — the guard is never the defence under
   * test. This case isolates the STATEMENT: the store function is called
   * directly with a principal for tenant B and an artwork id owned by tenant A,
   * so the read cannot shield it. Without `WHERE tenant_id = ?` on the delete,
   * tenant A's row disappears.
   */
  it("the DELETE statement's tenant binding is itself a defence", async () => {
    const artworkId = await createReadyArtwork(TENANT_A, adminA.cookie, HOST_A);

    const { deleteArtwork } = await import("../src/pod/artwork-store");
    const result = await deleteArtwork(
      podEnv(),
      env.DB,
      {
        accountType: "tenant_admin",
        role: "admin",
        tenantId: TENANT_B,
        userId: adminB.userId,
      },
      artworkId,
      Date.now(),
    );

    expect(result.status).toBe("not_found");

    // Tenant A's row and both of its objects survive untouched.
    const row = await env.DB.prepare(
      "SELECT tenant_id FROM pod_artwork WHERE artwork_id = ?",
    )
      .bind(artworkId)
      .first<{ tenant_id: string }>();
    expect(row?.tenant_id).toBe(TENANT_A);

    const listed = await env.PRIVATE_BUCKET.list({ prefix: `pod/${TENANT_A}/` });
    expect(listed.objects).toHaveLength(2);
  });

  /**
   * MUTATION-DRIVEN (M4). The ready UPDATE carries `AND status = 'processing'`,
   * and nothing exercised it: every test reaches that statement with the row
   * genuinely in `processing`, so dropping the clause changed nothing. This
   * case makes the guard the sole defence by moving the row to a terminal state
   * WHILE the farm is in flight — the real race, where a second actor wrote a
   * verdict between this dispatch's insert and its update.
   *
   * The schema's terminal-status trigger would also abort an unguarded write,
   * so the guard and the trigger are two layers over the same hole; this test
   * pins the guard's own behaviour, which is to leave the existing verdict
   * alone rather than to raise.
   */
  it("the ready UPDATE will not overwrite a verdict written mid-flight", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );

    // Another actor writes a verdict while the farm holds the lease — the
    // in-flight race, reproduced deterministically between acquire and report.
    const { report } = await runFarm({
      beforeReport: async () => {
        await env.DB.prepare(
          `UPDATE pod_artwork
           SET status = 'rejected',
               reasons_json = '[{"code":"raced","message":"raced"}]',
               updated_at = ?
           WHERE original_object_id = ?`,
        )
          .bind(Date.now(), objectId)
          .run();
      },
    });

    // The verdict written mid-flight STANDS. The guarded update matched no row,
    // so nothing was overwritten and no output key was attached to a rejection.
    const row = await env.DB.prepare(
      `SELECT status, print_object_key, effective_dpi FROM pod_artwork
       WHERE original_object_id = ?`,
    )
      .bind(objectId)
      .first<Record<string, unknown>>();

    expect(row?.status).toBe("rejected");
    expect(row?.print_object_key).toBeNull();
    expect(row?.effective_dpi).toBeNull();
    // The farm's report still completes its job rather than throwing.
    expect(report?.status).toBe(200);
  });

  it("an unknown artwork id is a 404 on every verb", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await worker.fetch(
        podRequest("/v1/admin/pod/artwork/does-not-exist", {
          cookie: adminA.cookie,
          method,
        }),
        podEnv(),
      );

      expect(response.status).toBe(404);
    }
  });

  it("malformed and sub-paths are 404s", async () => {
    for (const path of [
      "/v1/admin/pod/artwork/a/b",
      "/v1/admin/pod/artwork/%ZZ",
      "/v1/admin/pod/artwork/",
      "/v1/admin/pod/unknown",
    ]) {
      const response = await worker.fetch(
        podRequest(path, { cookie: adminA.cookie }),
        podEnv(),
      );

      expect(response.status).toBe(404);
    }
  });

  it("wrong methods are 404s", async () => {
    const patched = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: {},
        cookie: adminA.cookie,
        method: "PATCH",
      }),
      podEnv(),
    );
    const posted = await worker.fetch(
      podRequest("/v1/admin/pod/profiles", {
        body: {},
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );

    expect(patched.status).toBe(404);
    expect(posted.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("response hygiene", () => {
  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  it("no client-visible body leaks the token, the farm URL or the R2 host", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);

    const bodies: string[] = [];

    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    const createdText = await created.text();
    bodies.push(createdText);
    const { artworkId } = (JSON.parse(createdText) as { artwork: { artworkId: string } })
      .artwork;

    const listed = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", { cookie: adminA.cookie }),
      podEnv(),
    );
    bodies.push(await listed.text());

    // The poll while processing, and again after a farm failure was reported.
    const detail = () =>
      worker.fetch(
        podRequest(`/v1/admin/pod/artwork/${artworkId}`, { cookie: adminA.cookie }),
        podEnv(),
      );
    bodies.push(await (await detail()).text());
    await runFarm({ result: "failed" });
    bodies.push(await (await detail()).text());

    for (const body of bodies) {
      expect(body).not.toContain(env.RENDER_FARM_TOKEN);
      expect(body).not.toContain(env.RENDER_FARM_URL);
      expect(body).not.toContain("render-farm.test.invalid");
      expect(body).not.toContain("r2.cloudflarestorage");
      expect(body).not.toContain(env.R2_SECRET_ACCESS_KEY);
      expect(body).not.toContain(env.R2_ACCESS_KEY_ID);
      // No object keys, no render-job internals.
      expect(body).not.toContain("shops/");
      expect(body).not.toContain("pod/");
      expect(body.toLowerCase()).not.toContain("lease");
      expect(body.toLowerCase()).not.toContain("job_failed");
    }
  });

  it("a farm failure shows the admin 'processing' and nothing about the farm", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    const { artwork } = await created.json<{ artwork: { artworkId: string } }>();
    await runFarm({ result: "failed" });

    const detail = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artwork.artworkId}`, { cookie: adminA.cookie }),
      podEnv(),
    );
    const body = await detail.text();

    expect(detail.status).toBe(200);
    expect((JSON.parse(body) as { artwork: { status: string } }).artwork.status).toBe(
      "processing",
    );
    expect(body.toLowerCase()).not.toContain("farm");
    expect(body.toLowerCase()).not.toContain("firebase");
    expect(body.toLowerCase()).not.toContain("sharp");
  });

  // The detail route's previewUrl is the ONE intended place an R2 host appears
  // in a client-visible response. Pinned explicitly so the hygiene scan above
  // cannot be misread as forbidding it everywhere.
  it("the preview URL is the single intended R2 host exposure", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    const { artwork } = await created.json<{
      artwork: { artworkId: string };
    }>();
    await runFarm();

    const detail = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artwork.artworkId}`, {
        cookie: adminA.cookie,
      }),
      podEnv(),
    );
    const body = await detail.json<{
      artwork: Record<string, unknown>;
      previewUrl: string;
    }>();

    expect(body.previewUrl).toContain("r2.cloudflarestorage.com");
    // …and nowhere else in the payload.
    expect(JSON.stringify(body.artwork)).not.toContain("r2.cloudflarestorage");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the real presigner (aws4fetch)", () => {
  // These exercise the REAL signing path with the test credentials — the same
  // code the deployed worker runs. What they cannot prove is that R2 ACCEPTS
  // the signature; only a live smoke can. See the fake farm's header.
  it("produces an https R2 URL carrying a SigV4 query signature", async () => {
    const { createR2Presigner } = await import("../src/pod/render-farm-client");
    const presigner = createR2Presigner(env as unknown as Env);
    const url = new URL(await presigner.presignGet("pod/t/print/x.png"));

    expect(url.protocol).toBe("https:");
    // EU-jurisdiction buckets (R2_JURISDICTION="eu" in the test bindings, as
    // deployed) are only reachable through the .eu. host.
    expect(url.hostname).toBe(
      `${env.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`,
    );
    expect(url.pathname).toBe(
      `/${env.R2_PRIVATE_BUCKET_NAME}/pod/t/print/x.png`,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).not.toBeNull();
    // The credential scope must name the region and service R2 documents.
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/");
  });

  it("signs against the default host when no jurisdiction is configured", async () => {
    const { createR2Presigner } = await import("../src/pod/render-farm-client");
    const presigner = createR2Presigner({
      ...env,
      R2_JURISDICTION: undefined,
    } as unknown as Env);
    const url = new URL(await presigner.presignGet("pod/t/print/x.png"));

    expect(url.hostname).toBe(`${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(
      `/${env.R2_PRIVATE_BUCKET_NAME}/pod/t/print/x.png`,
    );
    expect(url.searchParams.get("X-Amz-Signature")).not.toBeNull();
  });

  it("darkens the POD surface for a jurisdiction it does not know", async () => {
    const { isPodConfigured } = await import("../src/pod/render-farm-client");

    expect(isPodConfigured(env as unknown as Env)).toBe(true);
    expect(
      isPodConfigured({ ...env, R2_JURISDICTION: undefined } as unknown as Env),
    ).toBe(true);
    for (const value of ["EU", "fedramp", "eu ", "us"]) {
      expect(
        isPodConfigured({ ...env, R2_JURISDICTION: value } as unknown as Env),
        value,
      ).toBe(false);
    }
  });

  it("signs the content type into a PUT url so R2 pins the media type", async () => {
    const { createR2Presigner } = await import("../src/pod/render-farm-client");
    const presigner = createR2Presigner(env as unknown as Env);
    const url = new URL(
      await presigner.presignPut("pod/t/print/x.png", "image/png"),
    );

    // content-type in SignedHeaders is what makes a mismatched upload fail with
    // SignatureDoesNotMatch rather than storing the wrong media type.
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-type",
    );
  });

  it("honours a shorter TTL for preview downloads", async () => {
    const { createR2Presigner } = await import("../src/pod/render-farm-client");
    const presigner = createR2Presigner(env as unknown as Env);
    const url = new URL(await presigner.presignGet("pod/t/preview/x.webp", 300));

    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  });

  it("the presigned URLs it produces satisfy the farm's allowlist", async () => {
    const { createR2Presigner } = await import("../src/pod/render-farm-client");
    const presigner = createR2Presigner(env as unknown as Env);

    for (const url of [
      await presigner.presignGet("pod/t/print/x.png"),
      await presigner.presignPut("pod/t/print/x.png", "image/png"),
    ]) {
      expect(validateR2Url(url, "url")).toStrictEqual([]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CP5-WG — artwork metadata (label, rights confirmation, creator) and a failed
// render that the poll can tell from a missing artwork.
describe("CP5-WG — the rights confirmation on creation", () => {
  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  const create = (body: unknown, options: Partial<RequestOptions> = {}) =>
    worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body,
        cookie: adminA.cookie,
        method: "POST",
        ...options,
      }),
      podEnv(),
    );

  // REFUSALS FIRST. Each body names a real, owned original and a live profile,
  // so the only defect is the one named.
  const REFUSED: Array<[string, (objectId: string) => unknown]> = [
    ["the old body without rightsConfirmed", (objectId) => ({ objectId, profileId: "apparel_dtg" })],
    ["rightsConfirmed: false", (objectId) => ({ objectId, profileId: "apparel_dtg", rightsConfirmed: false })],
    ['rightsConfirmed: "true"', (objectId) => ({ objectId, profileId: "apparel_dtg", rightsConfirmed: "true" })],
    ["rightsConfirmed: 1", (objectId) => ({ objectId, profileId: "apparel_dtg", rightsConfirmed: 1 })],
    ["rightsConfirmed: null", (objectId) => ({ objectId, profileId: "apparel_dtg", rightsConfirmed: null })],
    ["a label that is a number", (objectId) => ({ label: 7, objectId, profileId: "apparel_dtg", rightsConfirmed: true })],
    ["a label of only spaces", (objectId) => ({ label: "   ", objectId, profileId: "apparel_dtg", rightsConfirmed: true })],
    ["a label of 121 characters", (objectId) => ({ label: "x".repeat(121), objectId, profileId: "apparel_dtg", rightsConfirmed: true })],
    ["a label with a newline", (objectId) => ({ label: "a\nb", objectId, profileId: "apparel_dtg", rightsConfirmed: true })],
    ["a client-sent confirmation time", (objectId) => ({ objectId, profileId: "apparel_dtg", rightsConfirmed: true, rightsConfirmedAt: 1 })],
    ["a client-sent creator", (objectId) => ({ createdBy: "someone", objectId, profileId: "apparel_dtg", rightsConfirmed: true })],
  ];

  for (const [label, body] of REFUSED) {
    it(`refuses ${label} with 400 and creates nothing`, async () => {
      const objectId = crypto.randomUUID();
      await seedOriginal(TENANT_A, objectId);
      const response = await create(body(objectId));
      expect(response.status).toBe(400);
      expect(await response.json()).toStrictEqual({
        error: { code: "invalid_request", message: "Request is not valid" },
      });
      expect(await renderJobCount()).toBe(0);
      const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM pod_artwork").first<{ n: number }>();
      expect(rows?.n).toBe(0);
    });
  }

  it("a cross-origin creation is the opaque 404, before the body is read", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const response = await create(
      { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
      { origin: "https://evil.example" },
    );
    expect(response.status).toBe(404);
    expect(await renderJobCount()).toBe(0);
  });

  it("stores the label trimmed, the SERVER's time and the creator; answers them as label, rightsConfirmedAt, createdBySelf", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const before = Date.now();
    const response = await create({
      label: "  Logotyp – framsida  ",
      objectId,
      profileId: "apparel_dtg",
      rightsConfirmed: true,
    });
    const after = Date.now();
    expect(response.status).toBe(202);
    const { artwork } = await response.json<{ artwork: Record<string, unknown> }>();
    expect(artwork.label).toBe("Logotyp – framsida");
    expect(artwork.createdBySelf).toBe(true);
    expect(artwork.rightsConfirmedAt).toBeGreaterThanOrEqual(before);
    expect(artwork.rightsConfirmedAt).toBeLessThanOrEqual(after);
    // No person's id in the answer: not the creator's, not under another key.
    expect(JSON.stringify(artwork)).not.toContain(adminA.userId);
    expect("createdBy" in artwork).toBe(false);

    const row = await env.DB.prepare(
      "SELECT label, rights_confirmed_at, created_by, created_at FROM pod_artwork WHERE artwork_id = ?",
    )
      .bind(artwork.artworkId as string)
      .first<Record<string, unknown>>();
    expect(row).toStrictEqual({
      created_at: artwork.createdAt,
      created_by: adminA.userId,
      label: "Logotyp – framsida",
      rights_confirmed_at: artwork.rightsConfirmedAt,
    });
  });

  it("a label is optional: absent or null stores NULL", async () => {
    for (const label of [undefined, null]) {
      const objectId = crypto.randomUUID();
      await seedOriginal(TENANT_A, objectId);
      const response = await create({ label, objectId, profileId: "apparel_dtg", rightsConfirmed: true });
      expect(response.status).toBe(202);
      const { artwork } = await response.json<{ artwork: { label: unknown; rightsConfirmedAt: unknown } }>();
      expect(artwork.label).toBeNull();
      expect(typeof artwork.rightsConfirmedAt).toBe("number");
    }
  });

  it("the confirmation and its author cannot be rewritten by an UPDATE (0048 trigger)", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const response = await create({ objectId, profileId: "apparel_dtg", rightsConfirmed: true });
    const { artwork } = await response.json<{ artwork: { artworkId: string } }>();
    await expect(
      env.DB.prepare("UPDATE pod_artwork SET rights_confirmed_at = 1 WHERE artwork_id = ?")
        .bind(artwork.artworkId)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.DB.prepare("UPDATE pod_artwork SET created_by = NULL WHERE artwork_id = ?")
        .bind(artwork.artworkId)
        .run(),
    ).rejects.toThrow(/immutable/);
    // A label above 120 characters or with surrounding spaces is unstorable too.
    await expect(
      env.DB.prepare("UPDATE pod_artwork SET label = ' x' WHERE artwork_id = ?")
        .bind(artwork.artworkId)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("CP5-WG — list and detail carry the metadata, never another person's id", () => {
  let adminA2: SignedUpUser;

  beforeAll(async () => {
    adminA2 = await signUp("pod-admin-a2@example.test");
    await seedAccess(adminA2.userId, "tenant_admin");
    await seedMembership(adminA2.userId, TENANT_A);
  });

  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  it("createdBySelf is true for the creator, false for a co-admin and for a row older than 0048", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { label: "Mine", objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    const { artwork } = await created.json<{ artwork: { artworkId: string } }>();

    // A row written before 0048: all three columns NULL.
    const oldObject = crypto.randomUUID();
    await seedOriginal(TENANT_A, oldObject);
    await env.DB.prepare(
      `INSERT INTO pod_artwork (artwork_id, tenant_id, original_object_id, profile_id, status,
         reasons_json, created_at, updated_at)
       VALUES ('old-artwork', ?, ?, 'apparel_dtg', 'rejected', '[{"code":"x","message":"x"}]', ?, ?)`,
    )
      .bind(TENANT_A, oldObject, SEED_NOW, SEED_NOW)
      .run();

    const listAs = async (cookie: string) => {
      const response = await worker.fetch(podRequest("/v1/admin/pod/artwork", { cookie }), podEnv());
      expect(response.status).toBe(200);
      const body = await response.json<{ artwork: Array<Record<string, unknown>> }>();
      expect(JSON.stringify(body)).not.toContain(adminA.userId);
      expect(JSON.stringify(body)).not.toContain(adminA2.userId);
      return new Map(body.artwork.map((entry) => [entry.artworkId, entry]));
    };

    const mine = await listAs(adminA.cookie);
    expect(mine.get(artwork.artworkId)).toMatchObject({ createdBySelf: true, label: "Mine" });
    expect(mine.get("old-artwork")).toMatchObject({ createdBySelf: false, label: null, rightsConfirmedAt: null });

    const theirs = await listAs(adminA2.cookie);
    expect(theirs.get(artwork.artworkId)).toMatchObject({ createdBySelf: false, label: "Mine" });

    const detail = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artwork.artworkId}`, { cookie: adminA2.cookie }),
      podEnv(),
    );
    const body = await detail.json<{ artwork: Record<string, unknown> }>();
    expect(body.artwork).toMatchObject({ createdBySelf: false, label: "Mine" });
    expect(typeof body.artwork.rightsConfirmedAt).toBe("number");
    expect(JSON.stringify(body)).not.toContain(adminA.userId);
  });
});

describe("CP5-WG — PATCH /v1/admin/pod/artwork/:id { label }", () => {
  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  async function createdArtwork(): Promise<string> {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const response = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { label: "Före", objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    expect(response.status).toBe(202);
    return (await response.json<{ artwork: { artworkId: string } }>()).artwork.artworkId;
  }

  const patch = (artworkId: string, body: unknown, options: Partial<RequestOptions> = {}) =>
    worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artworkId}`, {
        body,
        cookie: adminA.cookie,
        method: "PATCH",
        ...options,
      }),
      podEnv(),
    );

  const labelOf = async (artworkId: string) =>
    (
      await env.DB.prepare("SELECT label FROM pod_artwork WHERE artwork_id = ?")
        .bind(artworkId)
        .first<{ label: string | null }>()
    )?.label;

  it("no session, a foreign shop's admin, and a cross-origin request: the opaque 404, nothing renamed", async () => {
    const artworkId = await createdArtwork();
    const answers = [
      await patch(artworkId, { label: "x" }, { cookie: undefined }),
      await patch(artworkId, { label: "x" }, { cookie: adminB.cookie }),
      await patch(artworkId, { label: "x" }, { cookie: adminB.cookie, host: HOST_B, shopId: TENANT_A }),
      await patch(artworkId, { label: "x" }, { origin: "https://evil.example" }),
      await patch(artworkId, { label: "x" }, { origin: null }),
      // B's own shop context cannot reach A's artwork either.
      await patch(artworkId, { label: "x" }, { cookie: adminB.cookie, host: HOST_B }),
    ];
    for (const response of answers) {
      expect(response.status).toBe(404);
    }
    expect(await labelOf(artworkId)).toBe("Före");
  });

  it("malformed ids and sub-paths are the opaque 404; an unknown id is a 404", async () => {
    for (const path of ["%E0%A4%A", "a/b", "nope"]) {
      const response = await patch(path, { label: "x" });
      expect(response.status, path).toBe(404);
    }
  });

  it("refuses a malformed body with 400 and renames nothing", async () => {
    const artworkId = await createdArtwork();
    for (const body of [
      {},
      { label: 3 },
      { label: "" },
      { label: "   " },
      { label: "x".repeat(121) },
      { label: "a\u0000b" },
      { label: "x", status: "ready" },
      ["x"],
      "x",
    ]) {
      const response = await patch(artworkId, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await labelOf(artworkId)).toBe("Före");
  });

  it("renames, clears with null, audits in the same batch and changes nothing a visitor sees", async () => {
    const artworkId = await createdArtwork();
    const version = await catalogVersionOf(TENANT_A);

    const renamed = await patch(artworkId, { label: "  Efter  " });
    expect(renamed.status).toBe(200);
    const body = await renamed.json<{ artwork: Record<string, unknown> }>();
    expect(body.artwork).toMatchObject({ artworkId, createdBySelf: true, label: "Efter", status: "processing" });
    expect(Object.keys(body.artwork).sort()).toStrictEqual([
      "artworkId",
      "createdAt",
      "createdBySelf",
      "effectiveDpi",
      "heightPx",
      "label",
      "originalObjectId",
      "profileId",
      "rightsConfirmedAt",
      "status",
      "widthPx",
    ]);
    expect(await labelOf(artworkId)).toBe("Efter");

    const cleared = await patch(artworkId, { label: null });
    expect(cleared.status).toBe(200);
    expect(await labelOf(artworkId)).toBeNull();

    const audits = await env.DB.prepare(
      "SELECT actor_user_id, metadata_json FROM audit_events WHERE action = 'pod.artwork.rename' AND resource_id = ? ORDER BY created_at",
    )
      .bind(artworkId)
      .all<{ actor_user_id: string; metadata_json: string }>();
    expect(audits.results.map((row) => JSON.parse(row.metadata_json))).toStrictEqual([
      { hadLabel: true, hasLabel: true },
      { hadLabel: true, hasLabel: false },
    ]);
    expect(audits.results.every((row) => row.actor_user_id === adminA.userId)).toBe(true);
    // A label reaches no public answer, so the catalogue's version is untouched.
    expect(await catalogVersionOf(TENANT_A)).toBe(version);
  });

  it("other methods on the artwork id stay what they were (PUT and POST are 404s)", async () => {
    const artworkId = await createdArtwork();
    for (const method of ["PUT", "POST"]) {
      const response = await patch(artworkId, { label: "x" }, { method });
      expect(response.status, method).toBe(404);
    }
  });
});

async function catalogVersionOf(tenantId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT catalog_version FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ catalog_version: number }>();
  return row?.catalog_version ?? -1;
}

describe("CP5-WG (c) — a failed render is not a missing artwork", () => {
  beforeEach(async () => {
    await seedProfile("apparel_dtg");
  });

  async function failedArtwork(): Promise<{ artworkId: string; objectId: string }> {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    const { artwork } = await created.json<{ artwork: { artworkId: string } }>();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runFarm({ result: "failed" });
    }
    const row = await env.DB.prepare("SELECT 1 FROM pod_artwork WHERE artwork_id = ?")
      .bind(artwork.artworkId)
      .first();
    expect(row).toBeNull();
    return { artworkId: artwork.artworkId, objectId };
  }

  const detail = (artworkId: string, cookie = adminA.cookie, host = HOST_A) =>
    worker.fetch(podRequest(`/v1/admin/pod/artwork/${artworkId}`, { cookie, host }), podEnv());

  it("the poll answers status 'failed' with one coarse reason, and nothing of the job", async () => {
    const { artworkId } = await failedArtwork();
    const response = await detail(artworkId);
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      artwork: { artworkId, reason: "render_failed", status: "failed" },
      previewUrl: null,
    });
  });

  it("another shop's admin, and no session, still get the opaque 404", async () => {
    const { artworkId } = await failedArtwork();
    expect((await detail(artworkId, adminB.cookie, HOST_B)).status).toBe(404);
    expect(
      (await worker.fetch(podRequest(`/v1/admin/pod/artwork/${artworkId}`), podEnv())).status,
    ).toBe(404);
  });

  it("a failed artwork is not in the list and cannot be renamed or deleted (404); a re-post works", async () => {
    const { artworkId, objectId } = await failedArtwork();
    const list = await worker.fetch(podRequest("/v1/admin/pod/artwork", { cookie: adminA.cookie }), podEnv());
    const body = await list.json<{ artwork: Array<{ artworkId: string }> }>();
    expect(body.artwork.some((entry) => entry.artworkId === artworkId)).toBe(false);
    const renamed = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artworkId}`, { body: { label: "x" }, cookie: adminA.cookie, method: "PATCH" }),
      podEnv(),
    );
    expect(renamed.status).toBe(404);
    const deleted = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artworkId}`, { cookie: adminA.cookie, method: "DELETE" }),
      podEnv(),
    );
    expect(deleted.status).toBe(404);
    // Replay is still the retry.
    const again = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    expect(again.status).toBe(202);
  });

  it("an artwork its admin deleted while processing is gone (404), not failed", async () => {
    const objectId = crypto.randomUUID();
    await seedOriginal(TENANT_A, objectId);
    const created = await worker.fetch(
      podRequest("/v1/admin/pod/artwork", {
        body: { objectId, profileId: "apparel_dtg", rightsConfirmed: true },
        cookie: adminA.cookie,
        method: "POST",
      }),
      podEnv(),
    );
    const { artwork } = await created.json<{ artwork: { artworkId: string } }>();
    const deleted = await worker.fetch(
      podRequest(`/v1/admin/pod/artwork/${artwork.artworkId}`, { cookie: adminA.cookie, method: "DELETE" }),
      podEnv(),
    );
    expect(deleted.status).toBe(204);
    const job = await env.DB.prepare("SELECT state, error FROM render_jobs WHERE artwork_id = ?")
      .bind(artwork.artworkId)
      .first<{ error: string; state: string }>();
    expect(job).toStrictEqual({ error: "artwork_deleted", state: "failed" });
    expect((await detail(artwork.artworkId)).status).toBe(404);
  });

  it("an id that never existed is the opaque 404", async () => {
    expect((await detail(crypto.randomUUID())).status).toBe(404);
  });
});
