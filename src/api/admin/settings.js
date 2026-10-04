// The shop's store settings (CP5 brief FE; cloudflare/src/routes/admin-settings.ts):
//
//   GET /v1/admin/settings  → { settings: { storeIdentity, returnAddress,
//                               vatRegistered, vatNumber, sellerType, updatedAt } }
//   PUT /v1/admin/settings  { storeIdentity?, returnAddress?, vatRegistered?,
//                             vatNumber?, sellerType? } → { settings }
//       Each PRESENT field is replaced; storeIdentity is replaced WHOLE.
//       400 invalid_request · refused_store_identity_keys {keys} ·
//       unreferencable_images {keys}
//   PATCH /v1/admin/settings  (CP5-WK; the admin's saves since unit CP5-FP)
//       { expectedUpdatedAt: <updatedAt as read> | null,
//         storeIdentity?: { <top-level key>: value }, the four gate fields? }
//       → 200 { settings }: each named identity key replaced
//       → 409 { error: { code: 'conflict' }, settings }: the row moved since
//         `expectedUpdatedAt`; nothing was written, `settings` is what is stored
//       400 as the PUT, for the keys written
//
// An acting-as platform user may read and write these (the audit row carries
// the grant).

import { AdminApiError, adminRequest } from './client.js';

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

/**
 * The fenced partial write. → { settings } (the merged settings). A 409
 * conflict rejects with the AdminApiError, `stored` set to the answer's
 * `settings` (what is stored now; null when the answer carried none).
 */
export async function patchSettings(body, { shopId } = {}) {
  try {
    const { data } = await adminRequest('PATCH', '/v1/admin/settings', options(shopId, { json: body }));
    return { settings: data?.settings ?? null };
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 409 && error.code === 'conflict') {
      const stored = error.body?.settings;
      error.stored = stored && typeof stored === 'object' ? stored : null;
    }
    throw error;
  }
}
