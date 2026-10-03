// src/config/shopConfig.js for the admin build (alias list,
// vite.admin.config.js): the same names, fed by the API of the active shop.
//
//   loadShopConfig(shopId)    GET /v1/admin/settings + GET /v1/admin/shop, in the
//                             flat shape the Firestore storeIdentity had
//                             (providers/shapes.js settingsFromAdmin)
//   loadShopFeatures(shopId)  the `features` of GET /v1/admin/shop
//   saveShopConfig(patch, shopId)  READ-MODIFY-WRITE (unit FE): GET
//                             /v1/admin/settings, the patch merged into the
//                             stored identity as Firestore's merge write did
//                             (adapters/settings.js settingsPutBody), then PUT
//                             the WHOLE identity (the PUT replaces it) with the
//                             gate fields (returnAddress, vatRegistered,
//                             vatNumber, sellerType) beside it. The platform's
//                             keys (D99: shopName, supportEmail, vatRate,
//                             currency) are never sent. NO LOCK: a write by
//                             someone else between the GET and the PUT (one
//                             round trip) is lost; a guarded PATCH of a later
//                             Worker unit closes that window. This tab's own
//                             saves are queued, so they never race each other.
//   load/saveCartRecovery, load/saveReviewSettings: the two add-ons are not
//                             ported (D81): the loads answer {}, the saves refuse.

import { adminRequest, notAvailable } from '../../api/admin/client.js';
import { featuresOf, settingsFromAdmin } from '../providers/shapes.js';
import { getSettings, putSettings } from '../../api/admin/settings.js';
import { settingsPutBody } from '../adapters/settings.js';

const shopOption = (shopId) => (shopId && shopId !== '__unresolved__' ? { shopId } : {});

export const loadShopConfig = async (shopId) => {
  const [settings, shop] = await Promise.all([
    adminRequest('GET', '/v1/admin/settings', shopOption(shopId)).then(({ data }) => data?.settings ?? null),
    adminRequest('GET', '/v1/admin/shop', shopOption(shopId)).then(({ data }) => data?.shop ?? null),
  ]);
  return settingsFromAdmin(settings, shop);
};

export const loadShopFeatures = async (shopId) => {
  const { data } = await adminRequest('GET', '/v1/admin/shop', shopOption(shopId));
  return featuresOf(data?.shop);
};

// The saves of this tab run one after another: a page's two writes in quick
// succession (a text saved on leaving its field, then the acceptance's save)
// each read what the one before wrote. Another tab or person is not covered.
let saveQueue = Promise.resolve();

export const saveShopConfig = (patch, shopId) => {
  const option = shopOption(shopId);
  const run = saveQueue.then(async () => {
    const current = await getSettings(option);
    return putSettings(settingsPutBody(current, patch), option);
  });
  saveQueue = run.catch(() => {});
  return run;
};

export const loadCartRecovery = async () => ({});

export const saveCartRecovery = async () => {
  throw notAvailable('Övergiven kassa');
};

export const loadReviewSettings = async () => ({});

export const saveReviewSettings = async () => {
  throw notAvailable('Recensioner');
};
