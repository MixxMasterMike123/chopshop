// The store identity's images (CP5 brief FG): the identity names them by
// OBJECT ID (`logoObjectId`, `heroObjectId`, `faviconObjectId`,
// `emailLogoObjectId`, `gallery[].imageObjectId`); the page shows and edits
// ADDRESSES. An address is read from the object (GET /v1/admin/objects/:id →
// `url`): nothing is constructed by hand. A page's table address → object id
// is kept per shop, from the load and from the uploads of this tab.
//
// An object that no longer answers (removed, D93) makes a write of ITS key
// refuse (`unreferencable_images`); since the fenced PATCH (unit CP5-FP) only
// the keys a save writes are checked, so it no longer blocks other saves, and
// the storefront page clears such ids when it is saved (adapters/content.js
// brandingPatch).
// An object whose read FAILED (a network error, a 500) is not gone: its
// preview is unavailable, and its stored id is kept on save unless the page
// replaces the image (`unread`; CP5-FX, finding 7).

import { getObject } from '../../api/admin/uploads.js';
import { IMAGE_ID_KEYS, isObjectId } from '../adapters/content.js';

const perShop = new Map(); // shopId → { urls: Map(address → id), loaded: { idKey: { id, resolved } } }

export function imageStateOf(shopId) {
  if (!perShop.has(shopId)) perShop.set(shopId, { urls: new Map(), loaded: {} });
  return perShop.get(shopId);
}

/**
 * { resolved, url, unread }: `resolved` false only when the API says the
 * object is gone; `unread` true when the read failed (the preview is
 * unavailable, the object is not known to be gone).
 */
async function look(objectId, shopId) {
  try {
    const object = await getObject(objectId, { shopId });
    if (!object) return { resolved: false, url: '', unread: false };
    return { resolved: true, url: typeof object.url === 'string' ? object.url : '', unread: false };
  } catch {
    // Not knowing is not "gone": nothing is cleared on a failed read.
    return { resolved: true, url: '', unread: true };
  }
}

/**
 * Reads every image the identity names. → { loaded, addresses } where
 * `loaded[idKey] = { id, resolved, unread }`, `addresses[idKey | 'gallery:<id>'] = url`,
 * `addresses['gone:<id>']` marks a gallery object that is gone and
 * `addresses['unread:<id>']` one whose read failed.
 */
export async function readImages(identity, shopId) {
  const loaded = {};
  const addresses = {};
  const jobs = [];
  for (const key of IMAGE_ID_KEYS) {
    const id = identity?.[key];
    if (!isObjectId(id)) continue;
    jobs.push(look(id, shopId).then((seen) => {
      loaded[key] = { id, resolved: seen.resolved, unread: seen.unread };
      if (seen.url) addresses[key] = seen.url;
    }));
  }
  if (Array.isArray(identity?.gallery)) {
    for (const item of identity.gallery) {
      const id = item?.imageObjectId;
      if (!isObjectId(id)) continue;
      jobs.push(look(id, shopId).then((seen) => {
        addresses[`gallery:${id}`] = seen.resolved ? seen.url : '';
        if (!seen.resolved) addresses[`gone:${id}`] = 'gone';
        if (seen.unread) addresses[`unread:${id}`] = 'unread';
      }));
    }
  }
  await Promise.all(jobs);
  return { loaded, addresses };
}

/** Remembers a load: the table address → id, and what the identity named. */
export function rememberImages(shopId, identity, { loaded, addresses }) {
  const state = imageStateOf(shopId);
  state.loaded = loaded;
  for (const [key, entry] of Object.entries(loaded)) {
    if (addresses[key]) state.urls.set(addresses[key], entry.id);
  }
  for (const item of Array.isArray(identity?.gallery) ? identity.gallery : []) {
    const url = addresses[`gallery:${item?.imageObjectId}`];
    if (url) state.urls.set(url, item.imageObjectId);
  }
}
