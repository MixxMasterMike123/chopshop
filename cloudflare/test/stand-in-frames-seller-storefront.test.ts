import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { publishAdminProduct, unpublishAdminProduct } from "../src/catalog/admin-catalog";
import {
  CANVAS_ELIGIBILITY_PREDICATE,
  PUBLIC_ELIGIBILITY_PREDICATE,
  publicEligibilityPredicate,
  STAND_IN_FRAME_TERM,
} from "../src/catalog/eligibility";
import { listPublicProductPage } from "../src/catalog/public-catalog";
import { createCheckout, type CreateCheckoutInput } from "../src/commerce/checkout";
import {
  createMapping,
  deleteMapping,
  evaluatePodGate,
  listMappings,
  podRefusalMessage,
} from "../src/pod/pod-mappings";
import { isStandInSku, replacePrinters } from "../src/pod/printers";
import { STOREFRONT_BODY_REVISION } from "../src/storefront/public-routes";
import {
  eligibilityPredicate,
  PREVIEW_CANVAS_ELIGIBILITY_PREDICATE,
  PREVIEW_ELIGIBILITY_PREDICATE,
  withoutPublishedTerm,
  withPrintCanvas,
} from "../src/storefront/preview";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  adminOf,
  CAP,
  catalogVersion,
  grantTenantAdmin,
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
  testCapabilities,
  testPrinter,
} from "./pod-fixtures";
import { seedCollection, seedPage } from "./storefront-fixtures";

/**
 * CP6-PS4 part A — while the print canvas is on (PRINT_CANVAS_ENABLED =
 * "true"), checkout refuses a line on a stand-in frame (CP6-PS3). The seller
 * and the storefront now agree: a product with ANY active mapping on a
 * stand-in model is not offered by any public read, its next publish and any
 * mapping write onto such a model are refused `pod_frame_unconfirmed`, and the
 * ETag names the switch. With the switch off or unset nothing changes.
 *
 * The fixture printer's models: 2000 (the tee: TEE_S, TEE_M) and TRUCKER (the
 * cap: CAP). Products: `tee` (TEE_S front), `mixed` (TEE_M front for the
 * product, CAP front for its variant `mixed-cap`), `plain-mug` (no print).
 */

const TENANT = "tenant-stand-in-shop";
const HOST = "stand-in-shop.podtest.test";
const ORIGIN = `https://${HOST}`;
const ADMIN = adminOf(TENANT);
const CONTEXT: TenantContext = { domainKind: "storefront", hostname: HOST, tenantId: TENANT };

const ON = "true";
/** Every value that is not exactly "true" is off, as printCanvasEnabled reads it. */
const OFF_VALUES = [undefined, "false", "TRUE", " true", "1"] as const;

function envWith(canvas: string | undefined): Env {
  const copy = { ...env, PRINT_CANVAS_ENABLED: canvas } as Record<string, unknown>;
  if (canvas === undefined) {
    delete copy.PRINT_CANVAS_ENABLED;
  }
  return copy as unknown as Env;
}

function get(path: string, canvas: string | undefined, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), envWith(canvas));
}

/** The models marked as stand-ins; the frames keep their size, so no mapping is suspended. */
async function setStandIns(models: { cap?: boolean; tee?: boolean }): Promise<void> {
  const capabilities = testCapabilities();
  for (const [key, standIn] of [["2000", models.tee], ["TRUCKER", models.cap]] as const) {
    const model = capabilities.models[key];
    if (model === undefined) {
      throw new Error(`fixture model ${key} missing`);
    }
    capabilities.models[key] = standIn === true ? { ...model, provisional: true } : model;
  }
  expect(await replacePrinters(env.DB, PLATFORM, [testPrinter({ capabilities })], Date.now())).not.toBeNull();
}

async function listed(canvas: string | undefined): Promise<string[]> {
  const response = await get("/v1/products", canvas);
  expect(response.status).toBe(200);
  return (await response.json<{ products: Array<{ productId: string }> }>()).products.map((p) => p.productId);
}

async function sitemapPaths(canvas: string | undefined): Promise<string[]> {
  const response = await get("/v1/sitemap", canvas);
  expect(response.status).toBe(200);
  return (await response.json<{ entries: Array<{ path: string }> }>()).entries.map((e) => e.path);
}

