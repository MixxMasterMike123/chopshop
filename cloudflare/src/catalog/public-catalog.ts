import type { TenantContext } from "../tenancy/resolve-tenant";
import type { PublicPodFields } from "../pod/pod-mappings";
import { publicPodFields } from "../pod/pod-mappings";
import { productPath } from "./admin-catalog";
import type {
  DisplayCursor,
  DisplayOrderColumns,
  ImageRow,
  PublicProductImage,
  VariantRow,
  VisibleImage,
} from "./admin-product-reads";
import {
  chunks,
  displayOrderAfter,
  displayOrderBy,
  encodeDisplayCursor,
  imagesOfVariant,
  loadImageRowsFor,
  loadTagsFor,
  loadVariantsFor,
  MAX_ACTIVE_VARIANTS,
  placeholders,
  resolveProductImages,
  visibleImages,
} from "./admin-product-reads";
import {
  ELIGIBLE_PRODUCTS_FROM,
  PUBLIC_ELIGIBILITY_PREDICATE,
} from "./eligibility";

export type { PublicProductImage } from "./admin-product-reads";

/**
 * The public product shapes (CP4-A). EVERY read here goes through THE
 * predicate (src/catalog/eligibility.ts, unchanged) — the same fragment
 * checkout and the preview route use — and names the tenant twice (the
 * publication's and the product's). What a shape carries beyond the
 * predicate's row (tags, variants, images) is read for the product ids that
 * row set admitted, again by tenant, so nothing of a draft, a hidden product
 * or another shop can reach a public shape through them.
 */

/** One card's variant hint: a distinct group (or label) and its first image. */
export interface PublicProductSwatch {
  image: PublicProductImage | null;
  label: string;
}

export interface PublicProductSummary {
  category: string | null;
  compareAtPriceMinor: number | null;
  currency: string;
  description: string | null;
  featured: boolean;
  handle: string;
  /** The main image: the first row of the list a visitor may see, or null. */
  image: PublicProductImage | null;
  /** True when the active variants are priced differently ("från" on the card). */
  isFromPrice: boolean;
  /** The cheapest active variant priced above zero, else the product's price. */
  lowestPriceMinor: number;
  name: string;
  /** Relative to the shop's root: "/product/<handle>". */
  path: string;
  priceMinor: number;
  productId: string;
  sku: string;
  sortOrder: number | null;
  swatches: PublicProductSwatch[];
  tags: string[];
}

export interface PublicProductVariant {
  group: string | null;
  /** The first of `images`, or null. */
  image: PublicProductImage | null;
  /** The variant's group's images (admin-product-reads.ts, THE GROUP RULE). */
  images: PublicProductImage[];
  label: string;
  position: number;
  priceMinor: number;
  size: string | null;
  sku: string;
  variantId: string;
}

export interface PublicProductDetail extends PublicProductSummary {
  allowPickup: boolean;
  allowShipping: boolean;
  brand: string | null;
  eanCode: string | null;
  /** Every row a visitor may see, in list order; `variantId` as the row names it. */
  images: (PublicProductImage & { variantId: string | null })[];
  isPersonalized: boolean;
  launchDate: string | null;
  moreInfo: string | null;
  /**
   * null for a non-POD product. For a POD product: the print areas (slot + mm)
   * and preview paths of its active mappings — never a printer, an SKU of the
   * printer, or a cost (A13).
   */
  pod: PublicPodFields | null;
  size: string | null;
  sizeGuide: string | null;
  stock: number | null;
  variants: PublicProductVariant[];
}

/** GET /v1/products: every filter is optional; they combine with AND. */
export interface PublicProductFilter {
  /** A category's address form (categoryKey), as in /kategori/<key>. */
  category?: string | null;
  cursor?: DisplayCursor | null;
  featured?: boolean;
  /** 1–100 (default 100). */
  limit?: number;
  /** A tag's address form (productTagKey), as in /tagg/<key>. */
  tag?: string | null;
}

export interface PublicProductPage {
  /** Pass back as `cursor` for the next page; null = this was the last. */
  nextCursor: string | null;
  products: PublicProductSummary[];
}

interface ProductRow {
  allow_pickup: number;
  allow_shipping: number;
  brand: string | null;
  catalog_version?: number;
  category: string | null;
  compare_at_price_minor: number | null;
  currency: string;
  ean_code: string | null;
  featured: number;
  handle: string;
  is_personalized: number;
  is_pod: number;
  launch_date: string | null;
  more_info: string | null;
  product_id: string;
  public_description: string | null;
  public_name: string;
  public_price_minor: number;
  size: string | null;
  size_guide: string | null;
  sku: string;
  sort_order: number | null;
  stock: number | null;
}

