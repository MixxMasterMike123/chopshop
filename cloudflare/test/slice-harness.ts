import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";

import worker from "../src/index";
import { replayDeferred, runAlertDigest, runReconciliation, runRetentionSweep } from "../src/commerce/crons";
import { STRIPE_GATEWAY_OVERRIDE } from "../src/commerce/stripe-client";
import { FAKE_PRINTER_FETCH_OVERRIDE } from "../src/dispatch/printer-client";
import { RESEND_FETCH_OVERRIDE } from "../src/email/email-queue-consumer";
import { runOutboxSweep } from "../src/outbox/sweeper";
import { R2_PRESIGNER_OVERRIDE, type R2Presigner } from "../src/pod/render-farm-client";
import type { RenderJobLease } from "../src/pod/render-jobs";
import { handleFakePrinterRoute } from "../src/routes/fake-printer";
import { quietEnv, type RecordingQueue } from "./dispatch-fixtures";
import { AUTH_ORIGIN, FakeMoneyStripe, postEvent } from "./money-fixtures";
import { TEE_S, testPrinter } from "./pod-fixtures";

/**
 * The CP2-D1 slice harness: every step of the vertical slice as a call to the
 * REAL route it names (PLAN §10 CP2), plus the failure-injection seams the
 * suites in test/slice/ share. Not a test file.
 *
 * Nothing here writes a row a route would write, with two deliberate
 * exceptions, both of which the staging seed script mirrors:
 *   - the tenant's Connect account and capability flags (SQL), because the
 *     Connect onboarding endpoints are not built (CP2-A report) — on staging
 *     the reviewer runs the same UPDATE through the preflight;
 *   - the render farm's uploads, which go straight into the private bucket at
 *     the keys the presigned PUT URLs name (the farm is a separate service;
 *     pod-artwork.test.ts's runFarm does the same).
 *
 * Third parties are the existing fakes, reached through their production
 * seams only: FakeMoneyStripe (STRIPE_GATEWAY_OVERRIDE), the fake printer's
 * in-process transport (FAKE_PRINTER_FETCH_OVERRIDE), a fake Resend
 * (RESEND_FETCH_OVERRIDE) and a fake presigner (R2_PRESIGNER_OVERRIDE). Queues
 * are recording queues, so nothing reaches the pool's own consumers: every
 * delivery is driven explicitly through `worker.queue()`.
 */

export { AUTH_ORIGIN };
export const PLATFORM = "https://platform.slice.test";
export const ADMIN = "https://admin.slice.test";
export const FARM = "https://render.slice.test";
export const PASSWORD = "slice-password-long-enough-1";
export const MINUTE_MS = 60 * 1_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export const PROFILE = {
  acceptedFormats: [{ ext: "png" }],
  active: true,
  label: "Textil (DTG)",
  maxFileMb: 50,
  minDpi: 300,
  printAreaMm: { h: 400, w: 300 },
  profileId: "apparel_dtg",
  sortOrder: 0,
};

let ipCounter = 0;
/** A distinct client IP per request: no per-IP limiter ever turns a step into a 429. */
export function nextIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

