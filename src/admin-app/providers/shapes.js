// The pure parts of the admin providers (tested under Node in shapes.test.mjs):
// the API's answers in the shapes the pages read.

import { STORE } from '../../config/store.js';

/** The `features` of a `/v1/admin/shop` answer: booleans only. */
export function featuresOf(shop) {
  const features = {};
  const raw = shop && typeof shop === 'object' ? shop.features : null;
  if (raw && typeof raw === 'object') {
    for (const [key, enabled] of Object.entries(raw)) {
      if (typeof enabled === 'boolean') features[key] = enabled;
    }
  }
  return features;
}

/**
 * The store settings in the shape StoreSettingsContext.jsx gave the pages
 * (the keys of config/store.js), from `GET /v1/admin/settings` (`settings`)
 * and `GET /v1/admin/shop` (`shop`), either of which may be null:
 *   - the saved store identity's keys as they are (`logoObjectId` etc. stay
 *     object ids: the address of an image is not part of the settings);
 *   - the gate fields beside it (returnAddress, vatRegistered, vatNumber,
 *     sellerType);
 *   - the platform-owned identity of the shop (D99: read-only for a seller):
 *     shopName, supportEmail, currency, vatRate (from vatRateBp).
 */
export function settingsFromAdmin(settings, shop) {
  const saved = {};
  const identity = settings?.storeIdentity;
  if (identity && typeof identity === 'object' && !Array.isArray(identity)) Object.assign(saved, identity);
  for (const key of ['returnAddress', 'vatRegistered', 'vatNumber', 'sellerType']) {
    if (settings && settings[key] !== undefined) saved[key] = settings[key];
  }
  if (shop && typeof shop === 'object') {
    if (typeof shop.shopName === 'string') saved.shopName = shop.shopName;
    if (typeof shop.supportEmail === 'string') saved.supportEmail = shop.supportEmail;
    if (typeof shop.currency === 'string') saved.currency = shop.currency;
    if (Number.isSafeInteger(shop.vatRateBp)) saved.vatRate = shop.vatRateBp / 10000;
  }
  return saved;
}

/**
 * The static defaults overridden, key by key, by the non-empty saved values;
 * `__loaded` true (the read is over). As StoreSettingsContext.jsx merges.
 */
export function mergeSettings(saved) {
  const merged = { ...STORE, __loaded: true };
  for (const [key, value] of Object.entries(saved || {})) {
    if (value !== undefined && value !== null && value !== '') merged[key] = value;
  }
  return merged;
}