export const PUBLIC_PRODUCT_LIMIT = 100;
/** listPublicProductsByIds reads at most one page. */
export const MAX_PUBLIC_PRODUCTS_BY_IDS = 100;

// THE predicate (src/catalog/eligibility.ts) — the same fragment checkout and
// the preview route use, so the three can never disagree about what is public.
const PUBLIC_PRODUCT_COLUMNS = `SELECT
     publication.product_id AS product_id,
     publication.public_name AS public_name,
     publication.public_description AS public_description,
     publication.public_price_minor AS public_price_minor,
     publication.currency AS currency,
     product.sku AS sku,
     product.is_pod AS is_pod,
     product.handle AS handle,
     product.featured AS featured,
     product.sort_order AS sort_order,
     product.compare_at_price_minor AS compare_at_price_minor,
     product.category AS category,
     product.more_info AS more_info,
     product.size_guide AS size_guide,
     product.size AS size,
     product.brand AS brand,
     product.ean_code AS ean_code,
     product.stock AS stock,
     product.launch_date AS launch_date,
     product.is_personalized AS is_personalized,
     product.allow_shipping AS allow_shipping,
     product.allow_pickup AS allow_pickup
   ${ELIGIBLE_PRODUCTS_FROM}
   WHERE publication.tenant_id = ?
     AND product.tenant_id = ?
     AND ${PUBLIC_ELIGIBILITY_PREDICATE}`;

/** The public list order: the shape's own name, the publication's. */
const PUBLIC_ORDER_COLUMNS: DisplayOrderColumns = {
  id: "publication.product_id",
  name: "publication.public_name",
  sortOrder: "product.sort_order",
};

function catalogVersionStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare("SELECT catalog_version FROM tenants WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId);
}

function pageLimit(filter: PublicProductFilter): number {
  const limit = filter.limit ?? PUBLIC_PRODUCT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PUBLIC_PRODUCT_LIMIT) {
    throw new RangeError(`public product limit must be 1–${PUBLIC_PRODUCT_LIMIT}`);
  }
  return limit;
}

/** One page of the list (limit + 1 rows: the extra one only says "there is more"). */
function listStatement(
  db: D1Database,
  tenant: TenantContext,
  filter: PublicProductFilter,
): D1PreparedStatement {
  const where: string[] = [];
  const binds: unknown[] = [tenant.tenantId, tenant.tenantId];
  if (filter.featured === true) {
    where.push("product.featured = 1");
  }
  if (filter.category !== undefined && filter.category !== null) {
    where.push("product.category_key = ?");
    binds.push(filter.category);
  }
  if (filter.tag !== undefined && filter.tag !== null) {
    where.push(`EXISTS (
       SELECT 1 FROM product_tags AS tagged
       WHERE tagged.tenant_id = product.tenant_id
         AND tagged.product_id = product.product_id
         AND tagged.tag_key = ?
     )`);
    binds.push(filter.tag);
  }
  if (filter.cursor !== undefined && filter.cursor !== null) {
    const after = displayOrderAfter(filter.cursor, PUBLIC_ORDER_COLUMNS);
    where.push(after.sql);
    binds.push(...after.binds);
  }
  return db
    .prepare(
      `${PUBLIC_PRODUCT_COLUMNS}
       ${where.map((clause) => `AND ${clause}`).join("\n       ")}
       ORDER BY ${displayOrderBy(PUBLIC_ORDER_COLUMNS)}
       LIMIT ?`,
    )
    .bind(...binds, pageLimit(filter) + 1);
}

type DetailMatch = { id: string } | { ref: string };

/**
 * The source system's product page found its product by the sku after the
 * LAST "_" of the address (productUrls.js getSkuFromSlug), so an address
 * made before a rename still resolves. null when there is none.
 */
function skuFromRef(ref: string): string | null {
  const underscore = ref.lastIndexOf("_");
  const sku = underscore === -1 ? "" : ref.slice(underscore + 1);
  return sku.length === 0 ? null : sku;
}