async function collectionProducts(canvas: string | undefined): Promise<string[]> {
  const response = await get("/v1/collections/utvalt", canvas);
  expect(response.status).toBe(200);
  return (await response.json<{ products: Array<{ productId: string }> }>()).products.map((p) => p.productId);
}

/** Every versioned answer this suite can read (all seven call sites of versionedJsonResponse). */
const VERSIONED_PATHS = [
  "/v1/storefront",
  "/v1/products",
  "/v1/products/plain-mug",
  "/v1/pages",
  "/v1/pages/om-oss",
  "/v1/collections",
  "/v1/collections/utvalt",
] as const;

function checkoutInput(items: CreateCheckoutInput["items"]): CreateCheckoutInput {
  return {
    deliveryMethod: "shipping",
    discountCode: null,
    email: "buyer@podtest.test",
    idempotencyKey: `idem-${crypto.randomUUID()}`,
    items,
    shippingCountry: "SE",
  };
}

async function map(productId: string, artworkId: string, sku: string, variantId: string | null = null) {
  return createMapping(env.DB, ADMIN, {
    artworkId,
    printerId: "fake-printer",
    productId,
    sku,
    slots: ["front"],
    variantId,
  }, Date.now());
}

let seller: { cookie: string; userId: string };

function adminFetch(path: string, method: string, canvas: string | undefined, body?: unknown): Promise<Response> {
  return worker.fetch(
    sessionRequest(`${ORIGIN}${path}`, method, { body, cookie: seller.cookie, shopId: TENANT }),
    envWith(canvas),
  );
}

beforeAll(async () => {
  await seedTenant(TENANT, HOST);
  await seedProfile();
  await seedPrinter();
  await seedArtwork(TENANT, { artworkId: "si-front" });
  await seedArtwork(TENANT, { artworkId: "si-cap", fileName: "cap.png" });
  // Past D8's first-N (test/screening.test.ts owns that rule).
  await seedProduct(TENANT, { productId: "live-1", published: true });
  await seedProduct(TENANT, { productId: "live-2", published: true });
  await seedProduct(TENANT, { productId: "plain-mug", priceMinor: 12_900, published: true });
  await seedProduct(TENANT, { productId: "tee", priceMinor: 39_900 });
  await seedProduct(TENANT, {
    productId: "mixed",
    priceMinor: 39_900,
    variants: [{ priceMinor: 39_900, sku: "SKU-mixed-cap", variantId: "mixed-cap" }],
  });
  expect((await map("tee", "si-front", TEE_S)).status).toBe("ok");
  expect((await map("mixed", "si-front", TEE_M)).status).toBe("ok");
  expect((await map("mixed", "si-cap", CAP, "mixed-cap")).status).toBe("ok");
  for (const productId of ["tee", "mixed"]) {
    expect((await publishAdminProduct(env.DB, ADMIN, productId, Date.now())).status).toBe("ok");
  }
  for (const productId of ["plain-mug", "tee", "mixed"]) {
    await env.DB.prepare("UPDATE products SET handle = ? WHERE tenant_id = ? AND product_id = ?")
      .bind(productId, TENANT, productId)
      .run();
  }
  await seedCollection(TENANT, { handle: "utvalt", productIds: ["tee", "plain-mug", "mixed"], title: "Utvalt" });
  await seedPage(TENANT, { content: "Om butiken.", slug: "om-oss", title: "Om oss" });
  seller = await signUp("stand-in-seller@podtest.test");
  await grantTenantAdmin(seller.userId, TENANT);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limit_windows").run();
  await setStandIns({});
});

