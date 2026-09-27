import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PlatformPrincipal } from "../src/auth/live-authorization";
import { publishAdminProduct, updateAdminProduct } from "../src/catalog/admin-catalog";
import { getPublicProduct } from "../src/catalog/public-catalog";
import {
  addScreeningTerm,
  decideByPlatform,
  deleteScreeningTerm,
  readRescreenBacklog,
  rescreenStaleScreenings,
  termFromKey,
  termKeyOf,
  updateScreeningTerm,
} from "../src/catalog/screening";
import {
  findScreeningHits,
  isHardBlock,
  normalizeScreeningTerm,
  productScreeningTexts,
  sqlMatchTerms,
  termMatch,
} from "../src/catalog/screening-core";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  adminOf,
  catalogVersion,
  grantPlatformAdmin,
  grantTenantAdmin,
  PLATFORM,
  seedProduct,
  seedTenant,
  sessionRequest,
  signUp,
} from "./pod-fixtures";

/**
 * CP3-D — screening settings (review_first_products, the global hard block),
 * the blocklist routes, and how a blocklist change takes effect (migration
 * 0034, src/catalog/screening.ts). Every term here is invented.
 */

const PLATFORM_HOST = "https://platform.cp3d-screening.test";
const ADMIN_HOST = "https://admin.cp3d-screening.test";

let platformSession: { cookie: string; userId: string };
let adminSession: { cookie: string; userId: string };
let actor: PlatformPrincipal;

const ADMIN_SHOP = "tenant-cp3d-sc-admin";

function fetchApp(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

function platform(method: string, path: string, body?: unknown, extra: { origin?: string | null } = {}): Promise<Response> {
  return fetchApp(
    sessionRequest(`${PLATFORM_HOST}${path}`, method, {
      body,
      cookie: platformSession.cookie,
      ...extra,
    }),
  );
}

async function expectOpaque404(response: Response, label: string): Promise<void> {
  expect(response.status, label).toBe(404);
  await expect(response.json(), label).resolves.toEqual({
    error: { code: "not_found", message: "Route not found" },
  });
}

async function patchSettings(body: unknown): Promise<Record<string, unknown>> {
  const response = await platform("PATCH", "/v1/platform/settings", body);
  expect(response.status).toBe(200);
  return response.json();
}

async function addTerm(body: Record<string, unknown>): Promise<{
  rescreen: { blockedNow: number; pending: number; unverified: number };
  term: { hardBlock: boolean; kind: string; note: string | null; term: string; termKey: string };
}> {
  const response = await platform("POST", "/v1/platform/screening-terms", body);
  expect(response.status, JSON.stringify(body)).toBe(201);
  return response.json();
}

async function row(productId: string) {
  return env.DB.prepare(
    `SELECT status, reason, hits_json, earlier_hits_json, requires_approval, version,
            terms_version, screened_tokens, screened_raw
     FROM product_screening WHERE product_id = ?`,
  )
    .bind(productId)
    .first<{
      earlier_hits_json: string;
      hits_json: string;
      reason: string | null;
      requires_approval: number;
      screened_raw: string | null;
      screened_tokens: string | null;
      status: string;
      terms_version: number | null;
      version: number;
    }>();
}

async function termsVersion(): Promise<number> {
  const settings = await env.DB.prepare("SELECT screening_terms_version FROM platform_settings WHERE id = 1")
    .first<{ screening_terms_version: number }>();
  return settings?.screening_terms_version ?? 0;
}

function context(tenantId: string): TenantContext {
  return { domainKind: "storefront", hostname: `${tenantId}.cp3d-screening.test`, tenantId };
}

async function isPublic(tenantId: string, productId: string): Promise<boolean> {
  return (await getPublicProduct(env.DB, context(tenantId), productId)) !== null;
}

/** The storefront's own answer, over HTTP (the next request after a change). */
async function publicStatus(tenantId: string, productId: string): Promise<number> {
  const response = await fetchApp(
    new Request(`https://${tenantId}.cp3d-screening.test/v1/products/${productId}`),
  );
  return response.status;
}

/** A shop with two approved products: its later products are past D8 (N = 2). */
async function shopPastD8(tenantId: string): Promise<void> {
  await seedTenant(tenantId, `${tenantId}.cp3d-screening.test`);
  for (const suffix of ["one", "two"]) {
    const productId = `${tenantId}-anchor-${suffix}`;
    await seedProduct(tenantId, { name: `Anchor item ${suffix}`, productId });
    expect((await publishAdminProduct(env.DB, adminOf(tenantId), productId, Date.now())).status).toBe("ok");
    await decideByPlatform(env.DB, PLATFORM, productId, "approved", Date.now());
  }
}

async function publish(tenantId: string, productId: string, name: string): Promise<string | null> {
  await seedProduct(tenantId, { name, productId });
  const result = await publishAdminProduct(env.DB, adminOf(tenantId), productId, Date.now());
  expect(result.status).toBe("ok");
  return result.status === "ok" ? result.product.screeningStatus : null;
}

/**
 * A D1 handle whose batch() first lets something else commit — the
 * interleaving a real race produces (the same seam as screening.test.ts).
 */
function racingDb(onBatch: (attempt: number) => Promise<void>): { calls: () => number; db: D1Database } {
  let attempt = 0;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          attempt += 1;
          await onBatch(attempt);
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { calls: () => attempt, db };
}

beforeAll(async () => {
  platformSession = await signUp("cp3d-screening-platform@example.com");
  await grantPlatformAdmin(platformSession.userId);
  actor = { accountType: "platform_admin", userId: platformSession.userId };
  await seedTenant(ADMIN_SHOP, `${ADMIN_SHOP}.cp3d-screening.test`);
  adminSession = await signUp("cp3d-screening-admin@example.com");
  await grantTenantAdmin(adminSession.userId, ADMIN_SHOP);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO acting_as_grants (id, platform_user_id, tenant_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), platformSession.userId, ADMIN_SHOP, new Date(now).toISOString(), new Date(now + 3_600_000).toISOString())
    .run();
});

