// Products (CP4 brief A). Money is in minor units (öre): `priceMinor`,
// `lowestPriceMinor`, `compareAtPriceMinor`. `path` is relative to the shop's
// root (client.shopHref makes it an address). A POD product's `pod.previewUrls`
// are API paths (client.apiUrl makes them addresses).

import { apiUrl, readOne, request, segment, withQuery } from './client.js';

/** The most pages `listAllProducts` walks (100 each): 2 000 products. */
export const MAX_PRODUCT_PAGES = 20;

/**
 * One page of the public list: `{ products: PublicProductSummary[], nextCursor }`.
 * Filters: `tag`, `category`, `featured` (true → `featured=1`), `cursor`,
 * `limit` 1–100 (the API's default is 100).
 */
export async function listProducts({ tag, category, featured, cursor, limit, signal } = {}) {
  const { data } = await request(
    withQuery('/v1/products', { tag, category, featured: featured ? 1 : undefined, cursor, limit }),
    { signal },
  );
  return { products: data?.products ?? [], nextCursor: data?.nextCursor ?? null };
}

/**
 * Every product of a filter, following the cursor (one shop has 113 public
 * products and a single page stops at 100).
 */
export async function listAllProducts(filter = {}) {
  const products = [];
  let cursor;
  for (let page = 0; page < MAX_PRODUCT_PAGES; page += 1) {
    const result = await listProducts({ ...filter, cursor });
    products.push(...result.products);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return products;
}

/** One public product by id or handle (`PublicProductDetail`), or null. */
export function getProduct(ref, { signal } = {}) {
  return readOne(`/v1/products/${segment(ref)}`, 'product', { signal });
}

/** The address of a POD product's artwork preview (an API path). */
export function previewImageUrl(previewPath) {
  return apiUrl(previewPath);
}
