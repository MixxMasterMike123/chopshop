// AdminCollections' data layer — the OLDER build's implementation (Firebase).
//
// The page (AdminCollections.jsx) reaches its data only through this module,
// so one page serves two builds: the older build (vite.config.js) uses this
// file as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/adminCollectionsData.js (the API). Both
// files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { collection, getDocs, doc, deleteDoc, updateDoc, writeBatch, serverTimestamp, query, where } from 'firebase/firestore';
import { db } from '../../firebase/config';

/** Every collection document of the shop, as `{ ...data, id }` (the page sorts them). */
export async function loadShopCollections(shopId) {
  const snap = await getDocs(query(collection(db, 'collections'), where('shopId', '==', shopId)));
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}

export async function deleteShopCollection(id) {
  await deleteDoc(doc(db, 'collections', id));
}

/** The star: written as `featured`. */
export async function setCollectionFeatured(id, featured) {
  await updateDoc(doc(db, 'collections', id), { featured, updatedAt: serverTimestamp() });
}

/** Writes `sortOrder` = the place in `orderDraft` (the collections, in their new order). */
export async function saveCollectionOrder(orderDraft) {
  for (let i = 0; i < orderDraft.length; i += 400) {
    const batch = writeBatch(db);
    orderDraft.slice(i, i + 400).forEach((c, j) => {
      batch.update(doc(db, 'collections', c.id), { sortOrder: i + j, updatedAt: serverTimestamp() });
    });
    await batch.commit();
  }
}
