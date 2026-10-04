// src/config/pod3dModels.js for the ADMIN build (CP5 unit FN2): the platform's
// 3D models from GET /v1/admin/pod/3d-models (read by a shop admin; images in
// the public bucket), in the older pod3dModels document shape
// (adapters/studioMedia.js models3dFromApi). Same exports as the original.
//
// What differs from the original, on purpose (as podMockupTemplates.js here):
//   - BOUND TO THE SHOP: the route is a shop's (X-Shop-Id), so the cache is
//     keyed by the shop, and an answer that arrives after the tab moved to
//     another shop is dropped (readForShop), never shown.
//   - A FAILED READ IS NOT "NO MODELS": the load REJECTS (and is not cached).
//     DesignStudio catches it on its own (the rest of the studio still loads)
//     and says where the 3D view was that the models could not be read.
//   - Only active models arrive (the server filters).

import { getRequestShopId } from '../../api/admin/client.js';
import { isUnresolvedShopId } from '../../config/tenancy.js';
import { list3dModels } from '../../api/admin/podStudio.js';
import { readForShop } from '../providers/ordersForShop.js';
import { models3dFromApi } from '../adapters/studioMedia.js';

const loads = new Map(); // shopId → Promise<models>

/** loadPod3dModels() → Promise<Array<model>> for the tab's shop. Rejects when they cannot be read. */
export const loadPod3dModels = async () => {
  const shopId = getRequestShopId();
  // The cache holds the shop's own request; only THIS caller is dropped when
  // the tab moves shop (a dropped promise never settles, so it must never be
  // what the cache holds).
  if (!loads.has(shopId) && !isUnresolvedShopId(shopId)) {
    const load = list3dModels({ shopId }).then(models3dFromApi);
    loads.set(shopId, load);
    load.catch(() => {
      if (loads.get(shopId) === load) loads.delete(shopId); // a failure is asked again next time
    });
  }
  return readForShop(shopId, () => loads.get(shopId));
};

/** Find a loaded model by its id. Returns null if absent. */
export const getPod3dModelById = (models, id) =>
  (Array.isArray(models) ? models : []).find((m) => m && m.id === id) || null;

/** Drop the cache (the studio's "Försök igen") so the next load reads the API again. */
export const clearPod3dModelsCache = () => {
  loads.clear();
};
