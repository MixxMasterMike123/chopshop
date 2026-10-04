// PlatformShops' data layer — the ADMIN build's implementation (CP5 brief FI).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/platform/platformShopsData.js (the older build's, Firebase); both
// export the same names with the same meaning.
//
//   the list      GET /v1/platform/tenants?counts=1, every page (cursor to
//                 the end): each row with its counts (unit CP5-FP)
//   the status    POST /v1/platform/tenants/:id/activate | suspend
//   storefront    the shop's storefront; for an UNPUBLISHED shop with an open
//                 acting-as grant, its preview (POST /v1/admin/preview)
//
// The count columns are the API's three (products, those visible in the
// storefront, orders); there is no customer count, so that column is not
// shown (COUNT_COLUMNS) rather than a dash.

import { readAllTenants, setTenantStatus } from '../../api/admin/platform.js';
import { SHOP_COUNT_COLUMNS, toListShops } from '../adapters/platformShops.js';
import { openStorefrontOf } from './platformStorefront.js';

export const SHOW_COUNTS = true;

/** The count columns: { label, key (of shop.counts), title }. */
export const COUNT_COLUMNS = SHOP_COUNT_COLUMNS;

/** The publication column's words: here an unpublished shop is closed (D57). */
export { SHOP_LIST_PUBLISH_COPY as PUBLISH_COPY } from './publishCopy.js';

export async function loadShops() {
  return toListShops(await readAllTenants({ counts: true }));
}

/** `next`: 'active' → activate, 'disabled' → suspend. */
export async function setShopStatus(shop, next) {
  await setTenantStatus(shop.id, next === 'active' ? 'active' : 'suspended');
}

export function openStorefront(shop) {
  return openStorefrontOf(shop);
}