let uniqueCounter = 0;
export function unique(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${uniqueCounter}-${Math.floor(Math.random() * 1e6)}`;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A small PNG-signed original (the farm is faked, so only the bytes' identity matters). */
export function pngBytes(seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(2_048);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + seed * 7) % 251;
  }
  return bytes;
}

// ── the world: sessions and tenants for a file, fakes and queues per test ───

export interface Tenant {
  accountId: string;
  adminCookie: string;
  adminUserId: string;
  host: string;
  origin: string;
  shopName: string;
  tenantId: string;
}

function fakePresigner(): R2Presigner {
  const base = "https://testaccount.r2.cloudflarestorage.com/meteorshop-test-private";
  return {
    async presignGet(objectKey: string, ttlSeconds = 900): Promise<string> {
      return `${base}/${objectKey}?X-Amz-Expires=${ttlSeconds}&X-Amz-Signature=fake`;
    },
    async presignPut(objectKey: string, contentType: string): Promise<string> {
      return `${base}/${objectKey}?X-Amz-Expires=900&X-Amz-Signature=fake&ct=${encodeURIComponent(contentType)}`;
    },
  };
}

export class SliceWorld {
  platformCookie = "";
  platformUserId = "";
  readonly tenants: Tenant[] = [];
  stripe: FakeMoneyStripe = new FakeMoneyStripe();
  emails: RecordingQueue;
  nudges: RecordingQueue;
  renders: RecordingQueue;
  env: Env;

  constructor() {
    const fresh = this.freshQueues();
    this.emails = fresh.emails;
    this.nudges = fresh.nudges;
    this.renders = fresh.renders;
    this.env = fresh.env;
  }

  private freshQueues() {
    return quietEnv({
      [R2_PRESIGNER_OVERRIDE]: fakePresigner(),
      [STRIPE_GATEWAY_OVERRIDE]: this.stripe,
    });
  }

  /**
   * A fresh Stripe fake and fresh recording queues. The crons are GLOBAL (they
   * scan every tenant's rows), so a test that runs them gets a Stripe of its
   * own: intents another test created are unknown to it and are left alone.
   */
  reset(): this {
    this.stripe = new FakeMoneyStripe();
    const fresh = this.freshQueues();
    this.emails = fresh.emails;
    this.nudges = fresh.nudges;
    this.renders = fresh.renders;
    this.env = fresh.env;
    return this;
  }

  /** This world's env with bindings or seams replaced (a crashing DB, a lossy printer…). */
  with(overrides: Record<PropertyKey, unknown>): Env {
    return { ...this.env, ...overrides } as unknown as Env;
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

export interface CallOptions {
  bearer?: string;
  body?: unknown;
  cookie?: string;
  env?: Env;
  headers?: Record<string, string>;
  /** Defaults to the URL's own origin on state changes, none on GET. */
  origin?: string | null;
  /** Sent as it is, unparsed (a truncated or malformed body). Wins over `body`. */
  rawBody?: string;
  shopId?: string;
}

export function call(
  world: SliceWorld,
  method: string,
  url: string,
  options: CallOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("cf-connecting-ip", nextIp());
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  if (options.shopId !== undefined) {
    headers.set("x-shop-id", options.shopId);
  }
  if (options.bearer !== undefined) {
    headers.set("authorization", `Bearer ${options.bearer}`);
  }
  const origin =
    options.origin === undefined ? (method === "GET" ? null : new URL(url).origin) : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  return worker.fetch(new Request(url, { body, headers, method }), options.env ?? world.env);
}

/** Asserts the status (naming the body on failure) and parses JSON. */
export async function expectJson<T>(response: Response, status: number, label: string): Promise<T> {
  const text = await response.text();
  expect(response.status, `${label}: ${text.slice(0, 400)}`).toBe(status);
  return (text.length === 0 ? null : JSON.parse(text)) as T;
}

/** The outcome of a call that a crashing seam may make reject. */
export async function settle(promise: Promise<Response>): Promise<number | "threw"> {
  try {
    const response = await promise;
    await response.body?.cancel();
    return response.status;
  } catch {
    return "threw";
  }
}

// ── auth, platform, tenants ─────────────────────────────────────────────────

export async function signIn(world: SliceWorld, email: string, password = PASSWORD): Promise<string> {
  // Better Auth's own limiter: one fixture signs in many users from one isolate.
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const response = await worker.fetch(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password }),
      headers: { "cf-connecting-ip": nextIp(), "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
    world.env,
  );
  expect(response.status, `sign-in ${email}`).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined || cookie.length === 0) {
    throw new Error(`sign-in for ${email} returned no session cookie`);
  }
  return cookie;
}

/** POST /v1/platform/bootstrap (the one-time first platform admin), then sign in. */
export async function bootstrapPlatform(world: SliceWorld): Promise<void> {
  const email = "platform@slice.test";
  const response = await call(world, "POST", `${PLATFORM}/v1/platform/bootstrap`, {
    body: { email, name: "Slice Platform", password: PASSWORD },
    headers: { "x-bootstrap-token": env.BOOTSTRAP_TOKEN },
    origin: null,
  });
  const body = await expectJson<{ user: { userId: string } }>(response, 201, "platform bootstrap");
  world.platformUserId = body.user.userId;
  world.platformCookie = await signIn(world, email);
}

export function platformCall(world: SliceWorld, method: string, path: string, body?: unknown, env?: Env) {
  return call(world, method, `${PLATFORM}${path}`, { body, cookie: world.platformCookie, env });
}

export function adminCall(
  world: SliceWorld,
  tenant: Tenant,
  method: string,
  path: string,
  body?: unknown,
  env?: Env,
) {
  return call(world, method, `${ADMIN}${path}`, {
    body,
    cookie: tenant.adminCookie,
    env,
    shopId: tenant.tenantId,
  });
}

export function storefrontCall(
  world: SliceWorld,
  tenant: Tenant,
  method: string,
  path: string,
  options: CallOptions = {},
) {
  return call(world, method, `${tenant.origin}${path}`, options);
}

export interface TenantSpec {
  /**
   * false: the shop's admin does NOT accept the platform terms, so the CP2-E
   * checkout gate stays closed (the slice then accepts through the route).
   */
  acceptTerms?: boolean;
  commissionBps?: number | null;
  /**
   * false: the shop is left as a fresh shop is — no store settings, no legal
   * pages adopted — so the CP3-E readiness gate keeps its checkout closed. For
   * suites about the settings themselves. Default: made ready.
   */
  legallyReady?: boolean;
  host: string;
  shopName: string;
  tenantId: string;
}

/**
 * POST /v1/platform/tenants → the Connect account (SQL: onboarding endpoints
 * are not built; staging gets the same UPDATE from the seed script) → a tenant
 * admin (POST /v1/platform/users + /admins) → that admin's session → the admin
 * accepts the current platform terms (POST /v1/admin/legal/accept-terms, the
 * CP2-E checkout gate) unless `acceptTerms: false`.
 */
export async function createTenant(world: SliceWorld, spec: TenantSpec): Promise<Tenant> {
  await expectJson(
    await platformCall(world, "POST", "/v1/platform/tenants", {
      hostname: spec.host,
      shopName: spec.shopName,
      tenantId: spec.tenantId,
    }),
    201,
    `create tenant ${spec.tenantId}`,
  );

  const accountId = `acct_${spec.tenantId.replace(/[^A-Za-z0-9]/g, "")}`;
  await env.DB.prepare(
    `UPDATE tenants
     SET stripe_account_id = ?, stripe_charges_enabled = 1, stripe_payouts_enabled = 1,
         stripe_details_submitted = 1, commission_bps = ?
     WHERE tenant_id = ?`,
  )
    .bind(accountId, spec.commissionBps ?? null, spec.tenantId)
    .run();

  const email = `admin@${spec.host}`;
  const created = await expectJson<{ user: { userId: string } }>(
    await platformCall(world, "POST", "/v1/platform/users", {
      accountType: "tenant_admin",
      email,
      password: PASSWORD,
    }),
    201,
    "create tenant admin",
  );
  await expectJson(
    await platformCall(world, "POST", `/v1/platform/tenants/${spec.tenantId}/admins`, {
      userId: created.user.userId,
    }),
    201,
    "grant tenant admin",
  );

  const tenant: Tenant = {
    accountId,
    adminCookie: await signIn(world, email),
    adminUserId: created.user.userId,
    host: spec.host,
    origin: `https://${spec.host}`,
    shopName: spec.shopName,
    tenantId: spec.tenantId,
  };
  world.tenants.push(tenant);
  // CP3-E: checkout has a second gate, legal readiness. Every slice shop is
  // made ready here, through the seller's own routes, so that the only gate a
  // test with `acceptTerms: false` still meets is the terms gate it is about.
  if (spec.legallyReady !== false) {
    await makeLegallyReady(world, tenant);
  }
  if (spec.acceptTerms !== false) {
    await acceptPlatformTerms(world, tenant);
  }
  return tenant;
}

export const SLICE_RETURN_ADDRESS = "Testgatan 1, 123 45 Teststad";

/**
 * D98: the pickup place every slice shop offers (invented), set with the
 * store settings in makeLegallyReady, and the recipient openCheckout sends by
 * default — a collected order at that place.
 */
export const SLICE_PICKUP_LOCATION = {
  address: "Testgatan 1, 123 45 Teststad",
  dates: [] as string[],
  // The same id as legal-fixtures.ts FIXTURE_PICKUP_LOCATION, so a shop made
  // ready either way takes the same default recipient.
  id: "fixture-pickup",
  name: "Slice-butikens utlämning",
};
export const SLICE_RECIPIENT = { name: "Slice Köpare", pickupLocationId: SLICE_PICKUP_LOCATION.id };
export const SLICE_LEGAL_TEMPLATE_VERSION = "2026-09-07";

