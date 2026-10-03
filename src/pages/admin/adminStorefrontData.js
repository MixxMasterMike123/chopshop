// AdminStorefront's data layer — the OLDER build's implementation (Firebase).
//
// The page (AdminStorefront.jsx) reaches its data only through this module;
// the admin build swaps it, by its alias list, for
// src/admin-app/replacements/adminStorefrontData.js (the API). Both export the
// same names with the same meaning. Everything here is the page's former
// inline code, moved and unchanged.

import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { loadShopConfig, saveShopConfig } from '../../config/shopConfig';
import { uploadStoreImage } from '../../utils/imageUpload';

/** The category names of the shop's products (the frontpage showcase picker), sorted. */
export async function loadShopCategories(shopId) {
  const snap = await getDocs(query(collection(db, 'products'), where('shopId', '==', shopId)));
  const cats = new Set();
  snap.forEach((d) => {
    const p = d.data();
    const cat = (p.category || p.group || '').trim();
    if (cat) cats.add(cat);
  });
  return Array.from(cats).sort();
}

/**
 * THIS shop's saved config (impersonation / shop-admin's own shop / path),
 * not the default — so a non-default shop edits its own branding.
 */
export async function loadBranding(shopId) {
  return loadShopConfig(shopId);
}

/** Saves the branding keys (a merge: the identity's other keys stay). */
export async function saveBranding(patch, shopId) {
  await saveShopConfig(patch, shopId);
}

/** Uploads a logo, hero or favicon (`kind`); → its address. */
export async function uploadBrandImage(file, kind, shopId) {
  return uploadStoreImage(file, kind, shopId);
}
