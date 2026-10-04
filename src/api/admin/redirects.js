// The shop's own forwards from old addresses to new ones (unit CP5-FL; the
// Worker: cloudflare/src/routes/admin-redirects.ts, CP4_D_REPORT.md §4.4).
// Every call is an `adminRequest`: it carries X-Shop-Id, the shop named by the
// caller (the page binds its calls to the shop it was opened for).
//
//   GET    /v1/admin/redirects?cursor=&limit=1..500   { redirects: [{ fromPath, toPath, createdAt, createdBy }], nextCursor }
//          ordered by fromPath (byte order)
//   PUT    /v1/admin/redirects  { redirects: [{ fromPath, toPath }] }  1..500
//          200 { redirects } in the stored form (an existing fromPath gets the new target)
//          400 refused_redirects { problems: [{ index, reason }] }
//              reason: invalid_path | reserved_path | same_path | duplicate | chain
//          409 conflict
//   DELETE /v1/admin/redirects  { fromPaths: [...] }   1..500 → 204 (an unknown path is a no-op)

import { adminRequest, withQuery } from './client.js';

/** One page of the shop's forwards. → { redirects, nextCursor }. */
export async function listRedirects({ shopId, cursor, limit, signal } = {}) {
  const { data } = await adminRequest('GET', withQuery('/v1/admin/redirects', { cursor, limit }), { shopId, signal });
  return {
    redirects: Array.isArray(data?.redirects) ? data.redirects : [],
    nextCursor: typeof data?.nextCursor === 'string' && data.nextCursor !== '' ? data.nextCursor : null,
  };
}

/** Writes forwards (new ones, or a new target for an existing old address). → the stored rows. */
export async function putRedirects(entries, { shopId } = {}) {
  const { data } = await adminRequest('PUT', '/v1/admin/redirects', { shopId, json: { redirects: entries } });
  return Array.isArray(data?.redirects) ? data.redirects : [];
}

/** Removes the forwards from these old addresses. */
export async function deleteRedirects(fromPaths, { shopId } = {}) {
  await adminRequest('DELETE', '/v1/admin/redirects', { shopId, json: { fromPaths } });
}
