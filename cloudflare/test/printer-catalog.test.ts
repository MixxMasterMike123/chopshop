import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import catalogFile from "../../docs/SnapWearDocs/snapwear-catalog.json";
import { createMapping, listMappings } from "../src/pod/pod-mappings";
import {
  applyCatalog,
  eurCentsToWholeKronorMinor,
  parseCatalogApplyInput,
  parseCatalogPutInput,
  parseRateE4,
  storeCatalog,
} from "../src/pod/printer-catalog";
import type { CatalogApplyInput } from "../src/pod/printer-catalog";
import type { PrinterCapabilities, PrinterInput } from "../src/pod/printers";
import { replacePrinters } from "../src/pod/printers";
import { handlePlatformPrinterCatalogApplyRoute } from "../src/routes/pod-platform";
import {
  adminOf,
  CAP,
  expectHandHidden,
  grantActingAs,
  grantPlatformAdmin,
  grantTenantAdmin,
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
  testPrinter,
} from "./pod-fixtures";

/**
 * CP3-C: the supplier catalogue (`printer_catalog`) — store/read with its
 * sha256, and the apply route that turns it into the printer's capabilities
 * and tiers: dry run vs apply, equality with the seed scripts' output, exact
 * öre arithmetic, the environment policy, suspension, and the fences.
 */

const TENANT_A = "tenant-pc-a";
const HOST = "https://platform.pctest.test";
const CATALOG = catalogFile as unknown as {
  models: Record<string, Record<string, unknown>>;
  skus: Record<string, Record<string, unknown>>;
};
const CATALOG_PATH = "/v1/platform/printers/fake-printer/catalog";
const APPLY_PATH = "/v1/platform/printers/fake-printer/catalog/apply";

let tenantAdmin: { cookie: string; userId: string };
let platform: { cookie: string; userId: string };

type Caller = "anonymous" | "tenant" | "acting" | "platform";

function call(
  caller: Caller,
  path: string,
  method: string,
  body?: unknown,
  options: { origin?: string | null } = {},
): Promise<Response> {
  const url = `${HOST}${path}`;
  if (caller === "anonymous") {
    return exports.default.fetch(
      new Request(url, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "content-type": "application/json", origin: HOST },
        method,
      }),
    );
  }
  return exports.default.fetch(
    sessionRequest(url, method, {
      body,
      cookie: caller === "tenant" ? tenantAdmin.cookie : platform.cookie,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(caller === "platform" ? {} : { shopId: TENANT_A }),
    }),
  );
}

