import type { TenantContext } from "../tenancy/resolve-tenant";
import type { PublicPodFields } from "../pod/pod-mappings";
import { publicPodFields } from "../pod/pod-mappings";
import {
  ELIGIBLE_PRODUCTS_FROM,
  PUBLIC_ELIGIBILITY_PREDICATE,
} from "./eligibility";

export interface PublicProductSummary {
  currency: string;
  description: string | null;
  name: string;
  priceMinor: number;
  productId: string;
  sku: string;
}

export interface PublicProductVariant {
  label: string;
  priceMinor: number;
  sku: string;
  variantId: string;
}

export interface PublicProductDetail extends PublicProductSummary {
  /**
   * null for a non-POD product. For a POD product: the print areas (slot + mm)
   * and preview paths of its active mappings — never a printer, an SKU of the
   * printer, or a cost (A13).
   */
  pod: PublicPodFields | null;
  variants: PublicProductVariant[];
}

interface ProductRow {
  catalog_version?: number;
  currency: string;
  is_pod: number;
  product_id: string;
  public_description: string | null;
  public_name: string;
  public_price_minor: number;
  sku: string;
}

interface VariantRow {
  label: string;
  price_minor: number;
  sku: string;
  variant_id: string;
}

const PUBLIC_PRODUCT_LIMIT = 100;
const PUBLIC_VARIANT_LIMIT = 100;

// THE predicate (src/catalog/eligibility.ts) — the same fragment checkout and
// the preview route use, so the three can never disagree about what is public.
const PUBLIC_PRODUCT_COLUMNS = `SELECT
     publication.product_id AS product_id,
     publication.public_name AS public_name,
     publication.public_description AS public_description,
     publication.public_price_minor AS public_price_minor,
     publication.currency AS currency,
     product.sku AS sku,
     product.is_pod AS is_pod
   ${ELIGIBLE_PRODUCTS_FROM}
   WHERE publication.tenant_id = ?
     AND product.tenant_id = ?
     AND ${PUBLIC_ELIGIBILITY_PREDICATE}`;

function toSummary(row: ProductRow): PublicProductSummary {
  return {
    currency: row.currency,
    description: row.public_description,
    name: row.public_name,
    priceMinor: row.public_price_minor,
    productId: row.product_id,
    sku: row.sku,
  };
}

function catalogVersionStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare("SELECT catalog_version FROM tenants WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId);
}

function listStatement(db: D1Database, tenant: TenantContext): D1PreparedStatement {
  return db
    .prepare(
      `${PUBLIC_PRODUCT_COLUMNS}
       ORDER BY publication.public_name ASC, publication.product_id ASC
       LIMIT ${PUBLIC_PRODUCT_LIMIT}`,
    )
    .bind(tenant.tenantId, tenant.tenantId);
}

function detailStatement(
  db: D1Database,
  tenant: TenantContext,
  productId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `${PUBLIC_PRODUCT_COLUMNS}
         AND publication.product_id = ?
       LIMIT 1`,
    )
    .bind(tenant.tenantId, tenant.tenantId, productId);
}

export async function listPublicProducts(
  db: D1Database,
  tenant: TenantContext,
): Promise<PublicProductSummary[]> {
  const result = await listStatement(db, tenant).all<ProductRow>();
  return result.results.map(toSummary);
}

async function toDetail(
  db: D1Database,
  tenant: TenantContext,
  row: ProductRow,
): Promise<PublicProductDetail> {
  const variants = await db
    .prepare(
      `SELECT
         variant.variant_id AS variant_id,
         variant.sku AS sku,
         variant.label AS label,
         variant.price_minor AS price_minor
       FROM product_variants AS variant
       WHERE variant.tenant_id = ?
         AND variant.product_id = ?
         AND variant.active = 1
       ORDER BY variant.label ASC, variant.variant_id ASC
       LIMIT ${PUBLIC_VARIANT_LIMIT}`,
    )
    .bind(tenant.tenantId, row.product_id)
    .all<VariantRow>();

  return {
    ...toSummary(row),
    pod: row.is_pod === 1 ? await publicPodFields(db, tenant.tenantId, row.product_id) : null,
    variants: variants.results.map((variant) => ({
      label: variant.label,
      priceMinor: variant.price_minor,
      sku: variant.sku,
      variantId: variant.variant_id,
    })),
  };
}

export async function getPublicProduct(
  db: D1Database,
  tenant: TenantContext,
  productId: string,
): Promise<PublicProductDetail | null> {
  if (productId.length === 0) {
    return null;
  }

  const row = await detailStatement(db, tenant, productId).first<ProductRow>();
  return row === null ? null : toDetail(db, tenant, row);
}

// ── versioned reads (ETag = tenants.catalog_version, PLAN §2.4) ────────────
//
// The version and the data are read in ONE D1 batch — a single implicit
// transaction — so the version labels exactly the snapshot the body was built
// from. Reading them separately could label an older body with a newer
// version, and a client would then keep that stale body across a 304 until
// the next bump.

export interface Versioned<T> {
  catalogVersion: number;
  value: T;
}

export async function listPublicProductsVersioned(
  db: D1Database,
  tenant: TenantContext,
): Promise<Versioned<PublicProductSummary[]> | null> {
  const [version, list] = await db.batch<{ catalog_version: number } | ProductRow>([
    catalogVersionStatement(db, tenant.tenantId),
    listStatement(db, tenant),
  ]);
  const catalogVersion = (version?.results[0] as { catalog_version: number } | undefined)
    ?.catalog_version;
  if (catalogVersion === undefined) {
    return null;
  }
  return {
    catalogVersion,
    value: ((list?.results ?? []) as ProductRow[]).map(toSummary),
  };
}

/**
 * The detail read, versioned. The variant and POD reads that follow the
 * batched product row run outside that snapshot; any change to them bumps the
 * version (by trigger), so at worst the body is NEWER than its label — which
 * costs one extra full response, never a stale 304.
 */
export async function getPublicProductVersioned(
  db: D1Database,
  tenant: TenantContext,
  productId: string,
): Promise<Versioned<PublicProductDetail | null> | null> {
  const [version, detail] = await db.batch<{ catalog_version: number } | ProductRow>([
    catalogVersionStatement(db, tenant.tenantId),
    detailStatement(db, tenant, productId),
  ]);
  const catalogVersion = (version?.results[0] as { catalog_version: number } | undefined)
    ?.catalog_version;
  if (catalogVersion === undefined) {
    return null;
  }
  const row = (detail?.results[0] as ProductRow | undefined) ?? null;
  return {
    catalogVersion,
    value: row === null ? null : await toDetail(db, tenant, row),
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
