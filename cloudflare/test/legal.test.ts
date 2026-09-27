import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCheckout } from "../src/commerce/checkout";
import {
  isPersonalizedLine,
  parseCheckoutConsent,
  WITHDRAWAL_DISCLOSURE_TEXT,
  WITHDRAWAL_DISCLOSURE_VERSION,
  withdrawalDisclosureSha256,
} from "../src/legal/consent";
import { hasAcceptedCurrentTerms } from "../src/legal/platform-terms";
import { CURRENT_TERMS_VERSION, legalReadinessStatements } from "./legal-fixtures";
import {
  ADMIN,
  acceptPlatformTerms,
  adminCall,
  adminOrder,
  approveProduct,
  bootstrapPlatform,
  call,
  claimReceipt,
  createPlainProduct,
  createTenant,
  expectJson,
  keysOf,
  openCheckout,
  payCheckout,
  platformCall,
  publishProduct,
  readBuyerOrder,
  SliceWorld,
  storefrontCall,
  succeedPayment,
  type Tenant,
  termsStatus,
  unique,
} from "./slice-harness";

/**
 * CP2-E — the checkout legal gate and the buyer's consent, through the real
 * routes (migrations/0031, src/legal/).
 *
 *   SELLER  a shop takes no checkout until its own admin accepted the CURRENT
 *           platform terms version, with stored, append-only evidence.
 *   BUYER   terms always; the no-withdrawal waiver only (and always) for a
 *           personalised line, with the disclosure version shown; marketing
 *           as its own box. Frozen on the checkout, copied onto the order,
 *           shown on the receipt and to the shop's admin.
 */

const world = new SliceWorld();
let shop: Tenant;
let other: Tenant;
let mug = "";
let engraved = "";

beforeAll(async () => {
  await bootstrapPlatform(world);
  shop = await createTenant(world, { legallyReady: false,
    acceptTerms: false,
    host: "legal-shop.legal.slice.test",
    shopName: "Juridik Butik",
    tenantId: "legal-shop",
  });
  other = await createTenant(world, { legallyReady: false,
    acceptTerms: false,
    host: "legal-other.legal.slice.test",
    shopName: "Annan Butik",
    tenantId: "legal-other",
  });

  mug = await createPlainProduct(world, shop, { name: "Mugg", priceMinor: 14_900, sku: "LEGAL-MUG" });
  engraved = await createPlainProduct(world, shop, {
    name: "Mugg med din text",
    priceMinor: 24_900,
    sku: "LEGAL-ENGRAVED",
  });
  for (const productId of [mug, engraved]) {
    await publishProduct(world, shop, productId);
    await approveProduct(world, productId);
  }
  // The seller's "Specialtillverkad / personlig produkt" toggle (CP5's
  // ProductForm writes it; no CF route does yet).
  await env.DB.prepare("UPDATE products SET is_personalized = 1 WHERE product_id = ?").bind(engraved).run();
  // CP3-E's second gate: both shops are legally ready (return address, VAT
  // answer, legal pages adopted), so every 404 below is the TERMS gate's.
  await env.DB.batch([
    ...legalReadinessStatements(env.DB, shop.tenantId, shop.adminUserId),
    ...legalReadinessStatements(env.DB, other.tenantId, other.adminUserId),
  ]);
}, 60_000);

const READY = { legalPagesAccepted: true, ready: true, returnAddress: true, vatAnswered: true };

beforeEach(() => {
  world.reset();
});

