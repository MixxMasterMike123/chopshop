// PlatformAddons' data layer: the OLDER build's implementation (Firebase).
//
// The page (PlatformAddons.jsx) reaches its data only through this module, so
// one page serves two builds: the older build (vite.config.js) uses this file
// as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/platformAddonsData.js (the API). Both
// files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { ADDON_CATALOG } from '../../config/addons';

/** The add-ons that have a column (the whole catalogue here). */
export const ADDON_COLUMNS = ADDON_CATALOG;

/** The note under the table. */
export const ADDONS_FOOTNOTE =
  'Tillägg styrs endast härifrån (plattformsnivå). Affiliate visas här men dess full\xadständiga gating (storefront + kassan + funktioner) aktiveras i ett kommande steg.';

/** Every shop, sorted by name: [{ id, name, features }]. */
export async function loadShops() {
  const snap = await getDocs(collection(db, 'shops'));
  const base = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  base.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  return base;
}

/** Writes the dot-path features.<key> so other feature flags on the doc are untouched. */
export async function writeAddon(shop, key, next) {
  await updateDoc(doc(db, 'shops', shop.id), { [`features.${key}`]: next });
}
