import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { STORE_IDENTITY_MAX_BYTES } from "../src/platform/tenant-config";
import { expectNoCostKeys } from "./pod-fixtures";
import { ADMIN, call, type CallOptions, instrumentedDb } from "./slice-harness";
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
 * CP5-WK, unit WD — PATCH /v1/admin/settings: the top-level identity keys it
 * names are MERGED into the stored identity (each key replaced whole), fenced
 * by `expectedUpdatedAt` (409 when the row moved), with the PUT's validation,
 * guard and audit. Refusals first, then the merge, then the fence's races.
 */

interface Settings {
  returnAddress: string | null;
  sellerType: string | null;
  storeIdentity: Record<string, unknown>;
  updatedAt: string | null;
  vatNumber: string | null;
  vatRegistered: boolean | null;
}

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let shopC: Tenant;
let shopD: Tenant;
let shopE: Tenant;

const URL_PATH = `${ADMIN}/v1/admin/settings`;

function settingsCall(tenant: Tenant, method: string, body?: unknown, options: CallOptions = {}) {
  return call(world, method, URL_PATH, {
    body,
    cookie: tenant.adminCookie,
    shopId: tenant.tenantId,
    ...options,
  });
}

async function read(tenant: Tenant): Promise<Settings> {
  return (await expectJson<{ settings: Settings }>(await settingsCall(tenant, "GET"), 200, "read")).settings;
}

async function patch(tenant: Tenant, body: unknown, options: CallOptions = {}): Promise<Settings> {
  const answer = await expectJson<{ settings: Settings }>(
    await settingsCall(tenant, "PATCH", body, options),
    200,
    `patch ${JSON.stringify(body).slice(0, 120)}`,
  );
  expectNoCostKeys(answer);
  return answer.settings;
}

async function rawRow(tenantId: string) {
  return env.DB.prepare("SELECT * FROM tenant_settings WHERE tenant_id = ?").bind(tenantId).first();
}

async function catalogVersion(tenantId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT catalog_version FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ catalog_version: number }>();
  return row?.catalog_version ?? -1;
}

async function seedRow(tenantId: string, identity: Record<string, unknown>, updatedAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_settings (tenant_id, store_identity_json, updated_at, updated_by)
     VALUES (?, ?, ?, 'seed')
     ON CONFLICT (tenant_id) DO UPDATE SET store_identity_json = excluded.store_identity_json,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(tenantId, JSON.stringify(identity), updatedAt)
    .run();
}

