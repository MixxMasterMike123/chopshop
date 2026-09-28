import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { addressSlug, productHandle, productPath } from "../src/catalog/admin-catalog";
import { decodeDisplayCursor, encodeDisplayCursor } from "../src/catalog/admin-product-reads";
import { readScreeningGuard, screeningStatementsFor } from "../src/catalog/screening";
import { productScreeningTexts } from "../src/catalog/screening-core";
import {
  ADMIN,
  approveProduct,
  call,
  type CallOptions,
  createTenant,
  publishProduct,
} from "./slice-harness";
import {
  auditRows,
  expectJson,
  expectOpaque404,
  SliceWorld,
  type Tenant,
  tenantRow,
  tenantWorld,
} from "./tenant-fixtures";

/**
 * CP4-A — products: the storefront fields of create and update, the address
 * rule (the handle), the admin list and read, the display order, the public
 * list (filters, order, keyset cursor) and the public read by id, handle or
 * the source system's sku rule. Variants: test/product-variants.test.ts.
 * Images: test/product-images.test.ts.
 *
 * Refusals first (rule 9), then the happy paths. Every shop, admin and
 * session comes from the real routes (tenant-fixtures.ts); products that only
 * need to BE public are seeded as rows (no screening row = advisory).
 */

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;

const NOW = Date.now();

interface AdminProductBody {
  product: Record<string, unknown> & { handle: string; productId: string; tags: string[] };
}

interface PublicListBody {
  nextCursor: string | null;
  products: Array<Record<string, unknown> & { productId: string }>;
}

function admin(
  tenant: Tenant,
  method: string,
  path: string,
  body?: unknown,
  options: CallOptions = {},
): Promise<Response> {
  return call(world, method, `${ADMIN}${path}`, {
    body,
    cookie: tenant.adminCookie,
    shopId: tenant.tenantId,
    ...options,
  });
}

function storefront(tenant: Tenant, path: string, headers?: Record<string, string>): Promise<Response> {
  return call(world, "GET", `${tenant.origin}${path}`, { headers });
}

async function createProduct(tenant: Tenant, body: Record<string, unknown>): Promise<AdminProductBody["product"]> {
  const created = await expectJson<AdminProductBody>(
    await admin(tenant, "POST", "/v1/admin/products", { currency: "SEK", priceMinor: 10_000, ...body }),
    201,
    `create ${String(body.sku)}`,
  );
  return created.product;
}

async function patchProduct(tenant: Tenant, productId: string, body: unknown): Promise<Response> {
  return admin(tenant, "PATCH", `/v1/admin/products/${encodeURIComponent(productId)}`, body);
}

/** Created, activated and published through the routes; approved when D8 holds it. */
async function liveProduct(tenant: Tenant, body: Record<string, unknown>): Promise<string> {
  const product = await createProduct(tenant, body);
  await expectJson(await patchProduct(tenant, product.productId, { status: "active" }), 200, "activate");
  const published = await publishProduct(world, tenant, product.productId);
  if (published.product.screeningStatus === "pending") {
    await approveProduct(world, product.productId);
  }
  return product.productId;
}

interface SeedSpec {
  category?: string;
  featured?: boolean;
  name: string;
  productId: string;
  published?: boolean;
  sortOrder?: number | null;
  status?: "active" | "archived" | "draft";
  tags?: string[];
}

/** A product row + its publication, as an importer writes them (no screening row: advisory). */
async function seedProduct(tenantId: string, spec: SeedSpec): Promise<void> {
  const statements = [
    env.DB.prepare(
      `INSERT INTO products (
         product_id, tenant_id, status, sku, name, description, b2c_price_minor, currency,
         is_pod, created_at, updated_at, handle, featured, sort_order, category, category_key
       ) VALUES (?, ?, ?, ?, ?, NULL, 9900, 'SEK', 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      spec.productId,
      tenantId,
      spec.status ?? "active",
      `SKU-${spec.productId}`,
      spec.name,
      NOW,
      NOW,
      productHandle(spec.name, null, `SKU-${spec.productId}`),
      spec.featured === true ? 1 : 0,
      spec.sortOrder ?? null,
      spec.category ?? null,
      spec.category === undefined ? null : addressSlug(spec.category),
    ),
    env.DB.prepare(
      `INSERT INTO product_publications (
         product_id, tenant_id, published, public_name, public_description,
         public_price_minor, currency, projection_version, published_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, 9900, 'SEK', 1, ?, ?)`,
    ).bind(spec.productId, tenantId, spec.published === false ? 0 : 1, spec.name, NOW, NOW),
    ...(spec.tags ?? []).map((tag, position) =>
      env.DB.prepare(
        `INSERT INTO product_tags (tenant_id, product_id, tag_key, tag, position)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(tenantId, spec.productId, addressSlug(tag), tag, position),
    ),
  ];
  await env.DB.batch(statements);
}

async function catalogVersion(tenantId: string): Promise<number> {
  return (await tenantRow(tenantId))?.catalog_version ?? -1;
}

async function productColumns(productId: string) {
  return env.DB.prepare(
    `SELECT handle, featured, sort_order, category, category_key, more_info, size_guide,
            size, brand, ean_code, stock, launch_date, is_personalized, compare_at_price_minor
     FROM products WHERE product_id = ?`,
  )
    .bind(productId)
    .first<Record<string, unknown>>();
}

async function tagRows(productId: string) {
  const rows = await env.DB.prepare(
    "SELECT tag, tag_key, position FROM product_tags WHERE product_id = ? ORDER BY position",
  )
    .bind(productId)
    .all<{ position: number; tag: string; tag_key: string }>();
  return rows.results;
}

