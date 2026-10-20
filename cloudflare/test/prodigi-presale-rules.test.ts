import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { publishAdminProduct } from "../src/catalog/admin-catalog";
import { createCheckout, type CreateCheckoutInput } from "../src/commerce/checkout";
import { createMapping, deleteMapping, podRefusalMessage, resolveProductionLine } from "../src/pod/pod-mappings";
import { buildFromCatalog } from "../src/pod/printer-catalog";
import {
  parsePrinterCapabilities,
  type PrinterCapabilities,
  type PrinterInput,
  printerShipsTo,
  providerTakesCollectedOrders,
  replacePrinters,
  requiredSlotsOf,
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
  testCapabilities,
  testPrinter,
} from "./pod-fixtures";

/**
 * CP11 U7 — the Codex Prodigi audit of 2026-10-19, findings F2, F3 and F4,
 * each reproduction case INVERTED into a conformance test: what the audit
 * reproduced as sold-then-refused-by-the-printer is now refused BEFORE
 * payment, and the storefront is told the same rule.
 *
 *   F2  a back-only Prodigi product (Prodigi requires `front`) is not
 *       published, and a live one (its front mapping deleted after
 *       publication) is not sold;
 *   F3  a Prodigi product is never sold for pickup (Prodigi ships every order
 *       to an address), and the public read says allowPickup false;
 *   F4  a Prodigi product is sold only to the countries its printer ships to
 *       (SE at launch), and the public read names them.
 * The staging fake, which takes either, keeps today's behaviour.
 */

const TENANT = "tenant-prodigi-presale";
const HOST = "prodigi-presale.podtest.test";
const ORIGIN = `https://${HOST}`;
const ADMIN = adminOf(TENANT);
const CONTEXT: TenantContext = { domainKind: "storefront", hostname: HOST, tenantId: TENANT };

function prodigiPrinter(capabilities: PrinterCapabilities = testCapabilities()): PrinterInput {
  return testPrinter({ capabilities, name: "Prodigi (sandbox)", printerId: "prodigi", provider: "prodigi" });
}

async function setPrinters(prodigiCapabilities?: PrinterCapabilities): Promise<void> {
  expect(
    await replacePrinters(env.DB, PLATFORM, [testPrinter(), prodigiPrinter(prodigiCapabilities)], Date.now()),
  ).not.toBeNull();
}

function shipped(productId: string, country = "SE"): CreateCheckoutInput {
  return {
    deliveryMethod: "shipping",
    discountCode: null,
    email: "buyer@podtest.test",
    idempotencyKey: `idem-${crypto.randomUUID()}`,
    items: [{ productId, quantity: 1 }],
    shippingCountry: country,
  };
}

function collected(productId: string): CreateCheckoutInput {
  return { ...shipped(productId), deliveryMethod: "pickup", shippingCountry: null };
}

async function checkoutStatus(input: CreateCheckoutInput): Promise<string> {
  return (await createCheckout(env.DB, CONTEXT, input, Date.now(), { printerEnvironment: "staging" })).status;
}

async function map(productId: string, printerId: string, slot: "back" | "front"): Promise<string> {
  const artworkId = `${productId}-${slot}`;
  await seedArtwork(TENANT, { artworkId, fileName: `${slot}.png` });
  const mapped = await createMapping(env.DB, ADMIN, {
    artworkId,
    printerId,
    productId,
    sku: TEE_S,
    slots: [slot],
    variantId: null,
  }, Date.now());
  expect(mapped.status, `${productId}/${slot}`).toBe("ok");
  return mapped.status === "ok" ? mapped.mapping.mappingId : "";
}

async function publicProduct(productId: string): Promise<{ allowPickup: boolean; shipsTo: string[] | null }> {
  const response = await worker.fetch(new Request(`${ORIGIN}/v1/products/${productId}`), env);
  expect(response.status, productId).toBe(200);
  const body = (await response.json()) as { product: { allowPickup: boolean; shipsTo: string[] | null } };
  return { allowPickup: body.product.allowPickup, shipsTo: body.product.shipsTo };
}

let liveBackOnlyMapping = "";

