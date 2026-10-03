// src/config/shopConfig.js for the admin build (alias list,
// vite.admin.config.js): the same names, fed by the API of the active shop.
//
//   loadShopConfig(shopId)    GET /v1/admin/settings + GET /v1/admin/shop, in the
//                             flat shape the Firestore storeIdentity had
//                             (providers/shapes.js settingsFromAdmin)
//   loadShopFeatures(shopId)  the `features` of GET /v1/admin/shop
//   saveShopConfig            REFUSES (not_available) until the settings units
//                             (FE, FG) give it its semantics: PUT
//                             /v1/admin/settings REPLACES the store identity
//                             whole where Firestore merged, and the shop's name,
//                             support address and VAT rate are refused keys
//                             (D99). Built here, it would silently drop fields.
//   load/saveCartRecovery, load/saveReviewSettings: the two add-ons are not
//                             ported (D81): the loads answer {}, the saves refuse.

import { adminRequest, notAvailable } from '../../api/admin/client.js';
import { featuresOf, settingsFromAdmin } from '../providers/shapes.js';

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

export const saveShopConfig = async () => {
  throw notAvailable('Spara butiksinställningarna');
};

export const loadCartRecovery = async () => ({});

export const saveCartRecovery = async () => {
  throw notAvailable('Övergiven kassa');
};

export const loadReviewSettings = async () => ({});

export const saveReviewSettings = async () => {
  throw notAvailable('Recensioner');
};
