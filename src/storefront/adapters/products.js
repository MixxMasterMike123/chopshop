// Products: an answer of GET /v1/products or GET /v1/products/:ref (CP4-A,
// cloudflare/src/catalog/public-catalog.ts) → the object the storefront pages
// read today (the fields of a Firestore `productsPublic` document). Pure: no
// React, no fetch, no DOM; tested under Node (adapters.test.mjs).
//
// What is bridged here, and nowhere else:
//   money      minor units (öre) → kronor, the unit every page prints and the
//              cart holds (`priceMinor` → `b2cPrice`, variants' `price`)
//   images     PublicImage objects → addresses (`b2cImageUrl`,
//              `b2cImageGallery`, a variant's `image` and `images`)
//   card price the server's `lowestPriceMinor` / `isFromPrice` → `lowestPrice`
//              / `isFromPrice`, read by the storefront's getCardPrice
//              (src/storefront/replacements/productPricing.js)
//   texts      `description` → `descriptions.b2c`, `moreInfo` →
//              `descriptions.b2cMoreInfo` (HTML, cleaned where it is rendered)
//   delivery   `allowShipping` / `allowPickup` → `delivery.{shipping,pickup}`
//   address    `path` is kept: the storefront's getProductUrl puts the root in
//              front of it (src/storefront/replacements/productUrls.js)
//
// Not carried, because the API does not carry them: review counts and rating
// sums (D81: no stars on a card, no review block), the B2B fields (D82), the
// carriage inputs `weight` and `shipping` (private to the checkout),
// `options` / `optionValues` (no variant of the export has them, CP4-A table).
// A page that reads one of them renders as it does today for a product
// without it.

const kronor = (minor) => (typeof minor === 'number' && Number.isFinite(minor) ? minor / 100 : null);

const addressOf = (image) => (image && typeof image.url === 'string' && image.url ? image.url : null);

const text = (value) => (typeof value === 'string' ? value : '');

/** A detail's variant: the rail row the product page renders, price in kronor. */
function toPageVariant(variant) {
  return {
    variantId: variant.variantId,
    sku: variant.sku,
    label: variant.label,
    price: kronor(variant.priceMinor),
    group: typeof variant.group === 'string' && variant.group ? variant.group : null,
    size: typeof variant.size === 'string' && variant.size ? variant.size : null,
    position: variant.position,
    image: addressOf(variant.image) ?? '',
    images: (Array.isArray(variant.images) ? variant.images : []).map(addressOf).filter(Boolean),
  };
}

/**
 * A list answer carries a card's variant hint as `swatches` (one per group,
 * with its first image), not the variants. The card reads the hint from
 * `product.variants` (NordProductCard variantGroups: group or label, and an
 * image), so a summary's `variants` are its swatches: a label and an image,
 * no sku and no price. Only the product page adds a variant to the cart, and
 * it reads a detail.
 */
function toSwatchVariant(swatch) {
  return {
    group: swatch.label,
    label: swatch.label,
    image: addressOf(swatch.image) ?? '',
    images: [],
  };
}

/**
 * One product, from a summary (a list, a collection) or a detail (the product
 * page). `options.apiUrl` turns an API path into an address (the client's
 * `apiUrl`); it is needed only for the print previews of a POD product.
 */
export function toPageProduct(api, { apiUrl } = {}) {
  if (!api || typeof api !== 'object' || typeof api.productId !== 'string') return null;
  const detail = Array.isArray(api.variants);

  // A detail lists every image a visitor may see; the product's own rows
  // (no variant) are the main image and the gallery, as `b2cImageUrl` and
  // `b2cImageGallery` were. A list answer has the main image only.
  const own = detail
    ? (Array.isArray(api.images) ? api.images : [])
        .filter((image) => image && image.variantId == null)
        .map(addressOf)
        .filter(Boolean)
    : [];
  const mainImage = own[0] ?? addressOf(api.image);

  const description = text(api.description);
  const product = {
    id: api.productId,
    productId: api.productId,
    sku: api.sku,
    handle: api.handle,
    path: api.path,
    name: text(api.name),
    currency: api.currency,
    category: typeof api.category === 'string' && api.category ? api.category : null,
    tags: Array.isArray(api.tags) ? api.tags : [],
    featured: api.featured === true,
    sortOrder: typeof api.sortOrder === 'number' ? api.sortOrder : null,
    b2cPrice: kronor(api.priceMinor),
    lowestPrice: kronor(api.lowestPriceMinor) ?? kronor(api.priceMinor),
    isFromPrice: api.isFromPrice === true,
    compareAtPrice: kronor(api.compareAtPriceMinor),
    b2cImageUrl: mainImage,
    b2cImageGallery: own.slice(1),
    description,
    descriptions: { b2c: description },
    variants: detail
      ? api.variants.map(toPageVariant)
      : (Array.isArray(api.swatches) ? api.swatches : []).map(toSwatchVariant),
  };

  if (!detail) return product;

  const toAddress = typeof apiUrl === 'function' ? apiUrl : () => null;
  return {
    ...product,
    descriptions: { b2c: description, b2cMoreInfo: text(api.moreInfo) },
    size: typeof api.size === 'string' && api.size ? api.size : null,
    sizeGuide: text(api.sizeGuide),
    launchDate: typeof api.launchDate === 'string' && api.launchDate ? api.launchDate : null,
    isPersonalized: api.isPersonalized === true,
    delivery: { shipping: api.allowShipping !== false, pickup: api.allowPickup !== false },
    stock: typeof api.stock === 'number' ? api.stock : null,
    brand: typeof api.brand === 'string' && api.brand ? api.brand : null,
    eanCode: typeof api.eanCode === 'string' && api.eanCode ? api.eanCode : null,
    isPodProduct: api.pod != null,
    // The artwork previews of a POD product, as addresses through /_api (the
    // Worker serves them). No page of today renders them.
    podPreviewUrls: (Array.isArray(api.pod?.previewUrls) ? api.pod.previewUrls : [])
      .map((path) => toAddress(path))
      .filter(Boolean),
  };
}

/** Every product of a list answer, in the answer's order. */
export function toPageProducts(list, options) {
  return (Array.isArray(list) ? list : []).map((api) => toPageProduct(api, options)).filter(Boolean);
}

/**
 * The sku a product's address ends in: `/product/<name>_<sku>` → `<sku>`
 * (the source system's rule, which the API still resolves). A gallery tile
 * of the storefront response names its product by path; the home page links
 * a tile by `linkSku`.
 */
export function skuOfProductPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/product/')) return null;
  let handle;
  try {
    handle = decodeURIComponent(path.slice('/product/'.length));
  } catch {
    return null;
  }
  const underscore = handle.lastIndexOf('_');
  const sku = underscore === -1 ? '' : handle.slice(underscore + 1);
  return sku || null;
}
