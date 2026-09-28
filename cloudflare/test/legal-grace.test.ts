import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCheckout } from "../src/commerce/checkout";
import {
  GRACE_PERIOD_MS,
  hasAcceptedCurrentTerms,
  isTermsGateOpen,
  readTermsStatus,
} from "../src/legal/platform-terms";
import {
  bareTenantStatement,
  BUYER_CONSENT,
  BUYER_RECIPIENT_PICKUP,
  CURRENT_TERMS_VERSION,
  DAY,
  FOURTEEN_DAYS,
  legalReadinessStatements,
  termsAcceptanceStatement,
  termsVersionStatement,
} from "./legal-fixtures";
import {
  acceptPlatformTerms,
  adminCall,
  approveProduct,
  bootstrapPlatform,
  call,
  createPlainProduct,
  createTenant,
  expectJson,
  PLATFORM,
  platformCall,
  publishProduct,
  sha256Hex,
  SliceWorld,
  storefrontCall,
  type Tenant,
  unique,
} from "./slice-harness";

/**
 * CP3-E — D47 grace (with D54) and publishing a platform-terms version.
 *
 *   GRACE   a new version C keeps a shop that accepted the IMMEDIATELY PREVIOUS
 *           version open for [C.published_at, C.published_at + 14 d) — the
 *           deadline instant itself is closed. Never accepted, or two versions
 *           behind: no grace.
 *   PUBLISH platform session only; the Worker hashes and archives the text
 *           (private bucket, not a stored_objects row) and audits; labels are
 *           unique and each version is published after the latest.
 *
 * Storage is per file, and versions are append-only and strictly ordered, so
 * this file runs ONE timeline:
 *   2026-09-07 (0031 seed) → R0 (now − 3 h) → R (now − 2 h)   the real-clock routes
 *   → G1 2031-01-01 → G2 2031-03-01 → G3 2031-03-05           the injected clock
 *   → P  2032-01-01                                            the publish route
 */

const world = new SliceWorld();
const iso = (ms: number) => new Date(ms).toISOString();
const bytes = (text: string) => new TextEncoder().encode(text);

const SEED_SHA256 = "ca1f708f70d0ab3b9d26d9d0647efafca77018d8a4e5dcc6bfec7c0a464c0b91";
const R0 = "r0-recent";
const R = "r-recent";
const R_TEXT = "Plattformsvillkor, testversion R.\n\nTest Seller läser och godkänner.";
const G1 = "g1-2031";
const G1_AT = "2031-01-01T00:00:00.000Z";
const G2 = "g2-2031";
const G2_AT = "2031-03-01T00:00:00.000Z";
const G3 = "g3-2031";
const G3_AT = "2031-03-05T00:00:00.000Z";
const ZERO = "0".repeat(64);
const VERSIONS_PATH = "/v1/platform/legal/terms-versions";
const NOT_FOUND = { error: { code: "not_found", message: "Route not found" } };

let graceShop: Tenant;
let behindShop: Tenant;
let neverShop: Tenant;
let clockShop: Tenant;
let graceMug = "";
let clockMug = "";
let r0At = "";
let rAt = "";
let rSha = "";

