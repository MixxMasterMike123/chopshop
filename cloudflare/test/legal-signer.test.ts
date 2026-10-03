import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isCheckoutLegallyOpen } from "../src/legal/legal-pages";
import { BUYER_RECIPIENT_PICKUP, CURRENT_TERMS_VERSION } from "./legal-fixtures";
import {
  adminCall,
  approveProduct,
  bootstrapPlatform,
  call,
  ADMIN,
  PLATFORM,
  createPlainProduct,
  createTenant,
  expectJson,
  platformCall,
  publishProduct,
  SliceWorld,
  storefrontCall,
  type Tenant,
  unique,
} from "./slice-harness";

/**
 * CP5-WJ items 1 and 3:
 *
 *   1. the legal status (`latestAcceptance`) and the adoption read
 *      (`acceptedBy`) name WHO signed and WHEN — a person of the shop by name
 *      and address; a platform user to the shop only as "the platform";
 *   3. the platform's shop detail carries `legal`: the checkout's own legal
 *      gate (ONE predicate, legal-pages.ts readLegalCheckoutGate) and who
 *      signed what — and it agrees with what a real checkout does.
 */

const world = new SliceWorld();
let ready: Tenant;
let fresh: Tenant;
let imported: Tenant;
let legacy: Tenant;
let mug = "";
let blankMug = "";

const PLATFORM_EMAIL = "platform@slice.test";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Signer {
  email: string | null;
  kind: string;
  name: string | null;
}

interface DetailLegal {
  checkoutOpen: boolean;
  pagesAdoption: { acceptedAt: string; acceptedBy: Signer; pages: string[]; templateVersion: string | null } | null;
  readiness: { legalPagesAccepted: boolean; ready: boolean; returnAddress: boolean; vatAnswered: boolean };
  terms: {
    acceptedCurrent: boolean;
    currentVersion: string | null;
    gateOpen: boolean;
    graceDeadline: string | null;
    inGrace: boolean;
    latestAcceptance: { acceptedAt: string; acceptedBy: Signer; version: string } | null;
  };
}

async function detailLegal(tenant: Tenant): Promise<DetailLegal> {
  const body = await expectJson<{ legal: DetailLegal; settings: { returnAddressSet: boolean } }>(
    await platformCall(world, "GET", `/v1/platform/tenants/${tenant.tenantId}`),
    200,
    `detail ${tenant.tenantId}`,
  );
  return body.legal;
}

async function checkout(tenant: Tenant, productId: string): Promise<number> {
  const response = await storefrontCall(world, tenant, "POST", "/v1/checkout", {
    body: {
      consent: { terms: true },
      deliveryMethod: "pickup",
      email: `${unique("buyer")}@buyers.signer.test`,
      idempotencyKey: unique("idem-signer"),
      items: [{ productId, quantity: 1 }],
      recipient: BUYER_RECIPIENT_PICKUP,
    },
    origin: null,
  });
  await response.body?.cancel();
  return response.status;
}

