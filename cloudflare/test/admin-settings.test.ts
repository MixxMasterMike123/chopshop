import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { STORE_IDENTITY_MAX_BYTES } from "../src/platform/tenant-config";
import {
  ADMIN,
  approveProduct,
  call,
  type CallOptions,
  createPlainProduct,
  publishProduct,
} from "./slice-harness";
import {
  auditCount,
  auditRows,
  expectJson,
  expectOpaque404,
  platform,
  SliceWorld,
  type Tenant,
  tenantWorld,
} from "./tenant-fixtures";

/**
 * CP3-A — the shop admin's store settings (GET / PUT /v1/admin/settings,
 * 0032 tenant_settings): the store identity JSON and the four fields the
 * checkout gate reads. Tenant from X-Shop-Id; acting-as admitted; nothing in
 * tenant_settings ever reaches a public response.
 */

interface SettingsBody {
  settings: {
    returnAddress: string | null;
    sellerType: string | null;
    storeIdentity: Record<string, unknown>;
    updatedAt: string | null;
    vatNumber: string | null;
    vatRegistered: boolean | null;
  };
}

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let shopC: Tenant;

function settingsCall(tenant: Tenant, method: string, body?: unknown, options: CallOptions = {}) {
  return call(world, method, `${ADMIN}/v1/admin/settings`, {
    body,
    cookie: tenant.adminCookie,
    shopId: tenant.tenantId,
    ...options,
  });
}

async function readSettings(tenant: Tenant): Promise<SettingsBody["settings"]> {
  return (await expectJson<SettingsBody>(await settingsCall(tenant, "GET"), 200, "read settings")).settings;
}

async function rawSettingsRow(tenantId: string) {
  return env.DB.prepare("SELECT * FROM tenant_settings WHERE tenant_id = ?").bind(tenantId).first();
}