function detailStatement(
  db: D1Database,
  tenant: TenantContext,
  match: DetailMatch,
): D1PreparedStatement {
  if ("id" in match) {
    return db
      .prepare(
        `${PUBLIC_PRODUCT_COLUMNS}
           AND publication.product_id = ?
         LIMIT 1`,
      )
      .bind(tenant.tenantId, tenant.tenantId, match.id);
  }
  const sku = skuFromRef(match.ref);
  // The id first, then the handle, then the source system's sku rule; each
  // is unique in the shop, so the order only decides between two products
  // when one's handle is another's id (never in practice), and decides it
  // the same way every time.
  return db
    .prepare(
      `${PUBLIC_PRODUCT_COLUMNS}
         AND (
           publication.product_id = ?
           OR product.handle = ?
           OR (? IS NOT NULL AND product.sku = ?)
         )
       ORDER BY CASE
         WHEN publication.product_id = ? THEN 0
         WHEN product.handle = ? THEN 1
         ELSE 2
       END
       LIMIT 1`,
    )
    .bind(
      tenant.tenantId,
      tenant.tenantId,
      match.ref,
      match.ref,
      sku,
      sku,
      match.ref,
      match.ref,
    );
}

/** What the rows of a set of products carry besides the predicate's row. */
interface ProductParts {
  images: Map<string, VisibleImage[]>;
  tags: Map<string, string[]>;
  variants: Map<string, VariantRow[]>;
}

async function loadParts(
  env: Env | null,
  db: D1Database,
  tenantId: string,
  productIds: readonly string[],
): Promise<ProductParts> {
  const tags = await loadTagsFor(db, tenantId, productIds);
  const variants = await loadVariantsFor(db, tenantId, productIds, {
    activeOnly: true,
    perProduct: MAX_ACTIVE_VARIANTS,
  });
  const imageRows = await loadImageRowsFor(db, tenantId, productIds);
  const resolved = await resolveProductImages(env, db, tenantId, imageRows.values());
  const images = new Map<string, VisibleImage[]>();
  for (const productId of productIds) {
    images.set(
      productId,
      visibleImages(
        imageRows.get(productId) ?? ([] as ImageRow[]),
        variants.get(productId) ?? [],
        resolved,
      ),
    );
  }
  return { images, tags, variants };
}

/** getCardPrice (src/utils/productPricing.js): the cheapest positive variant price. */
function cardPrice(basePriceMinor: number, variants: readonly VariantRow[]): {
  isFromPrice: boolean;
  lowestPriceMinor: number;
} {
  const prices = variants.map((variant) => variant.price_minor).filter((price) => price > 0);
  if (prices.length === 0) {
    return { isFromPrice: false, lowestPriceMinor: basePriceMinor };
  }
  const lowest = Math.min(...prices);
  return { isFromPrice: Math.max(...prices) > lowest, lowestPriceMinor: lowest };
}

/**
 * The card's variant hint (NordProductCard.jsx variantGroups): one entry per
 * distinct group — or label, for a variant without one — in rail order, with
 * the first image of its first variant.
 */
function swatchesOf(
  variants: readonly VariantRow[],
  visible: readonly VisibleImage[],
): PublicProductSwatch[] {
  const seen = new Set<string>();
  const swatches: PublicProductSwatch[] = [];
  for (const variant of variants) {
    const label = (variant.variant_group ?? variant.label).trim();
    if (label === "" || seen.has(label)) {
      continue;
    }
    seen.add(label);
    swatches.push({ image: imagesOfVariant(variant, visible)[0] ?? null, label });
  }
  return swatches;
}

function toSummary(row: ProductRow, parts: ProductParts): PublicProductSummary {
  const variants = parts.variants.get(row.product_id) ?? [];
  const visible = parts.images.get(row.product_id) ?? [];
  return {
    category: row.category,
    compareAtPriceMinor: row.compare_at_price_minor,
    currency: row.currency,
    description: row.public_description,
    featured: row.featured === 1,
    handle: row.handle,
    image: visible[0]?.image ?? null,
    ...cardPrice(row.public_price_minor, variants),
    name: row.public_name,
    path: productPath(row.handle),
    priceMinor: row.public_price_minor,
    productId: row.product_id,
    sku: row.sku,
    sortOrder: row.sort_order,
    swatches: swatchesOf(variants, visible),
    tags: parts.tags.get(row.product_id) ?? [],
  };
}

/**
 * The ids among `productIds` that THE predicate still admits, asked AFTER the
 * tags, variants and images were read. Those reads run after the product row
 * was selected, so an edit in between can put a text on the product that was
 * never approved — and the same batch that writes it blocks the product. A
 * product that is no longer admitted is left out of the answer, with whatever
 * was read for it.
 */
