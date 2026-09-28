import type { ShippingRates, ShippingRatesWire } from "../commerce/shipping";
import { normalizeShippingRates, toShippingRatesWire } from "../commerce/shipping";
import type { PublicImage } from "../storage/public-objects";
import { resolvePublicImages } from "../storage/public-objects";
import type { ProductScreeningInput, ScreeningStatus } from "./screening-core";

/**
 * CP4-A — the product READ layer: the rows a product is made of (the product,
 * its tags, its variants, its image list), the admin views of them, and the
 * one loader of a product's screened texts. Nothing here writes, and nothing
 * here imports a write path (admin-catalog.ts, product-variants.ts,
 * product-images.ts and screening.ts import THIS module, never the reverse),
 * so the screening module can read a product's texts from here without a
 * cycle.
 *
 * Every read names the tenant. Every list is bounded: by LIMIT, by the
 * schema's own caps (30 image rows, 20 tags per product), or by a per-product
 * window (variants), and `IN (…)` lists are read 90 ids at a time.
 */

export type ProductStatus = "draft" | "active" | "archived";

export interface AdminProduct {
  allowPickup: boolean;
  allowShipping: boolean;
  brand: string | null;
  /** As the seller typed it; its address form is derived (categoryKey). */
  category: string | null;
  compareAtPriceMinor: number | null;
  currency: string;
  description: string | null;
  eanCode: string | null;
  featured: boolean;
  /** The last segment of the storefront address, derived (productHandle). */
  handle: string;
  isPersonalized: boolean;
  /** Sticky once the product gets its first POD mapping. */
  isPod: boolean;
  /** YYYY-MM-DD, or null. */
  launchDate: string | null;
  /** "Mer information": HTML the storefront cleans when it renders it. */
  moreInfo: string | null;
  name: string;
  priceMinor: number;
  productId: string;
  /**
   * PLAN §2.4 / D8: null until the product is first published (screened);
   * 'pending' = a shop's first products wait for a platform approval before
   * they are public; 'blocked' = never public (hard block or takedown).
   */
  screeningStatus: ScreeningStatus | null;
  // The admin-facing `{region: {cost}}` form, identical to what a write sends
  // and to what the column stores, so a product round-trips unchanged.
  shippingRates: ShippingRatesWire | null;
  size: string | null;
  sizeGuide: string | null;
  sku: string;
  /** The admin's drag order; null = none (sorts after every ordered product). */
  sortOrder: number | null;
  status: ProductStatus;
  stock: number | null;
  /** In the seller's order, as typed. */
  tags: string[];
  weightGrams: number;
}

export interface ProductRow {
  allow_pickup: number;
  allow_shipping: number;
  b2c_price_minor: number;
  brand: string | null;
  category: string | null;
  category_key: string | null;
  compare_at_price_minor: number | null;
  currency: string;
  description: string | null;
  ean_code: string | null;
  featured: number;
  handle: string;
  is_personalized: number;
  is_pod: number;
  launch_date: string | null;
  more_info: string | null;
  name: string;
  product_id: string;
  screening_status: ScreeningStatus | null;
  shipping_json: string | null;
  size: string | null;
  size_guide: string | null;
  sku: string;
  sort_order: number | null;
  status: ProductStatus;
  stock: number | null;
  takedown_at: string | null;
  updated_at: number;
  weight_grams: number;
}

/** The schema's caps (migrations/0040), restated for the reads they bound. */
export const MAX_PRODUCT_IMAGES = 30;
export const MAX_PRODUCT_TAGS = 20;
/** Variants one product may hold in all (the admin route refuses more). */
export const MAX_PRODUCT_VARIANTS = 200;
/** Variants one product may have ACTIVE: every one of them is public. */
export const MAX_ACTIVE_VARIANTS = 100;
/** D1 bound-parameter budget (PLAN §2.7): `IN (…)` lists are read 90 at a time. */
export const ID_CHUNK = 90;

