// Content pages and posts (CP4 brief C). `lang` is a language tag (`sv-SE`);
// absent or unknown, the API answers in the shop's default language.

import { readOne, request, segment, withQuery } from './client.js';

/**
 * Published posts, newest first:
 * `{ pages: [{ slug, path, title, summary, author, publishedAt, image }], nextCursor }`.
 */
export async function listPosts({ lang, cursor, limit, signal } = {}) {
  const { data } = await request(withQuery('/v1/pages', { kind: 'post', lang, cursor, limit }), { signal });
  return { pages: data?.pages ?? [], nextCursor: data?.nextCursor ?? null };
}

/**
 * One published page or post by slug, or null. The brief does not name the
 * answer's key; this reads `{ page }` (see docs/cf-port/CP4_E_REPORT.md,
 * open questions): C's report decides.
 */
export function getPage(slug, { lang, signal } = {}) {
  return readOne(withQuery(`/v1/pages/${segment(slug)}`, { lang }), 'page', { signal });
}