describe("the fragments (one constant, one term)", () => {
  it("off: THE predicate is the constant itself, and an unmarked tenant reads it", () => {
    expect(publicEligibilityPredicate(false)).toBe(PUBLIC_ELIGIBILITY_PREDICATE);
    expect(publicEligibilityPredicate(true)).toBe(CANVAS_ELIGIBILITY_PREDICATE);
    expect(CANVAS_ELIGIBILITY_PREDICATE).toBe(`${PUBLIC_ELIGIBILITY_PREDICATE}${STAND_IN_FRAME_TERM}`);
    expect(eligibilityPredicate(CONTEXT)).toBe(PUBLIC_ELIGIBILITY_PREDICATE);
    expect(eligibilityPredicate({ ...CONTEXT, preview: true })).toBe(PREVIEW_ELIGIBILITY_PREDICATE);
    expect(eligibilityPredicate({ ...CONTEXT, hideStandInFrames: true })).toBe(CANVAS_ELIGIBILITY_PREDICATE);
    expect(eligibilityPredicate({ ...CONTEXT, hideStandInFrames: true, preview: true })).toBe(
      PREVIEW_CANVAS_ELIGIBILITY_PREDICATE,
    );
    expect(PREVIEW_CANVAS_ELIGIBILITY_PREDICATE).toBe(withoutPublishedTerm(CANVAS_ELIGIBILITY_PREDICATE));
    expect(PREVIEW_CANVAS_ELIGIBILITY_PREDICATE).toBe(`${PREVIEW_ELIGIBILITY_PREDICATE}${STAND_IN_FRAME_TERM}`);
  });

  it("the switch is read exactly ('true' only), and off leaves the tenant object as it was", () => {
    for (const value of OFF_VALUES) {
      expect(withPrintCanvas({ PRINT_CANVAS_ENABLED: value }, CONTEXT), String(value)).toBe(CONTEXT);
    }
    expect(withPrintCanvas({ PRINT_CANVAS_ENABLED: ON }, CONTEXT)).toEqual({ ...CONTEXT, hideStandInFrames: true });
  });

  it("isStandInSku reads models[skus[sku].model].provisional === true, and nothing else", () => {
    const capabilities = testCapabilities();
    expect(isStandInSku(capabilities, TEE_S)).toBe(false);
    const tee = capabilities.models["2000"];
    if (tee === undefined) {
      throw new Error("fixture model missing");
    }
    capabilities.models["2000"] = { ...tee, provisional: true };
    expect([isStandInSku(capabilities, TEE_S), isStandInSku(capabilities, TEE_M), isStandInSku(capabilities, CAP)])
      .toEqual([true, true, false]);
    expect(isStandInSku(capabilities, "no-such-sku")).toBe(false);
  });
});

