import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  publishAdminProduct,
  unpublishAdminProduct,
  updateAdminProduct,
} from "../src/catalog/admin-catalog";
import { getPublicProduct } from "../src/catalog/public-catalog";
import { decideByPlatform } from "../src/catalog/screening";
import { createCheckout } from "../src/commerce/checkout";
import type { CreateCheckoutInput } from "../src/commerce/checkout";
import { createMapping, deleteMapping, listMappings } from "../src/pod/pod-mappings";
import { replacePrinters } from "../src/pod/printers";
import {
  handlePublicProductRequest,
  handlePublicProductsRequest,
  handlePublicStorefrontRequest,
} from "../src/storefront/public-routes";
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

    await expect(publishAdminProduct(env.DB, ADMIN, "gate-unmapped", Date.now())).resolves.toEqual({
      code: "pod_mapping_missing",
      status: "refused",
    });
    expect(await publishedFlag("gate-unmapped")).toBeNull();
  });

  it("PRISGOLV: refuses a price under the floor, accepts one exactly at it", async () => {
    // front only: 60 + 40 + 40 = 140 kr ex → floor 196 kr.
    await seedProduct(TENANT, { productId: "gate-floor", priceMinor: 19_500 });
    expect((await map("gate-floor", "art-front", ["front"])).status).toBe("ok");
    await expect(publishAdminProduct(env.DB, ADMIN, "gate-floor", Date.now())).resolves.toEqual({
      code: "price_below_floor",
      status: "refused",
    });

    // A PATCH may not dodge it either (ProductForm's rule): still refused…
    await expect(
      updateAdminProduct(env.DB, ADMIN, "gate-floor", { priceMinor: 19_599 }, Date.now()),
    ).resolves.toEqual({ code: "price_below_floor", status: "refused" });
    // …while the floor itself is a legal price.
    await expect(
      updateAdminProduct(env.DB, ADMIN, "gate-floor", { priceMinor: 19_600 }, Date.now()),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(publishAdminProduct(env.DB, ADMIN, "gate-floor", Date.now())).resolves.toMatchObject({
      product: { isPod: true, priceMinor: 19_600, screeningStatus: "advisory" },
      status: "ok",
    });
  });

  it("a mapping edit on a LIVE product may not push its floor over the price", async () => {
    // gate-floor is live at 196 kr; a back print would make the floor 250 kr.
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
    const detail = await getPublicProduct(env.DB, TENANT_CONTEXT, "pdp-tee");
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
    const first = await handlePublicProductRequest(env, new Request(`${ORIGIN}/v1/products/pdp-tee`), "pdp-tee");
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe(`"${version}"`);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const body = await first.json();
    expectNoCostKeys(body);

    const again = await handlePublicProductRequest(
      env,
      new Request(`${ORIGIN}/v1/products/pdp-tee`, { headers: { "if-none-match": `"${version}"` } }),
      "pdp-tee",
    );
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    for (const response of [
      await handlePublicProductsRequest(env, new Request(`${ORIGIN}/v1/products`)),
      await handlePublicStorefrontRequest(env, new Request(`${ORIGIN}/v1/storefront`)),
    ]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe(`"${version}"`);
      expectNoCostKeys(await response.json());
    }
  });

  it("a takedown answers 404 on the very next request — cached ETag or not — and kills the preview", async () => {
    const version = await catalogVersion(TENANT);
    const cached = `"${version}"`;
    await decideByPlatform(env.DB, PLATFORM, "pdp-tee", "blocked", Date.now());
    expect(await catalogVersion(TENANT)).toBeGreaterThan(version);

    const conditional = await handlePublicProductRequest(
      env,
      new Request(`${ORIGIN}/v1/products/pdp-tee`, { headers: { "if-none-match": cached } }),
      "pdp-tee",
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
    expect(await getPublicProduct(env.DB, TENANT_CONTEXT, "pdp-tee")).toBeNull();
    await env.DB.prepare("UPDATE tenants SET published = 1 WHERE tenant_id = ?").bind(TENANT).run();
    await bumps("printer deactivated", () =>
      replacePrinters(env.DB, PLATFORM, [testPrinter({ status: "inactive" })], Date.now()),
    );
    // A POD product with no ACTIVE printer behind its mapping is not public.
    expect(await getPublicProduct(env.DB, TENANT_CONTEXT, "pdp-tee")).toBeNull();
    await bumps("printer reactivated", () => replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now()));
    expect(await getPublicProduct(env.DB, TENANT_CONTEXT, "pdp-tee")).not.toBeNull();
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
            { slot: "front", r2Key: printKeyFront, sha256: hex64("b"), widthMm: 299, heightMm: 399 },
            { slot: "back", r2Key: printKeyBack, sha256: hex64("b"), widthMm: 299, heightMm: 399 },
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
    expect(await getPublicProduct(env.DB, TENANT_CONTEXT, "snap-late")).not.toBeNull();

    // …the mapping is deactivated before they check out.
    const [mapping] = await listMappings(env.DB, ADMIN, "snap-late");
    await deleteMapping(env.DB, ADMIN, mapping?.mappingId ?? "", Date.now());

    await env.DB.prepare("DELETE FROM rate_limit_windows").run();
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/v1/checkout`, {
        body: JSON.stringify({
          deliveryMethod: "shipping",
          email: "late@podtest.test",
          idempotencyKey: `idem-late-${crypto.randomUUID()}`,
          items: [{ productId: "snap-late", quantity: 1 }],
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
    expect(await getPublicProduct(env.DB, TENANT_CONTEXT, "snap-tee")).toBeNull();
    await expect(publishAdminProduct(env.DB, ADMIN, "snap-tee", Date.now())).resolves.toEqual({
      code: "pod_mapping_suspended",
      status: "refused",
    });

    // Restoring the frame does not silently resurrect the mapping: the seller
    // re-posts it (which re-validates), and the product is whole again.
    await replacePrinters(env.DB, PLATFORM, [testPrinter()], Date.now());
    expect(await getPublicProduct(env.DB, TENANT_CONTEXT, "snap-tee")).toBeNull();
    expect((await map("snap-tee", "art-back", ["back"])).status).toBe("ok");
    expect(await getPublicProduct(env.DB, TENANT_CONTEXT, "snap-tee")).not.toBeNull();

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
          deliveryMethod: "shipping",
          email: "http@podtest.test",
          idempotencyKey: `idem-http-${crypto.randomUUID()}`,
          items: [{ productId: "snap-http", quantity: 1 }],
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
