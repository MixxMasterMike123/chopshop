// The store identity's images (CP5 brief FG): the identity names them by
// OBJECT ID (`logoObjectId`, `heroObjectId`, `faviconObjectId`,
// `emailLogoObjectId`, `gallery[].imageObjectId`); the page shows and edits
// ADDRESSES. An address is read from the object (GET /v1/admin/objects/:id →
// `url`): nothing is constructed by hand. A page's table address → object id
// is kept per shop, from the load and from the uploads of this tab.
//
// An object that no longer answers (removed, D93) would make the PUT of the
// identity refuse its stored id (`unreferencable_images`) and so block every
// save of the identity: those ids are cleared in the save that comes next.

import { getObject } from '../../api/admin/uploads.js';
import { IMAGE_ID_KEYS, isObjectId } from '../adapters/content.js';

const perShop = new Map(); // shopId → { urls: Map(address → id), loaded: { idKey: { id, resolved } } }

export function imageStateOf(shopId) {
  if (!perShop.has(shopId)) perShop.set(shopId, { urls: new Map(), loaded: {} });
  return perShop.get(shopId);
}

/** { resolved, url }: `resolved` false only when the API says the object is gone. */
async function look(objectId, shopId) {
  try {
    const object = await getObject(objectId, { shopId });
    if (!object) return { resolved: false, url: '' };
    return { resolved: true, url: typeof object.url === 'string' ? object.url : '' };
  } catch {
    // Not knowing is not "gone": nothing is cleared on a failed read.
    return { resolved: true, url: '' };
  }
}

/**
 * Reads every image the identity names. → { loaded, addresses } where
 * `loaded[idKey] = { id, resolved }` and `addresses[idKey | 'gallery:<id>'] = url`.
 */
export async function readImages(identity, shopId) {
  const loaded = {};
  const addresses = {};
  const jobs = [];
  for (const key of IMAGE_ID_KEYS) {
    const id = identity?.[key];
    if (!isObjectId(id)) continue;
    jobs.push(look(id, shopId).then((seen) => {
      loaded[key] = { id, resolved: seen.resolved };
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

/** The patch that clears every stored reference whose object is gone ({} when none is). */
export function deadReferencesPatch(identity, { loaded, addresses }) {
  const patch = {};
  for (const [key, entry] of Object.entries(loaded)) if (entry.resolved === false) patch[key] = null;
  if (Array.isArray(identity?.gallery) && identity.gallery.some((item) => addresses[`gone:${item?.imageObjectId}`])) {
    patch.gallery = identity.gallery.map((item) => {
      if (!addresses[`gone:${item?.imageObjectId}`]) return item;
      const { imageObjectId, ...rest } = item;
      return rest;
    });
  }
  return patch;
}
