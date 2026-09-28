import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN,
  approveProduct,
  bootstrapPlatform,
  call,
  createPodProduct,
  createTenant,
  expectJson,
  payCheckout,
  publishProduct,
  type Quote,
  renderReadyArtwork,
  seedPrintShop,
  SliceWorld,
  storefrontCall,
  succeedPayment,
  type Tenant,
  unique,
} from "./slice-harness";
import { createProductVariant, deleteProductVariant } from "../src/catalog/product-variants";
import { decideByPlatform } from "../src/catalog/screening";
import { adminOf, PLATFORM } from "./pod-fixtures";
import { auditRows, expectOpaque404, tenantRow } from "./tenant-fixtures";

/**
 * CP4-A — a product's variants: POST, PATCH, DELETE
 * /v1/admin/products/:productId/variants[/:variantId] (src/catalog/
 * product-variants.ts). Money stays keyed on the variant: checkout resolves a
 * line by the variant id and charges the row's price under the row's sku,
 * unchanged — proven here through the real checkout, payment and webhook.
 * A variant a checkout, a paid order or a print mapping names is deactivated,
 * never deleted. PRISGOLV covers a variant's price on a live POD product.
 */

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
const NOW = Date.now();

interface VariantBody {
  variant: {
    active: boolean;
    group: string | null;
    label: string;
    position: number;
    priceMinor: number;
    size: string | null;
    sku: string;
    variantId: string;
  };
}

interface PublicDetail {
  product: {
    images: unknown[];
    isFromPrice: boolean;
    lowestPriceMinor: number;
    swatches: Array<{ label: string }>;
    variants: Array<{ group: string | null; label: string; position: number; priceMinor: number; size: string | null; sku: string; variantId: string }>;
  };
}

function admin(tenant: Tenant, method: string, path: string, body?: unknown, origin?: string | null): Promise<Response> {
  return call(world, method, `${ADMIN}${path}`, {
    body,
    cookie: tenant.adminCookie,
    origin,
    shopId: tenant.tenantId,
  });
}

async function createProduct(tenant: Tenant, body: Record<string, unknown>): Promise<string> {
  const created = await expectJson<{ product: { productId: string } }>(
    await admin(tenant, "POST", "/v1/admin/products", {
      allowPickup: true,
      currency: "SEK",
      priceMinor: 20_000,
      ...body,
    }),
    201,
    `create ${String(body.sku)}`,
  );
  return created.product.productId;
}

async function liveProduct(tenant: Tenant, body: Record<string, unknown>): Promise<string> {
  const productId = await createProduct(tenant, body);
  await expectJson(await admin(tenant, "PATCH", `/v1/admin/products/${productId}`, { status: "active" }), 200, "activate");
  const published = await publishProduct(world, tenant, productId);
  if (published.product.screeningStatus === "pending") {
    await approveProduct(world, productId);
  }
  return productId;
}

async function addVariant(tenant: Tenant, productId: string, body: Record<string, unknown>): Promise<VariantBody["variant"]> {
  const created = await expectJson<VariantBody>(
    await admin(tenant, "POST", `/v1/admin/products/${productId}/variants`, body),
    201,
    `variant ${String(body.sku)}`,
  );
  return created.variant;
}

async function publicDetail(tenant: Tenant, productId: string): Promise<PublicDetail["product"]> {
  const body = await expectJson<PublicDetail>(
    await call(world, "GET", `${tenant.origin}/v1/products/${productId}`),
    200,
    `detail ${productId}`,
  );
  return body.product;
}

async function variantRow(variantId: string) {
  return env.DB.prepare(
    "SELECT sku, label, price_minor, active, variant_group, size, position FROM product_variants WHERE variant_id = ?",
  )
    .bind(variantId)
    .first<Record<string, unknown>>();
}

async function catalogVersion(tenantId: string): Promise<number> {
  return (await tenantRow(tenantId))?.catalog_version ?? -1;
}