describe("the storefront does not offer a product on a stand-in frame while the switch is on", () => {
  it("switch off or unset: every public answer is the same, byte for byte, stand-in or not", async () => {
    await setStandIns({ cap: true, tee: true });
    const reference = new Map<string, { body: string; etag: string | null; status: number }>();
    for (const value of OFF_VALUES) {
      for (const path of [...VERSIONED_PATHS, "/v1/products/tee", "/v1/sitemap", "/v1/seo?path=%2Fproduct%2Ftee"]) {
        const response = await get(path, value);
        const answer = { body: await response.text(), etag: response.headers.get("etag"), status: response.status };
        const first = reference.get(path);
        if (first === undefined) {
          reference.set(path, answer);
        } else {
          expect(answer, `${path} with ${String(value)}`).toEqual(first);
        }
      }
    }
    const version = await catalogVersion(TENANT);
    expect(reference.get("/v1/products")?.etag).toBe(`"${version}"`);
    expect(reference.get("/v1/products/tee")?.status).toBe(200);
    expect(await listed(undefined)).toEqual(expect.arrayContaining(["tee", "mixed", "plain-mug"]));
    expect(await sitemapPaths(undefined)).toEqual(expect.arrayContaining(["/product/tee", "/product/mixed"]));
  });

  it("switch on: the product leaves the list, the detail, the collection, the sitemap, the SEO answer and its previews", async () => {
    await setStandIns({ tee: true });
    // `mixed` prints the tee model on its product-level mapping, so it goes too.
    const list = await listed(ON);
    expect(list).not.toContain("tee");
    expect(list).not.toContain("mixed");
    expect(list).toContain("plain-mug");
    expect((await get("/v1/products/tee", ON)).status).toBe(404);
    expect((await get("/v1/products/plain-mug", ON)).status).toBe(200);
    expect(await collectionProducts(ON)).toEqual(["plain-mug"]);
    const paths = await sitemapPaths(ON);
    expect(paths).not.toContain("/product/tee");
    expect(paths).toContain("/product/plain-mug");
    expect((await get("/v1/seo?path=%2Fproduct%2Ftee", ON)).status).toBe(404);
    expect((await get("/v1/seo?path=%2Fproduct%2Fplain-mug", ON)).status).toBe(200);
    expect((await get("/v1/storefront/pod-previews/tee/si-front", ON)).status).toBe(404);
    // The same moment with the switch off: everything is there.
    expect(await listed(undefined)).toEqual(expect.arrayContaining(["tee", "mixed"]));
    expect((await get("/v1/storefront/pod-previews/tee/si-front", undefined)).status).toBe(200);
  });

  it("the whole product: one variant's mapping on a stand-in hides it, and checkout refuses its other units too", async () => {
    await setStandIns({ cap: true });
    const list = await listed(ON);
    expect(list).not.toContain("mixed");
    expect(list).toContain("tee");
    const options = (refuseStandInFrames: boolean) => ({ dispatchTarget: "fake-printer" as const, refuseStandInFrames });
    // The base unit prints the tee model (real frames), yet its product is not public now.
    const base = checkoutInput([{ productId: "mixed", quantity: 1 }]);
    expect((await createCheckout(env.DB, CONTEXT, base, Date.now(), options(true))).status).toBe("invalid_items");
    expect((await createCheckout(env.DB, CONTEXT, checkoutInput([{ productId: "mixed", quantity: 1 }]), Date.now(), options(false))).status)
      .toBe("ok");
    // A product on real frames sells with the switch on.
    expect((await createCheckout(env.DB, CONTEXT, checkoutInput([{ productId: "tee", quantity: 1 }]), Date.now(), options(true))).status)
      .toBe("ok");
  });

  it("only an ACTIVE mapping counts: an inactive one on a stand-in model hides nothing and refuses no publish", async () => {
    await setStandIns({ cap: true });
    const iso = new Date().toISOString();
    const inactiveId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO pod_mappings (id, tenant_id, product_id, variant_id, artwork_id, printer_id, sku,
         slots_json, status, suspended_reason, created_at, updated_at)
       VALUES (?, ?, 'tee', NULL, 'si-cap', 'fake-printer', ?, '[{"slot":"front","widthMm":60,"heightMm":40}]', 'inactive', NULL, ?, ?)`,
    )
      .bind(inactiveId, TENANT, CAP, iso, iso)
      .run();
    try {
      expect(await listed(ON)).toContain("tee");
      expect((await publishAdminProduct(env.DB, ADMIN, "tee", Date.now(), { refuseStandInFrames: true })).status).toBe("ok");
      // The gate reads the state it is given: an inactive row in it is not a route.
      const given = (await listMappings(env.DB, ADMIN, "tee")).filter(
        (m) => m.status === "active" || m.mappingId === inactiveId,
      );
      expect(given.map((m) => m.status).sort()).toEqual(["active", "inactive"]);
      expect(await evaluatePodGate(env.DB, TENANT, "tee", { mappings: given, refuseStandInFrames: true })).toBeNull();
    } finally {
      await env.DB.prepare("DELETE FROM pod_mappings WHERE id = ?").bind(inactiveId).run();
    }
  });

  it("it comes back by itself: the frames confirmed (a new ETag), or the switch off", async () => {
    await setStandIns({ tee: true });
    expect(await listed(ON)).not.toContain("tee");
    const hiddenAt = await catalogVersion(TENANT);

    await setStandIns({});
    expect(await catalogVersion(TENANT)).toBeGreaterThan(hiddenAt);
    expect(await listed(ON)).toContain("tee");

    await setStandIns({ tee: true });
    expect(await listed(ON)).not.toContain("tee");
    expect(await listed("false")).toContain("tee");
  });

  it("a preview reads the stand-in term too", async () => {
    await setStandIns({ tee: true });
    const ids = async (tenant: TenantContext & { hideStandInFrames?: true; preview?: true }) =>
      (await listPublicProductPage(env, env.DB, tenant, {})).products.map((p) => p.productId);
    expect(await ids({ ...CONTEXT, preview: true })).toContain("tee");
    expect(await ids({ ...CONTEXT, hideStandInFrames: true, preview: true })).not.toContain("tee");
    expect(await ids({ ...CONTEXT, hideStandInFrames: true, preview: true })).toContain("plain-mug");
  });
});

describe("the ETag names the switch", () => {
  it("off \"<v>\", on \"<v>-c\": a body kept from before a flip is answered in full, never a 304", async () => {
    const version = await catalogVersion(TENANT);
    for (const path of VERSIONED_PATHS) {
      // CP8-DC (F10): the storefront body names its code revision as well;
      // CP9-OB: and `-x`, this shop cannot take an order (no account).
      const r = path === "/v1/storefront" ? `-r${STOREFRONT_BODY_REVISION}-x` : "";
      const off = await get(path, undefined);
      const on = await get(path, ON);
      expect([off.status, on.status], path).toEqual([200, 200]);
      expect(off.headers.get("etag"), path).toBe(`"${version}${r}"`);
      expect(on.headers.get("etag"), path).toBe(`"${version}-c${r}"`);

      const flippedOn = await get(path, ON, { "if-none-match": `"${version}${r}"` });
      expect(flippedOn.status, path).toBe(200);
      expect(await flippedOn.text(), path).toBe(await on.text());
      expect((await get(path, ON, { "if-none-match": `"${version}-c${r}"` })).status, path).toBe(304);

      const flippedOff = await get(path, "false", { "if-none-match": `"${version}-c${r}"` });
      expect(flippedOff.status, path).toBe(200);
      expect((await get(path, "false", { "if-none-match": `"${version}${r}"` })).status, path).toBe(304);
    }
  });
});

describe("the seller is told: pod_frame_unconfirmed", () => {
  it("a mapping write onto a stand-in model is refused while the switch is on, on a draft as on a live product", async () => {
    await setStandIns({ cap: true });
    await seedProduct(TENANT, { productId: "draft-cap", priceMinor: 39_900 });
    const input = { artworkId: "si-cap", printerId: "fake-printer", productId: "draft-cap", sku: CAP, slots: ["front" as const], variantId: null };
    expect(await createMapping(env.DB, ADMIN, input, Date.now(), { refuseStandInFrames: true }))
      .toEqual({ code: "pod_frame_unconfirmed", status: "refused" });
    expect(await listMappings(env.DB, ADMIN, "draft-cap")).toEqual([]);
    // The live `tee` onto the cap model: refused as well.
    expect(await createMapping(env.DB, ADMIN, { ...input, productId: "tee", sku: CAP, slots: ["back" as const] }, Date.now(), { refuseStandInFrames: true }))
      .toEqual({ code: "pod_frame_unconfirmed", status: "refused" });
    // Real frames: the same write goes through with the switch on; absent or false, the stand-in too.
    expect((await createMapping(env.DB, ADMIN, { ...input, sku: TEE_S }, Date.now(), { refuseStandInFrames: true })).status).toBe("ok");
    expect((await createMapping(env.DB, ADMIN, { ...input, productId: "draft-cap-2" }, Date.now())).status).toBe("not_found");
    await seedProduct(TENANT, { productId: "draft-cap-2", priceMinor: 39_900 });
    expect((await createMapping(env.DB, ADMIN, { ...input, productId: "draft-cap-2" }, Date.now())).status).toBe("ok");
  });

  it("the mapping route reads the switch exactly and answers 422 with the seller's sentence", async () => {
    await setStandIns({ cap: true });
    await seedProduct(TENANT, { productId: "route-cap", priceMinor: 39_900 });
    const body = { artworkId: "si-cap", printerId: "fake-printer", productId: "route-cap", sku: CAP, slots: ["front"] };
    const refused = await adminFetch("/v1/admin/pod/mappings", "POST", ON, body);
    expect(refused.status).toBe(422);
    await expect(refused.json()).resolves.toEqual({
      error: { code: "pod_frame_unconfirmed", message: podRefusalMessage("pod_frame_unconfirmed") },
    });
    for (const value of OFF_VALUES) {
      await env.DB.prepare("UPDATE pod_mappings SET status = 'inactive' WHERE tenant_id = ? AND product_id = 'route-cap'").bind(TENANT).run();
      const response = await adminFetch("/v1/admin/pod/mappings", "POST", value, body);
      expect(response.status, String(value)).toBeLessThan(300);
    }
  });

  it("publish is refused while the switch is on, through the route; with it off the product publishes", async () => {
    await setStandIns({ tee: true });
    expect((await unpublishAdminProduct(env.DB, ADMIN, "tee", Date.now())).status).toBe("ok");
    expect(await publishAdminProduct(env.DB, ADMIN, "tee", Date.now(), { refuseStandInFrames: true })).toEqual({
      code: "pod_frame_unconfirmed",
      message: podRefusalMessage("pod_frame_unconfirmed"),
      status: "refused",
    });
    const refused = await adminFetch("/v1/admin/products/tee/publish", "POST", ON);
    expect(refused.status).toBe(422);
    await expect(refused.json()).resolves.toEqual({
      error: { code: "pod_frame_unconfirmed", message: podRefusalMessage("pod_frame_unconfirmed") },
    });
    for (const value of OFF_VALUES) {
      expect((await adminFetch("/v1/admin/products/tee/publish", "POST", value)).status, String(value)).toBe(200);
    }
    // Real frames again: the switch on publishes it.
    await setStandIns({});
    expect((await adminFetch("/v1/admin/products/tee/publish", "POST", ON)).status).toBe(200);
  });

  it("the gate checks the stand-in last: a price under the floor is named first, and no other rule is skipped", async () => {
    await setStandIns({ tee: true });
    expect(await evaluatePodGate(env.DB, TENANT, "tee", { refuseStandInFrames: true })).toBe("pod_frame_unconfirmed");
    expect(await evaluatePodGate(env.DB, TENANT, "tee", { productPriceMinor: 100, refuseStandInFrames: true })).toBe(
      "price_below_floor",
    );
    expect(await evaluatePodGate(env.DB, TENANT, "tee", { mappings: [], refuseStandInFrames: true })).toBe(
      "pod_mapping_missing",
    );
    expect(await evaluatePodGate(env.DB, TENANT, "tee")).toBeNull();
  });

  it("the delete never passes the switch: a stand-in mapping can always be removed", async () => {
    await setStandIns({ cap: true });
    await seedProduct(TENANT, { productId: "remove-cap", priceMinor: 39_900 });
    expect((await map("remove-cap", "si-cap", CAP)).status).toBe("ok");
    const [mapping] = await listMappings(env.DB, ADMIN, "remove-cap");
    const removed = await adminFetch(`/v1/admin/pod/mappings/${mapping?.mappingId ?? ""}`, "DELETE", ON);
    expect(removed.status).toBe(204);
    expect((await listMappings(env.DB, ADMIN, "remove-cap")).map((row) => row.status)).toEqual(["inactive"]);
  });

  it("the sentence says what to do and nothing of the platform's prices", () => {
    const text = podRefusalMessage("pod_frame_unconfirmed");
    expect(text).toMatch(/not confirmed the print area for this garment/);
    expect(text).not.toBe(podRefusalMessage("anything-else"));
    expect(text).not.toMatch(/\d|price|cost|tier|SnapWear|fake-printer/i);
  });
});

describe("the SQL term agrees with isStandInSku on every key", () => {
  it("a mapping SKU with a quote, a backslash or a space never breaks a read, and is never a stand-in", async () => {
    // `2700003"` (TEE_S and a quote) names an existing SKU before its quote: without the guard, the path is a parse error.
    await setStandIns({ cap: true, tee: true });
    const iso = new Date().toISOString();
    await seedProduct(TENANT, { isPod: true, productId: "odd-sku", published: true });
    for (const sku of ['a"b', "a\\b", "a b", "a'b", "2700003\""]) {
      await env.DB.prepare(
        `INSERT INTO pod_mappings (id, tenant_id, product_id, variant_id, artwork_id, printer_id, sku,
           slots_json, status, suspended_reason, created_at, updated_at)
         VALUES (?, ?, 'odd-sku', NULL, 'si-front', 'fake-printer', ?, '[{"slot":"front","widthMm":10,"heightMm":10}]', 'active', NULL, ?, ?)`,
      )
        .bind(crypto.randomUUID(), TENANT, sku, iso, iso)
        .run();
      expect(isStandInSku(testCapabilities(), sku)).toBe(false);
    }
    // Not a stand-in by either reading: the product stays public with the switch on.
    expect(await listed(ON)).toContain("odd-sku");
    await env.DB.prepare("UPDATE pod_mappings SET status = 'inactive' WHERE tenant_id = ? AND product_id = 'odd-sku'").bind(TENANT).run();
  });

  it("a stored document whose model name holds a quote never breaks a read", async () => {
    // SQLite parses a JSON path lazily: a stray quote is an error only once
    // the part before it named a key that exists (`2000` does).
    const capabilities = testCapabilities();
    const raw = JSON.stringify({
      models: { ...capabilities.models, '2000"x': { garment: "tee", printAreasMm: { front: { h: 400, w: 300 } }, provisional: true } },
      skus: { ...capabilities.skus, [TEE_S]: { label: "White / S", model: '2000"x' } },
    });
    await env.DB.prepare("UPDATE printers SET capabilities_json = ? WHERE id = 'fake-printer'").bind(raw).run();
    try {
      // The document fails parsePrinterCapabilities (a model key with a quote): no stand-in in code either.
      const list = await listed(ON);
      expect(list).toContain("tee");
      expect(list).toContain("plain-mug");
    } finally {
      await setStandIns({});
    }
  });
});
