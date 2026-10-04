import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { getPublicProductByRef, listPublicProductPage } from "../src/catalog/public-catalog";

const NOW = 1_787_100_000_000;

interface SeedProductOptions {
  currency?: string;
  description?: string;
  productId: string;
  publicName?: string;
  published: boolean;
  sku: string;
  status: "draft" | "active" | "archived";
  tenantId: string;
}

async function seedTenant(tenantId: string, hostname: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, support_email, default_locale,
        default_currency, created_at, updated_at
      ) VALUES (?, 'active', ?, ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, `Shop ${tenantId}`, `ops-${tenantId}@example.test`, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, NOW, NOW),
  ]);
}

async function seedProduct(options: SeedProductOptions): Promise<void> {
  const currency = options.currency ?? "SEK";
  const publicName = options.publicName ?? `Public ${options.productId}`;

  await env.DB.prepare(
    `INSERT INTO products (
      product_id, tenant_id, status, sku, name, description,
      b2c_price_minor, currency, is_pod, internal_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(
      options.productId,
      options.tenantId,
      options.status,
      options.sku,
      `Internal name must-not-leak ${options.productId}`,
      options.description ?? null,
      999_999,
      currency,
      JSON.stringify({ supplierCost: "must-not-leak" }),
      NOW,
      NOW,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO product_publications (
      product_id, tenant_id, published, public_name, public_description,
      public_price_minor, currency, projection_version, published_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      options.productId,
      options.tenantId,
      options.published ? 1 : 0,
      publicName,
      options.description ?? null,
      12_900,
      currency,
      options.published ? NOW : null,
      NOW,
    )
    .run();
}

async function seedVariant(
  tenantId: string,
  productId: string,
  variantId: string,
  sku: string,
  label: string,
  active: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO product_variants (
      variant_id, tenant_id, product_id, sku, label, price_minor,
      active, attributes_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      variantId,
      tenantId,
      productId,
      sku,
      label,
      13_900,
      active ? 1 : 0,
      JSON.stringify({ internalNote: "must-not-leak" }),
      NOW,
      NOW,
    )
    .run();
}

beforeAll(async () => {
  await seedTenant("tenant-cat-a", "a.catalog.test");
  await seedTenant("tenant-cat-b", "b.catalog.test");

  await seedProduct({
    productId: "product-a-live",
    publicName: "Alpha Tee",
    sku: "SKU-A-LIVE",
    published: true,
    status: "active",
    tenantId: "tenant-cat-a",
  });
  await seedProduct({
    productId: "product-a-draft",
    publicName: "Alpha Draft",
    sku: "SKU-A-DRAFT",
    published: true,
    status: "draft",
    tenantId: "tenant-cat-a",
  });
  await seedProduct({
    productId: "product-a-archived",
    publicName: "Alpha Archived",
    sku: "SKU-A-ARCHIVED",
    published: true,
    status: "archived",
    tenantId: "tenant-cat-a",
  });
  await seedProduct({
    productId: "product-a-unpublished",
    publicName: "Alpha Unpublished",
    sku: "SKU-A-UNPUB",
    published: false,
    status: "active",
    tenantId: "tenant-cat-a",
  });
  await seedProduct({
    productId: "product-b-live",
    publicName: "Bravo must-not-leak Hoodie",
    sku: "SKU-B-LIVE",
    published: true,
    status: "active",
    tenantId: "tenant-cat-b",
  });

  await seedVariant(
    "tenant-cat-a",
    "product-a-live",
    "variant-a-m",
    "SKU-A-LIVE-M",
    "Medium",
    true,
  );
  await seedVariant(
    "tenant-cat-a",
    "product-a-live",
    "variant-a-x",
    "SKU-A-LIVE-X",
    "Retired",
    false,
  );
});

describe("GET /v1/products", () => {
  it("returns only the hostname tenant's published active products", async () => {
    const response = await exports.default.fetch(
      new Request("https://a.catalog.test/v1/products", {
        headers: {
          "x-forwarded-host": "b.catalog.test",
          "x-shop-id": "tenant-cat-b",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    // CP4-A changed this case: the summary gained the storefront fields and the
    // list its cursor. The fixture names no handle, so the sku is its handle
    // (the 0040 backfill); its one active variant (13 900) is the card price.
    expect(body).toEqual({
      nextCursor: null,
      products: [
        {
          category: null,
          compareAtPriceMinor: null,
          currency: "SEK",
          description: null,
          featured: false,
          handle: "SKU-A-LIVE",
          image: null,
          isFromPrice: false,
          lowestPriceMinor: 13_900,
          name: "Alpha Tee",
          path: "/product/SKU-A-LIVE",
          priceMinor: 12_900,
          productId: "product-a-live",
          sku: "SKU-A-LIVE",
          sortOrder: null,
          swatches: [{ image: null, label: "Medium" }],
          tags: [],
        },
      ],
    });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("999999");
    expect(serialized).not.toContain("internal_json");
    expect(serialized).not.toContain("tenant-cat-b");
    expect(serialized).not.toContain("Bravo");
  });

  it("fails closed for an unknown hostname", async () => {
    const response = await exports.default.fetch(
      "https://unknown.catalog.test/v1/products",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Products not found",
      },
    });
  });

  it("does not expose the collection through another method", async () => {
    const response = await exports.default.fetch(
      new Request("https://a.catalog.test/v1/products", { method: "POST" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });
});

describe("GET /v1/products/{productId}", () => {
  it("returns public fields and active variants only", async () => {
    const response = await exports.default.fetch(
      "https://a.catalog.test/v1/products/product-a-live",
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    // CP4-A changed this case: the detail gained the storefront fields, the
    // image list and the rail fields of each variant.
    expect(body).toEqual({
      product: {
        allowPickup: false,
        allowShipping: true,
        brand: null,
        category: null,
        compareAtPriceMinor: null,
        currency: "SEK",
        description: null,
        eanCode: null,
        featured: false,
        handle: "SKU-A-LIVE",
        image: null,
        images: [],
        isFromPrice: false,
        isPersonalized: false,
        launchDate: null,
        lowestPriceMinor: 13_900,
        moreInfo: null,
        name: "Alpha Tee",
        path: "/product/SKU-A-LIVE",
        // Not a POD product: no print areas, no previews.
        pod: null,
        priceMinor: 12_900,
        productId: "product-a-live",
        size: null,
        sizeGuide: null,
        sku: "SKU-A-LIVE",
        sortOrder: null,
        stock: null,
        swatches: [{ image: null, label: "Medium" }],
        tags: [],
        variants: [
          {
            group: null,
            image: null,
            images: [],
            label: "Medium",
            position: 0,
            priceMinor: 13_900,
            size: null,
            sku: "SKU-A-LIVE-M",
            variantId: "variant-a-m",
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("fails closed when another tenant's product id is requested", async () => {
    const response = await exports.default.fetch(
      new Request("https://a.catalog.test/v1/products/product-b-live", {
        headers: { "x-shop-id": "tenant-cat-b" },
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Product not found",
      },
    });
  });

  it.each([
    ["product-a-draft"],
    ["product-a-archived"],
    ["product-a-unpublished"],
  ])("fails closed for non-public product %s", async (productId) => {
    const response = await exports.default.fetch(
      `https://a.catalog.test/v1/products/${productId}`,
    );

    expect(response.status).toBe(404);
  });

  it.each([
    ["https://a.catalog.test/v1/products/"],
    ["https://a.catalog.test/v1/products/product-a-live/"],
    ["https://a.catalog.test/v1/products/product-a-live/variants"],
  ])("rejects malformed path %s", async (target) => {
    const response = await exports.default.fetch(target);

    expect(response.status).toBe(404);
  });

  it("fails closed for an unknown hostname", async () => {
    const response = await exports.default.fetch(
      "https://unknown.catalog.test/v1/products/product-a-live",
    );

    expect(response.status).toBe(404);
  });
});

