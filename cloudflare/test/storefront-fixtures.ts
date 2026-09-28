import { env } from "cloudflare:workers";

import type { ObjectKind } from "../src/storage/object-store";
import {
  activateObject,
  deletePendingOrMutableObject,
  reservePendingObject,
} from "../src/storage/object-store";
import { slugify } from "../src/storefront/redirects";
import type { TenantContext } from "../src/tenancy/resolve-tenant";

/**
 * CP4-D test fixtures. Not a test file.
 *
 * D reads tables of builders A (products.handle/.category/.sort_order/
 * .featured, product_images, product_tags), B (collections,
 * collection_products) and C (pages) whose migrations are written in the same
 * tree at the same time. `ensureStorefrontTables` creates what is missing with
 * the columns CP4_BRIEFS.md fixes, ONLY IF NOT EXISTS, so these suites run
 * with or without the other builders' migrations. The seeders write the
 * columns the brief fixes, plus — only when the table already has them — the
 * extra NOT NULL columns a builder's own migration added (A: `category_key`,
 * `tag_key`, the tag `position`), filled the way that builder's rule fills them.
 */

export const NOW = 1_790_000_000_000;
export const NOW_ISO = new Date(NOW).toISOString();
export const PUBLIC_BASE = "https://public-objects.test.invalid";

async function columnsOf(table: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(rows.results.map((row) => row.name));
}

export async function ensureStorefrontTables(): Promise<void> {
  const productColumns = await columnsOf("products");
  const missing = (
    [
      ["handle", "TEXT"],
      ["featured", "INTEGER NOT NULL DEFAULT 0"],
      ["sort_order", "INTEGER"],
      ["category", "TEXT"],
    ] as const
  ).filter(([name]) => !productColumns.has(name));
  for (const [name, type] of missing) {
    await env.DB.prepare(`ALTER TABLE products ADD COLUMN ${name} ${type}`).run();
  }

  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS product_images (
         tenant_id TEXT NOT NULL,
         product_id TEXT NOT NULL,
         variant_id TEXT,
         object_id TEXT NOT NULL,
         position INTEGER NOT NULL,
         alt TEXT,
         created_at TEXT NOT NULL
       )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS product_tags (
         tenant_id TEXT NOT NULL,
         product_id TEXT NOT NULL,
         tag TEXT NOT NULL
       )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS collections (
         collection_id TEXT PRIMARY KEY NOT NULL,
         tenant_id TEXT NOT NULL,
         handle TEXT NOT NULL,
         external_ref TEXT,
         title TEXT NOT NULL,
         description TEXT,
         image_object_id TEXT,
         type TEXT NOT NULL,
         rule_tag TEXT,
         published INTEGER NOT NULL DEFAULT 0,
         featured INTEGER NOT NULL DEFAULT 0,
         sort_order INTEGER,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         UNIQUE (tenant_id, handle)
       )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS collection_products (
         tenant_id TEXT NOT NULL,
         collection_id TEXT NOT NULL,
         product_id TEXT NOT NULL,
         position INTEGER NOT NULL,
         PRIMARY KEY (collection_id, product_id)
       )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS pages (
         page_id TEXT PRIMARY KEY NOT NULL,
         tenant_id TEXT NOT NULL,
         slug TEXT NOT NULL,
         kind TEXT NOT NULL,
         status TEXT NOT NULL,
         title_json TEXT NOT NULL,
         content_json TEXT NOT NULL,
         summary_json TEXT,
         meta_title_json TEXT,
         meta_description_json TEXT,
         author TEXT,
         image_object_id TEXT,
         published_at TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         UNIQUE (tenant_id, slug)
       )`,
    ),
  ]);
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
  const productColumns = await columnsOf("products");
  const category = seed.category ?? null;
  const withKey = productColumns.has("category_key");
  const price = seed.priceMinor ?? 19_900;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO products (
         product_id, tenant_id, status, sku, name, description, b2c_price_minor,
         currency, is_pod, created_at, updated_at, handle, category, sort_order
         ${withKey ? ", category_key" : ""}
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SEK', 0, ?, ?, ?, ?, ?${withKey ? ", ?" : ""})`,
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
      ...(withKey ? [category === null ? null : slugify(category)] : []),
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
    const tagColumns = await columnsOf("product_tags");
    const keyed = tagColumns.has("tag_key");
    const positioned = tagColumns.has("position");
    await env.DB.batch(
      seed.tags.map((tag, index) =>
        env.DB.prepare(
          `INSERT INTO product_tags (tenant_id, product_id, tag${keyed ? ", tag_key" : ""}${positioned ? ", position" : ""})
           VALUES (?, ?, ?${keyed ? ", ?" : ""}${positioned ? ", ?" : ""})`,
        ).bind(
          tenantId,
          productId,
          tag,
          ...(keyed ? [slugify(tag)] : []),
          ...(positioned ? [index] : []),
        ),
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
