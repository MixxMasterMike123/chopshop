// AdminProducts' data layer — the OLDER build's implementation (Firebase).
//
// The page (AdminProducts.jsx) reaches its data only through this module, so
// one page serves two builds: the older build (vite.config.js) uses this file
// as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/adminProductsData.js (the API). Both
// files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { collection, getDocs, doc, deleteDoc, updateDoc, writeBatch, serverTimestamp, query, where } from 'firebase/firestore';
import { db } from '../../firebase/config';

/** The list's "Varianter" column has a source here (the embedded `variants`). */
export const LIST_SHOWS_VARIANT_COUNT = true;

/** Every product document of the shop, as `{ ...data, id }`. */
export async function loadShopProducts(shopId) {
  const snap = await getDocs(query(collection(db, 'products'), where('shopId', '==', shopId)));
  const data = [];
  snap.forEach((d) => {
    data.push({ ...d.data(), id: d.id });
  });
  return data;
}

/** Removes the product (an error with code 'not-found' when it is already gone). */
export async function deleteProduct(productId) {
  await deleteDoc(doc(db, 'products', productId));
}

/** The featured star: the explicit boolean. */
export async function setProductFeatured(productId, featured) {
  await updateDoc(doc(db, 'products', productId), { featured, updatedAt: serverTimestamp() });
}

/** The storefront order: each product's place is its index in `orderDraft`. */
export async function saveProductOrder(orderDraft) {
  // Positions are just the draft index. Batched writes, chunked well under
  // Firestore's 500-op batch limit.
  for (let i = 0; i < orderDraft.length; i += 400) {
    const batch = writeBatch(db);
    orderDraft.slice(i, i + 400).forEach((p, j) => {
      batch.update(doc(db, 'products', p.id), { sortOrder: i + j, updatedAt: serverTimestamp() });
    });
    await batch.commit();
  }
}

/** The product the form edits: the list's document already is the whole product. */
export async function openProduct(p) {
  return { ...p, documentId: p.id };
}
