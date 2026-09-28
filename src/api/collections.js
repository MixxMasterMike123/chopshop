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
