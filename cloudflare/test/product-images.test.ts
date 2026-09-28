import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import type { ObjectBucket, ObjectKind } from "../src/storage/object-store";
import { activateObject, reservePendingObject } from "../src/storage/object-store";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import { replaceProductImages } from "../src/catalog/product-images";
import { decideByPlatform } from "../src/catalog/screening";
import { adminOf, PLATFORM } from "./pod-fixtures";
import { ADMIN, approveProduct, call, type CallOptions, publishProduct } from "./slice-harness";
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
 * CP4-A — a product's images: PUT /v1/admin/products/:productId/images (the
 * whole ordered list, ≤ 30) and the images of the public shapes. Rows hold
 * object ids; the address comes from src/storage/public-objects.ts at read
 * time. D92: only this shop's active public product media can be attached.
 * D93: a removed object leaves the public shapes, and the next row leads.
 */

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
const NOW = Date.now();
const BASE = "https://public-objects.test.invalid";
const SHA = "d".repeat(64);

interface AdminImage {
  alt: string | null;
  image: { contentType: string; height: number | null; objectId: string; url: string; width: number | null } | null;
  objectId: string;
  position: number;
  variantId: string | null;
}

interface PublicImageView {
  alt: string | null;
  objectId: string;
  url: string;
  variantId?: string | null;
  width: number | null;
}

interface PublicDetail {
  product: {
    image: PublicImageView | null;
    images: PublicImageView[];
    swatches: Array<{ image: PublicImageView | null; label: string }>;
    variants: Array<{ group: string | null; image: PublicImageView | null; images: PublicImageView[]; variantId: string }>;
  };
}

