/**
 * THE public gate of a shop: a shop is public while it is ACTIVE and
 * PUBLISHED (D57: an unpublished shop is not shown; its preview is D's second
 * pass). Every public read of the storefront, its pages, legal pages and
 * collections asks through this one statement; a product's own eligibility
 * carries the same two terms inside THE predicate (src/catalog/eligibility.ts).
 *
 * The row holds what the callers read: `catalog_version` (the ETag of every
 * public read, PLAN §2.4), `default_locale` (the pages' fallback language),
 * and the storefront response's name, currency and support address.
 */

export interface PublicShopRow {
  catalog_version: number;
  default_currency: string;
  default_locale: string;
  shop_name: string | null;
  support_email: string | null;
}

/** At most one row: the shop, only while it is public. Meant for a `batch()` with the read it gates. */
export function publicShopStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT shop_name, default_locale, default_currency, support_email, catalog_version
       FROM tenants
       WHERE tenant_id = ?
         AND status = 'active'
         AND published = 1
       LIMIT 1`,
    )
    .bind(tenantId);
}
