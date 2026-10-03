// PlatformShops' data layer — the ADMIN build's implementation (CP5 brief FI).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/platform/platformShopsData.js (the older build's, Firebase); both
// export the same names with the same meaning.
//
//   the list      GET /v1/platform/tenants, every page (cursor to the end)
//   the status    POST /v1/platform/tenants/:id/activate | suspend
//   storefront    the shop's storefront; for an UNPUBLISHED shop with an open
//                 acting-as grant, its preview (POST /v1/admin/preview)
//
// No per-shop counts: the API has no route for them, so the three count
// columns are not shown (SHOW_COUNTS false) rather than showing zeros.

import { readAllTenants, setTenantStatus } from '../../api/admin/platform.js';
import { toListShops } from '../adapters/platformShops.js';
import { openStorefrontOf } from './platformStorefront.js';

export const SHOW_COUNTS = false;

export async function loadShops() {
  return toListShops(await readAllTenants());
}

/** `next`: 'active' → activate, 'disabled' → suspend. */
export async function setShopStatus(shop, next) {
  await setTenantStatus(shop.id, next === 'active' ? 'active' : 'suspended');
}

export function openStorefront(shop) {
  return openStorefrontOf(shop);
}