/**
 * The three conditions of the legal readiness gate (src/legal/legal-pages.ts
 * isLegallyReady), met the way a seller meets them: a return address and the
 * VAT answer through PUT /v1/admin/settings, and the adoption of the three
 * legal pages through POST /v1/admin/legal/accept-pages.
 */
export async function makeLegallyReady(world: SliceWorld, tenant: Tenant): Promise<void> {
  await expectJson(
    await adminCall(world, tenant, "PUT", "/v1/admin/settings", {
      returnAddress: SLICE_RETURN_ADDRESS,
      storeIdentity: { pickupLocations: [SLICE_PICKUP_LOCATION] },
      vatRegistered: true,
    }),
    200,
    "store settings (return address, VAT answer)",
  );
  await expectJson(
    await adminCall(world, tenant, "POST", "/v1/admin/legal/accept-pages", {
      custom: false,
      pod: true,
      templateVersion: SLICE_LEGAL_TEMPLATE_VERSION,
      texts: {
        angerratt: "<h1>Ångerrätt och returer</h1><p>Slice fixture.</p>",
        integritetspolicy: "<h1>Integritetspolicy</h1><p>Slice fixture.</p>",
        kopvillkor: "<h1>Köpvillkor</h1><p>Slice fixture.</p>",
      },
    }),
    201,
    "accept legal pages",
  );
}

export interface TermsStatusBody {
  accepted: boolean;
  acceptedAt: string | null;
  acceptedVersion: string | null;
  currentVersion: string | null;
  graceDeadline: string | null;
  inGrace: boolean;
  readiness: {
    legalPagesAccepted: boolean;
    ready: boolean;
    returnAddress: boolean;
    vatAnswered: boolean;
  };
}

/** GET /v1/admin/legal/status as the shop's admin. */
export async function termsStatus(world: SliceWorld, tenant: Tenant) {
  return expectJson<TermsStatusBody>(
    await adminCall(world, tenant, "GET", "/v1/admin/legal/status"),
    200,
    "terms status",
  );
}

/** The shop's admin accepts the CURRENT platform terms version (201). */
export async function acceptPlatformTerms(world: SliceWorld, tenant: Tenant): Promise<string> {
  const { currentVersion } = await termsStatus(world, tenant);
  const body = await expectJson<{ acceptance: { acceptedAt: string; termsVersion: string } }>(
    await adminCall(world, tenant, "POST", "/v1/admin/legal/accept-terms", { termsVersion: currentVersion }),
    201,
    "accept platform terms",
  );
  expect(body.acceptance.termsVersion).toBe(currentVersion);
  return body.acceptance.acceptedAt;
}

/** PUT /v1/platform/printers (the fake printer + its tiers) and PUT /v1/platform/pod/profiles. */
export async function seedPrintShop(world: SliceWorld): Promise<void> {
  const printers = await expectJson<{
    printers: Array<{ printerId: string; pricedSkuCount: number; status: string }>;
  }>(await platformCall(world, "PUT", "/v1/platform/printers", { printers: [testPrinter()] }), 200, "printers");
  expect(printers.printers).toEqual([
    expect.objectContaining({ printerId: "fake-printer", status: "active" }),
  ]);

  const profiles = await expectJson<{ profiles: Array<{ profileId: string }> }>(
    await platformCall(world, "PUT", "/v1/platform/pod/profiles", { profiles: [PROFILE] }),
    200,
    "profiles",
  );
  expect(profiles.profiles.map((profile) => profile.profileId)).toEqual(["apparel_dtg"]);
}

// ── artwork and the render farm ─────────────────────────────────────────────

/** POST /v1/admin/objects (reserve) + PUT …/content (Worker-streamed, checksummed). */
export async function uploadOriginal(
  world: SliceWorld,
  tenant: Tenant,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const reserved = await expectJson<{ object: { objectId: string } }>(
    await adminCall(world, tenant, "POST", "/v1/admin/objects", {
      contentType: "image/png",
      fileName: "motif.png",
      kind: "artwork_original",
      sha256: await sha256Hex(bytes),
      sizeBytes: bytes.length,
    }),
    201,
    "reserve original",
  );
  const objectId = reserved.object.objectId;

  const headers = new Headers({
    "cf-connecting-ip": nextIp(),
    "content-length": String(bytes.length),
    cookie: tenant.adminCookie,
    origin: ADMIN,
    "x-shop-id": tenant.tenantId,
  });
  const uploaded = await worker.fetch(
    new Request(`${ADMIN}/v1/admin/objects/${objectId}/content`, {
      body: new Response(bytes).body,
      headers,
      method: "PUT",
    }),
    world.env,
  );
  const body = await expectJson<{ object: { status: string } }>(uploaded, 200, "upload original");
  expect(body.object.status).toBe("active");
  return objectId;
}

/** POST /v1/admin/pod/artwork → 202 'processing' with a queued render job. */
export async function createArtwork(world: SliceWorld, tenant: Tenant, objectId: string): Promise<string> {
  const body = await expectJson<{ artwork: { artworkId: string; status: string } }>(
    await adminCall(world, tenant, "POST", "/v1/admin/pod/artwork", { objectId, profileId: PROFILE.profileId, rightsConfirmed: true }),
    202,
    "create artwork",
  );
  expect(body.artwork.status).toBe("processing");
  return body.artwork.artworkId;
}

function farmRequest(path: string, body?: unknown): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.RENDER_FARM_TOKEN}`,
    "cf-connecting-ip": nextIp(),
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return new Request(`${FARM}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method: "POST",
  });
}

/** POST /v1/render/jobs/acquire as the farm; null on 204 (nothing to do). */
export async function acquireJob(world: SliceWorld, targetEnv?: Env): Promise<RenderJobLease | null> {
  const response = await worker.fetch(farmRequest("/v1/render/jobs/acquire"), targetEnv ?? world.env);
  if (response.status === 204) {
    return null;
  }
  return expectJson<RenderJobLease>(response, 200, "acquire render job");
}

function keyFromPresignedUrl(raw: string): string {
  const path = new URL(raw).pathname.replace(/^\/+/, "");
  return decodeURIComponent(path.slice(path.indexOf("/") + 1));
}