beforeAll(async () => {
  await bootstrapPlatform(world);
  // All created while the 0031 seed is current: every one but neverShop accepts it.
  graceShop = await createTenant(world, { legallyReady: false,
    host: "grace-shop.example.com",
    shopName: "Nåd Butik",
    tenantId: "grace-shop",
  });
  behindShop = await createTenant(world, { legallyReady: false,
    host: "behind-shop.example.com",
    shopName: "Efter Butik",
    tenantId: "behind-shop",
  });
  neverShop = await createTenant(world, { legallyReady: false,
    acceptTerms: false,
    host: "never-shop.example.com",
    shopName: "Aldrig Butik",
    tenantId: "never-shop",
  });
  clockShop = await createTenant(world, { legallyReady: false,
    host: "clock-shop.example.com",
    shopName: "Klock Butik",
    tenantId: "clock-shop",
  });
  graceMug = await createPlainProduct(world, graceShop, { name: "Mugg", priceMinor: 14_900, sku: "GRACE-MUG" });
  clockMug = await createPlainProduct(world, clockShop, { name: "Mugg", priceMinor: 14_900, sku: "CLOCK-MUG" });
  for (const [shop, productId] of [
    [graceShop, graceMug],
    [clockShop, clockMug],
  ] as const) {
    await publishProduct(world, shop, productId);
    await approveProduct(world, productId);
  }
  // Every shop is legally ready (the second gate), so each 404 here is the terms gate's.
  await env.DB.batch(
    [graceShop, behindShop, neverShop, clockShop].flatMap((shop) =>
      legalReadinessStatements(env.DB, shop.tenantId, shop.adminUserId),
    ),
  );

  // Two versions published in the recent past, as a migration would insert
  // them (the publish route refuses a past publish time). graceShop accepted
  // R0 while it was current; behindShop only ever accepted the seed.
  const now = Date.now();
  r0At = iso(now - 3 * 60 * 60 * 1_000);
  rAt = iso(now - 2 * 60 * 60 * 1_000);
  rSha = await sha256Hex(bytes(R_TEXT));
  await env.DB.batch([
    termsVersionStatement(env.DB, R0, r0At),
    termsVersionStatement(env.DB, R, rAt, rSha),
    termsAcceptanceStatement(env.DB, graceShop.tenantId, R0, iso(now - 150 * 60 * 1_000)),
  ]);
}, 60_000);

beforeEach(() => {
  world.reset();
});

async function statusOf(tenant: Tenant) {
  return expectJson<Record<string, unknown>>(
    await adminCall(world, tenant, "GET", "/v1/admin/legal/status"),
    200,
    `status ${tenant.tenantId}`,
  );
}

function checkoutBody(productId: string) {
  return {
    consent: BUYER_CONSENT,
    deliveryMethod: "pickup",
    email: `${unique("buyer")}@example.com`,
    idempotencyKey: unique("idem-grace"),
    items: [{ productId, quantity: 1 }],
    recipient: BUYER_RECIPIENT_PICKUP,
  };
}

