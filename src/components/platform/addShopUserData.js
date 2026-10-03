// AddShopUserModal's data layer — the OLDER build's implementation (Firebase).
//
// The modal (AddShopUserModal.jsx) reaches its data only through this module,
// so one component serves two builds: the admin build (vite.admin.config.js)
// swaps it, by its alias list, for
// src/admin-app/replacements/addShopUserData.js (the API). Both files export
// the same names with the same meaning.
//
// Everything here is the modal's former inline code, moved and unchanged.

import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase/config';

/** The new admin's name is stored with the account here. */
export const NAME_FIELD = true;

/**
 * The platform-gated createShopUser callable (creates the Auth account +
 * users/{uid} doc + claims + credentials email). Resolves
 * { emailSent, emailError }.
 */
export async function addShopUser({ shop, email, name }) {
  const createShopUser = httpsCallable(functions, 'createShopUser');
  const res = await createShopUser({ shopId: shop.id, email, name: name.trim() });
  return res.data || {};
}
