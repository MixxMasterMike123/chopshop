// The legal pages a shop adopted (CP4 brief C, D79): the text a visitor sees
// is the text the seller adopted, as adopted.

import { readOne, request, segment } from './client.js';

/** Which legal pages the shop has: `[{ key, path, title }]`. */
export async function listLegalPages({ signal } = {}) {
  const { data } = await request('/v1/legal', { signal });
  return data?.pages ?? [];
}

/**
 * One legal page (the HTML of the latest adoption and its date), or null when
 * the shop adopted none. The brief does not name the answer's key; this reads
 * `{ page }` (see docs/cf-port/CP4_E_REPORT.md, open questions).
 */
export function getLegalPage(key, { signal } = {}) {
  return readOne(`/v1/legal/${segment(key)}`, 'page', { signal });
}
