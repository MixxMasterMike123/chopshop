import { env } from "cloudflare:workers";

import type { ObjectKind } from "../src/storage/object-store";
import {
  activateObject,
  deletePendingOrMutableObject,
  reservePendingObject,
} from "../src/storage/object-store";
import { slugify } from "../src/storefront/addresses";
import type { TenantContext } from "../src/tenancy/resolve-tenant";

/**
 * CP4-D test fixtures. Not a test file.
 *
 * D's suites read the tables of builders A (0040: products.handle/.category/
 * .category_key/.sort_order/.featured, product_images, product_tags), B (0041:
 * collections, collection_products) and C (0042: pages). The seeders write
 * those tables straight into D1, as the importer does, filling A's keys the
 * way A's rule fills them (the slug of the text).
 */

export const NOW = 1_790_000_000_000;
export const NOW_ISO = new Date(NOW).toISOString();
export const PUBLIC_BASE = "https://public-objects.test.invalid";

const STOREFRONT_TABLES = ["product_images", "product_tags", "collections", "collection_products", "pages"] as const;

/**
 * The suites stand on the migrated tables of A, B and C. This only checks
 * that they are there, so a run against a database without them fails here,
 * naming the table, rather than inside a seeder.
 */
export async function ensureStorefrontTables(): Promise<void> {
  for (const table of STOREFRONT_TABLES) {
    const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (columns.results.length === 0) {
      throw new Error(`the storefront fixtures need the migrated table ${table}`);
    }
  }
}

// ── shops ───────────────────────────────────────────────────────────────────

export interface ShopSeed {
  name?: string;
  published?: boolean;
  status?: "active" | "closed" | "provisioning" | "suspended";
  supportEmail?: string | null;
}

export interface SeededShop {
  context: TenantContext;
  host: string;
  origin: string;
  tenantId: string;
}

/** A shop with a verified storefront hostname, straight into D1. */
export async function seedShop(tenantId: string, seed: ShopSeed = {}): Promise<SeededShop> {
  const host = `${tenantId}.storefront-d.test`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
         tenant_id, status, shop_name, support_email, default_locale,
         default_currency, settings_json, created_at, updated_at, published
       ) VALUES (?, ?, ?, ?, 'sv-SE', 'SEK', ?, ?, ?, ?)`,
    ).bind(
      tenantId,
      seed.status ?? "active",
      seed.name ?? `Butik ${tenantId}`,
      seed.supportEmail === undefined ? null : seed.supportEmail,
      JSON.stringify({ privateSetting: "settings-json-must-not-leak" }),
      NOW,
      NOW,
      seed.published === false ? 0 : 1,
    ),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
         domain_id, tenant_id, hostname, kind, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, host, NOW, NOW),
  ]);
  return {
    context: { domainKind: "storefront", hostname: host, tenantId },
    host,
    origin: `https://${host}`,
    tenantId,
  };
}

/** The store identity as a non-route writer (the importer) stores it. */
export async function storeIdentity(tenantId: string, identity: Record<string, unknown>): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_settings (tenant_id, store_identity_json, updated_at, updated_by)
     VALUES (?, ?, ?, 'import')
     ON CONFLICT (tenant_id) DO UPDATE SET
       store_identity_json = excluded.store_identity_json,
       updated_at = excluded.updated_at`,
  )
    .bind(tenantId, JSON.stringify(identity), NOW_ISO)
    .run();
}

export async function setFeature(tenantId: string, key: string, enabled: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_features (tenant_id, feature_key, enabled, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 'test')
     ON CONFLICT (tenant_id, feature_key) DO UPDATE SET enabled = excluded.enabled`,
  )
    .bind(tenantId, key, enabled ? 1 : 0, NOW_ISO)
    .run();
}

export async function catalogVersion(tenantId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT catalog_version FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ catalog_version: number }>();
  return row?.catalog_version ?? 0;
}

// ── public objects ──────────────────────────────────────────────────────────