async function stillPublic(
  db: D1Database,
  tenant: TenantContext,
  productIds: readonly string[],
): Promise<Set<string>> {
  const admitted = new Set<string>();
  const ids = [...new Set(productIds)];
  if (ids.length === 0) {
    return admitted;
  }
  const results = await db.batch<{ product_id: string }>(
    chunks(ids).map((chunk) =>
      db
        .prepare(
          `SELECT publication.product_id AS product_id
           ${ELIGIBLE_PRODUCTS_FROM}
           WHERE publication.tenant_id = ?
             AND product.tenant_id = ?
             AND ${PUBLIC_ELIGIBILITY_PREDICATE}
             AND publication.product_id IN (${placeholders(chunk.length)})
           LIMIT ${chunk.length}`,
        )
        .bind(tenant.tenantId, tenant.tenantId, ...chunk),
    ),
  );
  for (const result of results) {
    for (const row of result.results) {
      admitted.add(row.product_id);
    }
  }
  return admitted;
}

async function toSummaries(
  env: Env | null,
  db: D1Database,
  tenant: TenantContext,
  rows: readonly ProductRow[],
): Promise<PublicProductSummary[]> {
  const ids = rows.map((row) => row.product_id);
  const parts = await loadParts(env, db, tenant.tenantId, ids);
  const admitted = await stillPublic(db, tenant, ids);
  return rows.filter((row) => admitted.has(row.product_id)).map((row) => toSummary(row, parts));
}

async function toDetail(
  env: Env | null,
  db: D1Database,
  tenant: TenantContext,
  row: ProductRow,
): Promise<PublicProductDetail | null> {
  const parts = await loadParts(env, db, tenant.tenantId, [row.product_id]);
  const pod = row.is_pod === 1 ? await publicPodFields(db, tenant.tenantId, row.product_id) : null;
  // Asked last: see stillPublic.
  if (!(await stillPublic(db, tenant, [row.product_id])).has(row.product_id)) {
    return null;
  }
  const visible = parts.images.get(row.product_id) ?? [];
  return {
    ...toSummary(row, parts),
    allowPickup: row.allow_pickup === 1,
    allowShipping: row.allow_shipping === 1,
    brand: row.brand,
    eanCode: row.ean_code,
    images: visible.map((entry) => ({ ...entry.image, variantId: entry.variantId })),
    isPersonalized: row.is_personalized === 1,
    launchDate: row.launch_date,
    moreInfo: row.more_info,
    pod,
    size: row.size,
    sizeGuide: row.size_guide,
    stock: row.stock,
    variants: (parts.variants.get(row.product_id) ?? []).map((variant) => {
      const images = imagesOfVariant(variant, visible);
      return {
        group: variant.variant_group,
        image: images[0] ?? null,
        images,
        label: variant.label,
        position: variant.position,
        priceMinor: variant.price_minor,
        size: variant.size,
        sku: variant.sku,
        variantId: variant.variant_id,
      };
    }),
  };
}

function toPage(
  rows: readonly ProductRow[],
  limit: number,
  summaries: PublicProductSummary[],
): PublicProductPage {
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return {
    nextCursor:
      last === undefined
        ? null
        : encodeDisplayCursor({
            id: last.product_id,
            name: last.public_name,
            sortOrder: last.sort_order,
          }),
    products: summaries,
  };
}

async function listPage(
  env: Env | null,
  db: D1Database,
  tenant: TenantContext,
  filter: PublicProductFilter,
): Promise<PublicProductPage> {
  const limit = pageLimit(filter);
  const result = await listStatement(db, tenant, filter).all<ProductRow>();
  const page = result.results.slice(0, limit);
  return toPage(result.results, limit, await toSummaries(env, db, tenant, page));
}

// ── the functions B and D call ──────────────────────────────────────────────

/**
 * One page of the shop's public products in the display order (sort order,
 * NULL last, then name, then id), filtered by tag, category and featured.
 * A keyset cursor: a product unpublished between two pages is simply absent,
 * nothing repeats and nothing is skipped. Throws RangeError on a limit
 * outside 1–100 (a caller's bug; the route validates first).
 */
export function listPublicProductPage(
  env: Env,
  db: D1Database,
  tenant: TenantContext,
  filter: PublicProductFilter,
): Promise<PublicProductPage> {
  return listPage(env, db, tenant, filter);
}