async function seedLive(tenantId: string, productId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO products (product_id, tenant_id, status, sku, name, b2c_price_minor, currency, is_pod, created_at, updated_at)
       VALUES (?, ?, 'active', ?, 'Seed', 1000, 'SEK', 0, ?, ?)`,
    ).bind(productId, tenantId, `SKU-${productId}`, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO product_publications (product_id, tenant_id, published, public_name, public_price_minor,
         currency, projection_version, published_at, updated_at)
       VALUES (?, ?, 1, 'Seed', 1000, 'SEK', 1, ?, ?)`,
    ).bind(productId, tenantId, NOW, NOW),
  ]);
}

/** A buyer's checkout of one variant (the real storefront route). */
function checkoutOf(tenant: Tenant, productId: string, variantId: string): Promise<Response> {
  return storefrontCall(world, tenant, "POST", "/v1/checkout", {
    body: {
      consent: { terms: true },
      deliveryMethod: "pickup",
      email: `${unique("buyer")}@buyers.cp4a.test`,
      idempotencyKey: unique("idem-cp4a"),
      items: [{ productId, quantity: 2, variantId }],
    },
    origin: null,
  });
}

interface CheckoutBody {
  checkout: {
    checkoutId: string;
    items: Array<{ sku: string; unitPriceMinor: number; variantId: string | null }>;
    totalMinor: number;
  };
}

