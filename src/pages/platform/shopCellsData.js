// shopCells' data layer — the OLDER build's implementation (Firebase).
//
// The cells (shopCells.jsx) and PlatformShopDetail reach these facts only
// through this module, so one file serves two builds: the admin build
// (vite.admin.config.js) swaps it, by its alias list, for
// src/admin-app/replacements/shopCellsData.js (the API). Both files export
// the same names with the same meaning.
//
// Everything here is the cells' former inline code, moved and unchanged.

import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase/config';
import { getLegalReadiness } from '../../utils/legalPageReadiness';
export { PLATFORM_TERMS_VERSION } from '../../config/platformTerms';

/**
 * The seller's acceptance of the legal pages and of the platform's terms
 * (who, when, which version) can be read here: their pill and rows show.
 */
export const LEGAL_FACTS = true;

/** The legal-pages readiness of the shop (legalPageReadiness.js's shape). */
export function legalReadinessOf(shop) {
  return getLegalReadiness(shop.storeIdentity || {});
}

/** Sets the shop's commission (basis points). */
export async function saveShopCommission(shop, bps) {
  await httpsCallable(functions, 'setShopCommission')({ shopId: shop.id, commissionBps: bps });
}

/** The message a refused save shows. */
export function commissionErrorMessage(e) {
  return e.message || 'Kunde inte spara avgift.';
}