function admin(tenant: Tenant, method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<Response> {
  return call(world, method, `${ADMIN}${path}`, {
    body,
    cookie: tenant.adminCookie,
    shopId: tenant.tenantId,
    ...options,
  });
}

function context(tenantId: string): TenantContext {
  return { domainKind: "admin", hostname: "", tenantId };
}

/** An object row made the way the upload makes it: reserved, then (optionally) activated. */
async function objectRow(
  tenantId: string,
  options: { activate?: boolean; bucket?: ObjectBucket; kind?: ObjectKind; name?: string } = {},
): Promise<string> {
  const reserved = await reservePendingObject(
    env.DB,
    context(tenantId),
    {
      bucket: options.bucket ?? "public",
      contentType: "image/png",
      fileName: options.name ?? "photo.png",
      kind: options.kind ?? "product_media",
    },
    NOW,
  );
  if (reserved.status !== "ok") {
    throw new Error(`reserve: ${reserved.status}`);
  }
  if (options.activate !== false) {
    const activated = await activateObject(
      env.DB,
      context(tenantId),
      reserved.object.objectId,
      { dimensions: { height: 600, width: 800 }, sha256: SHA, sizeBytes: 1_024 },
      NOW,
    );
    expect(activated.status).toBe("ok");
  }
  return reserved.object.objectId;
}

async function createProduct(tenant: Tenant, body: Record<string, unknown>): Promise<string> {
  const created = await expectJson<{ product: { productId: string } }>(
    await admin(tenant, "POST", "/v1/admin/products", { currency: "SEK", priceMinor: 10_000, ...body }),
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

async function addVariant(tenant: Tenant, productId: string, body: Record<string, unknown>): Promise<string> {
  const created = await expectJson<{ variant: { variantId: string } }>(
    await admin(tenant, "POST", `/v1/admin/products/${productId}/variants`, body),
    201,
    "variant",
  );
  return created.variant.variantId;
}

function putImages(tenant: Tenant, productId: string, images: unknown): Promise<Response> {
  return admin(tenant, "PUT", `/v1/admin/products/${productId}/images`, images);
}

async function publicDetail(tenant: Tenant, productId: string, targetEnv?: Env): Promise<PublicDetail["product"]> {
  const body = await expectJson<PublicDetail>(
    await call(world, "GET", `${tenant.origin}/v1/products/${productId}`, { env: targetEnv }),
    200,
    "detail",
  );
  return body.product;
}

async function imageRows(productId: string) {
  const rows = await env.DB.prepare(
    "SELECT position, object_id, variant_id, alt FROM product_images WHERE product_id = ? ORDER BY position",
  )
    .bind(productId)
    .all<{ alt: string | null; object_id: string; position: number; variant_id: string | null }>();
  return rows.results;
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

beforeAll(async () => {
  const shops = await tenantWorld("cp4i", 2);
  world = shops.world;
  [shopA, shopB] = shops.tenants as [Tenant, Tenant];
  for (const tenant of [shopA, shopB]) {
    await seedLive(tenant.tenantId, `${tenant.tenantId}-seed-1`);
    await seedLive(tenant.tenantId, `${tenant.tenantId}-seed-2`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
describe("refusals", () => {
  let productId: string;
  let mine: string;

  beforeAll(async () => {
    productId = await createProduct(shopA, { name: "Refusal frame", sku: "I-REF" });
    mine = await objectRow(shopA.tenantId);
  });

  it("another shop's admin, no session, a foreign origin: the opaque 404, nothing written", async () => {
    const body = [{ objectId: mine }];
    await expectOpaque404(await putImages(shopB, productId, body), "B");
    await expectOpaque404(
      await call(world, "PUT", `${ADMIN}/v1/admin/products/${productId}/images`, { body }),
      "anonymous",
    );
    await expectOpaque404(await admin(shopA, "PUT", `/v1/admin/products/${productId}/images`, body, { origin: "https://evil.example" }), "origin");
    expect(await imageRows(productId)).toEqual([]);
  });

  it.each([
    ["31 rows", Array.from({ length: 31 }, (_, index) => ({ alt: `a${index}`, objectId: `o-${index}` }))],
    ["one object twice on the product", [{ objectId: "o-1" }, { objectId: "o-1" }]],
    ["an unknown key", [{ objectId: "o-1", url: "https://x.test/a.png" }]],
    ["an alt text too long", [{ alt: "a".repeat(501), objectId: "o-1" }]],
    ["an empty object id", [{ objectId: "" }]],
    ["an empty variant id", [{ objectId: "o-1", variantId: "" }]],
    ["not a list", { images: [] }],
    ["a row that is not an object", ["o-1"]],
  ])("%s is a 400", async (_label, body) => {
    const response = await putImages(shopA, productId, body);
    expect(response.status).toBe(400);
    await response.body?.cancel();
  });

  it("an object that is not this shop's active public product media is refused (400), nothing written", async () => {
    const theirs = await objectRow(shopB.tenantId);
    const privateOne = await objectRow(shopA.tenantId, { bucket: "private", kind: "document" });
    const branding = await objectRow(shopA.tenantId, { kind: "shop_branding" });
    const pending = await objectRow(shopA.tenantId, { activate: false });
    const version = await catalogVersion(shopA.tenantId);
    for (const [label, objectId] of [
      ["another shop's", theirs],
      ["a private object", privateOne],
      ["a branding image", branding],
      ["a pending upload", pending],
      ["an unknown id", "no-such-object"],
    ] as const) {
      const response = await putImages(shopA, productId, [{ objectId: mine }, { objectId }]);
      const body = await expectJson<{ error: { reason: string } }>(response, 400, label);
      expect(body.error.reason, label).toBe("image_not_referencable");
    }
    expect(await imageRows(productId)).toEqual([]);
    expect(await catalogVersion(shopA.tenantId)).toBe(version);
  });

  it("a variant of another product is refused (400 variant_not_found)", async () => {
    const other = await createProduct(shopA, { name: "Other frame", sku: "I-OTHER" });
    const variantId = await addVariant(shopA, other, { label: "M", priceMinor: 100, sku: "I-OTHER-M" });
    const body = await expectJson<{ error: { reason: string } }>(
      await putImages(shopA, productId, [{ objectId: mine, variantId }]),
      400,
      "variant",
    );
    expect(body.error.reason).toBe("variant_not_found");
  });

  it("with no public base configured, every image write is refused and no shape carries an image", async () => {
    const noBase = world.with({ PUBLIC_OBJECT_BASE_URL: "" });
    const response = await call(world, "PUT", `${ADMIN}/v1/admin/products/${productId}/images`, {
      body: [{ objectId: mine }],
      cookie: shopA.adminCookie,
      env: noBase,
      shopId: shopA.tenantId,
    });
    expect(response.status).toBe(400);
    await response.body?.cancel();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the list, the main image and what a visitor sees", () => {
  let productId: string;
  let first: string;
  let second: string;
  let third: string;

  beforeAll(async () => {
    productId = await liveProduct(shopA, { name: "Gallery tee", sku: "I-GAL" });
    first = await objectRow(shopA.tenantId, { name: "front.png" });
    second = await objectRow(shopA.tenantId, { name: "back.png" });
    third = await objectRow(shopA.tenantId, { name: "detail.png" });
  });

  it("writes the whole list in order and answers each row with its address", async () => {
    const version = await catalogVersion(shopA.tenantId);
    const body = await expectJson<{ images: AdminImage[] }>(
      await putImages(shopA, productId, [
        { alt: "Framsida", objectId: first },
        { alt: "", objectId: second },
        { alt: "Detalj", objectId: third },
      ]),
      200,
      "put",
    );
    expect(body.images.map((image) => [image.position, image.objectId, image.alt])).toEqual([
      [0, first, "Framsida"],
      [1, second, null],
      [2, third, "Detalj"],
    ]);
    expect(body.images[0]?.image).toMatchObject({
      contentType: "image/png",
      height: 600,
      objectId: first,
      width: 800,
    });
    expect(body.images[0]?.image?.url).toMatch(
      new RegExp(`^${BASE}/shops/${shopA.tenantId}/product_media/${first}/v1/front\\.png$`),
    );
    expect(await catalogVersion(shopA.tenantId)).toBeGreaterThan(version);

    const audit = (await auditRows(shopA.tenantId, "product.images_replace")).at(-1);
    expect(audit?.metadata).toEqual({
      images: [first, second, third].map((objectId) => ({ objectId, variantId: null })),
    });
  });

  it("the public shapes: the first row is the main image, the list keeps its order, the address is made at read time", async () => {
    const detail = await publicDetail(shopA, productId);
    expect(detail.image).toMatchObject({ alt: "Framsida", objectId: first, width: 800 });
    expect(detail.images.map((image) => image.objectId)).toEqual([first, second, third]);
    expect(detail.images.every((image) => image.variantId === null)).toBe(true);
    const list = await expectJson<{ products: Array<{ image: PublicImageView | null; productId: string }> }>(
      await call(world, "GET", `${shopA.origin}/v1/products`),
      200,
      "list",
    );
    expect(list.products.find((product) => product.productId === productId)?.image?.objectId).toBe(first);
    // No address is stored in a row.
    const stored = await env.DB.prepare("SELECT * FROM product_images WHERE product_id = ?").bind(productId).all();
    expect(JSON.stringify(stored.results)).not.toContain(BASE);
    // With no public base, the same product carries no image at all.
    const bare = await publicDetail(shopA, productId, world.with({ PUBLIC_OBJECT_BASE_URL: "" }));
    expect(bare.image).toBeNull();
    expect(bare.images).toEqual([]);
  });

  it("D93: a removed object is absent everywhere, the next row leads, and the ETag moves", async () => {
    const before = await call(world, "GET", `${shopA.origin}/v1/products/${productId}`);
    const etag = before.headers.get("etag");
    await before.body?.cancel();

    const removed = await admin(shopA, "DELETE", `/v1/admin/objects/${first}`);
    expect(removed.status).toBe(204);

    const after = await call(world, "GET", `${shopA.origin}/v1/products/${productId}`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(after.status).toBe(200);
    const detail = (await after.json<PublicDetail>()).product;
    expect(detail.image?.objectId).toBe(second);
    expect(detail.images.map((image) => image.objectId)).toEqual([second, third]);
    expect(JSON.stringify(detail)).not.toContain(first);

    // The admin still sees the row, with no image behind it, to fix the list.
    const read = await expectJson<{ images: AdminImage[] }>(
      await admin(shopA, "GET", `/v1/admin/products/${productId}`),
      200,
      "admin read",
    );
    expect(read.images.map((image) => [image.objectId, image.image === null])).toEqual([
      [first, true],
      [second, false],
      [third, false],
    ]);
    // A list that names the removed object is refused.
    const again = await putImages(shopA, productId, [{ objectId: first }]);
    expect(again.status).toBe(400);
    await again.body?.cancel();
  });

  it("an empty list clears the images", async () => {
    await expectJson(await putImages(shopA, productId, []), 200, "clear");
    expect(await imageRows(productId)).toEqual([]);
    expect((await publicDetail(shopA, productId)).image).toBeNull();
  });

  it("a draft's images never appear in a public shape", async () => {
    const draft = await createProduct(shopA, { name: "Draft gallery", sku: "I-DRAFT" });
    const secret = await objectRow(shopA.tenantId, { name: "secret.png" });
    await expectJson(await putImages(shopA, draft, [{ objectId: secret }]), 200, "draft images");
    expect((await call(world, "GET", `${shopA.origin}/v1/products/${draft}`)).status).toBe(404);
    const list = await call(world, "GET", `${shopA.origin}/v1/products`);
    expect(await list.text()).not.toContain(secret);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the group rule: a colour's photos belong to every size of it", () => {
  let productId: string;
  let blackM: string;
  let blackL: string;
  let white: string;
  let shared: string;
  let blackPhoto: string;
  let whitePhoto: string;

  beforeAll(async () => {
    productId = await liveProduct(shopA, { name: "Group tee", sku: "I-GRP" });
    blackM = await addVariant(shopA, productId, { group: "Svart", label: "Svart / M", priceMinor: 100, size: "M", sku: "I-GRP-SM" });
    blackL = await addVariant(shopA, productId, { group: "Svart", label: "Svart / L", priceMinor: 100, size: "L", sku: "I-GRP-SL" });
    white = await addVariant(shopA, productId, { group: "Vit", label: "Vit / M", priceMinor: 100, size: "M", sku: "I-GRP-VM" });
    shared = await objectRow(shopA.tenantId, { name: "shared.png" });
    blackPhoto = await objectRow(shopA.tenantId, { name: "black.png" });
    whitePhoto = await objectRow(shopA.tenantId, { name: "white.png" });
    await expectJson(
      await putImages(shopA, productId, [
        { objectId: shared },
        { alt: "Svart", objectId: blackPhoto, variantId: blackM },
        { alt: "Vit", objectId: whitePhoto, variantId: white },
      ]),
      200,
      "images",
    );
  });

  it("every size of the group shows the group's photo; the other colour does not", async () => {
    const detail = await publicDetail(shopA, productId);
    const byId = new Map(detail.variants.map((variant) => [variant.variantId, variant]));
    expect(byId.get(blackM)?.images.map((image) => image.objectId)).toEqual([blackPhoto]);
    expect(byId.get(blackL)?.images.map((image) => image.objectId)).toEqual([blackPhoto]);
    expect(byId.get(blackL)?.image?.alt).toBe("Svart");
    expect(byId.get(white)?.images.map((image) => image.objectId)).toEqual([whitePhoto]);
    expect(detail.images.map((image) => [image.objectId, image.variantId])).toEqual([
      [shared, null],
      [blackPhoto, blackM],
      [whitePhoto, white],
    ]);
    expect(detail.swatches.map((swatch) => [swatch.label, swatch.image?.objectId])).toEqual([
      ["Svart", blackPhoto],
      ["Vit", whitePhoto],
    ]);
  });

  it("the size that holds the photo sold out: the photo stays, named by the colour's next active size", async () => {
    await expectJson(
      await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${blackM}`, { active: false }),
      200,
      "sold out",
    );
    const detail = await publicDetail(shopA, productId);
    const listed = new Set(detail.variants.map((variant) => variant.variantId));
    expect(detail.images.map((image) => [image.objectId, image.variantId])).toEqual([
      [shared, null],
      [blackPhoto, blackL],
      [whitePhoto, white],
    ]);
    expect(detail.images.every((image) => image.variantId === null || listed.has(image.variantId ?? ""))).toBe(true);
    await expectJson(
      await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${blackM}`, { active: true }),
      200,
      "back in stock",
    );
  });

  it("deleting the size that holds the group's photo moves the photo to the next size", async () => {
    await expectJson(await admin(shopA, "DELETE", `/v1/admin/products/${productId}/variants/${blackM}`), 200, "delete");
    expect((await imageRows(productId)).map((row) => [row.object_id, row.variant_id])).toEqual([
      [shared, null],
      [blackPhoto, blackL],
      [whitePhoto, white],
    ]);
    const detail = await publicDetail(shopA, productId);
    expect(detail.variants.find((variant) => variant.variantId === blackL)?.image?.objectId).toBe(blackPhoto);
  });

  it("a colour with no active size shows none of its photos", async () => {
    await expectJson(
      await admin(shopA, "PATCH", `/v1/admin/products/${productId}/variants/${blackL}`, { active: false }),
      200,
      "sold out",
    );
    const detail = await publicDetail(shopA, productId);
    expect(detail.images.map((image) => image.objectId)).toEqual([shared, whitePhoto]);
    expect(JSON.stringify(detail)).not.toContain(blackPhoto);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("alt texts are screened", () => {
  it("a hard-blocked term in an alt text takes the live product down", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO content_screening_terms (term, kind, hard_block, created_at) VALUES ('velmorax', 'club', 1, ?)",
    )
      .bind(new Date().toISOString())
      .run();
    const productId = await liveProduct(shopA, { name: "Alt tee", sku: "I-ALT" });
    const photo = await objectRow(shopA.tenantId);
    await expectJson(await putImages(shopA, productId, [{ alt: "Velmorax shirt", objectId: photo }]), 200, "put");
    expect((await call(world, "GET", `${shopA.origin}/v1/products/${productId}`)).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the 0040 schema of product_images", () => {
  let productId: string;

  beforeAll(async () => {
    productId = await createProduct(shopA, { name: "Schema frame", sku: "I-SCHEMA" });
  });

  const insert = (tenantId: string, objectId: string, position = 0) =>
    env.DB.prepare(
      `INSERT INTO product_images (tenant_id, product_id, position, variant_id, object_id, alt, created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, ?)`,
    )
      .bind(tenantId, productId, position, objectId, new Date().toISOString())
      .run();

  it("refuses another shop's object, a private one, a branding one, a pending one, and a foreign tenant", async () => {
    await expect(insert(shopA.tenantId, await objectRow(shopB.tenantId))).rejects.toThrow(/active public product media/);
    await expect(
      insert(shopA.tenantId, await objectRow(shopA.tenantId, { bucket: "private", kind: "document" })),
    ).rejects.toThrow(/active public product media/);
    await expect(insert(shopA.tenantId, await objectRow(shopA.tenantId, { kind: "shop_branding" }))).rejects.toThrow(
      /active public product media/,
    );
    await expect(insert(shopA.tenantId, await objectRow(shopA.tenantId, { activate: false }))).rejects.toThrow(
      /active public product media/,
    );
    await expect(insert(shopB.tenantId, await objectRow(shopB.tenantId))).rejects.toThrow(/image tenant_id must match/);
  });

  it("caps the list at 30 positions and one object once per owner", async () => {
    const photo = await objectRow(shopA.tenantId);
    await expect(insert(shopA.tenantId, photo, 30)).rejects.toThrow();
    await insert(shopA.tenantId, photo, 0);
    await expect(insert(shopA.tenantId, photo, 1)).rejects.toThrow(/UNIQUE/);
  });

  it("every write bumps the shop's catalog_version", async () => {
    const photo = await objectRow(shopA.tenantId);
    const bumps = async (label: string, write: () => Promise<unknown>) => {
      const before = await catalogVersion(shopA.tenantId);
      await write();
      expect(await catalogVersion(shopA.tenantId), label).toBeGreaterThan(before);
    };
    await bumps("insert", () => insert(shopA.tenantId, photo, 5));
    await bumps("update", () =>
      env.DB.prepare("UPDATE product_images SET alt = 'x' WHERE product_id = ? AND position = 5").bind(productId).run(),
    );
    await bumps("delete", () =>
      env.DB.prepare("DELETE FROM product_images WHERE product_id = ? AND position = 5").bind(productId).run(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("THE FENCE: a platform decision racing an image write", () => {
  it("an approval between the write's reads and its batch: re-run once, screened anew; a decision that keeps racing: 409, nothing written", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO content_screening_terms (term, kind, hard_block, created_at) VALUES ('zendrak', 'band', 1, ?)",
    )
      .bind(new Date().toISOString())
      .run();
    const productId = await liveProduct(shopA, { name: "Race frame", sku: "I-RACE" });
    const photo = await objectRow(shopA.tenantId);
    // Batches of one write: the object lookup (getReferencablePublicImage),
    // then the write itself. The approval lands just before the write.
    let calls = 0;
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            calls += 1;
            if (calls === 2) {
              await decideByPlatform(env.DB, PLATFORM, productId, "approved", Date.now());
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const principal = adminOf(shopA.tenantId, shopA.adminUserId);
    const result = await replaceProductImages(env, racing, principal, productId, [
      { alt: "Zendrak live", objectId: photo, variantId: null },
    ], Date.now());
    expect(result.status).toBe("ok");
    expect(calls).toBe(4);
    const row = await env.DB.prepare("SELECT status, hits_json FROM product_screening WHERE product_id = ?")
      .bind(productId)
      .first();
    expect(row).toEqual({ hits_json: '["zendrak"]', status: "blocked" });

    const other = await liveProduct(shopA, { name: "Race frame 2", sku: "I-RACE-2" });
    const always = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await decideByPlatform(env.DB, PLATFORM, other, "approved", Date.now());
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(
      replaceProductImages(env, always, principal, other, [{ alt: null, objectId: photo, variantId: null }], Date.now()),
    ).resolves.toEqual({ status: "conflict" });
    expect(await imageRows(other)).toEqual([]);
  });
});
