import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ACCEPT_PAGES_LIMIT,
  canonicalJson,
  canonicalTexts,
  hasLegalPagesAcceptance,
  isLegallyReady,
  LEGAL_TEXTS_MAX_BYTES,
} from "../src/legal/legal-pages";
import { BUYER_CONSENT, LEGAL_TEXTS, LEGAL_TEXTS_CANONICAL, LEGAL_TEXTS_SHA256 } from "./legal-fixtures";
import {
  ADMIN,
  adminCall,
  approveProduct,
  bootstrapPlatform,
  call,
  createPlainProduct,
  createTenant,
  expectJson,
  platformCall,
  publishProduct,
  sha256Hex,
  SliceWorld,
  storefrontCall,
  type Tenant,
  unique,
} from "./slice-harness";

/**
 * CP3-E — the seller ADOPTING its shop's consumer-facing legal pages
 * (migrations/0037 legal_acceptances, type legalPages; Firebase
 * src/utils/legalAcceptance.js recordLegalAcceptance).
 *
 *   - one append-only evidence row per adoption: who, when (server clock),
 *     template version, the POD and custom flags, ip, user agent, and the
 *     texts in CANONICAL form with their SHA-256 — the importer's hash;
 *   - only the shop's own admin adopts (never a platform user acting as it);
 *   - the snapshot is capped at 256 KiB of canonical UTF-8.
 */

const world = new SliceWorld();
let shopA: Tenant;
let shopB: Tenant;