async function checkoutCount(tenantId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM checkouts WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
const READY = { legalPagesAccepted: true, ready: true, returnAddress: true, vatAnswered: true };

describe("D47 grace at the real clock, through the routes", () => {
  it("status: one fixed shape — the CP2 keys, the accepted version, the grace and the readiness", async () => {
    // Accepted the immediately previous version (R0): in grace until R + 14 d.
    expect(await statusOf(graceShop)).toEqual({
      accepted: false,
      acceptedAt: null,
      acceptedVersion: R0,
      currentVersion: R,
      graceDeadline: iso(Date.parse(rAt) + FOURTEEN_DAYS),
      inGrace: true,
      readiness: READY,
    });
    // Accepted only the seed: two versions behind, no grace (D54).
    expect(await statusOf(behindShop)).toEqual({
      accepted: false,
      acceptedAt: null,
      acceptedVersion: CURRENT_TERMS_VERSION,
      currentVersion: R,
      graceDeadline: null,
      inGrace: false,
      readiness: READY,
    });
    // Never accepted.
    expect(await statusOf(neverShop)).toEqual({
      accepted: false,
      acceptedAt: null,
      acceptedVersion: null,
      currentVersion: R,
      graceDeadline: null,
      inGrace: false,
      readiness: READY,
    });
  });

  it("checkout: a shop in grace opens one; two behind and never-accepted get the unknown-shop 404 and write nothing", async () => {
    await expectJson(
      await storefrontCall(world, graceShop, "POST", "/v1/checkout", { body: checkoutBody(graceMug), origin: null }),
      201,
      "in grace",
    );

    const unknownShop = await expectJson(
      await call(world, "POST", "https://no-such-shop.example.com/v1/checkout", {
        body: checkoutBody(graceMug),
        origin: null,
      }),
      404,
      "unknown shop",
    );
    for (const shop of [behindShop, neverShop]) {
      // Without the gate this body would be a 400 (the product is another
      // shop's), so a 404 here is the gate and nothing else.
      const gated = await storefrontCall(world, shop, "POST", "/v1/checkout", {
        body: checkoutBody(graceMug),
        origin: null,
      });
      expect(await expectJson(gated, 404, shop.tenantId), "byte-identical to an unknown shop").toEqual(unknownShop);
      expect(await checkoutCount(shop.tenantId)).toBe(0);
    }
  });

  it("re-accepting the current version: open, no grace, no deadline", async () => {
    const acceptedAt = await acceptPlatformTerms(world, graceShop);
    expect(await statusOf(graceShop)).toEqual({
      accepted: true,
      acceptedAt,
      acceptedVersion: R,
      currentVersion: R,
      graceDeadline: null,
      inGrace: false,
      readiness: READY,
    });
    expect(await readTermsStatus(env.DB, graceShop.tenantId, Date.now())).toMatchObject({
      acceptedVersion: R,
      graceDeadline: null,
      inGrace: false,
    });
    await expectJson(
      await storefrontCall(world, graceShop, "POST", "/v1/checkout", { body: checkoutBody(graceMug), origin: null }),
      201,
      "accepted",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the 14-day boundary and D54, on an injected clock", () => {
  const G1_DEADLINE = Date.parse(G1_AT) + FOURTEEN_DAYS; // 2031-01-15T00:00:00.000Z
  const ACCEPTED_R = "2030-06-01T00:00:00.000Z";

  beforeAll(async () => {
    await env.DB.batch([
      termsVersionStatement(env.DB, G1, G1_AT),
      termsVersionStatement(env.DB, G2, G2_AT),
      termsVersionStatement(env.DB, G3, G3_AT),
      bareTenantStatement(env.DB, "t-prev"),
      bareTenantStatement(env.DB, "t-two"),
      bareTenantStatement(env.DB, "t-never"),
      bareTenantStatement(env.DB, "t-g1"),
      bareTenantStatement(env.DB, "t-g2"),
      // t-prev and clockShop accepted R: the version immediately before G1.
      termsAcceptanceStatement(env.DB, "t-prev", R, ACCEPTED_R),
      termsAcceptanceStatement(env.DB, clockShop.tenantId, R, ACCEPTED_R),
      // t-two accepted R0 only: two versions behind G1.
      termsAcceptanceStatement(env.DB, "t-two", R0, ACCEPTED_R),
      termsAcceptanceStatement(env.DB, "t-g1", G1, "2031-01-02T00:00:00.000Z"),
      termsAcceptanceStatement(env.DB, "t-g2", G2, "2031-03-02T12:00:00.000Z"),
    ]);
  });

  it("is exact: open at deadline − 1 ms, closed AT the deadline and at + 1 ms", async () => {
    expect(GRACE_PERIOD_MS).toBe(1_209_600_000);
    expect(iso(G1_DEADLINE)).toBe("2031-01-15T00:00:00.000Z");

    expect(await readTermsStatus(env.DB, "t-prev", G1_DEADLINE - 1)).toEqual({
      acceptedAt: null,
      acceptedVersion: R,
      currentPublishedAt: G1_AT,
      currentSha256: ZERO,
      currentVersion: G1,
      graceDeadline: "2031-01-15T00:00:00.000Z",
      inGrace: true,
    });
    expect(await isTermsGateOpen(env.DB, "t-prev", G1_DEADLINE - 1)).toBe(true);
    expect(await hasAcceptedCurrentTerms(env.DB, "t-prev", G1_DEADLINE - 1), "grace is not acceptance").toBe(false);

    for (const at of [G1_DEADLINE, G1_DEADLINE + 1]) {
      expect(await readTermsStatus(env.DB, "t-prev", at)).toMatchObject({
        acceptedAt: null,
        currentVersion: G1,
        graceDeadline: "2031-01-15T00:00:00.000Z",
        inGrace: false,
      });
      expect(await isTermsGateOpen(env.DB, "t-prev", at), iso(at)).toBe(false);
    }

    // The window starts at the publish instant itself; one ms earlier R is
    // still current, accepted, and no grace is involved.
    expect(await readTermsStatus(env.DB, "t-prev", Date.parse(G1_AT))).toMatchObject({ inGrace: true });
    expect(await readTermsStatus(env.DB, "t-prev", Date.parse(G1_AT) - 1)).toMatchObject({
      acceptedAt: ACCEPTED_R,
      currentVersion: R,
      graceDeadline: null,
      inGrace: false,
    });
  });

  it("checkout opens on the same instants: ok at deadline − 1 ms, the opaque not_found at the deadline and + 1 ms", async () => {
    const tenant = { domainKind: "storefront" as const, hostname: clockShop.host, tenantId: clockShop.tenantId };
    const input = () => ({
      consent: { disclosureVersion: null, marketing: false, terms: true as const, withdrawalWaiver: false },
      deliveryMethod: "pickup" as const,
      discountCode: null,
      email: "clock@example.com",
      idempotencyKey: unique("idem-clock"),
      items: [{ productId: clockMug, quantity: 1 }],
      shippingCountry: null,
    });
    const before = await checkoutCount(clockShop.tenantId);
    expect((await createCheckout(env.DB, tenant, input(), G1_DEADLINE - 1)).status).toBe("ok");
    expect(await createCheckout(env.DB, tenant, input(), G1_DEADLINE)).toEqual({ status: "not_found" });
    expect(await createCheckout(env.DB, tenant, input(), G1_DEADLINE + 1)).toEqual({ status: "not_found" });
    expect(await checkoutCount(clockShop.tenantId), "only the one inside the window").toBe(before + 1);
  });

  it("no grace without an acceptance of the immediately previous version: never accepted, two behind", async () => {
    const inside = Date.parse(G1_AT) + 1;
    expect(await readTermsStatus(env.DB, "t-never", inside)).toMatchObject({
      acceptedVersion: null,
      graceDeadline: null,
      inGrace: false,
    });
    expect(await readTermsStatus(env.DB, "t-two", inside)).toMatchObject({
      acceptedVersion: R0,
      graceDeadline: null,
      inGrace: false,
    });
    for (const tenantId of ["t-never", "t-two"]) {
      expect(await isTermsGateOpen(env.DB, tenantId, inside), tenantId).toBe(false);
    }
  });

  it("D54: two versions published within 14 days — the grace covers the immediately previous version only", async () => {
    // One day after G2: t-g1 accepted G1, the version right before G2.
    const afterG2 = Date.parse(G2_AT) + DAY;
    expect(await readTermsStatus(env.DB, "t-g1", afterG2)).toMatchObject({
      currentVersion: G2,
      graceDeadline: "2031-03-15T00:00:00.000Z",
      inGrace: true,
    });

    // G3 lands 4 days after G2. One day later t-g1 is still inside G2's own
    // 14 days, but G1 is now two versions behind: no grace, checkout closed.
    const afterG3 = Date.parse(G3_AT) + DAY;
    expect(afterG3).toBeLessThan(Date.parse(G2_AT) + FOURTEEN_DAYS);
    expect(await readTermsStatus(env.DB, "t-g1", afterG3)).toMatchObject({
      acceptedVersion: G1,
      currentVersion: G3,
      graceDeadline: null,
      inGrace: false,
    });
    expect(await isTermsGateOpen(env.DB, "t-g1", afterG3)).toBe(false);

    // t-g2 accepted G2, the version right before G3: its own 14 days from G3.
    expect(await readTermsStatus(env.DB, "t-g2", afterG3)).toMatchObject({
      acceptedVersion: G2,
      graceDeadline: "2031-03-19T00:00:00.000Z",
      inGrace: true,
    });

    // Re-accepting the new version: open, no grace flag, no deadline.
    await termsAcceptanceStatement(env.DB, "t-g2", G3, "2031-03-06T12:00:00.000Z").run();
    const afterReaccept = Date.parse("2031-03-07T00:00:00.000Z");
    expect(await readTermsStatus(env.DB, "t-g2", afterReaccept)).toMatchObject({
      acceptedAt: "2031-03-06T12:00:00.000Z",
      acceptedVersion: G3,
      graceDeadline: null,
      inGrace: false,
    });
    expect(await isTermsGateOpen(env.DB, "t-g2", afterReaccept)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("publishing a platform-terms version (platform only)", () => {
  const P = "2032-01-01";
  const P_AT = "2032-01-01T00:00:00.000Z";
  const P_TEXT = "Plattformsvillkor – testversion 2032.\n\nGäller mellan plattformen och Test Seller.";

  it("lists every version newest first, with publish time, hash, archive state and which is current", async () => {
    const list = await expectJson<{ versions: Array<Record<string, unknown>> }>(
      await platformCall(world, "GET", VERSIONS_PATH),
      200,
      "list",
    );
    expect(list.versions.map((row) => row.version)).toEqual([G3, G2, G1, R, R0, CURRENT_TERMS_VERSION]);
    expect(list.versions[3]).toEqual({ current: true, publishedAt: rAt, sha256: rSha, textArchived: false, version: R });
    expect(list.versions[5]).toEqual({
      current: false,
      publishedAt: "2026-09-07T00:00:00.000Z",
      sha256: SEED_SHA256,
      textArchived: false,
      version: CURRENT_TERMS_VERSION,
    });
  });

  it("publishes: the Worker hashes the text, archives it as a private object, audits; the time must follow the latest", async () => {
    // The default publish time (now) is before the scheduled 2031 versions.
    expect(
      await expectJson(await platformCall(world, "POST", VERSIONS_PATH, { text: P_TEXT, version: P }), 409, "not latest"),
    ).toEqual({
      error: {
        code: "terms_version_not_latest",
        message: "A new terms version must be published after the latest existing version",
      },
      latestPublishedAt: G3_AT,
    });
    // A publish time in the past, and malformed bodies.
    for (const body of [
      { publishedAt: "2020-01-01T00:00:00.000Z", text: P_TEXT, version: P },
      { publishedAt: "2032-01-01", text: P_TEXT, version: P },
      { publishedAt: "2032-02-30T00:00:00.000Z", text: P_TEXT, version: P },
      { publishedAt: P_AT, text: "", version: P },
      { publishedAt: P_AT, text: "\ud800", version: P },
      { publishedAt: P_AT, text: P_TEXT, version: "a b" },
      { publishedAt: P_AT, text: P_TEXT, version: P, sha256: ZERO },
      { publishedAt: P_AT, version: P },
    ]) {
      expect((await platformCall(world, "POST", VERSIONS_PATH, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }

    const created = await expectJson<{ version: Record<string, unknown> }>(
      await platformCall(world, "POST", VERSIONS_PATH, { publishedAt: P_AT, text: P_TEXT, version: P }),
      201,
      "publish",
    );
    const sha = await sha256Hex(bytes(P_TEXT));
    expect(created).toEqual({
      version: { current: false, publishedAt: P_AT, sha256: sha, textArchived: true, version: P },
    });

    // The evidence holds the hash; the archive holds the exact text it is the hash of.
    const version = await env.DB.prepare("SELECT published_at, sha256 FROM platform_terms_versions WHERE version = ?")
      .bind(P)
      .first();
    expect(version).toEqual({ published_at: P_AT, sha256: sha });
    const archive = await env.DB.prepare(
      "SELECT object_key, sha256, size_bytes, archived_by FROM platform_terms_texts WHERE version = ?",
    )
      .bind(P)
      .first<{ archived_by: string; object_key: string; sha256: string; size_bytes: number }>();
    expect(archive).toEqual({
      archived_by: world.platformUserId,
      object_key: `platform/legal/terms/${P}/${sha}.txt`,
      sha256: sha,
      size_bytes: bytes(P_TEXT).byteLength,
    });
    const object = await env.PRIVATE_BUCKET.get(archive?.object_key ?? "");
    expect(object?.httpMetadata?.contentType).toBe("text/plain; charset=utf-8");
    const stored = new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(await sha256Hex(stored)).toBe(sha);
    expect(new TextDecoder().decode(stored)).toBe(P_TEXT);
    // Not a stored_objects row: no tenant object route can address it.
    const objects = await env.DB.prepare("SELECT COUNT(*) AS n FROM stored_objects WHERE object_key LIKE '%legal%'")
      .first<{ n: number }>();
    expect(objects?.n).toBe(0);

    const audit = await env.DB.prepare(
      `SELECT tenant_id, actor_user_id, action, resource_type, resource_id, metadata_json
       FROM audit_events WHERE action = 'legal.platform_terms.publish'`,
    ).all();
    expect(audit.results).toEqual([
      {
        action: "legal.platform_terms.publish",
        actor_user_id: world.platformUserId,
        metadata_json: JSON.stringify({ publishedAt: P_AT, sha256: sha, sizeBytes: bytes(P_TEXT).byteLength }),
        resource_id: P,
        resource_type: "platform_terms_version",
        tenant_id: null,
      },
    ]);

    // Labels are unique; an equal publish time is not "after the latest".
    expect(
      await expectJson(
        await platformCall(world, "POST", VERSIONS_PATH, { publishedAt: "2033-01-01T00:00:00.000Z", text: "x", version: P }),
        409,
        "same label",
      ),
    ).toEqual({ error: { code: "terms_version_exists", message: "A terms version with this label exists" } });
    expect(
      (await platformCall(world, "POST", VERSIONS_PATH, { publishedAt: P_AT, text: "x", version: "2032-tie" })).status,
    ).toBe(409);
    // The database holds the order too (a racing publish cannot slip past).
    await expect(termsVersionStatement(env.DB, "2031-late", "2031-12-31T00:00:00.000Z").run()).rejects.toThrow(
      /published after the latest existing version/,
    );
  });

  it("text: the platform reads any version's; the seed has none until the text with its exact hash is attached; the seller reads the CURRENT one only", async () => {
    expect(await expectJson(await platformCall(world, "GET", `${VERSIONS_PATH}/${P}/text`), 200, "P text")).toEqual({
      publishedAt: P_AT,
      sha256: await sha256Hex(bytes(P_TEXT)),
      text: P_TEXT,
      textArchived: true,
      version: P,
    });
    expect(
      await expectJson(await platformCall(world, "GET", `${VERSIONS_PATH}/${CURRENT_TERMS_VERSION}/text`), 200, "seed text"),
    ).toEqual({
      publishedAt: "2026-09-07T00:00:00.000Z",
      sha256: SEED_SHA256,
      text: null,
      textArchived: false,
      version: CURRENT_TERMS_VERSION,
    });
    expect((await platformCall(world, "GET", `${VERSIONS_PATH}/no-such-version/text`)).status).toBe(404);

    // The seller's view of the CURRENT version (R) before its text is archived: said, not failed.
    expect(await expectJson(await adminCall(world, behindShop, "GET", "/v1/admin/legal/terms"), 200, "no text yet")).toEqual({
      publishedAt: rAt,
      sha256: rSha,
      text: null,
      textArchived: false,
      version: R,
    });

    // The seed: a text that does not hash to it is refused, and nothing is written.
    const wrong = "Inte den godkända texten.";
    expect(
      await expectJson(
        await platformCall(world, "PUT", `${VERSIONS_PATH}/${CURRENT_TERMS_VERSION}/text`, { text: wrong }),
        409,
        "seed mismatch",
      ),
    ).toEqual({
      error: { code: "terms_text_hash_mismatch", message: "The text does not hash to this version's stored SHA-256" },
      expectedSha256: SEED_SHA256,
      suppliedSha256: await sha256Hex(bytes(wrong)),
    });
    const seedRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_terms_texts WHERE version = ?")
      .bind(CURRENT_TERMS_VERSION)
      .first<{ n: number }>();
    expect(seedRows?.n).toBe(0);
    // …and the database refuses such a row outright.
    await expect(
      env.DB.prepare(
        `INSERT INTO platform_terms_texts (version, sha256, object_key, size_bytes, archived_by, archived_at)
         VALUES (?, ?, ?, 1, ?, '2026-09-27T00:00:00.000Z')`,
      )
        .bind(CURRENT_TERMS_VERSION, ZERO, `platform/legal/terms/${CURRENT_TERMS_VERSION}/${ZERO}.txt`, world.platformUserId)
        .run(),
    ).rejects.toThrow(/must hash to the version sha256/);

    // R's text, whose hash R already holds: archived once, then a replay.
    const attached = await expectJson<{ version: Record<string, unknown> }>(
      await platformCall(world, "PUT", `${VERSIONS_PATH}/${R}/text`, { text: R_TEXT }),
      201,
      "attach R",
    );
    expect(attached).toEqual({ version: { publishedAt: rAt, sha256: rSha, textArchived: true, version: R } });
    await expectJson(await platformCall(world, "PUT", `${VERSIONS_PATH}/${R}/text`, { text: R_TEXT }), 200, "again");
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'legal.platform_terms.archive_text' AND resource_id = ?",
    )
      .bind(R)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);

    // The seller now reads R — and only R: a query naming another version changes nothing.
    const current = { publishedAt: rAt, sha256: rSha, text: R_TEXT, textArchived: true, version: R };
    expect(await expectJson(await adminCall(world, behindShop, "GET", "/v1/admin/legal/terms"), 200, "terms")).toEqual(current);
    expect(
      await expectJson(await adminCall(world, behindShop, "GET", `/v1/admin/legal/terms?version=${P}`), 200, "terms?version"),
    ).toEqual(current);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await adminCall(world, behindShop, method, "/v1/admin/legal/terms", {})).status, method).toBe(404);
    }
    expect((await call(world, "GET", "https://admin.slice.test/v1/admin/legal/terms", {})).status, "no session").toBe(404);

    // Archived texts are evidence: append-only.
    await expect(env.DB.prepare("UPDATE platform_terms_texts SET size_bytes = size_bytes").run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM platform_terms_texts").run()).rejects.toThrow(/append-only/);
  });

  it("every platform route: no session, a tenant admin, a platform user acting as a shop → the opaque 404; cross-origin writes refused", async () => {
    await expectJson(
      await platformCall(world, "POST", `/v1/platform/tenants/${behindShop.tenantId}/acting-as`, { reason: "support" }),
      201,
      "acting-as grant",
    );
    const versionsBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_terms_versions").first<{ n: number }>();

    // [method, path, body, what the platform session itself gets]
    const routes: Array<[string, string, unknown, number]> = [
      ["GET", VERSIONS_PATH, undefined, 200],
      ["POST", VERSIONS_PATH, { version: "denied" }, 400],
      ["GET", `${VERSIONS_PATH}/${P}/text`, undefined, 200],
      ["PUT", `${VERSIONS_PATH}/${R}/text`, { text: R_TEXT }, 200],
    ];
    for (const [method, path, body, platformStatus] of routes) {
      const url = `${PLATFORM}${path}`;
      const callers: Array<[string, Promise<Response>]> = [
        ["no session", call(world, method, url, { body })],
        ["tenant admin", call(world, method, url, { body, cookie: behindShop.adminCookie })],
        ["tenant admin in its shop", call(world, method, url, { body, cookie: behindShop.adminCookie, shopId: behindShop.tenantId })],
        ["platform user acting as the shop", call(world, method, url, { body, cookie: world.platformCookie, shopId: behindShop.tenantId })],
      ];
      if (method !== "GET") {
        callers.push(["cross-origin", call(world, method, url, { body, cookie: world.platformCookie, origin: "https://evil.example.com" })]);
        callers.push(["no origin", call(world, method, url, { body, cookie: world.platformCookie, origin: null })]);
      }
      for (const [label, pending] of callers) {
        expect(await expectJson(await pending, 404, `${method} ${path} ${label}`)).toEqual(NOT_FOUND);
      }
      // The platform session reaches the handler (400 = its body was read and refused).
      expect((await call(world, method, url, { body, cookie: world.platformCookie })).status, `${method} ${path}`).toBe(
        platformStatus,
      );
    }
    // Methods a route does not own fall through to the ordinary 404.
    for (const [method, path] of [
      ["DELETE", VERSIONS_PATH],
      ["PUT", VERSIONS_PATH],
      ["POST", `${VERSIONS_PATH}/${R}/text`],
      ["HEAD", VERSIONS_PATH],
    ]) {
      expect((await call(world, method as string, `${PLATFORM}${path}`, { cookie: world.platformCookie })).status).toBe(404);
    }
    const versionsAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_terms_versions").first<{ n: number }>();
    expect(versionsAfter?.n, "nothing was published").toBe(versionsBefore?.n);
  });
});

// Last in the file: it schedules a version far in the future, after which no
// earlier publish time is accepted.
describe("the archived text is returned byte for byte", () => {
  it("a leading byte-order mark survives the round trip, so the text still hashes to its sha256 (Codex P2)", async () => {
    const text = "﻿# Plattformsvillkor\n\nText som lästs in från en fil med BOM.";
    const published = await expectJson<{ version: { sha256: string; version: string } }>(
      await platformCall(world, "POST", VERSIONS_PATH, {
        publishedAt: "2090-01-01T00:00:00.000Z",
        text,
        version: "2090-bom",
      }),
      201,
      "publish a text with a BOM",
    );
    const read = await expectJson<{ sha256: string; text: string }>(
      await platformCall(world, "GET", `${VERSIONS_PATH}/2090-bom/text`),
      200,
      "read it back",
    );
    expect(read.text).toBe(text);
    expect(read.text.charCodeAt(0)).toBe(0xfeff);
    expect(await sha256Hex(bytes(read.text))).toBe(read.sha256);
    expect(read.sha256).toBe(published.version.sha256);
  });
});