/**
 * The public products among `productIds`, IN THE ORDER GIVEN (a manual
 * collection's order), duplicates once; an id THE predicate refuses — a draft,
 * a hidden product, another shop's — is dropped without a trace. At most 100
 * distinct ids (one page); more throws RangeError.
 */
export async function listPublicProductsByIds(
  env: Env,
  db: D1Database,
  tenant: TenantContext,
  productIds: readonly string[],
): Promise<PublicProductSummary[]> {
  const ids = [...new Set(productIds)];
  if (ids.length > MAX_PUBLIC_PRODUCTS_BY_IDS) {
    throw new RangeError(`at most ${MAX_PUBLIC_PRODUCTS_BY_IDS} product ids per call`);
  }
  if (ids.length === 0) {
    return [];
  }
  const results = await db.batch<ProductRow>(
    chunks(ids).map((chunk) =>
      db
        .prepare(
          `${PUBLIC_PRODUCT_COLUMNS}
             AND publication.product_id IN (${placeholders(chunk.length)})
           LIMIT ${chunk.length}`,
        )
        .bind(tenant.tenantId, tenant.tenantId, ...chunk),
    ),
  );
  const byId = new Map<string, ProductRow>();
  for (const result of results) {
    for (const row of result.results) {
      byId.set(row.product_id, row);
    }
  }
  const rows = ids
    .map((id) => byId.get(id))
    .filter((row): row is ProductRow => row !== undefined);
  return toSummaries(env, db, tenant, rows);
}

/** One public product by its id, its handle, or the source system's sku rule; null otherwise. */
export async function getPublicProductByRef(
  env: Env,
  db: D1Database,
  tenant: TenantContext,
  ref: string,
): Promise<PublicProductDetail | null> {
  if (ref.length === 0) {
    return null;
  }
  const row = await detailStatement(db, tenant, { ref }).first<ProductRow>();
  return row === null ? null : toDetail(env, db, tenant, row);
}

// ── versioned reads (ETag = tenants.catalog_version, PLAN §2.4) ────────────
//
// The version and the data are read in ONE D1 batch — a single implicit
// transaction — so the version labels exactly the snapshot the body was built
// from. Reading them separately could label an older body with a newer
// version, and a client would then keep that stale body across a 304 until
// the next bump. The tag, variant, image and object reads that follow run
// outside that snapshot; any change to them bumps the version (by trigger,
// migrations/0025 and 0040), so at worst the body is NEWER than its label —
// which costs one extra full response, never a stale 304.

export interface Versioned<T> {
  catalogVersion: number;
  value: T;
}

function versionOf(result: D1Result | undefined): number | undefined {
  return (result?.results[0] as { catalog_version: number } | undefined)?.catalog_version;
}

/** GET /v1/products. null = no such tenant. */
export async function listPublicProductPageVersioned(
  env: Env,
  db: D1Database,
  tenant: TenantContext,
  filter: PublicProductFilter,
): Promise<Versioned<PublicProductPage> | null> {
  const limit = pageLimit(filter);
  const [version, list] = await db.batch<{ catalog_version: number } | ProductRow>([
    catalogVersionStatement(db, tenant.tenantId),
    listStatement(db, tenant, filter),
  ]);
  const catalogVersion = versionOf(version);
  if (catalogVersion === undefined) {
    return null;
  }
  const rows = (list?.results ?? []) as ProductRow[];
  const page = rows.slice(0, limit);
  return {
    catalogVersion,
    value: toPage(rows, limit, await toSummaries(env, db, tenant, page)),
  };
}

/** GET /v1/products/:ref. null = no such tenant; a null value = no such public product. */
export async function getPublicProductByRefVersioned(
  env: Env,
  db: D1Database,
  tenant: TenantContext,
  ref: string,
): Promise<Versioned<PublicProductDetail | null> | null> {
  const [version, detail] = await db.batch<{ catalog_version: number } | ProductRow>([
    catalogVersionStatement(db, tenant.tenantId),
    detailStatement(db, tenant, { ref }),
  ]);
  const catalogVersion = versionOf(version);
  if (catalogVersion === undefined) {
    return null;
  }
  const row = (detail?.results[0] as ProductRow | undefined) ?? null;
  return {
    catalogVersion,
    value: row === null ? null : await toDetail(env, db, tenant, row),
  };
}