async function sha256Of(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function resetPrinter(printer: PrinterInput = testPrinter()): Promise<void> {
  expect(await replacePrinters(env.DB, PLATFORM, [printer], Date.now())).not.toBeNull();
}

async function putCatalog(catalog: unknown, extra: Record<string, unknown> = {}): Promise<Response> {
  return call("platform", CATALOG_PATH, "PUT", { catalog, ...extra });
}

async function storedPrinter(): Promise<{ capabilities: PrinterCapabilities; tiers: unknown[] }> {
  const [printer, tiers] = await env.DB.batch([
    env.DB.prepare("SELECT capabilities_json FROM printers WHERE id = 'fake-printer'"),
    env.DB.prepare(
      "SELECT sku, blank_cost_minor, print_costs_json FROM printer_sku_tiers WHERE printer_id = 'fake-printer' ORDER BY sku",
    ),
  ]);
  const row = (printer?.results ?? [])[0] as { capabilities_json: string };
  return {
    capabilities: JSON.parse(row.capabilities_json) as PrinterCapabilities,
    tiers: ((tiers?.results ?? []) as Array<{ blank_cost_minor: number; print_costs_json: string; sku: string }>).map(
      (tier) => ({ blankCostMinor: tier.blank_cost_minor, printCostsMinor: JSON.parse(tier.print_costs_json) as unknown, sku: tier.sku }),
    ),
  };
}

async function snapshot(): Promise<unknown> {
  const results = await env.DB.batch([
    env.DB.prepare("SELECT capabilities_json, revision, updated_at FROM printers WHERE id = 'fake-printer'"),
    env.DB.prepare("SELECT sku, blank_cost_minor, print_costs_json, updated_at FROM printer_sku_tiers WHERE printer_id = 'fake-printer' ORDER BY sku"),
    env.DB.prepare("SELECT id, status, suspended_reason FROM pod_mappings ORDER BY id"),
    env.DB.prepare("SELECT printer_id, content_sha256, imported_at FROM printer_catalog ORDER BY printer_id"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events"),
  ]);
  return results.map((result) => result.results);
}

function interleavingDb(batchCall: number, interleave: () => Promise<unknown>): D1Database {
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

// ── the reference implementations (the seed scripts, ported verbatim) ────────

/**
 * scripts/cf-port/seed-staging-slice.mjs `printerDocument()`, minus its file
 * read and its die() checks: model 18000, SKUs 2700003/2700004, the model's
 * front/back frames, `${colour} / ${size}` labels, blank 60 kr + 40 kr per
 * large print.
 */
const SLICE_MODEL = "18000";
const SLICE_SKUS = ["2700003", "2700004"];
function slicePrinterDocument(catalog: typeof CATALOG): { capabilities: PrinterCapabilities; tiers: unknown[] } {
  const model = catalog.models[SLICE_MODEL] as {
    back: { h: number; offsetTopMm?: number; w: number };
    front: { h: number; offsetTopMm?: number; w: number };
    garment?: string | null;
    name: string;
  };
  const frame = (area: { h: number; offsetTopMm?: number; w: number }) => ({
    h: area.h,
    w: area.w,
    ...(Number.isInteger(area.offsetTopMm) ? { offsetTopMm: area.offsetTopMm } : {}),
  });
  const skus: PrinterCapabilities["skus"] = {};
  for (const sku of SLICE_SKUS) {
    const entry = catalog.skus[sku] as { colour: string; size: string };
    skus[sku] = { label: `${entry.colour} / ${entry.size}`, model: SLICE_MODEL };
  }
  return {
    capabilities: {
      models: {
        [SLICE_MODEL]: {
          garment: model.garment ?? null,
          name: model.name,
          printAreasMm: { back: frame(model.back), front: frame(model.front) },
        },
      },
      skus,
    },
    tiers: SLICE_SKUS.map((sku) => ({ blankCostMinor: 6_000, printCostsMinor: { back: 4_000, front: 4_000 }, sku })),
  };
}

const SLICE_APPLY = {
  pricing: { basis: "sek", models: { [SLICE_MODEL]: { blankCostMinor: 6_000, printCostsMinor: { back: 4_000, front: 4_000 } } } },
  skus: SLICE_SKUS,
};

/** scripts/seed-snapwear-printer.cjs BASE_EUR + buildPricing, verbatim (floats). */
const EXTRA_PRINT_EUR = 3.3;
const BASE_EUR: Record<string, { eur: number; model: string }> = {
  bag: { eur: 5.22, model: "W101" },
  beanie: { eur: 8.9, model: "B445" },
  cap: { eur: 5.52, model: "TRUCKER" },
  hoodie: { eur: 13.72, model: "SF500" },
  longsleeve: { eur: 12.1, model: "64400" },
  sweatshirt: { eur: 11.9, model: "18000" },
  tee: { eur: 5.99, model: "64000" },
};
function firebaseSeedPricing(eurSek: number, buffer: number): { blankCostSek: Record<string, number>; print: number } {
  const factor = eurSek * (1 + buffer);
  const blankCostSek: Record<string, number> = {};
  for (const [garment, base] of Object.entries(BASE_EUR)) {
    blankCostSek[garment] = Math.round((base.eur - EXTRA_PRINT_EUR) * factor);
  }
  return { blankCostSek, print: Math.round(EXTRA_PRINT_EUR * factor) };
}

/**
 * The whole SnapWear offer as the Firebase seed routed it, as an apply body:
 * every SKU of the eight garment models, the seed's stand-in frames
 * (AREA_SOURCE / FIXED_AREAS: hoodie SF500 ← JH050 not provisional; longsleeve
 * 64400 ← 64000, bag W101 ← STAU760, cap and beanie fixed — provisional), and
 * its EUR pricing per garment (JH050, the second hoodie model, at the hoodie
 * price the seed gave every hoodie).
 */
const FULL_EUR_APPLY = {
  frames: {
    "64400": { fromModel: "64000" },
    B445: { printAreasMm: { front: { h: 50, w: 100 } } },
    SF500: { fromModel: "JH050", provisional: false },
    TRUCKER: { printAreasMm: { front: { h: 50, w: 70 } } },
    W101: { fromModel: "STAU760" },
  },
  models: ["64000", "64400", "18000", "SF500", "JH050", "TRUCKER", "B445", "W101"],
  pricing: {
    basis: "eur",
    bufferBp: 300,
    eurSek: "11.2",
    extraPrintEurCents: 330,
    models: {
      "18000": { baseEurCents: 1_190 },
      "64000": { baseEurCents: 599 },
      "64400": { baseEurCents: 1_210 },
      B445: { baseEurCents: 890 },
      JH050: { baseEurCents: 1_372 },
      SF500: { baseEurCents: 1_372 },
      TRUCKER: { baseEurCents: 552 },
      W101: { baseEurCents: 522 },
    },
    printSlots: ["front", "back", "pocket"],
  },
};

beforeAll(async () => {
  await seedTenant(TENANT_A, "pc-a.pctest.test");
  await seedProfile();
  await resetPrinter();
  await seedArtwork(TENANT_A, { artworkId: "art-a" });
  tenantAdmin = await signUp("pc-admin@pctest.test");
  await grantTenantAdmin(tenantAdmin.userId, TENANT_A);
  platform = await signUp("pc-platform@pctest.test");
  await grantPlatformAdmin(platform.userId);
  await grantActingAs(platform.userId, TENANT_A);
});

describe("exact öre arithmetic (the EUR basis)", () => {
  it("equals the Firebase seed's own prices for its whole table at 11.20 SEK/EUR + 3 %", () => {
    const firebase = firebaseSeedPricing(11.2, 0.03);
    const rateE4 = parseRateE4("11.2") ?? 0;
    for (const [garment, base] of Object.entries(BASE_EUR)) {
      expect(eurCentsToWholeKronorMinor(Math.round(base.eur * 100) - 330, rateE4, 300), garment).toBe(
        (firebase.blankCostSek[garment] ?? -1) * 100,
      );
    }
    expect(eurCentsToWholeKronorMinor(330, rateE4, 300)).toBe(firebase.print * 100);
    expect(firebase).toEqual({
      blankCostSek: { bag: 22, beanie: 65, cap: 26, hoodie: 120, longsleeve: 102, sweatshirt: 99, tee: 31 },
      print: 38,
    });
  });

  it("is exact half-up rounding of the rational value (independent remainder check, 40 000 cases)", () => {
    let halves = 0;
    let floatDisagreements = 0;
    for (const rateE4 of [100_000, 112_000, 115_000, 109_876, 150_001]) {
      for (const bufferBp of [0, 250, 300, 4_999]) {
        for (let cents = 0; cents <= 2_000; cents += 1) {
          const n = BigInt(cents) * BigInt(rateE4) * BigInt(10_000 + bufferBp);
          const d = 10_000_000_000n;
          const floor = n / d;
          const remainder = n % d;
          const expected = Number(floor + (2n * remainder >= d ? 1n : 0n)) * 100;
          const actual = eurCentsToWholeKronorMinor(cents, rateE4, bufferBp);
          expect(actual).toBe(expected);
          expect(Number.isSafeInteger(actual) && actual % 100 === 0).toBe(true);
          // The Firebase float formula agrees everywhere except exactly on a half krona.
          const float = Math.round((cents / 100) * (rateE4 / 10_000) * (1 + bufferBp / 10_000)) * 100;
          if (2n * remainder === d) {
            halves += 1;
          }
          if (float !== actual) {
            floatDisagreements += 1;
            expect(2n * remainder, `cents ${cents} rate ${rateE4} buffer ${bufferBp}`).toBe(d);
          }
        }
      }
    }
    expect(halves).toBeGreaterThan(0);
    expect(floatDisagreements).toBeLessThanOrEqual(halves);
  });

  it("an exact half krona rounds UP where the Firebase floats rounded down", () => {
    // 4.35 € − 3.30 € = 1.05 € at 10.00 SEK/EUR, no buffer = exactly 10.50 kr.
    expect(eurCentsToWholeKronorMinor(435 - 330, 100_000, 0)).toBe(1_100);
    // The seed's float expression lands at 10.499999999999998 and rounds to 10.
    expect(Math.round((4.35 - EXTRA_PRINT_EUR) * (10 * (1 + 0)))).toBe(10);
  });

  it("reads the rate exactly (four decimals at most) within the seed's plausibility bounds", () => {
    expect(parseRateE4("11.20")).toBe(112_000);
    expect(parseRateE4(11.2)).toBe(112_000);
    expect(parseRateE4("11.2371")).toBe(112_371);
    expect(parseRateE4("19.9999")).toBe(199_999);
    for (const bad of ["11.23715", 1e21, "5", "20", "5.0000", "-11", "11,2", "", null, Number.NaN]) {
      expect(parseRateE4(bad), String(bad)).toBeNull();
    }
  });
});

describe("PUT/GET /v1/platform/printers/:id/catalog — the stored supplier document", () => {
  it("stores the document with the sha256 of its stored bytes and returns it", async () => {
    const response = await putCatalog(catalogFile, {
      pricingBasis: { buffer: 0.03, eurSek: 11.2, extraPrintEur: 3.3 },
      source: "SnapWear sheets (SKU 21.09.xlsx + PrintArea.xlsx)",
    });
    expect(response.status).toBe(200);
    const stored = JSON.stringify(catalogFile);
    const sha = await sha256Of(stored);
    await expect(response.json()).resolves.toEqual({
      catalog: {
        contentSha256: sha,
        importedAt: expect.any(String) as unknown,
        importedBy: platform.userId,
        modelCount: 47,
        pricingBasis: { buffer: 0.03, eurSek: 11.2, extraPrintEur: 3.3 },
        printerId: "fake-printer",
        sizeBytes: new TextEncoder().encode(stored).length,
        skuCount: 323,
        source: "SnapWear sheets (SKU 21.09.xlsx + PrintArea.xlsx)",
      },
    });
    const row = await env.DB.prepare(
      "SELECT content_sha256, length(CAST(catalog_json AS BLOB)) AS bytes FROM printer_catalog WHERE printer_id = 'fake-printer'",
    ).first();
    expect(row).toEqual({ bytes: new TextEncoder().encode(stored).length, content_sha256: sha });

    const read = await call("platform", CATALOG_PATH, "GET");
    expect(read.status).toBe(200);
    const body = await read.json<{ catalog: { catalog: unknown; contentSha256: string } }>();
    expect(body.catalog.catalog).toEqual(catalogFile);
    expect(body.catalog.contentSha256).toBe(sha);
    expect(await sha256Of(JSON.stringify(body.catalog.catalog))).toBe(sha);

    const audit = await env.DB.prepare(
      "SELECT resource_id, metadata_json FROM audit_events WHERE action = 'pod.printers.catalog.put'",
    ).first<{ metadata_json: string; resource_id: string }>();
    expect(audit?.resource_id).toBe("fake-printer");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toEqual({
      contentSha256: sha,
      modelCount: 47,
      sizeBytes: new TextEncoder().encode(stored).length,
      skuCount: 323,
    });
  });

  it("refuses an unknown printer (404), a tenant printer (409), bad bodies (400) and >1 MiB (413)", async () => {
    const iso = new Date(SEED_NOW).toISOString();
    await env.DB.prepare(
      `INSERT INTO printers (id, tenant_id, type, name, status, currency, shipping_cost_minor, capabilities_json, created_at, updated_at)
       VALUES ('pc-shop-press', ?, 'manual', 'Shop press', 'active', 'SEK', 0, '{"models":{},"skus":{}}', ?, ?)`,
    ).bind(TENANT_A, iso, iso).run();
    const before = await snapshot();
    expect((await call("platform", "/v1/platform/printers/nobody/catalog", "PUT", { catalog: catalogFile })).status).toBe(404);
    const tenantOwned = await call("platform", "/v1/platform/printers/pc-shop-press/catalog", "PUT", { catalog: catalogFile });
    expect(tenantOwned.status).toBe(409);
    for (const body of [
      {},
      { catalog: [] },
      { catalog: { models: {} } },
      { catalog: { models: {}, skus: { "1": { colour: "Red" } } } },
      { catalog: catalogFile, source: "" },
      { catalog: catalogFile, pricingBasis: [1] },
      { catalog: catalogFile, extra: 1 },
    ]) {
      const response = await call("platform", CATALOG_PATH, "PUT", body);
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    const huge = { models: { filler: { note: "x".repeat(1_048_576) } }, skus: {} };
    const tooLarge = await putCatalog(huge);
    expect(tooLarge.status).toBe(413);
    expect(await snapshot()).toEqual(before);
    expect((await call("platform", "/v1/platform/printers/pc-shop-press/catalog", "GET")).status).toBe(404);
  });

  it("the schema holds the sha shape, the size cap and platform ownership", async () => {
    const iso = new Date().toISOString();
    const insert = (printerId: string, json: string, sha: string) =>
      env.DB.prepare(
        `INSERT INTO printer_catalog (printer_id, catalog_json, content_sha256, imported_at) VALUES (?, ?, ?, ?)`,
      ).bind(printerId, json, sha, iso).run();
    await expect(insert("pc-shop-press", "{}", "a".repeat(64))).rejects.toThrow(/platform printer/);
    await expect(insert("nobody", "{}", "a".repeat(64))).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE printer_catalog SET content_sha256 = 'XYZ' WHERE printer_id = 'fake-printer'").run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE printer_catalog SET catalog_json = '[1]' WHERE printer_id = 'fake-printer'").run(),
    ).rejects.toThrow();
  });
});

describe("POST …/catalog/apply — the seed, as a route", () => {
  let capMapping = "";
  let pocketMapping = "";
  let frontMapping = "";

  beforeAll(async () => {
    await resetPrinter();
    expect((await putCatalog(catalogFile)).status).toBe(200);
    const map = async (productId: string, sku: string, slots: Array<"front" | "pocket">) => {
      await seedProduct(TENANT_A, { productId });
      const result = await createMapping(
        env.DB,
        adminOf(TENANT_A),
        { artworkId: "art-a", printerId: "fake-printer", productId, sku, slots, variantId: null },
        Date.now(),
      );
      expect(result.status).toBe("ok");
      return result.status === "ok" ? result.mapping.mappingId : "";
    };
    capMapping = await map("pc-cap", CAP, ["front"]);
    pocketMapping = await map("pc-pocket", TEE_S, ["front", "pocket"]);
    frontMapping = await map("pc-front", TEE_M, ["front"]);
  });

  it("a dry run (the default) reports the diff and the would-be suspensions, and changes NOTHING", async () => {
    const before = await snapshot();
    const response = await call("platform", APPLY_PATH, "POST", SLICE_APPLY);
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      diff: {
        fields: ["capabilities"],
        models: { added: [SLICE_MODEL], changed: [], removed: ["2000", "TRUCKER"] },
        skus: { added: [], changed: [TEE_S, TEE_M], removed: [CAP] },
        tiers: { added: [], changed: [TEE_S, TEE_M], removed: [CAP] },
        unpricedSkus: [],
      },
      dryRun: true,
      suspendedMappings: 2,
    });
    expect(body.printer).toBeUndefined();
    const suspensions = (body.diff as { suspensions: Array<{ mappingId: string; reason: string }> }).suspensions;
    expect(new Map(suspensions.map((entry) => [entry.mappingId, entry.reason]))).toEqual(
      new Map([
        [capMapping, "sku_unavailable"],
        [pocketMapping, "unpriced"],
      ]),
    );
    expect(await snapshot()).toEqual(before);
  });

  it("apply: true produces EXACTLY what the slice seed's printerDocument() builds, and suspends in the same batch", async () => {
    const dryRun = await (await call("platform", APPLY_PATH, "POST", SLICE_APPLY)).json<{ diff: unknown; catalogSha256: string }>();
    const response = await call("platform", APPLY_PATH, "POST", { ...SLICE_APPLY, apply: true });
    expect(response.status).toBe(200);
    const body = await response.json<{ catalogSha256: string; diff: unknown; dryRun: boolean; printer: { revision: number } }>();
    expect(body.dryRun).toBe(false);
    // Same code path: the applied diff is the dry run's diff.
    expect(body.diff).toEqual(dryRun.diff);
    expect(body.catalogSha256).toBe(await sha256Of(JSON.stringify(catalogFile)));

    const reference = slicePrinterDocument(CATALOG);
    const stored = await storedPrinter();
    expect(stored.capabilities).toEqual(reference.capabilities);
    expect(stored.tiers).toEqual(reference.tiers);
    expect(body.printer).toMatchObject({ capabilities: reference.capabilities });

    const states = new Map(
      [...(await listMappings(env.DB, adminOf(TENANT_A), "pc-cap")), ...(await listMappings(env.DB, adminOf(TENANT_A), "pc-pocket")), ...(await listMappings(env.DB, adminOf(TENANT_A), "pc-front"))].map(
        (mapping) => [mapping.mappingId, `${mapping.status}:${mapping.suspendedReason ?? ""}`],
      ),
    );
    expect(states).toEqual(
      new Map([
        [capMapping, "suspended:sku_unavailable"],
        [pocketMapping, "suspended:unpriced"],
        [frontMapping, "active:"],
      ]),
    );
    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE action = 'pod.printers.catalog.apply'",
    ).first<{ metadata_json: string }>();
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toMatchObject({
      catalogSha256: body.catalogSha256,
      skus: { added: 0, changed: 2, removed: 1 },
      suspendedMappings: 2,
    });
    expect(audit?.metadata_json).not.toContain("6000");
  });

  it("`keep` keeps the tiers of the SKUs that stay; a new SKU arrives unpriced", async () => {
    const response = await call("platform", APPLY_PATH, "POST", {
      apply: true,
      pricing: { basis: "keep" },
      skus: [...SLICE_SKUS, "2700005"],
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      diff: { skus: { added: ["2700005"] }, tiers: { added: [], changed: [], removed: [] }, unpricedSkus: ["2700005"] },
      suspendedMappings: 0,
    });
    expect((await storedPrinter()).tiers).toEqual(slicePrinterDocument(CATALOG).tiers);
  });

  it("refuses a selection the catalogue cannot satisfy (400 invalid_selection, with the problems)", async () => {
    const before = await snapshot();
    const cases: Array<[unknown, RegExp]> = [
      [{ models: ["NOPE"], pricing: { basis: "keep" } }, /NOPE is not in the catalogue/],
      [{ pricing: { basis: "keep" }, skus: ["0000000"] }, /0000000 is not in the catalogue/],
      [{ models: ["TRUCKER"], pricing: { basis: "keep" } }, /TRUCKER has no print frames/],
      [{ frames: { "64000": { fromModel: "18000" } }, pricing: { basis: "keep" }, skus: SLICE_SKUS }, /frames: model 64000 is not in the selection/],
      [{ frames: { TRUCKER: { fromModel: "W101" } }, models: ["TRUCKER"], pricing: { basis: "keep" } }, /W101 has no print frames either/],
      [{ pricing: { basis: "sek", models: { "64000": { blankCostMinor: 1, printCostsMinor: {} } } }, skus: SLICE_SKUS }, /pricing.models: model 64000 is not in the selection/],
      [
        {
          pricing: { basis: "eur", bufferBp: 0, eurSek: "11.2", extraPrintEurCents: 330, models: { "18000": { baseEurCents: 329 } }, printSlots: ["front"] },
          skus: SLICE_SKUS,
        },
        /below extraPrintEurCents/,
      ],
      [{ pricing: { basis: "keep" } }, /select at least one model or SKU/],
    ];
    for (const [body, problem] of cases) {
      const response = await call("platform", APPLY_PATH, "POST", { ...(body as object), apply: true });
      expect(response.status, JSON.stringify(body)).toBe(400);
      const answer = await response.json<{ error: { code: string; problems: string[] } }>();
      expect(answer.error.code).toBe("invalid_selection");
      expect(answer.error.problems.join("\n")).toMatch(problem);
    }
    for (const body of [
      {},
      { skus: SLICE_SKUS },
      { apply: "yes", pricing: { basis: "keep" }, skus: SLICE_SKUS },
      { pricing: { basis: "sek" }, skus: SLICE_SKUS },
      { pricing: { basis: "keep", models: {} }, skus: SLICE_SKUS },
      { pricing: { basis: "eur", bufferBp: 0, eurSek: "11.23715", extraPrintEurCents: 330, models: {}, printSlots: ["front"] }, skus: SLICE_SKUS },
      { pricing: { basis: "eur", bufferBp: 5_000, eurSek: "11.2", extraPrintEurCents: 330, models: {}, printSlots: ["front"] }, skus: SLICE_SKUS },
      { pricing: { basis: "eur", bufferBp: 0, eurSek: "11.2", extraPrintEurCents: 330, models: {}, printSlots: [] }, skus: SLICE_SKUS },
      { frames: { TRUCKER: { fromModel: "W101", printAreasMm: { front: { h: 1, w: 1 } } } }, pricing: { basis: "keep" }, skus: SLICE_SKUS },
      { expectedCatalogSha256: "abc", pricing: { basis: "keep" }, skus: SLICE_SKUS },
      { pricing: { basis: "keep" }, skus: "2700003" },
      { pricing: { basis: "keep" }, skus: [TEE_S, TEE_S] },
    ]) {
      expect((await call("platform", APPLY_PATH, "POST", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("the fences: expected sha / revision, and a catalogue replaced mid-apply (409, nothing written)", async () => {
    const sha = await sha256Of(JSON.stringify(catalogFile));
    const wrongSha = await call("platform", APPLY_PATH, "POST", { ...SLICE_APPLY, apply: true, expectedCatalogSha256: "0".repeat(64) });
    expect(wrongSha.status).toBe(409);
    await expect(wrongSha.json()).resolves.toMatchObject({ error: { code: "catalog_changed" } });
    const stale = await call("platform", APPLY_PATH, "POST", { ...SLICE_APPLY, apply: true, expectedCatalogSha256: sha, expectedRevision: 0 });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "revision_mismatch" } });

    const before = await storedPrinter();
    const replaced = { ...catalogFile, generator: "a newer sheet" };
    const parsed = parseCatalogPutInput({ catalog: replaced });
    const input = parseCatalogApplyInput({ apply: true, pricing: { basis: "keep" }, skus: [TEE_S] }) as CatalogApplyInput;
    const result = await applyCatalog(
      // Batch 1 = editPrinter's read, batch 2 = its write: the catalogue moves in between.
      interleavingDb(2, async () => {
        if (parsed.status === "ok") {
          await storeCatalog(env.DB, PLATFORM, "fake-printer", parsed.input, Date.now());
        }
      }),
      PLATFORM,
      "fake-printer",
      input,
      Date.now(),
      "fake-printer",
    );
    expect(result).toEqual({ code: "concurrent_edit", status: "conflict" });
    expect(await storedPrinter()).toEqual(before);
    // Put the original back for the tests below.
    expect((await putCatalog(catalogFile)).status).toBe(200);
  });

  it("honours the environment policy for `api` printers", async () => {
    // D59: an imported, inactive SnapWear row on staging, with its catalogue.
    const iso = new Date(SEED_NOW).toISOString();
    await env.DB.prepare(
      `INSERT INTO printers (id, tenant_id, type, name, status, currency, shipping_cost_minor, capabilities_json, created_at, updated_at)
       VALUES ('snapwear', NULL, 'api', 'SnapWear', 'inactive', 'SEK', 0, '{"models":{},"skus":{}}', ?, ?)`,
    ).bind(iso, iso).run();
    expect((await call("platform", "/v1/platform/printers/snapwear/catalog", "PUT", { catalog: catalogFile })).status).toBe(200);
    const response = await call("platform", "/v1/platform/printers/snapwear/catalog/apply", "POST", { ...SLICE_APPLY, apply: true });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "printer_not_allowed" } });
    // A dry run is refused the same way: the policy is part of the result.
    expect((await call("platform", "/v1/platform/printers/snapwear/catalog/apply", "POST", SLICE_APPLY)).status).toBe(400);

    // A production-shaped env (target snapwear) refuses the staging fake printer.
    const before = await snapshot();
    const production = await handlePlatformPrinterCatalogApplyRoute(
      { ...env, DISPATCH_TARGET: "snapwear" } as unknown as Env,
      sessionRequest(`${HOST}${APPLY_PATH}`, "POST", { body: { ...SLICE_APPLY, apply: true }, cookie: platform.cookie }),
      "fake-printer",
    );
    expect(production.status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("no stored catalogue is a 409, an unknown printer the opaque 404", async () => {
    const iso = new Date(SEED_NOW).toISOString();
    await env.DB.prepare(
      `INSERT INTO printers (id, tenant_id, type, name, status, currency, shipping_cost_minor, capabilities_json, created_at, updated_at)
       VALUES ('pc-bare', NULL, 'manual', 'Bare', 'inactive', 'SEK', 0, '{"models":{},"skus":{}}', ?, ?)`,
    ).bind(iso, iso).run();
    const bare = await call("platform", "/v1/platform/printers/pc-bare/catalog/apply", "POST", SLICE_APPLY);
    expect(bare.status).toBe(409);
    await expect(bare.json()).resolves.toMatchObject({ error: { code: "no_catalog" } });
    const unknown = await call("platform", "/v1/platform/printers/nobody/catalog/apply", "POST", SLICE_APPLY);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
  });

  it("the whole SnapWear offer at the Firebase seed's EUR basis: its prices, its garments, its provisional areas", async () => {
    const response = await call("platform", APPLY_PATH, "POST", { ...FULL_EUR_APPLY, apply: true });
    expect(response.status).toBe(200);
    const body = await response.json<{ diff: { unpricedSkus: string[] }; printer: { capabilities: PrinterCapabilities } }>();
    expect(body.diff.unpricedSkus).toEqual([]);
    const { capabilities, tiers } = await storedPrinter();
    expect(Object.keys(capabilities.skus)).toHaveLength(323);

    const firebase = firebaseSeedPricing(11.2, 0.03);
    const garmentOf: Record<string, string> = { ...Object.fromEntries(Object.entries(BASE_EUR).map(([garment, base]) => [base.model, garment])), JH050: "hoodie" };
    for (const tier of tiers as Array<{ blankCostMinor: number; printCostsMinor: Record<string, number>; sku: string }>) {
      const model = capabilities.skus[tier.sku]?.model ?? "";
      const garment = garmentOf[model] ?? "";
      expect(tier, `${tier.sku} (${model})`).toEqual({
        blankCostMinor: (firebase.blankCostSek[garment] ?? -1) * 100,
        printCostsMinor: { back: firebase.print * 100, front: firebase.print * 100, pocket: firebase.print * 100 },
        sku: tier.sku,
      });
    }
    expect(capabilities.models.SF500?.printAreasMm).toEqual(capabilities.models.JH050?.printAreasMm);
    expect(capabilities.models.SF500?.provisional).toBeUndefined();
    expect(capabilities.models["64400"]).toMatchObject({ provisional: true });

    // The seller's view: the Firebase projection's garments + provisionalAreas, and nothing priced.
    const view = await exports.default.fetch(
      sessionRequest(`${HOST}/v1/admin/pod/printers`, "GET", { cookie: tenantAdmin.cookie, shopId: TENANT_A }),
    );
    expect(view.status).toBe(200);
    const printers = await view.json<{ printers: Array<{ garments: string[]; printerId: string; provisionalAreas: string[] }> }>();
    const fake = printers.printers.find((printer) => printer.printerId === "fake-printer");
    expect(fake?.garments).toEqual(["bag", "beanie", "cap", "hoodie", "longsleeve", "sweatshirt", "tee"]);
    expect(fake?.provisionalAreas).toEqual(["bag", "beanie", "cap", "longsleeve"]);
    const brands = [...new Set(Object.values(CATALOG.models).map((model) => model.brand).filter((brand): brand is string => typeof brand === "string"))];
    const numbers = new Set<number>();
    for (const tier of tiers as Array<{ blankCostMinor: number; printCostsMinor: Record<string, number> }>) {
      numbers.add(tier.blankCostMinor);
      Object.values(tier.printCostsMinor).forEach((cost) => numbers.add(cost));
    }
    expectHandHidden(
      printers,
      secretsOf([], { numbers: [...numbers, 1_190, 1_372, 599, 330, 112_000], strings: [...brands, await sha256Of(JSON.stringify(catalogFile))] }),
    );
  });
});

describe("platform sessions only", () => {
  it.each([
    ["GET", CATALOG_PATH, undefined],
    ["PUT", CATALOG_PATH, { catalog: { models: {}, skus: {} } }],
    ["POST", APPLY_PATH, { apply: true, pricing: { basis: "keep" }, skus: SLICE_SKUS }],
  ] as const)("%s %s: anonymous, tenant admin and a platform user acting as the shop get the opaque 404", async (method, path, body) => {
    const before = await snapshot();
    for (const caller of ["anonymous", "tenant", "acting"] as const) {
      const response = await call(caller, path, method, body);
      expect(response.status, caller).toBe(404);
      await expect(response.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
    }
    if (method !== "GET") {
      for (const origin of ["https://evil.test", null]) {
        const response = await call("platform", path, method, body, { origin });
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it("the catalogue routes answer only their own methods", async () => {
    for (const [method, path] of [
      ["POST", CATALOG_PATH],
      ["DELETE", CATALOG_PATH],
      ["GET", APPLY_PATH],
      ["PUT", APPLY_PATH],
    ] as const) {
      expect((await call("platform", path, method)).status, `${method} ${path}`).toBe(404);
    }
  });
});
