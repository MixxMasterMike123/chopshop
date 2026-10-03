// The shop's products (CP5 brief FC; the Worker: cloudflare/src/routes/
// admin-products.ts, the create/update/publish routes of src/app.ts
// handleAdminProductRoute, src/routes/pod-admin.ts for the quote; the shapes
// in docs/cf-port/CP4_A_REPORT.md §3 and cloudflare/src/catalog/
// admin-product-reads.ts).
//
//   GET    /v1/admin/products?cursor=&limit=&q=&status=   { products: AdminProductListItem[], nextCursor }
//   GET    /v1/admin/products/:id                          { product, variants, images, publication, variantsTruncated }
//   POST   /v1/admin/products                              201 { product }   (always a draft)
//   PATCH  /v1/admin/products/:id                          { product }       (422 { error: { code } } = refused)
//   POST   /v1/admin/products/:id/publish | /unpublish     { product }
//   PUT    /v1/admin/products/order                        [{ productId, sortOrder }] (1–200) → { products }
//   POST   /v1/admin/products/:id/variants                 201 { variant }
//   PATCH  /v1/admin/products/:id/variants/:vid            { variant }
//   DELETE /v1/admin/products/:id/variants/:vid            { outcome: 'deleted' | 'deactivated', variant }
//   PUT    /v1/admin/products/:id/images                   [{ objectId, alt?, variantId? }] (≤ 30) → { images }
//   GET    /v1/admin/pod/quote?productId=[&variantId=]     { inkopMinor, priceFloorMinor, currency } · 422 not_quotable
//
// Every request carries X-Shop-Id (adminRequest). Nothing here computes a
// figure: the answers are passed on as the server gave them.

import { AdminApiError, adminRequest, segment, withQuery } from './client.js';

export const PRODUCTS_PATH = '/v1/admin/products';
/** The list route's largest page. */
export const LIST_PAGE_MAX = 100;
/** The order route's largest body. */
export const ORDER_CHUNK = 200;
/** A shop's catalogue is read in at most this many pages (10 000 products). */
const LIST_PAGES_MAX = 100;

const productPath = (productId) => `${PRODUCTS_PATH}/${segment(productId)}`;

/** One page of the list. → { products, nextCursor } */
export async function listProducts({ cursor, limit = LIST_PAGE_MAX, q, status, shopId, signal } = {}) {
  const { data } = await adminRequest('GET', withQuery(PRODUCTS_PATH, { cursor, limit, q, status }), { shopId, signal });
  return {
    products: Array.isArray(data?.products) ? data.products : [],
    nextCursor: typeof data?.nextCursor === 'string' ? data.nextCursor : null,
  };
}

/** Every product of the shop (every status), page after page, in the display order. */
export async function listAllProducts({ shopId, signal } = {}) {
  const all = [];
  let cursor;
  for (let page = 0; page < LIST_PAGES_MAX; page++) {
    const { products, nextCursor } = await listProducts({ cursor, shopId, signal });
    all.push(...products);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
  throw new AdminApiError({ status: 0, code: 'too_many_products', message: 'Butiken har fler produkter än listan läser' });
}

/** One product with its variants, images and publication, or null on the opaque 404. */
export async function getProduct(productId, { shopId, signal } = {}) {
  try {
    const { data } = await adminRequest('GET', productPath(productId), { shopId, signal });
    return data && typeof data === 'object' && data.product ? data : null;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return null;
    throw error;
  }
}

/** → the created AdminProduct (a draft). */
export async function createProduct(body, { shopId } = {}) {
  const { data } = await adminRequest('POST', PRODUCTS_PATH, { json: body, shopId });
  return data?.product ?? null;
}

/** → the AdminProduct as written. */
export async function updateProduct(productId, body, { shopId } = {}) {
  const { data } = await adminRequest('PATCH', productPath(productId), { json: body, shopId });
  return data?.product ?? null;
}

export async function publishProduct(productId, { shopId } = {}) {
  const { data } = await adminRequest('POST', `${productPath(productId)}/publish`, { shopId });
  return data?.product ?? null;
}

export async function unpublishProduct(productId, { shopId } = {}) {
  const { data } = await adminRequest('POST', `${productPath(productId)}/unpublish`, { shopId });
  return data?.product ?? null;
}

/**
 * The display order: `entries` = [{ productId, sortOrder }], sent 200 at a
 * time (the route's cap; each request is one batch on the server).
 */
export async function setProductOrder(entries, { shopId } = {}) {
  for (let i = 0; i < entries.length; i += ORDER_CHUNK) {
    await adminRequest('PUT', `${PRODUCTS_PATH}/order`, { json: entries.slice(i, i + ORDER_CHUNK), shopId });
  }
}

/** → the created AdminVariant. */
export async function createVariant(productId, body, { shopId } = {}) {
  const { data } = await adminRequest('POST', `${productPath(productId)}/variants`, { json: body, shopId });
  return data?.variant ?? null;
}

/** → the AdminVariant as written. */
export async function updateVariant(productId, variantId, body, { shopId } = {}) {
  const { data } = await adminRequest('PATCH', `${productPath(productId)}/variants/${segment(variantId)}`, { json: body, shopId });
  return data?.variant ?? null;
}

/** → { outcome: 'deleted' | 'deactivated', variant } (a variant something names stays, inactive). */
export async function deleteVariant(productId, variantId, { shopId } = {}) {
  const { data } = await adminRequest('DELETE', `${productPath(productId)}/variants/${segment(variantId)}`, { shopId });
  return { outcome: data?.outcome === 'deactivated' ? 'deactivated' : 'deleted', variant: data?.variant ?? null };
}

/** Replaces the whole image list (the first row is the main image). → the AdminProductImage list. */
export async function replaceProductImages(productId, images, { shopId } = {}) {
  const { data } = await adminRequest('PUT', `${productPath(productId)}/images`, { json: images, shopId });
  return Array.isArray(data?.images) ? data.images : [];
}

/**
 * The seller's ONE number and the price floor, as the server quotes them:
 * `{ inkopMinor, priceFloorMinor, currency }`, or null when the product has
 * no mapping that can be produced (422 not_quotable).
 */
export async function getPodQuote(productId, { variantId, shopId, signal } = {}) {
  try {
    const { data } = await adminRequest('GET', withQuery('/v1/admin/pod/quote', { productId, variantId }), { shopId, signal });
    if (!Number.isSafeInteger(data?.inkopMinor) || !Number.isSafeInteger(data?.priceFloorMinor)) return null;
    return { inkopMinor: data.inkopMinor, priceFloorMinor: data.priceFloorMinor, currency: data.currency };
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 422) return null;
    throw error;
  }
}
