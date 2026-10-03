// PlatformShopDetail's data layer — the ADMIN build's implementation (CP5
// brief FI). The alias list of vite.admin.config.js puts this module in place
// of src/pages/platform/platformShopDetailData.js (the older build's,
// Firebase); both export the same names with the same meaning.
//
// PLATFORM-ONLY: the commission and the Connect facts are read here. Only the
// platform console imports this module.
//
//   the shop      GET /v1/platform/tenants/:id + GET …/connect (the opt-in flag
//                 is only in the Connect view), adapted by toDetailShop()
//   GO LIVE       POST …/publish | …/unpublish — unpublishing closes the
//                 storefront (D57); PUBLISH_COPY says so (publishCopy.js)
//   the status    POST …/activate | …/suspend
//   Connect       POST …/connect/enable | …/connect/disable
//   storefront    as the list (platformStorefront.js): the preview of an
//                 unpublished shop when an acting-as grant on it is open
//
// Not here: the counts (no route; the "Översikt" card is not shown) and the
// Shopify / WooCommerce migrators (PORT-LATER; their buttons are not shown and
// their modals are aliased to nothing).

import {
  getTenantConnect,
  getTenantDetail,
  setTenantConnectEnabled,
  setTenantPublished,
  setTenantStatus,
} from '../../api/admin/platform.js';
import { toDetailShop } from '../adapters/platformShops.js';
import { noteCurrentTermsVersion } from './shopCellsData.js';
import { openStorefrontOf } from './platformStorefront.js';
import { APP_URLS } from './urls.js';

export const SHOW_COUNTS = false;
export const MIGRATORS = false;

/** The publication card's words: here unpublishing CLOSES the storefront (D57). */
export { SHOP_DETAIL_PUBLISH_COPY as PUBLISH_COPY } from './publishCopy.js';

/** { shop, counts: null }, or null when the API answers the opaque 404. */
export async function loadShop(shopId) {
  const detail = await getTenantDetail(shopId);
  if (!detail) return null;
  let connect = null;
  try {
    connect = await getTenantConnect(shopId);
  } catch (error) {
    // The detail still shows; the opt-in then reads "not invited".
    console.warn('Connect view not available:', error?.code || error?.message);
  }
  noteCurrentTermsVersion(detail.legal?.terms?.currentVersion);
  return { shop: toDetailShop(detail, connect), counts: null };
}

export async function setShopPublished(shop, next) {
  await setTenantPublished(shop.id, next);
}

/** `next`: 'active' → activate, 'disabled' → suspend. A closed shop is refused (409). */
export async function setShopStatus(shop, next) {
  await setTenantStatus(shop.id, next === 'active' ? 'active' : 'suspended');
}

export async function setShopConnectEnabled(shop, next) {
  await setTenantConnectEnabled(shop.id, next);
}

export function storefrontUrlOf(shop) {
  return `${APP_URLS.B2C_SHOP}/${shop.id}`;
}

export function openStorefront(shop) {
  return openStorefrontOf(shop);
}