const PAGES = "/v1/admin/legal/pages";
const ACCEPT = "/v1/admin/legal/accept-pages";
const NOT_FOUND = { error: { code: "not_found", message: "Route not found" } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeAll(async () => {
  await bootstrapPlatform(world);
  shopA = await createTenant(world, { legallyReady: false, host: "pages-a.example.com", shopName: "Sidor A", tenantId: "pages-a" });
  shopB = await createTenant(world, { legallyReady: false, host: "pages-b.example.com", shopName: "Sidor B", tenantId: "pages-b" });
}, 60_000);

beforeEach(() => {
  world.reset();
});

function adoption(texts: Record<string, unknown> = LEGAL_TEXTS, overrides: Record<string, unknown> = {}) {
  return { custom: false, pod: true, templateVersion: "2026-09-07", texts, ...overrides };
}

async function rowCount(tenantId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM legal_acceptances WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("adopting the legal pages", () => {
  it("none before; the admin adopts; the row is the evidence, with an audit row; the read shows the latest", async () => {
    expect(await expectJson(await adminCall(world, shopA, "GET", PAGES), 200, "none")).toEqual({ acceptance: null });
    expect(await hasLegalPagesAcceptance(env.DB, shopA.tenantId)).toBe(false);

    const created = await expectJson<{ acceptance: { acceptanceId: string; acceptedAt: string } }>(
      await call(world, "POST", `${ADMIN}${ACCEPT}`, {
        body: adoption(),
        cookie: shopA.adminCookie,
        headers: { "user-agent": "Mozilla/5.0 (Test Seller)" },
        shopId: shopA.tenantId,
      }),
      201,
      "adopt",
    );
    expect(created).toEqual({
      acceptance: {
        acceptanceId: expect.stringMatching(UUID),
        acceptedAt: expect.stringMatching(ISO),
        custom: false,
        customPages: null,
        pod: true,
        templateVersion: "2026-09-07",
        textsSha256: LEGAL_TEXTS_SHA256,
      },
    });
    const { acceptanceId, acceptedAt } = created.acceptance;

    const row = await env.DB.prepare("SELECT * FROM legal_acceptances WHERE acceptance_id = ?").bind(acceptanceId).first();
    expect(row).toEqual({
      acceptance_id: acceptanceId,
      accepted_at: acceptedAt,
      accepted_at_original: null,
      custom_json: null,
      email: "admin@pages-a.example.com",
      ip: expect.stringMatching(/^203\.0\./),
      is_custom: 0,
      is_pod: 1,
      legacy_uid: null,
      source: "worker",
      template_version: "2026-09-07",
      tenant_id: shopA.tenantId,
      texts_json: LEGAL_TEXTS_CANONICAL,
      texts_sha256: LEGAL_TEXTS_SHA256,
      type: "legalPages",
      user_agent: "Mozilla/5.0 (Test Seller)",
      user_id: shopA.adminUserId,
      version: null,
    });
    const audit = await env.DB.prepare(
      "SELECT actor_user_id, resource_id FROM audit_events WHERE tenant_id = ? AND action = 'legal.pages.accept'",
    )
      .bind(shopA.tenantId)
      .all();
    expect(audit.results).toEqual([{ actor_user_id: shopA.adminUserId, resource_id: acceptanceId }]);

    expect(await expectJson(await adminCall(world, shopA, "GET", PAGES), 200, "read")).toEqual({
      acceptance: {
        acceptanceId,
        acceptedAt,
        custom: false,
        customPages: null,
        pageSha256: {
          angerratt: await sha256Hex(new TextEncoder().encode(LEGAL_TEXTS.angerratt)),
          integritetspolicy: await sha256Hex(new TextEncoder().encode(LEGAL_TEXTS.integritetspolicy)),
          kopvillkor: await sha256Hex(new TextEncoder().encode(LEGAL_TEXTS.kopvillkor)),
        },
        pod: true,
        source: "worker",
        templateVersion: "2026-09-07",
        textsSha256: LEGAL_TEXTS_SHA256,
        version: null,
      },
    });
    expect(await hasLegalPagesAcceptance(env.DB, shopA.tenantId)).toBe(true);
    expect(await hasLegalPagesAcceptance(env.DB, shopB.tenantId)).toBe(false);
  });

  it("the canonical hash is the importer's: a known-answer vector, stable under key reordering", async () => {
    expect(canonicalJson(LEGAL_TEXTS)).toBe(LEGAL_TEXTS_CANONICAL);
    expect(await canonicalTexts(LEGAL_TEXTS)).toEqual({
      json: LEGAL_TEXTS_CANONICAL,
      sha256: LEGAL_TEXTS_SHA256,
      sizeBytes: new TextEncoder().encode(LEGAL_TEXTS_CANONICAL).byteLength,
    });
    // Nested objects, arrays and integer-like keys, pinned against the
    // importer's canonicalStringify under Node: ECMAScript emits "9" before "10".
    const nested = canonicalJson({ b: { d: 1, c: [{ z: 1, y: 2 }] }, a: "x", "10": "t", "9": "n" });
    expect(nested).toBe('{"9":"n","10":"t","a":"x","b":{"c":[{"y":2,"z":1}],"d":1}}');
    expect(await sha256Hex(new TextEncoder().encode(nested))).toBe(
      "a9d477f63076cf671582c858e0091d310cf70aeca57cd30ec028d6d99484e966",
    );

    // Through the route, with the pages AND the body's keys in another order.
    const reordered = {
      texts: {
        integritetspolicy: LEGAL_TEXTS.integritetspolicy,
        kopvillkor: LEGAL_TEXTS.kopvillkor,
        angerratt: LEGAL_TEXTS.angerratt,
      },
      templateVersion: "2026-09-07",
      pod: false,
      custom: true,
    };
    const created = await expectJson<{ acceptance: { acceptanceId: string; textsSha256: string } }>(
      await adminCall(world, shopA, "POST", ACCEPT, reordered),
      201,
      "reordered",
    );
    expect(created.acceptance.textsSha256).toBe(LEGAL_TEXTS_SHA256);
    const row = await env.DB.prepare("SELECT texts_json, is_pod, is_custom FROM legal_acceptances WHERE acceptance_id = ?")
      .bind(created.acceptance.acceptanceId)
      .first();
    expect(row).toEqual({ is_custom: 1, is_pod: 0, texts_json: LEGAL_TEXTS_CANONICAL });

    // Every adoption is new evidence; the read answers with the latest.
    expect(await rowCount(shopA.tenantId)).toBe(2);
    const latest = await expectJson<{ acceptance: { acceptanceId: string; custom: boolean; pod: boolean } }>(
      await adminCall(world, shopA, "GET", PAGES),
      200,
      "latest",
    );
    expect(latest.acceptance).toMatchObject({ acceptanceId: created.acceptance.acceptanceId, custom: true, pod: false });
  });

  it("the snapshot cap is 262144 canonical UTF-8 bytes: exactly the cap is kept, one byte more is a 413", async () => {
    expect(LEGAL_TEXTS_MAX_BYTES).toBe(262_144);
    const texts = (pad: string) => ({ angerratt: "A", integritetspolicy: "B", kopvillkor: pad });
    const overhead = new TextEncoder().encode(canonicalJson(texts(""))).byteLength;
    const atCap = texts("x".repeat(LEGAL_TEXTS_MAX_BYTES - overhead));
    expect(new TextEncoder().encode(canonicalJson(atCap)).byteLength).toBe(LEGAL_TEXTS_MAX_BYTES);

    const before = await rowCount(shopA.tenantId);
    await expectJson(await adminCall(world, shopA, "POST", ACCEPT, adoption(atCap)), 201, "at the cap");
    const tooLarge = { error: { code: "payload_too_large", message: "The texts exceed the maximum allowed size" } };
    const overCap = texts("x".repeat(LEGAL_TEXTS_MAX_BYTES - overhead + 1));
    expect(await expectJson(await adminCall(world, shopA, "POST", ACCEPT, adoption(overCap)), 413, "one over")).toEqual(
      tooLarge,
    );
    // Bytes, not characters: 131 083 "å" are under the cap in characters, over it in UTF-8.
    const wide = texts("å".repeat(LEGAL_TEXTS_MAX_BYTES / 2 + 10));
    expect((await adminCall(world, shopA, "POST", ACCEPT, adoption(wide))).status).toBe(413);
    // A body over 1 MiB is refused before it is parsed.
    const huge = texts("x".repeat(1_100_000));
    expect(await expectJson(await adminCall(world, shopA, "POST", ACCEPT, adoption(huge)), 413, "huge body")).toEqual(tooLarge);
    expect(await rowCount(shopA.tenantId)).toBe(before + 1);

    // The database holds the cap too.
    await expect(
      env.DB.prepare(
        `INSERT INTO legal_acceptances (acceptance_id, tenant_id, type, user_id, accepted_at, texts_json, texts_sha256, source)
         VALUES ('over-cap', ?, 'legalPages', ?, '2026-09-27T00:00:00.000Z', ?, ?, 'worker')`,
      )
        .bind(shopA.tenantId, shopA.adminUserId, canonicalJson(overCap), "0".repeat(64))
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("a strict body: anything but { templateVersion, texts: the three pages, pod, custom } is a 400 and writes nothing", async () => {
    const before = await rowCount(shopA.tenantId);
    const bodies: unknown[] = [
      {},
      null,
      [adoption()],
      { ...adoption(), extra: true },
      { custom: false, pod: true, templateVersion: "2026-09-07" },
      adoption({ angerratt: "A", kopvillkor: "K" }),
      adoption({ ...LEGAL_TEXTS, villkor: "V" }),
      adoption({ ...LEGAL_TEXTS, angerratt: "" }),
      adoption({ ...LEGAL_TEXTS, angerratt: 7 }),
      adoption([LEGAL_TEXTS] as unknown as Record<string, unknown>),
      adoption(LEGAL_TEXTS, { pod: "yes" }),
      adoption(LEGAL_TEXTS, { custom: null }),
      adoption(LEGAL_TEXTS, { templateVersion: "a b" }),
      adoption(LEGAL_TEXTS, { templateVersion: "x".repeat(33) }),
    ];
    for (const body of bodies) {
      const response = await adminCall(world, shopA, "POST", ACCEPT, body);
      expect(await expectJson(response, 400, JSON.stringify(body)?.slice(0, 80) ?? "undefined")).toEqual({
        error: { code: "invalid_request", message: "Request is not valid" },
      });
    }
    const notJson = await call(world, "POST", `${ADMIN}${ACCEPT}`, {
      cookie: shopA.adminCookie,
      headers: { "content-type": "application/json" },
      shopId: shopA.tenantId,
    });
    expect(notJson.status).toBe(400);
    expect(await rowCount(shopA.tenantId)).toBe(before);
  });

  it("custom: a boolean, or the per-page map kept verbatim (custom_json) with is_custom as its summary", async () => {
    const map = { angerratt: false, integritetspolicy: false, kopvillkor: true };
    const created = await expectJson<{ acceptance: { acceptanceId: string; custom: boolean; customPages: unknown } }>(
      await adminCall(world, shopA, "POST", ACCEPT, adoption(LEGAL_TEXTS, { custom: { kopvillkor: true, angerratt: false, integritetspolicy: false } })),
      201,
      "per-page map",
    );
    expect(created.acceptance).toMatchObject({ custom: true, customPages: map });
    const row = await env.DB.prepare("SELECT is_custom, custom_json FROM legal_acceptances WHERE acceptance_id = ?")
      .bind(created.acceptance.acceptanceId)
      .first();
    expect(row).toEqual({
      custom_json: '{"angerratt":false,"integritetspolicy":false,"kopvillkor":true}',
      is_custom: 1,
    });
    expect(
      (await expectJson<{ acceptance: { custom: boolean; customPages: unknown } }>(await adminCall(world, shopA, "GET", PAGES), 200, "read"))
        .acceptance,
    ).toMatchObject({ custom: true, customPages: map });

    // Every page the platform's template: the summary is false.
    const none = await expectJson<{ acceptance: { acceptanceId: string; custom: boolean } }>(
      await adminCall(world, shopA, "POST", ACCEPT, adoption(LEGAL_TEXTS, { custom: { angerratt: false, integritetspolicy: false, kopvillkor: false } })),
      201,
      "no custom page",
    );
    expect(none.acceptance.custom).toBe(false);

    // A map must name exactly the three pages, with booleans.
    for (const custom of [
      { kopvillkor: true, angerratt: false },
      { ...map, villkor: true },
      { ...map, kopvillkor: "yes" },
      { ...map, kopvillkor: null },
      [true, false, true],
      "true",
      null,
    ]) {
      expect((await adminCall(world, shopA, "POST", ACCEPT, adoption(LEGAL_TEXTS, { custom }))).status, JSON.stringify(custom)).toBe(400);
    }

    // The database: imported history keeps Firebase's map verbatim (any subset
    // of the pages), and is_custom must be its summary.
    const insert = (customJson: string, isCustom: number | null) =>
      env.DB.prepare(
        `INSERT INTO legal_acceptances (
           acceptance_id, tenant_id, type, legacy_uid, accepted_at, is_custom, custom_json,
           texts_json, texts_sha256, source
         ) VALUES (?, ?, 'legalPages', 'firebase-uid-test-seller', '2026-09-10T08:00:00.000Z', ?, ?, ?, ?, 'import')`,
      )
        .bind(crypto.randomUUID(), shopA.tenantId, isCustom, customJson, LEGAL_TEXTS_CANONICAL, LEGAL_TEXTS_SHA256)
        .run();
    await insert('{"kopvillkor":true}', 1);
    await insert("{}", 0);
    await expect(insert('{"kopvillkor":true}', 0)).rejects.toThrow(/is_custom must say whether any page/);
    await expect(insert('{"kopvillkor":false}', 1)).rejects.toThrow(/is_custom must say whether any page/);
    await expect(insert('{"kopvillkor":true}', null)).rejects.toThrow(/is_custom must say whether any page/);
    await expect(insert("[true]", 1)).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert(JSON.stringify({ kopvillkor: true, note: "x".repeat(1_024) }), 1)).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it("only the shop's own admin adopts: acting-as, another shop's admin, no session and cross-origin get the opaque 404", async () => {
    await expectJson(
      await platformCall(world, "POST", `/v1/platform/tenants/${shopA.tenantId}/acting-as`, { reason: "support" }),
      201,
      "acting-as grant",
    );
    const before = await rowCount(shopA.tenantId);

    // Acting-as may READ the shop's adoption…
    const read = await call(world, "GET", `${ADMIN}${PAGES}`, { cookie: world.platformCookie, shopId: shopA.tenantId });
    expect(await expectJson<{ acceptance: unknown }>(read, 200, "acting-as read")).toMatchObject({
      acceptance: expect.objectContaining({ source: "worker" }),
    });

    // …but never adopt the pages as the seller's own terms.
    const refused: Array<[string, Promise<Response>]> = [
      ["acting-as", call(world, "POST", `${ADMIN}${ACCEPT}`, { body: adoption(), cookie: world.platformCookie, shopId: shopA.tenantId })],
      ["another shop's admin", call(world, "POST", `${ADMIN}${ACCEPT}`, { body: adoption(), cookie: shopB.adminCookie, shopId: shopA.tenantId })],
      ["no session", call(world, "POST", `${ADMIN}${ACCEPT}`, { body: adoption(), shopId: shopA.tenantId })],
      ["cross-origin", call(world, "POST", `${ADMIN}${ACCEPT}`, {
        body: adoption(), cookie: shopA.adminCookie, origin: "https://evil.example.com", shopId: shopA.tenantId,
      })],
      ["no origin", call(world, "POST", `${ADMIN}${ACCEPT}`, { body: adoption(), cookie: shopA.adminCookie, origin: null, shopId: shopA.tenantId })],
      ["no shop", call(world, "POST", `${ADMIN}${ACCEPT}`, { body: adoption(), cookie: shopA.adminCookie })],
      ["GET on the accept route", adminCall(world, shopA, "GET", ACCEPT)],
      ["POST on the read route", adminCall(world, shopA, "POST", PAGES, adoption())],
      // Another shop's admin cannot read this shop's evidence either.
      ["another shop's admin reads", call(world, "GET", `${ADMIN}${PAGES}`, { cookie: shopB.adminCookie, shopId: shopA.tenantId })],
      ["read without a session", call(world, "GET", `${ADMIN}${PAGES}`, { shopId: shopA.tenantId })],
    ];
    for (const [label, pending] of refused) {
      expect(await expectJson(await pending, 404, label)).toEqual(NOT_FOUND);
    }
    expect(await rowCount(shopA.tenantId), "nothing written").toBe(before);
    // Its own shop: none.
    expect(await expectJson(await adminCall(world, shopB, "GET", PAGES), 200, "B's own")).toEqual({ acceptance: null });
  });

  it("the evidence is append-only, and the table admits imported history but no forged Worker row", async () => {
    await expect(
      env.DB.prepare("UPDATE legal_acceptances SET template_version = template_version WHERE tenant_id = ?")
        .bind(shopA.tenantId)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM legal_acceptances WHERE tenant_id = ?").bind(shopA.tenantId).run(),
    ).rejects.toThrow(/append-only/);

    const insert = (fields: Record<string, unknown>) => {
      const row = {
        acceptance_id: crypto.randomUUID(),
        tenant_id: shopB.tenantId,
        type: "legalPages",
        user_id: null,
        legacy_uid: "firebase-uid-test-seller",
        accepted_at: "2026-09-10T08:00:00.000Z",
        accepted_at_original: "2026-09-10T08:00:00.123Z",
        texts_json: LEGAL_TEXTS_CANONICAL,
        texts_sha256: LEGAL_TEXTS_SHA256,
        source: "import",
        ...fields,
      };
      const columns = Object.keys(row);
      return env.DB.prepare(
        `INSERT INTO legal_acceptances (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
        .bind(...Object.values(row))
        .run();
    };

    // Imported history: the original uid verbatim, no mapped user, either type.
    await insert({});
    await insert({ type: "platformTerms", version: "2026-09-07", template_version: null });
    await insert({ user_id: shopB.adminUserId, email: "", user_agent: "" });

    for (const [label, fields] of [
      ["a Worker row of the platform-terms type", { legacy_uid: null, source: "worker", type: "platformTerms", user_id: shopB.adminUserId, accepted_at_original: null }],
      ["a Worker row carrying a legacy uid", { source: "worker", user_id: shopB.adminUserId }],
      ["an imported row without its uid", { legacy_uid: null, user_id: shopB.adminUserId }],
      ["nobody accepted", { legacy_uid: null }],
      ["an unknown source", { source: "script" }],
      ["an unknown type", { type: "cookies" }],
      ["a snapshot that is not an object", { texts_json: "[]" }],
      ["a malformed hash", { texts_sha256: "ABC" }],
      ["a non-ISO time", { accepted_at: "2026-09-10 08:00:00" }],
      ["a flag that is not 0/1", { is_pod: 2 }],
    ] as const) {
      await expect(insert(fields as Record<string, unknown>), label).rejects.toThrow(/constraint failed/);
    }
    // Imported rows count as "an acceptance exists" (the future readiness gate).
    expect(await hasLegalPagesAcceptance(env.DB, shopB.tenantId)).toBe(true);
    expect((await expectJson<{ acceptance: { source: string } }>(await adminCall(world, shopB, "GET", PAGES), 200, "B")).acceptance.source).toBe(
      "import",
    );
  });

  it(`at most ${ACCEPT_PAGES_LIMIT} well-formed adoptions per shop per hour, then 429 with Retry-After`, async () => {
    const shopC = await createTenant(world, { legallyReady: false, host: "pages-c.example.com", shopName: "Sidor C", tenantId: "pages-c" });
    for (let index = 0; index < ACCEPT_PAGES_LIMIT; index += 1) {
      await expectJson(await adminCall(world, shopC, "POST", ACCEPT, adoption()), 201, `adoption ${index + 1}`);
    }
    const limited = await adminCall(world, shopC, "POST", ACCEPT, adoption());
    expect(await expectJson(limited, 429, "limited")).toEqual({ error: { code: "rate_limited", message: "Too many requests" } });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await rowCount(shopC.tenantId)).toBe(ACCEPT_PAGES_LIMIT);
    // Another shop's allowance is its own.
    await expectJson(await adminCall(world, shopB, "POST", ACCEPT, adoption()), 201, "shop B");
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the legal readiness gate at checkout (return address, VAT answer, pages adopted)", () => {
  let shop: Tenant;
  let mug = "";
  let unknownShop: unknown;

  beforeAll(async () => {
    // Terms accepted (the harness does it through the route); nothing else yet.
    shop = await createTenant(world, { legallyReady: false, host: "ready-shop.example.com", shopName: "Redo Butik", tenantId: "ready-shop" });
    mug = await createPlainProduct(world, shop, { name: "Mugg", priceMinor: 14_900, sku: "READY-MUG" });
    await publishProduct(world, shop, mug);
    await approveProduct(world, mug);
  }, 60_000);

  function checkoutBody() {
    return {
      consent: BUYER_CONSENT,
      deliveryMethod: "pickup",
      email: `${unique("buyer")}@example.com`,
      idempotencyKey: unique("idem-ready"),
      items: [{ productId: mug, quantity: 1 }],
    };
  }

  /** The checkout's answer: 201, or the 404 body — which must equal an unknown shop's. */
  async function checkoutStatus(): Promise<number> {
    const response = await storefrontCall(world, shop, "POST", "/v1/checkout", { body: checkoutBody(), origin: null });
    if (response.status === 404) {
      expect(await response.json(), "the unknown-shop 404").toEqual(unknownShop);
    }
    return response.status;
  }

  async function readiness(): Promise<Record<string, boolean>> {
    const status = await expectJson<{ readiness: Record<string, boolean> }>(
      await adminCall(world, shop, "GET", "/v1/admin/legal/status"),
      200,
      "status",
    );
    return status.readiness;
  }

  async function putSettings(body: Record<string, unknown>) {
    return expectJson<{ settings: Record<string, unknown> }>(
      await adminCall(world, shop, "PUT", "/v1/admin/settings", body),
      200,
      "PUT settings",
    );
  }

  async function checkoutCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM checkouts WHERE tenant_id = ?")
      .bind(shop.tenantId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("becomes ready through the routes only: settings (address + VAT), then the pages; closed until all three hold", async () => {
    unknownShop = await expectJson(
      await call(world, "POST", "https://no-such-shop.example.com/v1/checkout", { body: checkoutBody(), origin: null }),
      404,
      "unknown shop",
    );

    // Terms accepted, nothing else: closed, and the seller sees why.
    expect(await readiness()).toEqual({ legalPagesAccepted: false, ready: false, returnAddress: false, vatAnswered: false });
    expect(await checkoutStatus()).toBe(404);

    // PUT /v1/admin/settings (CP3-A): the return address and the VAT answer.
    await putSettings({ returnAddress: "Testgatan 1\n123 45 Teststad", vatRegistered: false });
    expect(await readiness()).toEqual({ legalPagesAccepted: false, ready: false, returnAddress: true, vatAnswered: true });
    // The pages alone missing: still closed.
    expect(await checkoutStatus()).toBe(404);
    expect(await checkoutCount()).toBe(0);

    // POST /v1/admin/legal/accept-pages: all three hold — open.
    await expectJson(await adminCall(world, shop, "POST", ACCEPT, adoption()), 201, "adopt");
    expect(await readiness()).toEqual({ legalPagesAccepted: true, ready: true, returnAddress: true, vatAnswered: true });
    expect(await isLegallyReady(env.DB, shop.tenantId)).toBe(true);
    expect(await checkoutStatus()).toBe(201);
    expect(await checkoutCount()).toBe(1);
  });

  it("each condition missing alone closes the checkout with the opaque 404", async () => {
    const before = await checkoutCount();
    // The address alone missing ('' clears it through the route).
    await putSettings({ returnAddress: "" });
    expect(await readiness()).toMatchObject({ ready: false, returnAddress: false, vatAnswered: true, legalPagesAccepted: true });
    expect(await checkoutStatus()).toBe(404);
    await putSettings({ returnAddress: "Testgatan 1, 123 45 Teststad" });

    // The VAT question alone unanswered (null = not answered; false is an answer).
    await putSettings({ vatRegistered: null });
    expect(await readiness()).toMatchObject({ ready: false, returnAddress: true, vatAnswered: false, legalPagesAccepted: true });
    expect(await checkoutStatus()).toBe(404);
    await putSettings({ vatRegistered: true });

    expect(await readiness()).toMatchObject({ ready: true });
    expect(await checkoutStatus()).toBe(201);
    expect(await checkoutCount(), "only the ready one").toBe(before + 1);
  });

  it("a whitespace-only address cannot be stored through the route, and an imported one counts as missing", async () => {
    const saved = await putSettings({ returnAddress: "   " });
    expect(saved.settings.returnAddress, "the route trims it to nothing").toBeNull();
    expect(await readiness()).toMatchObject({ ready: false, returnAddress: false });

    // An imported row can carry what the route refuses: every JavaScript
    // whitespace, not only the spaces SQLite's trim() knows.
    await env.DB.prepare("UPDATE tenant_settings SET return_address = ? WHERE tenant_id = ?")
      .bind(" \n\t  ", shop.tenantId)
      .run();
    expect(await readiness()).toMatchObject({ ready: false, returnAddress: false });
    expect(await isLegallyReady(env.DB, shop.tenantId)).toBe(false);
    expect(await checkoutStatus()).toBe(404);

    await putSettings({ returnAddress: "Testgatan 1, 123 45 Teststad" });
    expect(await checkoutStatus()).toBe(201);
  });

  it("the status carries booleans only, never the address; a platform user acting as the shop can read it", async () => {
    const own = await expectJson<Record<string, unknown>>(
      await adminCall(world, shop, "GET", "/v1/admin/legal/status"),
      200,
      "own status",
    );
    expect(JSON.stringify(own)).not.toContain("Testgatan");
    expect(Object.keys(own).sort()).toEqual([
      "accepted",
      "acceptedAt",
      "acceptedVersion",
      "currentVersion",
      "graceDeadline",
      "inGrace",
      "readiness",
    ]);

    await expectJson(
      await platformCall(world, "POST", `/v1/platform/tenants/${shop.tenantId}/acting-as`, { reason: "support" }),
      201,
      "acting-as grant",
    );
    const asPlatform = await expectJson<Record<string, unknown>>(
      await call(world, "GET", `${ADMIN}/v1/admin/legal/status`, { cookie: world.platformCookie, shopId: shop.tenantId }),
      200,
      "acting-as status",
    );
    expect(asPlatform).toEqual(own);
    expect(asPlatform.readiness).toEqual({ legalPagesAccepted: true, ready: true, returnAddress: true, vatAnswered: true });
  });

  it("a shop with no settings row and no adoption is not ready (nothing configured)", async () => {
    await env.DB.prepare(
      "INSERT INTO tenants (tenant_id, status, shop_name, created_at, updated_at) VALUES ('bare-shop', 'active', 'Test Seller Butik', 0, 0)",
    ).run();
    expect(await isLegallyReady(env.DB, "bare-shop")).toBe(false);
    expect(await isLegallyReady(env.DB, "no-such-tenant")).toBe(false);
  });
});