// ── the normalisation (pure) ────────────────────────────────────────────────

describe("term normalisation = the product-text normalisation (screening-core)", () => {
  it.each([
    ["  Glimmer   Kraft ", "glimmer kraft"],
    ["GLIMMER-KRAFT", "glimmer kraft"],
    ["Dräkkenhölm", "drakkenholm"],
    ["Snörvel/Bø", "snorvel bo"],
    ["Straßenwicht", "strassenwicht"],
    ["✪", "✪"],
    [" ✺ ", "✺"],
    ["✪/✪", "✪/✪"],
  ])("%j is stored as %j", (input, stored) => {
    expect(normalizeScreeningTerm(input)?.term).toBe(stored);
  });

  it.each([
    ["an empty term", ""],
    ["only whitespace", "   "],
    ["letters that all fold away (can never match)", "Ωμέγαζ"],
    ["a control character", "zor\u0000blax"],
    ["201 characters", "z".repeat(201)],
    ["a term that NFKD lengthens past 200", "ß".repeat(101)],
    ["a non-string", 42],
  ])("refuses %s", (_label, input) => {
    expect(normalizeScreeningTerm(input)).toBeNull();
  });

  it("a stored term matches exactly the texts its typed form matches", () => {
    const texts = [
      "Glimmer-Kraft mug",
      "glimmerkraft mug",
      "GLIMMER KRAFT",
      "Dräkkenhölm hoodie",
      "Drakkenholmen",
      "Star ✪ tee",
      "Snörvel/Bø cap",
    ];
    for (const typed of ["Glimmer-Kraft", "Dräkkenhölm", "✪", "Snörvel/Bø"]) {
      const stored = normalizeScreeningTerm(typed)?.term ?? "";
      for (const text of texts) {
        const hit = (term: string) =>
          findScreeningHits(productScreeningTexts({ description: null, name: text }), [
            { hardBlock: false, kind: "other", term },
          ]).length > 0;
        expect(hit(stored), `${typed} → ${stored} on ${text}`).toBe(hit(typed));
      }
    }
  });

  it("two spellings the matcher cannot tell apart share one key", () => {
    expect(termMatch("glimmer-kraft")?.key).toBe(termMatch("Glimmer Kraft")?.key);
    expect(termMatch("glimmerkraft")?.key).not.toBe(termMatch("glimmer kraft")?.key);
    expect(termMatch("✪")?.key).toBe("✪");
  });

  it("isHardBlock = Firebase screenProductOnWrite.ts:119", () => {
    const soft = { hardBlock: false, kind: "other", term: "zorblax" };
    const hard = { hardBlock: true, kind: "brand", term: "quillfeather" };
    expect(isHardBlock([soft], false)).toBe(false);
    expect(isHardBlock([soft], true)).toBe(true);
    expect(isHardBlock([soft, hard], false)).toBe(true);
    expect(isHardBlock([], true)).toBe(false);
  });

  it("the SQL list keeps the matcher's first entry per key and marks what blocks", () => {
    expect(
      sqlMatchTerms(
        [
          { hardBlock: false, kind: "other", term: "glimmer kraft" },
          { hardBlock: true, kind: "other", term: "glimmer-kraft" },
          { hardBlock: true, kind: "other", term: "✪" },
          { hardBlock: false, kind: "other", term: "Ωμέγαζ" },
        ],
        false,
      ),
    ).toEqual([
      { b: 0, k: " glimmer kraft ", r: "glimmer kraft", s: 0, t: "glimmer kraft" },
      { b: 1, k: "", r: "✪", s: 1, t: "✪" },
    ]);
    expect(sqlMatchTerms([{ hardBlock: false, kind: "other", term: "zorblax" }], true)[0]?.b).toBe(1);
  });

  it("a term's URL key is its canonical base64url, reversible for any term", () => {
    for (const term of ["zq/xv", "✪/✪", "glimmer kraft", "dräkkenhölm", "a?b#c%d"]) {
      const key = termKeyOf(term);
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(termFromKey(key)).toBe(term);
    }
    expect(termFromKey("")).toBeNull();
    expect(termFromKey("%%%")).toBeNull();
    expect(termFromKey("a")).toBeNull(); // not base64
    expect(termFromKey(`${termKeyOf("zorblax")}=`)).toBeNull(); // padding is not canonical
    expect(termFromKey("_w")).toBeNull(); // invalid UTF-8
  });
});

// ── who may call ───────────────────────────────────────────────────────────