describe("a product that stops being public while its parts are read", () => {
  it("is left out of the list and is no product to the read of one", async () => {
    const tenantId = "tenant-catalog-race";
    const productId = "product-race-1";
    await seedTenant(tenantId, "race.catalog.test");
    await seedProduct({ productId, published: true, sku: "RACE-1", status: "active", tenantId });
    const tenant = { domainKind: "storefront", hostname: "race.catalog.test", tenantId };

    // The product row is selected first; the tags, variants and images are
    // read after it. An edit that lands in between writes a text and blocks
    // the product in one batch: here, before the first of those later reads.
    const racing = (): D1Database => {
      let fired = false;
      return new Proxy(env.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!fired) {
                fired = true;
                await target.batch([
                  target
                    .prepare(
                      "INSERT INTO product_tags (tenant_id, product_id, tag_key, tag, position) VALUES (?, ?, 'never-approved', 'Never approved', 0)",
                    )
                    .bind(tenantId, productId),
                  target
                    .prepare("UPDATE products SET takedown_at = '2027-01-01T00:00:00.000Z' WHERE product_id = ?")
                    .bind(productId),
                ]);
              }
              return target.batch(statements);
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };

    const page = await listPublicProductPage(env, racing(), tenant, {});
    expect(page.products.map((product) => product.productId)).not.toContain(productId);
    expect(JSON.stringify(page)).not.toContain("Never approved");

    await env.DB.prepare("UPDATE products SET takedown_at = NULL WHERE product_id = ?").bind(productId).run();
    await env.DB.prepare("DELETE FROM product_tags WHERE product_id = ?").bind(productId).run();
    expect(await getPublicProductByRef(env, racing(), tenant, productId)).toBeNull();
  });
});

