// AdminCollectionEdit's data layer — the OLDER build's implementation (Firebase).
//
// The page (AdminCollectionEdit.jsx) reaches its data only through this
// module; the admin build swaps it, by its alias list, for
// src/admin-app/replacements/adminCollectionEditData.js (the API). Both export
// the same names with the same meaning. Everything here is the page's former
// inline code, moved and unchanged.

import { doc, getDoc, setDoc, addDoc, deleteDoc, collection, getDocs, query, where, serverTimestamp } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { withShopId } from '../../config/withShopId';
import { uploadImageToStorage } from '../../utils/imageUpload';

// Read a product name that may be a legacy per-locale object or a plain string
// (same helper idiom as AdminProducts).
const productName = (name) => {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') return name['sv-SE'] || Object.values(name).find((v) => typeof v === 'string') || '';
  return '';
};

/** The shop's products for the picker (by name) and the tags they carry. → { products, availableTags } */
export async function loadPickerProducts(shopId) {
  const snap = await getDocs(query(collection(db, 'products'), where('shopId', '==', shopId)));
  const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const tags = new Set();
  data.forEach((p) => Array.isArray(p.tags) && p.tags.forEach((t) => t && t.trim() && tags.add(t.trim())));
  data.sort((a, b) => productName(a.name).localeCompare(productName(b.name), 'sv'));
  return { products: data, availableTags: Array.from(tags).sort((a, b) => a.localeCompare(b, 'sv')) };
}

/** The collection's fields for the form, or null when it does not exist. */
export async function loadCollection(id) {
  const snap = await getDoc(doc(db, 'collections', id));
  if (!snap.exists()) return null;
  return snap.data();
}

/**
 * Handle must be unique within the shop — the storefront resolves a
 * collection by (shopId, handle) with limit(1), so a duplicate would make
 * one collection unreachable and render arbitrarily. True when another
 * collection (not `id`) already has `handle`.
 */
export async function handleIsTaken(shopId, handle, id) {
  const dupSnap = await getDocs(query(collection(db, 'collections'), where('shopId', '==', shopId), where('handle', '==', handle)));
  return Boolean(dupSnap.docs.find((d) => d.id !== id));
}

/** Uploads the cover; → its address. */
export async function uploadCollectionCover(file, shopId) {
  // Storage path scoped to the shop (isAdminOfShop rule); mirrors ProductForm's
  // products/{shopId}/… convention. imageType keeps a stable name per collection.
  return uploadImageToStorage(file, `collections/${shopId}`, `cover_${Date.now()}`);
}

/**
 * Writes the collection (a new one when `isNew`). `data` is the document the
 * page built (without shopId). → the id of the collection.
 */
export async function saveCollection({ id, isNew, shopId, data }) {
  const stamped = {
    ...data,
    updatedAt: serverTimestamp(),
    ...(isNew && { createdAt: serverTimestamp() }),
  };
  if (isNew) {
    const ref = await addDoc(collection(db, 'collections'), withShopId(stamped, shopId));
    return ref.id;
  }
  // Full overwrite (merge:false) → must re-stamp shopId (same as AdminPageEdit).
  await setDoc(doc(db, 'collections', id), withShopId(stamped, shopId));
  return id;
}

export async function deleteCollection(id) {
  await deleteDoc(doc(db, 'collections', id));
}
