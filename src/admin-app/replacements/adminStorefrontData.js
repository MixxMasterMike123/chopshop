// AdminStorefront's data layer — the ADMIN build's implementation (the API).
// The alias list of vite.admin.config.js puts this file where the page imports
// src/pages/admin/adminStorefrontData.js (the older build's, Firebase). Same
// names, same meaning; the shapes are bridged by adapters/content.js.
//
//   categories   GET /v1/admin/products → the products' categories
//   load         the identity (GET /v1/admin/settings through shopConfig.js),
//                each image's address read from its object
//   upload       uploads.js, kind shop_branding → the address; the object id
//                is remembered beside it (brandingImages.js)
//   save         saveShopConfig (unit FE: read-modify-write of the WHOLE
//                identity). The page's addresses leave the patch; the
//                `…ObjectId` keys take their place. An image the page removed
//                clears its key in the same save, and so does a stored id whose
//                object is gone (it would make the PUT refuse the identity).
//                An image whose read FAILED is not gone: the page cannot show
//                it, the seller is told, and its id is kept unless replaced.
//                Template, theme, accent, the featured block and the texts are
//                plain identity keys.

import toast from 'react-hot-toast';
import { AdminApiError } from '../../api/admin/client.js';
import { listAllProducts } from '../../api/admin/products.js';
import { uploadObject } from '../../api/admin/uploads.js';
import { brandingFromIdentity, brandingPatch, categoriesOf, settingsRefusal, uploadRefusal } from '../adapters/content.js';
import { imageStateOf, readImages, rememberImages } from './brandingImages.js';
import { loadShopConfig, saveShopConfig } from './shopConfig.js';

function sayable(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.userMessage = message;
  return error;
}

export async function loadShopCategories(shopId) {
  const items = await listAllProducts({ shopId });
  return categoriesOf(items.filter((p) => p.status !== 'archived'));
}

/** What the seller is told when an image's preview could not be read (it is kept, not removed). */
export const UNREAD_IMAGES_NOTICE = 'Några bilder kunde inte hämtas just nu och visas inte. De finns kvar och ändras inte när du sparar.';

export async function loadBranding(shopId) {
  const saved = await loadShopConfig(shopId);
  const seen = await readImages(saved, shopId);
  rememberImages(shopId, saved, seen);
  const unread = Object.values(seen.loaded).some((entry) => entry.unread) ||
    Object.keys(seen.addresses).some((key) => key.startsWith('unread:'));
  if (unread) toast(UNREAD_IMAGES_NOTICE, { icon: 'ℹ️', duration: 8000 });
  return brandingFromIdentity(saved, seen.addresses);
}

export async function saveBranding(patch, shopId) {
  const state = imageStateOf(shopId);
  const out = brandingPatch(patch, state);
  try {
    await saveShopConfig(out, shopId);
  } catch (error) {
    const message = error instanceof AdminApiError ? settingsRefusal(error) : null;
    throw message ? sayable(message, error) : error;
  }
  // What the identity names now.
  for (const key of ['logoObjectId', 'heroObjectId', 'faviconObjectId', 'emailLogoObjectId']) {
    if (!(key in out)) continue;
    if (out[key]) state.loaded[key] = { id: out[key], resolved: true };
    else delete state.loaded[key];
  }
}

export async function uploadBrandImage(file, kind, shopId) {
  try {
    const { objectId, url } = await uploadObject(file, { kind: 'shop_branding', shopId });
    if (typeof url !== 'string' || url === '') throw sayable('Bilden laddades upp men kan inte visas ännu.');
    imageStateOf(shopId).urls.set(url, objectId);
    return url;
  } catch (error) {
    if (error?.userMessage) throw error;
    const message = error instanceof AdminApiError ? uploadRefusal(error) : null;
    throw message ? sayable(message, error) : error;
  }
}
