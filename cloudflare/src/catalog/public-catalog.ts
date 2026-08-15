import type { TenantContext } from "../tenancy/resolve-tenant";

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
  variants: PublicProductVariant[];
}

interface ProductRow {
  currency: string;
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

const PUBLIC_PRODUCT_COLUMNS = `SELECT
     publication.product_id AS product_id,
     publication.public_name AS public_name,
     publication.public_description AS public_description,
     publication.public_price_minor AS public_price_minor,
     publication.currency AS currency,
     product.sku AS sku
   FROM product_publications AS publication
   INNER JOIN products AS product
     ON product.product_id = publication.product_id
    AND product.tenant_id = publication.tenant_id
   WHERE publication.tenant_id = ?
     AND product.tenant_id = ?
     AND publication.published = 1
     AND product.status = 'active'`;

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

export async function listPublicProducts(
  db: D1Database,
  tenant: TenantContext,
): Promise<PublicProductSummary[]> {
  const result = await db
    .prepare(
      `${PUBLIC_PRODUCT_COLUMNS}
       ORDER BY publication.public_name ASC, publication.product_id ASC
       LIMIT ${PUBLIC_PRODUCT_LIMIT}`,
    )
    .bind(tenant.tenantId, tenant.tenantId)
    .all<ProductRow>();

  return result.results.map(toSummary);
}

export async function getPublicProduct(
  db: D1Database,
  tenant: TenantContext,
  productId: string,
): Promise<PublicProductDetail | null> {
  if (productId.length === 0) {
    return null;
  }

  const row = await db
    .prepare(
      `${PUBLIC_PRODUCT_COLUMNS}
         AND publication.product_id = ?
       LIMIT 1`,
    )
    .bind(tenant.tenantId, tenant.tenantId, productId)
    .first<ProductRow>();

  if (row === null) {
    return null;
  }

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
    variants: variants.results.map((variant) => ({
      label: variant.label,
      priceMinor: variant.price_minor,
      sku: variant.sku,
      variantId: variant.variant_id,
    })),
  };
}