beforeAll(async () => {
  world = new SliceWorld();
  await bootstrapPlatform(world);
  await seedPrintShop(world);
  shopA = await createTenant(world, { host: "cp4v-a.shops.cp4a.test", shopName: "Variant A", tenantId: "cp4v-a" });
  shopB = await createTenant(world, { host: "cp4v-b.shops.cp4a.test", shopName: "Variant B", tenantId: "cp4v-b" });
  // D8: two live products first, so everything published here is public at once.
  for (const tenant of [shopA, shopB]) {
    await seedLive(tenant.tenantId, `${tenant.tenantId}-seed-1`);
    await seedLive(tenant.tenantId, `${tenant.tenantId}-seed-2`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
describe("refusals", () => {
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    productId = await createProduct(shopA, { name: "Refusal hoodie", sku: "V-REF" });
    variantId = (await addVariant(shopA, productId, { label: "S", priceMinor: 100, sku: "V-REF-S" })).variantId;
  });

  it("another shop's admin, no session, a foreign origin: the opaque 404, nothing written", async () => {
    const version = await catalogVersion(shopA.tenantId);
    for (const [method, path, body] of [
      ["POST", `/v1/admin/products/${productId}/variants`, { label: "M", priceMinor: 100, sku: "V-REF-M" }],
      ["PATCH", `/v1/admin/products/${productId}/variants/${variantId}`, { label: "X" }],
      ["DELETE", `/v1/admin/products/${productId}/variants/${variantId}`, undefined],
    ] as const) {
      await expectOpaque404(await admin(shopB, method, path, body), `B ${method}`);
      await expectOpaque404(await call(world, method, `${ADMIN}${path}`, { body }), `anonymous ${method}`);
      await expectOpaque404(await admin(shopA, method, path, body, "https://evil.example"), `origin ${method}`);
    }
    expect(await catalogVersion(shopA.tenantId)).toBe(version);
    expect(await variantRow(variantId)).toMatchObject({ active: 1, label: "S" });
  });

  it("a variant under another product's path is not found", async () => {
    const other = await createProduct(shopA, { name: "Other", sku: "V-OTHER" });
    await expectOpaque404(
      await admin(shopA, "PATCH", `/v1/admin/products/${other}/variants/${variantId}`, { label: "X" }),
      "patch under another product",
    );
    await expectOpaque404(
      await admin(shopA, "DELETE", `/v1/admin/products/${other}/variants/${variantId}`),
      "delete under another product",
    );
    expect(await variantRow(variantId)).toMatchObject({ label: "S" });
  });

  it.each([
    ["no sku", { label: "M", priceMinor: 100 }],
    ["no label", { priceMinor: 100, sku: "V-X" }],
    ["an empty label", { label: "  ", priceMinor: 100, sku: "V-X" }],
    ["no price", { label: "M", sku: "V-X" }],
    ["a negative price", { label: "M", priceMinor: -1, sku: "V-X" }],
    ["a fractional price", { label: "M", priceMinor: 1.5, sku: "V-X" }],
    ["an unknown key", { label: "M", priceMinor: 100, sku: "V-X", stock: 3 }],
    ["a position past the rail", { label: "M", position: 10_001, priceMinor: 100, sku: "V-X" }],
    ["active as a string", { active: "yes", label: "M", priceMinor: 100, sku: "V-X" }],
    ["a group too long", { group: "g".repeat(101), label: "M", priceMinor: 100, sku: "V-X" }],
    ["a size with a control character", { label: "M", priceMinor: 100, size: "M\u0007", sku: "V-X" }],
    ["not an object", ["M"]],
  ])("a create with %s is a 400", async (_label, body) => {
    const response = await admin(shopA, "POST", `/v1/admin/products/${productId}/variants`, body);
    expect(response.status).toBe(400);
    await response.body?.cancel();
  });

  it("an empty or unknown patch is a 400", async () => {
    for (const body of [{}, { sku: "" }, { color: "red" }, { active: 1 }]) {
      const response = await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${variantId}`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await response.body?.cancel();
    }
  });

  it("a sku another variant of the shop holds is a 409; another shop may hold it", async () => {
    const other = await createProduct(shopA, { name: "Dup", sku: "V-DUP" });
    const response = await admin(shopA, "POST", `/v1/admin/products/${other}/variants`, {
      label: "S",
      priceMinor: 100,
      sku: "V-REF-S",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "conflict" } });
    const theirs = await createProduct(shopB, { name: "Dup", sku: "V-DUP" });
    await addVariant(shopB, theirs, { label: "S", priceMinor: 100, sku: "V-REF-S" });
  });

  it("the 101st active variant is refused; an inactive one still fits", async () => {
    const full = await createProduct(shopA, { name: "Full", sku: "V-FULL" });
    await env.DB.batch(
      Array.from({ length: 100 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO product_variants (variant_id, tenant_id, product_id, sku, label, price_minor, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 100, 1, ?, ?)`,
        ).bind(`full-${index}`, shopA.tenantId, full, `V-FULL-${index}`, `L${index}`, NOW, NOW),
      ),
    );
    const refused = await admin(shopA, "POST", `/v1/admin/products/${full}/variants`, {
      label: "one more",
      priceMinor: 100,
      sku: "V-FULL-X",
    });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "variant_limit" } });
    const inactive = await addVariant(shopA, full, { active: false, label: "spare", priceMinor: 100, sku: "V-FULL-Y" });
    const reactivate = await admin(shopA, "PATCH", `/v1/admin/products/${full}/variants/${inactive.variantId}`, {
      active: true,
    });
    expect(reactivate.status).toBe(409);
    await reactivate.body?.cancel();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the rail: create, edit, order, and what a visitor sees", () => {
  let productId: string;

  beforeAll(async () => {
    productId = await liveProduct(shopA, { name: "Rail hoodie", priceMinor: 30_000, sku: "V-RAIL" });
  });

  it("creates variants with group, size and position; the next position follows the last", async () => {
    const black = await addVariant(shopA, productId, { group: "Svart", label: "Svart / M", priceMinor: 30_000, size: "M", sku: "V-RAIL-SM" });
    const blackL = await addVariant(shopA, productId, { group: "Svart", label: "Svart / L", priceMinor: 32_000, size: "L", sku: "V-RAIL-SL" });
    const white = await addVariant(shopA, productId, { group: "Vit", label: "Vit / M", position: 0, priceMinor: 28_000, size: "M", sku: "V-RAIL-VM" });
    expect(black).toMatchObject({ active: true, group: "Svart", position: 0, size: "M" });
    expect(blackL.position).toBe(1);
    expect(white.position).toBe(0);

    const detail = await publicDetail(shopA, productId);
    // Rail order: position, then label, then id.
    expect(detail.variants.map((v) => v.sku)).toEqual(["V-RAIL-SM", "V-RAIL-VM", "V-RAIL-SL"]);
    expect(detail.variants[0]).toMatchObject({ group: "Svart", label: "Svart / M", position: 0, priceMinor: 30_000, size: "M" });
    expect(detail.lowestPriceMinor).toBe(28_000);
    expect(detail.isFromPrice).toBe(true);
    expect(detail.swatches.map((s) => s.label)).toEqual(["Svart", "Vit"]);
  });

  it("an edit changes what a visitor sees and the ETag; an inactive variant is never shown", async () => {
    const [first] = (await publicDetail(shopA, productId)).variants;
    const before = await call(world, "GET", `${shopA.origin}/v1/products/${productId}`);
    const etag = before.headers.get("etag");
    await before.body?.cancel();

    const edited = await expectJson<VariantBody>(
      await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${first?.variantId}`, {
        active: false,
        position: 9,
      }),
      200,
      "deactivate",
    );
    expect(edited.variant).toMatchObject({ active: false, position: 9 });
    const after = await call(world, "GET", `${shopA.origin}/v1/products/${productId}`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(after.status).toBe(200);
    const body = await after.json<PublicDetail>();
    expect(body.product.variants.map((v) => v.variantId)).not.toContain(first?.variantId);
    expect(JSON.stringify(body)).not.toContain("V-RAIL-SM");

    const audit = (await auditRows(shopA.tenantId, "product.variant_update")).at(-1);
    expect(audit).toMatchObject({ metadata: { fields: ["active", "position"], variantId: first?.variantId }, resourceId: productId });
  });

  it("a draft product's variants are not public, and neither is the draft", async () => {
    const draft = await createProduct(shopA, { name: "Draft hoodie", sku: "V-DRAFT" });
    await addVariant(shopA, draft, { label: "Only", priceMinor: 100, sku: "V-DRAFT-O" });
    const response = await call(world, "GET", `${shopA.origin}/v1/products/${draft}`);
    expect(response.status).toBe(404);
    const list = await call(world, "GET", `${shopA.origin}/v1/products`);
    expect(await list.text()).not.toContain("V-DRAFT-O");
  });

  it("every variant write bumps the shop's catalog_version", async () => {
    const bumps = async (label: string, write: () => Promise<Response>) => {
      const before = await catalogVersion(shopA.tenantId);
      const response = await write();
      expect(response.status, label).toBeLessThan(300);
      await response.body?.cancel();
      expect(await catalogVersion(shopA.tenantId), label).toBeGreaterThan(before);
    };
    let variantId = "";
    await bumps("create", async () => {
      const response = await admin(shopA, "POST", `/v1/admin/products/${productId}/variants`, {
        label: "Bump",
        priceMinor: 30_000,
        sku: "V-RAIL-BUMP",
      });
      variantId = (await response.clone().json<VariantBody>()).variant.variantId;
      return response;
    });
    await bumps("patch", () =>
      admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${variantId}`, { label: "Bumped" }),
    );
    await bumps("delete", () => admin(shopA, "DELETE", `/v1/admin/products/${productId}/variants/${variantId}`));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("money stays keyed on the variant (the real checkout, payment and webhook)", () => {
  let productId: string;
  let variant: VariantBody["variant"];

  beforeAll(async () => {
    productId = await liveProduct(shopA, { name: "Money tee", priceMinor: 25_000, sku: "V-MONEY" });
    variant = await addVariant(shopA, productId, { group: "Röd", label: "Röd / S", priceMinor: 27_500, size: "S", sku: "V-MONEY-RS" });
  });

  it("a line is priced at the variant's price under the variant's sku, and follows an edit", async () => {
    const first = await expectJson<CheckoutBody>(await checkoutOf(shopA, productId, variant.variantId), 201, "checkout");
    expect(first.checkout.items[0]).toMatchObject({ sku: "V-MONEY-RS", unitPriceMinor: 27_500, variantId: variant.variantId });
    expect(first.checkout.totalMinor).toBe(55_000);

    await expectJson(
      await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${variant.variantId}`, { priceMinor: 26_000, sku: "V-MONEY-RS2" }),
      200,
      "reprice",
    );
    const second = await expectJson<CheckoutBody>(await checkoutOf(shopA, productId, variant.variantId), 201, "checkout 2");
    expect(second.checkout.items[0]).toMatchObject({ sku: "V-MONEY-RS2", unitPriceMinor: 26_000 });
    // The first checkout's line is frozen.
    const frozen = await env.DB.prepare("SELECT sku, unit_price_minor FROM checkout_items WHERE checkout_id = ?")
      .bind(first.checkout.checkoutId)
      .first();
    expect(frozen).toEqual({ sku: "V-MONEY-RS", unit_price_minor: 27_500 });
  });

  it("an inactive variant cannot be bought", async () => {
    const spare = await addVariant(shopA, productId, { active: false, label: "Spare", priceMinor: 100, sku: "V-MONEY-SPARE" });
    const response = await checkoutOf(shopA, productId, spare.variantId);
    expect(response.status).toBeGreaterThanOrEqual(400);
    await response.body?.cancel();
  });

  it("a variant a checkout names is deactivated, never deleted", async () => {
    const named = await addVariant(shopA, productId, { label: "Named", priceMinor: 25_000, sku: "V-MONEY-N" });
    await expectJson(await checkoutOf(shopA, productId, named.variantId), 201, "checkout");
    const removed = await expectJson<{ outcome: string; variant: { active: boolean } | null }>(
      await admin(shopA, "DELETE", `/v1/admin/products/${productId}/variants/${named.variantId}`),
      200,
      "delete",
    );
    expect(removed).toMatchObject({ outcome: "deactivated", variant: { active: false } });
    expect(await variantRow(named.variantId)).toMatchObject({ active: 0 });
    const audit = (await auditRows(shopA.tenantId, "product.variant_delete")).at(-1);
    expect(audit?.metadata).toEqual({ outcome: "deactivated", variantId: named.variantId });
  });

  it("a variant a PAID order names is deactivated, and the order keeps its line", async () => {
    const paid = await addVariant(shopA, productId, { label: "Paid", priceMinor: 25_000, sku: "V-MONEY-P" });
    const checkout = await expectJson<CheckoutBody>(await checkoutOf(shopA, productId, paid.variantId), 201, "checkout");
    const paymentIntentId = await payCheckout(world, shopA, checkout.checkout.checkoutId);
    const { orderId } = await succeedPayment(world, shopA, {
      checkoutId: checkout.checkout.checkoutId,
      paymentIntentId,
      totalMinor: checkout.checkout.totalMinor,
    });
    expect(orderId).not.toBeNull();
    // The checkout's own line names the variant too; take it away so that the
    // PAID ORDER alone is what keeps the variant.
    await env.DB.prepare("DELETE FROM checkout_items WHERE checkout_id = ?")
      .bind(checkout.checkout.checkoutId)
      .run();
    const removed = await expectJson<{ outcome: string }>(
      await admin(shopA, "DELETE", `/v1/admin/products/${productId}/variants/${paid.variantId}`),
      200,
      "delete",
    );
    expect(removed.outcome).toBe("deactivated");
    const line = await env.DB.prepare("SELECT sku, variant_id FROM order_items WHERE order_id = ?")
      .bind(orderId)
      .first();
    expect(line).toEqual({ sku: "V-MONEY-P", variant_id: paid.variantId });
  });

  it("a variant nothing names is deleted, with its own images", async () => {
    const loose = await addVariant(shopA, productId, { label: "Loose", priceMinor: 25_000, sku: "V-MONEY-L" });
    const removed = await expectJson<{ outcome: string; variant: unknown }>(
      await admin(shopA, "DELETE", `/v1/admin/products/${productId}/variants/${loose.variantId}`),
      200,
      "delete",
    );
    expect(removed).toEqual({ outcome: "deleted", variant: null });
    expect(await variantRow(loose.variantId)).toBeNull();
    const again = await admin(shopA, "DELETE", `/v1/admin/products/${productId}/variants/${loose.variantId}`);
    expect(again.status).toBe(404);
    await again.body?.cancel();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a variant's texts are screened", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO content_screening_terms (term, kind, hard_block, created_at) VALUES ('quorvak', 'band', 1, ?)",
    )
      .bind(new Date().toISOString())
      .run();
  });

  it.each([
    ["label", { label: "Quorvak edition", priceMinor: 100, sku: "V-SCR-1" }],
    ["group", { group: "Quorvak", label: "One", priceMinor: 100, sku: "V-SCR-2" }],
    ["size", { label: "One", priceMinor: 100, size: "Quorvak", sku: "V-SCR-3" }],
  ])("a hard-blocked term in a new variant's %s takes the live product down", async (label, body) => {
    const productId = await liveProduct(shopA, { name: `Screened ${label}`, sku: `V-SCR-P-${label}` });
    await addVariant(shopA, productId, body);
    expect((await call(world, "GET", `${shopA.origin}/v1/products/${productId}`)).status).toBe(404);
    const row = await env.DB.prepare("SELECT status FROM product_screening WHERE product_id = ?")
      .bind(productId)
      .first<{ status: string }>();
    expect(row?.status).toBe("blocked");
  });

  it("on a draft the write is fenced, not screened; the publish screens it", async () => {
    const productId = await createProduct(shopA, { name: "Draft screened", sku: "V-SCR-D" });
    await addVariant(shopA, productId, { label: "Quorvak", priceMinor: 100, sku: "V-SCR-D-1" });
    expect(
      await env.DB.prepare("SELECT 1 FROM product_screening WHERE product_id = ?").bind(productId).first(),
    ).toBeNull();
    await expectJson(await admin(shopA, "PATCH", `/v1/admin/products/${productId}`, { status: "active" }), 200, "activate");
    const published = await publishProduct(world, shopA, productId);
    expect(published.product.screeningStatus).toBe("blocked");
  });

  it("an inactive variant's label is not public, so it is not screened", async () => {
    const productId = await liveProduct(shopA, { name: "Inactive screened", sku: "V-SCR-I" });
    await addVariant(shopA, productId, { active: false, label: "Quorvak", priceMinor: 100, sku: "V-SCR-I-1" });
    expect((await call(world, "GET", `${shopA.origin}/v1/products/${productId}`)).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("PRISGOLV: a variant's price on a live POD product", () => {
  let productId: string;
  let quote: Quote;

  beforeAll(async () => {
    const artworkId = await renderReadyArtwork(world, shopA, 41);
    ({ productId, quote } = await createPodProduct(world, shopA, {
      artworkId,
      name: "POD tee",
      priceMinor: 39_900,
      sku: "V-POD",
    }));
    const published = await publishProduct(world, shopA, productId);
    if (published.product.screeningStatus === "pending") {
      await approveProduct(world, productId);
    }
    expect(quote.priceFloorMinor).toBeLessThan(39_900);
  });

  it("a new active variant under the floor is refused (422) and nothing is written", async () => {
    const version = await catalogVersion(shopA.tenantId);
    const response = await admin(shopA, "POST", `/v1/admin/products/${productId}/variants`, {
      label: "Cheap",
      priceMinor: quote.priceFloorMinor - 1,
      sku: "V-POD-CHEAP",
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "price_below_floor" } });
    expect(await catalogVersion(shopA.tenantId)).toBe(version);
    expect(
      await env.DB.prepare("SELECT 1 FROM product_variants WHERE sku = 'V-POD-CHEAP'").first(),
    ).toBeNull();
  });

  it("at the floor a variant is created; lowering it under the floor is refused, raising it is not", async () => {
    const atFloor = await addVariant(shopA, productId, {
      label: "Floor",
      priceMinor: quote.priceFloorMinor,
      sku: "V-POD-FLOOR",
    });
    const lower = await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${atFloor.variantId}`, {
      priceMinor: quote.priceFloorMinor - 1,
    });
    expect(lower.status).toBe(422);
    await expect(lower.json()).resolves.toMatchObject({ error: { code: "price_below_floor" } });
    expect(await variantRow(atFloor.variantId)).toMatchObject({ price_minor: quote.priceFloorMinor });

    await expectJson(
      await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${atFloor.variantId}`, {
        priceMinor: quote.priceFloorMinor + 500,
      }),
      200,
      "raise",
    );
    await expectJson(
      await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${atFloor.variantId}`, {
        priceMinor: quote.priceFloorMinor + 100,
      }),
      200,
      "lower, still above the floor",
    );
  });

  it("an inactive variant may sit under the floor; activating it there is refused", async () => {
    const spare = await addVariant(shopA, productId, {
      active: false,
      label: "Spare",
      priceMinor: 1,
      sku: "V-POD-SPARE",
    });
    const activate = await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${spare.variantId}`, {
      active: true,
    });
    expect(activate.status).toBe(422);
    await activate.body?.cancel();
    expect(await variantRow(spare.variantId)).toMatchObject({ active: 0 });
    await expectJson(
      await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${spare.variantId}`, {
        active: true,
        priceMinor: quote.priceFloorMinor,
      }),
      200,
      "activate at the floor",
    );
  });

  it("a POD product that is not live is not gated (its next publish is)", async () => {
    await expectJson(await admin(shopA, "POST", `/v1/admin/products/${productId}/unpublish`), 200, "unpublish");
    await addVariant(shopA, productId, { label: "Offline cheap", priceMinor: 1, sku: "V-POD-OFF" });
    const republish = await admin(shopA, "POST", `/v1/admin/products/${productId}/publish`);
    expect(republish.status).toBe(422);
    await expect(republish.json()).resolves.toMatchObject({ error: { code: "price_below_floor" } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("THE FENCE: a platform decision racing a variant write", () => {
  /** A D1 handle whose batch() first lets something else commit (screening.test.ts's seam). */
  function racingDb(onBatch: (attempt: number) => Promise<void>): { calls: () => number; db: D1Database } {
    let attempt = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            attempt += 1;
            await onBatch(attempt);
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    return { calls: () => attempt, db };
  }

  const count = async (action: string, productId: string) =>
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = ? AND resource_id = ?")
        .bind(action, productId)
        .first<{ n: number }>()
    )?.n;

  it("an approval between the write's reads and its batch: the write is re-run once and screened anew", async () => {
    const productId = await liveProduct(shopA, { name: "Race hoodie", sku: "V-RACE" });
    const racing = racingDb(async (attempt) => {
      if (attempt === 1) {
        await decideByPlatform(env.DB, PLATFORM, productId, "approved", Date.now());
      }
    });
    const result = await createProductVariant(racing.db, adminOf(shopA.tenantId, shopA.adminUserId), productId, {
      active: true,
      group: null,
      label: "Quorvak",
      position: null,
      priceMinor: 100,
      size: null,
      sku: "V-RACE-1",
    }, Date.now());
    expect(result.status).toBe("ok");
    expect(racing.calls()).toBe(2);
    // The approval landed first; the variant's new term is one the approval
    // never saw, so the re-run blocks. One variant, one audit row.
    const row = await env.DB.prepare("SELECT status, hits_json FROM product_screening WHERE product_id = ?")
      .bind(productId)
      .first();
    expect(row).toEqual({ hits_json: '["quorvak"]', status: "blocked" });
    expect(await count("product.variant_create", productId)).toBe(1);
    expect(await count("screening.approve", productId)).toBe(1);
  });

  it("a decision that keeps racing: 409 and nothing of the write commits", async () => {
    const productId = await liveProduct(shopA, { name: "Race hoodie 2", sku: "V-RACE-2" });
    const variantId = await addVariant(shopA, productId, { label: "Stay", priceMinor: 100, sku: "V-RACE-2-S" }).then((v) => v.variantId);
    const racing = racingDb(async () => {
      await decideByPlatform(env.DB, PLATFORM, productId, "approved", Date.now());
    });
    await expect(
      deleteProductVariant(racing.db, adminOf(shopA.tenantId, shopA.adminUserId), productId, variantId, Date.now()),
    ).resolves.toEqual({ code: "conflict", status: "conflict" });
    expect(await variantRow(variantId)).toMatchObject({ active: 1, label: "Stay" });
    expect(await count("product.variant_delete", productId)).toBe(0);
  });
});
