/**
 * THE public gate of a shop: a shop is public while it is ACTIVE and
 * PUBLISHED (D57: an unpublished shop is not shown). Every public read of the
 * storefront, its pages, legal pages and collections asks through this one
 * statement; a product's own eligibility carries the same two terms inside
 * THE predicate (src/catalog/eligibility.ts).
 *
 * A PREVIEW (D57, src/storefront/preview.ts) asks with `preview = true`: the
 * same statement without `published = 1`, and nothing else changed. The two
 * term lists below are the only place either is written.
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

const PUBLIC_SHOP_TERMS = ["tenant_id = ?", "status = 'active'", "published = 1"] as const;
// The preview's gate: the public one minus `published = 1`, exactly.
const PREVIEW_SHOP_TERMS = PUBLIC_SHOP_TERMS.filter((term) => term !== "published = 1");

/** The WHERE terms of the gate (exported for the test that pins the one difference). */
export function publicShopTerms(preview: boolean): readonly string[] {
  return preview ? PREVIEW_SHOP_TERMS : PUBLIC_SHOP_TERMS;
}

/**
 * At most one row: the shop, only while it is public (or, for a preview, only
 * while it is active). Meant for a `batch()` with the read it gates.
 */
export function publicShopStatement(
  db: D1Database,
  tenantId: string,
  preview = false,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT shop_name, default_locale, default_currency, support_email, catalog_version
       FROM tenants
       WHERE ${publicShopTerms(preview).join("\n         AND ")}
       LIMIT 1`,
    )
    .bind(tenantId);
}
