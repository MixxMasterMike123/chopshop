import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { deleteArtwork } from "../src/pod/artwork-store";
import {
  createMapping,
  deleteMapping,
  listMappings,
  quoteForProduct,
  sizeSlot,
} from "../src/pod/pod-mappings";
import {
  priceFloorMinor,
  quotePodCost,
  withholdMinorFor,
} from "../src/pod/pod-quote";
import { dispatchTargetOf, parseReplacePrintersInput, replacePrinters } from "../src/pod/printers";
import { handlePlatformPrintersRoute } from "../src/routes/pod-platform";
import {
  adminOf,
  CAP,
  catalogVersion,
  expectNoCostKeys,
  grantPlatformAdmin,
  grantTenantAdmin,
  NOT_SNAPWEAR,
  PLATFORM,
  seedArtwork,
  seedPrinter,
  seedProduct,
  seedProfile,
  seedTenant,
  sessionRequest,
  signUp,
  TEE_M,
  TEE_S,
  testPrinter,
} from "./pod-fixtures";

const TENANT_A = "tenant-map-a";
const TENANT_B = "tenant-map-b";
const ADMIN_HOST = "https://admin.podtest.test";
const PLATFORM_HOST = "https://platform.podtest.test";
const A = adminOf(TENANT_A);
const B = adminOf(TENANT_B);

let adminSession: { cookie: string; userId: string };
let platformSession: { cookie: string; userId: string };