export interface RenderedOutputs {
  preview: { bytes: number; key: string; sha256: string };
  print: { bytes: number; key: string; sha256: string };
}

/** What the farm does before it reports: PUT both outputs to the attempt keys. */
export async function uploadOutputs(lease: RenderJobLease, fill: number): Promise<RenderedOutputs> {
  const print = new Uint8Array(40_000).fill(fill);
  const preview = new Uint8Array(1_500).fill((fill + 1) % 256);
  const printKey = keyFromPresignedUrl(lease.output.printPngPutUrl);
  const previewKey = keyFromPresignedUrl(lease.output.previewWebpPutUrl);
  await env.PRIVATE_BUCKET.put(printKey, print, { httpMetadata: { contentType: "image/png" } });
  await env.PRIVATE_BUCKET.put(previewKey, preview, { httpMetadata: { contentType: "image/webp" } });
  return {
    preview: { bytes: preview.length, key: previewKey, sha256: await sha256Hex(preview) },
    print: { bytes: print.length, key: printKey, sha256: await sha256Hex(print) },
  };
}

/** The farm's `ok: true` verdict for a lease (3200 × 3200 px at 325 DPI). */
export function completionBody(lease: RenderJobLease, outputs: RenderedOutputs) {
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
    notices: [],
    ok: true,
    outputs: { previewWebp: outputs.preview, printPng: outputs.print },
  };
}

export function completeJob(world: SliceWorld, jobId: string, body: unknown, targetEnv?: Env): Promise<Response> {
  return worker.fetch(farmRequest(`/v1/render/jobs/${jobId}/complete`, body), targetEnv ?? world.env);
}

export async function artworkDetail(world: SliceWorld, tenant: Tenant, artworkId: string) {
  return expectJson<{
    artwork: { printSha256: string | null; status: string };
    previewUrl: string | null;
  }>(await adminCall(world, tenant, "GET", `/v1/admin/pod/artwork/${artworkId}`), 200, "artwork detail");
}

/** Upload → create (202) → acquire → outputs → complete (200) → poll says ready. */
export async function renderReadyArtwork(world: SliceWorld, tenant: Tenant, seed: number): Promise<string> {
  const objectId = await uploadOriginal(world, tenant, pngBytes(seed));
  const artworkId = await createArtwork(world, tenant, objectId);
  const lease = await acquireJob(world);
  if (lease === null) {
    throw new Error("no render job to acquire");
  }
  const outputs = await uploadOutputs(lease, seed % 200);
  await expectJson(await completeJob(world, lease.jobId, completionBody(lease, outputs)), 200, "complete render job");
  const detail = await artworkDetail(world, tenant, artworkId);
  expect(detail.artwork.status).toBe("ready");
  return artworkId;
}

// ── catalogue: product, mapping, quote, publish, screening ──────────────────

export interface Quote {
  currency: string;
  inkopMinor: number;
  priceFloorMinor: number;
}

export async function createPodProduct(
  world: SliceWorld,
  tenant: Tenant,
  spec: { artworkId: string; name: string; priceMinor: number; sku: string },
): Promise<{ productId: string; quote: Quote }> {
  const created = await expectJson<{ product: { isPod: boolean; productId: string } }>(
    await adminCall(world, tenant, "POST", "/v1/admin/products", {
      allowPickup: true,
      allowShipping: true,
      currency: "SEK",
      description: "Tryckt på beställning.",
      name: spec.name,
      priceMinor: spec.priceMinor,
      sku: spec.sku,
    }),
    201,
    "create product",
  );
  const productId = created.product.productId;
  await activateProduct(world, tenant, productId);

  await expectJson(
    await adminCall(world, tenant, "POST", "/v1/admin/pod/mappings", {
      artworkId: spec.artworkId,
      printerId: "fake-printer",
      productId,
      sku: TEE_S,
      slots: ["front"],
    }),
    201,
    "create mapping",
  );

  const quote = await expectJson<Quote>(
    await adminCall(world, tenant, "GET", `/v1/admin/pod/quote?productId=${encodeURIComponent(productId)}`),
    200,
    "quote",
  );
  return { productId, quote };
}

/** A plain (non-POD) product, published. */
export async function createPlainProduct(
  world: SliceWorld,
  tenant: Tenant,
  spec: { name: string; priceMinor: number; sku: string },
): Promise<string> {
  const created = await expectJson<{ product: { productId: string } }>(
    await adminCall(world, tenant, "POST", "/v1/admin/products", {
      allowPickup: true,
      currency: "SEK",
      name: spec.name,
      priceMinor: spec.priceMinor,
      sku: spec.sku,
    }),
    201,
    "create plain product",
  );
  await activateProduct(world, tenant, created.product.productId);
  return created.product.productId;
}

/** Products are born 'draft'; PATCH { status: "active" } before a publish. */
export async function activateProduct(world: SliceWorld, tenant: Tenant, productId: string): Promise<void> {
  const body = await expectJson<{ product: { status: string } }>(
    await adminCall(world, tenant, "PATCH", `/v1/admin/products/${productId}`, { status: "active" }),
    200,
    "activate product",
  );
  expect(body.product.status).toBe("active");
}

export async function publishProduct(world: SliceWorld, tenant: Tenant, productId: string) {
  return expectJson<{ product: { screeningStatus: string | null } }>(
    await adminCall(world, tenant, "POST", `/v1/admin/products/${productId}/publish`),
    200,
    "publish",
  );
}

export async function approveProduct(world: SliceWorld, productId: string) {
  return expectJson<{ screening: { status: string } }>(
    await platformCall(world, "POST", `/v1/platform/screening/${productId}`, { decision: "approved" }),
    200,
    "platform approval",
  );
}

// ── storefront: checkout, payment, the webhook ──────────────────────────────

export interface CheckoutView {
  checkoutId: string;
  deliveryMethod: string;
  items: Array<{ productId: string; quantity: number; unitPriceMinor: number }>;
  totalMinor: number;
}

/** The buyer's boxes (CP2-E): terms always; marketing and the waiver when ticked. */
export interface BuyerConsent {
  disclosureVersion?: string;
  marketing?: boolean;
  terms: true;
  withdrawalWaiver?: boolean;
}