/** One more shop in this file's world (the platform is bootstrapped once per file). */
async function extraShop(tenantId: string): Promise<Tenant> {
  return createTenant(world, {
    host: `${tenantId}.shops.cp4a.test`,
    legallyReady: false,
    shopName: `Butik ${tenantId}`,
    tenantId,
  });
}

beforeAll(async () => {
  const shops = await tenantWorld("cp4a", 2);
  world = shops.world;
  [shopA, shopB] = shops.tenants as [Tenant, Tenant];
  // D8: a shop's first two products wait for the platform. Each shop starts
  // with two live products, so a product published here goes public at once.
  for (const tenant of [shopA, shopB]) {
    await seedProduct(tenant.tenantId, { name: "Zz seed one", productId: `${tenant.tenantId}-seed-1`, sortOrder: 900 });
    await seedProduct(tenant.tenantId, { name: "Zz seed two", productId: `${tenant.tenantId}-seed-2`, sortOrder: 901 });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the address rule (the source system's slugify, pinned for the importer)", () => {
  it.each([
    ["Vitlökssill (300g)", "vitlokssill-300g"],
    ["  Trimmed  Name  ", "trimmed-name"],
    ["Räkor & Sill", "rakor-and-sill"],
    ["Åsa's Öl", "asas-ol"],
    ["ÅÄÖ", "aao"],
    ["Crème brûlée", "crme-brle"],
    ["a_b", "a_b"],
    ["--x--", "-x-"],
    ["Hoodie – Svart", "hoodie-svart"],
    ["!!!", ""],
  ])("slugify(%j) = %j", (input, expected) => {
    expect(addressSlug(input)).toBe(expected);
  });

  it("builds the handle as slugify(name size) + '_' + sku, a '/' in the sku becoming '-'", () => {
    expect(productHandle("Minbutik Vasskydd", "6", "ABC-6-GL")).toBe("minbutik-vasskydd-6_ABC-6-GL");
    expect(productHandle("Tee", null, "tee-1")).toBe("tee_tee-1");
    expect(productHandle("!!!", null, "X")).toBe("_X");
    expect(productHandle("Tee", null, "A/B")).toBe("tee_A-B");
    expect(productPath("tee_A B(1)")).toBe("/product/tee_A%20B%281%29");
  });

  it("round-trips the display cursor and refuses every other spelling", () => {
    const cursor = { id: "p-1", name: "Åsa's tee", sortOrder: 3 };
    const encoded = encodeDisplayCursor(cursor);
    expect(decodeDisplayCursor(encoded)).toEqual(cursor);
    expect(decodeDisplayCursor(encodeDisplayCursor({ ...cursor, sortOrder: null }))).toEqual({
      ...cursor,
      sortOrder: null,
    });
    for (const bad of ["", "%%%", `${encoded}=`, "WzEsMiwzXQ", btoa('[1.5,"a","b"]'), "a".repeat(2_000)]) {
      expect(decodeDisplayCursor(bad), bad.slice(0, 20)).toBeNull();
    }
  });

  it("screens the further texts after the texts of before (a product with none keeps its haystack)", () => {
    expect(productScreeningTexts({ description: "<p>Soft</p>", name: "Tee" }, ["art.png"])).toEqual([
      "Tee",
      " Soft ",
      "art.png",
    ]);
    expect(
      productScreeningTexts({
        brand: "Brand",
        category: "Kat",
        description: null,
        imageAlts: ["alt"],
        moreInfo: "<b>More</b>",
        name: "Tee",
        size: "XL",
        sizeGuide: "Guide",
        tags: ["tag"],
        variantTexts: ["Svart", "M"],
      }),
    ).toEqual(["Tee", " More ", "Guide", "Kat", "tag", "Brand", "XL", "Svart", "M", "alt"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("refusals on every new admin route", () => {
  let productId: string;

  beforeAll(async () => {
    productId = (await createProduct(shopA, { name: "Refusal tee", sku: "REF-TEE" })).productId;
  });

  const routes = (id: string): Array<[string, string, unknown]> => [
    ["GET", "/v1/admin/products", undefined],
    ["GET", `/v1/admin/products/${id}`, undefined],
    ["PUT", "/v1/admin/products/order", [{ productId: id, sortOrder: 1 }]],
    ["POST", `/v1/admin/products/${id}/variants`, { label: "M", priceMinor: 100, sku: "REF-M" }],
    ["PATCH", `/v1/admin/products/${id}/variants/nope`, { label: "L" }],
    ["DELETE", `/v1/admin/products/${id}/variants/nope`, undefined],
    ["PUT", `/v1/admin/products/${id}/images`, []],
  ];

  it("no session: the opaque 404 on every route", async () => {
    for (const [method, path, body] of routes(productId)) {
      await expectOpaque404(await call(world, method, `${ADMIN}${path}`, { body }), `${method} ${path}`);
    }
  });

  it("a platform session without an acting-as grant, and a shop's admin naming another shop: 404", async () => {
    for (const [method, path, body] of routes(productId)) {
      await expectOpaque404(
        await call(world, method, `${ADMIN}${path}`, { body, cookie: world.platformCookie, shopId: shopA.tenantId }),
        `platform ${method} ${path}`,
      );
      await expectOpaque404(
        await call(world, method, `${ADMIN}${path}`, { body, cookie: shopB.adminCookie, shopId: shopA.tenantId }),
        `B as A ${method} ${path}`,
      );
    }
  });

  it("another shop's product is not found for this shop's admin, and nothing is written", async () => {
    const version = await catalogVersion(shopA.tenantId);
    for (const [method, path, body] of routes(productId).slice(1)) {
      const response = await admin(shopB, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(404);
      await response.body?.cancel();
    }
    expect(await catalogVersion(shopA.tenantId)).toBe(version);
    const listed = await expectJson<{ products: Array<{ productId: string }> }>(
      await admin(shopB, "GET", "/v1/admin/products"),
      200,
      "B's list",
    );
    expect(listed.products.map((p) => p.productId)).not.toContain(productId);
  });

  it("a state change from a foreign origin: 404 before the body is read, nothing written", async () => {
    const version = await catalogVersion(shopA.tenantId);
    for (const [method, path, body] of routes(productId).filter(([m]) => m !== "GET")) {
      await expectOpaque404(
        await admin(shopA, method, path, body, { origin: "https://evil.example" }),
        `${method} ${path}`,
      );
      await expectOpaque404(await admin(shopA, method, path, body, { origin: null }), `no origin ${method} ${path}`);
    }
    expect(await catalogVersion(shopA.tenantId)).toBe(version);
  });

  it("a method a route does not own falls through to the 404", async () => {
    for (const [method, path] of [
      ["DELETE", "/v1/admin/products"],
      ["POST", "/v1/admin/products/order"],
      ["DELETE", `/v1/admin/products/${productId}`],
      ["GET", `/v1/admin/products/${productId}/variants`],
      ["POST", `/v1/admin/products/${productId}/images`],
      ["GET", `/v1/admin/products/${productId}/images`],
      ["PUT", `/v1/admin/products/${productId}/variants/x`],
    ] as const) {
      const response = await admin(shopA, method, path, method === "GET" ? undefined : {});
      expect(response.status, `${method} ${path}`).toBe(404);
      await response.body?.cancel();
    }
  });

  it("a malformed id segment is the 404", async () => {
    for (const path of [
      "/v1/admin/products/a%2Fb",
      `/v1/admin/products/${"x".repeat(129)}`,
      "/v1/admin/products/%E0%A4%A",
      `/v1/admin/products/${productId}/`,
      `/v1/admin/products/${productId}/variants/a%2Fb`,
    ]) {
      const response = await admin(shopA, "GET", path);
      expect(response.status, path).toBe(404);
      await response.body?.cancel();
    }
  });

  it("over a cap, or a body that is not the shape: 400 with nothing written", async () => {
    const version = await catalogVersion(shopA.tenantId);
    const tooMany = Array.from({ length: 201 }, (_, index) => ({ productId: `p-${index}`, sortOrder: index }));
    for (const [method, path, body] of [
      ["PUT", "/v1/admin/products/order", tooMany],
      ["PUT", "/v1/admin/products/order", []],
      ["PUT", "/v1/admin/products/order", [{ productId, sortOrder: 1 }, { productId, sortOrder: 2 }]],
      ["PUT", "/v1/admin/products/order", [{ productId, sortOrder: 1.5 }]],
      ["PUT", "/v1/admin/products/order", [{ productId }]],
      ["PUT", "/v1/admin/products/order", { products: [] }],
      ["PATCH", `/v1/admin/products/${productId}`, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
      ["PATCH", `/v1/admin/products/${productId}`, { tags: ["Nyhet", "nyhet"] }],
      ["PATCH", `/v1/admin/products/${productId}`, { tags: ["x".repeat(51)] }],
      ["PATCH", `/v1/admin/products/${productId}`, { tags: ["!!!"] }],
      ["PATCH", `/v1/admin/products/${productId}`, { tags: "Nyhet" }],
      ["PATCH", `/v1/admin/products/${productId}`, { category: "!!!" }],
      ["PATCH", `/v1/admin/products/${productId}`, { category: "c".repeat(101) }],
      ["PATCH", `/v1/admin/products/${productId}`, { launchDate: "2026-02-30" }],
      ["PATCH", `/v1/admin/products/${productId}`, { launchDate: "2026-2-3" }],
      ["PATCH", `/v1/admin/products/${productId}`, { stock: -1 }],
      ["PATCH", `/v1/admin/products/${productId}`, { stock: 1_000_000_001 }],
      ["PATCH", `/v1/admin/products/${productId}`, { compareAtPriceMinor: 100_000_001 }],
      ["PATCH", `/v1/admin/products/${productId}`, { featured: "true" }],
      ["PATCH", `/v1/admin/products/${productId}`, { sortOrder: 2_000_000_000 }],
      ["PATCH", `/v1/admin/products/${productId}`, { brand: "a\u0000b" }],
      ["PATCH", `/v1/admin/products/${productId}`, { moreInfo: "m".repeat(20_001) }],
      ["PATCH", `/v1/admin/products/${productId}`, { handle: "chosen" }],
      ["GET", "/v1/admin/products?limit=0", undefined],
      ["GET", "/v1/admin/products?limit=101", undefined],
      ["GET", "/v1/admin/products?status=live", undefined],
      ["GET", "/v1/admin/products?cursor=nope", undefined],
      ["GET", "/v1/admin/products?q=", undefined],
      ["GET", "/v1/admin/products?page=2", undefined],
      ["GET", "/v1/admin/products?limit=5&limit=6", undefined],
    ] as const) {
      const response = await admin(shopA, method, path, body);
      expect(response.status, `${method} ${path} ${JSON.stringify(body)?.slice(0, 60)}`).toBe(400);
      await response.body?.cancel();
    }
    expect(await catalogVersion(shopA.tenantId)).toBe(version);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("create and update carry the storefront fields", () => {
  it("refuses what a seller may not write: the personalised flag, and HTML that can run", async () => {
    const product = await createProduct(shopA, { name: "Plain mug", sku: "PLAIN-REFUSE" });
    for (const [label, patch] of [
      // D46: the flag takes a buyer's right of withdrawal away; only the
      // studio's buyer flow sets it.
      ["the personalised flag", { isPersonalized: true }],
      ["a script in the further description", { moreInfo: "<p>Info</p><script>alert(1)</script>" }],
      ["an event attribute in the further description", { moreInfo: '<p onclick="x()">Info</p>' }],
    ] as const) {
      const response = await patchProduct(shopA, product.productId, patch);
      expect(await expectJson(response, 400, label)).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(await productColumns(product.productId)).toMatchObject({ is_personalized: 0, more_info: null });
  });

  it("writes every field, derives the handle and the address keys, and reads them back", async () => {
    const product = await createProduct(shopA, {
      brand: "Nord",
      category: "Rökt Fisk",
      compareAtPriceMinor: 12_900,
      description: "Kort",
      eanCode: "7350000000001",
      featured: true,
      launchDate: "2027-01-15",
      moreInfo: "<p>Mer\ninformation</p>",
      name: "Rökt Lax",
      size: "300 g",
      sizeGuide: "Rad ett\nRad två",
      sku: "LAX-300",
      sortOrder: 5,
      stock: 12,
      tags: [" Nyhet ", "Sommar 2026"],
    });
    expect(product).toMatchObject({
      brand: "Nord",
      category: "Rökt Fisk",
      compareAtPriceMinor: 12_900,
      eanCode: "7350000000001",
      featured: true,
      handle: "rokt-lax-300-g_LAX-300",
      // D46: a seller cannot make a product personalised.
      isPersonalized: false,
      launchDate: "2027-01-15",
      moreInfo: "<p>Mer\ninformation</p>",
      size: "300 g",
      sizeGuide: "Rad ett\nRad två",
      sortOrder: 5,
      stock: 12,
      tags: ["Nyhet", "Sommar 2026"],
    });
    expect(await productColumns(product.productId)).toMatchObject({
      category_key: "rokt-fisk",
      handle: "rokt-lax-300-g_LAX-300",
      is_personalized: 0,
    });
    expect(await tagRows(product.productId)).toEqual([
      { position: 0, tag: "Nyhet", tag_key: "nyhet" },
      { position: 1, tag: "Sommar 2026", tag_key: "sommar-2026" },
    ]);

    const read = await expectJson<{ product: Record<string, unknown> }>(
      await admin(shopA, "GET", `/v1/admin/products/${product.productId}`),
      200,
      "read",
    );
    expect(read.product).toEqual(product);
  });

  it("an absent key leaves a field alone, null or '' clears it, and the handle follows the name, size and sku", async () => {
    const product = await createProduct(shopA, {
      brand: "Keep",
      category: "Kat",
      name: "Handle Tee",
      sku: "HT-1",
      tags: ["a"],
    });
    expect(product.handle).toBe("handle-tee_HT-1");

    const unchanged = await expectJson<AdminProductBody>(
      await patchProduct(shopA, product.productId, { featured: true }),
      200,
      "featured only",
    );
    expect(unchanged.product).toMatchObject({ brand: "Keep", category: "Kat", handle: "handle-tee_HT-1", tags: ["a"] });

    const renamed = await expectJson<AdminProductBody>(
      await patchProduct(shopA, product.productId, { brand: "", category: null, name: "Döpt Om", size: "XL", tags: [] }),
      200,
      "rename",
    );
    expect(renamed.product).toMatchObject({ brand: null, category: null, handle: "dopt-om-xl_HT-1", tags: [] });
    expect(await productColumns(product.productId)).toMatchObject({ category: null, category_key: null });
    expect(await tagRows(product.productId)).toEqual([]);

    const resku = await expectJson<AdminProductBody>(
      await patchProduct(shopA, product.productId, { sku: "HT/2" }),
      200,
      "sku",
    );
    expect(resku.product.handle).toBe("dopt-om-xl_HT-2");
  });

  it("two products whose names and skus make one handle: the second write is a 409", async () => {
    // "clash_x" + "_" + "y" and "clash" + "_" + "x_y": one address.
    expect((await createProduct(shopA, { name: "Clash_x", sku: "y" })).handle).toBe("clash_x_y");
    const response = await admin(shopA, "POST", "/v1/admin/products", {
      currency: "SEK",
      name: "Clash",
      priceMinor: 100,
      sku: "x_y",
    });
    expect(response.status).toBe(409);
    await response.body?.cancel();
    // One shop's handle does not collide with another's.
    await createProduct(shopB, { name: "Clash_x", sku: "y" });
  });

  it("a tag write changes the ETag of the public reads, and the audit names the fields", async () => {
    const productId = await liveProduct(shopA, { name: "Etag tee", sku: "ETAG-1" });
    const first = await storefront(shopA, `/v1/products/${productId}`);
    const etag = first.headers.get("etag");
    expect(first.status).toBe(200);
    await first.body?.cancel();

    await expectJson(await patchProduct(shopA, productId, { tags: ["Ny"] }), 200, "tags");
    const again = await storefront(shopA, `/v1/products/${productId}`, { "if-none-match": etag ?? "" });
    expect(again.status).toBe(200);
    const body = await again.json<{ product: { tags: string[] } }>();
    expect(body.product.tags).toEqual(["Ny"]);
    expect(again.headers.get("etag")).not.toBe(etag);

    const audits = (await auditRows(shopA.tenantId, "product.update")).filter((row) => row.resourceId === productId);
    expect(audits.at(-1)?.metadata).toEqual({ fields: ["tags"] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("every new public text is screened (THE FENCE, as a product edit)", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO content_screening_terms (term, kind, hard_block, created_at) VALUES ('grimwald', 'brand', 1, ?)",
    )
      .bind(new Date().toISOString())
      .run();
  });

  it.each([
    ["a tag", { tags: ["Grimwald"] }],
    ["the category", { category: "Grimwald" }],
    ["the further description", { moreInfo: "<p>by <b>Grimwald</b></p>" }],
    ["the size guide", { sizeGuide: "Grimwald sizes" }],
    ["the brand", { brand: "Grimwald" }],
    ["the size", { size: "Grimwald" }],
  ])("%s with a hard-blocked term takes a live product off the storefront", async (label, patch) => {
    const productId = await liveProduct(shopA, { name: `Screen ${label}`, sku: `SCR-${addressSlug(label)}` });
    expect((await storefront(shopA, `/v1/products/${productId}`)).status).toBe(200);

    const edited = await expectJson<AdminProductBody>(await patchProduct(shopA, productId, patch), 200, label);
    expect(edited.product.screeningStatus).toBe("blocked");
    expect((await storefront(shopA, `/v1/products/${productId}`)).status).toBe(404);
    const row = await env.DB.prepare("SELECT status, hits_json FROM product_screening WHERE product_id = ?")
      .bind(productId)
      .first<{ hits_json: string; status: string }>();
    expect(row).toEqual({ hits_json: '["grimwald"]', status: "blocked" });
  });

  it("a screening that is handed no texts (the sweep, a mapping change) reads the further texts too", async () => {
    const productId = await liveProduct(shopA, { name: "Sweep mug", sku: "SCR-SWEEP" });
    // Written past the routes, as an import or an older row would hold it.
    await env.DB.prepare(
      "INSERT INTO product_tags (tenant_id, product_id, tag_key, tag, position) VALUES (?, ?, 'grimwald', 'Grimwald', 0)",
    )
      .bind(shopA.tenantId, productId)
      .run();

    const guard = await readScreeningGuard(env.DB, shopA.tenantId, productId);
    const screening = await screeningStatementsFor(env.DB, { guard, now: Date.now() });
    await env.DB.batch(screening.statements);

    expect(screening.status).toBe("blocked");
    expect((await storefront(shopA, `/v1/products/${productId}`)).status).toBe(404);
  });

  it("a publish screens the further texts too", async () => {
    const product = await createProduct(shopA, { name: "Quiet mug", sku: "QUIET-1", tags: ["Grimwald"] });
    await expectJson(await patchProduct(shopA, product.productId, { status: "active" }), 200, "activate");
    const published = await publishProduct(world, shopA, product.productId);
    expect(published.product.screeningStatus).toBe("blocked");
    expect((await storefront(shopA, `/v1/products/${product.productId}`)).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/admin/products and /v1/admin/products/:id", () => {
  const shop = () => shopB;

  beforeAll(async () => {
    const tenantId = shopB.tenantId;
    await seedProduct(tenantId, { name: "alpha one", productId: "adm-1", sortOrder: 2, status: "draft", published: false });
    await seedProduct(tenantId, { name: "Beta two", productId: "adm-2", sortOrder: 1 });
    await seedProduct(tenantId, { name: "gamma_three", productId: "adm-3", status: "archived", published: false });
    await seedProduct(tenantId, { name: "Delta 100%", productId: "adm-4" });
  });

  it("lists the shop's products in the display order with their publication state", async () => {
    const body = await expectJson<{ nextCursor: string | null; products: Array<Record<string, unknown>> }>(
      await admin(shop(), "GET", "/v1/admin/products?limit=100"),
      200,
      "list",
    );
    const ids = body.products.map((p) => p.productId);
    // sort_order first (1, 2, then the seeds' 900/901), then the rest by name.
    expect(ids.slice(0, 2)).toEqual(["adm-2", "adm-1"]);
    expect(ids.indexOf("adm-4")).toBeLessThan(ids.indexOf("adm-3"));
    expect(body.products.find((p) => p.productId === "adm-1")).toMatchObject({
      handle: "alpha-one_SKU-adm-1",
      image: null,
      published: false,
      screeningStatus: null,
      sortOrder: 2,
      status: "draft",
      takenDown: false,
    });
    expect(body.products.find((p) => p.productId === "adm-2")).toMatchObject({ published: true, status: "active" });
    expect(body.nextCursor).toBeNull();
  });

  it("filters by status and by a name or sku prefix (case-insensitive, wildcards are literal)", async () => {
    const byStatus = await expectJson<{ products: Array<{ productId: string }> }>(
      await admin(shop(), "GET", "/v1/admin/products?status=archived"),
      200,
      "status",
    );
    expect(byStatus.products.map((p) => p.productId)).toEqual(["adm-3"]);
    const byName = await expectJson<{ products: Array<{ productId: string }> }>(
      await admin(shop(), "GET", "/v1/admin/products?q=BETA"),
      200,
      "q name",
    );
    expect(byName.products.map((p) => p.productId)).toEqual(["adm-2"]);
    const bySku = await expectJson<{ products: Array<{ productId: string }> }>(
      await admin(shop(), "GET", "/v1/admin/products?q=sku-adm-4"),
      200,
      "q sku",
    );
    expect(bySku.products.map((p) => p.productId)).toEqual(["adm-4"]);
    for (const literal of ["%", "gamma%", "_"]) {
      const none = await expectJson<{ products: Array<{ productId: string }> }>(
        await admin(shop(), "GET", `/v1/admin/products?q=${encodeURIComponent(literal)}`),
        200,
        `q ${literal}`,
      );
      expect(none.products, literal).toEqual([]);
    }
    const underscore = await expectJson<{ products: Array<{ productId: string }> }>(
      await admin(shop(), "GET", `/v1/admin/products?q=${encodeURIComponent("gamma_")}`),
      200,
      "q gamma_",
    );
    expect(underscore.products.map((p) => p.productId)).toEqual(["adm-3"]);
  });

  it("walks every product with the cursor, one page at a time, without a gap or a repeat", async () => {
    const all = await expectJson<{ products: Array<{ productId: string }> }>(
      await admin(shop(), "GET", "/v1/admin/products?limit=100"),
      200,
      "all",
    );
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
      const body: { nextCursor: string | null; products: Array<{ productId: string }> } = await expectJson(
        await admin(shop(), "GET", `/v1/admin/products${query}`),
        200,
        `page ${page}`,
      );
      walked.push(...body.products.map((p) => p.productId));
      cursor = body.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(walked).toEqual(all.products.map((p) => p.productId));
  });

  it("reads one product with its publication, variants and images", async () => {
    const body = await expectJson<Record<string, unknown>>(
      await admin(shop(), "GET", "/v1/admin/products/adm-2"),
      200,
      "read",
    );
    expect(body).toMatchObject({
      images: [],
      product: { handle: "beta-two_SKU-adm-2", productId: "adm-2", sortOrder: 1, tags: [] },
      publication: { published: true, publishedAt: new Date(NOW).toISOString() },
      variants: [],
      variantsTruncated: false,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("PUT /v1/admin/products/order", () => {
  it("sets every named product's place in one batch, audited", async () => {
    const one = await createProduct(shopA, { name: "Order one", sku: "ORD-1" });
    const two = await createProduct(shopA, { name: "Order two", sku: "ORD-2", sortOrder: 7 });
    const body = await expectJson<{ products: Array<{ productId: string; sortOrder: number | null }> }>(
      await admin(shopA, "PUT", "/v1/admin/products/order", [
        { productId: two.productId, sortOrder: null },
        { productId: one.productId, sortOrder: -3 },
      ]),
      200,
      "order",
    );
    expect(body.products).toEqual([
      { productId: two.productId, sortOrder: null },
      { productId: one.productId, sortOrder: -3 },
    ]);
    expect((await productColumns(one.productId))?.sort_order).toBe(-3);
    expect((await productColumns(two.productId))?.sort_order).toBeNull();
    const audit = (await auditRows(shopA.tenantId, "product.reorder")).at(-1);
    expect(audit?.metadata).toEqual({ entries: body.products });
  });

  it("one product that is not this shop's: 404 and nothing moves", async () => {
    const mine = await createProduct(shopA, { name: "Order three", sku: "ORD-3", sortOrder: 4 });
    const theirs = await createProduct(shopB, { name: "Order theirs", sku: "ORD-B", sortOrder: 4 });
    await expectOpaque404(
      await admin(shopA, "PUT", "/v1/admin/products/order", [
        { productId: mine.productId, sortOrder: 99 },
        { productId: theirs.productId, sortOrder: 99 },
      ]),
      "foreign product",
    );
    expect((await productColumns(mine.productId))?.sort_order).toBe(4);
    expect((await productColumns(theirs.productId))?.sort_order).toBe(4);
  });

  it("an edit that does not name the place never writes an older one back", async () => {
    const product = await createProduct(shopA, { name: "Order four", sku: "ORD-4", sortOrder: 1 });
    await expectJson(
      await admin(shopA, "PUT", "/v1/admin/products/order", [{ productId: product.productId, sortOrder: 50 }]),
      200,
      "order",
    );
    await expectJson(await patchProduct(shopA, product.productId, { name: "Order four b" }), 200, "rename");
    expect((await productColumns(product.productId))?.sort_order).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/products — filters, order, cursor", () => {
  let shopC: Tenant;
  const otherWorld = () => world;

  beforeAll(async () => {
    shopC = await extraShop("cp4a-list");
    const tenantId = shopC.tenantId;
    await seedProduct(tenantId, { category: "Rökt fisk", name: "Böckling", productId: "l-1", tags: ["Nyhet"] });
    await seedProduct(tenantId, { featured: true, name: "anchovis", productId: "l-2", sortOrder: 2 });
    await seedProduct(tenantId, { category: "Rökt Fisk", featured: true, name: "Ål", productId: "l-3", sortOrder: 1, tags: ["nyhet", "Sommar"] });
    await seedProduct(tenantId, { category: "Rökt fisk", name: "Draft fish", productId: "l-4", status: "draft", tags: ["Nyhet"] });
    await seedProduct(tenantId, { name: "Hidden", productId: "l-5", published: false, featured: true });
    await seedProduct(tenantId, { name: "Cod", productId: "l-6" });
  });

  const list = async (query = ""): Promise<PublicListBody> =>
    expectJson<PublicListBody>(
      await call(otherWorld(), "GET", `${shopC.origin}/v1/products${query}`),
      200,
      `list ${query}`,
    );

  it("orders by the admin's place, NULL last, then the name (case-insensitive), then the id", async () => {
    const body = await list();
    expect(body.products.map((p) => p.productId)).toEqual(["l-3", "l-2", "l-1", "l-6"]);
    expect(body.nextCursor).toBeNull();
  });

  it("filters by a tag's and a category's address form, and by featured; drafts and hidden products never match", async () => {
    expect((await list("?tag=nyhet")).products.map((p) => p.productId)).toEqual(["l-3", "l-1"]);
    expect((await list("?tag=sommar")).products.map((p) => p.productId)).toEqual(["l-3"]);
    expect((await list("?category=rokt-fisk")).products.map((p) => p.productId)).toEqual(["l-3", "l-1"]);
    expect((await list("?featured=1")).products.map((p) => p.productId)).toEqual(["l-3", "l-2"]);
    expect((await list("?featured=1&category=rokt-fisk&tag=sommar")).products.map((p) => p.productId)).toEqual(["l-3"]);
    expect((await list("?tag=nothing")).products).toEqual([]);
    const summary = (await list("?tag=sommar")).products[0];
    expect(summary).toMatchObject({
      category: "Rökt Fisk",
      featured: true,
      handle: "al_SKU-l-3",
      path: "/product/al_SKU-l-3",
      sortOrder: 1,
      tags: ["nyhet", "Sommar"],
    });
  });

  it("refuses a malformed query with 400", async () => {
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=abc",
      "?featured=0",
      "?featured=true",
      "?cursor=xyz",
      "?tag=",
      "?category=",
      "?sort=name",
      "?tag=a&tag=b",
      `?tag=${"t".repeat(251)}`,
    ]) {
      const response = await call(otherWorld(), "GET", `${shopC.origin}/v1/products${query}`);
      expect(response.status, query).toBe(400);
      await response.body?.cancel();
    }
  });

  it("walks 250 products with the cursor, no gap and no repeat, while one is unpublished in between", async () => {
    const walkShop = await extraShop("cp4a-walk");
    const ids: string[] = [];
    for (let batch = 0; batch < 5; batch += 1) {
      const statements: D1PreparedStatement[] = [];
      for (let index = 0; index < 50; index += 1) {
        const n = batch * 50 + index;
        const productId = `w-${String(n).padStart(3, "0")}`;
        ids.push(productId);
        // Every third product has a place; names repeat, so the id decides ties.
        const sortOrder = n % 3 === 0 ? n % 7 : null;
        const name = `Name ${n % 11}`;
        statements.push(
          env.DB.prepare(
            `INSERT INTO products (product_id, tenant_id, status, sku, name, b2c_price_minor, currency,
               is_pod, created_at, updated_at, sort_order)
             VALUES (?, ?, 'active', ?, ?, 100, 'SEK', 0, ?, ?, ?)`,
          ).bind(productId, walkShop.tenantId, `SKU-${productId}`, name, NOW, NOW, sortOrder),
          env.DB.prepare(
            `INSERT INTO product_publications (product_id, tenant_id, published, public_name,
               public_price_minor, currency, projection_version, published_at, updated_at)
             VALUES (?, ?, 1, ?, 100, 'SEK', 1, ?, ?)`,
          ).bind(productId, walkShop.tenantId, name, NOW, NOW),
        );
      }
      await env.DB.batch(statements);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let unpublished: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query: string = cursor === null ? "?limit=40" : `?limit=40&cursor=${cursor}`;
      const body: PublicListBody = await expectJson(
        await call(otherWorld(), "GET", `${walkShop.origin}/v1/products${query}`),
        200,
        `walk ${page}`,
      );
      seen.push(...body.products.map((p) => p.productId));
      if (page === 2) {
        // A product not yet seen leaves the storefront between two pages.
        unpublished = ids.find((id) => !seen.includes(id)) ?? null;
        await env.DB.prepare("UPDATE product_publications SET published = 0 WHERE product_id = ?")
          .bind(unpublished)
          .run();
      }
      cursor = body.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(unpublished).not.toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(249);
    expect([...seen, unpublished].sort()).toEqual([...ids].sort());
    // The order the pages came in IS the display order.
    const order = await env.DB.prepare(
      `SELECT product.product_id FROM products AS product
       INNER JOIN product_publications AS publication ON publication.product_id = product.product_id
       WHERE product.tenant_id = ? AND publication.published = 1
       ORDER BY (product.sort_order IS NULL), product.sort_order, publication.public_name COLLATE NOCASE, product.product_id`,
    )
      .bind(walkShop.tenantId)
      .all<{ product_id: string }>();
    expect(seen).toEqual(order.results.map((row) => row.product_id));
  });

  it("the first page stops at 100 and says there is more", async () => {
    const big = await extraShop("cp4a-big");
    const statements: D1PreparedStatement[] = [];
    for (let n = 0; n < 113; n += 1) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO products (product_id, tenant_id, status, sku, name, b2c_price_minor, currency,
             is_pod, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?, 100, 'SEK', 0, ?, ?)`,
        ).bind(`b-${n}`, big.tenantId, `SKU-b-${n}`, `B ${String(n).padStart(3, "0")}`, NOW, NOW),
        env.DB.prepare(
          `INSERT INTO product_publications (product_id, tenant_id, published, public_name,
             public_price_minor, currency, projection_version, published_at, updated_at)
           VALUES (?, ?, 1, ?, 100, 'SEK', 1, ?, ?)`,
        ).bind(`b-${n}`, big.tenantId, `B ${String(n).padStart(3, "0")}`, NOW, NOW),
      );
    }
    await env.DB.batch(statements);
    const first: PublicListBody = await expectJson(await call(otherWorld(), "GET", `${big.origin}/v1/products`), 200, "p1");
    expect(first.products).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second: PublicListBody = await expectJson(
      await call(otherWorld(), "GET", `${big.origin}/v1/products?cursor=${first.nextCursor}`),
      200,
      "p2",
    );
    expect(second.products).toHaveLength(13);
    expect(second.nextCursor).toBeNull();
  });

  it("answers an ETag, a 304 while nothing changed, and a new body after a tag change", async () => {
    const first = await call(otherWorld(), "GET", `${shopC.origin}/v1/products?tag=nyhet`);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"\d+"$/);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    await first.body?.cancel();
    const cached = await call(otherWorld(), "GET", `${shopC.origin}/v1/products?tag=nyhet`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(cached.status).toBe(304);
    await env.DB.prepare("DELETE FROM product_tags WHERE product_id = 'l-1'").run();
    const changed = await call(otherWorld(), "GET", `${shopC.origin}/v1/products?tag=nyhet`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(changed.status).toBe(200);
    expect((await changed.json<PublicListBody>()).products.map((p) => p.productId)).toEqual(["l-3"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/products/:ref — by id, by handle, by the source system's sku rule", () => {
  let productId: string;

  beforeAll(async () => {
    productId = await liveProduct(shopA, { name: "Ref Tee", size: "M", sku: "REF-1" });
  });

  it("finds the product by its id, its handle and any address that ends in _<sku>", async () => {
    for (const ref of [productId, "ref-tee-m_REF-1", "an-old-name_REF-1", "ref-tee-m_REF-1".replace("m_", "M_")]) {
      const response = await storefront(shopA, `/v1/products/${encodeURIComponent(ref)}`);
      expect(response.status, ref).toBe(200);
      const body = await response.json<{ product: { path: string; productId: string } }>();
      expect(body.product).toMatchObject({ path: "/product/ref-tee-m_REF-1", productId });
    }
  });

  it("answers 404 for another shop, a draft, an unknown sku and a malformed ref", async () => {
    const draft = await createProduct(shopA, { name: "Ref Draft", sku: "REF-DRAFT" });
    for (const [tenant, ref] of [
      [shopB, productId],
      [shopB, "ref-tee-m_REF-1"],
      [shopA, draft.productId],
      [shopA, draft.handle],
      [shopA, "x_REF-DRAFT"],
      [shopA, "ref-tee-m_"],
      [shopA, "ref-tee-m"],
      [shopA, "a%2Fb"],
      [shopA, "x".repeat(1_201)],
    ] as const) {
      const response = await storefront(tenant, `/v1/products/${ref}`);
      expect(response.status, `${tenant.tenantId} ${ref.slice(0, 30)}`).toBe(404);
      await response.body?.cancel();
    }
  });

  it("a handle with characters an address must encode round-trips through its path", async () => {
    const id = await liveProduct(shopA, { name: "Enc", sku: "A B(1)å" });
    const body = await expectJson<{ product: { handle: string; path: string; productId: string } }>(
      await storefront(shopA, "/v1/products/enc_A%20B%281%29%C3%A5"),
      200,
      "encoded",
    );
    expect(body.product).toMatchObject({ handle: "enc_A B(1)å", path: "/product/enc_A%20B%281%29%C3%A5", productId: id });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the 0040 schema", () => {
  it("a row written without a handle gets its sku as handle; the handle cannot be cleared", async () => {
    await env.DB.prepare(
      `INSERT INTO products (product_id, tenant_id, status, sku, name, b2c_price_minor, currency, created_at, updated_at)
       VALUES ('schema-1', ?, 'draft', 'SC/1', 'Schema', 100, 'SEK', ?, ?)`,
    )
      .bind(shopA.tenantId, NOW, NOW)
      .run();
    expect((await productColumns("schema-1"))?.handle).toBe("SC-1");
    await expect(
      env.DB.prepare("UPDATE products SET handle = NULL WHERE product_id = 'schema-1'").run(),
    ).rejects.toThrow(/cannot be cleared/);
    await expect(
      env.DB.prepare("UPDATE products SET handle = 'a/b' WHERE product_id = 'schema-1'").run(),
    ).rejects.toThrow();
  });

  it("refuses a category without its key, an impossible launch date, and a tag of another shop's product", async () => {
    await expect(
      env.DB.prepare("UPDATE products SET category = 'X' WHERE product_id = 'schema-1'").run(),
    ).rejects.toThrow(/set together/);
    for (const date of ["2026-02-30", "2026-13-01", "tomorrow", "2026-1-1"]) {
      await expect(
        env.DB.prepare("UPDATE products SET launch_date = ? WHERE product_id = 'schema-1'").bind(date).run(),
        date,
      ).rejects.toThrow();
    }
    await env.DB.prepare("UPDATE products SET launch_date = '2028-02-29' WHERE product_id = 'schema-1'").run();
    await expect(
      env.DB.prepare(
        "INSERT INTO product_tags (tenant_id, product_id, tag_key, tag, position) VALUES (?, 'schema-1', 'x', 'x', 0)",
      )
        .bind(shopB.tenantId)
        .run(),
    ).rejects.toThrow(/tag tenant_id must match/);
    await expect(
      env.DB.prepare(
        "INSERT INTO product_tags (tenant_id, product_id, tag_key, tag, position) VALUES (?, 'schema-1', 'a/b', 'x', 0)",
      )
        .bind(shopA.tenantId)
        .run(),
    ).rejects.toThrow();
  });

  it("every write of product_tags bumps the shop's catalog_version", async () => {
    const bumps = async (sql: string) => {
      const before = await catalogVersion(shopA.tenantId);
      await env.DB.prepare(sql).bind(shopA.tenantId).run();
      expect(await catalogVersion(shopA.tenantId), sql).toBeGreaterThan(before);
    };
    await bumps(
      "INSERT INTO product_tags (tenant_id, product_id, tag_key, tag, position) VALUES (?, 'schema-1', 'k', 'K', 0)",
    );
    await bumps("UPDATE product_tags SET tag = 'Kk' WHERE tenant_id = ? AND product_id = 'schema-1'");
    await bumps("DELETE FROM product_tags WHERE tenant_id = ? AND product_id = 'schema-1'");
  });
});