describe("the screening routes — who may call", () => {
  const key = termKeyOf("authcheck");
  const routes: Array<[string, string, unknown]> = [
    ["GET", "/v1/platform/screening-terms", undefined],
    ["POST", "/v1/platform/screening-terms", { term: "authcheck" }],
    ["PATCH", `/v1/platform/screening-terms/${key}`, { note: "x" }],
    ["DELETE", `/v1/platform/screening-terms/${key}`, undefined],
    ["POST", "/v1/platform/screening-terms/rescreen", undefined],
  ];

  it.each(routes)("%s %s: anonymous, a tenant admin and a platform user acting as a shop get the opaque 404", async (method, path, body) => {
    const url = `${PLATFORM_HOST}${path}`;
    await expectOpaque404(
      await fetchApp(new Request(url, { body: body === undefined ? undefined : JSON.stringify(body), headers: { origin: PLATFORM_HOST }, method })),
      "anonymous",
    );
    await expectOpaque404(
      await fetchApp(sessionRequest(url, method, { body, cookie: adminSession.cookie, shopId: ADMIN_SHOP })),
      "tenant admin",
    );
    await expectOpaque404(
      await fetchApp(sessionRequest(url, method, { body, cookie: platformSession.cookie, shopId: ADMIN_SHOP })),
      "platform user acting as a shop",
    );
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM content_screening_terms WHERE term = 'authcheck'")
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it("the platform session reaches all five", async () => {
    expect((await platform("GET", "/v1/platform/screening-terms")).status).toBe(200);
    expect((await platform("POST", "/v1/platform/screening-terms", { term: "authcheck" })).status).toBe(201);
    expect((await platform("PATCH", `/v1/platform/screening-terms/${key}`, { note: "checked" })).status).toBe(200);
    expect((await platform("POST", "/v1/platform/screening-terms/rescreen")).status).toBe(200);
    expect((await platform("DELETE", `/v1/platform/screening-terms/${key}`)).status).toBe(200);
  });

  it("refuses a cross-origin or origin-less state change with the same 404", async () => {
    for (const origin of ["https://attacker.example.com", null]) {
      await expectOpaque404(
        await platform("POST", "/v1/platform/screening-terms", { term: "crossorigin" }, { origin }),
        `POST origin ${origin}`,
      );
      await expectOpaque404(await platform("POST", "/v1/platform/screening-terms/rescreen", undefined, { origin }), "rescreen");
    }
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM content_screening_terms WHERE term = 'crossorigin'")
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });
});

// ── review_first_products ──────────────────────────────────────────────────

describe("review_first_products drives D8", () => {
  afterAll(async () => {
    await patchSettings({ reviewFirstProducts: 2 });
  });

  it("N = 1: only the first product waits; after its approval the next is advisory", async () => {
    await patchSettings({ reviewFirstProducts: 1 });
    const tenant = "tenant-cp3d-rf1";
    await seedTenant(tenant, `${tenant}.cp3d-screening.test`);
    expect(await publish(tenant, "rf1-a", "Teapot a")).toBe("pending");
    await decideByPlatform(env.DB, PLATFORM, "rf1-a", "approved", Date.now());
    expect(await publish(tenant, "rf1-b", "Teapot b")).toBe("advisory");
    expect(await isPublic(tenant, "rf1-b")).toBe(true);
  });

  it("N = 3: two approvals are not enough; the third is", async () => {
    await patchSettings({ reviewFirstProducts: 3 });
    const tenant = "tenant-cp3d-rf3";
    await seedTenant(tenant, `${tenant}.cp3d-screening.test`);
    for (const id of ["a", "b", "c"]) {
      expect(await publish(tenant, `rf3-${id}`, `Kettle ${id}`)).toBe("pending");
    }
    await decideByPlatform(env.DB, PLATFORM, "rf3-a", "approved", Date.now());
    await decideByPlatform(env.DB, PLATFORM, "rf3-b", "approved", Date.now());
    expect(await publish(tenant, "rf3-d", "Kettle d")).toBe("pending");
    await decideByPlatform(env.DB, PLATFORM, "rf3-c", "approved", Date.now());
    expect(await publish(tenant, "rf3-e", "Kettle e")).toBe("advisory");
  });

  it("N = 0: a new shop's first product is public at once", async () => {
    await patchSettings({ reviewFirstProducts: 0 });
    const tenant = "tenant-cp3d-rf0";
    await seedTenant(tenant, `${tenant}.cp3d-screening.test`);
    expect(await publish(tenant, "rf0-a", "Ladle a")).toBe("advisory");
    expect(await row("rf0-a")).toMatchObject({ requires_approval: 0 });
    expect(await isPublic(tenant, "rf0-a")).toBe(true);
  });

  it("lowering N does not release a product already waiting (decided at its first screening)", async () => {
    await patchSettings({ reviewFirstProducts: 2 });
    const tenant = "tenant-cp3d-rfl";
    await seedTenant(tenant, `${tenant}.cp3d-screening.test`);
    expect(await publish(tenant, "rfl-a", "Whisk a")).toBe("pending");
    await patchSettings({ reviewFirstProducts: 0 });
    const edited = await updateAdminProduct(env.DB, adminOf(tenant), "rfl-a", { name: "Whisk a2" }, Date.now());
    expect(edited).toMatchObject({ product: { screeningStatus: "pending" }, status: "ok" });
    expect(await isPublic(tenant, "rfl-a")).toBe(false);
  });
});

// ── the global hard block ──────────────────────────────────────────────────

describe("the global hard block (Firebase: settings.hardBlock || a hard-block term)", () => {
  const tenant = "tenant-cp3d-gh";

  beforeAll(async () => {
    await shopPastD8(tenant);
    await addTerm({ kind: "other", term: "zorblax" });
  });

  it("off: a hit on a soft term is flagged and stays public (advisory)", async () => {
    expect(await publish(tenant, "gh-tee", "Zorblax tee")).toBe("flagged");
    expect(await publicStatus(tenant, "gh-tee")).toBe(200);
  });

  it("on: the same soft hit blocks — the switch takes the product down in its own batch", async () => {
    const before = await catalogVersion(tenant);
    const body = await patchSettings({ screeningHardBlock: true });
    expect(body.rescreen).toMatchObject({ blockedNow: 1 });
    expect(await row("gh-tee")).toMatchObject({ hits_json: '["zorblax"]', reason: "hard_block", status: "blocked" });
    expect(await catalogVersion(tenant)).toBeGreaterThan(before);
    expect(await publicStatus(tenant, "gh-tee")).toBe(404);
    // The machine agrees: nothing is left for the sweep on this row.
    expect((await row("gh-tee"))?.terms_version).toBe(await termsVersion());
  });

  it("on: a product published with a soft hit is blocked at once", async () => {
    expect(await publish(tenant, "gh-hoodie", "Zorblax hoodie")).toBe("blocked");
    expect(await publicStatus(tenant, "gh-hoodie")).toBe(404);
    // A clean product is untouched by the switch.
    expect(await publish(tenant, "gh-plain", "Plain hoodie")).toBe("advisory");
  });

  it("off again: a block whose hits did not change stays (the machine's unchanged-input branch); reinstating is the platform's approval", async () => {
    const body = await patchSettings({ screeningHardBlock: false });
    expect(body.rescreen).toMatchObject({ blockedNow: 0 });
    await rescreenStaleScreenings(env.DB, Date.now(), 100);
    expect((await row("gh-tee"))?.status).toBe("blocked");
    await decideByPlatform(env.DB, PLATFORM, "gh-tee", "approved", Date.now());
    expect(await publicStatus(tenant, "gh-tee")).toBe(200);
  });
});

// ── the term routes ────────────────────────────────────────────────────────

describe("the blocklist routes", () => {
  it("stores the normalised term with its defaults and URL key, audited without a tenant", async () => {
    const { term } = await addTerm({ term: "  Glimmer-KRAFT " });
    expect(term).toEqual({
      createdAt: expect.any(String),
      hardBlock: false,
      kind: "other",
      note: null,
      term: "glimmer kraft",
      termKey: termKeyOf("glimmer kraft"),
    });
    const audit = await env.DB.prepare(
      "SELECT tenant_id, actor_user_id, resource_id FROM audit_events WHERE action = 'screening.term_add' AND resource_id = ?",
    )
      .bind("glimmer kraft")
      .first();
    expect(audit).toEqual({ actor_user_id: platformSession.userId, resource_id: "glimmer kraft", tenant_id: null });
  });

  it("refuses a second spelling of the same term (409 duplicate_term), an imported raw form included", async () => {
    for (const spelling of ["glimmer kraft", "GLIMMER—KRAFT", "Glimmer Kraft"]) {
      const response = await platform("POST", "/v1/platform/screening-terms", { term: spelling });
      expect(response.status, spelling).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "duplicate_term" } });
    }
    // An importer writes Firebase's raw form verbatim.
    await env.DB.prepare(
      "INSERT INTO content_screening_terms (term, kind, hard_block, note, created_at) VALUES ('Dräkkenhölm', 'band', 0, '', ?)",
    )
      .bind(new Date().toISOString())
      .run();
    expect((await platform("POST", "/v1/platform/screening-terms", { term: "drakkenholm" })).status).toBe(409);
  });

  it.each([
    ["a term that can never match", { term: "Ωμέγαζ" }],
    ["an empty term", { term: "  " }],
    ["no term", { kind: "brand" }],
    ["an unknown kind", { kind: "logo", term: "fernwhisk" }],
    ["a non-boolean hardBlock", { hardBlock: "yes", term: "fernwhisk" }],
    ["a note over 500 characters", { note: "n".repeat(501), term: "fernwhisk" }],
    ["an unknown key", { severity: "high", term: "fernwhisk" }],
  ])("refuses %s (400)", async (_label, body) => {
    expect((await platform("POST", "/v1/platform/screening-terms", body)).status).toBe(400);
  });

  it("stores a symbol term raw, and addresses a term containing '/' by its key", async () => {
    const { term } = await addTerm({ hardBlock: false, kind: "other", note: "a symbol", term: "✪/✪" });
    expect(term.term).toBe("✪/✪");
    const patched = await platform("PATCH", `/v1/platform/screening-terms/${term.termKey}`, { kind: "brand" });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({ term: { kind: "brand", note: "a symbol", term: "✪/✪" } });
    expect((await platform("DELETE", `/v1/platform/screening-terms/${term.termKey}`)).status).toBe(200);
  });

  it("kind and note are cosmetic: no version move; hardBlock is screening input: the version moves", async () => {
    const key = termKeyOf("glimmer kraft");
    const before = await termsVersion();
    const cosmetic = await platform("PATCH", `/v1/platform/screening-terms/${key}`, { kind: "brand", note: "why it is written in full" });
    expect(cosmetic.status).toBe(200);
    await expect(cosmetic.json()).resolves.toMatchObject({
      rescreen: { blockedNow: 0 },
      term: { kind: "brand", note: "why it is written in full" },
    });
    expect(await termsVersion()).toBe(before);
    expect((await platform("PATCH", `/v1/platform/screening-terms/${key}`, { note: null })).status).toBe(200);
    expect((await platform("PATCH", `/v1/platform/screening-terms/${key}`, { hardBlock: true })).status).toBe(200);
    expect(await termsVersion()).toBe(before + 1);
    expect((await platform("PATCH", `/v1/platform/screening-terms/${key}`, { hardBlock: false })).status).toBe(200);
  });

  it("PATCH refuses a rename and bad keys; unknown terms are 404", async () => {
    const key = termKeyOf("glimmer kraft");
    expect((await platform("PATCH", `/v1/platform/screening-terms/${key}`, { term: "other" })).status).toBe(400);
    expect((await platform("PATCH", `/v1/platform/screening-terms/${key}`, {})).status).toBe(400);
    expect((await platform("PATCH", `/v1/platform/screening-terms/${termKeyOf("nosuchterm")}`, { note: "x" })).status).toBe(404);
    expect((await platform("PATCH", "/v1/platform/screening-terms/%25%25", { note: "x" })).status).toBe(404);
    expect((await platform("DELETE", `/v1/platform/screening-terms/${termKeyOf("glimmer kraft")}=`)).status).toBe(404);
    expect((await platform("DELETE", `/v1/platform/screening-terms/${termKeyOf("nosuchterm")}`)).status).toBe(404);
  });

  it("lists terms in term order with a cursor", async () => {
    for (const term of ["listaaa", "listbbb", "listccc"]) {
      await addTerm({ term });
    }
    const all: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const response = await platform("GET", `/v1/platform/screening-terms?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      expect(response.status).toBe(200);
      const body = await response.json<{ nextCursor: string | null; terms: Array<{ term: string }>; termsVersion: number }>();
      expect(body.terms.length).toBeLessThanOrEqual(2);
      expect(body.termsVersion).toBe(await termsVersion());
      all.push(...body.terms.map((entry) => entry.term));
      cursor = body.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(all).toEqual([...all].sort());
    expect(all).toEqual(expect.arrayContaining(["listaaa", "listbbb", "listccc", "glimmer kraft", "Dräkkenhölm"]));
    for (const query of ["limit=0", "limit=501", "limit=x", "cursor=%25", "cursor=a", "sort=term"]) {
      expect((await platform("GET", `/v1/platform/screening-terms?${query}`)).status, query).toBe(400);
    }
  });

  it("deletes a term (audited) and a second delete is 404", async () => {
    const key = termKeyOf("listccc");
    const response = await platform("DELETE", `/v1/platform/screening-terms/${key}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ deleted: true, rescreen: { blockedNow: 0 } });
    expect((await platform("DELETE", `/v1/platform/screening-terms/${key}`)).status).toBe(404);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'screening.term_delete' AND resource_id = 'listccc' AND tenant_id IS NULL",
    ).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });
});

