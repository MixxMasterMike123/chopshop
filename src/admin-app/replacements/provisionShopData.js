// ProvisionShopModal's data layer — the ADMIN build's implementation (CP5
// brief FI). The alias list of vite.admin.config.js puts this module in place
// of src/components/platform/provisionShopData.js (the older build's,
// Firebase); both export the same names with the same meaning.
//
// A new shop, in three calls:
//   1. POST /v1/platform/tenants { tenantId, shopName, hostname }  (409 → 'exists')
//      The API needs a storefront hostname at creation; the modal asks for
//      none, so the shop gets the placeholder provisionHostnameFor(id)
//      (the storefront on the shared host finds it by path, D77).
//   2. PUT /v1/platform/tenants/:id/features — the Butikstyp preset's values
//      for the keys the API allows.
//   3. POST /v1/platform/tenants/:id/unpublish — the API creates a shop
//      published; the console's rule is that a new shop starts unpublished
//      (here: closed to visitors, D57).
// If 2 or 3 fails the shop exists: the modal closes as created and a toast
// names what to redo on the shop's detail page.
//
// Not written here: the accent colour (no platform route writes a shop's
// store identity: the field is not shown, ACCENT_FIELD false) and the
// `shopType` crumb (no column).

import toast from 'react-hot-toast';
import {
  createTenant,
  provisionHostnameFor,
  putTenantFeatures,
  setTenantPublished,
} from '../../api/admin/platform.js';
import { API_FEATURE_KEYS, isConflict, provisionFeaturesOf } from '../adapters/platformShops.js';

export const ACCENT_FIELD = false;

/** The note under the form: a new shop starts unpublished, closed to visitors (D57). */
export { NEW_SHOP_NOTE } from './publishCopy.js';

export async function provisionShop({ id, name, preset }) {
  try {
    await createTenant({ tenantId: id, shopName: name.trim(), hostname: provisionHostnameFor(id) });
  } catch (error) {
    if (isConflict(error)) return 'exists';
    throw error;
  }

  const unfinished = [];
  try {
    await putTenantFeatures(id, provisionFeaturesOf(preset.features, API_FEATURE_KEYS));
  } catch (error) {
    console.error('Provision: features not set', error);
    unfinished.push('butikstypen (Tillägg)');
  }
  try {
    await setTenantPublished(id, false);
  } catch (error) {
    console.error('Provision: unpublish failed', error);
    unfinished.push('avpublicera butiken (AVPUBLICERA)');
  }
  if (unfinished.length > 0) {
    toast.error(`Butiken skapades, men detta gick inte: ${unfinished.join(', ')}. Gör om det på butikens detaljsida.`, {
      duration: 10000,
    });
  }
  return 'created';
}