export async function openCheckout(
  world: SliceWorld,
  tenant: Tenant,
  items: Array<{ productId: string; quantity: number }>,
  options: { consent?: BuyerConsent; email?: string; recipient?: Record<string, unknown> } = {},
): Promise<CheckoutView> {
  const body = await expectJson<{ checkout: CheckoutView }>(
    await storefrontCall(world, tenant, "POST", "/v1/checkout", {
      body: {
        consent: options.consent ?? { terms: true },
        deliveryMethod: "pickup",
        email: options.email ?? `${unique("buyer")}@buyers.slice.test`,
        idempotencyKey: unique("idem-slice"),
        items,
        recipient: options.recipient ?? SLICE_RECIPIENT,
      },
      origin: null,
    }),
    201,
    "checkout",
  );
  return body.checkout;
}

/** POST /v1/checkout/{id}/payment — no body, tenant from the hostname. */
export function paymentCall(world: SliceWorld, tenant: Tenant, checkoutId: string, targetEnv?: Env) {
  return storefrontCall(world, tenant, "POST", `/v1/checkout/${checkoutId}/payment`, {
    env: targetEnv,
    origin: null,
  });
}

export async function payCheckout(world: SliceWorld, tenant: Tenant, checkoutId: string): Promise<string> {
  const body = await expectJson<{ payment: { clientSecret: string; paymentIntentId: string } }>(
    await paymentCall(world, tenant, checkoutId),
    201,
    "payment intent",
  );
  return body.payment.paymentIntentId;
}

/** Stripe says the intent succeeded: the fake's record, then the SIGNED webhook. */
export async function succeedPayment(
  world: SliceWorld,
  tenant: Tenant,
  payment: { checkoutId: string; paymentIntentId: string; totalMinor: number },
  options: { env?: Env; eventId?: string } = {},
): Promise<{ eventId: string; orderId: string | null }> {
  markIntentSucceeded(world, payment.paymentIntentId);
  const { eventId, response } = await postEvent(
    "payment_intent.succeeded",
    {
      amount: payment.totalMinor,
      currency: "sek",
      id: payment.paymentIntentId,
      latest_charge: `ch_${payment.paymentIntentId.replace(/^pi_/, "")}`,
      metadata: { checkout_id: payment.checkoutId, tenant_id: tenant.tenantId },
      object: "payment_intent",
      status: "succeeded",
    },
    { env: options.env ?? world.env, eventId: options.eventId },
  );
  expect(response.status, "the webhook answers 200").toBe(200);
  const order = await env.DB.prepare("SELECT order_id FROM orders WHERE checkout_id = ?")
    .bind(payment.checkoutId)
    .first<{ order_id: string }>();
  return { eventId, orderId: order?.order_id ?? null };
}

export function markIntentSucceeded(world: SliceWorld, paymentIntentId: string, chargedAtMs = Date.now()): void {
  const intent = world.stripe.intents.get(paymentIntentId);
  if (intent === undefined) {
    throw new Error(`the fake Stripe never created ${paymentIntentId}`);
  }
  world.stripe.intents.set(paymentIntentId, {
    ...intent,
    chargeCreated: Math.floor(chargedAtMs / 1_000),
    status: "succeeded",
  });
}

export interface PaidOrder {
  checkoutId: string;
  dispatchIds: string[];
  emailId: string;
  orderId: string;
  paymentIntentId: string;
  totalMinor: number;
}

/**
 * Checkout → PaymentIntent → signed success webhook, then the order
 * confirmation delivered (so no test leaves a due email row for another
 * test's sweep to trip over).
 */
export async function buyProduct(
  world: SliceWorld,
  tenant: Tenant,
  productId: string,
  options: { deliverEmail?: boolean; quantity?: number } = {},
): Promise<PaidOrder> {
  const checkout = await openCheckout(world, tenant, [{ productId, quantity: options.quantity ?? 1 }]);
  const paymentIntentId = await payCheckout(world, tenant, checkout.checkoutId);
  const { orderId } = await succeedPayment(world, tenant, {
    checkoutId: checkout.checkoutId,
    paymentIntentId,
    totalMinor: checkout.totalMinor,
  });
  if (orderId === null) {
    throw new Error("the webhook made no order");
  }
  const rows = await outboxRowsFor(orderId);
  const emailId = rows.find((row) => row.event_type === "email")?.outbox_id;
  if (emailId === undefined) {
    throw new Error("no confirmation email row");
  }
  if (options.deliverEmail !== false) {
    await deliverOutbox(world, [emailId]);
  }
  return {
    checkoutId: checkout.checkoutId,
    dispatchIds: rows.filter((row) => row.event_type === "dispatch").map((row) => row.outbox_id),
    emailId,
    orderId,
    paymentIntentId,
    totalMinor: checkout.totalMinor,
  };
}

// ── queues ──────────────────────────────────────────────────────────────────

export interface DeliveredBatch {
  acks: string[];
  retries: Array<{ delaySeconds: number | undefined; id: string }>;
}

export function queueBatch(queue: string, bodies: unknown[]): { batch: MessageBatch<unknown>; result: DeliveredBatch } {
  const result: DeliveredBatch = { acks: [], retries: [] };
  const batch = {
    ackAll: () => {
      throw new Error("the consumers never ack a whole batch");
    },
    messages: bodies.map((body, index) => ({
      ack: () => result.acks.push(`m${index}`),
      attempts: 1,
      body,
      id: `m${index}`,
      retry: (options?: { delaySeconds?: number }) =>
        result.retries.push({ delaySeconds: options?.delaySeconds, id: `m${index}` }),
      timestamp: new Date(),
    })),
    queue,
    retryAll: () => {
      throw new Error("the consumers never retry a whole batch");
    },
  } as unknown as MessageBatch<unknown>;
  return { batch, result };
}

/** Delivers `{ outboxId }` nudges to the REAL `-outbox` consumer (worker.queue). */
export async function deliverOutbox(world: SliceWorld, outboxIds: string[], targetEnv?: Env): Promise<DeliveredBatch> {
  const { batch, result } = queueBatch(
    "chopshop-test-outbox",
    outboxIds.map((outboxId) => ({ outboxId })),
  );
  await worker.queue(batch, targetEnv ?? world.env);
  return result;
}

/**
 * Resend, as far as the platform relies on it: every send carries an
 * Idempotency-Key, and a repeated key within 24 h is the SAME email (Resend
 * answers with the first message's id and sends nothing). `delivered` is what
 * a buyer would actually receive.
 */
