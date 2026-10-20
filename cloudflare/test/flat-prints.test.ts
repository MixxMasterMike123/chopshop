import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import garmentCatalog from "../../docs/cf-port/prodigi-catalog.json";
import printsCatalog from "../../docs/cf-port/prodigi-prints-catalog.json";
import { publishAdminProduct } from "../src/catalog/admin-catalog";
import { createCheckout, type CreateCheckoutInput } from "../src/commerce/checkout";
import { buildDispatchJob } from "../src/dispatch/dispatch-effect";
import { canvasSpec, type FrozenCanvasSlot } from "../src/dispatch/print-canvas";
import type { PrinterJob } from "../src/dispatch/printer-client";
import { toProdigiOrderBody } from "../src/dispatch/prodigi-wire";
import {
  createMapping,
  evaluatePodGate,
  parseCreateMappingInput,
  podRefusalMessage,
  resolveProductionLine,
} from "../src/pod/pod-mappings";
import { buildFromCatalog, type CatalogApplyInput } from "../src/pod/printer-catalog";
import {
  flatReachesPx,
  getPlatformPrinter,
  listTenantPrinters,
  parsePrinterCapabilities,
  type PrinterCapabilities,
  type PrinterInput,
  replacePrinters,
  slotFrame,
} from "../src/pod/printers";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  adminOf,
  PLATFORM,
  seedArtwork,
  seedProduct,
  seedProfile,
  seedTenant,
  TEE_S,
  testPrinter,
} from "./pod-fixtures";

/**
 * CP12 F2 — flat prints (framed posters) end to end in the Worker, and the
 * same per-model wire that carries the 18600's `edge` and the tote's
 * no-size / `default` area (CP11 U4B):
 *   the capability document (kind, px, attributes, prodigiPrintArea, a SKU's
 *   own attributes) and its caps; the catalogue apply from the committed
 *   posters catalogue; the tenant view (kind + px, never attributes); the
 *   mapping's placement (fit, background) and the per-size resolution rule
 *   at the mapping, the publish gate and checkout; the frozen snapshot; the
 *   flat canvas geometry; the Prodigi item of a poster, an 18600 and a tote.
 */

const TENANT = "tenant-flat-prints";
const HOST = "flat-prints.podtest.test";
const ADMIN = adminOf(TENANT);
const CONTEXT: TenantContext = { domainKind: "storefront", hostname: HOST, tenantId: TENANT };
const POSTER_12X16 = "GLOBAL-BFP-12X16.white-frame.12x16";
const POSTER_18X24 = "GLOBAL-BFP-18X24.white-frame.18x24";
const POSTER_ATTRIBUTES = {
  color: "white",
  frame: "Budget",
  glaze: "Acrylic / Perspex",
  mount: "No mount / Mat",
  paperType: "Silk",
  substrateWeight: "150gsm",
};

function applyInput(models: string[]): CatalogApplyInput {
  return { apply: false, frames: {}, models, pricing: { basis: "keep" }, skus: [] };
}

/** The posters printer's capability document, built from the committed catalogue. */
function posterCapabilities(): PrinterCapabilities {
  const built = buildFromCatalog(printsCatalog, applyInput(["BFP-12X16", "BFP-18X24"]));
  if (built.status !== "ok") {
    throw new Error(JSON.stringify(built.problems));
  }
  return built.built.capabilities;
}

function postersPrinter(capabilities: PrinterCapabilities = posterCapabilities()): PrinterInput {
  return {
    capabilities,
    currency: "SEK",
    name: "Prodigi prints (sandbox)",
    printerId: "prodigi-prints",
    provider: "prodigi",
    shippingCostMinor: 15_000,
    status: "active",
    tiers: Object.keys(capabilities.skus).map((sku) => ({
      blankCostMinor: 22_000,
      printCostsMinor: { front: 0 },
      sku,
    })),
    type: "api",
  };
}

async function setPrinters(capabilities?: PrinterCapabilities): Promise<void> {
  expect(
    await replacePrinters(env.DB, PLATFORM, [testPrinter(), postersPrinter(capabilities)], Date.now()),
  ).not.toBeNull();
}

