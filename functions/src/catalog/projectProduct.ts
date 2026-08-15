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

/** Variant rows: money/display keys only — never any wholesale/cost keys. */
const VARIANT_KEYS = [
  'sku', 'label', 'price', 'image', 'images', 'group', 'size', 'optionValues',
] as const;

/** Rail rows (variantGroups, model v2.2): what deriveVariantsFromGroups persists. */
const GROUP_KEYS = ['label', 'sku', 'price', 'image', 'images', 'sizes'] as const;

/** Legacy v2.1 options-matrix rows (cleared to [] on re-save, still rendered). */
const OPTION_KEYS = ['name', 'values'] as const;

/** Top-level passthrough fields (objects with sub-allowlists handled apart). */
const TOP_KEYS = [
  'shopId', 'name', 'sku', 'category', 'group', 'tags',
  'featured', 'sortOrder', 'hasVariants',
  'b2cPrice', 'basePrice', 'compareAtPrice',
  'b2cImageUrl', 'b2cImageGallery', 'imageUrl',
  'size', 'color', 'description',
  'reviewCount', 'ratingSum',
  'launchDate', 'sizeGuide', 'isPersonalized',
  'weight', 'shipping', 'stock', 'brand', 'eanCode',
  'isActive', 'createdAt', 'updatedAt',
] as const;

type AnyDoc = Record<string, unknown>;

const pick = (obj: AnyDoc, keys: readonly string[]): AnyDoc => {
  const out: AnyDoc = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
};

/**
 * Project a raw product doc to its public shape, or null when the product
 * must NOT exist publicly (draft / inactive / not B2C-available). null means
 * "delete the projection doc" — absence, not a flag, hides drafts, so the
 * storefront's existing `isActive==true && availability.b2c==true` queries
 * and its missing-doc handling (cart reconcile, recovery links) keep working
 * unchanged against the mirror.
 */
export function projectPublicProduct(raw: AnyDoc | undefined | null): AnyDoc | null {
  if (!raw) return null;
  const availability = raw.availability as AnyDoc | undefined;
  // Strict === true mirrors the storefront query semantics exactly: a product
  // with isActive undefined is invisible today and stays invisible.
  if (raw.isActive !== true || availability?.b2c !== true) return null;

  const pub = pick(raw, TOP_KEYS);

  // availability: only the b2c flag (b2b channel membership is internal).
  pub.availability = { b2c: true };

  // descriptions: b2c-facing texts only (nothing else is written today, but
  // the sub-allowlist keeps any future internal note out by default).
  const descriptions = raw.descriptions as AnyDoc | undefined;
  if (descriptions && typeof descriptions === 'object') {
    pub.descriptions = pick(descriptions, ['b2c', 'b2cMoreInfo']);
  }

  // delivery: the two storefront-facing booleans.
  const delivery = raw.delivery as AnyDoc | undefined;
  if (delivery && typeof delivery === 'object') {
    pub.delivery = pick(delivery, ['shipping', 'pickup']);
  }

  // Row arrays: per-row sub-allowlists (rows are client-authored objects; a
  // future per-row cost/wholesale key must not ride along in ANY of them).
  const pickRows = (rows: unknown, keys: readonly string[]): AnyDoc[] | undefined =>
    Array.isArray(rows)
      ? rows.filter((r): r is AnyDoc => !!r && typeof r === 'object').map((r) => pick(r, keys))
      : undefined;
  const variants = pickRows(raw.variants, VARIANT_KEYS);
  if (variants) pub.variants = variants;
  const variantGroups = pickRows(raw.variantGroups, GROUP_KEYS);
  if (variantGroups) pub.variantGroups = variantGroups;
  const options = pickRows(raw.options, OPTION_KEYS);
  if (options) pub.options = options;

  return pub;
}