beforeAll(async () => {
  await bootstrapPlatform(world);
  // Made ready through the seller's routes, terms accepted by its admin.
  ready = await createTenant(world, { host: "signer-ready.example.com", shopName: "Signer Klar", tenantId: "signer-ready" });
  // Nothing answered, nothing adopted, nothing accepted.
  fresh = await createTenant(world, {
    acceptTerms: false,
    host: "signer-fresh.example.com",
    legallyReady: false,
    shopName: "Signer Ny",
    tenantId: "signer-fresh",
  });
  // Ready, but its evidence is IMPORTED and signed by accounts that are not
  // the shop's (rows written below).
  imported = await createTenant(world, {
    acceptTerms: false,
    host: "signer-import.example.com",
    shopName: "Signer Import",
    tenantId: "signer-import",
  });
  legacy = await createTenant(world, {
    acceptTerms: false,
    host: "signer-legacy.example.com",
    legallyReady: false,
    shopName: "Signer Arv",
    tenantId: "signer-legacy",
  });
  mug = await createPlainProduct(world, ready, { name: "Mugg", priceMinor: 14_900, sku: "SIGNER-MUG" });
  blankMug = await createPlainProduct(world, imported, { name: "Mugg", priceMinor: 14_900, sku: "SIGNER-BLANK" });
  for (const [shop, productId] of [
    [ready, mug],
    [imported, blankMug],
  ] as const) {
    await publishProduct(world, shop, productId);
    await approveProduct(world, productId);
  }

  // The imported shop: a platform-terms acceptance and a later legal-pages
  // adoption, both signed by the PLATFORM user (a carried Firebase uid), and
  // an older adoption whose uid was not carried (user_id NULL, address kept).
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO platform_terms_acceptances (id, tenant_id, user_id, terms_version, accepted_at, evidence_json)
       VALUES (?, ?, ?, ?, ?, '{}')`,
    ).bind(crypto.randomUUID(), imported.tenantId, world.platformUserId, CURRENT_TERMS_VERSION, new Date(now).toISOString()),
    env.DB.prepare(
      `INSERT INTO legal_acceptances (
         acceptance_id, tenant_id, type, user_id, legacy_uid, email, accepted_at,
         template_version, texts_json, texts_sha256, source
       ) VALUES (?, ?, 'legalPages', NULL, 'legacy-gone', 'former@signer-import.example.com',
                 '2030-01-01T00:00:00.000Z', '2026-08-01', '{"kopvillkor":"<p>K</p>"}', ?, 'import')`,
    ).bind("legacy_unmapped", imported.tenantId, "a".repeat(64)),
    env.DB.prepare(
      `INSERT INTO legal_acceptances (
         acceptance_id, tenant_id, type, user_id, legacy_uid, email, accepted_at,
         template_version, texts_json, texts_sha256, source
       ) VALUES (?, ?, 'legalPages', ?, 'legacy-platform', ?, '2030-02-01T00:00:00.000Z', '2026-09-07',
                 '{"angerratt":"<p>A</p>","integritetspolicy":"<p>I</p>","kopvillkor":"<p>K</p>"}', ?, 'import')`,
    ).bind("legacy_platform", imported.tenantId, world.platformUserId, PLATFORM_EMAIL, "b".repeat(64)),
  ]);
}, 90_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("item 1 — the signer and the time, as the shop sees them", () => {
  it("the shop's own admin is named by name and address; the time is the server's", async () => {
    const status = await expectJson<{ acceptedAt: string; latestAcceptance: unknown }>(
      await adminCall(world, ready, "GET", "/v1/admin/legal/status"),
      200,
      "status",
    );
    expect(status.latestAcceptance).toEqual({
      acceptedAt: status.acceptedAt,
      acceptedBy: { email: `admin@${ready.host}`, kind: "admin", name: "admin" },
      version: CURRENT_TERMS_VERSION,
    });
    const pages = await expectJson<{ acceptance: { acceptedAt: string; acceptedBy: Signer } }>(
      await adminCall(world, ready, "GET", "/v1/admin/legal/pages"),
      200,
      "pages",
    );
    expect(pages.acceptance.acceptedAt).toMatch(ISO);
    expect(pages.acceptance.acceptedBy).toEqual({ email: `admin@${ready.host}`, kind: "admin", name: "admin" });
  });

  it("a platform user who signed is named to the shop as the platform, never by its address — also to an acting-as reader", async () => {
    const own = await adminCall(world, imported, "GET", "/v1/admin/legal/status");
    const ownText = await own.clone().text();
    const status = await expectJson<{ latestAcceptance: { acceptedBy: Signer; version: string } }>(own, 200, "status");
    expect(status.latestAcceptance.acceptedBy).toEqual({ email: null, kind: "platform", name: null });
    expect(status.latestAcceptance.version).toBe(CURRENT_TERMS_VERSION);

    const pagesResponse = await adminCall(world, imported, "GET", "/v1/admin/legal/pages");
    const pagesText = await pagesResponse.clone().text();
    const pages = await expectJson<{ acceptance: { acceptanceId: string; acceptedAt: string; acceptedBy: Signer } }>(
      pagesResponse,
      200,
      "pages",
    );
    expect(pages.acceptance).toMatchObject({
      acceptanceId: "legacy_platform",
      acceptedAt: "2030-02-01T00:00:00.000Z",
      acceptedBy: { email: null, kind: "platform", name: null },
    });
    for (const text of [ownText, pagesText]) {
      expect(text).not.toContain(PLATFORM_EMAIL);
      expect(text).not.toContain("Slice Platform");
      expect(text).not.toContain(world.platformUserId);
    }

    // The platform user acting as the shop reads what the shop reads.
    await expectJson(
      await platformCall(world, "POST", `/v1/platform/tenants/${imported.tenantId}/acting-as`, { reason: "support" }),
      201,
      "acting-as grant",
    );
    const asPlatform = await call(world, "GET", `${ADMIN}/v1/admin/legal/pages`, {
      cookie: world.platformCookie,
      shopId: imported.tenantId,
    });
    expect(await asPlatform.text()).toBe(pagesText);
  });

  it("an imported adoption whose uid was not carried is named by the address stored with it", async () => {
    await env.DB.prepare(
      `INSERT INTO legal_acceptances (
         acceptance_id, tenant_id, type, user_id, legacy_uid, email, accepted_at,
         template_version, texts_json, texts_sha256, source
       ) VALUES ('legacy_unmapped_latest', ?, 'legalPages', NULL, 'legacy-gone-2', 'gone@signer-legacy.example.com',
                 '2030-03-01T00:00:00.000Z', '2026-08-01', '{"kopvillkor":"<p>K</p>"}', ?, 'import')`,
    )
      .bind(legacy.tenantId, "c".repeat(64))
      .run();
    const pages = await expectJson<{ acceptance: { acceptedBy: Signer } }>(
      await adminCall(world, legacy, "GET", "/v1/admin/legal/pages"),
      200,
      "pages",
    );
    expect(pages.acceptance.acceptedBy).toEqual({ email: "gone@signer-legacy.example.com", kind: "admin", name: null });
    expect((await detailLegal(legacy)).pagesAdoption).toEqual({
      acceptedAt: "2030-03-01T00:00:00.000Z",
      acceptedBy: { email: "gone@signer-legacy.example.com", kind: "admin", name: null },
      pages: ["kopvillkor"],
      templateVersion: "2026-08-01",
    });
  });

  it("one shop's signer never reaches another shop", async () => {
    const status = await expectJson<{ latestAcceptance: unknown }>(
      await adminCall(world, fresh, "GET", "/v1/admin/legal/status"),
      200,
      "fresh status",
    );
    expect(status.latestAcceptance).toBeNull();
    // Another shop's session naming this shop: the opaque 404.
    const foreign = await call(world, "GET", `${ADMIN}/v1/admin/legal/status`, {
      cookie: ready.adminCookie,
      shopId: imported.tenantId,
    });
    expect(foreign.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("item 3 — the platform detail's legal readiness is the checkout's gate", () => {
  it("a ready shop: every fact true, the signers by person; a real checkout opens", async () => {
    const legal = await detailLegal(ready);
    expect(legal).toEqual({
      checkoutOpen: true,
      pagesAdoption: {
        acceptedAt: expect.stringMatching(ISO),
        acceptedBy: { email: `admin@${ready.host}`, kind: "admin", name: "admin" },
        pages: ["angerratt", "integritetspolicy", "kopvillkor"],
        templateVersion: "2026-09-07",
      },
      readiness: { legalPagesAccepted: true, ready: true, returnAddress: true, vatAnswered: true },
      terms: {
        acceptedCurrent: true,
        currentVersion: CURRENT_TERMS_VERSION,
        gateOpen: true,
        graceDeadline: null,
        inGrace: false,
        latestAcceptance: {
          acceptedAt: expect.stringMatching(ISO),
          acceptedBy: { email: `admin@${ready.host}`, kind: "admin", name: "admin" },
          version: CURRENT_TERMS_VERSION,
        },
      },
    });
    expect(await checkout(ready, mug)).toBe(201);
  });

  it("a fresh shop: nothing adopted or accepted, checkout closed", async () => {
    const legal = await detailLegal(fresh);
    expect(legal).toMatchObject({
      checkoutOpen: false,
      // Other shops' adoptions (later ones too) never reach this shop's view.
      pagesAdoption: null,
      readiness: { legalPagesAccepted: false, ready: false, returnAddress: false, vatAnswered: false },
      terms: { acceptedCurrent: false, gateOpen: false, inGrace: false, latestAcceptance: null },
    });
    expect(await isCheckoutLegallyOpen(env.DB, fresh.tenantId, Date.now())).toBe(false);
  });

  it("the platform sees the platform signer as the person it is", async () => {
    const legal = await detailLegal(imported);
    expect(legal.pagesAdoption).toEqual({
      acceptedAt: "2030-02-01T00:00:00.000Z",
      acceptedBy: { email: PLATFORM_EMAIL, kind: "platform", name: "Slice Platform" },
      pages: ["angerratt", "integritetspolicy", "kopvillkor"],
      templateVersion: "2026-09-07",
    });
    expect(legal.terms.latestAcceptance?.acceptedBy).toEqual({
      email: PLATFORM_EMAIL,
      kind: "platform",
      name: "Slice Platform",
    });
    expect(legal.checkoutOpen).toBe(true);
    expect(await checkout(imported, blankMug)).toBe(201);
  });

  it("ONE predicate: a return address of white space only reads as missing here as at the checkout, though the settings summary says set", async () => {
    await env.DB.prepare("UPDATE tenant_settings SET return_address = ? WHERE tenant_id = ?")
      .bind("  \n ", imported.tenantId)
      .run();
    try {
      const body = await expectJson<{ legal: DetailLegal; settings: { returnAddressSet: boolean } }>(
        await platformCall(world, "GET", `/v1/platform/tenants/${imported.tenantId}`),
        200,
        "detail",
      );
      // The older summary only asks whether a value is stored.
      expect(body.settings.returnAddressSet).toBe(true);
      expect(body.legal.readiness.returnAddress).toBe(false);
      expect(body.legal.checkoutOpen).toBe(false);
      expect(await checkout(imported, blankMug)).toBe(404);
    } finally {
      await env.DB.prepare("UPDATE tenant_settings SET return_address = ? WHERE tenant_id = ?")
        .bind("Testgatan 1, 123 45 Teststad", imported.tenantId)
        .run();
    }
  });

  it("only the platform reads it: a tenant admin gets the opaque 404; a shop's detail never carries another's signer", async () => {
    const asSeller = await call(world, "GET", `${PLATFORM}/v1/platform/tenants/${ready.tenantId}`, {
      cookie: ready.adminCookie,
    });
    expect(asSeller.status).toBe(404);
    const text = JSON.stringify(await detailLegal(fresh));
    expect(text).not.toContain(ready.host);
    expect(text).not.toContain(PLATFORM_EMAIL);
  });
});