/** A version effective in 2099 (the gate reads "the latest published <= now"). */
async function ensureFutureVersion(): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO platform_terms_versions (version, published_at, sha256, created_at)
     VALUES ('2099-01-01', '2099-01-01T00:00:00.000Z', ?, '2026-09-27T00:00:00.000Z')`,
  )
    .bind("0".repeat(64))
    .run();
}

function checkoutBody(items: Array<{ productId: string; quantity: number }>, consent?: unknown) {
  return {
    ...(consent === undefined ? {} : { consent }),
    deliveryMethod: "pickup",
    email: `${unique("buyer")}@buyers.legal.test`,
    idempotencyKey: unique("idem-legal"),
    items,
  };
}

async function postCheckout(tenant: Tenant, body: unknown) {
  return storefrontCall(world, tenant, "POST", "/v1/checkout", { body, origin: null });
}

async function checkoutCount(tenantId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM checkouts WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("seller: the platform-terms gate", () => {
  it("closes checkout (the unknown-shop 404, nothing written) until the shop's admin accepts", async () => {
    expect(await termsStatus(world, shop)).toEqual({
      accepted: false,
      acceptedAt: null,
      acceptedVersion: null,
      currentVersion: CURRENT_TERMS_VERSION,
      graceDeadline: null,
      inGrace: false,
      readiness: READY,
    });

    const gated = await postCheckout(shop, checkoutBody([{ productId: mug, quantity: 1 }], { terms: true }));
    const unknownShop = await call(world, "POST", "https://no-such-shop.legal.slice.test/v1/checkout", {
      body: checkoutBody([{ productId: mug, quantity: 1 }], { terms: true }),
      origin: null,
    });
    const gatedBody = await expectJson(gated, 404, "gated checkout");
    expect(gatedBody, "indistinguishable from a shop that does not exist").toEqual(
      await expectJson(unknownShop, 404, "unknown shop"),
    );
    expect(await checkoutCount(shop.tenantId)).toBe(0);

    // The storefront read says nothing about the gate.
    const storefront = await expectJson<Record<string, unknown>>(
      await storefrontCall(world, shop, "GET", "/v1/storefront"),
      200,
      "storefront",
    );
    expect(keysOf(storefront).filter((key) => /terms|accept/i.test(key))).toEqual([]);

    const acceptedAt = await acceptPlatformTerms(world, shop);
    expect(await termsStatus(world, shop)).toEqual({
      accepted: true,
      acceptedAt,
      acceptedVersion: CURRENT_TERMS_VERSION,
      currentVersion: CURRENT_TERMS_VERSION,
      graceDeadline: null,
      inGrace: false,
      readiness: READY,
    });
    expect(await hasAcceptedCurrentTerms(env.DB, shop.tenantId, Date.now())).toBe(true);
    await expectJson(await postCheckout(shop, checkoutBody([{ productId: mug, quantity: 1 }], { terms: true })), 201, "open");

    // One shop's acceptance opens nothing for another.
    expect(await termsStatus(world, other)).toMatchObject({ accepted: false });
    expect(await hasAcceptedCurrentTerms(env.DB, other.tenantId, Date.now())).toBe(false);
  });

  it("stores the evidence (who, when, version, ip, user agent, text hash) + an audit row; a repeat answers with the FIRST", async () => {
    const response = await call(world, "POST", `${ADMIN}/v1/admin/legal/accept-terms`, {
      body: { termsVersion: CURRENT_TERMS_VERSION },
      cookie: other.adminCookie,
      headers: { "user-agent": "Mozilla/5.0 (Juridik-test)" },
      shopId: other.tenantId,
    });
    const first = await expectJson<{ acceptance: { acceptedAt: string; termsVersion: string } }>(response, 201, "accept");
    expect(first.acceptance.termsVersion).toBe(CURRENT_TERMS_VERSION);

    const rows = await env.DB.prepare(
      `SELECT user_id, terms_version, accepted_at, ip, user_agent, evidence_json
       FROM platform_terms_acceptances WHERE tenant_id = ?`,
    )
      .bind(other.tenantId)
      .all<Record<string, string>>();
    expect(rows.results).toEqual([
      {
        accepted_at: first.acceptance.acceptedAt,
        evidence_json: JSON.stringify({
          origin: ADMIN,
          termsSha256: "ca1f708f70d0ab3b9d26d9d0647efafca77018d8a4e5dcc6bfec7c0a464c0b91",
        }),
        ip: expect.stringMatching(/^203\.0\./),
        terms_version: CURRENT_TERMS_VERSION,
        user_agent: "Mozilla/5.0 (Juridik-test)",
        user_id: other.adminUserId,
      },
    ]);
    const audit = await env.DB.prepare(
      "SELECT actor_user_id, action FROM audit_events WHERE tenant_id = ? AND action = 'legal.platform_terms.accept'",
    )
      .bind(other.tenantId)
      .all();
    expect(audit.results).toEqual([{ action: "legal.platform_terms.accept", actor_user_id: other.adminUserId }]);

    const again = await expectJson<{ acceptance: { acceptedAt: string } }>(
      await adminCall(world, other, "POST", "/v1/admin/legal/accept-terms", { termsVersion: CURRENT_TERMS_VERSION }),
      200,
      "accept again",
    );
    expect(again.acceptance.acceptedAt, "the first acceptance is the evidence").toBe(first.acceptance.acceptedAt);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_terms_acceptances WHERE tenant_id = ?")
      .bind(other.tenantId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("refuses a stale version (409 + the current one), a malformed body (400), and every unauthorised caller (404)", async () => {
    const stale = await adminCall(world, shop, "POST", "/v1/admin/legal/accept-terms", { termsVersion: "2025-01-01" });
    expect(await expectJson(stale, 409, "stale")).toEqual({
      currentVersion: CURRENT_TERMS_VERSION,
      error: { code: "terms_version_not_current", message: "The terms version is not the current one" },
    });
    for (const body of [{}, { termsVersion: 7 }, { termsVersion: CURRENT_TERMS_VERSION, extra: true }, { termsVersion: "a b" }]) {
      await expectJson(await adminCall(world, shop, "POST", "/v1/admin/legal/accept-terms", body), 400, "malformed");
    }

    const cases: Array<[string, Promise<Response>]> = [
      ["no session", call(world, "POST", `${ADMIN}/v1/admin/legal/accept-terms`, {
        body: { termsVersion: CURRENT_TERMS_VERSION }, shopId: shop.tenantId,
      })],
      ["cross-origin", call(world, "POST", `${ADMIN}/v1/admin/legal/accept-terms`, {
        body: { termsVersion: CURRENT_TERMS_VERSION }, cookie: shop.adminCookie, origin: "https://evil.test", shopId: shop.tenantId,
      })],
      ["another shop's admin", call(world, "POST", `${ADMIN}/v1/admin/legal/accept-terms`, {
        body: { termsVersion: CURRENT_TERMS_VERSION }, cookie: other.adminCookie, shopId: shop.tenantId,
      })],
      ["GET on the accept route", adminCall(world, shop, "GET", "/v1/admin/legal/accept-terms")],
      ["POST on the status route", adminCall(world, shop, "POST", "/v1/admin/legal/status", {})],
      ["status without a session", call(world, "GET", `${ADMIN}/v1/admin/legal/status`, { shopId: shop.tenantId })],
    ];
    for (const [label, pending] of cases) {
      expect((await pending).status, label).toBe(404);
    }
  });

  it("a platform user acting as the shop can never accept on the seller's behalf", async () => {
    const fresh = await createTenant(world, { legallyReady: false,
      acceptTerms: false,
      host: "legal-acting.legal.slice.test",
      shopName: "Acting Butik",
      tenantId: "legal-acting",
    });
    await expectJson(
      await platformCall(world, "POST", `/v1/platform/tenants/${fresh.tenantId}/acting-as`, { reason: "support" }),
      201,
      "acting-as grant",
    );
    // The grant works for reads…
    const status = await call(world, "GET", `${ADMIN}/v1/admin/legal/status`, {
      cookie: world.platformCookie,
      shopId: fresh.tenantId,
    });
    expect(await expectJson(status, 200, "status as platform")).toMatchObject({ accepted: false });
    // …but not to sign the contract.
    const refused = await call(world, "POST", `${ADMIN}/v1/admin/legal/accept-terms`, {
      body: { termsVersion: CURRENT_TERMS_VERSION },
      cookie: world.platformCookie,
      shopId: fresh.tenantId,
    });
    expect(refused.status).toBe(404);
    expect(await hasAcceptedCurrentTerms(env.DB, fresh.tenantId, Date.now())).toBe(false);
  });

  it("follows the CURRENT version: a newer published version closes checkout again until re-accepted", async () => {
    await ensureFutureVersion();
    const in2100 = Date.parse("2100-01-01T00:00:00.000Z");
    const tenant = { domainKind: "storefront" as const, hostname: shop.host, tenantId: shop.tenantId };
    const input = {
      consent: { disclosureVersion: null, marketing: false, terms: true as const, withdrawalWaiver: false },
      deliveryMethod: "pickup" as const,
      discountCode: null,
      email: "future@buyers.legal.test",
      idempotencyKey: unique("idem-future"),
      items: [{ productId: mug, quantity: 1 }],
      shippingCountry: null,
    };

    expect(await hasAcceptedCurrentTerms(env.DB, shop.tenantId, in2100)).toBe(false);
    expect(await createCheckout(env.DB, tenant, input, in2100)).toEqual({ status: "not_found" });
    // Today the 2026 acceptance still holds.
    expect((await createCheckout(env.DB, tenant, { ...input, idempotencyKey: unique("idem-now") }, Date.now())).status).toBe("ok");

    await env.DB.prepare(
      `INSERT INTO platform_terms_acceptances (id, tenant_id, user_id, terms_version, accepted_at, evidence_json)
       VALUES (?, ?, ?, '2099-01-01', '2100-01-01T00:00:00.000Z', '{}')`,
    )
      .bind(crypto.randomUUID(), shop.tenantId, shop.adminUserId)
      .run();
    expect(await hasAcceptedCurrentTerms(env.DB, shop.tenantId, in2100)).toBe(true);
    expect((await createCheckout(env.DB, tenant, input, in2100)).status).toBe("ok");
  });

  it("the evidence is append-only, and a version cannot be accepted before it is published", async () => {
    await ensureFutureVersion();
    const id = crypto.randomUUID();
    await expect(
      env.DB.prepare(
        `INSERT INTO platform_terms_acceptances (id, tenant_id, user_id, terms_version, accepted_at, evidence_json)
         VALUES (?, 'legal-other', 'u', '2099-01-01', '2098-12-31T23:59:59.000Z', '{}')`,
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/cannot be accepted before it is published/);
    await expect(
      env.DB.prepare("UPDATE platform_terms_acceptances SET accepted_at = accepted_at WHERE tenant_id = 'legal-other'").run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM platform_terms_acceptances WHERE tenant_id = 'legal-other'").run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("UPDATE platform_terms_versions SET sha256 = sha256").run(),
    ).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM platform_terms_versions").run()).rejects.toThrow(/append-only/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("buyer: consent at checkout", () => {
  it("requires the terms box: no consent, terms false or a stray key is a 400 and writes nothing", async () => {
    const before = await checkoutCount(shop.tenantId);
    for (const consent of [undefined, {}, { terms: false }, { terms: "yes" }, { marketing: true }, { terms: true, extra: 1 }]) {
      const response = await postCheckout(shop, checkoutBody([{ productId: mug, quantity: 1 }], consent));
      expect(await expectJson(response, 400, JSON.stringify(consent ?? null))).toEqual({
        error: { code: "invalid_request", message: "Request is not valid" },
      });
    }
    // A disclosure version belongs to a ticked waiver only.
    for (const consent of [
      { disclosureVersion: WITHDRAWAL_DISCLOSURE_VERSION, terms: true },
      { terms: true, withdrawalWaiver: true },
      { disclosureVersion: "", terms: true, withdrawalWaiver: true },
    ]) {
      expect((await postCheckout(shop, checkoutBody([{ productId: mug, quantity: 1 }], consent))).status).toBe(400);
    }
    expect(await checkoutCount(shop.tenantId)).toBe(before);
  });

  it("a personalised line without the waiver ⇒ 400 withdrawal_waiver_required; a stale disclosure ⇒ withdrawal_disclosure_outdated", async () => {
    const before = await checkoutCount(shop.tenantId);
    const noWaiver = await postCheckout(
      shop,
      checkoutBody([{ productId: mug, quantity: 1 }, { productId: engraved, quantity: 1 }], { marketing: true, terms: true }),
    );
    expect(await expectJson(noWaiver, 400, "no waiver")).toEqual({
      error: {
        code: "withdrawal_waiver_required",
        message: "The basket needs a consent the request did not give",
      },
    });
    const stale = await postCheckout(
      shop,
      checkoutBody([{ productId: engraved, quantity: 1 }], {
        disclosureVersion: "v0-2025-01",
        terms: true,
        withdrawalWaiver: true,
      }),
    );
    expect(await expectJson<{ error: { code: string } }>(stale, 400, "stale disclosure")).toMatchObject({
      error: { code: "withdrawal_disclosure_outdated" },
    });
    expect(await checkoutCount(shop.tenantId)).toBe(before);
  });

  it("a cart with no personalised line needs no waiver, and a waiver sent anyway is NOT recorded (the right stays)", async () => {
    const plain = await openCheckout(world, shop, [{ productId: mug, quantity: 1 }], { consent: { terms: true } });
    const waivedAnyway = await openCheckout(world, shop, [{ productId: mug, quantity: 1 }], {
      consent: { disclosureVersion: WITHDRAWAL_DISCLOSURE_VERSION, marketing: false, terms: true, withdrawalWaiver: true },
    });
    for (const checkoutId of [plain.checkoutId, waivedAnyway.checkoutId]) {
      const row = await env.DB.prepare("SELECT consent_json FROM checkouts WHERE checkout_id = ?")
        .bind(checkoutId)
        .first<{ consent_json: string }>();
      expect(JSON.parse(row?.consent_json ?? "null")).toMatchObject({
        marketing: false,
        terms: true,
        withdrawal: { disclosureSha256: null, disclosureVersion: null, personalizedItems: [], waived: false },
      });
    }
  });

  it("the waiver is frozen on the checkout, copied onto the order in the webhook batch, and shown on the receipt and to the admin", async () => {
    const consent = {
      disclosureVersion: WITHDRAWAL_DISCLOSURE_VERSION,
      marketing: true,
      terms: true as const,
      withdrawalWaiver: true,
    };
    const checkout = await openCheckout(
      world,
      shop,
      [{ productId: mug, quantity: 1 }, { productId: engraved, quantity: 2 }],
      { consent },
    );
    const frozen = await env.DB.prepare("SELECT consent_json FROM checkouts WHERE checkout_id = ?")
      .bind(checkout.checkoutId)
      .first<{ consent_json: string }>();
    expect(JSON.parse(frozen?.consent_json ?? "null")).toEqual({
      marketing: true,
      recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      terms: true,
      v: 1,
      withdrawal: {
        disclosureSha256: await withdrawalDisclosureSha256(),
        disclosureVersion: WITHDRAWAL_DISCLOSURE_VERSION,
        // Only the engraved mug (item 1) is personalised; the plain one keeps its right.
        personalizedItems: [1],
        waived: true,
      },
    });
    await expect(
      env.DB.prepare("UPDATE checkouts SET consent_json = NULL WHERE checkout_id = ?").bind(checkout.checkoutId).run(),
    ).rejects.toThrow(/checkout consent is frozen/);

    // An idempotent replay with a different box is a different request.
    const replay = await postCheckout(shop, {
      consent: { ...consent, marketing: false },
      deliveryMethod: "pickup",
      email: "x@buyers.legal.test",
      idempotencyKey: "idem-legal-replay-1",
      items: [{ productId: mug, quantity: 1 }],
    });
    await expectJson(replay, 201, "first");
    const flipped = await postCheckout(shop, {
      consent: { ...consent, marketing: true },
      deliveryMethod: "pickup",
      email: "x@buyers.legal.test",
      idempotencyKey: "idem-legal-replay-1",
      items: [{ productId: mug, quantity: 1 }],
    });
    expect(flipped.status, "marketing flipped under the same key").toBe(409);

    const paymentIntentId = await payCheckout(world, shop, checkout.checkoutId);
    const { orderId } = await succeedPayment(world, shop, {
      checkoutId: checkout.checkoutId,
      paymentIntentId,
      totalMinor: checkout.totalMinor,
    });
    expect(orderId).not.toBeNull();
    const order = await env.DB.prepare("SELECT consent_json, is_personalized FROM orders WHERE order_id = ?")
      .bind(orderId)
      .first<{ consent_json: string; is_personalized: number }>();
    expect(order).toEqual({ consent_json: frozen?.consent_json, is_personalized: 1 });
    await expect(
      env.DB.prepare("UPDATE orders SET is_personalized = 0 WHERE order_id = ?").bind(orderId).run(),
    ).rejects.toThrow(/order consent is immutable/);

    const claimed = await expectJson<{ receipt: { receiptToken: string } }>(
      await claimReceipt(world, shop, checkout.checkoutId),
      200,
      "claim",
    );
    const buyer = await expectJson<{ order: { withdrawal: unknown } }>(
      await readBuyerOrder(world, shop, orderId ?? "", claimed.receipt.receiptToken),
      200,
      "receipt",
    );
    expect(buyer.order.withdrawal).toEqual({ waived: true });

    const admin = await adminOrder(world, shop, orderId ?? "");
    expect(admin.withdrawal).toEqual({ waived: true });
    expect(admin.consent).toEqual({
      marketing: true,
      recordedAt: expect.any(String),
      terms: true,
      withdrawal: {
        disclosureVersion: WITHDRAWAL_DISCLOSURE_VERSION,
        personalizedItems: [1],
        waived: true,
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("consent rules (unit)", () => {
  it("the disclosure is Firebase's text, version and a stable hash", async () => {
    expect(WITHDRAWAL_DISCLOSURE_VERSION).toBe("v1-2026-06");
    expect(WITHDRAWAL_DISCLOSURE_TEXT).toMatch(/^Den här beställningen innehåller en eller flera specialtillverkade produkter/);
    expect(WITHDRAWAL_DISCLOSURE_TEXT).toMatch(/Reklamationsrätten vid fel på varan gäller alltid\./);
    expect(await withdrawalDisclosureSha256()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("personalisation is the product's own flag — never POD-ness (the legal firewall)", () => {
    expect(isPersonalizedLine({ isPersonalized: false })).toBe(false);
    expect(isPersonalizedLine({ isPersonalized: true })).toBe(true);
  });

  it("parses the boxes strictly", () => {
    expect(parseCheckoutConsent({ terms: true })).toEqual({
      disclosureVersion: null,
      marketing: false,
      terms: true,
      withdrawalWaiver: false,
    });
    expect(parseCheckoutConsent({ marketing: true, terms: true })).toMatchObject({ marketing: true });
    expect(parseCheckoutConsent(null)).toBeNull();
    expect(parseCheckoutConsent([{ terms: true }])).toBeNull();
    expect(parseCheckoutConsent({ marketing: "yes", terms: true })).toBeNull();
    expect(parseCheckoutConsent({ disclosureVersion: "v1", terms: true, withdrawalWaiver: false })).toBeNull();
  });
});