/** The capability document with the 12×16's sheet `px` replaced (mm unchanged). */
function withSheetPx(px: { h: number; w: number }): PrinterCapabilities {
  const capabilities = posterCapabilities();
  const model = capabilities.models["BFP-12X16"]!;
  const front = model.printAreasMm.front!;
  return {
    ...capabilities,
    models: { ...capabilities.models, "BFP-12X16": { ...model, printAreasMm: { front: { ...front, px } } } },
  };
}

async function mapPoster(
  productId: string,
  artwork: { h: number; w: number },
  slots: unknown[] = ["front"],
  sku = POSTER_12X16,
) {
  const artworkId = `${productId}-art-${artwork.w}x${artwork.h}-${crypto.randomUUID().slice(0, 6)}`;
  await seedArtwork(TENANT, { artworkId, heightPx: artwork.h, widthPx: artwork.w });
  const input = parseCreateMappingInput({ artworkId, printerId: "prodigi-prints", productId, sku, slots });
  if (input === null) {
    throw new Error("mapping body");
  }
  return createMapping(env.DB, ADMIN, input, Date.now());
}

function shipped(productId: string): CreateCheckoutInput {
  return {
    deliveryMethod: "shipping",
    discountCode: null,
    email: "buyer@podtest.test",
    idempotencyKey: `idem-${crypto.randomUUID()}`,
    items: [{ productId, quantity: 1 }],
    shippingCountry: "SE",
  };
}

