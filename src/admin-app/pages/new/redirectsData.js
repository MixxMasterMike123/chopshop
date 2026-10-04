// The data of the shop admin's "Omdirigeringar" page (unit CP5-FL). Admin
// requests: each carries X-Shop-Id, the shop the page was opened for.
// Tested under Node against the dev API (redirectsData.test.mjs).
//
// BOUND TO THE SHOP (CP5-FX finding 1): every call goes through readForShop,
// so an answer that arrives after the tab moved to another shop is dropped,
// never shown under the other shop (the admin tree also mounts the page
// afresh per shop).
//
// A write whose answer is lost is read back: the list is walked from just
// before the old address (the list's own order, UTF-8 bytes) until the
// address is found or passed. The address is compared in the form the server
// stores (adapters/redirects.js normalizeStorefrontPath).

import { deleteRedirects, listRedirects, putRedirects } from '../../../api/admin/redirects.js';
import { isLostAnswer } from '../../adapters/platformModels.js';
import { readFailureMessage } from '../../adapters/platformSettings.js';
import {
  REDIRECTS_PAGE,
  lookupCursorFor,
  normalizeStorefrontPath,
  redirectRefusalMessage,
  scanPage,
} from '../../adapters/redirects.js';
import { readForShop } from '../../providers/ordersForShop.js';
import { pageError } from './platformSettingsData.js';

const LOOKUP_PAGES = 10;

/** One page of the shop's forwards → { redirects, nextCursor }. */
export function loadForwards(shopId, cursor = null) {
  return readForShop(shopId, async (id) => {
    try {
      return await listRedirects({ shopId: id, cursor, limit: REDIRECTS_PAGE });
    } catch (error) {
      throw pageError(readFailureMessage(error, 'Omdirigeringarna'), error);
    }
  });
}

/** The stored forward from `path` (normal form), or null. Throws when the list cannot be read. */
export async function findForward(shopId, path) {
  let cursor = lookupCursorFor(path);
  if (cursor === null) return null;
  for (let page = 0; page < LOOKUP_PAGES; page += 1) {
    const { redirects, nextCursor } = await listRedirects({ shopId, cursor, limit: REDIRECTS_PAGE });
    const seen = scanPage(redirects, nextCursor, path);
    if (seen.state === 'found') return seen.row;
    if (seen.state === 'absent') return null;
    cursor = nextCursor;
  }
  throw new Error('The lookup did not reach the address');
}

const unclear = (what, cause) =>
  pageError(`Anslutningen bröts och det är oklart om ${what}. Ladda om sidan och kontrollera innan du försöker igen.`, cause);

/**
 * Writes one forward (a new one, or a new target for an old address that
 * has one). → { forward (as stored), readBack }.
 */
export function saveForward(shopId, { fromPath, toPath }) {
  return readForShop(shopId, async (id) => {
    const entry = { fromPath: String(fromPath ?? '').trim(), toPath: String(toPath ?? '').trim() };
    if (entry.fromPath === '' || entry.toPath === '') throw pageError('Fyll i både den gamla och den nya adressen.');
    try {
      const [stored] = await putRedirects([entry], { shopId: id });
      if (!stored) throw Object.assign(new Error('No forward in the answer'), { code: 'bad_response' });
      return { forward: stored, readBack: false };
    } catch (error) {
      if (!isLostAnswer(error)) throw pageError(redirectRefusalMessage(error), error);
      const from = normalizeStorefrontPath(entry.fromPath);
      const to = normalizeStorefrontPath(entry.toPath);
      let found;
      try {
        found = from === null ? null : await findForward(id, from);
      } catch {
        throw unclear('omdirigeringen sparades', error);
      }
      if (found && found.toPath === to) return { forward: found, readBack: true };
      throw pageError('Anslutningen bröts och omdirigeringen sparades inte. Försök igen.', error);
    }
  });
}

/** Removes the forward from `fromPath` (a stored old address). → { readBack }. */
export function removeForward(shopId, fromPath) {
  return readForShop(shopId, async (id) => {
    try {
      await deleteRedirects([fromPath], { shopId: id });
      return { readBack: false };
    } catch (error) {
      if (!isLostAnswer(error)) throw pageError(redirectRefusalMessage(error, 'Borttagningen'), error);
      let found;
      try {
        found = await findForward(id, fromPath);
      } catch {
        throw unclear('omdirigeringen togs bort', error);
      }
      if (!found) return { readBack: true };
      throw pageError('Anslutningen bröts och omdirigeringen togs inte bort. Försök igen.', error);
    }
  });
}
