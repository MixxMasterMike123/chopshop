// Product URL utilities for clean, SEO-friendly URLs
import { APP_URLS } from '../config/urls';
import { STORE } from '../config/store';
import { resolveShopId, isShoplessPath } from '../config/tenancy';

// Current shop prefix for storefront links, derived from the URL (path-prefix
// multi-tenant grammar: /{shopId}/...). Single source = config/tenancy.
const currentShopPrefix = () => {
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/';
  return `/${resolveShopId(pathname)}`;
};

// Helper to safely get content from multilingual fields without using hooks
const safeGetContent = (field) => {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && field !== null) {
    // A simplified, non-hook version of getContentValue
    // Prioritize Swedish, then English, then take any available.
    return field['sv-SE'] || field['en-GB'] || field['en-US'] || Object.values(field)[0] || '';
  }
  return String(field);
};

// Helper to create a URL-friendly slug from a string
export const slugify = (str) => {
  if (!str) return '';
  return str
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[åä]/g, 'a')          // Replace Swedish characters
    .replace(/ö/g, 'o')
    .replace(/&/g, '-and-')         // Replace & with 'and'
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-');        // Replace multiple - with single -
};

/**
 * Auto-derive a URL-safe SKU from a product name.
 *
 * SKU is the product's lookup KEY everywhere (URL resolution via
 * getSkuFromSlug, server cart repricing, order line items, POD podMappings).
 * A product saved without one is unreachable (its URL falls back to the raw
 * doc id, which getSkuFromSlug can't resolve). This fills the gap from the name.
 *
 * ⚠️ MUST contain NO underscore: the variant slug is `[name]_[sku]` and
 * getSkuFromSlug splits on the LAST '_'. An underscore in the SKU would make
 * the URL resolve to only the fragment after it. slugify keeps `\w` (incl. `_`),
 * so we strip underscores explicitly here.
 *
 * @param {string} name  the product name (plain string)
 * @returns {string} e.g. "Vitlökssill (300g)" -> "vitloksill-300g"
 */
export const skuFromName = (name) => {
  const base = slugify(name).replace(/_/g, '-').replace(/\-\-+/g, '-').replace(/^-|-$/g, '');
  return base || 'produkt';
};

/**
 * Ensure a per-shop-UNIQUE SKU. SKU is the lookup key, so a duplicate within a
 * shop collides two products on one URL / cart line. Given the desired base and
 * the set of SKUs already taken in this shop (lowercased), returns base, or
 * base-2, base-3, … until free. Pass the CURRENT product's own SKU as `selfSku`
 * so editing a product doesn't collide with itself.
 *
 * @param {string} base       desired sku (already url-safe)
 * @param {Set<string>|string[]} takenSkus  existing shop SKUs (any case)
 * @param {string} [selfSku]  this product's current sku, excluded from the check
 * @returns {string} a SKU not present in takenSkus
 */
export const uniqueSku = (base, takenSkus, selfSku = '') => {
  const taken = new Set([...(takenSkus || [])].map((s) => String(s || '').trim().toLowerCase()));
  const self = String(selfSku || '').trim().toLowerCase();
  if (self) taken.delete(self);
  const root = (base || 'produkt').toLowerCase();
  if (!taken.has(root)) return base || 'produkt';
  for (let n = 2; n < 10000; n++) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Practically unreachable; fall back to a timestamped suffix.
  return `${root}-${Date.now()}`;
};

/**
 * NEW DYNAMIC SLUG GENERATOR
 * Generates a unique, SEO-friendly slug for a specific product variant.
 * Format: [name-size]_[sku]
 * Example: minbutik-vasskydd-6_ABC-6-GL
 */
export const getVariantProductSlug = (product) => {
  if (!product || !product.sku) {
    console.error("Cannot generate slug for product without SKU:", product);
    return product?.id || 'invalid-product';
  }

  const name = safeGetContent(product.name) || 'product';
  const size = product.size || '';

  // Create the human-readable part from name and size.
  const seoPart = slugify(`${name} ${size}`);
  
  // Combine with the unique SKU, which is the key for database lookups.
  return `${seoPart}_${product.sku}`;
};

/**
 * Extracts the SKU from a dynamic variant slug.
 * This is the reverse of getVariantProductSlug.
 */
export const getSkuFromSlug = (slug) => {
  if (!slug || !slug.includes('_')) return null;
  const parts = slug.split('_');
  return parts[parts.length - 1];
};


// Generate full product URL (shop-prefixed: /{shopId}/product/:slug).
// Storefront is Swedish-only (i18n deferred). Multi-tenant path-prefix grammar.
export const getProductUrl = (product) => {
  const slug = getVariantProductSlug(product);
  return `${currentShopPrefix()}/product/${slug}`;
};