export class FakeResend {
  /** Every call as it reached "Resend": its Idempotency-Key. */
  readonly calls: Array<{ idempotencyKey: string | null }> = [];
  readonly delivered = new Map<string, { id: string; payload: { subject: string; to: string[] } }>();

  readonly fetch = async (request: Request): Promise<Response> => {
    const idempotencyKey = request.headers.get("idempotency-key");
    this.calls.push({ idempotencyKey });
    const key = idempotencyKey ?? crypto.randomUUID();
    const existing = this.delivered.get(key);
    if (existing !== undefined) {
      return Response.json({ id: existing.id });
    }
    const payload = await request.json<{ subject: string; to: string[] }>();
    const id = `re_${crypto.randomUUID()}`;
    this.delivered.set(key, { id, payload });
    return Response.json({ id });
  };
}

/** Drains the recorded EMAIL_QUEUE into the REAL `-email` consumer with a fake Resend. */
export async function deliverEmails(
  world: SliceWorld,
  resend: FakeResend,
  options: { env?: Env; jobs?: unknown[] } = {},
): Promise<DeliveredBatch> {
  const jobs = options.jobs ?? world.emails.sent.splice(0);
  const { batch, result } = queueBatch("chopshop-test-email", jobs);
  await worker.queue(batch, {
    ...(options.env ?? world.env),
    [RESEND_FETCH_OVERRIDE]: resend.fetch,
  } as unknown as Env);
  return result;
}

// ── the fake printer's wire, with faults ────────────────────────────────────

export type PrinterFault = "deliver" | "lose_answer" | "unreachable";

/** Every submission that reached the printer's wire, in order. */
export type PrinterLog = Array<{ fault: PrinterFault; jobId: string }>;

/**
 * A FAKE_PRINTER_FETCH_OVERRIDE transport. Per job id: deliver normally, deliver
 * and then lose the answer, or fail before anything reaches the printer.
 * `onDelivered` runs after the printer has the job, before the answer returns
 * (i.e. while the request is "on the wire"). `log` records every SUBMISSION —
 * the fake printer's own table cannot show a duplicate (its job_id is UNIQUE,
 * which is the printer-side dedupe the design relies on), so "exactly once" is
 * asserted on the wire too.
 */
export function printerWire(
  fault: (jobId: string) => PrinterFault,
  onDelivered?: (jobId: string) => Promise<void>,
  log?: PrinterLog,
): Record<symbol, unknown> {
  return {
    [FAKE_PRINTER_FETCH_OVERRIDE]: async (request: Request): Promise<Response> => {
      const payload = await request.clone().json<{ job_id?: unknown }>();
      const jobId = typeof payload.job_id === "string" ? payload.job_id : "";
      const mode = fault(jobId);
      log?.push({ fault: mode, jobId });
      if (mode === "unreachable") {
        throw new Error("printer unreachable");
      }
      const response = await handleFakePrinterRoute(env as unknown as Env, request);
      await onDelivered?.(jobId);
      if (mode === "lose_answer") {
        throw new Error("connection reset");
      }
      return response;
    },
  };
}

// ── receipts, admin money, dispatch ─────────────────────────────────────────

export async function claimReceipt(world: SliceWorld, tenant: Tenant, checkoutId: string) {
  return storefrontCall(world, tenant, "POST", `/v1/checkout/${checkoutId}/receipt`, { origin: null });
}

export function readBuyerOrder(world: SliceWorld, tenant: Tenant, orderId: string, token: string) {
  return storefrontCall(world, tenant, "GET", `/v1/orders/${orderId}`, { bearer: token });
}

export interface AdminOrder {
  consent: {
    marketing: boolean;
    recordedAt: string;
    terms: boolean;
    withdrawal: { disclosureVersion: string | null; personalizedItems: number[]; waived: boolean };
  } | null;
  money: {
    chargedMinor: number;
    feeMinor: number;
    refundableMinor: number;
    refundedMinor: number;
    refundPendingMinor: number;
  };
  payout: { amountMinor: number; eligibleAt: string; state: string };
  refunds: Array<{ amountMinor: number; origin: string; refundId: string; state: string }>;
  status: string;
  withdrawal: { waived: boolean };
}

export async function adminOrder(world: SliceWorld, tenant: Tenant, orderId: string): Promise<AdminOrder> {
  const body = await expectJson<{ order: AdminOrder }>(
    await adminCall(world, tenant, "GET", `/v1/admin/orders/${orderId}`),
    200,
    "admin order read",
  );
  return body.order;
}

/**
 * POST …/refunds with the Idempotency-Key the route requires (CP2-E): a fresh
 * one unless the caller names it (a retry after a lost response reuses it).
 */
export function refundCall(
  world: SliceWorld,
  tenant: Tenant,
  orderId: string,
  amountMinor: number,
  targetEnv?: Env,
  idempotencyKey: string = crypto.randomUUID(),
) {
  return call(world, "POST", `${ADMIN}/v1/admin/orders/${orderId}/refunds`, {
    body: { amountMinor, reason: "Kunden ångrade köpet" },
    cookie: tenant.adminCookie,
    env: targetEnv,
    headers: { "idempotency-key": idempotencyKey },
    shopId: tenant.tenantId,
  });
}

export function cancelCall(world: SliceWorld, tenant: Tenant, orderId: string, targetEnv?: Env) {
  return adminCall(world, tenant, "POST", `/v1/admin/orders/${orderId}/cancel`, {
    reason: "Kunden ångrade sig",
  }, targetEnv);
}

