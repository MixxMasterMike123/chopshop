// PlatformShopDetail's data layer — the OLDER build's implementation (Firebase).
//
// The page (PlatformShopDetail.jsx) reaches its data only through this
// module, so one page serves two builds: the older build (vite.config.js)
// uses this file as it is; the admin build (vite.admin.config.js) swaps it,
// by its alias list, for src/admin-app/replacements/platformShopDetailData.js
// (the API). Both files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { doc, getDoc, updateDoc, collection, query, where, getCountFromServer } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { APP_URLS } from '../../config/urls';

/** The per-shop counts (products, orders, customers) have a read here. */
export const SHOW_COUNTS = true;

/** The count columns: { label, key (of the counts), title }. */
export const COUNT_COLUMNS = [
  { label: 'Produkter', key: 'products' },
  { label: 'Ordrar', key: 'orders' },
  { label: 'Kunder', key: 'b2cCustomers' },
];

/** The Shopify and WooCommerce migrators exist in this build. */
export const MIGRATORS = true;

/** The publication card's words: here unpublishing only hides the shop from search engines. */
export { SHOP_DETAIL_PUBLISH_COPY as PUBLISH_COPY } from './publishCopy.js';

/** The shop and its counts, or null when the shop does not exist. */
export async function loadShop(shopId) {
  const snap = await getDoc(doc(db, 'shops', shopId));
  if (!snap.exists()) {
    return null;
  }
  const shop = { id: snap.id, ...snap.data() };

  // Same aggregation pattern as PlatformShops.loadShops.
  const c = {};
  for (const col of ['products', 'orders', 'b2cCustomers']) {
    try {
      const agg = await getCountFromServer(
        query(collection(db, col), where('shopId', '==', shopId))
      );
      c[col] = agg.data().count;
    } catch {
      c[col] = null;
    }
  }
  return { shop, counts: c };
}

/** GO LIVE / TA UR SÖK. Platform-only Firestore write (rules: allow update if isPlatform()). */
export async function setShopPublished(shop, next) {
  await updateDoc(doc(db, 'shops', shop.id), { published: next });
}

/** The kill-switch: `next` is 'active' or 'disabled'. */
export async function setShopStatus(shop, next) {
  await updateDoc(doc(db, 'shops', shop.id), { status: next });
}

/** Operator opt-in for Stripe Connect (lets the shop START onboarding). Pure Firestore write. */
export async function setShopConnectEnabled(shop, next) {
  await updateDoc(doc(db, 'shops', shop.id), { 'payments.connectEnabled': next });
}

/** The shop's storefront address. */
export function storefrontUrlOf(shop) {
  return `${APP_URLS.B2C_SHOP}/${shop.id}`;
}

/** Opens the shop's storefront in a new tab. */
export function openStorefront(shop) {
  window.open(`${APP_URLS.B2C_SHOP}/${shop.id}`, '_blank', 'noopener');
}
