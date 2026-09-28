// src/utils/productUrls.js for the Cloudflare storefront (alias list,
// vite.storefront.config.js). Same exports the storefront pages import, with
// one change: every address is built under the storefront's ROOT, taken from
// the same place as the client's `shopHref` (src/api/client.js):
// '/<shop>' on the shared host, '' on a shop's own domain (D77). The Firebase
// module builds '/<shop>/…' from the first path segment, which is wrong on a
// shop's own domain.
//
// Where the API hands a page a path of its own (a product's `path`, a menu
// entry's `path` or `url`), that path wins: it is the one the API resolves.
// Everything else is the Firebase module's code, unchanged. Left out: the
// affiliate link builder (D81) and the admin's SKU helpers; importing one of
// them fails the build, which is the point. The Firebase module stays as it
// is for the older build (it also reaches config/urls.js, which names the
// Firebase project).

import { STORE } from '../../config/store.js';
import { shopHref, storefrontRoot } from '../../api/client.js';

/** The root of the shop's addresses: '/<shop>', '' (own domain), or '' when the address names no shop. */
const currentShopPrefix = () => storefrontRoot() ?? '';

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
 * Generates a unique, SEO-friendly slug for a specific product variant.
 * Format: [name-size]_[sku]
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

// A product's address: the API's own `path` (relative to the shop's root)
// when the product carries one, else the address the Firebase module built.
export const getProductUrl = (product) => {
  if (typeof product?.path === 'string') {
    const href = shopHref(product.path);
    if (href) return href;
  }
  const slug = getVariantProductSlug(product);
  return `${currentShopPrefix()}/product/${slug}`;
};

// getCountryAwareUrl('cart') -> <root>/cart ; getCountryAwareUrl('') -> <root>
// (the shop's home). An address that names no shop links to '/', as the
// Firebase module's shopless guard does.
export const getCountryAwareUrl = (path) => {
  const root = storefrontRoot();
  if (root === null) return '/';
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  if (!cleanPath || cleanPath === '') return root || '/';
  return `${root}/${cleanPath}`;
};

// Category (browse) URL. getCategoryUrl('Rökt') -> <root>/kategori/rokt
export const getCategoryUrl = (category) => `${currentShopPrefix()}/kategori/${slugify(category)}`;

// All-products catalog URL: <root>/produkter
export const getAllProductsUrl = () => `${currentShopPrefix()}/produkter`;

// Collection URL. The handle is already a slug, so it is not re-slugified.
export const getCollectionUrl = (handle) => `${currentShopPrefix()}/samling/${handle}`;

// Tag browse URL: <root>/tagg/<slug>
export const getTagUrl = (tag) => `${currentShopPrefix()}/tagg/${slugify(tag)}`;

// A menu entry's address. The storefront response resolves every entry: a
// storefront entry carries its `path` (relative to the root), a link its
// `url`. Without them, the Firebase module's rule by type and target.
export const buildMenuHref = (item) => {
  if (item && typeof item.path === 'string') {
    const href = shopHref(item.path);
    if (href) return href;
  }
  if (item?.type === 'url' && typeof item.url === 'string' && item.url) return item.url;
  if (!item || !item.type) return currentShopPrefix() || '/';
  const target = item.target || '';
  switch (item.type) {
    case 'all-products': return getAllProductsUrl();
    case 'category': return getCategoryUrl(target);
    case 'tag': return getTagUrl(target);
    case 'collection': return getCollectionUrl(target);
    case 'page': return getCountryAwareUrl(target);
    case 'url': return target || currentShopPrefix() || '/';
    case 'home':
    default: return getCountryAwareUrl('');
  }
};

// Is a menu item an EXTERNAL link (raw url that leaves the SPA)?
export const isExternalMenuItem = (item) =>
  item?.type === 'url' && /^https?:\/\//i.test(item.target || '');

export const getProductSeoTitle = (product) => {
  if (!product) return STORE.shopName;
  const name = safeGetContent(product.name);
  const size = product.size ? ` - ${product.size}` : '';
  return `${name}${size} | ${STORE.shopName}`;
};

export const getProductSeoDescription = (product) => {
  if (!product) return STORE.tagline || STORE.shopName;

  const name = safeGetContent(product.name);
  const b2cDesc = safeGetContent(product.descriptions?.b2c);
  const fallbackDesc = safeGetContent(product.description);
  const legacyB2bDesc = safeGetContent(product.descriptions?.b2b);
  const defaultDesc = `${name} – ${STORE.shopName}`;

  const description = b2cDesc || fallbackDesc || legacyB2bDesc || defaultDesc;

  // Truncate to a reasonable length for meta descriptions (160 chars is optimal)
  return description.length > 160 ? description.substring(0, 157) + '...' : description;
};

export const getShopSeoTitle = (language = 'sv-SE', store = STORE) => {
  const name = store.shopName || STORE.shopName;
  const tagline = store.tagline || STORE.tagline;
  return tagline ? `${name} - ${tagline}` : name;
};

export const getShopSeoDescription = (language = 'sv-SE', store = STORE) => {
  return store.companyDescription || store.tagline || store.shopName || STORE.shopName;
};

const seoSuffix = () => ` | ${STORE.shopName}`;

export const getCartSeoTitle = () => `Varukorg${seoSuffix()}`;
export const getCartSeoDescription = () =>
  'Granska dina valda produkter. Säker kassa och snabb leverans.';

export const getCheckoutSeoTitle = () => `Kassa${seoSuffix()}`;
export const getCheckoutSeoDescription = () =>
  'Säker kassa. Snabb leverans och 14 dagars ångerrätt. Betala säkert online.';

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

// Structured data for the shop's home. The serving origin is the page's own.
export const generateShopStructuredData = (language = 'sv-SE', store = STORE) => {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

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
    "contactPoint": {
      "@type": "ContactPoint",
      "contactType": "customer service",
      "email": store.supportEmail || STORE.supportEmail
    },
    ...(sameAs.length > 0 && { "sameAs": sameAs })
  };
};
