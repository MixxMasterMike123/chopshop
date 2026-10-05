import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { takesDestinationCharges } from "../src/commerce/payment";
import {
  isPlaceholderAddress,
  isPlaceholderText,
  isRealText,
  LEGAL_IDENTITY_FIELDS,
  PLACEHOLDER_IDENTITY_TEXTS,
  readLegalIdentityGaps,
} from "../src/legal/legal-identity";
import { isLegallyReady } from "../src/legal/legal-pages";
import { STOREFRONT_BODY_REVISION } from "../src/storefront/public-routes";
import { BUYER_CONSENT, BUYER_RECIPIENT_PICKUP } from "./legal-fixtures";
import {
  adminCall,
  approveProduct,
  bootstrapPlatform,
  createPlainProduct,
  createTenant,
  expectJson,
  giveSupportAddress,
  publishProduct,
  SLICE_LEGAL_IDENTITY,
  SLICE_PICKUP_LOCATION,
  SliceWorld,
  storefrontCall,
  type Tenant,
  unique,
} from "./slice-harness";
import { catalogVersion, seedShop, storeIdentity } from "./storefront-fixtures";

/**
 * CP9-OB — what a new shop's onboarding trips over, on the Worker's side:
 *
 *   - adopting the legal pages requires the identity they print (legal name,
 *     postal address, a real support address; for a company the org number,
 *     for a VAT-registered company the VAT number), refused with 409
 *     legal_identity_incomplete before anything is written or counted; the
 *     rule is the ACT of adopting: an adoption already made keeps its checkout;
 *   - a placeholder value (the older admin's defaults, stored as values) is
 *     never shown in the public storefront answer and never counts as set;
 *   - the storefront answer says whether the shop can take an order NOW
 *     (`ordersOpen`, the checkout's and the payment's own predicates), and its
 *     ETag names that fact, so a change without a catalog bump is never a
 *     stale 304.
 */

const world = new SliceWorld();
const ACCEPT = "/v1/admin/legal/accept-pages";
const STATUS = "/v1/admin/legal/status";
const SETTINGS = "/v1/admin/settings";

const ADOPTION = {
  custom: false,
  pod: false,
  templateVersion: "2026-09-07",
  texts: {
    angerratt: "<h1>Ångerrätt</h1><p>CP9-OB fixture.</p>",
    integritetspolicy: "<h1>Integritetspolicy</h1><p>CP9-OB fixture.</p>",
    kopvillkor: "<h1>Köpvillkor</h1><p>CP9-OB fixture.</p>",
  },
};

beforeAll(async () => {
  await bootstrapPlatform(world);
}, 60_000);

beforeEach(() => {
  world.reset();
});