describe("catalogue database invariants", () => {
  it("gives two products whose skus make one handle each a handle of its own", async () => {
    await seedProduct({ productId: "product-h-slash", published: false, sku: "H/1", status: "draft", tenantId: "tenant-cat-a" });
    await seedProduct({ productId: "product-h-dash", published: false, sku: "H-1", status: "draft", tenantId: "tenant-cat-a" });
    const rows = await env.DB.prepare(
      "SELECT product_id, handle FROM products WHERE product_id IN ('product-h-slash', 'product-h-dash') ORDER BY product_id",
    ).all<{ handle: string; product_id: string }>();
    expect(rows.results).toEqual([
      { handle: "H-1-product-", product_id: "product-h-dash" },
      { handle: "H-1", product_id: "product-h-slash" },
    ]);
  });

  it("stops the 201st active variant and the 401st variant of a product, whoever writes it", async () => {
    await seedProduct({ productId: "product-many", published: false, sku: "MANY", status: "draft", tenantId: "tenant-cat-a" });
    for (let index = 0; index < 200; index += 1) {
      await seedVariant("tenant-cat-a", "product-many", `many-a-${index}`, `MANY-A-${index}`, `A ${index}`, true);
    }
    await expect(
      seedVariant("tenant-cat-a", "product-many", "many-a-200", "MANY-A-200", "A 200", true),
    ).rejects.toThrow(/variant limit reached/);
    for (let index = 0; index < 200; index += 1) {
      await seedVariant("tenant-cat-a", "product-many", `many-i-${index}`, `MANY-I-${index}`, `I ${index}`, false);
    }
    await expect(
      seedVariant("tenant-cat-a", "product-many", "many-i-200", "MANY-I-200", "I 200", false),
    ).rejects.toThrow(/variant limit reached/);
    await expect(
      env.DB.prepare("UPDATE product_variants SET active = 1 WHERE variant_id = 'many-i-0'").run(),
    ).rejects.toThrow(/variant limit reached/);
  });

  it("rejects a variant whose tenant differs from its product", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO product_variants (
          variant_id, tenant_id, product_id, sku, label, price_minor,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
        .bind(
          "variant-cross-tenant",
          "tenant-cat-b",
          "product-a-live",
          "SKU-CROSS",
          "Cross",
          1_000,
          NOW,
          NOW,
        )
        .run(),
    ).rejects.toThrow("variant tenant_id must match product tenant_id");
  });

  it("rejects a publication whose tenant differs from its product", async () => {
    await env.DB.prepare(
      `INSERT INTO products (
        product_id, tenant_id, status, sku, name, b2c_price_minor,
        currency, created_at, updated_at
      ) VALUES (?, 'tenant-cat-a', 'active', ?, ?, ?, 'SEK', ?, ?)`,
    )
      .bind(
        "product-a-orphan",
        "SKU-A-ORPHAN",
        "Orphan",
        1_000,
        NOW,
        NOW,
      )
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO product_publications (
          product_id, tenant_id, published, public_name,
          public_price_minor, currency, published_at, updated_at
        ) VALUES (?, 'tenant-cat-b', 1, ?, ?, 'SEK', ?, ?)`,
      )
        .bind("product-a-orphan", "Orphan Public", 1_000, NOW, NOW)
        .run(),
    ).rejects.toThrow("publication tenant_id must match product tenant_id");
  });

  it("blocks product re-homing at the database boundary", async () => {
    await expect(
      env.DB.prepare(
        "UPDATE products SET tenant_id = ?, updated_at = ? WHERE product_id = ?",
      )
        .bind("tenant-cat-b", NOW + 1, "product-a-live")
        .run(),
    ).rejects.toThrow("tenant_id is immutable");
  });

  it("blocks publication re-homing at the database boundary", async () => {
    await expect(
      env.DB.prepare(
        "UPDATE product_publications SET tenant_id = ?, updated_at = ? WHERE product_id = ?",
      )
        .bind("tenant-cat-b", NOW + 1, "product-a-live")
        .run(),
    ).rejects.toThrow("publication tenant_id must match product tenant_id");
  });

  it("blocks publication re-pointing to another tenant's product", async () => {
    await expect(
      env.DB.prepare(
        "UPDATE product_publications SET product_id = ?, updated_at = ? WHERE product_id = ?",
      )
        .bind("product-b-live", NOW + 1, "product-a-live")
        .run(),
    ).rejects.toThrow("publication tenant_id must match product tenant_id");
  });

  it("blocks publication re-pointing within the same tenant", async () => {
    await expect(
      env.DB.prepare(
        "UPDATE product_publications SET product_id = ?, updated_at = ? WHERE product_id = ?",
      )
        .bind("product-a-draft", NOW + 1, "product-a-live")
        .run(),
    ).rejects.toThrow("product_id is immutable");
  });

  it("blocks variant re-homing at the database boundary", async () => {
    await expect(
      env.DB.prepare(
        "UPDATE product_variants SET tenant_id = ?, updated_at = ? WHERE variant_id = ?",
      )
        .bind("tenant-cat-b", NOW + 1, "variant-a-m")
        .run(),
    ).rejects.toThrow("variant tenant_id must match product tenant_id");
  });

  it("rejects a duplicate sku inside one tenant", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO products (
          product_id, tenant_id, status, sku, name, b2c_price_minor,
          currency, created_at, updated_at
        ) VALUES (?, 'tenant-cat-a', 'active', 'SKU-A-LIVE', ?, ?, 'SEK', ?, ?)`,
      )
        .bind("product-a-duplicate", "Duplicate", 1_000, NOW, NOW)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a negative public price", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO products (
          product_id, tenant_id, status, sku, name, b2c_price_minor,
          currency, created_at, updated_at
        ) VALUES (?, 'tenant-cat-a', 'active', ?, ?, ?, 'SEK', ?, ?)`,
      )
        .bind("product-a-negative", "SKU-A-NEG", "Negative", -1, NOW, NOW)
        .run(),
    ).rejects.toThrow();
  });
});

describe("GET /ready", () => {
  it("reports the latest required migration as applied", async () => {
    const response = await exports.default.fetch(
      "https://a.catalog.test/ready",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      database: "ready",
      migration: "0053_print_canvas_jobs.sql",
      status: "ok",
    });
  });
});
