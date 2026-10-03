// The shop's store settings (CP5 brief FE; cloudflare/src/routes/admin-settings.ts):
//
//   GET /v1/admin/settings  → { settings: { storeIdentity, returnAddress,
//                               vatRegistered, vatNumber, sellerType, updatedAt } }
//   PUT /v1/admin/settings  { storeIdentity?, returnAddress?, vatRegistered?,
//                             vatNumber?, sellerType? } → { settings }
//       Each PRESENT field is replaced; storeIdentity is replaced WHOLE.
//       400 invalid_request · refused_store_identity_keys {keys} ·
//       unreferencable_images {keys}
//
// An acting-as platform user may read and write these (the audit row carries
// the grant).

import { adminRequest } from './client.js';

const options = (shopId, extra = {}) => (shopId ? { ...extra, shopId } : extra);

/** The shop's settings (`settings` of the answer). */
export async function getSettings({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', '/v1/admin/settings', options(shopId, { signal }));
  return data?.settings ?? null;
}

/** Writes the fields `body` carries; resolves the settings as stored. */
export async function putSettings(body, { shopId } = {}) {
  const { data } = await adminRequest('PUT', '/v1/admin/settings', options(shopId, { json: body }));
  return data?.settings ?? null;
}