beforeAll(async () => {
  await seedTenant(TENANT, HOST);
  await seedProfile();
  await setPrinters();
  // Past D8's first-N (test/screening.test.ts owns that rule).
  await seedProduct(TENANT, { productId: "live-1", published: true });
  await seedProduct(TENANT, { productId: "live-2", published: true });
  for (const productId of ["pg-front-back", "pg-back-only", "pg-live-back-only", "fake-back-only"]) {
    await seedProduct(TENANT, { productId, priceMinor: 39_900 });
  }
  await map("pg-front-back", "prodigi", "front");
  await map("pg-front-back", "prodigi", "back");
  await map("pg-back-only", "prodigi", "back");
  await map("pg-live-back-only", "prodigi", "back");
  liveBackOnlyMapping = await map("pg-live-back-only", "prodigi", "front");
  await map("fake-back-only", "fake-printer", "back");
  // Every product may be collected as far as the SELLER is concerned: the
  // printer's rule is what is under test.
  await env.DB.prepare(`UPDATE products SET allow_pickup = 1 WHERE tenant_id = ?`).bind(TENANT).run();
  for (const productId of ["pg-front-back", "pg-live-back-only", "fake-back-only"]) {
    expect((await publishAdminProduct(env.DB, ADMIN, productId, Date.now())).status, productId).toBe("ok");
  }
  // The audit's F2 case as it could still exist: published with a front
  // print, then the front mapping deleted (a delete is never refused for it).
  expect((await deleteMapping(env.DB, ADMIN, liveBackOnlyMapping, Date.now())).status).toBe("ok");
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limit_windows").run();
  await setPrinters();
});

describe("F2 · Prodigi requires a front print", () => {
  it("publication refuses a back-only Prodigi product with its own code and a seller sentence", async () => {
    const result = await publishAdminProduct(env.DB, ADMIN, "pg-back-only", Date.now());
    expect(result).toEqual({
      code: "pod_required_slot_missing",
      message: podRefusalMessage("pod_required_slot_missing"),
      status: "refused",
    });
    expect(podRefusalMessage("pod_required_slot_missing")).toMatch(/front/);
    // The sentence names no printer, supplier, SKU or price.
    expect(podRefusalMessage("pod_required_slot_missing")).not.toMatch(/prodigi|sku|kr|öre|cost/i);
  });

  it("checkout refuses a live back-only Prodigi product before payment (the audit's checkout `ok`)", async () => {
    expect(await checkoutStatus(shipped("pg-live-back-only"))).toBe("invalid_items");
    const line = await resolveProductionLine(
      env.DB,
      TENANT,
      { productId: "pg-live-back-only", quantity: 1, variantId: null },
      "staging",
    );
    expect(line).toBeNull();
  });

  it("front + back on Prodigi is published and sold; back-only on the fake is unchanged", async () => {
    expect(await checkoutStatus(shipped("pg-front-back"))).toBe("ok");
    expect(await checkoutStatus(shipped("fake-back-only"))).toBe("ok");
  });

  it("a model's own requiredSlots overrides the provider default, in both directions", async () => {
    // A Prodigi model that requires nothing extra beyond back: the back-only line sells.
    const backRequired = testCapabilities();
    backRequired.models["2000"] = { ...backRequired.models["2000"]!, requiredSlots: ["back"] };
    await setPrinters(backRequired);
    expect(await checkoutStatus(shipped("pg-live-back-only"))).toBe("ok");
    // …and front-and-back required: the line with both still sells.
    const both = testCapabilities();
    both.models["2000"] = { ...both.models["2000"]!, requiredSlots: ["front", "back"] };
    await setPrinters(both);
    expect(await checkoutStatus(shipped("pg-front-back"))).toBe("ok");
    expect(await checkoutStatus(shipped("pg-live-back-only"))).toBe("invalid_items");
  });
});

describe("F3 · no pickup for a printer that ships every order", () => {
  it("checkout refuses a Prodigi product for pickup (the audit's checkout `ok` → ship_to_missing after payment)", async () => {
    expect(await checkoutStatus(collected("pg-front-back"))).toBe("invalid_items");
    // The same product shipped is sold.
    expect(await checkoutStatus(shipped("pg-front-back"))).toBe("ok");
  });

  it("the staging fake, which takes a collected job, is still sold for pickup", async () => {
    expect(await checkoutStatus(collected("fake-back-only"))).toBe("ok");
  });

  it("the public read says what checkout does: allowPickup false for the Prodigi product, true for the fake's", async () => {
    expect((await publicProduct("pg-front-back")).allowPickup).toBe(false);
    expect((await publicProduct("fake-back-only")).allowPickup).toBe(true);
    // The seller's own flag is untouched.
    const row = await env.DB.prepare(`SELECT allow_pickup FROM products WHERE product_id = 'pg-front-back'`).first<{
      allow_pickup: number;
    }>();
    expect(row?.allow_pickup).toBe(1);
  });

  it("the provider rule: Prodigi and (until it names an address) SnapWear take no collected order", () => {
    expect(providerTakesCollectedOrders("prodigi")).toBe(false);
    expect(providerTakesCollectedOrders("snapwear")).toBe(false);
    expect(providerTakesCollectedOrders("fake")).toBe(true);
  });
});

