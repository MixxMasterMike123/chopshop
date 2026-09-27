import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import catalogFile from "../../docs/SnapWearDocs/snapwear-catalog.json";
import { createMapping, listMappings, podRefusalMessage, quoteForProduct } from "../src/pod/pod-mappings";
import { setDefaultPrinter } from "../src/pod/print-defaults";
import { parseCatalogPutInput, storeCatalog } from "../src/pod/printer-catalog";
import type { BelowFloorProduct, PrinterCapabilities, PrinterEditOptions } from "../src/pod/printers";
import { editPrinter, replacePrinters } from "../src/pod/printers";
import { handlePlatformPrinterListRoute, handlePlatformPrinterRoute } from "../src/routes/pod-platform";
import {
  adminOf,
  CAP,
  catalogVersion,
  expectHandHidden,
  grantActingAs,
  grantPlatformAdmin,
  grantTenantAdmin,
  hiddenPrinter,
  NOT_SNAPWEAR,
  OPAQUE_NOT_FOUND,
  PLATFORM,
  secretsOf,
  SEED_NOW,
  seedArtwork,
  seedProduct,
  seedProfile,
  seedTenant,
  sessionRequest,
  signUp,
  TEE_M,
  TEE_S,
  testCapabilities,
} from "./pod-fixtures";

/**
 * CP3-C: the platform printer read + partial edit (GET/PATCH), the environment
 * policy on edits, `default` as a reserved id, the unchanged replace-all PUT,
 * the platform-only guard, and THE ONE-NUMBER WALK over every tenant-reachable
 * answer of the POD admin surface.
 */

const TENANT_A = "tenant-pp-a";
const TENANT_B = "tenant-pp-b";
const HOST = "https://platform.pptest.test";
const A = adminOf(TENANT_A);

let tenantAdmin: { cookie: string; userId: string };
let platform: { cookie: string; userId: string };

type Caller = "anonymous" | "tenant" | "tenant-bare" | "acting" | "platform";

/** A request through the whole Worker (router + guards), as `caller`. */
function call(
  caller: Caller,
  path: string,
  method: string,
  body?: unknown,
  options: { origin?: string | null } = {},
): Promise<Response> {
  const url = `${HOST}${path}`;
  if (caller === "anonymous") {
    const headers = new Headers({ origin: HOST });
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    return exports.default.fetch(
      new Request(url, { body: body === undefined ? undefined : JSON.stringify(body), headers, method }),
    );
  }
  const cookie = caller === "tenant" || caller === "tenant-bare" ? tenantAdmin.cookie : platform.cookie;
  const shopId = caller === "tenant" || caller === "acting" ? TENANT_A : undefined;
  return exports.default.fetch(
    sessionRequest(url, method, {
      body,
      cookie,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(shopId === undefined ? {} : { shopId }),
    }),
  );
}