// ── a term change takes effect ─────────────────────────────────────────────

describe("a blocklist change takes effect (PLAN §2.4)", () => {
  const tenant = "tenant-cp3d-tc";

  beforeAll(async () => {
    await shopPastD8(tenant);
  });

  it("a HARD term added: a product that was public is blocked in the change's own batch, the next request 404s", async () => {
    expect(await publish(tenant, "tc-mug", "Quillfeather mug")).toBe("advisory");
    expect(await publish(tenant, "tc-plain", "Plain mug")).toBe("advisory");
    expect(await publicStatus(tenant, "tc-mug")).toBe(200);
    const before = await catalogVersion(tenant);

    const { rescreen } = await addTerm({ hardBlock: true, kind: "brand", term: "Quillfeather" });

    expect(rescreen.blockedNow).toBe(1);
    expect(await row("tc-mug")).toMatchObject({
      earlier_hits_json: "[]",
      hits_json: '["quillfeather"]',
      reason: "hard_block",
      status: "blocked",
    });
    expect(await publicStatus(tenant, "tc-mug")).toBe(404);
    expect(await catalogVersion(tenant)).toBeGreaterThan(before);
    // Both verdicts are current under the new term set: nothing waits for the sweep.
    const version = await termsVersion();
    expect((await row("tc-mug"))?.terms_version).toBe(version);
    expect(await row("tc-plain")).toMatchObject({ status: "advisory", terms_version: version });
    expect(await publicStatus(tenant, "tc-plain")).toBe(200);
  });

  it("a SOFT term added: nothing is blocked; the affected verdict is stale until the sweep flags it (still public)", async () => {
    expect(await publish(tenant, "tc-cap", "Snörvel cap")).toBe("advisory");
    const { rescreen } = await addTerm({ term: "snorvel" });
    expect(rescreen.blockedNow).toBe(0);
    expect(rescreen.pending).toBeGreaterThanOrEqual(1);
    expect((await row("tc-cap"))?.status).toBe("advisory");
    expect((await row("tc-cap"))?.terms_version).toBeLessThan(await termsVersion());
    expect(await publicStatus(tenant, "tc-cap")).toBe(200);

    const swept = await platform("POST", "/v1/platform/screening-terms/rescreen");
    expect(swept.status).toBe(200);
    await expect(swept.json()).resolves.toMatchObject({ rescreened: expect.any(Number) });
    for (let round = 0; round < 10 && (await readRescreenBacklog(env.DB)).pending > 0; round += 1) {
      await rescreenStaleScreenings(env.DB, Date.now());
    }
    expect(await row("tc-cap")).toMatchObject({ hits_json: '["snorvel"]', status: "flagged", terms_version: await termsVersion() });
    expect(await publicStatus(tenant, "tc-cap")).toBe(200);
  });

  it("making a term hard blocks what it flags; an approval that already saw the term sticks (Firebase parity)", async () => {
    expect(await publish(tenant, "tc-bag", "Snörvel Bagzilla bag")).toBe("flagged");
    await decideByPlatform(env.DB, PLATFORM, "tc-bag", "approved", Date.now());
    const approvedHits = (await row("tc-bag"))?.hits_json;
    expect(approvedHits).toBe('["snorvel"]');

    const response = await platform("PATCH", `/v1/platform/screening-terms/${termKeyOf("snorvel")}`, { hardBlock: true });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ rescreen: { blockedNow: 1 } });
    expect((await row("tc-cap"))?.status).toBe("blocked");
    expect(await publicStatus(tenant, "tc-cap")).toBe(404);
    expect(await row("tc-bag")).toMatchObject({ status: "approved" });
    expect(await publicStatus(tenant, "tc-bag")).toBe(200);
  });

  it("…but a hard term the approval never saw blocks it", async () => {
    const { rescreen } = await addTerm({ hardBlock: true, term: "bagzilla" });
    expect(rescreen.blockedNow).toBe(1);
    expect(await row("tc-bag")).toMatchObject({
      hits_json: '["bagzilla","snorvel"]',
      reason: "hard_block",
      status: "blocked",
    });
    expect(await publicStatus(tenant, "tc-bag")).toBe(404);
  });

  it("a hard SYMBOL term is matched on the raw text", async () => {
    expect(await publish(tenant, "tc-poster", "Star ✺ poster")).toBe("advisory");
    const { rescreen } = await addTerm({ hardBlock: true, term: "✺" });
    expect(rescreen.blockedNow).toBe(1);
    expect(await row("tc-poster")).toMatchObject({ hits_json: '["✺"]', status: "blocked" });
  });

  it("parity: the full machine, re-run on every verdict the SQL just wrote, changes nothing", async () => {
    const ids = ["tc-mug", "tc-plain", "tc-cap", "tc-bag", "tc-poster"];
    const before = await Promise.all(ids.map(row));
    await env.DB.prepare(
      `UPDATE product_screening SET terms_version = NULL WHERE product_id IN (${ids.map(() => "?").join(", ")})`,
    )
      .bind(...ids)
      .run();
    for (let round = 0; round < 20 && (await readRescreenBacklog(env.DB)).pending > 0; round += 1) {
      await rescreenStaleScreenings(env.DB, Date.now());
    }
    const after = await Promise.all(ids.map(row));
    after.forEach((entry, index) => {
      expect(
        { earlier: entry?.earlier_hits_json, hits: entry?.hits_json, reason: entry?.reason, status: entry?.status },
        ids[index],
      ).toEqual({
        earlier: before[index]?.earlier_hits_json,
        hits: before[index]?.hits_json,
        reason: before[index]?.reason,
        status: before[index]?.status,
      });
    });
  });

  it("a term removed: the block is not lifted in SQL (fail closed); the sweep re-screens it to flagged (a human still looks)", async () => {
    const response = await platform("DELETE", `/v1/platform/screening-terms/${termKeyOf("quillfeather")}`);
    expect(response.status).toBe(200);
    expect((await row("tc-mug"))?.status).toBe("blocked");
    expect((await row("tc-mug"))?.terms_version).toBeLessThan(await termsVersion());
    for (let round = 0; round < 10 && (await readRescreenBacklog(env.DB)).pending > 0; round += 1) {
      await rescreenStaleScreenings(env.DB, Date.now());
    }
    expect(await row("tc-mug")).toMatchObject({
      earlier_hits_json: '["quillfeather"]',
      hits_json: "[]",
      status: "flagged",
    });
    expect(await publicStatus(tenant, "tc-mug")).toBe(200);
  });

  it("the sweep is bounded per call", async () => {
    await addTerm({ term: "boundcheck" });
    await env.DB.prepare(
      "UPDATE product_screening SET terms_version = NULL WHERE tenant_id = ?",
    )
      .bind(tenant)
      .run();
    const pending = (await readRescreenBacklog(env.DB)).pending;
    expect(pending).toBeGreaterThan(2);
    const one = await rescreenStaleScreenings(env.DB, Date.now(), 1);
    expect(one.rescreened).toBe(1);
    expect(one.pending).toBe(pending - 1);
  });
});