const PRODUCT_SELECT = `SELECT
     product.product_id, product.sku, product.name, product.description,
     product.b2c_price_minor, product.currency, product.status,
     product.weight_grams, product.allow_shipping, product.allow_pickup,
     product.shipping_json, product.is_pod, product.takedown_at,
     product.updated_at, product.handle, product.featured, product.sort_order,
     product.compare_at_price_minor, product.category, product.category_key,
     product.more_info, product.size_guide, product.size, product.brand,
     product.ean_code, product.stock, product.launch_date,
     product.is_personalized, screening.status AS screening_status
   FROM products AS product
   LEFT JOIN product_screening AS screening
     ON screening.product_id = product.product_id
    AND screening.tenant_id = product.tenant_id
   WHERE product.tenant_id = ?
     AND product.product_id = ?
   LIMIT 1`;

export function chunks<T>(values: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    out.push(values.slice(start, start + size));
  }
  return out;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function emptyToNull(rates: ShippingRates | null): ShippingRates | null {
  return rates === null || Object.keys(rates).length === 0 ? null : rates;
}

/** The stored carriage table in internal form, or null when there is none. */
export function storedShippingRates(row: { shipping_json: string | null }): ShippingRates | null {
  return emptyToNull(
    normalizeShippingRates(
      row.shipping_json === null ? null : safeParseJson(row.shipping_json),
    ),
  );
}

/** Internal → admin-facing, preserving 'no table' as null rather than {}. */
export function toWire(rates: ShippingRates | null): ShippingRatesWire | null {
  return rates === null ? null : toShippingRatesWire(rates);
}

export function toAdminProduct(row: ProductRow, tags: readonly string[]): AdminProduct {
  return {
    allowPickup: row.allow_pickup === 1,
    allowShipping: row.allow_shipping === 1,
    brand: row.brand,
    category: row.category,
    compareAtPriceMinor: row.compare_at_price_minor,
    currency: row.currency,
    description: row.description,
    eanCode: row.ean_code,
    featured: row.featured === 1,
    handle: row.handle,
    isPersonalized: row.is_personalized === 1,
    isPod: row.is_pod === 1,
    launchDate: row.launch_date,
    moreInfo: row.more_info,
    name: row.name,
    priceMinor: row.b2c_price_minor,
    productId: row.product_id,
    screeningStatus: row.screening_status,
    // Re-validated on the way out with the same gate that guards the way in. A
    // row that somehow holds a malformed blob reports no table rather than
    // handing an admin a shape the checkout engine will refuse to price from.
    shippingRates: toWire(storedShippingRates(row)),
    size: row.size,
    sizeGuide: row.size_guide,
    sku: row.sku,
    sortOrder: row.sort_order,
    status: row.status,
    stock: row.stock,
    tags: [...tags],
    weightGrams: row.weight_grams,
  };
}