async function adoptionRows(tenantId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM legal_acceptances WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function adoptionAttempts(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(count), 0) AS n FROM rate_limit_windows WHERE scope = 'legal-pages-accept-tenant'",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

async function patchIdentity(tenant: Tenant, body: Record<string, unknown>): Promise<void> {
  const current = await expectJson<{ settings: { updatedAt: string | null } }>(
    await adminCall(world, tenant, "GET", SETTINGS),
    200,
    "settings",
  );
  await expectJson(
    await adminCall(world, tenant, "PATCH", SETTINGS, { expectedUpdatedAt: current.settings.updatedAt, ...body }),
    200,
    "PATCH settings",
  );
}

async function identityMissing(tenant: Tenant): Promise<string[]> {
  const status = await expectJson<{ identityMissing: string[] }>(await adminCall(world, tenant, "GET", STATUS), 200, "status");
  return status.identityMissing;
}

async function refusedFor(tenant: Tenant): Promise<string[]> {
  const body = await expectJson<{ error: { code: string; message: string; missing: string[] } }>(
    await adminCall(world, tenant, "POST", ACCEPT, ADOPTION),
    409,
    "refused adoption",
  );
  expect(body.error.code).toBe("legal_identity_incomplete");
  expect(Object.keys(body.error).sort()).toEqual(["code", "message", "missing"]);
  return body.error.missing;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("the placeholder texts", () => {
  it("are the six defaults the older admin stored as values, compared without tags, spaces and case", () => {
    for (const text of PLACEHOLDER_IDENTITY_TEXTS) {
      expect(isPlaceholderText(text), text).toBe(true);
    }
    expect(isPlaceholderText("my company")).toBe(true);
    expect(isPlaceholderText("  My   Company ")).toBe(true);
    expect(isPlaceholderText("<p>My Company</p>")).toBe(true);
    expect(isPlaceholderText("My Company<br/>\n123 Main Street<br>\nCity")).toBe(true);
    expect(isPlaceholderText("QUALITY PRODUCTS, DELIVERED.")).toBe(true);
    // A real text that only contains one is the shop's own.
    expect(isPlaceholderText("My Company AB")).toBe(false);
    expect(isPlaceholderText("Ninetone Group AB")).toBe(false);
    expect(isRealText("My Company AB")).toBe(true);
    expect(isRealText("   ")).toBe(false);
    expect(isRealText("<br>")).toBe(false);
    expect(isRealText(42)).toBe(false);
  });

  it("an address at a placeholder domain is one, another domain is not", () => {
    for (const address of ["hello@example.com", "a@example.org", "b@EXAMPLE.net", " c@example.se "]) {
      expect(isPlaceholderAddress(address), address).toBe(true);
    }
    for (const address of ["kundtjanst@butik.se", "x@shop.example.com", "x@example.test", "x@notexample.com"]) {
      expect(isPlaceholderAddress(address), address).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("adopting the legal pages requires the identity they print", () => {
  let shop: Tenant;
  let mug = "";

  beforeAll(async () => {
    shop = await createTenant(world, { legallyReady: false, host: "ob-new.example.com", shopName: "Ny Butik", tenantId: "ob-new" });
    mug = await createPlainProduct(world, shop, { name: "Mugg", priceMinor: 14_900, sku: "OB-MUG" });
    await publishProduct(world, shop, mug);
    await approveProduct(world, mug);
    // The checkout's own conditions, so only the adoption is left.
    await expectJson(
      await adminCall(world, shop, "PUT", SETTINGS, {
        returnAddress: "Returgatan 1\n123 45 Teststad",
        storeIdentity: { pickupLocations: [SLICE_PICKUP_LOCATION] },
        vatRegistered: false,
      }),
      200,
      "return address, VAT answer",
    );
  }, 60_000);

  async function checkoutStatus(): Promise<number> {
    const response = await storefrontCall(world, shop, "POST", "/v1/checkout", {
      body: {
        consent: BUYER_CONSENT,
        deliveryMethod: "pickup",
        email: `${unique("buyer")}@buyers.ob.test`,
        idempotencyKey: unique("idem-ob"),
        items: [{ productId: mug, quantity: 1 }],
        recipient: BUYER_RECIPIENT_PICKUP,
      },
      origin: null,
    });
    await response.body?.cancel();
    return response.status;
  }

  it("a new shop: refused, naming the fields; nothing written, no attempt counted; the status says the same", async () => {
    const attempts = await adoptionAttempts();
    expect(await refusedFor(shop)).toEqual(["legalName", "address", "supportEmail"]);
    expect(await identityMissing(shop)).toEqual(["legalName", "address", "supportEmail"]);
    expect(await adoptionRows(shop.tenantId)).toBe(0);
    expect(await adoptionAttempts(), "a refusal costs no attempt").toBe(attempts);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ? AND action = 'legal.pages.accept'",
    )
      .bind(shop.tenantId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(0);
    expect(await isLegallyReady(env.DB, shop.tenantId)).toBe(false);
    expect(await checkoutStatus()).toBe(404);
  });

  it("the older admin's placeholders count as missing", async () => {
    await patchIdentity(shop, {
      storeIdentity: { address: "My Company<br>123 Main Street<br>City", legalName: "My Company" },
    });
    await env.DB.prepare("UPDATE tenants SET support_email = 'hello@example.com' WHERE tenant_id = ?")
      .bind(shop.tenantId)
      .run();
    expect(await refusedFor(shop)).toEqual(["legalName", "address", "supportEmail"]);
    expect(await adoptionRows(shop.tenantId)).toBe(0);
  });

  it("each field alone: legal name, address, support address", async () => {
    await giveSupportAddress(shop);
    await patchIdentity(shop, { storeIdentity: { address: "Storgatan 1<br>123 45 Sundsvall", legalName: "" } });
    expect(await refusedFor(shop)).toEqual(["legalName"]);
    await patchIdentity(shop, { storeIdentity: { address: "   ", legalName: "Ny Butik AB" } });
    expect(await refusedFor(shop)).toEqual(["address"]);
    await patchIdentity(shop, { storeIdentity: { address: "Storgatan 1<br>123 45 Sundsvall" } });
    await env.DB.prepare("UPDATE tenants SET support_email = NULL WHERE tenant_id = ?").bind(shop.tenantId).run();
    expect(await refusedFor(shop)).toEqual(["supportEmail"]);
    await giveSupportAddress(shop);
    expect(await identityMissing(shop)).toEqual([]);
  });

  it("a company also needs its org number, and a VAT-registered company its VAT number", async () => {
    await expectJson(await adminCall(world, shop, "PUT", SETTINGS, { sellerType: "company", vatRegistered: true }), 200, "company");
    expect(await refusedFor(shop)).toEqual(["orgNumber", "vatNumber"]);
    await patchIdentity(shop, { storeIdentity: { orgNumber: "556677-8899" } });
    expect(await refusedFor(shop)).toEqual(["vatNumber"]);
    // A company that is not VAT-registered prints no VAT number.
    await expectJson(await adminCall(world, shop, "PUT", SETTINGS, { vatRegistered: false }), 200, "not registered");
    expect(await identityMissing(shop)).toEqual([]);
    await expectJson(await adminCall(world, shop, "PUT", SETTINGS, { vatRegistered: true }), 200, "registered");
    // An individual's pages print no VAT number, registered or not.
    await expectJson(await adminCall(world, shop, "PUT", SETTINGS, { sellerType: "individual" }), 200, "individual");
    expect(await identityMissing(shop)).toEqual([]);
    await expectJson(
      await adminCall(world, shop, "PUT", SETTINGS, { sellerType: "company", vatNumber: "SE556677889901", vatRegistered: false }),
      200,
      "company, not VAT-registered",
    );
    expect(await identityMissing(shop)).toEqual([]);
    await expectJson(await adminCall(world, shop, "PUT", SETTINGS, { vatRegistered: true }), 200, "registered again");
    expect(await identityMissing(shop)).toEqual([]);
  });

  it("complete: adopted, the checkout opens", async () => {
    await expectJson(await adminCall(world, shop, "POST", ACCEPT, ADOPTION), 201, "adopted");
    expect(await adoptionRows(shop.tenantId)).toBe(1);
    expect(await isLegallyReady(env.DB, shop.tenantId)).toBe(true);
    expect(await checkoutStatus()).toBe(201);
  });

  it("not retroactive: an identity emptied after adopting keeps the checkout open; only a new adoption is refused", async () => {
    await patchIdentity(shop, { storeIdentity: { legalName: "" } });
    expect(await identityMissing(shop)).toEqual(["legalName"]);
    const status = await expectJson<{ readiness: Record<string, boolean> }>(await adminCall(world, shop, "GET", STATUS), 200, "status");
    expect(status.readiness).toEqual({ legalPagesAccepted: true, ready: true, returnAddress: true, vatAnswered: true });
    expect(await checkoutStatus()).toBe(201);
    expect(await refusedFor(shop)).toEqual(["legalName"]);
    expect(await adoptionRows(shop.tenantId)).toBe(1);
  });

  it("the reader names exactly the fields of LEGAL_IDENTITY_FIELDS, in that order", async () => {
    expect(LEGAL_IDENTITY_FIELDS).toEqual(["legalName", "address", "supportEmail", "orgNumber", "vatNumber"]);
    expect(await readLegalIdentityGaps(env.DB, "no-such-tenant")).toEqual(["legalName", "address", "supportEmail"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the public storefront answer never shows a placeholder", () => {
  it("drops the stored defaults, keeps the shop's own values", async () => {
    const shop = await seedShop("ob-placeholders", { supportEmail: "hello@example.com" });
    await storeIdentity(shop.tenantId, {
      address: "My Company<br>123 Main Street<br>City",
      businessInfo: "Registrerad för F-skatt",
      companyDescription: "Quality products, delivered.",
      legalName: "My Company",
      tagline: "Quality products, delivered.",
    });
    const read = async () =>
      (await (await exports.default.fetch(new Request(`${shop.origin}/v1/storefront`))).json()) as {
        storefront: { identity: Record<string, unknown> };
      };
    expect((await read()).storefront.identity).toEqual({ businessInfo: "Registrerad för F-skatt" });

    await storeIdentity(shop.tenantId, {
      address: "Storgatan 1<br>123 45 Sundsvall",
      companyDescription: "Tryck från Sundsvall.",
      legalName: "My Company AB",
      tagline: "Merch från Sundsvall",
    });
    await env.DB.prepare("UPDATE tenants SET support_email = 'hej@butik.test' WHERE tenant_id = ?").bind(shop.tenantId).run();
    expect((await read()).storefront.identity).toEqual({
      address: "Storgatan 1<br>123 45 Sundsvall",
      companyDescription: "Tryck från Sundsvall.",
      legalName: "My Company AB",
      supportEmail: "hej@butik.test",
      tagline: "Merch från Sundsvall",
    });
  });

  it("the SEO answer, built from the same projection, prints none either", async () => {
    const shop = await seedShop("ob-seo", { name: "Seo Butik", supportEmail: "hello@example.com" });
    await storeIdentity(shop.tenantId, { companyDescription: "Quality products, delivered.", tagline: "Quality products, delivered." });
    const response = await exports.default.fetch(new Request(`${shop.origin}/v1/seo?path=%2F`));
    const text = await response.text();
    expect(response.status, text.slice(0, 200)).toBe(200);
    expect(text).toContain("Seo Butik");
    expect(text).not.toContain("Quality products");
    expect(text).not.toContain("example.com");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the storefront answer says whether the shop can take an order now", () => {
  let ready: Tenant;

  beforeAll(async () => {
    // Legally ready, terms accepted, an account that takes charges (the harness).
    ready = await createTenant(world, { host: "ob-ready.example.com", shopName: "Redo", tenantId: "ob-ready" });
  }, 60_000);

  async function storefront(tenant: Tenant, headers: Record<string, string> = {}) {
    return storefrontCall(world, tenant, "GET", "/v1/storefront", { headers });
  }

  async function ordersOpen(response: Response): Promise<boolean> {
    const body = (await response.json()) as { storefront: { ordersOpen: boolean } };
    return body.storefront.ordersOpen;
  }

  it("the payment's own test of the account", () => {
    expect(takesDestinationCharges({ stripe_account_id: "acct_1", stripe_charges_enabled: 1 })).toBe(true);
    expect(takesDestinationCharges({ stripe_account_id: "acct_1", stripe_charges_enabled: 0 })).toBe(false);
    expect(takesDestinationCharges({ stripe_account_id: null, stripe_charges_enabled: 1 })).toBe(false);
  });

  it("a ready shop: open, and its ETag carries no mark", async () => {
    const version = await catalogVersion(ready.tenantId);
    const response = await storefront(ready);
    expect(response.headers.get("etag")).toBe(`"${version}-r${STOREFRONT_BODY_REVISION}"`);
    expect(await ordersOpen(response)).toBe(true);
    // CP9-AC raised it (features.abandonedCheckout).
    expect(STOREFRONT_BODY_REVISION).toBe(3);
  });

  it("an account that stops taking charges (no catalog bump): closed, a new ETag, never a stale 304", async () => {
    const version = await catalogVersion(ready.tenantId);
    const openTag = `"${version}-r${STOREFRONT_BODY_REVISION}"`;
    await env.DB.prepare("UPDATE tenants SET stripe_charges_enabled = 0 WHERE tenant_id = ?").bind(ready.tenantId).run();
    expect(await catalogVersion(ready.tenantId), "the account columns bump nothing").toBe(version);

    const closed = await storefront(ready, { "if-none-match": openTag });
    expect(closed.status).toBe(200);
    expect(closed.headers.get("etag")).toBe(`"${version}-r${STOREFRONT_BODY_REVISION}-x"`);
    expect(await ordersOpen(closed)).toBe(false);
    const again = await storefront(ready, { "if-none-match": `"${version}-r${STOREFRONT_BODY_REVISION}-x"` });
    expect(again.status).toBe(304);
    await again.body?.cancel();

    // Back: the closed body is not kept either.
    await env.DB.prepare("UPDATE tenants SET stripe_charges_enabled = 1 WHERE tenant_id = ?").bind(ready.tenantId).run();
    const reopened = await storefront(ready, { "if-none-match": `"${version}-r${STOREFRONT_BODY_REVISION}-x"` });
    expect(reopened.status).toBe(200);
    expect(await ordersOpen(reopened)).toBe(true);
  });

  it("no account at all: closed", async () => {
    const flags = "stripe_charges_enabled = ?2, stripe_payouts_enabled = ?2, stripe_details_submitted = ?2";
    await env.DB.prepare(`UPDATE tenants SET stripe_account_id = ?1, ${flags} WHERE tenant_id = ?3`)
      .bind(null, 0, ready.tenantId)
      .run();
    expect(await ordersOpen(await storefront(ready))).toBe(false);
    await env.DB.prepare(`UPDATE tenants SET stripe_account_id = ?1, ${flags} WHERE tenant_id = ?3`)
      .bind(ready.accountId, 1, ready.tenantId)
      .run();
    expect(await ordersOpen(await storefront(ready))).toBe(true);
  });

  it("the legal gate closed (the readiness): closed, with the account still fine", async () => {
    await expectJson(await adminCall(world, ready, "PUT", SETTINGS, { returnAddress: "" }), 200, "no return address");
    expect(await ordersOpen(await storefront(ready))).toBe(false);
    await expectJson(await adminCall(world, ready, "PUT", SETTINGS, { returnAddress: "Returgatan 1" }), 200, "back");
    expect(await ordersOpen(await storefront(ready))).toBe(true);
  });

  it("an imported adoption without the identity still takes orders (the rule is the act of adopting)", async () => {
    const shop = await createTenant(world, { host: "ob-imported.example.com", shopName: "Importerad", tenantId: "ob-imported" });
    // As the import leaves a shop: adopted, identity never filled.
    await expectJson(await adminCall(world, shop, "PUT", SETTINGS, { storeIdentity: { pickupLocations: [SLICE_PICKUP_LOCATION] } }), 200, "identity gone");
    await env.DB.prepare("UPDATE tenants SET support_email = NULL WHERE tenant_id = ?").bind(shop.tenantId).run();
    expect(await identityMissing(shop)).toEqual(["legalName", "address", "supportEmail"]);
    expect(await ordersOpen(await storefront(shop))).toBe(true);
    expect(Object.keys(SLICE_LEGAL_IDENTITY)).toEqual(["address", "legalName"]);
  });

  it("the terms gate closed by a newer version, which is no write to the shop: closed, never a stale 304", async () => {
    const version = await catalogVersion(ready.tenantId);
    const openTag = `"${version}-r${STOREFRONT_BODY_REVISION}"`;
    expect((await storefront(ready)).headers.get("etag")).toBe(openTag);
    // Two versions after the one it accepted: no D47 grace (the version right
    // before the current one would have been in grace for 14 days).
    for (const [version, ago] of [["2026-10-05", 2_000], ["2026-10-06", 1_000]] as const) {
      await env.DB.prepare(
        `INSERT INTO platform_terms_versions (version, published_at, sha256, created_at)
         VALUES (?, ?, ?, ?)`,
      )
        .bind(version, new Date(Date.now() - ago).toISOString(), "0".repeat(64), new Date().toISOString())
        .run();
    }
    expect(await catalogVersion(ready.tenantId)).toBe(version);
    const closed = await storefront(ready, { "if-none-match": openTag });
    expect(closed.status).toBe(200);
    expect(closed.headers.get("etag")).toBe(`"${version}-r${STOREFRONT_BODY_REVISION}-x"`);
    expect(await ordersOpen(closed)).toBe(false);
  });

});