export function resolveCall(world: SliceWorld, outboxId: string, body: unknown) {
  return platformCall(world, "POST", `/v1/platform/dispatch/${outboxId}/resolve`, body);
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface OutboxSummary {
  attempts: number;
  cancel_requested: number;
  event_type: string;
  last_error: string | null;
  outbox_id: string;
  status: string;
  submitted_at: number | null;
}

export async function outboxRowsFor(orderId: string): Promise<OutboxSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT outbox_id, event_type, status, attempts, cancel_requested, last_error, submitted_at
     FROM outbox_events WHERE aggregate_id = ? ORDER BY created_at, event_type, outbox_id`,
  )
    .bind(orderId)
    .all<OutboxSummary>();
  return rows.results;
}

// ── the crons, in scheduled()'s order ───────────────────────────────────────

/**
 * One 15-minute tick exactly as src/outbox/scheduled.ts orders it — deferred
 * replay, outbox sweep, reconciliation, retention, alert digest — at an
 * explicit `now`, so a suite can stand 31 minutes in the future. scheduled()
 * itself reads the wall clock, and some steps check a timestamp against
 * Date.now() (the digest job refuses a createdAt in the future), so the wall
 * clock is pinned to `now` for the tick, as it is for a real cron.
 */
export async function cronTick(targetEnv: Env, now: number) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const replay = await replayDeferred(targetEnv, now);
    const sweep = await runOutboxSweep(targetEnv, now);
    const reconciliation = await runReconciliation(targetEnv, now);
    const retention = await runRetentionSweep(targetEnv, now);
    const digest = await runAlertDigest(targetEnv, now);
    return { digest, reconciliation, replay, retention, sweep };
  } finally {
    clock.mockRestore();
  }
}

// ── an instrumented D1: interleavings, crashes, and "which batch wrote it" ──

export interface DbOp {
  kind: "all" | "batch" | "first" | "raw" | "run";
  sql: string[];
}

/**
 * A D1 handle whose every operation (a statement's first/all/run/raw, or a
 * batch) is logged with its SQL and passed to `before` first — which may await
 * an interleaving or throw to simulate the worker dying at exactly that point.
 * Statements reach D1 unwrapped. (The same shape as pod-publish.test.ts's
 * interleavedDb, keyed on SQL instead of a call count.)
 */
export function instrumentedDb(
  before: (op: DbOp) => Promise<void> | void,
  base: D1Database = env.DB,
): { db: D1Database; ops: DbOp[] } {
  const ops: DbOp[] = [];
  const realOf = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();

  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        }
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return async (...args: unknown[]) => {
            const op: DbOp = { kind: prop, sql: [sql] };
            ops.push(op);
            await before(op);
            return (Reflect.get(target, prop, target) as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    realOf.set(proxy, statement);
    sqlOf.set(proxy, sql);
    return proxy;
  };

  const db = new Proxy(base, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => wrap(target.prepare(sql), sql);
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const op: DbOp = { kind: "batch", sql: statements.map((statement) => sqlOf.get(statement) ?? "") };
          ops.push(op);
          await before(op);
          return target.batch(statements.map((statement) => realOf.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  return { db, ops };
}

export function opWrites(op: DbOp, pattern: RegExp): boolean {
  return op.sql.some((sql) => pattern.test(sql));
}

/**
 * A DB that dies ONCE, at the first operation matching `when` after `armed()`
 * turns true — i.e. after the external effect already happened.
 */
export function dyingDb(armed: () => boolean, when: (op: DbOp) => boolean = (op) => op.kind === "batch") {
  let died = false;
  return instrumentedDb((op) => {
    if (!died && armed() && when(op)) {
      died = true;
      throw new Error("worker died");
    }
  });
}

// ── the ledger (PLAN §10 CP2: "money reconciles to the öre") ────────────────

export interface Ledger {
  chargedMinor: number;
  commissionMinor: number;
  feeMinor: number;
  payoutMinor: number;
  refundHeldMinor: number;
  refundedMinor: number;
  /** D36 (CP2-D2): withholding returned to the shop as an application-fee refund; 0 before 0028. */
  releasedMinor: number;
  retransferredMinor: number;
  reversedMinor: number;
  stripe: {
    feeCollectedMinor: number;
    feeRefundedMinor: number;
    intentAmountMinor: number;
    refundedMinor: number;
    /** What the connected account holds from this charge, by Stripe's movements. */
    shopNetMinor: number;
  } | null;
  withheldMinor: number;
}

type Row = Record<string, unknown>;

function money(row: Row, column: string): number {
  const value = row[column];
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`ledger: ${column} is not an integer öre amount (${String(value)})`);
  }
  return value;
}

/**
 * Application-fee refunds the fake Stripe recorded for this order's D36
 * withholding release, found the way the worker finds them at Stripe: by
 * `metadata.withholding_release_id`. Duck-typed over the fake's own records,
 * because the fake's shape for fee refunds belongs to CP2-D2; 0 when there is
 * no release (or no 0028 yet).
 */
async function feeRefundedAtStripe(db: D1Database, fake: FakeMoneyStripe, orderId: string): Promise<number> {
  let releaseIds: string[];
  try {
    const rows = await db
      .prepare("SELECT id FROM withholding_releases WHERE order_id = ?")
      .bind(orderId)
      .all<{ id: string }>();
    releaseIds = rows.results.map((row) => row.id);
  } catch {
    return 0; // no withholding_releases table: D36 not built in this tree
  }
  if (releaseIds.length === 0) {
    return 0;
  }
  const seen = new Set<string>();
  let total = 0;
  for (const value of Object.values(fake as unknown as Record<string, unknown>)) {
    const entries = value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : [];
    for (const entry of entries.flat()) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as { amount?: unknown; id?: unknown; metadata?: { withholding_release_id?: unknown } };
      const releaseId = record.metadata?.withholding_release_id;
      if (
        typeof releaseId === "string" &&
        releaseIds.includes(releaseId) &&
        typeof record.amount === "number" &&
        typeof record.id === "string" &&
        !seen.has(record.id)
      ) {
        seen.add(record.id);
        total += record.amount;
      }
    }
  }
  return total;
}

/**
 * Every money fact of one order, cross-checked from three independent places:
 *   1. the order's money columns;
 *   2. its refund_operations (the reserve-first ledger);
 *   3. (when given) the fake Stripe's own record of what it did — the intent,
 *      the application fee it collected, the refunds it made (reverse_transfer,
 *      fee kept), fee refunds (D36) and the transfer movements.
 * and the one identity that ties them:
 *
 *   charged = refunded + payout + fee + reversed − retransferred − released
 *
 * where `payout` is the admin read's figure when given (the seller's ONE
 * number), and must equal what the connected account actually nets at Stripe.
 */
export async function assertLedgerBalanced(
  db: D1Database,
  orderId: string,
  options: { payoutMinor?: number; stripe?: FakeMoneyStripe } = {},
): Promise<Ledger> {
  // SELECT *: a money column a later migration adds is read without a change here.
  const order = await db.prepare("SELECT * FROM orders WHERE order_id = ?").bind(orderId).first<Row>();
  if (order === null) {
    throw new Error(`ledger: no order ${orderId}`);
  }
  const ops = await db
    .prepare(
      `SELECT id, amount_minor, state, stripe_refund_id FROM refund_operations
       WHERE order_id = ? ORDER BY created_at, id`,
    )
    .bind(orderId)
    .all<{ amount_minor: number; id: string; state: string; stripe_refund_id: string | null }>();

  const charged = money(order, "charged_minor");
  const fee = money(order, "application_fee_minor");
  const withheld = money(order, "withheld_minor");
  const reversed = money(order, "transfer_reversed_minor");
  const retransferred = money(order, "dispute_retransferred_minor");
  const released = money(order, "withholding_released_minor");
  const paymentIntentId = String(order.payment_intent_id);

  const label = `ledger ${orderId}`;
  const sum = (states: string[]) =>
    ops.results.filter((op) => states.includes(op.state)).reduce((total, op) => total + op.amount_minor, 0);
  const refunded = sum(["succeeded"]);
  const held = sum(["reserved", "submitted"]);

  // The reserve-first ledger and the order's columns agree, to the öre.
  expect(money(order, "refund_succeeded_minor"), `${label}: succeeded ops = refund_succeeded_minor`).toBe(refunded);
  expect(money(order, "refunded_total_minor"), `${label}: refunded_total_minor mirrors it`).toBe(refunded);
  expect(money(order, "refund_reserved_minor"), `${label}: held ops = refund_reserved_minor`).toBe(held);
  // Never over-refunded, counting what is still in flight.
  expect(refunded + held, `${label}: refunded + held <= charged`).toBeLessThanOrEqual(charged);
  // The fee is commission + withholding, neither negative, never above the charge;
  // a release returns at most the withholding, never the commission (D9/D36).
  expect(withheld).toBeGreaterThanOrEqual(0);
  expect(fee).toBeGreaterThanOrEqual(withheld);
  expect(fee).toBeLessThanOrEqual(charged);
  expect(released).toBeLessThanOrEqual(withheld);

  const payout = charged - refunded - fee - reversed + retransferred + released;
  if (options.payoutMinor !== undefined) {
    expect(options.payoutMinor, `${label}: the seller's payout is the ledger's`).toBe(payout);
  }
  expect(
    refunded + payout + fee + reversed - retransferred - released,
    `${label}: charged = refunded + payout + fee + reversed − retransferred − released`,
  ).toBe(charged);

  let stripe: Ledger["stripe"] = null;
  if (options.stripe !== undefined) {
    const fake = options.stripe;
    const intent = fake.intents.get(paymentIntentId);
    expect(intent, `${label}: Stripe knows the intent`).toBeDefined();
    const created = fake.createCalls.filter(
      (params) => `pi_${params.idempotencyKey.replace(/[^A-Za-z0-9]/g, "")}` === paymentIntentId,
    );
    expect(created.length, `${label}: the intent was created`).toBeGreaterThanOrEqual(1);
    // Every create for this intent carried the same money (idempotent retries).
    for (const params of created) {
      expect(params.amount).toBe(charged);
      expect(params.applicationFeeAmount, `${label}: fee collected = fee frozen`).toBe(fee);
      expect(params.transferDestination).toBe(order.connect_account_id);
    }
    const atStripe = [...fake.refunds.values()].filter((refund) => refund.payment_intent === paymentIntentId);
    const stripeSucceeded = atStripe
      .filter((refund) => refund.status === "succeeded")
      .reduce((total, refund) => total + refund.amount, 0);
    expect(stripeSucceeded, `${label}: Stripe's succeeded refunds = the ledger's`).toBe(refunded);
    // Each op Stripe answered for maps to exactly one Stripe refund of its amount.
    for (const op of ops.results) {
      if (op.stripe_refund_id === null) {
        continue;
      }
      const refund = fake.refunds.get(op.stripe_refund_id);
      expect(refund?.amount, `${label}: op ${op.id} ↔ ${op.stripe_refund_id}`).toBe(op.amount_minor);
    }
    // …and every Stripe refund of this intent is known to exactly one op.
    for (const refund of atStripe) {
      const owners = ops.results.filter((op) => op.stripe_refund_id === refund.id);
      expect(owners.length, `${label}: Stripe refund ${refund.id} has one op`).toBe(1);
    }
    // D9: the fee stays; reverse_transfer claws the principal back from the shop.
    for (const params of fake.refundCalls.filter((call) => call.paymentIntentId === paymentIntentId)) {
      expect(params.refundApplicationFee).toBe(false);
      expect(params.reverseTransfer).toBe(true);
    }
    const transferId = typeof order.stripe_transfer_id === "string" ? order.stripe_transfer_id : null;
    const reversals = transferId === null
      ? 0
      : (fake.reversalsByTransfer.get(transferId) ?? []).reduce((total, r) => total + r.amount, 0);
    const retransfers = [...fake.transfersByGroup.values()]
      .flat()
      .filter((transfer) => transfer.metadata.order_id === orderId)
      .reduce((total, transfer) => total + transfer.amount, 0);
    const feeRefunded = await feeRefundedAtStripe(db, fake, orderId);
    expect(feeRefunded, `${label}: Stripe's fee refunds = the recorded release`).toBe(released);
    const intentAmount = intent?.amount ?? 0;
    // Destination charge, transfer = gross: the shop receives the charge, the
    // platform collects its fee from it (and returns any fee refund), each
    // refund reverses its own amount.
    const shopNet = intentAmount - fee + feeRefunded - stripeSucceeded - reversals + retransfers;
    expect(shopNet, `${label}: the payout is what the connected account nets at Stripe`).toBe(payout);
    stripe = {
      feeCollectedMinor: fee,
      feeRefundedMinor: feeRefunded,
      intentAmountMinor: intentAmount,
      refundedMinor: stripeSucceeded,
      shopNetMinor: shopNet,
    };
  }

  return {
    chargedMinor: charged,
    commissionMinor: fee - withheld,
    feeMinor: fee,
    payoutMinor: payout,
    refundHeldMinor: held,
    refundedMinor: refunded,
    releasedMinor: released,
    retransferredMinor: retransferred,
    reversedMinor: reversed,
    stripe,
    withheldMinor: withheld,
  };
}

/** Keys (case-insensitive substrings) no buyer- or seller-facing body may carry. */
export function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => keysOf(entry, into));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      keysOf(entry, into);
    }
  }
  return into;
}

export function numbersOf(value: unknown, into: number[] = []): number[] {
  if (typeof value === "number") {
    into.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => numbersOf(entry, into));
  } else if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((entry) => numbersOf(entry, into));
  }
  return into;
}
