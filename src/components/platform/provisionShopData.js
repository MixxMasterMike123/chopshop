// ProvisionShopModal's data layer — the OLDER build's implementation (Firebase).
//
// The modal (ProvisionShopModal.jsx) reaches its data only through this
// module, so one component serves two builds: the admin build
// (vite.admin.config.js) swaps it, by its alias list, for
// src/admin-app/replacements/provisionShopData.js (the API). Both files
// export the same names with the same meaning.
//
// Everything here is the modal's former inline code, moved and unchanged.

import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../firebase/config';

/** The accent colour is written with the new shop here. */
export const ACCENT_FIELD = true;

/** The note under the form: a new shop starts hidden from search engines, open by link. */
export { NEW_SHOP_NOTE } from '../../pages/platform/publishCopy.js';

/**
 * Creates shops/{id}. Resolves 'exists' when the id is taken (nothing is
 * written), else 'created'.
 */
export async function provisionShop({ id, name, accent, preset }) {
  // Uniqueness check (rules also prevent overwrite via create, but check for a clear message).
  const existing = await getDoc(doc(db, 'shops', id));
  if (existing.exists()) {
    return 'exists';
  }

  await setDoc(doc(db, 'shops', id), {
    name: name.trim(),
    storeIdentity: {
      shopName: name.trim(),
      accent,
    },
    status: 'active',
    // A new shop starts hidden from search engines: the storefront is open +
    // shoppable via link, but carries a noindex robots meta until the operator
    // clicks GO LIVE on the shop detail page. (status=active is the kill-switch;
    // published controls search-engine indexing only.)
    published: false,
    features: preset.features,
    // Immutable audit crumb (D1) — written once at creation, never read at
    // runtime. Live gating always reads features.pod; this field only
    // records what was chosen at provisioning time.
    shopType: preset.type,
    ownerUid: null, // owner assignment is a later slice (P4.6)
    createdAt: serverTimestamp(),
    provisionedVia: 'platform',
  });
  return 'created';
}