// ── the pre-CP4 signatures ──────────────────────────────────────────────────
//
// Kept with their exact signatures for their callers outside this builder's
// files: src/storefront/public-routes.ts (the GET mounts that the CP4-A
// mounts now precede), src/storefront/seo.ts, and the CP2/CP3 suites. They
// run the SAME queries as the functions above, with no `env`, so their shapes
// carry no image (`image: null`, `images: []`); the reviewer's consolidation
// moves their callers to the functions above and removes them.

/** @deprecated Use listPublicProductPage (images, filters, cursor). The first page, no images. */
export async function listPublicProducts(
  db: D1Database,
  tenant: TenantContext,
): Promise<PublicProductSummary[]> {
  return (await listPage(null, db, tenant, {})).products;
}

/** @deprecated Use getPublicProductByRef. By product id only, no images. */
export async function getPublicProduct(
  db: D1Database,
  tenant: TenantContext,
  productId: string,
): Promise<PublicProductDetail | null> {
  if (productId.length === 0) {
    return null;
  }

  const row = await detailStatement(db, tenant, { id: productId }).first<ProductRow>();
  return row === null ? null : toDetail(null, db, tenant, row);
}

/** @deprecated Use listPublicProductPageVersioned. The first page, no images. */
export async function listPublicProductsVersioned(
  db: D1Database,
  tenant: TenantContext,
): Promise<Versioned<PublicProductSummary[]> | null> {
  const [version, list] = await db.batch<{ catalog_version: number } | ProductRow>([
    catalogVersionStatement(db, tenant.tenantId),
    listStatement(db, tenant, {}),
  ]);
  const catalogVersion = versionOf(version);
  if (catalogVersion === undefined) {
    return null;
  }
  const rows = ((list?.results ?? []) as ProductRow[]).slice(0, PUBLIC_PRODUCT_LIMIT);
  return { catalogVersion, value: await toSummaries(null, db, tenant, rows) };
}

/** @deprecated Use getPublicProductByRefVersioned. By product id only, no images. */
export async function getPublicProductVersioned(
  db: D1Database,
  tenant: TenantContext,
  productId: string,
): Promise<Versioned<PublicProductDetail | null> | null> {
  const [version, detail] = await db.batch<{ catalog_version: number } | ProductRow>([
    catalogVersionStatement(db, tenant.tenantId),
    detailStatement(db, tenant, { id: productId }),
  ]);
  const catalogVersion = versionOf(version);
  if (catalogVersion === undefined) {
    return null;
  }
  const row = (detail?.results[0] as ProductRow | undefined) ?? null;
  return {
    catalogVersion,
    value: row === null ? null : await toDetail(null, db, tenant, row),
  };
}

/**
 * The preview object for GET /v1/storefront/pod-previews/:productId/:artworkId —
 * answered only while the product passes THE predicate and an ACTIVE mapping of
 * it prints that artwork. Checked per request, so a takedown or a deleted
 * mapping stops the image on the next request (no signed URL outlives it).
 */
export async function findPublicPreview(
  db: D1Database,
  tenant: TenantContext,
  productId: string,
  artworkId: string,
): Promise<{ key: string; sha256: string } | null> {
  const row = await db
    .prepare(
      `SELECT artwork.preview_object_key AS preview_key, artwork.preview_sha256 AS preview_sha256
       ${ELIGIBLE_PRODUCTS_FROM}
       INNER JOIN pod_mappings AS mapping
         ON mapping.product_id = product.product_id
        AND mapping.tenant_id = product.tenant_id
       INNER JOIN pod_artwork AS artwork
         ON artwork.artwork_id = mapping.artwork_id
        AND artwork.tenant_id = mapping.tenant_id
       WHERE publication.tenant_id = ?
         AND product.tenant_id = ?
         AND product.product_id = ?
         AND mapping.artwork_id = ?
         AND mapping.status = 'active'
         AND artwork.status = 'ready'
         AND ${PUBLIC_ELIGIBILITY_PREDICATE}
       LIMIT 1`,
    )
    .bind(tenant.tenantId, tenant.tenantId, productId, artworkId)
    .first<{ preview_key: string | null; preview_sha256: string | null }>();
  if (
    row === null ||
    row.preview_key === null ||
    row.preview_sha256 === null ||
    // Containment, re-proved: only this tenant's server-owned preview prefix.
    !row.preview_key.startsWith(`pod/${tenant.tenantId}/preview/`)
  ) {
    return null;
  }
  return { key: row.preview_key, sha256: row.preview_sha256 };
}
