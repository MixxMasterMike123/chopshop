/**
 * THE public-eligibility predicate (PLAN §2.4) — one SQL fragment, used by
 * every public read and by checkout, so nothing purchasable is invisible on the
 * storefront and nothing hidden from the storefront is purchasable:
 *
 *   src/catalog/public-catalog.ts   product list, product detail, POD previews
 *   src/commerce/checkout.ts        line resolution
 *   src/catalog/screening.ts        the D8 "other live products" count
 *
 * §2.4 reads: is_active AND b2c_available AND shop.status='active' AND
 * shop.published!=false AND takedown_at IS NULL AND screening.status <>
 * 'blocked' (advisory statuses stay public — §11.6). In this schema:
 *
 *   is_active        publication.published = 1 AND product.status = 'active'
 *                    (b2c_available has no CF counterpart: B2B is retired)
 *   shop             tenant.status = 'active' AND tenant.published = 1
 *   takedown         product.takedown_at IS NULL
 *   screening        an ALLOWLIST (approved | advisory | flagged) rather than
 *                    "<> 'blocked'", because D8 adds a second non-public status
 *                    (pending) and a denylist would silently admit any status a
 *                    later migration adds. A product with NO screening row never
 *                    went through publishAdminProduct (fixtures, a future
 *                    import) and is admitted as advisory — the CP3 import must
 *                    write rows explicitly (see the CP2-C report).
 *   POD              a POD product is public only while it has at least one
 *                    ACTIVE mapping on an ACTIVE printer and NO SUSPENDED one
 *                    (a routing edit took a slot/SKU/price away: the product as
 *                    designed can no longer be made, and selling the remaining
 *                    prints would silently drop one). Not in §2.4's text, but
 *                    the only consistent reading of "mapping delete / routing
 *                    edit changes eligibility": otherwise the storefront would
 *                    show a product checkout must refuse.
 *
 * The fragment expects these aliases in the FROM clause, which
 * ELIGIBLE_PRODUCTS_FROM provides:
 *   publication (product_publications), product (products), tenant (tenants),
 *   screening (product_screening, LEFT JOIN).
 */
export const ELIGIBLE_PRODUCTS_FROM = `FROM product_publications AS publication
   INNER JOIN products AS product
     ON product.product_id = publication.product_id
    AND product.tenant_id = publication.tenant_id
   INNER JOIN tenants AS tenant
     ON tenant.tenant_id = product.tenant_id
   LEFT JOIN product_screening AS screening
     ON screening.product_id = product.product_id
    AND screening.tenant_id = product.tenant_id`;

export const PUBLIC_ELIGIBILITY_PREDICATE = `publication.published = 1
     AND product.status = 'active'
     AND product.takedown_at IS NULL
     AND tenant.status = 'active'
     AND tenant.published = 1
     AND (screening.status IS NULL OR screening.status IN ('approved', 'advisory', 'flagged'))
     AND (
       product.is_pod = 0
       OR EXISTS (
         SELECT 1
         FROM pod_mappings AS eligible_mapping
         INNER JOIN printers AS eligible_printer
           ON eligible_printer.id = eligible_mapping.printer_id
         WHERE eligible_mapping.tenant_id = product.tenant_id
           AND eligible_mapping.product_id = product.product_id
           AND eligible_mapping.status = 'active'
           AND eligible_printer.status = 'active'
       )
     )
     AND NOT EXISTS (
       SELECT 1
       FROM pod_mappings AS suspended_mapping
       WHERE suspended_mapping.tenant_id = product.tenant_id
         AND suspended_mapping.product_id = product.product_id
         AND suspended_mapping.status = 'suspended'
     )`;