// ── the terms fence ────────────────────────────────────────────────────────

describe("the terms fence: a product mutation racing a blocklist change", () => {
  const tenant = "tenant-cp3d-race";

  beforeAll(async () => {
    await shopPastD8(tenant);
  });

  it("an edit whose verdict was computed before a hard term landed is re-run, and blocked", async () => {
    expect(await publish(tenant, "race-vase", "Calm vase")).toBe("advisory");
    const racing = racingDb(async (attempt) => {
      if (attempt === 1) {
        const added = await addScreeningTerm(env.DB, actor, { hardBlock: true, kind: "other", note: null, term: "moonwhistle" }, Date.now());
        expect(added.status).toBe("ok");
      }
    });
    const result = await updateAdminProduct(racing.db, adminOf(tenant), "race-vase", { name: "Moonwhistle vase" }, Date.now());

    // Without the fence the edit committed 'advisory' under the old term set
    // while the term's own SQL check had run over the OLD name.
    expect(result).toMatchObject({ product: { name: "Moonwhistle vase", screeningStatus: "blocked" }, status: "ok" });
    expect(racing.calls()).toBe(2);
    expect(await row("race-vase")).toMatchObject({ hits_json: '["moonwhistle"]', status: "blocked" });
    expect(await isPublic(tenant, "race-vase")).toBe(false);
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = 'race-vase' AND action = 'product.update'",
    ).first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it("a FIRST publish racing a hard term is re-run, and blocked", async () => {
    await seedProduct(tenant, { name: "Duskmoth lamp", productId: "race-lamp" });
    const racing = racingDb(async (attempt) => {
      if (attempt === 1) {
        await addScreeningTerm(env.DB, actor, { hardBlock: true, kind: "other", note: null, term: "duskmoth" }, Date.now());
      }
    });
    const result = await publishAdminProduct(racing.db, adminOf(tenant), "race-lamp", Date.now());
    expect(result).toMatchObject({ product: { screeningStatus: "blocked" }, status: "ok" });
    expect(await isPublic(tenant, "race-lamp")).toBe(false);
  });

  it("the trigger itself refuses a verdict stamped with a stale term version", async () => {
    const current = await termsVersion();
    await expect(
      env.DB.prepare("UPDATE product_screening SET terms_version = ? WHERE product_id = 'race-vase'")
        .bind(current - 1)
        .run(),
    ).rejects.toThrow(/screening terms changed/);
  });

  it("two term changes racing: the loser is re-planned from fresh reads and both land", async () => {
    const racing = racingDb(async (attempt) => {
      if (attempt === 1) {
        await addScreeningTerm(env.DB, actor, { hardBlock: false, kind: "other", note: null, term: "racerone" }, Date.now());
      }
    });
    const result = await addScreeningTerm(racing.db, actor, { hardBlock: false, kind: "other", note: null, term: "racertwo" }, Date.now());
    expect(result.status).toBe("ok");
    expect(racing.calls()).toBe(2);
    const stored = await env.DB.prepare(
      "SELECT term FROM content_screening_terms WHERE term IN ('racerone', 'racertwo') ORDER BY term",
    ).all<{ term: string }>();
    expect(stored.results.map((entry) => entry.term)).toEqual(["racerone", "racertwo"]);
  });

  it("a note-only edit racing a hardBlock change writes the note and leaves the flag alone (Codex P1)", async () => {
    await addScreeningTerm(env.DB, actor, { hardBlock: false, kind: "other", note: null, term: "racerflag" }, Date.now());
    const versionBefore = (
      await env.DB.prepare("SELECT screening_terms_version AS v FROM platform_settings WHERE id = 1").first<{ v: number }>()
    )?.v;

    // The note edit has read the term (hardBlock false); before its batch
    // commits, another operator makes the term blocking.
    const racing = racingDb(async (attempt) => {
      if (attempt === 1) {
        const flagged = await updateScreeningTerm(env.DB, actor, "racerflag", { hardBlock: true }, Date.now());
        expect(flagged.status).toBe("ok");
      }
    });
    const noted = await updateScreeningTerm(racing.db, actor, "racerflag", { note: "checked with legal" }, Date.now());
    expect(noted.status).toBe("ok");

    await expect(
      env.DB.prepare("SELECT hard_block, note FROM content_screening_terms WHERE term = 'racerflag'").first(),
    ).resolves.toEqual({ hard_block: 1, note: "checked with legal" });
    // Only the hardBlock change moved the version: the note edit is cosmetic.
    const versionAfter = (
      await env.DB.prepare("SELECT screening_terms_version AS v FROM platform_settings WHERE id = 1").first<{ v: number }>()
    )?.v;
    expect(versionAfter).toBe((versionBefore ?? 0) + 1);
  });

  it("a note edit of a term deleted meanwhile writes nothing and audits nothing", async () => {
    await addScreeningTerm(env.DB, actor, { hardBlock: false, kind: "other", note: null, term: "racergone" }, Date.now());
    const audits = async () =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'screening.term_update' AND resource_id = 'racergone'",
        ).first<{ n: number }>()
      )?.n;
    const racing = racingDb(async (attempt) => {
      if (attempt === 1) {
        await deleteScreeningTerm(env.DB, actor, "racergone", Date.now());
      }
    });
    const result = await updateScreeningTerm(racing.db, actor, "racergone", { note: "too late" }, Date.now());
    expect(result.status).toBe("not_found");
    expect(await audits()).toBe(0);
  });
});

