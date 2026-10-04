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
//   save         saveShopConfig (unit CP5-FP: the fenced PATCH of the keys
//                the save changes). The page's addresses leave the patch; the
//                `…ObjectId` keys take their place. An image the page removed
//                clears its key in the same save, and so does a stored id whose
//                object is gone (cleaned up while the page that manages it is
//                saved). An image whose read FAILED is not gone: the page
//                cannot show it, the seller is told, and its id is kept unless
//                replaced. Template, theme, accent, the featured block and the
//                texts are plain identity keys.
//   a conflict   the settings changed since the page read them (409): the
//                stored identity's images are read, and the page's form
//                follows what is stored with the seller's edits kept where the
//                other change left the field alone (adapters/merge.js); the
//                sentence says which edits were lost

import toast from 'react-hot-toast';
import { AdminApiError } from '../../api/admin/client.js';
import { listAllProducts } from '../../api/admin/products.js';
import { uploadObject } from '../../api/admin/uploads.js';
import { STORE } from '../../config/store.js';
import { brandingFromIdentity, brandingPatch, categoriesOf, settingsRefusal, uploadRefusal } from '../adapters/content.js';
import { mergeThree } from '../adapters/merge.js';
import { settingsConflictMessage } from '../adapters/settings.js';
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

// shopId → the branding as the page shows it stored (its load, then each
// save), in the page's shape: the base of a conflict's three-way merge.
const shownStored = new Map();

/** A branding source as the page shows it: STORE's value where the source has none (the page's own rule). */
function pageView(source) {
  const out = {};
  for (const key of new Set([...Object.keys(STORE), ...Object.keys(source || {})])) {
    const value = source?.[key] !== undefined ? source[key] : STORE[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The page's branding source from saved settings (flat): its images read and remembered. */
async function brandingOf(saved, shopId) {
  const seen = await readImages(saved, shopId);
  rememberImages(shopId, saved, seen);
  const unread = Object.values(seen.loaded).some((entry) => entry.unread) ||
    Object.keys(seen.addresses).some((key) => key.startsWith('unread:'));
  return { branding: brandingFromIdentity(saved, seen.addresses), unread };
}

export async function loadBranding(shopId) {
  const saved = await loadShopConfig(shopId);
  const { branding, unread } = await brandingOf(saved, shopId);
  if (unread) toast(UNREAD_IMAGES_NOTICE, { icon: 'ℹ️', duration: 8000 });
  shownStored.set(shopId, pageView(branding));
  return branding;
}

/** A save refused because the settings moved: the form to show (`branding`) and the sentence. */
async function conflictOf(error, patch, shopId) {
  const { branding } = await brandingOf(error.saved, shopId);
  const base = shownStored.get(shopId) ?? pageView({});
  const theirs = pageView(branding);
  const merged = mergeThree({ ...base, ...patch }, base, theirs);
  shownStored.set(shopId, theirs);
  const refused = sayable(settingsConflictMessage(merged.lost, { lostAnswer: error.lostAnswer }), error);
  refused.branding = merged.value;
  return refused;
}

export async function saveBranding(patch, shopId) {
  const state = imageStateOf(shopId);
  const out = brandingPatch(patch, state);
  try {
    await saveShopConfig(out, shopId);
  } catch (error) {
    if (error?.code === 'settings_conflict') throw await conflictOf(error, patch, shopId);
    if (error?.userMessage) throw error;
    const message = error instanceof AdminApiError ? settingsRefusal(error) : null;
    throw message ? sayable(message, error) : error;
  }
  shownStored.set(shopId, { ...(shownStored.get(shopId) ?? pageView({})), ...patch });
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