describe("F4 · destinations", () => {
  it("checkout sells a Prodigi product to SE only by default (the audit's US / CA / AU / NZ / JP)", async () => {
    expect(await checkoutStatus(shipped("pg-front-back", "SE"))).toBe("ok");
    for (const country of ["US", "CA", "AU", "NZ", "JP", "NO", "DK"]) {
      expect(await checkoutStatus(shipped("pg-front-back", country)), country).toBe("invalid_items");
    }
    // The fake restricts nothing (as before).
    expect(await checkoutStatus(shipped("fake-back-only", "US"))).toBe("ok");
  });

  it("the printer's own shipsTo widens or narrows it", async () => {
    await setPrinters({ ...testCapabilities(), shipsTo: ["DK", "SE"] });
    expect(await checkoutStatus(shipped("pg-front-back", "DK"))).toBe("ok");
    expect(await checkoutStatus(shipped("pg-front-back", "US"))).toBe("invalid_items");
  });

  it("the public read names the countries, never the printer", async () => {
    const prodigi = await publicProduct("pg-front-back");
    expect(prodigi.shipsTo).toEqual(["SE"]);
    expect((await publicProduct("fake-back-only")).shipsTo).toBeNull();
    await setPrinters({ ...testCapabilities(), shipsTo: ["SE", "DK"] });
    expect((await publicProduct("pg-front-back")).shipsTo).toEqual(["DK", "SE"]);
    const raw = await (await worker.fetch(new Request(`${ORIGIN}/v1/products/pg-front-back`), env)).text();
    expect(raw).not.toMatch(/prodigi/i);
  });
});

describe("the capability document carries requiredSlots and shipsTo", () => {
  it("parses them, and refuses malformed ones", () => {
    const base = testCapabilities();
    const good = {
      ...base,
      models: { ...base.models, "2000": { ...base.models["2000"]!, requiredSlots: ["front"] } },
      shipsTo: ["SE", "NO"],
    };
    expect(parsePrinterCapabilities(good)).toEqual(good);
    expect(parsePrinterCapabilities(base)).toEqual(base);
    for (const shipsTo of [[], ["se"], ["SWE"], ["SE", "SE"], "SE", [1]]) {
      expect(parsePrinterCapabilities({ ...base, shipsTo }), JSON.stringify(shipsTo)).toBeNull();
    }
    for (const requiredSlots of [[], ["sleeve"], ["front", "front"], ["pocket"], "front"]) {
      const models = { ...base.models, TRUCKER: { ...base.models.TRUCKER!, requiredSlots } };
      expect(parsePrinterCapabilities({ ...base, models }), JSON.stringify(requiredSlots)).toBeNull();
    }
  });

  it("the defaults: Prodigi requires front and ships to SE; the others require and restrict nothing", () => {
    const capabilities = testCapabilities();
    expect(requiredSlotsOf("prodigi", capabilities, TEE_S)).toEqual(["front"]);
    expect(requiredSlotsOf("fake", capabilities, TEE_S)).toEqual([]);
    expect(requiredSlotsOf("snapwear", capabilities, TEE_S)).toEqual([]);
    expect(printerShipsTo("prodigi", capabilities)).toEqual(["SE"]);
    expect(printerShipsTo("fake", capabilities)).toBeNull();
    expect(printerShipsTo("fake", { ...capabilities, shipsTo: ["SE"] })).toEqual(["SE"]);
  });

  it("a catalogue apply carries a model's requiredSlots, and keeps the printer's shipsTo unless the catalogue names one", () => {
    const catalog = {
      models: { M1: { front: { h: 400, w: 300 }, back: { h: 400, w: 300 }, garment: "tee", requiredSlots: ["front"] } },
      skus: { "GLOBAL-TEE-X.black.m": { colour: "Black", model: "M1", size: "M" } },
    };
    const input = {
      apply: false,
      frames: {},
      models: ["M1"],
      pricing: { basis: "keep" as const },
      skus: [],
    };
    const kept = buildFromCatalog(catalog, input, ["SE", "NO"]);
    expect(kept.status).toBe("ok");
    if (kept.status === "ok") {
      expect(kept.built.capabilities.models.M1?.requiredSlots).toEqual(["front"]);
      expect(kept.built.capabilities.shipsTo).toEqual(["SE", "NO"]);
    }
    const own = buildFromCatalog({ ...catalog, shipsTo: ["SE"] }, input, ["SE", "NO"]);
    expect(own.status === "ok" && own.built.capabilities.shipsTo).toEqual(["SE"]);
    const none = buildFromCatalog(catalog, input);
    expect(none.status === "ok" && none.built.capabilities.shipsTo).toBeUndefined();
    const unframed = buildFromCatalog(
      { ...catalog, models: { M1: { ...catalog.models.M1, requiredSlots: ["pocket"] } } },
      input,
    );
    expect(unframed.status).toBe("invalid");
  });
});