// Generate a shop-prefixed storefront URL for B2C links.
// getCountryAwareUrl('cart') -> /{shopId}/cart ; getCountryAwareUrl('') -> /{shopId}
//
// SHOPLESS GUARD: on a shopless path (bare root, credential routes like /login,
// /register, /affiliate-login), there is no real shop — resolveShopId() returns
// the UNRESOLVED sentinel, and this used to manufacture a /b8shield store link
// out of thin air (the credential-page → default-shop leak). In that case
// return the platform Landing Page ('/') instead. On a real /{shopId}/... route
// this is unchanged: the prefix is the genuine tenant.
export const getCountryAwareUrl = (path) => {
  if (typeof window !== 'undefined' && isShoplessPath(window.location.pathname)) {
    return '/';
  }
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  const prefix = currentShopPrefix();
  if (!cleanPath || cleanPath === '') return prefix;
  return `${prefix}/${cleanPath}`;
};

// Category (browse) URL — shop-prefixed. Category is the primary taxonomy.
// getCategoryUrl('Rökt') -> /{shopId}/kategori/rokt
export const getCategoryUrl = (category) => `${currentShopPrefix()}/kategori/${slugify(category)}`;

// All-products catalog URL — shop-prefixed. The full-assortment browse page
// (Shopify's /collections/all equivalent): /{shopId}/produkter
export const getAllProductsUrl = () => `${currentShopPrefix()}/produkter`;

// Collection (curated group) browse URL — shop-prefixed. The handle is already a
// slug (stored slugified), so DON'T re-slugify it. getCollectionUrl('eva-eastwood')
// -> /{shopId}/samling/eva-eastwood
export const getCollectionUrl = (handle) => `${currentShopPrefix()}/samling/${handle}`;

// Tag browse URL — shop-prefixed. Tags are free-text; slugify for the URL. The
// TagPage un-slugs by matching against the shop's real tags. getTagUrl('Nyhet')
// -> /{shopId}/tagg/nyhet
export const getTagUrl = (tag) => `${currentShopPrefix()}/tagg/${slugify(tag)}`;

// Resolve a menu item ({ type, target }) to an href. Single source for the
// storefront nav (ShopNavigation) so every menu link points at the right page.
// - home         → the shop home (/{shopId})
// - all-products → /{shopId}/produkter
// - category     → /{shopId}/kategori/{slug}
// - tag          → /{shopId}/tagg/{slug}
// - collection   → /{shopId}/samling/{handle}
// - page         → /{shopId}/{slug}  (CMS page; shop-prefixed via getCountryAwareUrl)
// - url          → the raw target (external / absolute), used as-is
export const buildMenuHref = (item) => {
  if (!item || !item.type) return currentShopPrefix();
  const target = item.target || '';
  switch (item.type) {
    case 'all-products': return getAllProductsUrl();
    case 'category': return getCategoryUrl(target);
    case 'tag': return getTagUrl(target);
    case 'collection': return getCollectionUrl(target);
    case 'page': return getCountryAwareUrl(target);
    case 'url': return target || currentShopPrefix();
    case 'home':
    default: return getCountryAwareUrl('');
  }
};

// Is a menu item an EXTERNAL link (raw url that leaves the SPA)? Used so the nav
// renders it as a plain <a target=_blank> instead of a client-side <Link>.
export const isExternalMenuItem = (item) =>
  item?.type === 'url' && /^https?:\/\//i.test(item.target || '');


/**
 * DYNAMIC SEO TITLE GENERATOR
 * Generates a descriptive title from the product object.
 */
export const getProductSeoTitle = (product) => {
  if (!product) return STORE.shopName;
  const name = safeGetContent(product.name);
  const size = product.size ? ` - ${product.size}` : '';
  return `${name}${size} | ${STORE.shopName}`;
};

/**
 * DYNAMIC SEO DESCRIPTION GENERATOR
 * Generates a descriptive meta description from the product object.
 */
export const getProductSeoDescription = (product) => {
  if (!product) return STORE.tagline || STORE.shopName;
  
  const name = safeGetContent(product.name);
  // B2C-only platform: prefer the consumer description. The legacy B2B field is
  // kept only as a last-resort fallback for old products that still carry it
  // (no new product writes descriptions.b2b — the reseller function is retired).
  const b2cDesc = safeGetContent(product.descriptions?.b2c);
  const fallbackDesc = safeGetContent(product.description);
  const legacyB2bDesc = safeGetContent(product.descriptions?.b2b);
  const defaultDesc = `${name} – ${STORE.shopName}`;

  const description = b2cDesc || fallbackDesc || legacyB2bDesc || defaultDesc;
  
  // Truncate to a reasonable length for meta descriptions (160 chars is optimal)
  return description.length > 160 ? description.substring(0, 157) + '...' : description;
};


