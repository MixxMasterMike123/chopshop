import type { TenantContext } from "../tenancy/resolve-tenant";

export interface PublicStorefront {
  currency: string;
  locale: string;
  name: string;
}

interface StorefrontRow {
  default_currency: string;
  default_locale: string;
  shop_name: string | null;
}

export async function getPublicStorefront(
  db: D1Database,
  tenant: TenantContext,
): Promise<PublicStorefront | null> {
  const row = await db
    .prepare(
      `SELECT shop_name, default_locale, default_currency
       FROM tenants
       WHERE tenant_id = ?
         AND status = 'active'
       LIMIT 1`,
    )
    .bind(tenant.tenantId)
    .first<StorefrontRow>();

  if (row === null || row.shop_name === null || row.shop_name.trim() === "") {
    return null;
  }

  return {
    currency: row.default_currency,
    locale: row.default_locale,
    name: row.shop_name,
  };
}

/**
 * The storefront read with its tenant's catalog_version (the ETag of every
 * public read, PLAN §2.4). One statement, so the version labels exactly the row
 * the body is built from.
 */
export async function getPublicStorefrontVersioned(
  db: D1Database,
  tenant: TenantContext,
): Promise<{ catalogVersion: number; value: PublicStorefront } | null> {
  const row = await db
    .prepare(
      `SELECT shop_name, default_locale, default_currency, catalog_version
       FROM tenants
       WHERE tenant_id = ?
         AND status = 'active'
       LIMIT 1`,
    )
    .bind(tenant.tenantId)
    .first<StorefrontRow & { catalog_version: number }>();

  if (row === null || row.shop_name === null || row.shop_name.trim() === "") {
    return null;
  }

  return {
    catalogVersion: row.catalog_version,
    value: {
      currency: row.default_currency,
      locale: row.default_locale,
      name: row.shop_name,
    },
  };
}
