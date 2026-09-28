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

/** The most pages `listAllPages` walks (100 each): 1 000 pages and posts. */
export const MAX_PAGE_LIST_PAGES = 10;

/**
 * One page of the published pages and posts, newest first:
 * `{ pages: [{ slug, path, kind, title, summary, author, publishedAt, image }], nextCursor }`.
 * `kind` 'page' | 'post' (absent: both), `limit` 1–100 (the API's default is 20).
 */
export async function listPages({ kind, lang, cursor, limit, signal } = {}) {
  const { data } = await request(withQuery('/v1/pages', { kind, lang, cursor, limit }), { signal });
  return { pages: data?.pages ?? [], nextCursor: data?.nextCursor ?? null };
}

/** Every published page of a filter, following the cursor, 100 at a time. */
export async function listAllPages(filter = {}) {
  const pages = [];
  let cursor;
  for (let page = 0; page < MAX_PAGE_LIST_PAGES; page += 1) {
    const result = await listPages({ ...filter, cursor, limit: 100 });
    pages.push(...result.pages);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return pages;
}