beforeAll(async () => {
  const setup = await tenantWorld("wk", 5);
  world = setup.world;
  [shopA, shopB, shopC, shopD, shopE] = setup.tenants as [Tenant, Tenant, Tenant, Tenant, Tenant];
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("who may PATCH", () => {
  it("anonymous, cross-origin, origin-less, no X-Shop-Id, another shop's admin, a platform user without a grant: the opaque 404, nothing written", async () => {
    await seedRow(shopA.tenantId, { accent: "#111111" }, "2026-10-01T00:00:00.000Z");
    const before = await rawRow(shopA.tenantId);
    const audits = await auditCount();
    const body = { expectedUpdatedAt: "2026-10-01T00:00:00.000Z", storeIdentity: { accent: "#222222" } };

    await expectOpaque404(await call(world, "PATCH", URL_PATH, { body, shopId: shopA.tenantId }), "anonymous");
    for (const origin of ["https://evil.test", null]) {
      await expectOpaque404(await settingsCall(shopA, "PATCH", body, { origin }), `origin=${origin}`);
    }
    await expectOpaque404(await settingsCall(shopA, "PATCH", body, { shopId: undefined }), "no X-Shop-Id");
    await expectOpaque404(
      await call(world, "PATCH", URL_PATH, { body, cookie: shopB.adminCookie, shopId: shopA.tenantId }),
      "another shop's admin",
    );
    await expectOpaque404(
      await call(world, "PATCH", URL_PATH, { body, cookie: world.platformCookie, shopId: shopA.tenantId }),
      "platform without a grant",
    );

    expect(await rawRow(shopA.tenantId)).toEqual(before);
    expect(await auditCount()).toBe(audits);
  });

  it("a platform user with an acting-as grant may PATCH, audited with the grant (as the PUT)", async () => {
    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/acting-as`, { body: { reason: "support" } }),
      201,
      "grant",
    );
    const grant = await env.DB.prepare(
      "SELECT id FROM acting_as_grants WHERE tenant_id = ? AND platform_user_id = ? AND revoked_at IS NULL",
    )
      .bind(shopB.tenantId, world.platformUserId)
      .first<{ id: string }>();
    const asPlatform = { cookie: world.platformCookie, shopId: shopB.tenantId };
    const current = await expectJson<{ settings: Settings }>(await call(world, "GET", URL_PATH, asPlatform), 200, "read");

    const answer = await expectJson<{ settings: Settings }>(
      await call(world, "PATCH", URL_PATH, {
        ...asPlatform,
        body: { expectedUpdatedAt: current.settings.updatedAt, storeIdentity: { accent: "#0E5E63" } },
      }),
      200,
      "acting-as patch",
    );
    expect(answer.settings.storeIdentity).toMatchObject({ accent: "#0E5E63" });
    expect((await rawRow(shopB.tenantId))?.updated_by).toBe(world.platformUserId);
    expect((await auditRows(shopB.tenantId, "tenant.settings_update")).at(-1)).toMatchObject({
      actorUserId: world.platformUserId,
      metadata: { actingAsGrantId: grant?.id, fields: ["storeIdentity"], identityKeys: ["accent"] },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the body", () => {
  const T = "2026-10-01T00:00:00.000Z";

  it.each([
    ["no expectedUpdatedAt", { storeIdentity: { accent: "#fff" } }],
    ["expectedUpdatedAt without milliseconds", { expectedUpdatedAt: "2026-10-01T00:00:00Z", storeIdentity: { a: 1 } }],
    ["expectedUpdatedAt as a number", { expectedUpdatedAt: 1, storeIdentity: { a: 1 } }],
    ["expectedUpdatedAt as words", { expectedUpdatedAt: "yesterday", storeIdentity: { a: 1 } }],
    ["nothing to change", { expectedUpdatedAt: T }],
    ["an empty identity patch and nothing else", { expectedUpdatedAt: T, storeIdentity: {} }],
    ["an identity that is an array", { expectedUpdatedAt: T, storeIdentity: [] }],
    ["an identity that is null", { expectedUpdatedAt: T, storeIdentity: null }],
    ["an unknown top-level key", { expectedUpdatedAt: T, published: true }],
    ["a bad gate field", { expectedUpdatedAt: T, vatRegistered: "yes" }],
    ["a malformed image key", { expectedUpdatedAt: T, storeIdentity: { logoObjectId: "not an id!" } }],
    ["nesting 9 deep", { expectedUpdatedAt: T, storeIdentity: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } } }],
    ["a body that is an array", [{ expectedUpdatedAt: T }]],
  ])("refuses %s with 400, writing nothing", async (_label, body) => {
    await seedRow(shopC.tenantId, { accent: "#123123" }, T);
    const before = await rawRow(shopC.tenantId);
    const audits = await auditCount();
    expect(await expectJson(await settingsCall(shopC, "PATCH", body), 400, "invalid")).toEqual({
      error: { code: "invalid_request", message: "Request is not valid" },
    });
    expect(await rawRow(shopC.tenantId)).toEqual(before);
    expect(await auditCount()).toBe(audits);
  });

  it("a malformed JSON body is a 400", async () => {
    await expectJson(
      await settingsCall(shopC, "PATCH", undefined, { rawBody: '{"expectedUpdatedAt": null, "storeIdentity": {' }),
      400,
      "malformed",
    );
  });

  it.each([
    [{ shopName: "Egen" }, ["shopName"]],
    [{ payments: { commissionBps: 0 } }, ["payments"]],
    [{ commissionBps: 0, supportEmail: "a@b.test" }, ["commissionBps", "supportEmail"]],
    [{ legal: { acceptance: { at: "x" }, custom: {} } }, ["legal.acceptance"]],
    [{ returnAddress: "x" }, ["returnAddress"]],
    [{ gallery: [{ imageUrl: "https://storage.googleapis.com/bucket/y.png" }] }, ["gallery[0].imageUrl"]],
  ])("refuses the identity keys %j by name (as the PUT), writing nothing", async (identity, keys) => {
    await seedRow(shopC.tenantId, { accent: "#123123" }, T);
    const before = await rawRow(shopC.tenantId);
    const body = await expectJson<{ error: { code: string; keys: string[] } }>(
      await settingsCall(shopC, "PATCH", { expectedUpdatedAt: T, storeIdentity: identity }),
      400,
      "refused",
    );
    expect(body.error.code).toBe("refused_store_identity_keys");
    expect([...body.error.keys].sort()).toEqual([...keys].sort());
    expect(await rawRow(shopC.tenantId)).toEqual(before);
  });

  it("refuses an image the PATCHED keys name that this shop cannot use, naming its path", async () => {
    await seedRow(shopC.tenantId, { accent: "#123123" }, T);
    const before = await rawRow(shopC.tenantId);
    expect(
      await expectJson(
        await settingsCall(shopC, "PATCH", {
          expectedUpdatedAt: T,
          storeIdentity: { gallery: [{ imageObjectId: "no-such-object" }], heroObjectId: "22222222-2222-4222-8222-222222222222" },
        }),
        400,
        "unreferencable",
      ),
    ).toEqual({
      error: {
        code: "unreferencable_images",
        keys: ["heroObjectId", "gallery[0].imageObjectId"],
        message: "The store identity names an image this shop cannot use",
      },
    });
    expect(await rawRow(shopC.tenantId)).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the fence", () => {
  it("answers 409 with what is stored now when expectedUpdatedAt is not the row's, writing nothing", async () => {
    await seedRow(shopD.tenantId, { accent: "#aaaaaa", heroHeadline: "Hej" }, "2026-10-02T08:00:00.000Z");
    const before = await rawRow(shopD.tenantId);
    const audits = await auditCount();

    for (const expectedUpdatedAt of ["2026-10-02T07:59:59.999Z", "2026-10-02T08:00:00.001Z", null]) {
      const body = await expectJson<{ error: { code: string; message: string }; settings: Settings }>(
        await settingsCall(shopD, "PATCH", { expectedUpdatedAt, storeIdentity: { accent: "#bbbbbb" } }),
        409,
        `stale ${expectedUpdatedAt}`,
      );
      expect(body.error).toEqual({
        code: "conflict",
        message: "The settings changed since they were read; read them again and retry",
      });
      expect(body.settings).toEqual(await read(shopD));
      expect(body.settings.storeIdentity).toEqual({ accent: "#aaaaaa", heroHeadline: "Hej" });
      expectNoCostKeys(body);
    }
    expect(await rawRow(shopD.tenantId)).toEqual(before);
    expect(await auditCount()).toBe(audits);
  });

  it("a shop with no settings row: expectedUpdatedAt null creates it; a string is stale", async () => {
    expect((await read(shopE)).updatedAt).toBeNull();
    await expectJson(
      await settingsCall(shopE, "PATCH", { expectedUpdatedAt: "2026-10-02T08:00:00.000Z", storeIdentity: { a: 1 } }),
      409,
      "a time for a row that does not exist",
    );
    expect(await rawRow(shopE.tenantId)).toBeNull();

    const written = await patch(shopE, { expectedUpdatedAt: null, storeIdentity: { accent: "#010101" }, vatRegistered: false });
    expect(written).toMatchObject({ storeIdentity: { accent: "#010101" }, vatRegistered: false, returnAddress: null });
    expect(written.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await rawRow(shopE.tenantId))?.updated_by).toBe(shopE.adminUserId);

    // A second "no row yet" PATCH is stale now: the first one created it.
    await expectJson(
      await settingsCall(shopE, "PATCH", { expectedUpdatedAt: null, storeIdentity: { accent: "#020202" } }),
      409,
      "null after the row exists",
    );
    expect((await read(shopE)).storeIdentity).toEqual({ accent: "#010101" });
  });

  it("a write that lands between the PATCH's read and its batch makes the PATCH a 409 with nothing of it written", async () => {
    await seedRow(shopD.tenantId, { accent: "#aaaaaa", menu: [] }, "2026-10-02T09:00:00.000Z");
    const audits = await auditCount();
    let fired = false;
    const instrumented = instrumentedDb(async (op) => {
      if (!fired && op.kind === "batch" && op.sql.some((sql) => sql.includes("UPDATE tenant_settings"))) {
        fired = true;
        // Another tab's PUT, committed first.
        await env.DB.prepare(
          `UPDATE tenant_settings SET store_identity_json = ?, updated_at = '2026-10-02T09:00:00.500Z'
           WHERE tenant_id = ?`,
        )
          .bind(JSON.stringify({ accent: "#aaaaaa", menu: [{ label: "Nytt" }] }), shopD.tenantId)
          .run();
      }
    });

    const body = await expectJson<{ settings: Settings }>(
      await settingsCall(
        shopD,
        "PATCH",
        { expectedUpdatedAt: "2026-10-02T09:00:00.000Z", storeIdentity: { accent: "#cccccc" } },
        { env: world.with({ DB: instrumented.db }) },
      ),
      409,
      "interleaved",
    );
    expect(fired).toBe(true);
    // The other write stands, whole; the PATCH wrote nothing and audited nothing.
    expect(body.settings.storeIdentity).toEqual({ accent: "#aaaaaa", menu: [{ label: "Nytt" }] });
    expect(body.settings.updatedAt).toBe("2026-10-02T09:00:00.500Z");
    expect(await auditCount()).toBe(audits);

    // Re-read and re-apply: the merge keeps the other write's menu.
    const again = await patch(shopD, { expectedUpdatedAt: body.settings.updatedAt, storeIdentity: { accent: "#cccccc" } });
    expect(again.storeIdentity).toEqual({ accent: "#cccccc", menu: [{ label: "Nytt" }] });
  });

  it("a second creating PATCH racing the first (no row at read) writes nothing", async () => {
    await env.DB.prepare("DELETE FROM tenant_settings WHERE tenant_id = ?").bind(shopE.tenantId).run();
    let fired = false;
    const instrumented = instrumentedDb(async (op) => {
      if (!fired && op.kind === "batch" && op.sql.some((sql) => sql.includes("INSERT INTO tenant_settings"))) {
        fired = true;
        await seedRow(shopE.tenantId, { accent: "#first" }, "2026-10-02T10:00:00.000Z");
      }
    });
    const audits = await auditCount();
    await expectJson(
      await settingsCall(
        shopE,
        "PATCH",
        { expectedUpdatedAt: null, storeIdentity: { accent: "#second" } },
        { env: world.with({ DB: instrumented.db }) },
      ),
      409,
      "create raced",
    );
    expect(fired).toBe(true);
    expect((await read(shopE)).storeIdentity).toEqual({ accent: "#first" });
    expect(await auditCount()).toBe(audits);
  });

  it("every write moves updatedAt strictly forward, even when the clock is behind the stored time (PUT and PATCH)", async () => {
    // A stored time far ahead of the clock (a clock that stepped back, or two writes in one millisecond).
    await seedRow(shopD.tenantId, { accent: "#aaaaaa" }, "2099-12-31T23:59:59.999Z");
    const put = await expectJson<{ settings: Settings }>(
      await settingsCall(shopD, "PUT", { storeIdentity: { accent: "#bbbbbb" } }),
      200,
      "put",
    );
    expect(put.settings.updatedAt).toBe("2100-01-01T00:00:00.000Z");

    const patched = await patch(shopD, { expectedUpdatedAt: "2100-01-01T00:00:00.000Z", storeIdentity: { accent: "#cccccc" } });
    expect(patched.updatedAt).toBe("2100-01-01T00:00:00.001Z");

    // A PATCH that read the PUT's time before it moved again is stale.
    await expectJson(
      await settingsCall(shopD, "PATCH", { expectedUpdatedAt: "2100-01-01T00:00:00.000Z", storeIdentity: { a: 1 } }),
      409,
      "the PUT's time after the PATCH moved it",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("what merge means: each named top-level key replaced whole", () => {
  it("replaces the named keys (objects and arrays whole, null stored), keeps the rest in place, and writes the gate fields", async () => {
    const identity = {
      accent: "#0E5E63",
      heroHeadline: "Tryck på beställning",
      legal: { custom: { angerratt: "<p>A</p>", kopvillkor: "<p>K</p>" }, customUpdatedAt: "2026-10-01" },
      menu: [{ label: "Nyheter", target: "news", type: "collection" }],
      theme: { colors: { accent: "#123456", text: "#000000" }, layout: { gridCols: 3 } },
    };
    const start = await expectJson<{ settings: Settings }>(
      await settingsCall(shopA, "PUT", { returnAddress: "Gatan 1", storeIdentity: identity, vatRegistered: true }),
      200,
      "start",
    );
    const versionBefore = await catalogVersion(shopA.tenantId);
    const audits = await auditRows(shopA.tenantId, "tenant.settings_update");

    const patched = await patch(shopA, {
      expectedUpdatedAt: start.settings.updatedAt,
      sellerType: "company",
      storeIdentity: {
        heroHeadline: null,
        legal: { custom: { kopvillkor: "<p>K2</p>" } },
        newKey: { added: true },
        theme: { colors: { accent: "#654321" } },
      },
    });

    expect(patched.storeIdentity).toEqual({
      accent: "#0E5E63",
      heroHeadline: null,
      // Replaced whole: angerratt and customUpdatedAt are gone (no deep merge).
      legal: { custom: { kopvillkor: "<p>K2</p>" } },
      menu: [{ label: "Nyheter", target: "news", type: "collection" }],
      // Replaced whole: layout and colors.text are gone.
      theme: { colors: { accent: "#654321" } },
      newKey: { added: true },
    });
    // The stored order: replaced keys where they were, new keys last.
    expect(Object.keys(patched.storeIdentity)).toEqual(["accent", "heroHeadline", "legal", "menu", "theme", "newKey"]);
    // Gate fields: named ones written, the others kept.
    expect(patched).toMatchObject({ returnAddress: "Gatan 1", sellerType: "company", vatRegistered: true });
    expect(patched.updatedAt).not.toBe(start.settings.updatedAt);
    expect(await read(shopA)).toEqual(patched);

    // The PUT's audit row, plus the identity keys replaced (never a value).
    const after = await auditRows(shopA.tenantId, "tenant.settings_update");
    expect(after).toHaveLength(audits.length + 1);
    expect(after.at(-1)).toEqual({
      action: "tenant.settings_update",
      actorUserId: shopA.adminUserId,
      metadata: { fields: ["storeIdentity", "sellerType"], identityKeys: ["heroHeadline", "legal", "newKey", "theme"] },
      reason: null,
      resourceId: shopA.tenantId,
      resourceType: "tenant_settings",
      tenantId: shopA.tenantId,
    });
    // The storefront reads the identity: its ETag must change (0043 trigger).
    expect(await catalogVersion(shopA.tenantId)).toBeGreaterThan(versionBefore);
  });

  it("a gate-field-only PATCH leaves the identity alone", async () => {
    const current = await read(shopA);
    const patched = await patch(shopA, { expectedUpdatedAt: current.updatedAt, vatNumber: " SE556677889901 " });
    expect(patched.storeIdentity).toEqual(current.storeIdentity);
    expect(patched.vatNumber).toBe("SE556677889901");
    expect((await auditRows(shopA.tenantId, "tenant.settings_update")).at(-1)?.metadata).toEqual({ fields: ["vatNumber"] });
  });

  it("merges onto the identity as the GET shows it: refused keys a non-route writer stored are dropped, never returned", async () => {
    await seedRow(
      shopB.tenantId,
      {
        accent: "#abcdef",
        commissionBps: 250,
        legal: { acceptance: { uid: "x" }, custom: { terms: true } },
        payments: { stripeAccountId: "acct_hidden" },
      },
      "2026-10-03T00:00:00.000Z",
    );
    const patched = await patch(shopB, { expectedUpdatedAt: "2026-10-03T00:00:00.000Z", storeIdentity: { heroHeadline: "Ny" } });
    expect(patched.storeIdentity).toEqual({ accent: "#abcdef", heroHeadline: "Ny", legal: { custom: { terms: true } } });
    const stored = JSON.parse(String((await rawRow(shopB.tenantId))?.store_identity_json)) as Record<string, unknown>;
    expect(stored).toEqual(patched.storeIdentity);
    expect(JSON.stringify(stored)).not.toMatch(/commission|acct_|payments|acceptance/);
  });

  it("an image the PATCH does not touch is not re-checked: a removed logo no longer blocks an unrelated save", async () => {
    await seedRow(
      shopC.tenantId,
      { accent: "#111111", logoObjectId: "33333333-3333-4333-8333-333333333333" },
      "2026-10-03T01:00:00.000Z",
    );
    // The PUT's read-modify-write sends the logo back and is refused …
    await expectJson(
      await settingsCall(shopC, "PUT", {
        storeIdentity: { accent: "#222222", logoObjectId: "33333333-3333-4333-8333-333333333333" },
      }),
      400,
      "PUT refused",
    );
    // … the PATCH of the colour alone is not.
    const patched = await patch(shopC, { expectedUpdatedAt: "2026-10-03T01:00:00.000Z", storeIdentity: { accent: "#222222" } });
    expect(patched.storeIdentity).toEqual({ accent: "#222222", logoObjectId: "33333333-3333-4333-8333-333333333333" });
  });

  it("refuses a merge that would make the identity larger than the cap, writing nothing", async () => {
    const overhead = JSON.stringify({ big: "" }).length;
    await seedRow(shopC.tenantId, { big: "x".repeat(STORE_IDENTITY_MAX_BYTES - overhead) }, "2026-10-03T02:00:00.000Z");
    const before = await rawRow(shopC.tenantId);
    await expectJson(
      await settingsCall(shopC, "PATCH", { expectedUpdatedAt: "2026-10-03T02:00:00.000Z", storeIdentity: { a: 1 } }),
      400,
      "over the cap",
    );
    expect(await rawRow(shopC.tenantId)).toEqual(before);
    // Replacing the big key with a small one is fine.
    const patched = await patch(shopC, { expectedUpdatedAt: "2026-10-03T02:00:00.000Z", storeIdentity: { big: "small" } });
    expect(patched.storeIdentity).toEqual({ big: "small" });
  });

  it("a key named __proto__ stays data", async () => {
    await seedRow(shopC.tenantId, { accent: "#111111" }, "2026-10-03T03:00:00.000Z");
    const patched = await patch(shopC, {
      expectedUpdatedAt: "2026-10-03T03:00:00.000Z",
      storeIdentity: JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>,
    });
    expect(Object.hasOwn(patched.storeIdentity, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