beforeAll(async () => {
  const setup = await tenantWorld("as", 3);
  world = setup.world;
  [shopA, shopB, shopC] = setup.tenants as [Tenant, Tenant, Tenant];
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("read and write", () => {
  it("answers an empty identity with every gate field unanswered before the first write", async () => {
    expect(await readSettings(shopA)).toEqual({
      returnAddress: null,
      sellerType: null,
      storeIdentity: {},
      updatedAt: null,
      vatNumber: null,
      vatRegistered: null,
    });
  });

  it("writes the identity and the gate fields, trimmed, and reads them back", async () => {
    const identity = {
      accent: "#0E5E63",
      heroHeadline: "Tryck på beställning",
      legal: { custom: { terms: false } },
      menu: [{ label: "Nyheter", target: "news", type: "collection" }],
      pickupLocations: [{ address: "Storgatan 1", dates: ["2026-10-01"], id: "p1", name: "Butiken" }],
      social: { instagram: "https://instagram.test/shop" },
      theme: { colors: { accent: "#123456" }, layout: { gridCols: 3 } },
    };
    const written = await expectJson<SettingsBody>(
      await settingsCall(shopA, "PUT", {
        returnAddress: "  Butik AB\nReturgatan 1\n123 45 Staden  ",
        sellerType: "company",
        storeIdentity: identity,
        vatNumber: " SE556677889901 ",
        vatRegistered: true,
      }),
      200,
      "write",
    );
    expect(written.settings).toEqual({
      returnAddress: "Butik AB\nReturgatan 1\n123 45 Staden",
      sellerType: "company",
      storeIdentity: identity,
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      vatNumber: "SE556677889901",
      vatRegistered: true,
    });
    expect(await readSettings(shopA)).toEqual(written.settings);
    expect(await rawSettingsRow(shopA.tenantId)).toMatchObject({
      return_address: "Butik AB\nReturgatan 1\n123 45 Staden",
      seller_type: "company",
      updated_by: shopA.adminUserId,
      vat_number: "SE556677889901",
      vat_registered: 1,
    });

    const [audit] = await auditRows(shopA.tenantId, "tenant.settings_update");
    expect(audit).toEqual({
      action: "tenant.settings_update",
      actorUserId: shopA.adminUserId,
      metadata: { fields: ["storeIdentity", "returnAddress", "vatRegistered", "vatNumber", "sellerType"] },
      reason: null,
      resourceId: shopA.tenantId,
      resourceType: "tenant_settings",
      tenantId: shopA.tenantId,
    });
  });

  it("replaces only the fields a PUT names; the identity object is replaced whole", async () => {
    const written = await expectJson<SettingsBody>(
      await settingsCall(shopA, "PUT", { storeIdentity: { accent: "#000000" }, vatRegistered: false }),
      200,
      "partial",
    );
    expect(written.settings).toMatchObject({
      returnAddress: "Butik AB\nReturgatan 1\n123 45 Staden",
      sellerType: "company",
      storeIdentity: { accent: "#000000" },
      vatNumber: "SE556677889901",
      vatRegistered: false,
    });
  });

  it("'' and null clear the text fields; null returns vatRegistered to unanswered", async () => {
    const written = await expectJson<SettingsBody>(
      await settingsCall(shopA, "PUT", { returnAddress: "  ", sellerType: "", vatNumber: null, vatRegistered: null }),
      200,
      "clear",
    );
    expect(written.settings).toMatchObject({
      returnAddress: null,
      sellerType: null,
      vatNumber: null,
      vatRegistered: null,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("refused identity keys", () => {
  it.each([
    [{ shopName: "Egen" }, ["shopName"]],
    [{ supportEmail: "a@b.test" }, ["supportEmail"]],
    [{ payments: { commissionBps: 0 } }, ["payments"]],
    [{ commissionBps: 0 }, ["commissionBps"]],
    [{ stripeAccountId: "acct_x" }, ["stripeAccountId"]],
    [{ features: { pod: true } }, ["features"]],
    [{ platformTerms: { version: "2026-09-07" } }, ["platformTerms"]],
    [{ legal: { acceptance: { acceptedAt: "2026-09-01T00:00:00.000Z" }, custom: {} } }, ["legal.acceptance"]],
    [{ returnAddress: "x" }, ["returnAddress"]],
    [{ vatRegistered: true }, ["vatRegistered"]],
    [{ vatNumber: "SE1" }, ["vatNumber"]],
    [{ sellerType: "company" }, ["sellerType"]],
    [{ published: true, status: "active" }, ["published", "status"]],
    [{ currency: "EUR", vatRate: 0.12 }, ["currency", "vatRate"]],
    [{ shopId: "as-b", tenantId: "as-b" }, ["shopId", "tenantId"]],
  ])("refuses %j with the key names, writing nothing", async (identity, keys) => {
    const before = await rawSettingsRow(shopB.tenantId);
    const audits = await auditCount();
    const body = await expectJson<{ error: { code: string; keys: string[] } }>(
      await settingsCall(shopB, "PUT", { storeIdentity: { accent: "#fff", ...identity } }),
      400,
      "refused",
    );
    expect(body.error.code).toBe("refused_store_identity_keys");
    expect(body.error.keys.sort()).toEqual([...keys].sort());
    expect(await rawSettingsRow(shopB.tenantId)).toEqual(before);
    expect(await auditCount()).toBe(audits);
  });

  it("never returns a refused key a non-route writer (the importer, a hand fix) stored", async () => {
    await env.DB.prepare(
      `INSERT INTO tenant_settings (tenant_id, store_identity_json, updated_at, updated_by)
       VALUES (?, ?, '2026-09-27T00:00:00.000Z', 'import')`,
    )
      .bind(
        shopC.tenantId,
        JSON.stringify({
          accent: "#abcdef",
          commissionBps: 250,
          legal: { acceptance: { uid: "x" }, custom: { terms: true } },
          payments: { commissionBps: 250, stripeAccountId: "acct_hidden" },
          shopName: "Importerad",
        }),
      )
      .run();
    const settings = await readSettings(shopC);
    expect(settings.storeIdentity).toEqual({ accent: "#abcdef", legal: { custom: { terms: true } } });
    expect(JSON.stringify(settings)).not.toMatch(/commission|acct_|payments|acceptance/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("validation", () => {
  function identityOfBytes(bytes: number, filler = "x"): Record<string, string> {
    const overhead = JSON.stringify({ a: "" }).length;
    return { a: filler.repeat(bytes - overhead) };
  }

  function nested(depth: number): Record<string, unknown> {
    let value: Record<string, unknown> = { leaf: 1 };
    for (let level = 1; level < depth; level += 1) {
      value = { next: value };
    }
    return value;
  }

  it(`accepts an identity of exactly ${STORE_IDENTITY_MAX_BYTES} UTF-8 bytes and refuses one byte more`, async () => {
    await expectJson(
      await settingsCall(shopB, "PUT", { storeIdentity: identityOfBytes(STORE_IDENTITY_MAX_BYTES) }),
      200,
      "at the cap",
    );
    await expectJson(
      await settingsCall(shopB, "PUT", { storeIdentity: identityOfBytes(STORE_IDENTITY_MAX_BYTES + 1) }),
      400,
      "over the cap",
    );
  });

  it("counts bytes, not characters", async () => {
    // 2-byte characters: under the cap in characters, over it in bytes.
    const identity = { a: "å".repeat(STORE_IDENTITY_MAX_BYTES / 2) };
    expect(JSON.stringify(identity).length).toBeLessThan(STORE_IDENTITY_MAX_BYTES);
    await expectJson(await settingsCall(shopB, "PUT", { storeIdentity: identity }), 400, "multi-byte");
  });

  it("accepts nesting 8 levels deep and refuses 9", async () => {
    await expectJson(await settingsCall(shopB, "PUT", { storeIdentity: nested(8) }), 200, "depth 8");
    await expectJson(await settingsCall(shopB, "PUT", { storeIdentity: nested(9) }), 400, "depth 9");
  });

  it.each([
    ["an empty body", {}],
    ["a non-object body", ["x"]],
    ["an unknown top-level key", { published: true }],
    ["an identity that is an array", { storeIdentity: [] }],
    ["an identity that is a string", { storeIdentity: "{}" }],
    ["a null identity", { storeIdentity: null }],
    ["vatRegistered as text", { vatRegistered: "yes" }],
    ["vatRegistered as a number", { vatRegistered: 1 }],
    ["an unknown seller type", { sellerType: "nonprofit" }],
    ["a VAT number with a newline", { vatNumber: "SE1\n2" }],
    ["a long VAT number", { vatNumber: "S".repeat(65) }],
    ["a long return address", { returnAddress: "r".repeat(1001) }],
    ["a return address with a control character", { returnAddress: "Gatan\u00001" }],
    ["a numeric return address", { returnAddress: 12345 }],
  ])("refuses %s", async (_label, body) => {
    const before = await rawSettingsRow(shopB.tenantId);
    await expectJson(await settingsCall(shopB, "PUT", body), 400, "invalid");
    expect(await rawSettingsRow(shopB.tenantId)).toEqual(before);
  });

  it("refuses a malformed JSON body and a missing one", async () => {
    const malformed = await worker.fetch(
      new Request(`${ADMIN}/v1/admin/settings`, {
        body: "{not json",
        headers: {
          "content-type": "application/json",
          cookie: shopB.adminCookie,
          origin: ADMIN,
          "x-shop-id": shopB.tenantId,
        },
        method: "PUT",
      }),
      world.env,
    );
    await expectJson(malformed, 400, "malformed");
    await expectJson(await settingsCall(shopB, "PUT"), 400, "no body");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("who may read and write", () => {
  it("anonymous callers and cross-origin or origin-less writes get the opaque 404", async () => {
    const before = await auditCount();
    await expectOpaque404(await call(world, "GET", `${ADMIN}/v1/admin/settings`, { shopId: shopA.tenantId }), "anon GET");
    await expectOpaque404(
      await call(world, "PUT", `${ADMIN}/v1/admin/settings`, { body: { vatRegistered: true }, shopId: shopA.tenantId }),
      "anon PUT",
    );
    for (const origin of ["https://evil.test", null]) {
      await expectOpaque404(
        await settingsCall(shopA, "PUT", { vatRegistered: true }, { origin }),
        `PUT origin=${origin}`,
      );
    }
    await expectOpaque404(await settingsCall(shopA, "GET", undefined, { shopId: undefined }), "no X-Shop-Id");
    await expectOpaque404(await settingsCall(shopA, "DELETE"), "DELETE");
    expect(await auditCount()).toBe(before);
  });

  it("another shop's admin can neither read nor write this shop's settings", async () => {
    await expectJson(
      await settingsCall(shopA, "PUT", { returnAddress: "A:s hemliga adress", storeIdentity: { accent: "#a" } }),
      200,
      "A writes",
    );
    const before = await rawSettingsRow(shopA.tenantId);

    const asB = { cookie: shopB.adminCookie, shopId: shopA.tenantId };
    await expectOpaque404(await call(world, "GET", `${ADMIN}/v1/admin/settings`, asB), "B reads A");
    await expectOpaque404(
      await call(world, "PUT", `${ADMIN}/v1/admin/settings`, { ...asB, body: { returnAddress: "Kapad" } }),
      "B writes A",
    );
    expect(await rawSettingsRow(shopA.tenantId)).toEqual(before);

    // B's own settings are B's: nothing of A's leaks through X-Shop-Id = B.
    expect(JSON.stringify(await readSettings(shopB))).not.toContain("hemliga");
  });

  it("a platform session without an acting-as grant is refused; with one it reads and writes, audited with the grant", async () => {
    const asPlatform = { cookie: world.platformCookie, shopId: shopB.tenantId };
    await expectOpaque404(await call(world, "GET", `${ADMIN}/v1/admin/settings`, asPlatform), "no grant");

    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/acting-as`, { body: { reason: "support" } }),
      201,
      "acting-as grant",
    );
    const grant = await env.DB.prepare(
      "SELECT id FROM acting_as_grants WHERE tenant_id = ? AND platform_user_id = ? AND revoked_at IS NULL",
    )
      .bind(shopB.tenantId, world.platformUserId)
      .first<{ id: string }>();
    expect(grant).not.toBeNull();

    await expectJson<SettingsBody>(await call(world, "GET", `${ADMIN}/v1/admin/settings`, asPlatform), 200, "read");
    const written = await expectJson<SettingsBody>(
      await call(world, "PUT", `${ADMIN}/v1/admin/settings`, {
        ...asPlatform,
        body: { returnAddress: "Rättad av support", vatRegistered: true },
      }),
      200,
      "write",
    );
    expect(written.settings).toMatchObject({ returnAddress: "Rättad av support", vatRegistered: true });
    expect((await rawSettingsRow(shopB.tenantId))?.updated_by).toBe(world.platformUserId);

    const audits = await auditRows(shopB.tenantId, "tenant.settings_update");
    expect(audits.at(-1)).toMatchObject({
      actorUserId: world.platformUserId,
      metadata: { actingAsGrantId: grant?.id, fields: ["returnAddress", "vatRegistered"] },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("nothing in tenant_settings reaches a public response", () => {
  it("the storefront, the product list and the product page carry none of it", async () => {
    const marker = "cp3a-private-7f3a";
    const productId = await createPlainProduct(world, shopC, { name: "Mössa", priceMinor: 19_900, sku: "AS-HAT" });
    await publishProduct(world, shopC, productId);
    await approveProduct(world, productId);

    await expectJson(
      await settingsCall(shopC, "PUT", {
        returnAddress: `Retur ${marker}`,
        sellerType: "individual",
        storeIdentity: { heroHeadline: `Hero ${marker}`, pickupLocations: [{ address: marker, id: "p" }] },
        vatNumber: `SE${marker}`,
        vatRegistered: true,
      }),
      200,
      "write",
    );

    for (const path of ["/v1/storefront", "/v1/products", `/v1/products/${productId}`]) {
      const response = await call(world, "GET", `${shopC.origin}${path}`);
      const text = await response.text();
      expect(response.status, `${path}: ${text.slice(0, 200)}`).toBe(200);
      expect(text, path).not.toContain(marker);
      expect(text, path).not.toMatch(/storeIdentity|returnAddress|vatRegistered|sellerType/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the 0032 schema", () => {
  const iso = "2026-09-27T00:00:00.000Z";

  it.each([
    ["an identity that is not an object", "store_identity_json", "[]"],
    ["an identity that is not JSON", "store_identity_json", "{nope"],
    ["an identity over 65 536 characters", "store_identity_json", JSON.stringify({ a: "x".repeat(65_536) })],
    ["vat_registered 2", "vat_registered", 2],
    ["an unknown seller type", "seller_type", "nonprofit"],
    ["an empty return address", "return_address", ""],
    ["a non-ISO updated_at", "updated_at", "2026-09-27 00:00:00"],
    ["an empty updated_by", "updated_by", ""],
  ])("refuses %s", async (_label, column, value) => {
    const row: Record<string, unknown> = {
      store_identity_json: "{}",
      tenant_id: "as-schema",
      updated_at: iso,
      updated_by: "test",
      [column]: value,
    };
    await env.DB.prepare(
      `INSERT OR IGNORE INTO tenants (tenant_id, status, shop_name, created_at, updated_at)
       VALUES ('as-schema', 'active', 'Schema', 1, 1)`,
    ).run();
    const columns = Object.keys(row);
    await expect(
      env.DB.prepare(
        `INSERT INTO tenant_settings (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
        .bind(...Object.values(row))
        .run(),
    ).rejects.toThrow();
  });

  it("refuses a row for a tenant that does not exist and a change of tenant_id", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO tenant_settings (tenant_id, updated_at, updated_by) VALUES ('as-nobody', ?, 'test')`,
      )
        .bind(iso)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      env.DB.prepare("UPDATE tenant_settings SET tenant_id = ? WHERE tenant_id = ?")
        .bind(shopB.tenantId, shopA.tenantId)
        .run(),
    ).rejects.toThrow(/tenant_id is immutable/);
  });
});
