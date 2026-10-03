// ShopPicker's data layer — the OLDER build's implementation (Firebase).
//
// The picker (ShopPicker.jsx) reaches its list only through this module, so
// one component serves two builds: the older build (vite.config.js) uses this
// file as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/shopPickerData.js (the shops of
// GET /v1/me). Both export the same name with the same meaning.
//
// The picker's former inline read, moved and unchanged.

import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase/config';

/** The shops to pick from: `[{ id, name, status, … }]`, sorted by name. */
export async function loadPickerShops() {
  const snap = await getDocs(collection(db, 'shops'));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}