function envWith(overrides: Record<string, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

beforeAll(async () => {
  await seedTenant(TENANT_A, "map-a.podtest.test");
  await seedTenant(TENANT_B, "map-b.podtest.test");
  await seedProfile();
  await seedPrinter();
  await seedArtwork(TENANT_A, { artworkId: "art-a" });
  await seedArtwork(TENANT_A, { artworkId: "art-a-back", fileName: "back.png" });
  await seedArtwork(TENANT_A, { artworkId: "art-a-processing", status: "processing" });
  await seedArtwork(TENANT_B, { artworkId: "art-b" });

  adminSession = await signUp("pod-admin@podtest.test");
  await grantTenantAdmin(adminSession.userId, TENANT_A);
  platformSession = await signUp("pod-platform@podtest.test");
  await grantPlatformAdmin(platformSession.userId);
});

describe("quotePodCost + PRISGOLV + withholding (the ported formulas)", () => {
  it("unit = blank + Σ prints + the 40 kr platform cut, × quantity (printRouting.ts)", async () => {
    const front = await quotePodCost(env.DB, { printerId: "fake-printer", quantity: 1, sku: TEE_S, slots: ["front"] });
    expect(front).toEqual({
      breakdown: {
        blankMinor: 6_000,
        currency: "SEK",
        platformCutMinor: 4_000,
        printMinorBySlot: { front: 4_000 },
        quantity: 1,
        unitMinor: 14_000,
      },
      productionCostMinor: 14_000,
    });
    // printProjection.ts §10 worked example: tee front+back = 60 + 40 + 40 + 40.
    const both = await quotePodCost(env.DB, { printerId: "fake-printer", quantity: 3, sku: TEE_S, slots: ["front", "back"] });
    expect(both?.productionCostMinor).toBe(18_000 * 3);
  });

  it("fails closed on an unpriced slot, an unknown SKU and a bad quantity", async () => {
    await expect(quotePodCost(env.DB, { printerId: "fake-printer", quantity: 1, sku: CAP, slots: ["back"] })).resolves.toBeNull();
    await expect(quotePodCost(env.DB, { printerId: "fake-printer", quantity: 1, sku: "0000000", slots: ["front"] })).resolves.toBeNull();
    await expect(quotePodCost(env.DB, { printerId: "fake-printer", quantity: 0, sku: TEE_S, slots: ["front"] })).resolves.toBeNull();
    await expect(quotePodCost(env.DB, { printerId: "nobody", quantity: 1, sku: TEE_S, slots: ["front"] })).resolves.toBeNull();
  });

  it("priceFloor: podPricing.test.js fixture (140 kr ex → 196 kr) and float parity for whole kronor", () => {
    expect(priceFloorMinor(14_000, 2_500)).toBe(19_600);
    expect(priceFloorMinor(18_000, 2_500)).toBe(25_000);
    // The Firebase formula (src/wagons/pod-wagon/podPricing.js L70–73), verbatim.
    const firebase = (costSek: number, vatRate = 0.25) =>
      Math.ceil((costSek * (1 + vatRate) + 5) / (1 - 0.08));
    for (let kr = 0; kr <= 5_000; kr += 1) {
      expect(priceFloorMinor(kr * 100, 2_500)).toBe(firebase(kr) * 100);
    }
    expect(priceFloorMinor(-1, 2_500)).toBeNull();
  });

  it("withholding = production cost × 1.25, rounded half-up once (productionWithholding.ts)", () => {
    expect(withholdMinorFor(14_000)).toBe(17_500);
    expect(withholdMinorFor(1)).toBe(1);
    expect(withholdMinorFor(2)).toBe(3);
  });

  it("sizes a slot by contain-fit in the frame, capped at the artwork's min DPI", () => {
    // 3543 × 4724 px (3:4) is exactly 300 DPI at 300 × 400 mm.
    expect(sizeSlot(3_543, 4_724, { h: 400, w: 300 }, 300)).toEqual({ heightMm: 399, widthMm: 299 });
    // A 390 × 490 SnapWear frame is LARGER than 300 DPI allows: capped, not stretched.
    expect(sizeSlot(3_543, 4_724, { h: 490, w: 390 }, 300)).toEqual({ heightMm: 399, widthMm: 299 });
    // A cap frame: contain-fit by height.
    expect(sizeSlot(3_543, 4_724, { h: 50, w: 70 }, 300)).toEqual({ heightMm: 50, widthMm: 37 });
    expect(sizeSlot(5, 5, { h: 50, w: 70 }, 300)).toBeNull();
  });
});

describe("PUT /v1/platform/printers", () => {
  const put = (body: unknown, cookie = platformSession.cookie, target: Env = env) =>
    handlePlatformPrintersRoute(
      target,
      sessionRequest(`${PLATFORM_HOST}/v1/platform/printers`, "PUT", { body, cookie }),
    );

  it("is dark unless the environment has a seedable dispatch target", async () => {
    expect(dispatchTargetOf(env)).toBe("fake-printer");
    expect(dispatchTargetOf(envWith({ DISPATCH_TARGET: "fake-printer", APP_ENV: "production" }))).toBeNull();
    expect(dispatchTargetOf(envWith({ DISPATCH_TARGET: undefined }))).toBeNull();
    const dark = await put({ printers: [testPrinter()] }, platformSession.cookie, envWith({ DISPATCH_TARGET: undefined }));
    expect(dark.status).toBe(404);
  });

  it("hides the surface from a tenant admin", async () => {
    const response = await put({ printers: [testPrinter()] }, adminSession.cookie);
    expect(response.status).toBe(404);
  });

  it("refuses SnapWear in staging, the fake printer's id for a manual printer, and foreign SKUs", async () => {
    for (const printers of [
      [testPrinter({ printerId: "snapwear" })],
      [testPrinter({ printerId: "fake-printer", type: "manual" })],
      [
        testPrinter({
          capabilities: { models: { m: { garment: "tee", printAreasMm: { front: { h: 10, w: 10 } } } }, skus: { [NOT_SNAPWEAR]: { model: "m" } } },
          tiers: [],
        }),
      ],
    ]) {
      const response = await put({ printers });
      expect(response.status).toBe(400);
    }
  });

  it("refuses malformed documents: a tier for an unlisted SKU, an unknown slot, a stray key", () => {
    const base = testPrinter();
    expect(parseReplacePrintersInput({ printers: [{ ...base, tiers: [{ blankCostMinor: 1, printCostsMinor: {}, sku: "123" }] }] })).toBeNull();
    expect(
      parseReplacePrintersInput({
        printers: [{ ...base, capabilities: { models: { x: { garment: null, printAreasMm: { chest: { h: 1, w: 1 } } } }, skus: {} } }],
      }),
    ).toBeNull();
    expect(parseReplacePrintersInput({ printers: [{ ...base, costBasisEur: 3 }] })).toBeNull();
    expect(parseReplacePrintersInput({ printers: [base, base] })).toBeNull();
  });

  it("replaces the set and answers counts only — no price leaves the platform route", async () => {
    const response = await put({ printers: [testPrinter()] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      printers: [
        {
          currency: "SEK",
          name: "Fake printer (staging)",
          pricedSkuCount: 3,
          printerId: "fake-printer",
          skuCount: 3,
          status: "active",
          type: "api",
        },
      ],
      suspendedMappings: 0,
    });
    expectNoCostKeys(body);
    const tiers = await env.DB.prepare(
      "SELECT sku, blank_cost_minor, print_costs_json, tenant_id FROM printer_sku_tiers WHERE printer_id = 'fake-printer' ORDER BY sku",
    ).all();
    expect(tiers.results).toEqual([
      { blank_cost_minor: 5_000, print_costs_json: '{"front":3000}', sku: CAP, tenant_id: null },
      { blank_cost_minor: 6_000, print_costs_json: '{"back":4000,"front":4000,"pocket":2000}', sku: TEE_S, tenant_id: null },
      { blank_cost_minor: 6_000, print_costs_json: '{"back":4000,"front":4000,"pocket":2000}', sku: TEE_M, tenant_id: null },
    ]);
  });
});

describe("POD mappings (create, list, delete, quote)", () => {
  it("creates a mapping sized to the printer's frame and returns ONE number + the floor", async () => {
    await seedProduct(TENANT_A, { productId: "tee-a", priceMinor: 29_900 });
    const result = await createMapping(env.DB, A, {
      artworkId: "art-a",
      printerId: "fake-printer",
      productId: "tee-a",
      sku: TEE_S,
      slots: ["front", "pocket"],
      variantId: null,
    }, Date.now());
    expect(result).toMatchObject({
      created: true,
      mapping: {
        artworkId: "art-a",
        printerId: "fake-printer",
        productId: "tee-a",
        sku: TEE_S,
        slots: [
          { heightMm: 399, slot: "front", widthMm: 299 },
          { heightMm: 100, slot: "pocket", widthMm: 75 },
        ],
        status: "active",
        variantId: null,
      },
      // 60 + 40 (front) + 20 (pocket) + 40 cut = 160 kr ex → floor 223 kr.
      quote: { currency: "SEK", inkopMinor: 16_000, priceFloorMinor: 22_300 },
      status: "ok",
    });
    const product = await env.DB.prepare("SELECT is_pod FROM products WHERE product_id = 'tee-a'").first();
    expect(product).toEqual({ is_pod: 1 });
  });

  it("a second artwork on another slot joins the scope; the quote covers both", async () => {
    const result = await createMapping(env.DB, A, {
      artworkId: "art-a-back",
      printerId: "fake-printer",
      productId: "tee-a",
      sku: TEE_S,
      slots: ["back"],
      variantId: null,
    }, Date.now());
    expect(result).toMatchObject({ quote: { inkopMinor: 20_000 }, status: "ok" });
    await expect(quoteForProduct(env.DB, A, "tee-a", null)).resolves.toEqual({
      quote: { currency: "SEK", inkopMinor: 20_000, priceFloorMinor: 27_800 },
      status: "ok",
    });
  });

  it.each([
    ["a slot another artwork already fills", { artworkId: "art-a-back", slots: ["front"] }, "slot_taken"],
    ["another SKU in the same scope", { sku: TEE_M, slots: ["pocket"], artworkId: "art-a-back" }, "sku_mismatch"],
  ])("refuses %s (409)", async (_label, overrides, code) => {
    const result = await createMapping(env.DB, A, {
      artworkId: "art-a",
      printerId: "fake-printer",
      productId: "tee-a",
      sku: TEE_S,
      slots: ["front"],
      variantId: null,
      ...(overrides as object),
    }, Date.now());
    expect(result).toEqual({ code, status: "conflict" });
  });

  it("names the precise refusal once the product exists", async () => {
    await seedProduct(TENANT_A, { productId: "tee-refusals" });
    const attempt = (over: object) =>
      createMapping(env.DB, A, {
        artworkId: "art-a",
        printerId: "fake-printer",
        productId: "tee-refusals",
        sku: TEE_S,
        slots: ["front"],
        variantId: null,
        ...over,
      }, Date.now());
    await expect(attempt({ artworkId: "art-a-processing" })).resolves.toEqual({ code: "artwork_not_ready", status: "refused" });
    await expect(attempt({ sku: "2810013" })).resolves.toEqual({ code: "sku_unavailable", status: "refused" });
    await expect(attempt({ slots: ["left_sleeve"] })).resolves.toEqual({ code: "slot_not_printable", status: "refused" });
    await expect(attempt({ printerId: "snapwear" })).resolves.toEqual({ code: "printer_unavailable", status: "refused" });
    await expect(attempt({ sku: CAP, slots: ["back"] })).resolves.toEqual({ code: "slot_not_printable", status: "refused" });
  });

  it("refuses a SKU the printer lists but has not priced (A1: nothing unrecoverable is sold)", async () => {
    const unpricedSku = "2700005";
    const printer = testPrinter();
    printer.capabilities.skus[unpricedSku] = { model: "2000" };
    await replacePrinters(env.DB, PLATFORM, [printer], Date.now());
    await expect(
      createMapping(env.DB, A, {
        artworkId: "art-a",
        printerId: "fake-printer",
        productId: "tee-refusals",
        sku: unpricedSku,
        slots: ["front"],
        variantId: null,
      }, Date.now()),
    ).resolves.toEqual({ code: "unpriced", status: "refused" });
    await replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now());
  });

  it("hides another tenant's product, artwork and mapping behind not_found", async () => {
    await expect(
      createMapping(env.DB, B, {
        artworkId: "art-b",
        printerId: "fake-printer",
        productId: "tee-a",
        sku: TEE_S,
        slots: ["front"],
        variantId: null,
      }, Date.now()),
    ).resolves.toEqual({ status: "not_found" });
    await seedProduct(TENANT_B, { productId: "tee-b" });
    await expect(
      createMapping(env.DB, B, {
        artworkId: "art-a",
        printerId: "fake-printer",
        productId: "tee-b",
        sku: TEE_S,
        slots: ["front"],
        variantId: null,
      }, Date.now()),
    ).resolves.toEqual({ status: "not_found" });
    const [mapping] = await listMappings(env.DB, A, "tee-a");
    await expect(deleteMapping(env.DB, B, mapping?.mappingId ?? "", Date.now())).resolves.toEqual({ status: "not_found" });
    await expect(listMappings(env.DB, B, "tee-a")).resolves.toEqual([]);
  });

  it("the schema refuses a cross-tenant mapping even if the code were wrong", async () => {
    const iso = new Date().toISOString();
    await expect(
      env.DB.prepare(
        `INSERT INTO pod_mappings (id, tenant_id, product_id, variant_id, artwork_id, printer_id, sku, slots_json, status, created_at, updated_at)
         VALUES ('forged', ?, 'tee-b', NULL, 'art-a', 'fake-printer', ?, '[{"slot":"front","widthMm":1,"heightMm":1}]', 'active', ?, ?)`,
      )
        .bind(TENANT_B, TEE_S, iso, iso)
        .run(),
    ).rejects.toThrow(/artwork must belong to the same tenant/);
  });

  it("deletes softly (inactive), re-activates on re-post, and never deletes the referenced artwork", async () => {
    const [back] = (await listMappings(env.DB, A, "tee-a")).filter((m) => m.artworkId === "art-a-back");
    expect(back).toBeDefined();
    const versionBefore = await catalogVersion(TENANT_A);
    await expect(deleteMapping(env.DB, A, back?.mappingId ?? "", Date.now())).resolves.toEqual({ status: "ok" });
    expect(await catalogVersion(TENANT_A)).toBeGreaterThan(versionBefore);
    expect((await listMappings(env.DB, A, "tee-a")).find((m) => m.mappingId === back?.mappingId)?.status).toBe("inactive");

    // The artwork (and its print master) stays: a mapping row references it.
    await expect(deleteArtwork(env, env.DB, A, "art-a-back", Date.now())).resolves.toEqual({ status: "conflict" });

    const again = await createMapping(env.DB, A, {
      artworkId: "art-a-back",
      printerId: "fake-printer",
      productId: "tee-a",
      sku: TEE_S,
      slots: ["back"],
      variantId: null,
    }, Date.now());
    expect(again).toMatchObject({ created: false, mapping: { mappingId: back?.mappingId, status: "active" }, status: "ok" });
  });

  it("per-variant sets: a variant's own SKU overrides the product-level set", async () => {
    await seedProduct(TENANT_A, {
      productId: "tee-sized",
      variants: [
        { priceMinor: 29_900, sku: "TEE-SIZED-S", variantId: "tee-sized-s" },
        { priceMinor: 29_900, sku: "TEE-SIZED-M", variantId: "tee-sized-m" },
      ],
    });
    for (const [variantId, sku] of [["tee-sized-s", TEE_S], ["tee-sized-m", TEE_M]] as const) {
      const result = await createMapping(env.DB, A, {
        artworkId: "art-a",
        printerId: "fake-printer",
        productId: "tee-sized",
        sku,
        slots: ["front"],
        variantId,
      }, Date.now());
      expect(result.status).toBe("ok");
    }
    await expect(quoteForProduct(env.DB, A, "tee-sized", "tee-sized-m")).resolves.toMatchObject({ status: "ok" });
    // No product-level set: the bare product is not quotable.
    await expect(quoteForProduct(env.DB, A, "tee-sized", null)).resolves.toEqual({ status: "not_quotable" });
  });

  it("a routing edit that drops a SKU suspends its mappings in the same batch", async () => {
    await seedProduct(TENANT_A, { productId: "cap-routed", priceMinor: 29_900 });
    const created = await createMapping(env.DB, A, {
      artworkId: "art-a",
      printerId: "fake-printer",
      productId: "cap-routed",
      sku: CAP,
      slots: ["front"],
      variantId: null,
    }, Date.now());
    expect(created.status).toBe("ok");

    const withoutCap = testPrinter();
    delete withoutCap.capabilities.skus[CAP];
    withoutCap.tiers = withoutCap.tiers.filter((tier) => tier.sku !== CAP);
    const result = await replacePrinters(env.DB, PLATFORM, [withoutCap], Date.now());
    expect(result?.suspendedMappings).toBe(1);
    const [mapping] = await listMappings(env.DB, A, "cap-routed");
    expect(mapping).toMatchObject({ status: "suspended", suspendedReason: "sku_unavailable" });

    await replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now());
  });
});

