// PlatformShops' data layer — the OLDER build's implementation (Firebase).
//
// The page (PlatformShops.jsx) reaches its data only through this module, so
// one page serves two builds: the older build (vite.config.js) uses this file
// as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/platformShopsData.js (the API). Both
// files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { collection, getDocs, doc, updateDoc, query, where, getCountFromServer } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { APP_URLS } from '../../config/urls';

/** The per-shop counts (products, orders, customers) have a read here. */
export const SHOW_COUNTS = true;

/** The publication column's words: here unpublishing only hides the shop from search engines. */
export { SHOP_LIST_PUBLISH_COPY as PUBLISH_COPY } from './publishCopy.js';

/** Every shop with its counts, sorted by name. */
export async function loadShops() {
  const snap = await getDocs(collection(db, 'shops'));
  const base = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const withCounts = await Promise.all(
    base.map(async (shop) => {
      const counts = {};
      for (const col of ['products', 'orders', 'b2cCustomers']) {
        try {
          const agg = await getCountFromServer(
            query(collection(db, col), where('shopId', '==', shop.id))
          );
          counts[col] = agg.data().count;
        } catch {
          counts[col] = null;
        }
      }
      return { ...shop, counts };
    })
  );

  withCounts.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  return withCounts;
}

/** The kill-switch: `next` is 'active' or 'disabled'. */
export async function setShopStatus(shop, next) {
  await updateDoc(doc(db, 'shops', shop.id), { status: next });
}

/** Opens the shop's storefront in a new tab. */
export function openStorefront(shop) {
  window.open(`${APP_URLS.B2C_SHOP}/${shop.id}`, '_blank', 'noopener');
}