// ── what the term change cannot see ────────────────────────────────────────

describe("the limits, counted rather than silent", () => {
  const tenant = "tenant-cp3d-unv";

  beforeAll(async () => {
    await shopPastD8(tenant);
    // Earlier suites leave stale verdicts; drain them so this suite's row is
    // the sweep's only work.
    for (let round = 0; round < 20 && (await readRescreenBacklog(env.DB)).pending > 0; round += 1) {
      await rescreenStaleScreenings(env.DB, Date.now());
    }
    expect((await readRescreenBacklog(env.DB)).pending).toBe(0);
  });

  it("a row without stored text (written before 0034) is not checked in SQL, is counted, and the sweep screens it first", async () => {
    expect(await publish(tenant, "unv-old", "Fernwhisk spoon")).toBe("advisory");
    await env.DB.prepare(
      "UPDATE product_screening SET screened_tokens = NULL, screened_raw = NULL, terms_version = NULL WHERE product_id = 'unv-old'",
    ).run();
    const before = await readRescreenBacklog(env.DB);
    const { rescreen } = await addTerm({ hardBlock: true, term: "fernwhisk" });
    expect(rescreen.blockedNow).toBe(0);
    expect(rescreen.unverified).toBe(before.unverified);
    expect(before.unverified).toBeGreaterThanOrEqual(1);
    expect((await row("unv-old"))?.status).toBe("advisory");

    const swept = await rescreenStaleScreenings(env.DB, Date.now(), 1);
    expect(swept.rescreened).toBe(1);
    expect(await row("unv-old")).toMatchObject({ hits_json: '["fernwhisk"]', status: "blocked" });
    expect((await row("unv-old"))?.screened_tokens).toContain(" fernwhisk ");
  });

  it("the stored text admits the largest supported product, and is refused beyond the cap, never truncated (Codex P2)", async () => {
    // 700 artworks with 100-character file names: over 70 000 characters.
    const large = " fernwhisk ".padEnd(70_000, "a");
    await env.DB.prepare(
      "UPDATE product_screening SET screened_tokens = ?, screened_raw = ? WHERE product_id = 'unv-old'",
    ).bind(large, large).run();
    expect((await row("unv-old"))?.screened_tokens?.length).toBe(70_000);

    await expect(
      env.DB.prepare("UPDATE product_screening SET screened_tokens = ? WHERE product_id = 'unv-old'")
        .bind("a".repeat(524_289))
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    expect((await row("unv-old"))?.screened_tokens?.length).toBe(70_000);
  });

  it("a live product with NO screening row is outside the path: counted as unverified", async () => {
    const before = await readRescreenBacklog(env.DB);
    await seedProduct(tenant, { name: "Fernwhisk fork", productId: "unv-norow", published: true });
    const after = await readRescreenBacklog(env.DB);
    expect(after.unverified).toBe(before.unverified + 1);
    expect(await row("unv-norow")).toBeNull();
    // THE documented gap: the predicate admits a row-less product as advisory,
    // so it is public although the hard term matches its name. The sweep does
    // not screen row-less products (a first screening would apply D8 to it).
    expect(await isPublic(tenant, "unv-norow")).toBe(true);
    expect((await rescreenStaleScreenings(env.DB, Date.now())).unverified).toBe(after.unverified);
  });
});

// ── tenant-facing responses ────────────────────────────────────────────────

describe("nothing of this reaches a tenant or the storefront", () => {
  const DENIED = ["screened", "termsversion", "hardblock", "reviewfirst", "commission", "blocklist", "termkey"];

  function expectClean(value: unknown, path = "$"): void {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => expectClean(entry, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      expect(DENIED.find((part) => key.toLowerCase().includes(part)), `${path}.${key}`).toBeUndefined();
      expectClean(entry, `${path}.${key}`);
    }
  }

  it("admin product create/edit/publish and the public reads", async () => {
    const admin = (method: string, path: string, body?: unknown) =>
      fetchApp(sessionRequest(`${ADMIN_HOST}${path}`, method, { body, cookie: adminSession.cookie, shopId: ADMIN_SHOP }));
    const created = await admin("POST", "/v1/admin/products", {
      currency: "SEK",
      description: null,
      name: "Walkcheck tee",
      priceMinor: 19_900,
      sku: "SKU-WALKCHECK",
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json<{ product: { productId: string } }>();
    expectClean(createdBody);
    const id = createdBody.product.productId;
    const edited = await admin("PATCH", `/v1/admin/products/${id}`, { status: "active" });
    expectClean(await edited.json());
    const published = await admin("POST", `/v1/admin/products/${id}/publish`);
    expect(published.status).toBe(200);
    expectClean(await published.json());
    const list = await fetchApp(new Request(`https://${ADMIN_SHOP}.cp3d-screening.test/v1/products`));
    expectClean(await list.json());
    const storefront = await fetchApp(new Request(`https://${ADMIN_SHOP}.cp3d-screening.test/v1/storefront`));
    expectClean(await storefront.json());
  });
});