export async function loadProductRow(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<ProductRow | null> {
  return db.prepare(PRODUCT_SELECT).bind(tenantId, productId).first<ProductRow>();
}

export interface TagRow {
  tag: string;
  tag_key: string;
}

export async function loadProductTags(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<TagRow[]> {
  const result = await db
    .prepare(
      `SELECT tag, tag_key FROM product_tags
       WHERE tenant_id = ? AND product_id = ?
       ORDER BY position
       LIMIT ${MAX_PRODUCT_TAGS}`,
    )
    .bind(tenantId, productId)
    .all<TagRow>();
  return result.results;
}

/** The tags of many products, in each product's order. */
export async function loadTagsFor(
  db: D1Database,
  tenantId: string,
  productIds: readonly string[],
): Promise<Map<string, string[]>> {
  const tags = new Map<string, string[]>();
  const ids = [...new Set(productIds)];
  if (ids.length === 0) {
    return tags;
  }
  const results = await db.batch<{ product_id: string; tag: string }>(
    chunks(ids).map((chunk) =>
      db
        .prepare(
          `SELECT product_id, tag FROM product_tags
           WHERE tenant_id = ? AND product_id IN (${placeholders(chunk.length)})
           ORDER BY product_id, position
           LIMIT ${chunk.length * MAX_PRODUCT_TAGS}`,
        )
        .bind(tenantId, ...chunk),
    ),
  );
  for (const result of results) {
    for (const row of result.results) {
      tags.set(row.product_id, [...(tags.get(row.product_id) ?? []), row.tag]);
    }
  }
  return tags;
}

/**
 * LIVE = published and active (the Firebase `isLive` rule the screening
 * module follows): a write that leaves a product live re-screens it.
 */
export async function isProductLive(
  db: D1Database,
  tenantId: string,
  product: Pick<ProductRow, "product_id" | "status">,
): Promise<boolean> {
  if (product.status !== "active") {
    return false;
  }
  const publication = await db
    .prepare(
      "SELECT published FROM product_publications WHERE tenant_id = ? AND product_id = ? LIMIT 1",
    )
    .bind(tenantId, product.product_id)
    .first<{ published: number }>();
  return publication?.published === 1;
}

/** The whole admin product: its row and its tags. */
export async function loadAdminProduct(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<{ product: AdminProduct; row: ProductRow } | null> {
  const row = await loadProductRow(db, tenantId, productId);
  if (row === null) {
    return null;
  }
  const tags = await loadProductTags(db, tenantId, productId);
  return { product: toAdminProduct(row, tags.map((tag) => tag.tag)), row };
}

// ── variants ────────────────────────────────────────────────────────────────

export interface VariantRow {
  active: number;
  label: string;
  position: number;
  price_minor: number;
  product_id: string;
  size: string | null;
  sku: string;
  variant_group: string | null;
  variant_id: string;
}

const VARIANT_COLUMNS = `variant_id, product_id, sku, label, price_minor, active,
     variant_group, size, position`;
/** The rail's order: the admin's position, then the label and the id (a total order). */
const VARIANT_ORDER = "position, label, variant_id";

/**
 * The variants of many products, at most `perProduct` each, in rail order.
 * `activeOnly` = what a buyer can choose.
 */
export async function loadVariantsFor(
  db: D1Database,
  tenantId: string,
  productIds: readonly string[],
  options: { activeOnly: boolean; perProduct: number },
): Promise<Map<string, VariantRow[]>> {
  const variants = new Map<string, VariantRow[]>();
  const ids = [...new Set(productIds)];
  if (ids.length === 0) {
    return variants;
  }
  const results = await db.batch<VariantRow>(
    chunks(ids).map((chunk) =>
      db
        .prepare(
          `SELECT ${VARIANT_COLUMNS} FROM (
             SELECT ${VARIANT_COLUMNS},
                    ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY ${VARIANT_ORDER}) AS rank
             FROM product_variants
             WHERE tenant_id = ?
               AND product_id IN (${placeholders(chunk.length)})
               ${options.activeOnly ? "AND active = 1" : ""}
           )
           WHERE rank <= ?
           ORDER BY product_id, rank
           LIMIT ?`,
        )
        .bind(tenantId, ...chunk, options.perProduct, chunk.length * options.perProduct),
    ),
  );
  for (const result of results) {
    for (const row of result.results) {
      variants.set(row.product_id, [...(variants.get(row.product_id) ?? []), row]);
    }
  }
  return variants;
}

/** The texts of the variants a visitor can see: label, group and size. */
export function variantScreeningTexts(
  variants: readonly { label: string; size: string | null; variant_group: string | null }[],
): string[] {
  return variants.flatMap((variant) =>
    [variant.label, variant.variant_group, variant.size].filter(
      (text): text is string => text !== null,
    ),
  );
}

// ── images ──────────────────────────────────────────────────────────────────

/** One row of a product's image list, with the group facts of the variant it names. */
export interface ImageRow {
  alt: string | null;
  object_id: string;
  position: number;
  product_id: string;
  variant_active: number | null;
  variant_group: string | null;
  variant_id: string | null;
}

/** The image lists of many products, each in position order (≤ 30 rows by schema). */
export async function loadImageRowsFor(
  db: D1Database,
  tenantId: string,
  productIds: readonly string[],
): Promise<Map<string, ImageRow[]>> {
  const images = new Map<string, ImageRow[]>();
  const ids = [...new Set(productIds)];
  if (ids.length === 0) {
    return images;
  }
  const results = await db.batch<ImageRow>(
    chunks(ids).map((chunk) =>
      db
        .prepare(
          `SELECT image.product_id, image.position, image.variant_id, image.object_id,
                  image.alt, variant.variant_group AS variant_group,
                  variant.active AS variant_active
           FROM product_images AS image
           LEFT JOIN product_variants AS variant
             ON variant.variant_id = image.variant_id
            AND variant.tenant_id = image.tenant_id
            AND variant.product_id = image.product_id
           WHERE image.tenant_id = ?
             AND image.product_id IN (${placeholders(chunk.length)})
           ORDER BY image.product_id, image.position
           LIMIT ${chunk.length * MAX_PRODUCT_IMAGES}`,
        )
        .bind(tenantId, ...chunk),
    ),
  );
  for (const result of results) {
    for (const row of result.results) {
      images.set(row.product_id, [...(images.get(row.product_id) ?? []), row]);
    }
  }
  return images;
}

/**
 * THE GROUP RULE of an image row that names a variant: every variant of the
 * same group shows it (the photos of "Svart" belong to every size of
 * "Svart"); a variant without a group shows only the rows that name it.
 */
export function imageGroupKey(variantId: string, group: string | null): string {
  return group === null ? `variant:${variantId}` : `group:${group}`;
}

/** An image of a public shape: the object's address and size, and its alt text. */
export interface PublicProductImage extends PublicImage {
  alt: string | null;
}

export interface VisibleImage {
  /** null = a row of the product itself. */
  groupKey: string | null;
  image: PublicProductImage;
  /** null, or an ACTIVE variant of the row's group (never one a visitor cannot see). */
  variantId: string | null;
}

/**
 * The rows of one product a visitor may see, in list order: a row of the
 * product itself, or a row whose group has an ACTIVE variant (a sold-out
 * colour's photos are not shown), and only when its object resolved — an
 * object that is not this shop's active public product media (removed under
 * D93, never finished, another kind) is absent, and the next row moves up.
 *
 * A row may name a size that is no longer active while its colour still has
 * one: it then carries the colour's first active variant (rail order), so a
 * `variantId` in a public shape always names a variant that shape lists.
 */
export function visibleImages(
  rows: readonly ImageRow[],
  activeVariants: readonly VariantRow[],
  resolved: ReadonlyMap<string, PublicImage>,
): VisibleImage[] {
  const firstActive = new Map<string, string>();
  for (const variant of activeVariants) {
    const key = imageGroupKey(variant.variant_id, variant.variant_group);
    if (!firstActive.has(key)) {
      firstActive.set(key, variant.variant_id);
    }
  }
  const visible: VisibleImage[] = [];
  for (const row of rows) {
    const image = resolved.get(row.object_id);
    if (image === undefined) {
      continue;
    }
    if (row.variant_id === null) {
      visible.push({ groupKey: null, image: { ...image, alt: row.alt }, variantId: null });
      continue;
    }
    const groupKey = imageGroupKey(row.variant_id, row.variant_group);
    const shownAs = row.variant_active === 1 ? row.variant_id : firstActive.get(groupKey);
    if (firstActive.has(groupKey) && shownAs !== undefined) {
      visible.push({ groupKey, image: { ...image, alt: row.alt }, variantId: shownAs });
    }
  }
  return visible;
}

/** The images of one variant under the group rule, in list order. */
export function imagesOfVariant(
  variant: Pick<VariantRow, "variant_group" | "variant_id">,
  visible: readonly VisibleImage[],
): PublicProductImage[] {
  const key = imageGroupKey(variant.variant_id, variant.variant_group);
  return visible.filter((entry) => entry.groupKey === key).map((entry) => entry.image);
}

/**
 * Every object id of these lists resolved through public-objects.ts (THE
 * resolver: active, public bucket, this tenant, product media). With no `env`
 * nothing resolves — the pre-CP4 callers, which have no env, get no images.
 */
export async function resolveProductImages(
  env: Env | null,
  db: D1Database,
  tenantId: string,
  rows: Iterable<readonly ImageRow[]>,
): Promise<Map<string, PublicImage>> {
  if (env === null) {
    return new Map();
  }
  const ids: string[] = [];
  for (const list of rows) {
    for (const row of list) {
      ids.push(row.object_id);
    }
  }
  return resolvePublicImages(env, db, tenantId, ids, ["product_media"]);
}

// ── the screened texts ──────────────────────────────────────────────────────

/** Active variants read for screening; more than this many is refused upstream. */
const SCREENED_VARIANTS_LIMIT = 1_000;

/**
 * Every text of the product a visitor reads, from D1 — the input of
 * screening-core.ts productScreeningTexts (minus the artwork names, which
 * screening.ts adds). null = no such product in this shop.
 *
 * The write paths call it AFTER readScreeningGuard (THE FENCE) and overlay the
 * edit they are about to write. It is also the loader screening.ts should use
 * when a caller passes no texts (the rescreen sweep, a mapping change): see
 * the report's "Reviewer wiring".
 *
 * Plain reads, never a read `batch()`: inside a mutation the race suites
 * treat every batch as the mutation's write (the screening.ts convention).
 */
export async function loadProductScreeningInput(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<ProductScreeningInput | null> {
  const row = await db
    .prepare(
      `SELECT name, description, more_info, size_guide, category, brand, size
       FROM products WHERE tenant_id = ? AND product_id = ? LIMIT 1`,
    )
    .bind(tenantId, productId)
    .first<ScreenedProductRow>();
  if (row === null) {
    return null;
  }
  const tags = await loadProductTags(db, tenantId, productId);
  const variants = await db
    .prepare(
      `SELECT label, variant_group, size FROM product_variants
       WHERE tenant_id = ? AND product_id = ? AND active = 1
       ORDER BY ${VARIANT_ORDER} LIMIT ${SCREENED_VARIANTS_LIMIT}`,
    )
    .bind(tenantId, productId)
    .all<ScreenedVariantRow>();
  const images = await db
    .prepare(
      `SELECT alt FROM product_images WHERE tenant_id = ? AND product_id = ?
       ORDER BY position LIMIT ${MAX_PRODUCT_IMAGES}`,
    )
    .bind(tenantId, productId)
    .all<{ alt: string | null }>();
  return {
    brand: row.brand,
    category: row.category,
    description: row.description,
    imageAlts: images.results
      .map((image) => image.alt)
      .filter((alt): alt is string => alt !== null),
    moreInfo: row.more_info,
    name: row.name,
    size: row.size,
    sizeGuide: row.size_guide,
    tags: tags.map((tag) => tag.tag),
    variantTexts: variantScreeningTexts(variants.results),
  };
}

interface ScreenedProductRow {
  brand: string | null;
  category: string | null;
  description: string | null;
  more_info: string | null;
  name: string;
  size: string | null;
  size_guide: string | null;
}

interface ScreenedVariantRow {
  label: string;
  size: string | null;
  variant_group: string | null;
}

// ── the display order and its cursor ────────────────────────────────────────

/**
 * The storefront's display order (src/utils/productSorting.js): the admin's
 * sort order ascending with NULL last, then the name, then the id — a TOTAL
 * order, so a keyset over it never repeats or skips a row. The name compares
 * case-insensitively (COLLATE NOCASE, ASCII): the pages sort again with
 * `localeCompare` as they do today, so this order only has to be total and
 * close; the visible order is theirs.
 */
export interface DisplayOrderColumns {
  id: string;
  name: string;
  sortOrder: string;
}

export interface DisplayCursor {
  id: string;
  name: string;
  sortOrder: number | null;
}

const CURSOR_MAX_LENGTH = 1_500;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

function base64UrlEncode(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded =
      value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodeDisplayCursor(cursor: DisplayCursor): string {
  return base64UrlEncode(JSON.stringify([cursor.sortOrder, cursor.name, cursor.id]));
}

/**
 * The cursor back, or null for anything that is not EXACTLY a cursor this
 * module wrote (the canonical encoding only, so one position has one cursor).
 */
export function decodeDisplayCursor(value: string): DisplayCursor | null {
  if (value.length === 0 || value.length > CURSOR_MAX_LENGTH || !CURSOR_PATTERN.test(value)) {
    return null;
  }
  const text = base64UrlDecode(value);
  if (text === null) {
    return null;
  }
  const parsed = safeParseJson(text);
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    return null;
  }
  const [sortOrder, name, id] = parsed as unknown[];
  if (
    !(sortOrder === null || (typeof sortOrder === "number" && Number.isSafeInteger(sortOrder))) ||
    typeof name !== "string" ||
    name.length > 1_000 ||
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 128
  ) {
    return null;
  }
  const cursor: DisplayCursor = { id, name, sortOrder };
  return encodeDisplayCursor(cursor) === value ? cursor : null;
}

export function displayOrderBy(columns: DisplayOrderColumns): string {
  return `(${columns.sortOrder} IS NULL) ASC, ${columns.sortOrder} ASC,
     ${columns.name} COLLATE NOCASE ASC, ${columns.id} ASC`;
}

/** The rows strictly after `cursor` in displayOrderBy's order. */
export function displayOrderAfter(
  cursor: DisplayCursor,
  columns: DisplayOrderColumns,
): { binds: unknown[]; sql: string } {
  const { id, name, sortOrder } = columns;
  const afterName = `(${name} COLLATE NOCASE > ? OR (${name} COLLATE NOCASE = ? AND ${id} > ?))`;
  if (cursor.sortOrder === null) {
    return {
      binds: [cursor.name, cursor.name, cursor.id],
      sql: `(${sortOrder} IS NULL AND ${afterName})`,
    };
  }
  return {
    binds: [cursor.sortOrder, cursor.sortOrder, cursor.name, cursor.name, cursor.id],
    sql: `(${sortOrder} IS NULL
       OR ${sortOrder} > ?
       OR (${sortOrder} = ? AND ${afterName}))`,
  };
}

// ── the admin views ─────────────────────────────────────────────────────────

export const ADMIN_LIST_LIMIT = 50;
const ADMIN_LIST_MAX_LIMIT = 100;
const QUERY_MAX_LENGTH = 100;
const PRODUCT_STATUSES: readonly ProductStatus[] = ["draft", "active", "archived"];

export interface AdminProductListQuery {
  cursor: DisplayCursor | null;
  limit: number;
  /** A prefix of the name or the sku, ASCII case-insensitive. */
  q: string | null;
  status: ProductStatus | null;
}

/** `GET /v1/admin/products` query → a query, or null (400). Unknown parameters are refused. */
export function parseAdminProductListQuery(url: URL): AdminProductListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!["cursor", "limit", "q", "status"].includes(key) || params.getAll(key).length > 1) {
      return null;
    }
  }
  const limitRaw = params.get("limit");
  if (limitRaw !== null && !/^\d{1,3}$/.test(limitRaw)) {
    return null;
  }
  const limit = limitRaw === null ? ADMIN_LIST_LIMIT : Number(limitRaw);
  if (limit < 1 || limit > ADMIN_LIST_MAX_LIMIT) {
    return null;
  }
  const cursorRaw = params.get("cursor");
  const cursor = cursorRaw === null ? null : decodeDisplayCursor(cursorRaw);
  if (cursorRaw !== null && cursor === null) {
    return null;
  }
  const status = params.get("status");
  if (status !== null && !(PRODUCT_STATUSES as readonly string[]).includes(status)) {
    return null;
  }
  const q = params.get("q");
  if (
    q !== null &&
    (q.length === 0 || q.length > QUERY_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(q))
  ) {
    return null;
  }
  return { cursor, limit, q, status: status as ProductStatus | null };
}

export interface AdminProductListItem {
  category: string | null;
  currency: string;
  featured: boolean;
  handle: string;
  /** The main image: the first row of the list whose object resolves. */
  image: PublicProductImage | null;
  isPod: boolean;
  name: string;
  priceMinor: number;
  productId: string;
  /** The publication's own flag (published by the admin); eligibility may still hide it. */
  published: boolean;
  screeningStatus: ScreeningStatus | null;
  sku: string;
  sortOrder: number | null;
  status: ProductStatus;
  takenDown: boolean;
  updatedAt: string;
}

interface AdminListRow {
  b2c_price_minor: number;
  category: string | null;
  currency: string;
  featured: number;
  handle: string;
  is_pod: number;
  name: string;
  product_id: string;
  published: number | null;
  screening_status: ScreeningStatus | null;
  sku: string;
  sort_order: number | null;
  status: ProductStatus;
  takedown_at: string | null;
  updated_at: number;
}

const ADMIN_ORDER_COLUMNS: DisplayOrderColumns = {
  id: "product.product_id",
  name: "product.name",
  sortOrder: "product.sort_order",
};

function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** The first row of a list whose object resolved, whatever it names. */
function firstResolved(
  rows: readonly ImageRow[] | undefined,
  resolved: ReadonlyMap<string, PublicImage>,
): PublicProductImage | null {
  for (const row of rows ?? []) {
    const image = resolved.get(row.object_id);
    if (image !== undefined) {
      return { ...image, alt: row.alt };
    }
  }
  return null;
}

/** GET /v1/admin/products — every product of the shop, in the display order. */
export async function listAdminProducts(
  env: Env,
  db: D1Database,
  tenantId: string,
  query: AdminProductListQuery,
): Promise<{ nextCursor: string | null; products: AdminProductListItem[] }> {
  const where = ["product.tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (query.status !== null) {
    where.push("product.status = ?");
    binds.push(query.status);
  }
  if (query.q !== null) {
    where.push("(product.name LIKE ? ESCAPE '\\' OR product.sku LIKE ? ESCAPE '\\')");
    binds.push(likePrefix(query.q), likePrefix(query.q));
  }
  if (query.cursor !== null) {
    const after = displayOrderAfter(query.cursor, ADMIN_ORDER_COLUMNS);
    where.push(after.sql);
    binds.push(...after.binds);
  }
  const rows = await db
    .prepare(
      `SELECT product.product_id, product.sku, product.name, product.handle,
              product.status, product.b2c_price_minor, product.currency,
              product.featured, product.sort_order, product.category,
              product.is_pod, product.takedown_at, product.updated_at,
              publication.published AS published,
              screening.status AS screening_status
       FROM products AS product
       LEFT JOIN product_publications AS publication
         ON publication.product_id = product.product_id
        AND publication.tenant_id = product.tenant_id
       LEFT JOIN product_screening AS screening
         ON screening.product_id = product.product_id
        AND screening.tenant_id = product.tenant_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${displayOrderBy(ADMIN_ORDER_COLUMNS)}
       LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<AdminListRow>();

  const page = rows.results.slice(0, query.limit);
  const imageRows = await loadImageRowsFor(db, tenantId, page.map((row) => row.product_id));
  const resolved = await resolveProductImages(env, db, tenantId, imageRows.values());
  const last = page.at(-1);
  return {
    nextCursor:
      rows.results.length > query.limit && last !== undefined
        ? encodeDisplayCursor({ id: last.product_id, name: last.name, sortOrder: last.sort_order })
        : null,
    products: page.map((row) => ({
      category: row.category,
      currency: row.currency,
      featured: row.featured === 1,
      handle: row.handle,
      image: firstResolved(imageRows.get(row.product_id), resolved),
      isPod: row.is_pod === 1,
      name: row.name,
      priceMinor: row.b2c_price_minor,
      productId: row.product_id,
      published: row.published === 1,
      screeningStatus: row.screening_status,
      sku: row.sku,
      sortOrder: row.sort_order,
      status: row.status,
      takenDown: row.takedown_at !== null,
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
  };
}

export interface AdminVariant {
  active: boolean;
  group: string | null;
  label: string;
  position: number;
  priceMinor: number;
  size: string | null;
  sku: string;
  variantId: string;
}

export function toAdminVariant(row: VariantRow): AdminVariant {
  return {
    active: row.active === 1,
    group: row.variant_group,
    label: row.label,
    position: row.position,
    priceMinor: row.price_minor,
    size: row.size,
    sku: row.sku,
    variantId: row.variant_id,
  };
}

export interface AdminProductImage {
  alt: string | null;
  /** The object as a visitor would see it; null = it no longer resolves (removed, D93). */
  image: PublicImage | null;
  objectId: string;
  position: number;
  variantId: string | null;
}

export function toAdminImages(
  rows: readonly ImageRow[],
  resolved: ReadonlyMap<string, PublicImage>,
): AdminProductImage[] {
  return rows.map((row) => ({
    alt: row.alt,
    image: resolved.get(row.object_id) ?? null,
    objectId: row.object_id,
    position: row.position,
    variantId: row.variant_id,
  }));
}

export interface AdminProductDetail {
  images: AdminProductImage[];
  product: AdminProduct;
  publication: { published: boolean; publishedAt: string | null } | null;
  variants: AdminVariant[];
  /** True when the product holds more variants than the admin read shows (an import). */
  variantsTruncated: boolean;
}

/** GET /v1/admin/products/:productId — one product with its variants, images and tags. */
export async function getAdminProductDetail(
  env: Env,
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<AdminProductDetail | null> {
  const loaded = await loadAdminProduct(db, tenantId, productId);
  if (loaded === null) {
    return null;
  }
  const publication = await db
    .prepare(
      `SELECT published, published_at FROM product_publications
       WHERE tenant_id = ? AND product_id = ? LIMIT 1`,
    )
    .bind(tenantId, productId)
    .first<{ published: number; published_at: number | null }>();
  const variants =
    (
      await loadVariantsFor(db, tenantId, [productId], {
        activeOnly: false,
        perProduct: MAX_PRODUCT_VARIANTS + 1,
      })
    ).get(productId) ?? [];
  const imageRows = (await loadImageRowsFor(db, tenantId, [productId])).get(productId) ?? [];
  const resolved = await resolveProductImages(env, db, tenantId, [imageRows]);
  return {
    images: toAdminImages(imageRows, resolved),
    product: loaded.product,
    publication:
      publication === null
        ? null
        : {
            published: publication.published === 1,
            publishedAt:
              publication.published_at === null
                ? null
                : new Date(publication.published_at).toISOString(),
          },
    variants: variants.slice(0, MAX_PRODUCT_VARIANTS).map(toAdminVariant),
    variantsTruncated: variants.length > MAX_PRODUCT_VARIANTS,
  };
}
