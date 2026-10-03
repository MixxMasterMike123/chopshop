// The shop's collections and content pages (CP5 brief FG; the Worker:
// cloudflare/src/routes/admin-collections.ts, admin-pages.ts; the shapes in
// docs/cf-port/CP4_B_REPORT.md and CP4_C_REPORT.md).
//
//   GET    /v1/admin/collections?cursor&limit        { collections: AdminCollectionSummary[], nextCursor }
//   POST   /v1/admin/collections                     201 { collection }
//   GET    /v1/admin/collections/:id                 { collection }  (+ description, productIds)
//   PATCH  /v1/admin/collections/:id                 { collection }
//   DELETE /v1/admin/collections/:id                 204
//   PUT    /v1/admin/collections/:id/products        [productId, …] (0–500) → { collection }
//
//   GET    /v1/admin/pages?kind&status&cursor&limit  { pages: AdminPageSummary[], nextCursor }
//   POST   /v1/admin/pages                           201 { page }
//   GET    /v1/admin/pages/:id                       { page }
//   PATCH  /v1/admin/pages/:id                       { page }
//   DELETE /v1/admin/pages/:id                       204
//
// Every request carries X-Shop-Id (adminRequest). Nothing here computes
// anything: the answers are passed on as the server gave them.

import { AdminApiError, adminRequest, segment, withQuery } from './client.js';

export const COLLECTIONS_PATH = '/v1/admin/collections';
export const PAGES_PATH = '/v1/admin/pages';
/** Both lists' largest page. */
export const LIST_PAGE_MAX = 100;
/** A list is walked in at most this many pages (10 000 rows). */
const LIST_PAGES_MAX = 100;
/** `PUT …/products` takes at most this many ids. */
export const COLLECTION_PRODUCTS_MAX = 500;

const collectionPath = (id) => `${COLLECTIONS_PATH}/${segment(id)}`;
const pagePath = (id) => `${PAGES_PATH}/${segment(id)}`;

async function walk(path, key, params, { shopId, signal } = {}) {
  const all = [];
  let cursor;
  for (let page = 0; page < LIST_PAGES_MAX; page++) {
    const { data } = await adminRequest('GET', withQuery(path, { ...params, cursor, limit: LIST_PAGE_MAX }), { shopId, signal });
    all.push(...(Array.isArray(data?.[key]) ? data[key] : []));
    if (typeof data?.nextCursor !== 'string') return all;
    cursor = data.nextCursor;
  }
  throw new AdminApiError({ status: 0, code: 'too_many_rows', message: 'Listan är för lång för att läsas' });
}

async function getOrNull(path, key, { shopId, signal } = {}) {
  try {
    const { data } = await adminRequest('GET', path, { shopId, signal });
    return data?.[key] ?? null;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return null;
    throw error;
  }
}

// ── collections ─────────────────────────────────────────────────────────────

/** Every collection of the shop (summaries), in the server's display order. */
export const listAllCollections = (options = {}) => walk(COLLECTIONS_PATH, 'collections', {}, options);

/** One collection (with its description and ordered `productIds`), or null on the opaque 404. */
export const getCollection = (id, options = {}) => getOrNull(collectionPath(id), 'collection', options);

/** → the created collection. */
export async function createCollection(body, { shopId } = {}) {
  const { data } = await adminRequest('POST', COLLECTIONS_PATH, { json: body, shopId });
  return data?.collection ?? null;
}

/** → the collection as written. */
export async function updateCollection(id, body, { shopId } = {}) {
  const { data } = await adminRequest('PATCH', collectionPath(id), { json: body, shopId });
  return data?.collection ?? null;
}

export async function deleteCollection(id, { shopId } = {}) {
  await adminRequest('DELETE', collectionPath(id), { shopId });
}

/** The whole ordered member list of a MANUAL collection. → the collection as written. */
export async function setCollectionProducts(id, productIds, { shopId } = {}) {
  const { data } = await adminRequest('PUT', `${collectionPath(id)}/products`, { json: productIds, shopId });
  return data?.collection ?? null;
}

// ── pages ───────────────────────────────────────────────────────────────────

/** Every page of the shop (summaries; a status or a kind narrows). */
export const listAllPages = (params = {}, options = {}) => walk(PAGES_PATH, 'pages', params, options);

/** One page with its content, or null on the opaque 404. */
export const getPage = (id, options = {}) => getOrNull(pagePath(id), 'page', options);

/** → the created page. */
export async function createPage(body, { shopId } = {}) {
  const { data } = await adminRequest('POST', PAGES_PATH, { json: body, shopId });
  return data?.page ?? null;
}

/** → the page as written. */
export async function updatePage(id, body, { shopId } = {}) {
  const { data } = await adminRequest('PATCH', pagePath(id), { json: body, shopId });
  return data?.page ?? null;
}

export async function deletePage(id, { shopId } = {}) {
  await adminRequest('DELETE', pagePath(id), { shopId });
}