/** A public object made the way an upload makes it: reserved, then activated. */
export async function publicObject(
  tenantId: string,
  options: { activate?: boolean; fileName?: string; kind?: ObjectKind; size?: { height: number; width: number } | null } = {},
): Promise<string> {
  const context: TenantContext = { domainKind: "admin", hostname: "", tenantId };
  const kind = options.kind ?? "shop_branding";
  const reserved = await reservePendingObject(
    env.DB,
    context,
    {
      bucket: kind === "shop_branding" || kind === "product_media" ? "public" : "private",
      contentType: "image/png",
      fileName: options.fileName ?? "image.png",
      kind,
    },
    NOW,
  );
  if (reserved.status !== "ok") {
    throw new Error(`reserve failed: ${reserved.status}`);
  }
  if (options.activate !== false) {
    const activated = await activateObject(
      env.DB,
      context,
      reserved.object.objectId,
      {
        dimensions: options.size === undefined ? { height: 300, width: 400 } : options.size,
        sha256: "d".repeat(64),
        sizeBytes: 1_024,
      },
      NOW,
    );
    if (activated.status !== "ok") {
      throw new Error(`activate failed: ${activated.status}`);
    }
  }
  return reserved.object.objectId;
}

export async function removeObject(tenantId: string, objectId: string): Promise<void> {
  const result = await deletePendingOrMutableObject(
    env.DB,
    { domainKind: "admin", hostname: "", tenantId },
    objectId,
    NOW + 1,
  );
  if (result.status !== "ok") {
    throw new Error(`delete failed: ${result.status}`);
  }
}

export async function objectKey(objectId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT object_key FROM stored_objects WHERE object_id = ?")
    .bind(objectId)
    .first<{ object_key: string }>();
  if (row === null) {
    throw new Error(`no object ${objectId}`);
  }
  return row.object_key;
}

// ── catalogue (A), collections (B), pages (C) ───────────────────────────────

export interface ProductSeed {
  category?: string | null;
  description?: string | null;
  handle?: string;
  name: string;
  priceMinor?: number;
  published?: boolean;
  sku: string;
  sortOrder?: number | null;
  status?: "active" | "archived" | "draft";
  tags?: string[];
  takenDown?: boolean;
  variants?: Array<{ active?: boolean; label: string; priceMinor: number; sku: string }>;
}

let productCounter = 0;

/** A product with its publication (published by default), straight into D1. */
export async function seedProduct(tenantId: string, seed: ProductSeed): Promise<string> {
  productCounter += 1;
  const productId = `prod-${tenantId}-${productCounter}`;
  const category = seed.category ?? null;
  const price = seed.priceMinor ?? 19_900;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO products (
         product_id, tenant_id, status, sku, name, description, b2c_price_minor,
         currency, is_pod, created_at, updated_at, handle, category, sort_order,
         category_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SEK', 0, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      productId,
      tenantId,
      seed.status ?? "active",
      seed.sku,
      seed.name,
      seed.description ?? null,
      price,
      NOW,
      NOW + productCounter,
      seed.handle ?? seed.sku,
      category,
      seed.sortOrder ?? null,
      category === null ? null : slugify(category),
    ),
    env.DB.prepare(
      `INSERT INTO product_publications (
         product_id, tenant_id, published, public_name, public_description,
         public_price_minor, currency, published_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'SEK', ?, ?)`,
    ).bind(
      productId,
      tenantId,
      seed.published === false ? 0 : 1,
      seed.name,
      seed.description ?? null,
      price,
      NOW,
      NOW,
    ),
  ];
  for (const [index, variant] of (seed.variants ?? []).entries()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO product_variants (
           variant_id, tenant_id, product_id, sku, label, price_minor, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `${productId}-v${index}`,
        tenantId,
        productId,
        variant.sku,
        variant.label,
        variant.priceMinor,
        variant.active === false ? 0 : 1,
        NOW,
        NOW,
      ),
    );
  }
  await env.DB.batch(statements);

  if (seed.tags !== undefined && seed.tags.length > 0) {
    await env.DB.batch(
      seed.tags.map((tag, index) =>
        env.DB.prepare(
          `INSERT INTO product_tags (tenant_id, product_id, tag, tag_key, position)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(tenantId, productId, tag, slugify(tag), index),
      ),
    );
  }
  if (seed.takenDown === true) {
    await env.DB.prepare("UPDATE products SET takedown_at = ? WHERE product_id = ?")
      .bind(NOW_ISO, productId)
      .run();
  }
  return productId;
}

export async function attachImage(
  tenantId: string,
  productId: string,
  objectId: string,
  position: number,
  alt: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO product_images (tenant_id, product_id, object_id, position, alt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(tenantId, productId, objectId, position, alt, NOW_ISO)
    .run();
}

export interface CollectionSeed {
  description?: string | null;
  handle: string;
  imageObjectId?: string | null;
  productIds?: string[];
  published?: boolean;
  ruleTag?: string | null;
  title: string;
  type?: "manual" | "smart";
}

let collectionCounter = 0;

export async function seedCollection(tenantId: string, seed: CollectionSeed): Promise<string> {
  collectionCounter += 1;
  const collectionId = `coll-${tenantId}-${collectionCounter}`;
  const iso = new Date(NOW + collectionCounter).toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO collections (
         collection_id, tenant_id, handle, title, description, image_object_id,
         type, rule_tag, published, featured, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(
      collectionId,
      tenantId,
      seed.handle,
      seed.title,
      seed.description ?? null,
      seed.imageObjectId ?? null,
      seed.type ?? "manual",
      seed.type === "smart" ? (seed.ruleTag ?? null) : null,
      seed.published === false ? 0 : 1,
      iso,
      iso,
    ),
  ];
  for (const [position, productId] of (seed.productIds ?? []).entries()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO collection_products (tenant_id, collection_id, product_id, position)
         VALUES (?, ?, ?, ?)`,
      ).bind(tenantId, collectionId, productId, position),
    );
  }
  await env.DB.batch(statements);
  return collectionId;
}

