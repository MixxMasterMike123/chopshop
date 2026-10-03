// shopCells' data layer — the ADMIN build's implementation (CP5 brief FI).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/platform/shopCellsData.js (the older build's, Firebase); both
// export the same names with the same meaning.
//
// PLATFORM-ONLY: the commission is written here. Only the platform console's
// pages (shopCells, PlatformShopDetail) import this module.
//
// What the platform detail carries (unit WJ): the checkout's own legal gate
// (`legal.checkoutOpen`), who adopted the legal pages and accepted the
// platform terms, and when. The readiness is the checkout's: "Juridik OK" and
// the GO LIVE warning mean what the checkout decides.

import { patchTenant } from '../../api/admin/platform.js';
import { commissionErrorMessage as messageOf, legalReadinessFromLegal } from '../adapters/platformShops.js';

// The platform's current terms version (the detail's `legal.terms.currentVersion`),
// which the "gammal version" pill compares the accepted one with. It is the
// same for every shop; the data module of the detail sets it from each read.
let currentTermsVersion = null;
export { currentTermsVersion as PLATFORM_TERMS_VERSION };

/** Called with each detail read (platformShopDetailData.js). */
export function noteCurrentTermsVersion(version) {
  if (typeof version === 'string' && version !== '') currentTermsVersion = version;
}

/** The seller's adoption of the pages and the platform terms (who, when, which version) are read: their pill and rows show. */
export const LEGAL_FACTS = true;

/** The readiness from the shop's `legal` (adapters/platformShops.js toDetailShop). */
export function legalReadinessOf(shop) {
  return legalReadinessFromLegal(shop.legal);
}

/** PATCH /v1/platform/tenants/:id { commissionBps }. The server's cap decides (400 over it). */
export async function saveShopCommission(shop, bps) {
  await patchTenant(shop.id, { commissionBps: bps });
}

export function commissionErrorMessage(e) {
  return messageOf(e);
}
