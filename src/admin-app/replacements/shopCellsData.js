// shopCells' data layer — the ADMIN build's implementation (CP5 brief FI).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/platform/shopCellsData.js (the older build's, Firebase); both
// export the same names with the same meaning.
//
// PLATFORM-ONLY: the commission is written here. Only the platform console's
// pages (shopCells, PlatformShopDetail) import this module.
//
// What the platform detail does not carry: who accepted the legal pages or
// the platform's terms, when, and which version (gap analysis §2c,
// PlatformShopDetail). LEGAL_FACTS is false, so the platform-terms pill and
// the two "godkända" rows are not shown; the readiness comes from the
// detail's settings summary (return address, VAT answer) with the adoption
// listed as unknown.

import { patchTenant } from '../../api/admin/platform.js';
import { commissionErrorMessage as messageOf, legalReadinessFromSummary } from '../adapters/platformShops.js';

/** Not read by this build (the pill reads it only when LEGAL_FACTS is true). */
export const PLATFORM_TERMS_VERSION = null;

export const LEGAL_FACTS = false;

/** The readiness from the shop's `legalSummary` (adapters/platformShops.js toDetailShop). */
export function legalReadinessOf(shop) {
  return legalReadinessFromSummary(shop.legalSummary);
}

/** PATCH /v1/platform/tenants/:id { commissionBps }. The server's cap decides (400 over it). */
export async function saveShopCommission(shop, bps) {
  await patchTenant(shop.id, { commissionBps: bps });
}

export function commissionErrorMessage(e) {
  return messageOf(e);
}