export interface PageSeed {
  author?: string | null;
  content: string;
  imageObjectId?: string | null;
  kind?: "page" | "post";
  metaDescription?: string | null;
  metaTitle?: string | null;
  slug: string;
  status?: "draft" | "published";
  summary?: string | null;
  title: string;
}

let pageCounter = 0;

const perLanguage = (text: string | null | undefined): string | null =>
  text === null || text === undefined ? null : JSON.stringify({ "sv-SE": text });

export async function seedPage(tenantId: string, seed: PageSeed): Promise<string> {
  pageCounter += 1;
  const pageId = `page-${tenantId}-${pageCounter}`;
  const iso = new Date(NOW + pageCounter).toISOString();
  const published = (seed.status ?? "published") === "published";
  await env.DB.prepare(
    `INSERT INTO pages (
       page_id, tenant_id, slug, kind, status, title_json, content_json, summary_json,
       meta_title_json, meta_description_json, author, image_object_id, published_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      pageId,
      tenantId,
      seed.slug,
      seed.kind ?? "page",
      seed.status ?? "published",
      perLanguage(seed.title),
      perLanguage(seed.content),
      perLanguage(seed.summary),
      perLanguage(seed.metaTitle),
      perLanguage(seed.metaDescription),
      seed.author ?? null,
      seed.imageObjectId ?? null,
      published ? iso : null,
      iso,
      iso,
    )
    .run();
  return pageId;
}

/** An adoption of the three legal pages, as the importer writes one. */
export async function adoptLegalPages(tenantId: string, texts: Record<string, string>): Promise<string> {
  const acceptedAt = new Date(NOW + 5_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO legal_acceptances (
       acceptance_id, tenant_id, type, legacy_uid, accepted_at, texts_json,
       texts_sha256, source
     ) VALUES (?, ?, 'legalPages', 'legacy-admin', ?, ?, ?, 'import')`,
  )
    .bind(`acceptance-${tenantId}`, tenantId, acceptedAt, JSON.stringify(texts), "e".repeat(64))
    .run();
  return acceptedAt;
}

export async function publishPlatformTerms(version: string, publishedAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO platform_terms_versions (version, published_at, sha256, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(version, publishedAt, "f".repeat(64), publishedAt)
    .run();
}
