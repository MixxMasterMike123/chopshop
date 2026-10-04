import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  publishAdminProduct,
  unpublishAdminProduct,
  updateAdminProduct,
} from "../src/catalog/admin-catalog";
import { getPublicProductByRef } from "../src/catalog/public-catalog";
import { decideByPlatform } from "../src/catalog/screening";
import { createCheckout } from "../src/commerce/checkout";
import type { CreateCheckoutInput } from "../src/commerce/checkout";
import { buyerRecipientShipping } from "./legal-fixtures";
import {
  createMapping,
  deleteMapping,
  listMappings,
  MAX_GATE_VARIANTS,
  PRODUCTION_TIER_READ_SQL,
} from "../src/pod/pod-mappings";
import { replacePrinters } from "../src/pod/printers";
import {
  handlePublicProductListRoute,
  handlePublicProductRefRoute,
} from "../src/routes/public-products";
import { handlePublicStorefrontRequest, STOREFRONT_BODY_REVISION } from "../src/storefront/public-routes";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  adminOf,
  catalogVersion,
  expectNoCostKeys,
  hex64,
  PLATFORM,
  PREVIEW_BYTES,
  seedArtwork,
  seedPrinter,
  seedProduct,
  seedProfile,
  seedTenant,
  TEE_M,
  TEE_S,
  testPrinter,
} from "./pod-fixtures";

const TENANT = "tenant-publish";
const HOST = "publish.podtest.test";
const ORIGIN = `https://${HOST}`;
const ADMIN = adminOf(TENANT);
const TENANT_CONTEXT: TenantContext = { domainKind: "storefront", hostname: HOST, tenantId: TENANT };

let printKeyFront = "";
let printKeyBack = "";

async function map(
  productId: string,
  artworkId: string,
  slots: Array<"back" | "front" | "pocket">,
  options: { sku?: string; variantId?: string | null } = {},
) {
  return createMapping(env.DB, ADMIN, {
    artworkId,
    printerId: "fake-printer",
    productId,
    sku: options.sku ?? TEE_S,
    slots,
    variantId: options.variantId ?? null,
  }, Date.now());
}

async function publishedFlag(productId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT published FROM product_publications WHERE product_id = ?")
    .bind(productId)
    .first<{ published: number }>();
  return row?.published ?? null;
}

beforeAll(async () => {
  await seedTenant(TENANT, HOST);
  await seedProfile();
  await seedPrinter();
  ({ printKey: printKeyFront } = await seedArtwork(TENANT, { artworkId: "art-front" }));
  ({ printKey: printKeyBack } = await seedArtwork(TENANT, { artworkId: "art-back", fileName: "back.png" }));
  // Past D8's first-N (test/screening.test.ts owns that rule): two live products.
  await seedProduct(TENANT, { productId: "live-1", published: true });
  await seedProduct(TENANT, { productId: "live-2", published: true });
});