beforeAll(async () => {
  await seedTenant(TENANT, HOST);
  await seedProfile();
  await setPrinters();
  // Past D8's first-N (test/screening.test.ts owns that rule).
  await seedProduct(TENANT, { productId: "flat-live-1", published: true });
  await seedProduct(TENANT, { productId: "flat-live-2", published: true });
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limit_windows").run();
  await setPrinters();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the capability document carries flat models", () => {
  it("the catalogue apply builds the posters exactly (kind, front mm + px, attributes, default area)", () => {
    const capabilities = posterCapabilities();
    expect(capabilities.models["BFP-12X16"]).toEqual({
      attributes: POSTER_ATTRIBUTES,
      garment: "poster",
      kind: "flat",
      name: 'Budget Framed Poster, 30x40cm / 12x16"',
      printAreasMm: { front: { h: 400, offsetTopMm: 0, px: { h: 4_724, w: 3_543 }, w: 300 } },
      prodigiPrintArea: "default",
      requiredSlots: ["front"],
    });
    // The catalogue SKU repeats the model's attributes: nothing of its own is kept.
    expect(capabilities.skus[POSTER_12X16]).toEqual({ label: "White frame / 12x16", model: "BFP-12X16" });
    expect(capabilities.models["BFP-18X24"]?.printAreasMm.front?.px).toEqual({ h: 7_086, w: 5_314 });
    // The document is what the parser keeps, key for key.
    expect(parsePrinterCapabilities(JSON.parse(JSON.stringify(capabilities)))).toEqual(capabilities);
  });

  it("the slice seed's --printer prodigi-prints document is the catalogue apply's (scripts/cf-port/seed-staging-slice.mjs)", () => {
    // prodigiPrintsDocument(), ported: model BFP-12X16, the one SKU, front mm + the sheet's px.
    const model = printsCatalog.models["BFP-12X16"];
    const seeded = parsePrinterCapabilities({
      models: {
        "BFP-12X16": {
          attributes: model.attributes,
          garment: model.garment,
          kind: "flat",
          name: model.name,
          printAreasMm: {
            front: { h: model.front.h, offsetTopMm: model.front.offsetTopMm, px: model.printAreaPx.front, w: model.front.w },
          },
          prodigiPrintArea: model.prodigiPrintArea,
          requiredSlots: ["front"],
        },
      },
      skus: { [POSTER_12X16]: { label: "White frame / 12x16", model: "BFP-12X16" } },
    });
    const applied = buildFromCatalog(printsCatalog, { ...applyInput([]), skus: [POSTER_12X16] });
    expect(seeded).not.toBeNull();
    expect(applied.status === "ok" && applied.built.capabilities).toEqual(seeded);
  });

  it("the 18600 keeps its per-colour `edge` on the SKU; the tote gets its `default` area", () => {
    const built = buildFromCatalog(garmentCatalog, applyInput(["18600", "STAU773"]));
    expect(built.status).toBe("ok");
    if (built.status !== "ok") return;
    const { models, skus } = built.built.capabilities;
    expect(skus["GLOBAL-HOOD-GIL-18600.white.m"]).toEqual({ attributes: { edge: "Zip" }, label: "White / M", model: "18600" });
    expect(skus["GLOBAL-HOOD-GIL-18600.ash.m"]).toEqual({ attributes: { edge: "Drawstring" }, label: "Ash / M", model: "18600" });
    expect(models["18600"]?.prodigiPrintArea).toBeUndefined();
    expect(models["18600"]?.kind).toBeUndefined();
    expect(models.STAU773?.prodigiPrintArea).toBe("default");
    expect(skus["H-BAG-LTOTE.anthracite.one-size"]).toEqual({ label: "Anthracite / One Size", model: "STAU773" });
    // A garment from the same catalogue is unchanged: no attributes, no kind, no area name, no px.
    const tee = buildFromCatalog(garmentCatalog, applyInput(["64000"]));
    const teeModel = tee.status === "ok" ? tee.built.capabilities.models["64000"] : undefined;
    expect(Object.keys(teeModel ?? {}).sort()).toEqual(["garment", "name", "printAreasMm"]);
    expect(JSON.stringify(teeModel)).not.toContain('"px"');
    expect(tee.status === "ok" && tee.built.capabilities.skus["GLOBAL-TEE-GIL-64000.black.m"]).toEqual({
      label: "Black / M",
      model: "64000",
    });
  });

  it("a flat catalogue model without its pixel area, or with a frames override, is refused", () => {
    const model = printsCatalog.models["BFP-12X16"];
    const noPx = { ...printsCatalog, models: { "BFP-12X16": { ...model, printAreaPx: { front: null } } } };
    expect(buildFromCatalog(noPx, applyInput(["BFP-12X16"])).status).toBe("invalid");
    const twoSlots = { ...printsCatalog, models: { "BFP-12X16": { ...model, back: { h: 400, w: 300 } } } };
    expect(buildFromCatalog(twoSlots, applyInput(["BFP-12X16"])).status).toBe("invalid");
    const override = buildFromCatalog(printsCatalog, {
      ...applyInput(["BFP-12X16"]),
      frames: { "BFP-12X16": { printAreasMm: { front: { h: 400, w: 300 } }, provisional: false } },
    });
    expect(override.status).toBe("invalid");
    const badAttributes = { ...printsCatalog, models: { "BFP-12X16": { ...model, attributes: { "bad key": "x" } } } };
    expect(buildFromCatalog(badAttributes, applyInput(["BFP-12X16"])).status).toBe("invalid");
  });

  it("every new key is parsed with caps, and a contradiction refuses the whole document", () => {
    const good = JSON.parse(JSON.stringify(posterCapabilities())) as {
      models: Record<string, Record<string, unknown>>;
      skus: Record<string, Record<string, unknown>>;
    };
    expect(parsePrinterCapabilities(good)).not.toBeNull();
    const model = good.models["BFP-12X16"]!;
    const front = (model.printAreasMm as { front: Record<string, unknown> }).front;
    const withModel = (patch: Record<string, unknown>) => ({
      ...good,
      models: { ...good.models, "BFP-12X16": { ...model, ...patch } },
    });
    const thirteen = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, "v"]));
    for (const [label, document] of [
      ["kind other", withModel({ kind: "mug" })],
      ["flat with two slots", withModel({ printAreasMm: { back: { h: 400, w: 300 }, front } })],
      ["flat without px", withModel({ printAreasMm: { front: { h: 400, w: 300 } } })],
      ["flat provisional", withModel({ provisional: true })],
      ["flat requiring back", withModel({ requiredSlots: ["back"] })],
      ["px over the cap", withModel({ printAreasMm: { front: { ...front, px: { h: 20_001, w: 10 } } } })],
      ["px not an integer", withModel({ printAreasMm: { front: { ...front, px: { h: 4_724.5, w: 3_543 } } } })],
      ["px with an extra key", withModel({ printAreasMm: { front: { ...front, px: { h: 1, w: 1, z: 1 } } } })],
      ["13 attributes", withModel({ attributes: thirteen })],
      ["no attributes in the set", withModel({ attributes: {} })],
      ["a key that is not an identifier", withModel({ attributes: { "paper type": "Silk" } })],
      ["a value over 64 characters", withModel({ attributes: { frame: "x".repeat(65) } })],
      ["an empty value", withModel({ attributes: { frame: "" } })],
      ["a control character", withModel({ attributes: { frame: "Budget\n" } })],
      ["a value that is not a string", withModel({ attributes: { frame: 1 } })],
      ["an area name with a space", withModel({ prodigiPrintArea: "de fault" })],
      ["an area name too long", withModel({ prodigiPrintArea: "a".repeat(33) })],
      [
        "SKU attributes malformed",
        { ...good, skus: { ...good.skus, [POSTER_12X16]: { ...good.skus[POSTER_12X16], attributes: { edge: 1 } } } },
      ],
    ] as const) {
      expect(parsePrinterCapabilities(document), label).toBeNull();
    }
    // `kind: "garment"` is the default, accepted and not stored.
    const tee = { models: { M: { garment: "tee", kind: "garment", printAreasMm: { front: { h: 1, w: 1 } } } }, skus: {} };
    expect(parsePrinterCapabilities(tee)?.models.M).toEqual({ garment: "tee", printAreasMm: { front: { h: 1, w: 1 } } });
  });

  it("a flat model prints its one slot and nothing derived from it", () => {
    const capabilities = posterCapabilities();
    expect(slotFrame(capabilities, POSTER_12X16, "front")).toMatchObject({ h: 400, w: 300 });
    expect(slotFrame(capabilities, POSTER_12X16, "pocket")).toBeNull();
    expect(slotFrame(capabilities, POSTER_12X16, "back")).toBeNull();
  });

  it("the resolution rule: contain reaches the sheet on one axis, cover on both", () => {
    const sheet = { h: 4_724, w: 3_543 };
    expect(flatReachesPx({ h: 3_600, w: 3_600 }, sheet, "contain")).toBe(true);
    expect(flatReachesPx({ h: 4_724, w: 100 }, sheet, "contain")).toBe(true);
    expect(flatReachesPx({ h: 3_000, w: 3_000 }, sheet, "contain")).toBe(false);
    expect(flatReachesPx({ h: 3_600, w: 3_600 }, sheet, "cover")).toBe(false);
    expect(flatReachesPx({ h: 4_724, w: 3_543 }, sheet, "cover")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the views: the seller sees capability, the platform everything", () => {
  it("the tenant view carries kind, garment and the front area in mm + px — never attributes or the area name", async () => {
    const view = (await listTenantPrinters(env.DB, TENANT)).find((printer) => printer.printerId === "prodigi-prints");
    expect(view?.capabilities.models["BFP-12X16"]).toEqual({
      garment: "poster",
      kind: "flat",
      name: 'Budget Framed Poster, 30x40cm / 12x16"',
      printAreasMm: { front: { h: 400, offsetTopMm: 0, px: { h: 4_724, w: 3_543 }, w: 300 } },
    });
    expect(view?.capabilities.skus[POSTER_12X16]).toEqual({ label: "White frame / 12x16", model: "BFP-12X16" });
    expect(view?.garments).toEqual(["poster"]);
    const text = JSON.stringify(view);
    for (const hidden of ["attributes", "prodigiPrintArea", "Acrylic", "default", "Cost", "tiers"]) {
      expect(text, hidden).not.toContain(hidden);
    }
  });

  it("an 18600 SKU's `edge` stays platform-side too", async () => {
    const built = buildFromCatalog(garmentCatalog, applyInput(["18600"]));
    if (built.status !== "ok") throw new Error("18600");
    const hoodie = { ...testPrinter(), capabilities: built.built.capabilities, name: "Prodigi", printerId: "prodigi", provider: "prodigi" as const, tiers: [] };
    expect(await replacePrinters(env.DB, PLATFORM, [testPrinter(), postersPrinter(), hoodie], Date.now())).not.toBeNull();
    const view = (await listTenantPrinters(env.DB, TENANT)).find((printer) => printer.printerId === "prodigi");
    expect(view?.capabilities.skus["GLOBAL-HOOD-GIL-18600.white.m"]).toEqual({ label: "White / M", model: "18600" });
    expect(JSON.stringify(view)).not.toContain("edge");
    const platform = await getPlatformPrinter(env.DB, "prodigi");
    expect((platform?.capabilities as PrinterCapabilities).skus["GLOBAL-HOOD-GIL-18600.white.m"]?.attributes).toEqual({ edge: "Zip" });
  });

  it("the platform view shows the stored document whole", async () => {
    const platform = await getPlatformPrinter(env.DB, "prodigi-prints");
    expect(platform?.capabilitiesValid).toBe(true);
    expect((platform?.capabilities as PrinterCapabilities).models["BFP-12X16"]).toMatchObject({
      attributes: POSTER_ATTRIBUTES,
      kind: "flat",
      prodigiPrintArea: "default",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the mapping's placement and the per-size resolution rule", () => {
  it("parses a slot as a name or { slot, fit?, background? }, lower-casing the colour; refuses the rest", () => {
    const base = { artworkId: "a", printerId: "p", productId: "x", sku: POSTER_12X16 };
    expect(parseCreateMappingInput({ ...base, slots: [{ background: "#1A2B3C", fit: "cover", slot: "front" }] })).toEqual({
      ...base,
      placements: { front: { background: "#1a2b3c", fit: "cover" } },
      slots: ["front"],
      variantId: null,
    });
    expect(parseCreateMappingInput({ ...base, slots: [{ slot: "front" }] })).toEqual({ ...base, slots: ["front"], variantId: null });
    for (const slots of [
      [{ fit: "stretch", slot: "front" }],
      [{ background: "white", slot: "front" }],
      [{ background: "#fff", slot: "front" }],
      [{ slot: "front", x: 1 }],
      [{ fit: "cover" }],
      [{ slot: "front" }, "front"],
    ]) {
      expect(parseCreateMappingInput({ ...base, slots }), JSON.stringify(slots)).toBeNull();
    }
  });

  it("a poster mapping stores fit and background on its slot (default contain, white), sized from the pixels", async () => {
    await seedProduct(TENANT, { productId: "poster-default", priceMinor: 99_900 });
    const contained = await mapPoster("poster-default", { h: 3_600, w: 3_600 });
    expect(contained.status).toBe("ok");
    if (contained.status !== "ok") return;
    // 3600² contained in 3543 × 4724: 3543 × 3543 px = 300 × 300 mm.
    expect(contained.mapping.slots).toEqual([{ background: "#ffffff", fit: "contain", heightMm: 300, slot: "front", widthMm: 300 }]);

    await seedProduct(TENANT, { productId: "poster-cover", priceMinor: 99_900 });
    const covered = await mapPoster("poster-cover", { h: 6_000, w: 4_000 }, [{ background: "#000000", fit: "cover", slot: "front" }]);
    expect(covered.status === "ok" && covered.mapping.slots).toEqual([
      { background: "#000000", fit: "cover", heightMm: 400, slot: "front", widthMm: 300 },
    ]);
  });

  it("refuses a master below the sheet (per fit), a slot a poster does not have, and a placement on a garment", async () => {
    await seedProduct(TENANT, { productId: "poster-refusals", priceMinor: 99_900 });
    expect(await mapPoster("poster-refusals", { h: 3_000, w: 3_000 })).toEqual({ code: "resolution_too_low", status: "refused" });
    // Reaches the 12×16 contained, but not covered, and not the 18×24 at all.
    expect(await mapPoster("poster-refusals", { h: 3_600, w: 3_600 }, [{ fit: "cover", slot: "front" }])).toEqual({
      code: "resolution_too_low",
      status: "refused",
    });
    expect(await mapPoster("poster-refusals", { h: 3_600, w: 3_600 }, ["front"], POSTER_18X24)).toEqual({
      code: "resolution_too_low",
      status: "refused",
    });
    expect(await mapPoster("poster-refusals", { h: 6_000, w: 6_000 }, ["back"])).toEqual({ code: "slot_not_printable", status: "refused" });
    expect(await mapPoster("poster-refusals", { h: 6_000, w: 6_000 }, ["pocket"])).toEqual({ code: "slot_not_printable", status: "refused" });

    await seedProduct(TENANT, { productId: "tee-placement", priceMinor: 99_900 });
    await seedArtwork(TENANT, { artworkId: "tee-placement-art" });
    const input = parseCreateMappingInput({
      artworkId: "tee-placement-art",
      printerId: "fake-printer",
      productId: "tee-placement",
      sku: TEE_S,
      slots: [{ fit: "cover", slot: "front" }],
    });
    expect(input && (await createMapping(env.DB, ADMIN, input, Date.now()))).toEqual({
      code: "placement_unsupported",
      status: "refused",
    });
  });

  it("publish and checkout refuse a poster whose sheet outgrew its master (pod_resolution_too_low), with a seller sentence", async () => {
    await seedProduct(TENANT, { productId: "poster-outgrown", priceMinor: 99_900 });
    expect((await mapPoster("poster-outgrown", { h: 4_724, w: 3_543 })).status).toBe("ok");
    expect(await evaluatePodGate(env.DB, TENANT, "poster-outgrown")).toBeNull();
    // The printer's sheet grows (a catalogue re-apply), its millimetres do not:
    // nothing is suspended, but the master no longer reaches it.
    await setPrinters(withSheetPx({ h: 4_800, w: 3_600 }));
    expect(await evaluatePodGate(env.DB, TENANT, "poster-outgrown")).toBe("pod_resolution_too_low");
    expect(await publishAdminProduct(env.DB, ADMIN, "poster-outgrown", Date.now())).toMatchObject({
      code: "pod_resolution_too_low",
      status: "refused",
    });
    expect(podRefusalMessage("pod_resolution_too_low")).toMatch(/resolution/);
    expect(
      await resolveProductionLine(env.DB, TENANT, { productId: "poster-outgrown", quantity: 1, variantId: null }, "staging"),
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("checkout freezes what the canvas and the wire need", () => {
  it("a poster line: the sheet's pixels, fit and background per file; the supplier facts per line", async () => {
    await seedProduct(TENANT, { productId: "poster-sold", priceMinor: 99_900 });
    expect((await mapPoster("poster-sold", { h: 3_600, w: 3_600 })).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "poster-sold", Date.now())).status).toBe("ok");

    const line = await resolveProductionLine(env.DB, TENANT, { productId: "poster-sold", quantity: 1, variantId: null }, "staging");
    expect(line?.printFiles[0]?.flat).toEqual({ background: "#ffffff", canvasPx: { h: 4_724, w: 3_543 }, fit: "contain" });
    expect(line?.printerItem).toEqual({ attributes: POSTER_ATTRIBUTES, kind: "flat", printArea: "default" });

    const result = await createCheckout(env.DB, CONTEXT, shipped("poster-sold"), Date.now(), { printerEnvironment: "staging" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const row = await env.DB.prepare("SELECT production_snapshot_json FROM checkouts WHERE checkout_id = ?")
      .bind(result.checkout.checkoutId)
      .first<{ production_snapshot_json: string }>();
    const snapshot = JSON.parse(row!.production_snapshot_json) as { lines: Array<Record<string, unknown>>; printer: string };
    expect(snapshot.printer).toBe("prodigi-prints");
    expect(snapshot.lines[0]).toMatchObject({
      printFiles: [
        {
          flat: { background: "#ffffff", canvasPx: { h: 4_724, w: 3_543 }, fit: "contain" },
          frameMm: { h: 400, offsetTopMm: 0, w: 300 },
          slot: "front",
          sourcePx: { h: 3_600, w: 3_600 },
        },
      ],
      printerItem: { attributes: POSTER_ATTRIBUTES, kind: "flat", printArea: "default" },
      sku: POSTER_12X16,
    });
    // frameMm stays the millimetre frame (the pixels live in `flat`).
    expect(JSON.stringify((snapshot.lines[0]!.printFiles as unknown[])[0])).not.toContain('"px"');
  });

  it("a garment line freezes neither (byte-for-byte the CP11 line)", async () => {
    await seedProduct(TENANT, { productId: "tee-plain", priceMinor: 99_900 });
    await seedArtwork(TENANT, { artworkId: "tee-plain-art" });
    expect(
      (await createMapping(env.DB, ADMIN, {
        artworkId: "tee-plain-art",
        printerId: "fake-printer",
        productId: "tee-plain",
        sku: TEE_S,
        slots: ["front"],
        variantId: null,
      }, Date.now())).status,
    ).toBe("ok");
    const line = await resolveProductionLine(env.DB, TENANT, { productId: "tee-plain", quantity: 1, variantId: null }, "staging");
    expect(line).not.toBeNull();
    expect(line).not.toHaveProperty("printerItem");
    expect(line?.printFiles[0]).not.toHaveProperty("flat");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the flat canvas", () => {
  const POSTER_SLOT: FrozenCanvasSlot = {
    flat: { background: "#ffffff", canvasPx: { h: 4_724, w: 3_543 }, fit: "contain" },
    frameMm: { h: 400, offsetTopMm: 0, w: 300 },
    frameProvisional: false,
    location: "front",
    r2Key: "pod/t/print/a.png",
    sha256: "b".repeat(64),
    sourcePx: { h: 3_600, w: 3_600 },
    widthMm: 300,
  };

  it("contain: the sheet's exact pixels, the whole master centred, the background named", () => {
    expect(canvasSpec(POSTER_SLOT)).toEqual({
      ok: true,
      spec: {
        background: "#ffffff",
        canvasPx: { h: 4_724, w: 3_543 },
        dpi: 300,
        fit: "contain",
        motifPx: { h: 3_543, w: 3_543 },
        offsetPx: { left: 0, top: 590 },
        sourceCropPx: { h: 3_600, left: 0, top: 0, w: 3_600 },
        sourcePx: { h: 3_600, w: 3_600 },
        version: 1,
      },
    });
  });

  it("cover: the sheet's aspect cut from the master's centre, filling the sheet", () => {
    const slot = { ...POSTER_SLOT, flat: { ...POSTER_SLOT.flat!, fit: "cover" as const }, sourcePx: { h: 6_000, w: 4_000 } };
    expect(canvasSpec(slot)).toEqual({
      ok: true,
      spec: {
        background: "#ffffff",
        canvasPx: { h: 4_724, w: 3_543 },
        dpi: 300,
        fit: "cover",
        motifPx: { h: 4_724, w: 3_543 },
        offsetPx: { left: 0, top: 0 },
        sourceCropPx: { h: 5_333, left: 0, top: 333, w: 4_000 },
        sourcePx: { h: 6_000, w: 4_000 },
        version: 1,
      },
    });
  });

  it("refuses to enlarge, a stand-in or missing frame, missing pixels, a sheet over the cap", () => {
    expect(canvasSpec({ ...POSTER_SLOT, sourcePx: { h: 3_000, w: 3_000 } })).toEqual({
      error: "print_canvas_resolution_too_low",
      ok: false,
    });
    expect(canvasSpec({ ...POSTER_SLOT, flat: { ...POSTER_SLOT.flat!, fit: "cover" } })).toEqual({
      error: "print_canvas_resolution_too_low",
      ok: false,
    });
    expect(canvasSpec({ ...POSTER_SLOT, frameProvisional: true })).toEqual({ error: "print_canvas_frame_provisional", ok: false });
    expect(canvasSpec({ ...POSTER_SLOT, frameMm: undefined })).toEqual({ error: "print_canvas_frame_missing", ok: false });
    expect(canvasSpec({ ...POSTER_SLOT, sourcePx: undefined })).toEqual({ error: "print_canvas_source_missing", ok: false });
    expect(
      canvasSpec({ ...POSTER_SLOT, flat: { ...POSTER_SLOT.flat!, canvasPx: { h: 8_000, w: 6_000 } }, sourcePx: { h: 8_000, w: 8_000 } }),
    ).toEqual({ error: "print_canvas_too_large", ok: false });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the dispatcher reads the frozen facts strictly", () => {
  function production(extra: Record<string, unknown>, file: Record<string, unknown> = {}): string {
    return JSON.stringify({
      lineNo: 1,
      printFiles: [{ heightMm: 300, r2Key: "pod/t/print/a.png", sha256: "b".repeat(64), slot: "front", widthMm: 300, ...file }],
      quantity: 1,
      sku: POSTER_12X16,
      ...extra,
    });
  }
  const FLAT = { background: "#ffffff", canvasPx: { h: 4_724, w: 3_543 }, fit: "contain" };
  const ITEM = { attributes: POSTER_ATTRIBUTES, kind: "flat", printArea: "default" };

  it("keeps a well-formed flat file and printerItem", () => {
    const built = buildDispatchJob("t", 1, production({ printerItem: ITEM }, { flat: FLAT }));
    expect(built.ok && built.value.printerItem).toEqual(ITEM);
    expect(built.ok && built.value.printFiles[0]?.flat).toEqual(FLAT);
  });

  it("refuses the line rather than drop a malformed one", () => {
    for (const [label, extra, file] of [
      ["flat background", {}, { flat: { ...FLAT, background: "white" } }],
      ["flat fit", {}, { flat: { ...FLAT, fit: "stretch" } }],
      ["flat pixels", {}, { flat: { ...FLAT, canvasPx: { h: 0, w: 1 } } }],
      ["item kind", { printerItem: { ...ITEM, kind: "mug" } }, {}],
      ["item area", { printerItem: { ...ITEM, printArea: "" } }, {}],
      ["item attributes", { printerItem: { ...ITEM, attributes: { frame: 1 } } }, {}],
      ["item extra key", { printerItem: { ...ITEM, sku: "x" } }, {}],
    ] as const) {
      expect(buildDispatchJob("t", 1, production(extra, file)), label).toEqual({ error: "production_line_invalid", ok: false });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the Prodigi item per model (the poster, the 18600, the tote)", () => {
  const SHIP_TO = {
    addressLine1: "Storgatan 1",
    addressLine2: null,
    city: "Klippan",
    country: "SE",
    name: "Test Köpare",
    phone: null,
    postalCode: "264 33",
  };

  function job(lines: PrinterJob["lines"]): PrinterJob & { shipTo: typeof SHIP_TO } {
    return { jobId: "o", lines, orderId: "0e3b8f0a-1111-4222-8333-444455556666", shipTo: SHIP_TO };
  }

  function line(sku: string, extra: Partial<PrinterJob["lines"][number]> = {}): PrinterJob["lines"][number] {
    return {
      artworks: [{ location: "front", url: `https://r2.test.invalid/${sku}.png` }],
      lineNo: 1,
      mockupUrls: [],
      quantity: 1,
      sku,
      ...extra,
    };
  }

  it("builds each item exactly", () => {
    const built = toProdigiOrderBody(
      job([
        line(POSTER_12X16, { printerItem: { attributes: POSTER_ATTRIBUTES, kind: "flat", printArea: "default" } }),
        line("GLOBAL-HOOD-GIL-18600.white.m", {
          artworks: [
            { location: "front", url: "https://r2.test.invalid/h-front.png" },
            { location: "back", url: "https://r2.test.invalid/h-back.png" },
          ],
          lineNo: 2,
          printerItem: { attributes: { edge: "Zip" } },
        }),
        line("H-BAG-LTOTE.anthracite.one-size", { lineNo: 3, printerItem: { printArea: "default" } }),
        line("GLOBAL-TEE-GIL-64000.black.m", { lineNo: 4 }),
      ]),
      "https://api.test/v1/webhooks/prodigi",
    );
    expect("body" in built && built.body.items).toStrictEqual([
      {
        assets: [{ printArea: "default", url: `https://r2.test.invalid/${POSTER_12X16}.png` }],
        attributes: POSTER_ATTRIBUTES,
        copies: 1,
        merchantReference: "1",
        sizing: "fitPrintArea",
        sku: "GLOBAL-BFP-12X16",
      },
      {
        assets: [
          { printArea: "front", url: "https://r2.test.invalid/h-front.png" },
          { printArea: "back", url: "https://r2.test.invalid/h-back.png" },
        ],
        attributes: { color: "white", edge: "Zip", size: "m" },
        copies: 1,
        merchantReference: "2",
        sizing: "fitPrintArea",
        sku: "GLOBAL-HOOD-GIL-18600",
      },
      {
        assets: [{ printArea: "default", url: "https://r2.test.invalid/H-BAG-LTOTE.anthracite.one-size.png" }],
        attributes: { color: "anthracite" },
        copies: 1,
        merchantReference: "3",
        sizing: "fitPrintArea",
        sku: "H-BAG-LTOTE",
      },
      {
        assets: [{ printArea: "front", url: "https://r2.test.invalid/GLOBAL-TEE-GIL-64000.black.m.png" }],
        attributes: { color: "black", size: "m" },
        copies: 1,
        merchantReference: "4",
        sizing: "fitPrintArea",
        sku: "GLOBAL-TEE-GIL-64000",
      },
    ]);
  });

  it("a key's colour and size never override a garment's fixed set silently: the key wins for color/size only", () => {
    const built = toProdigiOrderBody(
      job([line("GLOBAL-HOOD-GIL-18600.ash.l", { printerItem: { attributes: { color: "x", edge: "Drawstring" } } })]),
      "https://api.test/",
    );
    expect("body" in built && built.body.items[0]?.attributes).toStrictEqual({ color: "ash", edge: "Drawstring", size: "l" });
  });
});
