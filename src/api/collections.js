// Collections (CP4 brief B).

import { ApiError, request, segment, withQuery } from './client.js';

/** Published collections: `[{ handle, externalRef, title, description, image, path, featured }]`. */
export async function listCollections({ signal } = {}) {
  const { data } = await request('/v1/collections', { signal });
  return data?.collections ?? [];
}

/**
 * One collection by handle, external ref or id, with one page of its products:
 * `{ collection, products: PublicProductSummary[], nextCursor }`, or null.
 * `limit` 1–100 (the API's default is 24).
 */
export async function getCollection(ref, { cursor, limit, signal } = {}) {
  try {
    const { data } = await request(withQuery(`/v1/collections/${segment(ref)}`, { cursor, limit }), {
      signal,
    });
    return data?.collection
      ? { collection: data.collection, products: data.products ?? [], nextCursor: data.nextCursor ?? null }
      : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** The most pages `getWholeCollection` walks (100 products each). */
export const MAX_COLLECTION_PAGES = 10;

/**
 * One collection with every product it answers, following the cursor, 100 at
 * a time: `{ collection, products }`, or null.
 */
export async function getWholeCollection(ref, { signal } = {}) {
  const first = await getCollection(ref, { limit: 100, signal });
  if (!first) return null;
  const products = [...first.products];
  let cursor = first.nextCursor;
  for (let page = 1; cursor && page < MAX_COLLECTION_PAGES; page += 1) {
    const next = await getCollection(ref, { cursor, limit: 100, signal });
    if (!next) break;
    products.push(...next.products);
    cursor = next.nextCursor;
  }
  return { collection: first.collection, products };
}
