/**
 * P1-11 (CODEX audit 2026-08-15): public catalogue projection.
 *
 * The raw `products` collection carries non-public commerce data (b2bPrice
 * wholesale price, podCostSek platform cost, availability.b2b channel config,
 * isPodProduct fulfillment model) and drafts — but Firestore rules cannot
 * redact fields, so as long as the storefront reads `products`, all of it is
 * anonymously readable. Fix: the storefront reads `productsPublic`, a
 * server-maintained, field-ALLOWLISTED mirror that contains ONLY published
 * (isActive && availability.b2c) products, and the raw collection's read rule
 * tightens to shop-admin/platform.
 *
 * This module is PURE (no firebase imports) so the projection contract is
 * unit-testable in the rules-tests phase-1 gate and reusable byte-identically
 * by the backfill script (scripts/backfill-products-public.cjs requires the
 * compiled lib).
 *
 * ALLOWLIST, not blocklist: a new sensitive field added to ProductForm later
 * defaults to NOT leaking. The cost is that a new storefront-facing field must
 * be added here explicitly — that failure mode is visible (field missing on
 * the storefront), the blocklist failure mode is silent (field leaked).
 *
 * The list mirrors what storefront code actually consumes (mapped 2026-08-15:
 * PublicStorefront/PublicProductPage/AllProductsPage/CollectionPage/TagPage/
 * ProductCollectionPage cards + detail, CartContext line stamping + shipping
 * math, productFeed JSON-LD, productSorting). Deliberately EXCLUDED:
 * b2bPrice, podCostSek, availability.b2b, isPodProduct, dimensions.
 */
type AnyDoc = Record<string, unknown>;
/**
 * Project a raw product doc to its public shape, or null when the product
 * must NOT exist publicly (draft / inactive / not B2C-available). null means
 * "delete the projection doc" — absence, not a flag, hides drafts, so the
 * storefront's existing `isActive==true && availability.b2c==true` queries
 * and its missing-doc handling (cart reconcile, recovery links) keep working
 * unchanged against the mirror.
 */
export declare function projectPublicProduct(raw: AnyDoc | undefined | null): AnyDoc | null;
export {};