describe("the admin POD routes over HTTP (auth, shapes, denylist)", () => {
  const request = (path: string, method: string, body?: unknown, shopId = TENANT_A) =>
    exports.default.fetch(
      sessionRequest(`${ADMIN_HOST}${path}`, method, { body, cookie: adminSession.cookie, shopId }),
    );

  it("GET /v1/admin/pod/printers shows capabilities only", async () => {
    const response = await request("/v1/admin/pod/printers", "GET");
    expect(response.status).toBe(200);
    const body = await response.json<{ printers: Array<{ printerId: string }> }>();
    expect(body.printers.map((printer) => printer.printerId)).toEqual(["fake-printer"]);
    expectNoCostKeys(body);
    expect(JSON.stringify(body)).not.toContain("6000");
  });

  it("POST + GET + DELETE mappings, and the quote: one number, no cost keys", async () => {
    await seedProduct(TENANT_A, { productId: "tee-http", priceMinor: 29_900 });
    const created = await request("/v1/admin/pod/mappings", "POST", {
      artworkId: "art-a",
      printerId: "fake-printer",
      productId: "tee-http",
      sku: TEE_S,
      slots: ["front"],
    });
    expect(created.status).toBe(201);
    const body = await created.json<{ inkopMinor: number; mapping: { mappingId: string }; priceFloorMinor: number }>();
    expect(body).toMatchObject({ currency: "SEK", inkopMinor: 14_000, priceFloorMinor: 19_600 });
    expect(Object.keys(body).sort()).toEqual(["currency", "inkopMinor", "mapping", "priceFloorMinor"]);
    expectNoCostKeys(body);

    const quote = await request("/v1/admin/pod/quote?productId=tee-http", "GET");
    expect(quote.status).toBe(200);
    await expect(quote.json()).resolves.toEqual({ currency: "SEK", inkopMinor: 14_000, priceFloorMinor: 19_600 });

    const listed = await request("/v1/admin/pod/mappings?productId=tee-http", "GET");
    const list = await listed.json();
    expectNoCostKeys(list);

    const deleted = await request(`/v1/admin/pod/mappings/${body.mapping.mappingId}`, "DELETE");
    expect(deleted.status).toBe(204);
    const unquotable = await request("/v1/admin/pod/quote?productId=tee-http", "GET");
    expect(unquotable.status).toBe(422);
  });

  it("answers the opaque 404 to another shop, a cross-site write and a missing session", async () => {
    expect((await request("/v1/admin/pod/mappings", "GET", undefined, TENANT_B)).status).toBe(404);
    const crossSite = await exports.default.fetch(
      sessionRequest(`${ADMIN_HOST}/v1/admin/pod/mappings`, "POST", {
        body: {},
        cookie: adminSession.cookie,
        origin: "https://evil.test",
        shopId: TENANT_A,
      }),
    );
    expect(crossSite.status).toBe(404);
    expect((await exports.default.fetch(`${ADMIN_HOST}/v1/admin/pod/quote?productId=tee-a`)).status).toBe(404);
  });

  it("admin product responses carry screeningStatus/isPod and no cost keys", async () => {
    const created = await request("/v1/admin/products", "POST", {
      currency: "SEK",
      description: null,
      name: "HTTP POD tee",
      priceMinor: 29_900,
      sku: "SKU-HTTP-POD",
    });
    expect(created.status).toBe(201);
    const { product } = await created.json<{ product: { productId: string } }>();
    expect(product).toMatchObject({ isPod: false, screeningStatus: null });
    expectNoCostKeys(product);
    const mapped = await request("/v1/admin/pod/mappings", "POST", {
      artworkId: "art-a",
      printerId: "fake-printer",
      productId: product.productId,
      sku: TEE_S,
      slots: ["front"],
    });
    expect(mapped.status).toBe(201);
    const patched = await request(`/v1/admin/products/${product.productId}`, "PATCH", { status: "active" });
    const patchedBody = await patched.json();
    expect(patchedBody).toMatchObject({ product: { isPod: true } });
    expectNoCostKeys(patchedBody);
    const published = await request(`/v1/admin/products/${product.productId}/publish`, "POST");
    expect(published.status).toBe(200);
    const publishedBody = await published.json();
    // Tenant A's first published product: D8 holds it for approval.
    expect(publishedBody).toMatchObject({ product: { screeningStatus: "pending" } });
    expectNoCostKeys(publishedBody);

    // The platform review queue and decision, over HTTP.
    const queue = await exports.default.fetch(
      sessionRequest(`${PLATFORM_HOST}/v1/platform/screening?status=pending`, "GET", { cookie: platformSession.cookie }),
    );
    expect(queue.status).toBe(200);
    const queueBody = await queue.json<{ screening: Array<{ productId: string }> }>();
    expect(queueBody.screening.map((row) => row.productId)).toContain(product.productId);
    expectNoCostKeys(queueBody);
    const decided = await exports.default.fetch(
      sessionRequest(`${PLATFORM_HOST}/v1/platform/screening/${product.productId}`, "POST", {
        body: { decision: "approved" },
        cookie: platformSession.cookie,
      }),
    );
    expect(decided.status).toBe(200);
    const decidedBody = await decided.json();
    expect(decidedBody).toMatchObject({ screening: { productId: product.productId, status: "approved" } });
    expectNoCostKeys(decidedBody);
    // A tenant admin cannot reach the decision surface; a bad decision is a 400.
    expect(
      (
        await exports.default.fetch(
          sessionRequest(`${PLATFORM_HOST}/v1/platform/screening/${product.productId}`, "POST", {
            body: { decision: "approved" },
            cookie: adminSession.cookie,
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await exports.default.fetch(
          sessionRequest(`${PLATFORM_HOST}/v1/platform/screening/${product.productId}`, "POST", {
            body: { decision: "cleared" },
            cookie: platformSession.cookie,
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("maps refusals to 422/409 with a code, and rejects malformed bodies with 400", async () => {
    const refused = await request("/v1/admin/pod/mappings", "POST", {
      artworkId: "art-a-processing",
      printerId: "fake-printer",
      productId: "tee-a",
      sku: TEE_S,
      slots: ["front"],
    });
    expect(refused.status).toBe(422);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "artwork_not_ready" } });

    const conflict = await request("/v1/admin/pod/mappings", "POST", {
      artworkId: "art-a-back",
      printerId: "fake-printer",
      productId: "tee-a",
      sku: TEE_S,
      slots: ["front"],
    });
    expect(conflict.status).toBe(409);

    for (const bad of [{}, { artworkId: "x", printerId: "y", productId: "z", sku: "s", slots: ["front", "front"] }, { extra: 1 }]) {
      expect((await request("/v1/admin/pod/mappings", "POST", bad)).status).toBe(400);
    }
  });
});