/**
 * Generates an affiliate link with the correct language parameter based on affiliate's preferred language
 * @param {string} affiliateCode - The affiliate's unique code
 * @param {string} preferredLang - The affiliate's preferred language from DB (e.g., 'en-GB', 'en-US')
 * @param {string} [productPath] - Optional product path to append
 * @returns {string} The complete affiliate link
 */
export const generateAffiliateLink = (affiliateCode, preferredLang, productPath = '') => {
  // Shop-prefixed absolute link (multi-tenant path-prefix grammar). Uses the
  // current shop context; per-affiliate shop linkage (when an affiliate's shop
  // differs from the viewing context) is a later refinement.
  const baseUrl = APP_URLS.B2C_SHOP;
  const shopPrefix = currentShopPrefix();
  const path = productPath ? `/${productPath}` : '';
  return `${baseUrl}${shopPrefix}${path}?ref=${affiliateCode}`;
};

/**
 * SHOP SEO UTILITIES
 * Comprehensive SEO functions for B2C shop pages
 */

/**
 * Generate SEO title for shop homepage/storefront
 */
export const getShopSeoTitle = (language = 'sv-SE', store = STORE) => {
  // store = the live per-shop settings (useStoreSettings) so the browser tab
  // shows the real shop name, not the static 'My Shop' default. Falls back to
  // STORE for callers without the live context.
  const name = store.shopName || STORE.shopName;
  const tagline = store.tagline || STORE.tagline;
  return tagline ? `${name} - ${tagline}` : name;
};

/**
 * Generate SEO description for shop homepage/storefront
 */
export const getShopSeoDescription = (language = 'sv-SE', store = STORE) => {
  return store.companyDescription || store.tagline || store.shopName || STORE.shopName;
};

/**
 * SEO title/description helpers for cart/checkout/affiliate/legal pages.
 * Generic + brand-driven (STORE.shopName) so the template carries no
 * hardcoded brand. Per-shop SEO override is a later slice.
 */
const seoSuffix = () => ` | ${STORE.shopName}`;

export const getCartSeoTitle = () => `Varukorg${seoSuffix()}`;
export const getCartSeoDescription = () =>
  'Granska dina valda produkter. Säker kassa och snabb leverans.';

export const getCheckoutSeoTitle = () => `Kassa${seoSuffix()}`;
export const getCheckoutSeoDescription = () =>
  'Säker kassa. Snabb leverans och 14 dagars ångerrätt. Betala säkert online.';

const AFFILIATE_LABELS = {
  login: 'Affiliate-inloggning',
  registration: 'Affiliate-registrering',
  portal: 'Affiliate Portal',
};
export const getAffiliateSeoTitle = (pageType = 'login') =>
  `${AFFILIATE_LABELS[pageType] || AFFILIATE_LABELS.login}${seoSuffix()}`;
export const getAffiliateSeoDescription = () =>
  'Hantera ditt affiliate-konto: länkar, statistik och utbetalningar.';

const LEGAL_LABELS = {
  privacy: 'Integritetspolicy',
  terms: 'Köpvillkor',
  returns: 'Returpolicy',
  cookies: 'Cookie-policy',
  shipping: 'Frakt & Leverans',
};
export const getLegalSeoTitle = (pageType = 'privacy') =>
  `${LEGAL_LABELS[pageType] || LEGAL_LABELS.privacy}${seoSuffix()}`;
export const getLegalSeoDescription = (pageType = 'privacy') => {
  const label = LEGAL_LABELS[pageType] || LEGAL_LABELS.privacy;
  return `${label} – ${STORE.shopName}.`;
};

/**
 * Generate structured data for shop homepage
 */
export const generateShopStructuredData = (language = 'sv-SE', store = STORE) => {
  // Structured data must reflect the actual serving domain.
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : APP_URLS.B2C_SHOP;

  // Social profiles from store config (empty values are hidden).
  const sameAs = Object.values(store.social || {}).filter(Boolean);
  const logoUrl = store.logoUrl || STORE.logoUrl;

  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": store.shopName || STORE.shopName,
    "url": baseUrl,
    "logo": logoUrl?.startsWith('http') ? logoUrl : `${baseUrl}${logoUrl}`,
    "description": getShopSeoDescription(language, store),
    // NOTE: STORE has no structured postal-address or phone fields, so the
    // PostalAddress block and telephone are intentionally omitted rather
    // than inventing data.
    "contactPoint": {
      "@type": "ContactPoint",
      "contactType": "customer service",
      "email": store.supportEmail || STORE.supportEmail
    },
    ...(sameAs.length > 0 && { "sameAs": sameAs })
  };
};