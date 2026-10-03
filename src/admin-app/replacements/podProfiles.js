// src/config/podProfiles.js for the ADMIN build (CP5 unit FM): the print
// profiles from GET /v1/admin/pod/profiles (the platform's specification
// list, read by a shop admin), in the older settings/podProfiles shape
// (adapters/pod.js profileFromApi). Same contract as the original: the load
// never throws and degrades to [] (the upload modal then says no profile was
// found). Cached per SHOP (the route is a shop's): a load for another shop
// never answers from this one's cache, and a failed load is not cached.

import { getRequestShopId } from '../../api/admin/client.js';
import { loadProfiles } from './podLibraryLoad.js';

const cache = new Map(); // shopId → profiles[]

/** loadPodProfiles() → Promise<Array<profile>> for the tab's shop. */
export const loadPodProfiles = async () => {
  const shopId = getRequestShopId();
  if (!shopId) return [];
  if (cache.has(shopId)) return cache.get(shopId);
  try {
    const profiles = await loadProfiles(shopId);
    cache.set(shopId, profiles);
    return profiles;
  } catch (err) {
    console.warn('podProfiles: could not load the print profiles, using [] :', err?.message);
    return [];
  }
};

/** The API answers no version; every profile list is treated as provisional, as before a load. */
export const getPodProfilesMeta = () => ({ version: 0, provisional: true });

/** Find a loaded profile by its id (e.g. 'apparel_dtg'). Returns null if absent. */
export const getProfileById = (profiles, id) =>
  (Array.isArray(profiles) ? profiles : []).find((p) => p && p.id === id) || null;

/** Drop the cache so the next load reads the API again. */
export const clearPodProfilesCache = () => {
  cache.clear();
};

/** The older build's studio harness seeds its cache; nothing to seed here. */
export const seedPodProfilesCacheForDev = () => {};