function envWith(overrides: Record<string, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

async function resetPrinter(): Promise<void> {
  expect(await replacePrinters(env.DB, PLATFORM, [hiddenPrinter()], Date.now())).not.toBeNull();
}

const EDIT: PrinterEditOptions = { action: "pod.printers.edit", dryRun: false, target: "fake-printer" };

async function mapped(productId: string, sku: string, slots: Array<"back" | "front" | "pocket">): Promise<string> {
  await seedProduct(TENANT_A, { productId });
  const result = await createMapping(
    env.DB,
    A,
    { artworkId: "art-a", printerId: "fake-printer", productId, sku, slots, variantId: null },
    Date.now(),
  );
  expect(result.status).toBe("ok");
  return result.status === "ok" ? result.mapping.mappingId : "";
}

async function mappingState(productId: string): Promise<{ status: string; suspendedReason: string | null }> {
  const [mapping] = await listMappings(env.DB, A, productId);
  return { status: mapping?.status ?? "missing", suspendedReason: mapping?.suspendedReason ?? null };
}

/** Everything an edit could touch, for "nothing changed" assertions. */
async function snapshot(printerId = "fake-printer"): Promise<unknown> {
  const results = await env.DB.batch([
    env.DB.prepare(
      "SELECT name, status, shipping_cost_minor, capabilities_json, revision, updated_at FROM printers WHERE id = ?",
    ).bind(printerId),
    env.DB.prepare(
      "SELECT sku, blank_cost_minor, print_costs_json, created_at, updated_at FROM printer_sku_tiers WHERE printer_id = ? ORDER BY sku",
    ).bind(printerId),
    env.DB.prepare(
      "SELECT id, status, suspended_reason, updated_at FROM pod_mappings WHERE printer_id = ? ORDER BY id",
    ).bind(printerId),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events"),
    env.DB.prepare("SELECT tenant_id, catalog_version FROM tenants ORDER BY tenant_id"),
    env.DB.prepare("SELECT default_printer_id, updated_at FROM print_defaults"),
  ]);
  return results.map((result) => result.results);
}

/** A D1 handle that appends a statement that MUST fail to its `batchCall`-th batch. */
function dbFailingInBatch(batchCall: number): D1Database {
  let calls = 0;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          calls += 1;
          if (calls !== batchCall) {
            return target.batch(statements);
          }
          return target.batch([
            ...statements,
            // CHECK (id = 1): this statement can never succeed.
            target.prepare("INSERT INTO print_defaults (id, updated_at) VALUES (2, ?)").bind(new Date().toISOString()),
          ]);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A D1 handle that runs `interleave` on the real database right before its `batchCall`-th batch. */
function dbInterleavingBeforeBatch(batchCall: number, interleave: () => Promise<unknown>): D1Database {
  let calls = 0;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          calls += 1;
          if (calls === batchCall) {
            await interleave();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function withoutCap(): PrinterCapabilities {
  const capabilities = testCapabilities();
  delete capabilities.skus[CAP];
  delete capabilities.models.TRUCKER;
  return capabilities;
}

beforeAll(async () => {
  await seedTenant(TENANT_A, "pp-a.pptest.test");
  await seedTenant(TENANT_B, "pp-b.pptest.test");
  await seedProfile();
  await resetPrinter();
  await seedArtwork(TENANT_A, { artworkId: "art-a" });
  await seedArtwork(TENANT_A, { artworkId: "art-back", fileName: "back.png" });
  await seedArtwork(TENANT_A, { artworkId: "art-proc", status: "processing" });
  await seedArtwork(TENANT_B, { artworkId: "art-b" });

  tenantAdmin = await signUp("pp-admin@pptest.test");
  await grantTenantAdmin(tenantAdmin.userId, TENANT_A);
  platform = await signUp("pp-platform@pptest.test");
  await grantPlatformAdmin(platform.userId);
  await grantActingAs(platform.userId, TENANT_A);
});

describe("GET /v1/platform/printers[/:printerId] — everything the platform stores", () => {
  it("lists every printer with its type, status, capabilities, tiers WITH prices and shipping", async () => {
    await resetPrinter();
    const response = await call("platform", "/v1/platform/printers", "GET");
    expect(response.status).toBe(200);
    const body = await response.json<{
      defaultPrinterId: string | null;
      nextCursor: string | null;
      printers: Array<Record<string, unknown>>;
    }>();
    expect(body.nextCursor).toBeNull();
    const printer = body.printers.find((entry) => entry.printerId === "fake-printer");
    expect(printer).toMatchObject({
      capabilities: testCapabilities(),
      capabilitiesValid: true,
      catalog: null,
      currency: "SEK",
      name: "Fake printer (staging)",
      printerId: "fake-printer",
      shippingCostMinor: 6_957,
      status: "active",
      tenantId: null,
      type: "api",
    });
    expect(typeof printer?.revision).toBe("number");
    expect(
      (printer?.tiers as Array<{ blankCostMinor: number; printCostsMinor: unknown; sku: string }>).map(
        ({ blankCostMinor, printCostsMinor, sku }) => ({ blankCostMinor, printCostsMinor, sku }),
      ),
    ).toEqual([
      { blankCostMinor: 7_071, printCostsMinor: { front: 6_017 }, sku: CAP },
      { blankCostMinor: 7_137, printCostsMinor: { back: 6_223, front: 6_211, pocket: 6_039 }, sku: TEE_S },
      { blankCostMinor: 7_137, printCostsMinor: { back: 6_223, front: 6_211, pocket: 6_039 }, sku: TEE_M },
    ]);
  });

  it("GET one answers the same view; an unknown id is the opaque 404", async () => {
    const list = await (await call("platform", "/v1/platform/printers", "GET")).json<{
      printers: Array<{ printerId: string }>;
    }>();
    const one = await call("platform", "/v1/platform/printers/fake-printer", "GET");
    expect(one.status).toBe(200);
    await expect(one.json()).resolves.toEqual({
      printer: list.printers.find((entry) => entry.printerId === "fake-printer"),
    });
    const unknown = await call("platform", "/v1/platform/printers/no-such-printer", "GET");
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
  });

  it("shows tenant printers and imported rows whose capability document does not validate", async () => {
    const iso = new Date(SEED_NOW).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO printers (id, tenant_id, type, name, status, currency, shipping_cost_minor, capabilities_json, created_at, updated_at)
         VALUES ('pp-tenant-printer', ?, 'manual', 'Shop press', 'active', 'SEK', 0, '{"models":{},"skus":{}}', ?, ?)`,
      ).bind(TENANT_A, iso, iso),
      env.DB.prepare(
        `INSERT INTO printers (id, tenant_id, type, name, status, currency, shipping_cost_minor, capabilities_json, created_at, updated_at)
         VALUES ('pp-imported', NULL, 'manual', 'Imported', 'inactive', 'SEK', 0, '{"models":{},"skus":{},"garments":["tee"]}', ?, ?)`,
      ).bind(iso, iso),
    ]);
    const tenantOwned = await (await call("platform", "/v1/platform/printers/pp-tenant-printer", "GET")).json<{
      printer: { capabilitiesValid: boolean; tenantId: string | null };
    }>();
    expect(tenantOwned.printer).toMatchObject({ capabilitiesValid: true, tenantId: TENANT_A });
    const imported = await (await call("platform", "/v1/platform/printers/pp-imported", "GET")).json<{
      printer: { capabilities: unknown; capabilitiesValid: boolean };
    }>();
    expect(imported.printer).toMatchObject({
      capabilities: { garments: ["tee"], models: {}, skus: {} },
      capabilitiesValid: false,
    });
  });

  it("pages by id with a cursor and refuses a malformed query", async () => {
    const first = await (await call("platform", "/v1/platform/printers?limit=1", "GET")).json<{
      nextCursor: string | null;
      printers: Array<{ printerId: string }>;
    }>();
    expect(first.printers.map((entry) => entry.printerId)).toEqual(["fake-printer"]);
    expect(first.nextCursor).toBe("fake-printer");
    const rest = await (
      await call("platform", `/v1/platform/printers?limit=50&cursor=${first.nextCursor}`, "GET")
    ).json<{ nextCursor: string | null; printers: Array<{ printerId: string }> }>();
    expect(rest.printers.map((entry) => entry.printerId)).toEqual(["pp-imported", "pp-tenant-printer"]);
    expect(rest.nextCursor).toBeNull();
    for (const query of ["?limit=0", "?limit=51", "?limit=x", "?cursor=Not_An_Id", "?status=active"]) {
      expect((await call("platform", `/v1/platform/printers${query}`, "GET")).status).toBe(400);
    }
  });
});

describe("PATCH /v1/platform/printers/:printerId — a partial edit", () => {
  it("edits name and shipping; moves the revision by one; audits without prices", async () => {
    await resetPrinter();
    const before = (await (await call("platform", "/v1/platform/printers/fake-printer", "GET")).json<{
      printer: { revision: number };
    }>()).printer.revision;
    const response = await call("platform", "/v1/platform/printers/fake-printer", "PATCH", {
      name: "Fake printer (renamed)",
      shippingCostMinor: 6_958,
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      diff: { fields: string[] };
      printer: { name: string; revision: number; shippingCostMinor: number };
      suspendedMappings: number;
    }>();
    expect(body.diff.fields).toEqual(["name", "shippingCostMinor"]);
    expect(body.printer).toMatchObject({ name: "Fake printer (renamed)", revision: before + 1, shippingCostMinor: 6_958 });
    expect(body.suspendedMappings).toBe(0);

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, resource_id, metadata_json FROM audit_events
       WHERE action = 'pod.printers.edit' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).first<{ actor_user_id: string; metadata_json: string; resource_id: string }>();
    expect(audit).toMatchObject({ actor_user_id: platform.userId, resource_id: "fake-printer" });
    for (const figure of [6_957, 6_958, 7_137, 6_211]) {
      expect(audit?.metadata_json).not.toContain(String(figure));
    }
  });

  it("removing a SKU and a capability suspends the dependent mappings IN THE SAME BATCH", async () => {
    await resetPrinter();
    const capMapping = await mapped("pp-cap", CAP, ["front"]);
    const backMapping = await mapped("pp-back", TEE_S, ["back"]);
    await mapped("pp-front", TEE_M, ["front"]);
    const versionBefore = await catalogVersion(TENANT_A);

    const capabilities = withoutCap();
    delete capabilities.models["2000"]?.printAreasMm.back;
    const response = await call("platform", "/v1/platform/printers/fake-printer", "PATCH", { capabilities });
    expect(response.status).toBe(200);
    const body = await response.json<{
      diff: {
        models: { changed: string[]; removed: string[] };
        skus: { removed: string[] };
        suspensions: Array<{ mappingId: string; reason: string }>;
        tiers: { removed: string[] };
      };
      suspendedMappings: number;
    }>();
    expect(body.suspendedMappings).toBe(2);
    expect(body.diff.skus.removed).toEqual([CAP]);
    expect(body.diff.models).toMatchObject({ changed: ["2000"], removed: ["TRUCKER"] });
    // The tier of a SKU the printer no longer lists is dropped with it.
    expect(body.diff.tiers.removed).toEqual([CAP]);
    expect(body.diff.suspensions.map(({ mappingId, reason }) => ({ mappingId, reason })).sort((a, b) => a.reason.localeCompare(b.reason))).toEqual([
      { mappingId: capMapping, reason: "sku_unavailable" },
      { mappingId: backMapping, reason: "slot_not_printable" },
    ].sort((a, b) => a.reason.localeCompare(b.reason)));

    await expect(mappingState("pp-cap")).resolves.toEqual({ status: "suspended", suspendedReason: "sku_unavailable" });
    await expect(mappingState("pp-back")).resolves.toEqual({ status: "suspended", suspendedReason: "slot_not_printable" });
    await expect(mappingState("pp-front")).resolves.toEqual({ status: "active", suspendedReason: null });
    const tiers = await env.DB.prepare("SELECT sku FROM printer_sku_tiers WHERE printer_id = 'fake-printer' ORDER BY sku").all();
    expect(tiers.results).toEqual([{ sku: TEE_S }, { sku: TEE_M }]);
    expect(await catalogVersion(TENANT_A)).toBeGreaterThan(versionBefore);
  });

  it("removing a tier suspends the mappings that SKU priced (unpriced)", async () => {
    await resetPrinter();
    await mapped("pp-sku-dropped", TEE_S, ["front"]);
    const response = await call("platform", "/v1/platform/printers/fake-printer", "PATCH", {
      tiers: { remove: [TEE_S] },
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ diff: { tiers: { removed: string[] }; unpricedSkus: string[] }; suspendedMappings: number }>();
    expect(body.diff.tiers.removed).toEqual([TEE_S]);
    expect(body.diff.unpricedSkus).toEqual([TEE_S]);
    expect(body.suspendedMappings).toBe(1);
    await expect(mappingState("pp-sku-dropped")).resolves.toEqual({ status: "suspended", suspendedReason: "unpriced" });
  });

  it("a tier upsert re-prices the one number and keeps the tier's created_at", async () => {
    await resetPrinter();
    await mapped("pp-quote", TEE_M, ["front"]);
    await expect(quoteForProduct(env.DB, A, "pp-quote", null)).resolves.toMatchObject({
      quote: { inkopMinor: 7_137 + 6_211 + 4_000 },
      status: "ok",
    });
    const before = await env.DB.prepare(
      "SELECT created_at, updated_at FROM printer_sku_tiers WHERE printer_id = 'fake-printer' AND sku = ?",
    ).bind(TEE_M).first<{ created_at: string; updated_at: string }>();
    const result = await editPrinter(
      env.DB,
      PLATFORM,
      "fake-printer",
      {
        tiers: {
          kind: "patch",
          remove: [],
          upsert: [{ blankCostMinor: 7_137, printCostsMinor: { back: 6_223, front: 6_311, pocket: 6_039 }, sku: TEE_M }],
        },
      },
      Date.now() + 5_000,
      EDIT,
    );
    expect(result).toMatchObject({ diff: { tiers: { added: [], changed: [TEE_M], removed: [] } }, status: "ok" });
    await expect(quoteForProduct(env.DB, A, "pp-quote", null)).resolves.toMatchObject({
      quote: { inkopMinor: 7_137 + 6_311 + 4_000 },
    });
    const after = await env.DB.prepare(
      "SELECT created_at, updated_at FROM printer_sku_tiers WHERE printer_id = 'fake-printer' AND sku = ?",
    ).bind(TEE_M).first<{ created_at: string; updated_at: string }>();
    expect(after?.created_at).toBe(before?.created_at);
    expect((after?.updated_at ?? "") > (before?.updated_at ?? "")).toBe(true);
  });

  it("with an injected failure inside the write batch NOTHING changes (printer, tiers, mappings, audit)", async () => {
    await resetPrinter();
    await mapped("pp-fail-cap", CAP, ["front"]);
    await mapped("pp-fail-back", TEE_S, ["back"]);
    const before = await snapshot();
    const capabilities = withoutCap();
    delete capabilities.models["2000"]?.printAreasMm.back;
    await expect(
      editPrinter(
        dbFailingInBatch(2),
        PLATFORM,
        "fake-printer",
        {
          capabilities,
          name: "Must not land",
          tiers: { kind: "patch", remove: [TEE_M], upsert: [] },
        },
        Date.now(),
        EDIT,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await expect(mappingState("pp-fail-cap")).resolves.toEqual({ status: "active", suspendedReason: null });
  });

  it("an edit that raced another writer is refused (409 concurrent_edit), never written over it", async () => {
    await resetPrinter();
    await mapped("pp-race", CAP, ["front"]);
    for (const other of [
      () => editPrinter(env.DB, PLATFORM, "fake-printer", { name: "Other operator" }, Date.now(), EDIT),
      () => replacePrinters(env.DB, PLATFORM, [hiddenPrinter({ name: "Other operator" })], Date.now()),
    ]) {
      await resetPrinter();
      const result = await editPrinter(
        dbInterleavingBeforeBatch(2, other),
        PLATFORM,
        "fake-printer",
        { capabilities: withoutCap(), shippingCostMinor: 1 },
        Date.now(),
        EDIT,
      );
      expect(result).toEqual({ code: "concurrent_edit", status: "conflict" });
      const row = await env.DB.prepare(
        "SELECT name, shipping_cost_minor FROM printers WHERE id = 'fake-printer'",
      ).first();
      expect(row).toEqual({ name: "Other operator", shipping_cost_minor: 6_957 });
      await expect(mappingState("pp-race")).resolves.toEqual({ status: "active", suspendedReason: null });
    }
  });

  it("expectedRevision pins the state the operator read", async () => {
    await resetPrinter();
    const { printer } = await (await call("platform", "/v1/platform/printers/fake-printer", "GET")).json<{
      printer: { revision: number };
    }>();
    const stale = await call("platform", "/v1/platform/printers/fake-printer", "PATCH", {
      expectedRevision: printer.revision - 1,
      name: "Stale",
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "revision_mismatch" } });
    const fresh = await call("platform", "/v1/platform/printers/fake-printer", "PATCH", {
      expectedRevision: printer.revision,
      name: "Fresh",
    });
    expect(fresh.status).toBe(200);
  });

  it("refuses malformed bodies (400) and edits that make no sense for the tiers (400 invalid_tiers)", async () => {
    await resetPrinter();
    for (const body of [
      {},
      { name: "" },
      { currency: "EUR" },
      { type: "manual" },
      { status: "paused" },
      { shippingCostMinor: -1 },
      { tiers: {} },
      { tiers: { remove: [] } },
      { tiers: { upsert: [{ blankCostMinor: -1, printCostsMinor: {}, sku: TEE_S }] } },
      { tiers: { upsert: [{ blankCostMinor: 1, printCostsMinor: { chest: 1 }, sku: TEE_S }] } },
      { capabilities: { models: {}, skus: { [TEE_S]: { model: "nope" } } } },
      { expectedRevision: -1, name: "x" },
    ]) {
      expect((await call("platform", "/v1/platform/printers/fake-printer", "PATCH", body)).status).toBe(400);
    }
    for (const tiers of [
      { remove: ["2700999"] },
      { upsert: [{ blankCostMinor: 1, printCostsMinor: {}, sku: "2700005" }] },
      { remove: [TEE_S], upsert: [{ blankCostMinor: 1, printCostsMinor: {}, sku: TEE_S }] },
    ]) {
      const response = await call("platform", "/v1/platform/printers/fake-printer", "PATCH", { tiers });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_tiers" } });
    }
  });

  it("refuses to edit a tenant printer (409) and an unknown one (404)", async () => {
    const tenantOwned = await call("platform", "/v1/platform/printers/pp-tenant-printer", "PATCH", { name: "x" });
    expect(tenantOwned.status).toBe(409);
    await expect(tenantOwned.json()).resolves.toMatchObject({ error: { code: "tenant_printer" } });
    expect((await call("platform", "/v1/platform/printers/nobody-here", "PATCH", { name: "x" })).status).toBe(404);
  });
});

describe("belowFloor: the operator sees which products an edit pushes under the floor", () => {
  const publishBySql = (productId: string, priceMinor: number) =>
    env.DB.prepare(
      `INSERT INTO product_publications (
         product_id, tenant_id, published, public_name, public_description,
         public_price_minor, currency, projection_version, published_at, updated_at
       ) VALUES (?, ?, 1, ?, NULL, ?, 'SEK', 1, ?, ?)`,
    ).bind(productId, TENANT_A, productId, priceMinor, SEED_NOW, SEED_NOW).run();
  const floorNow = async (productId: string, variantId: string | null = null): Promise<number> => {
    const quote = await quoteForProduct(env.DB, A, productId, variantId);
    if (quote.status !== "ok") {
      throw new Error(`${productId} is not quotable`);
    }
    return quote.quote.priceFloorMinor;
  };
  // TEE_M's front print, raised by 10 kr.
  const RAISE = {
    tiers: {
      kind: "patch" as const,
      remove: [],
      upsert: [{ blankCostMinor: 7_137, printCostsMinor: { back: 6_223, front: 7_211, pocket: 6_039 }, sku: TEE_M }],
    },
  };
  let tightFloor = 0;
  let variantFloor = 0;

  beforeAll(async () => {
    await resetPrinter();
    // Live, priced EXACTLY at today's floor.
    await mapped("bf-tight", TEE_M, ["front"]);
    tightFloor = await floorNow("bf-tight");
    await env.DB.prepare("UPDATE products SET b2c_price_minor = ? WHERE product_id = 'bf-tight'").bind(tightFloor).run();
    await publishBySql("bf-tight", tightFloor);
    // Same SKU and slots, priced far above any floor.
    await mapped("bf-roomy", TEE_M, ["front"]);
    await env.DB.prepare("UPDATE products SET b2c_price_minor = 90_000 WHERE product_id = 'bf-roomy'").run();
    // Two variants with their own sets: S (TEE_S, untouched by the edit) and M (TEE_M), both at their floor.
    await seedProduct(TENANT_A, {
      productId: "bf-variants",
      variants: [
        { priceMinor: 1, sku: "BF-S", variantId: "bf-variant-s" },
        { priceMinor: 1, sku: "BF-M", variantId: "bf-variant-m" },
      ],
    });
    for (const [variantId, sku] of [["bf-variant-s", TEE_S], ["bf-variant-m", TEE_M]] as const) {
      const result = await createMapping(
        env.DB,
        A,
        { artworkId: "art-a", printerId: "fake-printer", productId: "bf-variants", sku, slots: ["front"], variantId },
        Date.now(),
      );
      expect(result.status).toBe("ok");
    }
    variantFloor = await floorNow("bf-variants", "bf-variant-m");
    await env.DB.batch([
      env.DB.prepare("UPDATE product_variants SET price_minor = ? WHERE variant_id = 'bf-variant-m'").bind(variantFloor),
      env.DB.prepare("UPDATE product_variants SET price_minor = ? WHERE variant_id = 'bf-variant-s'").bind(
        await floorNow("bf-variants", "bf-variant-s"),
      ),
    ]);
  });

  const listed = (products: BelowFloorProduct[], productId: string) =>
    products.find((entry) => entry.productId === productId);

  it("an edit that moves no cost lists none of them (priced exactly at the floor is not below it)", async () => {
    const result = await editPrinter(env.DB, PLATFORM, "fake-printer", { name: "Same prices" }, Date.now(), {
      ...EDIT,
      dryRun: true,
    });
    expect(result.status).toBe("ok");
    const report = result.status === "ok" ? result.diff.belowFloor : null;
    expect(report).toMatchObject({ count: expect.any(Number) as unknown });
    const products = report !== null && "products" in report ? report.products : [];
    for (const productId of ["bf-tight", "bf-roomy", "bf-variants"]) {
      expect(listed(products, productId), productId).toBeUndefined();
    }
  });

  it("raising a tier lists the products it pushes under, with the right floor — dry run and real run alike", async () => {
    const dryRun = await editPrinter(env.DB, PLATFORM, "fake-printer", RAISE, Date.now(), { ...EDIT, dryRun: true });
    expect(dryRun.status).toBe("ok");
    const dryReport = dryRun.status === "ok" ? dryRun.diff.belowFloor : null;

    const response = await call("platform", "/v1/platform/printers/fake-printer", "PATCH", {
      tiers: { upsert: RAISE.tiers.upsert },
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ diff: { belowFloor: { count: number; products: BelowFloorProduct[] } } }>();
    // Same code path, same snapshot facts: the same list.
    expect(body.diff.belowFloor).toEqual(dryReport);

    // The floor the edit reported is the floor the quote route now computes from the stored document.
    const tight = listed(body.diff.belowFloor.products, "bf-tight");
    expect(tight).toEqual({
      live: true,
      newFloorMinor: await floorNow("bf-tight"),
      priceMinor: tightFloor,
      productId: "bf-tight",
      tenantId: TENANT_A,
      variantId: null,
    });
    expect(tight?.newFloorMinor).toBeGreaterThan(tightFloor);
    expect(listed(body.diff.belowFloor.products, "bf-variants")).toEqual({
      live: false,
      newFloorMinor: await floorNow("bf-variants", "bf-variant-m"),
      priceMinor: variantFloor,
      productId: "bf-variants",
      tenantId: TENANT_A,
      variantId: "bf-variant-m",
    });
    expect(listed(body.diff.belowFloor.products, "bf-roomy")).toBeUndefined();
    expect(body.diff.belowFloor.count).toBe(body.diff.belowFloor.products.length);

    // Reported, never acted on: the products and their mappings are untouched.
    await expect(mappingState("bf-tight")).resolves.toEqual({ status: "active", suspendedReason: null });
    const price = await env.DB.prepare("SELECT b2c_price_minor FROM products WHERE product_id = 'bf-tight'").first();
    expect(price).toEqual({ b2c_price_minor: tightFloor });
    // The audit row carries the count, never a price.
    const audit = await env.DB.prepare(
      // By insertion order: an earlier test stamps its edit 5 s in the future.
      "SELECT metadata_json FROM audit_events WHERE action = 'pod.printers.edit' ORDER BY rowid DESC LIMIT 1",
    ).first<{ metadata_json: string }>();
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({ belowFloor: body.diff.belowFloor.count });
    expect(audit?.metadata_json).not.toContain(String(tightFloor));
  });

  it("a product whose mapping the edit suspends is listed under suspensions, not belowFloor; an inactive printer prices nothing", async () => {
    const capabilities = testCapabilities();
    delete capabilities.skus[TEE_M];
    const removing = await editPrinter(env.DB, PLATFORM, "fake-printer", { capabilities }, Date.now(), {
      ...EDIT,
      dryRun: true,
    });
    expect(removing.status).toBe("ok");
    if (removing.status === "ok" && "products" in removing.diff.belowFloor) {
      expect(listed(removing.diff.belowFloor.products, "bf-tight")).toBeUndefined();
      expect(removing.diff.suspensions.map((entry) => entry.productId)).toContain("bf-tight");
    }
    const inactive = await editPrinter(env.DB, PLATFORM, "fake-printer", { status: "inactive" }, Date.now(), {
      ...EDIT,
      dryRun: true,
    });
    expect(inactive).toMatchObject({ diff: { belowFloor: { count: 0, products: [] } }, status: "ok" });
  });

  it("is platform-only: a tenant session reaches neither the edit nor the list", async () => {
    for (const caller of ["tenant", "acting"] as const) {
      const response = await call(caller, "/v1/platform/printers/fake-printer", "PATCH", {
        tiers: { upsert: RAISE.tiers.upsert },
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
      for (const path of ["/v1/admin/pod/quote?productId=bf-tight", "/v1/admin/pod/mappings?productId=bf-tight", "/v1/admin/pod/printers"]) {
        const text = await (await call(caller, path, "GET")).text();
        expect(text).not.toContain("belowFloor");
        expect(text).not.toContain("newFloorMinor");
        expect(text).not.toContain("bf-roomy");
      }
    }
  });
});

describe("the environment policy for `api` printers holds on PATCH", () => {
  const patch = (target: Env, printerId: string, body: unknown) =>
    handlePlatformPrinterRoute(
      target,
      sessionRequest(`${HOST}/v1/platform/printers/${printerId}`, "PATCH", { body, cookie: platform.cookie }),
      printerId,
    );

  it("an api printer may list only SnapWear SKUs", async () => {
    await resetPrinter();
    const capabilities = testCapabilities();
    capabilities.skus[NOT_SNAPWEAR] = { model: "2000" };
    const before = await snapshot();
    const response = await patch(env, "fake-printer", { capabilities });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "printer_not_allowed" } });
    expect(await snapshot()).toEqual(before);
  });

  it("an api printer that is not this environment's dispatch target cannot be edited (D59's inactive import)", async () => {
    const iso = new Date(SEED_NOW).toISOString();
    await env.DB.prepare(
      `INSERT INTO printers (id, tenant_id, type, name, status, currency, shipping_cost_minor, capabilities_json, created_at, updated_at)
       VALUES ('snapwear', NULL, 'api', 'SnapWear', 'inactive', 'SEK', 0, ?, ?, ?)`,
    ).bind(JSON.stringify(testCapabilities()), iso, iso).run();
    const response = await patch(env, "snapwear", { name: "SnapWear (edited)" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "printer_not_allowed" } });

    // Production-shaped env (target snapwear): the staging fake printer is the refused one.
    const production = await patch(envWith({ DISPATCH_TARGET: "snapwear" }), "fake-printer", { name: "x" });
    expect(production.status).toBe(400);
  });

  it("a manual printer is free of the SnapWear list, but may not take a dispatch target's id", async () => {
    const iso = new Date(SEED_NOW).toISOString();
    await env.DB.prepare(
      `INSERT INTO printers (id, tenant_id, type, name, status, currency, shipping_cost_minor, capabilities_json, created_at, updated_at)
       VALUES ('pp-manual', NULL, 'manual', 'Local press', 'active', 'SEK', 0, '{"models":{},"skus":{}}', ?, ?)`,
    ).bind(iso, iso).run();
    const capabilities = testCapabilities();
    capabilities.skus[NOT_SNAPWEAR] = { model: "2000" };
    const response = await patch(env, "pp-manual", { capabilities });
    expect(response.status).toBe(200);
  });

  it("the whole surface is dark without a dispatch target", async () => {
    const dark = envWith({ DISPATCH_TARGET: undefined });
    const list = await handlePlatformPrinterListRoute(
      dark,
      sessionRequest(`${HOST}/v1/platform/printers`, "GET", { cookie: platform.cookie }),
    );
    expect(list.status).toBe(404);
    expect((await patch(dark, "fake-printer", { name: "x" })).status).toBe(404);
  });
});

describe("`default` is never a printer id", () => {
  it("the id routes refuse it, literally or percent-encoded", async () => {
    for (const path of ["/v1/platform/printers/default", "/v1/platform/printers/%64efault"]) {
      const response = await call("platform", path, "PATCH", { name: "x" });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
    }
    const encodedGet = await call("platform", "/v1/platform/printers/%64efault", "GET");
    expect(encodedGet.status).toBe(404);
    for (const path of ["/v1/platform/printers/default/catalog", "/v1/platform/printers/default/catalog/apply"]) {
      const apply = path.endsWith("apply");
      expect((await call("platform", path, apply ? "POST" : "GET", apply ? {} : undefined)).status).toBe(404);
    }
  });

  it("the replace-all PUT cannot create it and the schema refuses it", async () => {
    const response = await call("platform", "/v1/platform/printers", "PUT", {
      printers: [hiddenPrinter({ printerId: "default", type: "manual" })],
    });
    expect(response.status).toBe(400);
    const iso = new Date(SEED_NOW).toISOString();
    await expect(
      env.DB.prepare(
        `INSERT INTO printers (id, tenant_id, type, name, status, currency, shipping_cost_minor, capabilities_json, created_at, updated_at)
         VALUES ('default', NULL, 'manual', 'x', 'inactive', 'SEK', 0, '{"models":{},"skus":{}}', ?, ?)`,
      ).bind(iso, iso).run(),
    ).rejects.toThrow(/reserved/);
  });
});

describe("the CP2 replace-all PUT keeps working through the router", () => {
  it("PUT answers counts only and bumps the revision; GET then shows the new document", async () => {
    await resetPrinter();
    const before = (await (await call("platform", "/v1/platform/printers/fake-printer", "GET")).json<{
      printer: { revision: number };
    }>()).printer.revision;
    const response = await call("platform", "/v1/platform/printers", "PUT", {
      printers: [hiddenPrinter({ name: "Replaced" })],
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      printers: [
        {
          currency: "SEK",
          name: "Replaced",
          pricedSkuCount: 3,
          printerId: "fake-printer",
          skuCount: 3,
          status: "active",
          type: "api",
        },
      ],
      suspendedMappings: 0,
    });
    const after = await (await call("platform", "/v1/platform/printers/fake-printer", "GET")).json<{
      printer: { name: string; revision: number };
    }>();
    expect(after.printer).toMatchObject({ name: "Replaced", revision: before + 1 });
    // The list path answers GET (CP3) and PUT (CP2) only.
    for (const method of ["POST", "DELETE", "PATCH", "HEAD"]) {
      expect((await call("platform", "/v1/platform/printers", method)).status).toBe(404);
    }
  });
});

describe("platform sessions only: every other caller gets the opaque 404 and changes nothing", () => {
  const routes: Array<[string, string, unknown]> = [
    ["GET", "/v1/platform/printers", undefined],
    ["GET", "/v1/platform/printers/fake-printer", undefined],
    ["PATCH", "/v1/platform/printers/fake-printer", { name: "Hijacked" }],
  ];

  it.each(routes)("%s %s", async (method, path, body) => {
    await resetPrinter();
    const before = await snapshot();
    for (const caller of ["anonymous", "tenant", "tenant-bare", "acting"] as const) {
      const response = await call(caller, path, method, body);
      expect(response.status, `${caller} ${method} ${path}`).toBe(404);
      await expect(response.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
    }
    // The acting platform user is a real platform admin: without the shop header it passes.
    const allowed = await call("platform", path, method, body);
    expect(allowed.status).toBe(200);
    if (method === "PATCH") {
      // A cross-site write from the platform session is refused the same way.
      await resetPrinter();
      const snapshotBefore = await snapshot();
      const crossSite = await call("platform", path, method, body, { origin: "https://evil.test" });
      expect(crossSite.status).toBe(404);
      await expect(crossSite.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
      const noOrigin = await call("platform", path, method, body, { origin: null });
      expect(noOrigin.status).toBe(404);
      expect(await snapshot()).toEqual(snapshotBefore);
    } else {
      expect(await snapshot()).toEqual(before);
    }
  });
});

describe("THE ONE-NUMBER WALK: no tenant answer shows the platform's hand", () => {
  const CANARIES = {
    basis: "CANARY-BASIS-3d0b",
    brand: "CANARY-BRAND-55e1",
    document: "CANARY-CATALOG-7f3a",
    source: "CANARY-SOURCE-91c2",
  };
  let secrets: ReturnType<typeof secretsOf>;
  let n = 0;
  const next = (prefix: string) => `${prefix}-${(n += 1)}`;

  beforeAll(async () => {
    await resetPrinter();
    // A listed-but-unpriced SKU, so the `unpriced` refusal is reachable.
    const capabilities = testCapabilities();
    capabilities.skus["2700005"] = { label: "White / L", model: "2000" };
    const listed = await editPrinter(env.DB, PLATFORM, "fake-printer", { capabilities }, Date.now(), EDIT);
    expect(listed.status).toBe("ok");

    // The printer HAS a supplier catalogue (with a pricing basis) stored.
    const models = catalogFile.models as unknown as Record<string, Record<string, unknown>>;
    const document = {
      ...catalogFile,
      models: { ...models, "2000": { ...models["2000"], brand: CANARIES.brand } },
      supplierNote: CANARIES.document,
    };
    const parsed = parseCatalogPutInput({
      catalog: document,
      pricingBasis: { eurSek: 11.2371, extraPrintEur: 3.37, note: CANARIES.basis },
      source: CANARIES.source,
    });
    expect(parsed.status).toBe("ok");
    const stored = parsed.status === "ok" ? await storeCatalog(env.DB, PLATFORM, "fake-printer", parsed.input, Date.now()) : null;
    expect(stored?.status).toBe("ok");
    await setDefaultPrinter(env.DB, PLATFORM, "fake-printer", Date.now());

    const brands = new Set(Object.values(models).map((model) => String(model.brand)).filter((brand) => brand !== "null"));
    secrets = secretsOf([hiddenPrinter()], {
      numbers: [11.2371, 3.37],
      strings: [
        ...Object.values(CANARIES),
        ...brands,
        stored?.status === "ok" ? stored.catalog.contentSha256 : "unreachable",
      ],
    });

    // A product priced in another currency than the printer, and a live one
    // priced far under the floor, so those refusals are reachable too.
    const iso = SEED_NOW;
    await env.DB.prepare(
      `INSERT INTO products (product_id, tenant_id, status, sku, name, description, b2c_price_minor, currency, is_pod, created_at, updated_at)
       VALUES ('pp-eur', ?, 'active', 'SKU-pp-eur', 'Euro tee', NULL, 29900, 'EUR', 0, ?, ?)`,
    ).bind(TENANT_A, iso, iso).run();
    await seedProduct(TENANT_A, { priceMinor: 100, productId: "pp-cheap-live", published: true });
  });

  it("the walker is not vacuous: the PLATFORM view of the same printer fails it", async () => {
    const body = await (await call("platform", "/v1/platform/printers/fake-printer", "GET")).json();
    expect(() => expectHandHidden(body, secrets)).toThrow();
    const catalog = await (await call("platform", "/v1/platform/printers/fake-printer/catalog", "GET")).json();
    expect(() => expectHandHidden(catalog, secrets)).toThrow();
  });

  it.each(["tenant", "acting"] as const)("every answer the POD admin surface gives a %s session", async (caller) => {
    const walk = async (response: Response, status: number) => {
      expect(response.status).toBe(status);
      const body: unknown = await response.json();
      expectHandHidden(body, secrets);
      return body as Record<string, unknown>;
    };

    // The printer view: capability only, garments + provisionalAreas, picked by allowlist.
    const printers = await walk(await call(caller, "/v1/admin/pod/printers", "GET"), 200);
    const [view] = printers.printers as Array<Record<string, unknown>>;
    expect(Object.keys(view ?? {}).sort()).toEqual(["capabilities", "garments", "name", "printerId", "provisionalAreas"]);
    expect(view).toMatchObject({ garments: ["cap", "tee"], printerId: "fake-printer", provisionalAreas: [] });

    // Success paths: create, list, quote.
    const productId = next(`pp-walk-${caller}`);
    await seedProduct(TENANT_A, { productId });
    const post = (body: Record<string, unknown>) =>
      call(caller, "/v1/admin/pod/mappings", "POST", {
        artworkId: "art-a",
        printerId: "fake-printer",
        productId,
        sku: TEE_S,
        slots: ["front"],
        ...body,
      });
    const created = await walk(await post({}), 201);
    expect(Object.keys(created).sort()).toEqual(["currency", "inkopMinor", "mapping", "priceFloorMinor"]);
    await walk(await call(caller, `/v1/admin/pod/mappings?productId=${productId}`, "GET"), 200);
    const all = await walk(await call(caller, "/v1/admin/pod/mappings", "GET"), 200);
    // A mapping suspended because its tier went away reads as an unavailable SKU.
    expect(
      (all.mappings as Array<{ productId: string; suspendedReason: string | null }>).find(
        (mapping) => mapping.productId === "pp-sku-dropped",
      ),
    ).toMatchObject({ status: "suspended", suspendedReason: "sku_unavailable" });
    await walk(await call(caller, `/v1/admin/pod/quote?productId=${productId}`, "GET"), 200);

    // Every refusal the mapping POST can give.
    const refusal = async (body: Record<string, unknown>, status: number, code: string) => {
      const answer = await walk(await post(body), status);
      expect(answer, JSON.stringify(body)).toMatchObject({ error: { code } });
    };
    await refusal({ artworkId: "art-proc" }, 422, "artwork_not_ready");
    await refusal({ printerId: "snapwear" }, 422, "printer_unavailable");
    await refusal({ sku: "2810013" }, 422, "sku_unavailable");
    await refusal({ slots: ["left_sleeve"] }, 422, "slot_not_printable");
    // `unpriced` and `currency_mismatch` would describe how the platform prices.
    await refusal({ productId: next("pp-unlisted-walk"), sku: "2700005" }, 404, "not_found");
    const unpricedProduct = next("pp-unlisted-walk");
    await seedProduct(TENANT_A, { productId: unpricedProduct });
    await refusal({ productId: unpricedProduct, sku: "2700005" }, 422, "sku_unavailable");
    await refusal({ productId: "pp-eur" }, 422, "printer_unavailable");
    await refusal({ productId: "pp-cheap-live" }, 422, "price_below_floor");
    await refusal({ artworkId: "art-back" }, 409, "slot_taken");
    await refusal({ sku: TEE_M, artworkId: "art-back", slots: ["back"] }, 409, "sku_mismatch");
    await refusal({ artworkId: "art-b" }, 404, "not_found");
    await walk(await call(caller, "/v1/admin/pod/mappings", "POST", { productId }), 400);

    // Quote and delete errors.
    await walk(await call(caller, `/v1/admin/pod/quote?productId=${unpricedProduct}`, "GET"), 422);
    await walk(await call(caller, "/v1/admin/pod/quote", "GET"), 400);
    await walk(await call(caller, "/v1/admin/pod/quote?productId=nope", "GET"), 404);
    await walk(await call(caller, "/v1/admin/pod/mappings/nope", "DELETE"), 404);
    const mappingId = (created.mapping as { mappingId: string }).mappingId;
    const deleted = await call(caller, `/v1/admin/pod/mappings/${mappingId}`, "DELETE");
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");

    // Every platform printer route, reached with this session: the opaque 404.
    for (const [method, path, body] of [
      ["GET", "/v1/platform/printers", undefined],
      ["GET", "/v1/platform/printers/fake-printer", undefined],
      ["PATCH", "/v1/platform/printers/fake-printer", { name: "x" }],
      ["GET", "/v1/platform/printers/default", undefined],
      ["PUT", "/v1/platform/printers/default", { printerId: null }],
      ["GET", "/v1/platform/printers/fake-printer/catalog", undefined],
      ["PUT", "/v1/platform/printers/fake-printer/catalog", { catalog: { models: {}, skus: {} } }],
      ["POST", "/v1/platform/printers/fake-printer/catalog/apply", { pricing: { basis: "keep" }, skus: [TEE_S] }],
    ] as Array<[string, string, unknown]>) {
      const answer = await walk(await call(caller, path, method, body), 404);
      expect(answer).toEqual(OPAQUE_NOT_FOUND);
    }
  });

  it("every refusal sentence a tenant can read is neutral — and the old ones would fail the walk", () => {
    for (const code of [
      "pod_too_large",
      "pod_mapping_suspended",
      "pod_mapping_missing",
      "pod_unpriced",
      "currency_mismatch",
      "price_below_floor",
      "taken_down",
      "anything-else",
    ]) {
      expectHandHidden(podRefusalMessage(code), secrets, `podRefusalMessage(${code})`);
    }
    for (const old of [
      "The printer has no price for this garment and print areas.",
      "The printer prices in another currency than the product.",
      "The price is below the break-even floor for this production cost.",
    ]) {
      expect(() => expectHandHidden(old, secrets), old).toThrow();
    }
  });

  /**
   * The gate's two codes that name the pricing structure (`pod_unpriced`,
   * `currency_mismatch`) reach a tenant as ONE neutral code: src/app.ts
   * `adminResultResponse` translates them (consolidation). The WHOLE body is
   * walked for every refusal; the message is still the gate code's own.
   */
  const TENANT_CODE: Record<string, string> = {
    currency_mismatch: "pod_unavailable",
    pod_unpriced: "pod_unavailable",
  };

  it.each(["tenant", "acting"] as const)("every publish and price-edit refusal a %s session reads (adminResultResponse)", async (caller) => {
    const refusal = async (path: string, method: string, body: unknown, code: string) => {
      const response = await call(caller, path, method, body);
      expect(response.status, `${method} ${path}`).toBe(422);
      const answer = await response.json<{ error: { code: string; message: string } }>();
      expect(answer.error.code).toBe(TENANT_CODE[code] ?? code);
      expectHandHidden(answer, secrets);
      expect(answer.error.message).toBe(podRefusalMessage(code));
    };
    const publish = (productId: string, code: string) =>
      refusal(`/v1/admin/products/${productId}/publish`, "POST", undefined, code);
    const mapBySql = (productId: string, sku: string, status: "active" | "suspended") => {
      const iso = new Date().toISOString();
      return env.DB.prepare(
        `INSERT INTO pod_mappings (id, tenant_id, product_id, variant_id, artwork_id, printer_id, sku,
           slots_json, status, suspended_reason, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'art-a', 'fake-printer', ?, '[{"slot":"front","widthMm":299,"heightMm":399}]', ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), TENANT_A, productId, sku, status, status === "suspended" ? "sku_unavailable" : null, iso, iso)
        .run();
    };
    const mapByHttp = async (productId: string) => {
      const response = await call(caller, "/v1/admin/pod/mappings", "POST", {
        artworkId: "art-a",
        printerId: "fake-printer",
        productId,
        sku: TEE_S,
        slots: ["front"],
      });
      expect(response.status).toBe(201);
    };

    // price_below_floor at publish.
    const underPriced = next(`pp-pub-${caller}-low`);
    await seedProduct(TENANT_A, { priceMinor: 100, productId: underPriced });
    await mapByHttp(underPriced);
    await publish(underPriced, "price_below_floor");

    // price_below_floor on a live product's price cut.
    const live = next(`pp-pub-${caller}-live`);
    await seedProduct(TENANT_A, { priceMinor: 90_000, productId: live });
    await mapByHttp(live);
    expect((await call(caller, `/v1/admin/products/${live}/publish`, "POST")).status).toBe(200);
    await refusal(`/v1/admin/products/${live}`, "PATCH", { priceMinor: 100 }, "price_below_floor");

    // pod_mapping_missing, pod_mapping_suspended, taken_down.
    const missing = next(`pp-pub-${caller}-nomap`);
    await seedProduct(TENANT_A, { isPod: true, productId: missing });
    await publish(missing, "pod_mapping_missing");
    const suspended = next(`pp-pub-${caller}-susp`);
    await seedProduct(TENANT_A, { isPod: true, productId: suspended });
    await mapBySql(suspended, TEE_S, "suspended");
    await publish(suspended, "pod_mapping_suspended");
    const down = next(`pp-pub-${caller}-down`);
    await seedProduct(TENANT_A, { productId: down });
    await env.DB.prepare("UPDATE products SET takedown_at = ? WHERE product_id = ?").bind(new Date().toISOString(), down).run();
    await publish(down, "taken_down");

    // The gate's pod_unpriced and currency_mismatch (read as pod_unavailable):
    // an active mapping on a SKU with no price, a product in another currency.
    const noQuote = next(`pp-pub-${caller}-noquote`);
    await seedProduct(TENANT_A, { isPod: true, productId: noQuote });
    await mapBySql(noQuote, "2700005", "active");
    await publish(noQuote, "pod_unpriced");
    const otherMoney = next(`pp-pub-${caller}-eur`);
    await env.DB.prepare(
      `INSERT INTO products (product_id, tenant_id, status, sku, name, description, b2c_price_minor, currency, is_pod, created_at, updated_at)
       VALUES (?, ?, 'active', ?, 'Euro tee', NULL, 90000, 'EUR', 1, ?, ?)`,
    ).bind(otherMoney, TENANT_A, `SKU-${otherMoney}`, SEED_NOW, SEED_NOW).run();
    await mapBySql(otherMoney, TEE_S, "active");
    await publish(otherMoney, "currency_mismatch");
  });
});

describe("belowFloor is bounded: too many products to check is said, never a silent partial list", () => {
  it("above 1 000 products the report is { count: null, tooManyToCheck: true }, in the dry run and the real run", async () => {
    await resetPrinter();
    const iso = new Date().toISOString();
    const upTo1001 = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001)";
    await env.DB.batch([
      env.DB.prepare(
        `${upTo1001}
         INSERT INTO products (product_id, tenant_id, status, sku, name, description, b2c_price_minor, currency, is_pod, created_at, updated_at)
         SELECT 'bulk-' || i, ?, 'active', 'SKU-bulk-' || i, 'Bulk ' || i, NULL, 100, 'SEK', 1, ?, ? FROM n`,
      ).bind(TENANT_B, SEED_NOW, SEED_NOW),
      env.DB.prepare(
        `${upTo1001}
         INSERT INTO pod_mappings (id, tenant_id, product_id, variant_id, artwork_id, printer_id, sku, slots_json, status, suspended_reason, created_at, updated_at)
         SELECT 'bulk-map-' || i, ?, 'bulk-' || i, NULL, 'art-b', 'fake-printer', ?,
                '[{"slot":"front","widthMm":299,"heightMm":399}]', 'active', NULL, ?, ? FROM n`,
      ).bind(TENANT_B, TEE_S, iso, iso),
    ]);
    const dryRun = await editPrinter(env.DB, PLATFORM, "fake-printer", { name: "Bulk" }, Date.now(), {
      ...EDIT,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({ diff: { belowFloor: { count: null, tooManyToCheck: true } }, status: "ok" });
    const response = await call("platform", "/v1/platform/printers/fake-printer", "PATCH", { name: "Bulk" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      diff: { belowFloor: { count: null, tooManyToCheck: true } },
    });
  });
});
