/**
 * THE public-eligibility predicate (PLAN §2.4) — one SQL fragment, used by
 * every public read and by checkout, so nothing purchasable is invisible on the
 * storefront and nothing hidden from the storefront is purchasable:
 *
 *   src/catalog/public-catalog.ts   product list, product detail, POD previews
 *   src/commerce/checkout.ts        line resolution
 *   src/catalog/screening.ts        the D8 "other live products" count
 *
 * CP6-PS4: while the print canvas is on, every reader that decides what a
 * buyer sees or buys (the storefront's reads through preview.ts
 * eligibilityPredicate, the sitemap, checkout, the platform's "visible"
 * count) adds STAND_IN_FRAME_TERM below; with it off, THE predicate is this
 * constant byte for byte. Screening's D8 count keeps the constant (see
 * docs/cf-port/CP6_PS4_REPORT.md, decision A5).
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

/**
 * `$.<object>."<key>"<rest>` as an SQL expression, or NULL when `key` holds a
 * character no capability key has (parsePrinterCapabilities: every model and
 * SKU key is `[A-Za-z0-9._-]`). A path built from a `"` or a `\` is a parse
 * error in SQLite, which would fail the whole read; such a key can never name
 * an entry of a valid document, so NULL (no entry) is the same answer.
 */
function capabilityPath(object: string, key: string, rest: string): string {
  return `CASE WHEN ${key} GLOB '*[^A-Za-z0-9._-]*' THEN NULL
              ELSE '$.${object}."' || ${key} || '"${rest}' END`;
}

const STAND_IN_MODEL = `json_extract(
             stand_in_printer.capabilities_json,
             ${capabilityPath("skus", "stand_in_mapping.sku", ".model")}
           )`;

/**
 * CP6-PS4: the stand-in term, added to THE predicate only while the print
 * canvas is on (src/dispatch/print-canvas.ts printCanvasEnabled). A POD
 * product with ANY active mapping whose printer SKU's model has only a
 * stand-in frame (`capabilities.models[skus[sku].model].provisional ===
 * true`, decideProductionLine's rule) is not public: checkout refuses such a
 * line then (dispatch would refuse to print it), so the storefront must not
 * offer it. The whole product, as a suspended mapping hides the whole product.
 * A printer edit that marks or clears a stand-in bumps catalog_version (0025
 * catalog_version_printers_update); the switch itself is in the ETag
 * (src/storefront/public-routes.ts).
 */
export const STAND_IN_FRAME_TERM = `
     AND NOT EXISTS (
       SELECT 1
       FROM pod_mappings AS stand_in_mapping
       INNER JOIN printers AS stand_in_printer
         ON stand_in_printer.id = stand_in_mapping.printer_id
       WHERE stand_in_mapping.tenant_id = product.tenant_id
         AND stand_in_mapping.product_id = product.product_id
         AND stand_in_mapping.status = 'active'
         AND json_type(
           stand_in_printer.capabilities_json,
           ${capabilityPath("models", STAND_IN_MODEL, ".provisional")}
         ) = 'true'
     )`;

/** THE predicate with the stand-in term (the print canvas on). */
export const CANVAS_ELIGIBILITY_PREDICATE = `${PUBLIC_ELIGIBILITY_PREDICATE}${STAND_IN_FRAME_TERM}`;

/**
 * THE predicate for a read that is never a preview (checkout, the sitemap, the
 * platform's counts): itself, or with the stand-in term while the canvas is on.
 */
export function publicEligibilityPredicate(hideStandInFrames: boolean): string {
  return hideStandInFrames ? CANVAS_ELIGIBILITY_PREDICATE : PUBLIC_ELIGIBILITY_PREDICATE;
}