describe("the POD publish gate", () => {
  it("refuses a POD product with no active mapping (pod_mapping_missing)", async () => {
    await seedProduct(TENANT, { productId: "gate-unmapped", priceMinor: 29_900 });
    const mapped = await map("gate-unmapped", "art-front", ["front"]);
    expect(mapped.status).toBe("ok");
    const [mapping] = await listMappings(env.DB, ADMIN, "gate-unmapped");
    await deleteMapping(env.DB, ADMIN, mapping?.mappingId ?? "", Date.now());

    await expect(publishAdminProduct(env.DB, ADMIN, "gate-unmapped", Date.now())).resolves.toMatchObject({
      code: "pod_mapping_missing",
      status: "refused",
    });
    expect(await publishedFlag("gate-unmapped")).toBeNull();
  });

  it("PRISGOLV: refuses a price under the floor, accepts one exactly at it", async () => {
    // front only: 60 + 40 + 40 = 140 kr ex, + the printer's 49 kr parcel
    // (D41: the floor is a one-item order's) = 189 kr ex → floor 263 kr.
    await seedProduct(TENANT, { productId: "gate-floor", priceMinor: 26_200 });
    expect((await map("gate-floor", "art-front", ["front"])).status).toBe("ok");
    await expect(publishAdminProduct(env.DB, ADMIN, "gate-floor", Date.now())).resolves.toMatchObject({
      code: "price_below_floor",
      status: "refused",
    });

    // Not live: a PATCH is not gated (the next publish judges it in full)…
    await expect(
      updateAdminProduct(env.DB, ADMIN, "gate-floor", { priceMinor: 26_299 }, Date.now()),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(publishAdminProduct(env.DB, ADMIN, "gate-floor", Date.now())).resolves.toMatchObject({
      code: "price_below_floor",
      status: "refused",
    });
    // …and the floor itself is a legal price.
    await expect(
      updateAdminProduct(env.DB, ADMIN, "gate-floor", { priceMinor: 26_300 }, Date.now()),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(publishAdminProduct(env.DB, ADMIN, "gate-floor", Date.now())).resolves.toMatchObject({
      product: { isPod: true, priceMinor: 26_300, screeningStatus: "advisory" },
      status: "ok",
    });

    // Live: lowering it under the floor is refused (ProductForm's rule), with
    // the code and a sentence saying why; raising is always allowed.
    await expect(
      updateAdminProduct(env.DB, ADMIN, "gate-floor", { priceMinor: 26_299 }, Date.now()),
    ).resolves.toEqual({
      code: "price_below_floor",
      message: "The price is below this product's price floor. Raise it to at least the floor shown with the product's print quote.",
      status: "refused",
    });
    await expect(
      updateAdminProduct(env.DB, ADMIN, "gate-floor", { priceMinor: 26_400 }, Date.now()),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(
      updateAdminProduct(env.DB, ADMIN, "gate-floor", { priceMinor: 26_300 }, Date.now()),
    ).resolves.toMatchObject({ status: "ok" });
  });

  it("a mapping edit on a LIVE product may not push its floor over the price", async () => {
    // gate-floor is live at 263 kr; a back print would make the floor 317 kr.
    await expect(map("gate-floor", "art-back", ["back"])).resolves.toEqual({
      code: "price_below_floor",
      status: "refused",
    });
  });

  it("over HTTP a refused publish is never a success and publishes nothing", async () => {
    await seedProduct(TENANT, { productId: "gate-http", priceMinor: 100 });
    expect((await map("gate-http", "art-front", ["front"])).status).toBe("ok");
    const principalFree = await exports.default.fetch(
      new Request(`${ORIGIN}/v1/admin/products/gate-http/publish`, {
        headers: { origin: ORIGIN, "x-shop-id": TENANT },
        method: "POST",
      }),
    );
    expect(principalFree.status).not.toBe(200);
    expect(await publishedFlag("gate-http")).toBeNull();
  });
});

describe("public eligibility, POD fields, previews and catalog_version", () => {
  beforeAll(async () => {
    await seedProduct(TENANT, { productId: "pdp-tee", priceMinor: 39_900 });
    expect((await map("pdp-tee", "art-front", ["front"])).status).toBe("ok");
    expect((await map("pdp-tee", "art-back", ["back"])).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "pdp-tee", Date.now())).status).toBe("ok");
  });

  it("the product detail carries print areas and preview paths — never a printer, SKU or cost", async () => {
    const detail = await getPublicProductByRef(env, env.DB, TENANT_CONTEXT, "pdp-tee");
    expect(detail?.pod).toEqual({
      previewUrls: [
        "/v1/storefront/pod-previews/pdp-tee/art-front",
        "/v1/storefront/pod-previews/pdp-tee/art-back",
      ],
      printAreas: [
        { heightMm: 399, slot: "front", widthMm: 299 },
        { heightMm: 399, slot: "back", widthMm: 299 },
      ],
    });
    const serialized = JSON.stringify(detail);
    expectNoCostKeys(detail);
    for (const leak of [TEE_S, "fake-printer", "pod/", "6000", "4000"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("serves the preview bytes on the storefront host, with an ETag and a 304", async () => {
    const url = `${ORIGIN}/v1/storefront/pod-previews/pdp-tee/art-front`;
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("etag")).toBe(`"${hex64("c")}"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PREVIEW_BYTES);

    const revalidated = await exports.default.fetch(
      new Request(url, { headers: { "if-none-match": `"${hex64("c")}"` } }),
    );
    expect(revalidated.status).toBe(304);

    // Unmapped artwork on this product, and a product on another host: 404.
    expect((await exports.default.fetch(`${ORIGIN}/v1/storefront/pod-previews/pdp-tee/art-nope`)).status).toBe(404);
    expect(
      (await exports.default.fetch("https://unknown.podtest.test/v1/storefront/pod-previews/pdp-tee/art-front")).status,
    ).toBe(404);
  });

  it("answers ETag: \"<catalog_version>\" and a bodiless 304 while nothing changed", async () => {
    const version = await catalogVersion(TENANT);
    const first = await handlePublicProductRefRoute(env, new Request(`${ORIGIN}/v1/products/pdp-tee`));
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe(`"${version}"`);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const body = await first.json();
    expectNoCostKeys(body);

    const again = await handlePublicProductRefRoute(
      env,
      new Request(`${ORIGIN}/v1/products/pdp-tee`, { headers: { "if-none-match": `"${version}"` } }),
    );
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    for (const [response, etag] of [
      [await handlePublicProductListRoute(env, new Request(`${ORIGIN}/v1/products`)), `"${version}"`],
      // CP8-DC (F10): the storefront body names its code revision as well.
      [
        await handlePublicStorefrontRequest(env, new Request(`${ORIGIN}/v1/storefront`)),
        `"${version}-r${STOREFRONT_BODY_REVISION}"`,
      ],
    ] as const) {
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe(etag);
      expectNoCostKeys(await response.json());
    }
  });

  it("a takedown answers 404 on the very next request — cached ETag or not — and kills the preview", async () => {
    const version = await catalogVersion(TENANT);
    const cached = `"${version}"`;
    await decideByPlatform(env.DB, PLATFORM, "pdp-tee", "blocked", Date.now());
    expect(await catalogVersion(TENANT)).toBeGreaterThan(version);

    const conditional = await handlePublicProductRefRoute(
      env,
      new Request(`${ORIGIN}/v1/products/pdp-tee`, { headers: { "if-none-match": cached } }),
    );
    expect(conditional.status).toBe(404);
    expect((await exports.default.fetch(`${ORIGIN}/v1/products/pdp-tee`)).status).toBe(404);
    expect((await exports.default.fetch(`${ORIGIN}/v1/storefront/pod-previews/pdp-tee/art-front`)).status).toBe(404);
    const list = await exports.default.fetch(`${ORIGIN}/v1/products`);
    expect((await list.json<{ products: Array<{ productId: string }> }>()).products.map((p) => p.productId)).not.toContain("pdp-tee");

    await decideByPlatform(env.DB, PLATFORM, "pdp-tee", "approved", Date.now());
    expect((await exports.default.fetch(`${ORIGIN}/v1/products/pdp-tee`)).status).toBe(200);
  });

  it("bumps catalog_version on every eligibility transition", async () => {
    const bumps = async (label: string, change: () => Promise<unknown>) => {
      const before = await catalogVersion(TENANT);
      await change();
      expect(await catalogVersion(TENANT), label).toBeGreaterThan(before);
    };
    await bumps("unpublish", () => unpublishAdminProduct(env.DB, ADMIN, "pdp-tee", Date.now()));
    await bumps("publish", () => publishAdminProduct(env.DB, ADMIN, "pdp-tee", Date.now()));
    await bumps("product text", () => updateAdminProduct(env.DB, ADMIN, "pdp-tee", { name: "PDP Tee v2" }, Date.now()));
    await bumps("shop status", () =>
      env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE tenant_id = ?").bind(TENANT).run(),
    );
    await bumps("shop status back", () =>
      env.DB.prepare("UPDATE tenants SET status = 'active' WHERE tenant_id = ?").bind(TENANT).run(),
    );
    await bumps("shop go-live gate", () =>
      env.DB.prepare("UPDATE tenants SET published = 0 WHERE tenant_id = ?").bind(TENANT).run(),
    );
    expect(await getPublicProductByRef(env, env.DB, TENANT_CONTEXT, "pdp-tee")).toBeNull();
    await env.DB.prepare("UPDATE tenants SET published = 1 WHERE tenant_id = ?").bind(TENANT).run();
    await bumps("printer deactivated", () =>
      replacePrinters(env.DB, PLATFORM, [testPrinter({ status: "inactive" })], Date.now()),
    );
    // A POD product with no ACTIVE printer behind its mapping is not public.
    expect(await getPublicProductByRef(env, env.DB, TENANT_CONTEXT, "pdp-tee")).toBeNull();
    await bumps("printer reactivated", () => replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now()));
    expect(await getPublicProductByRef(env, env.DB, TENANT_CONTEXT, "pdp-tee")).not.toBeNull();
  });
});

// ── the production snapshot (the CP2 shared contract) ──────────────────────

function checkoutInput(
  items: CreateCheckoutInput["items"],
  key = crypto.randomUUID(),
): CreateCheckoutInput {
  return {
    deliveryMethod: "shipping",
    discountCode: null,
    email: "buyer@podtest.test",
    idempotencyKey: `idem-${key}`,
    items,
    shippingCountry: "SE",
  };
}

async function snapshotOf(checkoutId: string): Promise<unknown> {
  const row = await env.DB.prepare("SELECT production_snapshot_json FROM checkouts WHERE checkout_id = ?")
    .bind(checkoutId)
    .first<{ production_snapshot_json: string | null }>();
  return row?.production_snapshot_json === null || row === null
    ? null
    : JSON.parse(row.production_snapshot_json);
}

describe("checkout freezes the production snapshot", () => {
  beforeAll(async () => {
    await seedProduct(TENANT, { productId: "snap-tee", priceMinor: 39_900 });
    expect((await map("snap-tee", "art-front", ["front"])).status).toBe("ok");
    expect((await map("snap-tee", "art-back", ["back"])).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "snap-tee", Date.now())).status).toBe("ok");
    await seedProduct(TENANT, { productId: "plain-mug", priceMinor: 12_900, published: true });
  });

  it("freezes the exact contract shape: lines, print files, costs, totals with shipping", async () => {
    const result = await createCheckout(
      env.DB,
      TENANT_CONTEXT,
      checkoutInput([
        { productId: "plain-mug", quantity: 1 },
        { productId: "snap-tee", quantity: 2 },
      ]),
      Date.now(),
      { dispatchTarget: "fake-printer" },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    // (60 + 40 + 40 + 40) × 2 = 360 kr ex; + 49 kr printer shipping once.
    expect(await snapshotOf(result.checkout.checkoutId)).toEqual({
      printer: "fake-printer",
      lines: [
        {
          lineNo: 2,
          sku: TEE_S,
          quantity: 2,
          printFiles: [
            // CP6-PS2: + the frozen frame, its stand-in flag and the artwork's pixels.
            {
              slot: "front", r2Key: printKeyFront, sha256: hex64("b"), widthMm: 299, heightMm: 399,
              frameMm: { w: 300, h: 400, offsetTopMm: 30 }, frameProvisional: false,
              sourcePx: { w: 3_543, h: 4_724 },
            },
            {
              slot: "back", r2Key: printKeyBack, sha256: hex64("b"), widthMm: 299, heightMm: 399,
              frameMm: { w: 300, h: 450, offsetTopMm: 40 }, frameProvisional: false,
              sourcePx: { w: 3_543, h: 4_724 },
            },
          ],
          productionCostMinor: 36_000,
          withholdMinor: 45_000,
        },
      ],
      totals: { productionCostMinor: 40_900, withholdMinor: 51_125 },
    });

    // SERVER-ONLY: the buyer's response carries none of it.
    const serialized = JSON.stringify(result.checkout);
    for (const leak of ["r2Key", "pod/", "printFiles", "withhold", TEE_S, "fake-printer"]) {
      expect(serialized).not.toContain(leak);
    }
    expectNoCostKeys(result.checkout);
  });

  it("leaves a non-POD cart's snapshot NULL", async () => {
    const result = await createCheckout(
      env.DB,
      TENANT_CONTEXT,
      checkoutInput([{ productId: "plain-mug", quantity: 1 }]),
      Date.now(),
      { dispatchTarget: "fake-printer" },
    );
    expect(result.status).toBe("ok");
    expect(result.status === "ok" ? await snapshotOf(result.checkout.checkoutId) : "x").toBeNull();
  });

  it("refuses a cart whose printer is not this environment's dispatch target — or when it has none", async () => {
    await expect(
      createCheckout(env.DB, TENANT_CONTEXT, checkoutInput([{ productId: "snap-tee", quantity: 1 }]), Date.now(), {
        dispatchTarget: "snapwear",
      }),
    ).resolves.toEqual({ status: "invalid_items" });
    await expect(
      createCheckout(env.DB, TENANT_CONTEXT, checkoutInput([{ productId: "snap-tee", quantity: 1 }]), Date.now(), {
        dispatchTarget: null,
      }),
    ).resolves.toEqual({ status: "invalid_items" });
    // A cart without POD lines does not care.
    await expect(
      createCheckout(env.DB, TENANT_CONTEXT, checkoutInput([{ productId: "plain-mug", quantity: 1 }]), Date.now(), {
        dispatchTarget: null,
      }),
    ).resolves.toMatchObject({ status: "ok" });
  });

  it("the snapshot is frozen: purgeable to NULL, never rewritten", async () => {
    const result = await createCheckout(
      env.DB,
      TENANT_CONTEXT,
      checkoutInput([{ productId: "snap-tee", quantity: 1 }]),
      Date.now(),
    );
    expect(result.status).toBe("ok");
    const checkoutId = result.status === "ok" ? result.checkout.checkoutId : "";
    await expect(
      env.DB.prepare("UPDATE checkouts SET production_snapshot_json = '{}' WHERE checkout_id = ?").bind(checkoutId).run(),
    ).rejects.toThrow(/production snapshot is frozen/);
    await env.DB.prepare("UPDATE checkouts SET production_snapshot_json = NULL WHERE checkout_id = ?").bind(checkoutId).run();
    expect(await snapshotOf(checkoutId)).toBeNull();
  });

  it("a variant line freezes its own printer SKU", async () => {
    await seedProduct(TENANT, {
      priceMinor: 39_900,
      productId: "snap-sized",
      variants: [{ priceMinor: 39_900, sku: "SNAP-SIZED-M", variantId: "snap-sized-m" }],
    });
    expect((await map("snap-sized", "art-front", ["front"], { sku: TEE_M, variantId: "snap-sized-m" })).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "snap-sized", Date.now())).status).toBe("ok");
    const result = await createCheckout(
      env.DB,
      TENANT_CONTEXT,
      checkoutInput([{ productId: "snap-sized", quantity: 1, variantId: "snap-sized-m" }]),
      Date.now(),
    );
    expect(result.status).toBe("ok");
    const snapshot = (result.status === "ok" ? await snapshotOf(result.checkout.checkoutId) : null) as {
      lines: Array<{ sku: string }>;
    };
    expect(snapshot.lines[0]?.sku).toBe(TEE_M);
    // The bare product has no product-level set: not producible, refused.
    await expect(
      createCheckout(env.DB, TENANT_CONTEXT, checkoutInput([{ productId: "snap-sized", quantity: 1 }]), Date.now()),
    ).resolves.toEqual({ status: "invalid_items" });
  });

  it("recomputes eligibility at the freeze: a mapping deactivated after the cart refuses the checkout (HTTP 422)", async () => {
    await seedProduct(TENANT, { productId: "snap-late", priceMinor: 39_900 });
    expect((await map("snap-late", "art-front", ["front"])).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "snap-late", Date.now())).status).toBe("ok");
    // The buyer sees it (the "cart" moment)…
    expect(await getPublicProductByRef(env, env.DB, TENANT_CONTEXT, "snap-late")).not.toBeNull();

    // …the mapping is deactivated before they check out.
    const [mapping] = await listMappings(env.DB, ADMIN, "snap-late");
    await deleteMapping(env.DB, ADMIN, mapping?.mappingId ?? "", Date.now());

    await env.DB.prepare("DELETE FROM rate_limit_windows").run();
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/v1/checkout`, {
        body: JSON.stringify({
          consent: { terms: true },
          deliveryMethod: "shipping",
          email: "late@podtest.test",
          idempotencyKey: `idem-late-${crypto.randomUUID()}`,
          items: [{ productId: "snap-late", quantity: 1 }],
          recipient: buyerRecipientShipping("SE"),
          shippingCountry: "SE",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(422);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM checkout_items WHERE product_id = 'snap-late'",
    ).first<{ total: number }>();
    expect(rows?.total).toBe(0);
  });

  it("refuses when the printer lost a slot of the product (routing edit), until the seller re-posts", async () => {
    // A printer document without the back frame: snap-tee's back print cannot
    // be produced (its mapping is suspended in the same batch).
    const noBack = testPrinter();
    delete noBack.capabilities.models["2000"]?.printAreasMm.back;
    await replacePrinters(env.DB, PLATFORM, [noBack], Date.now());
    // Fail closed: the front print alone is NOT sold as if it were the product.
    await expect(
      createCheckout(env.DB, TENANT_CONTEXT, checkoutInput([{ productId: "snap-tee", quantity: 1 }]), Date.now()),
    ).resolves.toEqual({ status: "invalid_items" });
    expect(await getPublicProductByRef(env, env.DB, TENANT_CONTEXT, "snap-tee")).toBeNull();
    await expect(publishAdminProduct(env.DB, ADMIN, "snap-tee", Date.now())).resolves.toMatchObject({
      code: "pod_mapping_suspended",
      status: "refused",
    });

    // Restoring the frame does not silently resurrect the mapping: the seller
    // re-posts it (which re-validates), and the product is whole again.
    await replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now());
    expect(await getPublicProductByRef(env, env.DB, TENANT_CONTEXT, "snap-tee")).toBeNull();
    expect((await map("snap-tee", "art-back", ["back"])).status).toBe("ok");
    expect(await getPublicProductByRef(env, env.DB, TENANT_CONTEXT, "snap-tee")).not.toBeNull();

  });

  it("the HTTP checkout of a POD cart answers the unchanged buyer schema", async () => {
    await seedPrinter();
    await seedProduct(TENANT, { productId: "snap-http", priceMinor: 39_900 });
    expect((await map("snap-http", "art-front", ["front"])).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "snap-http", Date.now())).status).toBe("ok");
    await env.DB.prepare("DELETE FROM rate_limit_windows").run();
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/v1/checkout`, {
        body: JSON.stringify({
          consent: { terms: true },
          deliveryMethod: "shipping",
          email: "http@podtest.test",
          idempotencyKey: `idem-http-${crypto.randomUUID()}`,
          items: [{ productId: "snap-http", quantity: 1 }],
          recipient: buyerRecipientShipping("SE"),
          shippingCountry: "SE",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json<{ checkout: Record<string, unknown> }>();
    expect(Object.keys(body.checkout).sort()).toEqual([
      "checkoutId",
      "currency",
      "deliveryMethod",
      "discountCode",
      "discountMinor",
      "expiresAt",
      "items",
      "shippingCountry",
      "shippingMinor",
      "subtotalMinor",
      "totalMinor",
      "vatMinor",
      "vatRateBp",
    ]);
    expectNoCostKeys(body);
    expect(JSON.stringify(body)).not.toContain("pod/");
    const snapshot = (await snapshotOf(String(body.checkout.checkoutId))) as { printer: string };
    expect(snapshot.printer).toBe("fake-printer");
  });
});

// ── Codex CP2 P2: the base price of a variant product ───────────────────────

describe("the base price of a variant product is floor-checked whenever it is sellable", () => {
  it("a variant product with no product-level set: base not producible, not checked, not sellable", async () => {
    await seedProduct(TENANT, {
      priceMinor: 10_000,
      productId: "base-low",
      variants: [
        { priceMinor: 39_900, sku: "BASE-LOW-S", variantId: "base-low-s" },
        { priceMinor: 39_900, sku: "BASE-LOW-M", variantId: "base-low-m" },
      ],
    });
    expect((await map("base-low", "art-front", ["front"], { sku: TEE_S, variantId: "base-low-s" })).status).toBe("ok");
    expect((await map("base-low", "art-back", ["front"], { sku: TEE_M, variantId: "base-low-m" })).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "base-low", Date.now())).status).toBe("ok");

    await expect(
      createCheckout(env.DB, TENANT_CONTEXT, checkoutInput([{ productId: "base-low", quantity: 1 }]), Date.now()),
    ).resolves.toEqual({ status: "invalid_items" });
    await expect(
      createCheckout(
        env.DB,
        TENANT_CONTEXT,
        checkoutInput([{ productId: "base-low", quantity: 1, variantId: "base-low-s" }]),
        Date.now(),
      ),
    ).resolves.toMatchObject({ status: "ok" });
  });

  it("a product-level set makes the base purchase producible — then its price must clear PRISGOLV", async () => {
    // Live: adding the product-level set would make the 100 kr base sellable.
    await expect(map("base-low", "art-back", ["front"], { sku: TEE_S })).resolves.toEqual({
      code: "price_below_floor",
      status: "refused",
    });

    // Not live: the mapping is accepted, and the publish gate refuses instead.
    await unpublishAdminProduct(env.DB, ADMIN, "base-low", Date.now());
    expect((await map("base-low", "art-back", ["front"], { sku: TEE_S })).status).toBe("ok");
    await expect(publishAdminProduct(env.DB, ADMIN, "base-low", Date.now())).resolves.toMatchObject({
      code: "price_below_floor",
      status: "refused",
    });
    // Not live: the PATCH is accepted and the publish judges it.
    await expect(
      updateAdminProduct(env.DB, ADMIN, "base-low", { priceMinor: 15_000 }, Date.now()),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(publishAdminProduct(env.DB, ADMIN, "base-low", Date.now())).resolves.toMatchObject({
      code: "price_below_floor",
      status: "refused",
    });

    // Just under the floor (263 kr since D41) is still refused…
    await expect(
      updateAdminProduct(env.DB, ADMIN, "base-low", { priceMinor: 26_299 }, Date.now()),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(publishAdminProduct(env.DB, ADMIN, "base-low", Date.now())).resolves.toMatchObject({
      code: "price_below_floor",
      status: "refused",
    });
    // …the floor itself is a legal base price, and since D41 (the floor counts
    // the printer's per-order parcel) a one-item basket AT the floor clears its
    // own withholding, so it checks out (it used to be refused by A1):
    expect((await updateAdminProduct(env.DB, ADMIN, "base-low", { priceMinor: 26_300 }, Date.now())).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "base-low", Date.now())).status).toBe("ok");
    const base = await createCheckout(
      env.DB,
      TENANT_CONTEXT,
      checkoutInput([{ productId: "base-low", quantity: 1 }]),
      Date.now(),
    );
    expect(base.status).toBe("ok");
    const snapshot = (base.status === "ok" ? await snapshotOf(base.checkout.checkoutId) : null) as {
      lines: Array<{ printFiles: Array<{ r2Key: string }>; sku: string }>;
    };
    expect(snapshot.lines[0]?.sku).toBe(TEE_S);
    expect(snapshot.lines[0]?.printFiles.map((file) => file.r2Key)).toEqual([printKeyBack]);
  });
});

// ── Codex CP2 P2: no silent truncation of a mapping set or a variant list ───

describe("large products are read completely, or refused — never truncated", () => {
  const VARIANTS = 101;
  const pad = (index: number) => String(index).padStart(3, "0");
  const last = `many-v${pad(VARIANTS - 1)}`;

  beforeAll(async () => {
    await seedProduct(TENANT, {
      isPod: true,
      priceMinor: 39_900,
      productId: "many",
      variants: Array.from({ length: VARIANTS }, (_, index) => ({
        // The LAST variant (by id — the order a paged read would drop) is
        // priced between the front-only floor (263 kr) and the front+back
        // floor (317 kr, both D41): only a complete read of its set refuses it.
        priceMinor: index === VARIANTS - 1 ? 29_000 : 39_900,
        sku: `MANY-${pad(index)}`,
        variantId: `many-v${pad(index)}`,
      })),
    });
    // 202 ACTIVE mappings — past the old 200-row page — each variant with a
    // front and a back artwork; the last variant's BACK is the very last row.
    const base = Date.parse("2026-09-27T00:00:00.000Z");
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < VARIANTS; index += 1) {
      await seedArtwork(TENANT, { artworkId: `many-f-${pad(index)}` });
      await seedArtwork(TENANT, { artworkId: `many-b-${pad(index)}` });
      for (const [offset, side] of [[0, "f"], [1, "b"]] as const) {
        const iso = new Date(base + index * 2 + offset).toISOString();
        statements.push(
          env.DB.prepare(
            `INSERT INTO pod_mappings (
               id, tenant_id, product_id, variant_id, artwork_id, printer_id, sku,
               slots_json, status, suspended_reason, created_at, updated_at
             ) VALUES (?, ?, 'many', ?, ?, 'fake-printer', ?, ?, 'active', NULL, ?, ?)`,
          ).bind(
            `many-map-${side}-${pad(index)}`,
            TENANT,
            `many-v${pad(index)}`,
            `many-${side}-${pad(index)}`,
            TEE_S,
            JSON.stringify([
              { heightMm: 399, slot: side === "f" ? "front" : "back", widthMm: 299 },
            ]),
            iso,
            iso,
          ),
        );
      }
    }
    await env.DB.batch(statements);
  });

  it("the publish gate prices EVERY variant against its COMPLETE set (the 101st, front+back)", async () => {
    await expect(publishAdminProduct(env.DB, ADMIN, "many", Date.now())).resolves.toMatchObject({
      code: "price_below_floor",
      status: "refused",
    });
    await env.DB.prepare("UPDATE product_variants SET price_minor = 39900 WHERE variant_id = ?")
      .bind(last)
      .run();
    expect((await publishAdminProduct(env.DB, ADMIN, "many", Date.now())).status).toBe("ok");
  });

  it("the freeze reads the line's scope completely: the last variant ships front AND back", async () => {
    const result = await createCheckout(
      env.DB,
      TENANT_CONTEXT,
      checkoutInput([{ productId: "many", quantity: 1, variantId: last }]),
      Date.now(),
    );
    expect(result.status).toBe("ok");
    const snapshot = (result.status === "ok" ? await snapshotOf(result.checkout.checkoutId) : null) as {
      lines: Array<{ printFiles: Array<{ slot: string }>; productionCostMinor: number }>;
    };
    expect(snapshot.lines[0]?.printFiles.map((file) => file.slot)).toEqual(["front", "back"]);
    // 60 blank + 40 + 40 prints + 40 cut — not the front-only 140 kr.
    expect(snapshot.lines[0]?.productionCostMinor).toBe(18_000);
  });

  it("more variants than one gate checks completely is refused, not half-checked", async () => {
    // 0040 stops such a product at the write. The gate's own refusal stays for
    // rows that are older than that cap: written here without it.
    await env.DB.prepare("DROP TRIGGER IF EXISTS product_variants_limit_insert").run();
    await seedProduct(TENANT, {
      isPod: true,
      priceMinor: 39_900,
      productId: "too-many",
      variants: Array.from({ length: MAX_GATE_VARIANTS + 1 }, (_, index) => ({
        priceMinor: 39_900,
        sku: `TOO-MANY-${index}`,
        variantId: `too-many-v${String(index).padStart(3, "0")}`,
      })),
    });
    await expect(publishAdminProduct(env.DB, ADMIN, "too-many", Date.now())).resolves.toMatchObject({
      code: "pod_too_large",
      status: "refused",
    });
  });
});

// ── Codex follow-on: a gate that cannot price everything is a refusal ──────

describe("pod_too_large on a live product is refused by every caller of the gate", () => {
  beforeAll(async () => {
    // Live before it grew past MAX_GATE_VARIANTS (a fixture publication), and
    // older than 0040's cap, which would stop it at the write today.
    await env.DB.prepare("DROP TRIGGER IF EXISTS product_variants_limit_insert").run();
    await seedProduct(TENANT, {
      isPod: true,
      priceMinor: 39_900,
      productId: "big-live",
      published: true,
      variants: Array.from({ length: MAX_GATE_VARIANTS + 1 }, (_, index) => ({
        priceMinor: 39_900,
        sku: `BIG-LIVE-${index}`,
        variantId: `big-live-v${String(index).padStart(3, "0")}`,
      })),
    });
  });

  it("a mapping edit that would raise the floor is refused with the code, and writes nothing", async () => {
    await expect(map("big-live", "art-front", ["front"])).resolves.toEqual({
      code: "pod_too_large",
      status: "conflict",
    });
    expect(await listMappings(env.DB, ADMIN, "big-live")).toEqual([]);
  });

  it("a price CUT is refused with the code and a message naming the exit", async () => {
    const result = await updateAdminProduct(env.DB, ADMIN, "big-live", { priceMinor: 100 }, Date.now());
    expect(result).toMatchObject({ code: "pod_too_large", status: "refused" });
    expect(result.status === "refused" ? result.message : "").toMatch(/Unpublish it and reduce its active variants to 200 or fewer/);
    const row = await env.DB.prepare("SELECT b2c_price_minor FROM products WHERE product_id = 'big-live'")
      .first<{ b2c_price_minor: number }>();
    expect(row?.b2c_price_minor).toBe(39_900);
  });

  it("is never stranded: a price RAISE is allowed live, and anything is allowed once unpublished", async () => {
    await expect(
      updateAdminProduct(env.DB, ADMIN, "big-live", { priceMinor: 44_900 }, Date.now()),
    ).resolves.toMatchObject({ product: { priceMinor: 44_900 }, status: "ok" });
    await unpublishAdminProduct(env.DB, ADMIN, "big-live", Date.now());
    await expect(
      updateAdminProduct(env.DB, ADMIN, "big-live", { priceMinor: 100 }, Date.now()),
    ).resolves.toMatchObject({ status: "ok" });
    expect((await map("big-live", "art-front", ["front"])).status).toBe("ok");
    // …and the publish gate still will not put it live half-checked.
    await expect(publishAdminProduct(env.DB, ADMIN, "big-live", Date.now())).resolves.toMatchObject({
      code: "pod_too_large",
      status: "refused",
    });
  });
});

// ── Codex follow-on: the freeze reads ONE snapshot ─────────────────────────

/**
 * A D1 handle that runs `interleave` on the real database immediately before
 * its `atCall`-th operation (a statement's first/all/run/raw, or a batch) —
 * i.e. exactly between two of the caller's reads. Statements stay real for
 * batch(): the proxies are unwrapped before they reach D1.
 */
function interleavedDb(atCall: number, interleave: () => Promise<unknown>): D1Database {
  let calls = 0;
  const tick = async (): Promise<void> => {
    calls += 1;
    if (calls === atCall) {
      await interleave();
    }
  };
  const realOf = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return async (...args: unknown[]) => {
            await tick();
            return (Reflect.get(target, prop, target) as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    realOf.set(proxy, statement);
    return proxy;
  };
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => wrap(target.prepare(sql));
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await tick();
          return target.batch(statements.map((statement) => realOf.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe("a routing edit at ANY point of a checkout never yields a partial production snapshot", () => {
  it("refused, or complete front+back — for every interleaving point", async () => {
    const noBack = testPrinter();
    delete noBack.capabilities.models["2000"]?.printAreasMm.back;
    const outcomes: string[] = [];

    for (let atCall = 1; atCall <= 12; atCall += 1) {
      await replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now());
      const productId = `race-freeze-${atCall}`;
      await seedProduct(TENANT, { priceMinor: 39_900, productId });
      expect((await map(productId, "art-front", ["front"])).status).toBe("ok");
      expect((await map(productId, "art-back", ["back"])).status).toBe("ok");
      expect((await publishAdminProduct(env.DB, ADMIN, productId, Date.now())).status).toBe("ok");

      const racing = interleavedDb(atCall, () => replacePrinters(env.DB, PLATFORM, [noBack], Date.now()));
      const result = await createCheckout(
        racing,
        TENANT_CONTEXT,
        checkoutInput([{ productId, quantity: 1 }]),
        Date.now(),
      );
      if (result.status !== "ok") {
        outcomes.push("refused");
        continue;
      }
      const snapshot = (await snapshotOf(result.checkout.checkoutId)) as {
        lines: Array<{ printFiles: Array<{ slot: string }>; productionCostMinor: number }>;
      };
      // Never front-only: the whole garment, priced as the whole garment.
      expect(snapshot.lines[0]?.printFiles.map((file) => file.slot), `interleaved at call ${atCall}`).toEqual([
        "front",
        "back",
      ]);
      expect(snapshot.lines[0]?.productionCostMinor).toBe(18_000);
      outcomes.push("complete");
    }

    // Both sides of the race were actually exercised.
    expect(outcomes).toContain("refused");
    expect(outcomes).toContain("complete");
    await replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now());
  });
});

// ── Reviewer P2: no way around the floor through a suspended mapping ──────

async function setLivePrice(productId: string, priceMinor: number): Promise<void> {
  // A price that reached the row some other way (an import, legacy data).
  await env.DB.batch([
    env.DB.prepare("UPDATE products SET b2c_price_minor = ? WHERE product_id = ?").bind(priceMinor, productId),
    env.DB.prepare("UPDATE product_publications SET public_price_minor = ? WHERE product_id = ?").bind(
      priceMinor,
      productId,
    ),
  ]);
}

describe("the price floor holds while a mapping is suspended, and when a mapping is deleted", () => {
  it("ported regression: a price cut during a suspension is refused; the delete re-checks the floor", async () => {
    await seedProduct(TENANT, { priceMinor: 39_900, productId: "fb" });
    expect((await map("fb", "art-front", ["front"])).status).toBe("ok");
    expect((await map("fb", "art-back", ["back"])).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "fb", Date.now())).status).toBe("ok");
    // Front+back floor 250 kr.
    await expect(updateAdminProduct(env.DB, ADMIN, "fb", { priceMinor: 19_000 }, Date.now())).resolves.toMatchObject({
      code: "price_below_floor",
      status: "refused",
    });

    const noBack = testPrinter();
    delete noBack.capabilities.models["2000"]?.printAreasMm.back;
    await replacePrinters(env.DB, PLATFORM, [noBack], Date.now());

    // THE BYPASS: the gate stopped at pod_mapping_suspended without pricing
    // anything, and the cut was treated as a pass. Now: refused, with the code.
    await expect(updateAdminProduct(env.DB, ADMIN, "fb", { priceMinor: 19_000 }, Date.now())).resolves.toMatchObject({
      code: "pod_mapping_suspended",
      status: "refused",
    });

    // A price under the front-only floor (196 kr) that got there another way:
    // deleting the suspended back would return the product to the storefront
    // at 190 kr — refused.
    await setLivePrice("fb", 19_000);
    const back = (await listMappings(env.DB, ADMIN, "fb")).find((m) => m.status === "suspended");
    expect(back).toBeDefined();
    await expect(deleteMapping(env.DB, ADMIN, back?.mappingId ?? "", Date.now())).resolves.toEqual({
      code: "price_below_floor",
      status: "refused",
    });
    expect(await getPublicProductByRef(env, env.DB, TENANT_CONTEXT, "fb")).toBeNull();
    await expect(
      createCheckout(env.DB, TENANT_CONTEXT, checkoutInput([{ productId: "fb", quantity: 10 }]), Date.now(), {
        dispatchTarget: "fake-printer",
      }),
    ).resolves.toEqual({ status: "invalid_items" });

    // A raise is always allowed, even now; then the delete passes the floor.
    await expect(updateAdminProduct(env.DB, ADMIN, "fb", { priceMinor: 39_900 }, Date.now())).resolves.toMatchObject({
      status: "ok",
    });
    await expect(deleteMapping(env.DB, ADMIN, back?.mappingId ?? "", Date.now())).resolves.toEqual({ status: "ok" });
    const sold = await createCheckout(
      env.DB,
      TENANT_CONTEXT,
      checkoutInput([{ productId: "fb", quantity: 10 }]),
      Date.now(),
      { dispatchTarget: "fake-printer" },
    );
    expect(sold.status).toBe("ok");
    const snapshot = (sold.status === "ok" ? await snapshotOf(sold.checkout.checkoutId) : null) as {
      lines: Array<{ productionCostMinor: number }>;
    };
    expect(snapshot.lines[0]?.productionCostMinor).toBe(14_000 * 10);
    await replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now());
  });

  it("deleting a variant's own set may not drop it onto a costlier product-level set under its price", async () => {
    // Independent of the previous case's printer state.
    await replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now());
    await seedProduct(TENANT, {
      priceMinor: 39_900,
      productId: "fallback",
      variants: [{ priceMinor: 29_000, sku: "FALLBACK-M", variantId: "fallback-m" }],
    });
    // The variant's own set: front only on TEE_M (floor 263 kr ≤ its 290 kr).
    expect((await map("fallback", "art-front", ["front"], { sku: TEE_M, variantId: "fallback-m" })).status).toBe("ok");
    // The product-level set: front+back on TEE_S (floor 317 kr).
    expect((await map("fallback", "art-front", ["front"])).status).toBe("ok");
    expect((await map("fallback", "art-back", ["back"])).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "fallback", Date.now())).status).toBe("ok");

    const own = (await listMappings(env.DB, ADMIN, "fallback")).find((m) => m.variantId === "fallback-m");
    await expect(deleteMapping(env.DB, ADMIN, own?.mappingId ?? "", Date.now())).resolves.toEqual({
      code: "price_below_floor",
      status: "refused",
    });
    expect((await listMappings(env.DB, ADMIN, "fallback")).find((m) => m.variantId === "fallback-m")?.status).toBe(
      "active",
    );
  });
});

// ── Reviewer P3: one snapshot for every line of a cart ─────────────────────

describe("a tier-only routing edit at ANY point of a two-line checkout never mixes price lists", () => {
  it("both lines priced under the old tiers, or both under the new — never one of each", async () => {
    for (const productId of ["mix-a", "mix-b"]) {
      await seedProduct(TENANT, { priceMinor: 39_900, productId });
      expect((await map(productId, "art-front", ["front"])).status).toBe("ok");
      expect((await publishAdminProduct(env.DB, ADMIN, productId, Date.now())).status).toBe("ok");
    }
    const pricier = testPrinter();
    const teeS = pricier.tiers.find((tier) => tier.sku === TEE_S);
    if (teeS !== undefined) {
      teeS.printCostsMinor.front = 9_000;
    }
    const seen = new Set<string>();

    for (let atCall = 1; atCall <= 10; atCall += 1) {
      await replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now());
      const racing = interleavedDb(atCall, () => replacePrinters(env.DB, PLATFORM, [pricier], Date.now()));
      const result = await createCheckout(
        racing,
        TENANT_CONTEXT,
        checkoutInput([
          { productId: "mix-a", quantity: 1 },
          { productId: "mix-b", quantity: 1 },
        ]),
        Date.now(),
      );
      if (result.status !== "ok") {
        seen.add("refused");
        continue;
      }
      const snapshot = (await snapshotOf(result.checkout.checkoutId)) as {
        lines: Array<{ productionCostMinor: number }>;
      };
      const costs = snapshot.lines.map((line) => line.productionCostMinor);
      // 60 + 40 + 40 = 140 kr under the old tier, 60 + 90 + 40 = 190 kr under the new.
      expect([[14_000, 14_000], [19_000, 19_000]], `interleaved at call ${atCall}: ${costs.join("/")}`).toContainEqual(costs);
      seen.add(costs[0] === 14_000 ? "old" : "new");
    }

    expect(seen).toContain("old");
    expect(seen).toContain("new");
    await replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now());
  });
});

// ── Codex P2 (performance): the freeze's tier read is mapping-first ────────

describe("the freeze's tier read never scans the tier table", () => {
  it("EXPLAIN QUERY PLAN: mappings searched by index, each tier by its primary key — no SCAN", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${PRODUCTION_TIER_READ_SQL}`)
      .bind(TENANT, "snap-tee", null)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);

    // The regression: a full pass over printer_sku_tiers (323 SnapWear SKUs)
    // re-searching the product's mappings per tier, once per checkout line.
    expect(details.filter((detail) => /^SCAN /.test(detail)), details.join(" | ")).toEqual([]);
    expect(details.some((detail) => /^SEARCH mapping USING INDEX pod_mappings_tenant_product_status_idx/.test(detail))).toBe(true);
    expect(details.some((detail) => /^SEARCH tier USING INDEX sqlite_autoindex_printer_sku_tiers_1 \(printer_id=\? AND sku=\?\)/.test(detail))).toBe(true);
    // Mapping-first: the mapping search is the outer loop.
    const mappingAt = details.findIndex((detail) => detail.startsWith("SEARCH mapping"));
    const tierAt = details.findIndex((detail) => detail.startsWith("SEARCH tier"));
    expect(mappingAt).toBeLessThan(tierAt);
  });

  it("returns exactly the tiers of the line's active scope mappings", async () => {
    const rows = await env.DB.prepare(PRODUCTION_TIER_READ_SQL)
      .bind(TENANT, "snap-tee", null)
      .all<{ printer_id: string; sku: string }>();
    expect([...new Set(rows.results.map((row) => `${row.printer_id}/${row.sku}`))]).toEqual([`fake-printer/${TEE_S}`]);
    // A variant line reads its own set's SKU (and the product-level one).
    const sized = await env.DB.prepare(PRODUCTION_TIER_READ_SQL)
      .bind(TENANT, "snap-sized", "snap-sized-m")
      .all<{ sku: string }>();
    expect(sized.results.map((row) => row.sku)).toEqual([TEE_M]);
  });
});
