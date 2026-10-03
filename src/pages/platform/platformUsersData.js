// PlatformUsers' data layer: the OLDER build's implementation (Firebase).
//
// The page (PlatformUsers.jsx) reaches its data only through this module, so
// one page serves two builds: the older build (vite.config.js) uses this file
// as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/platformUsersData.js (the API). Both
// files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { collection, getDocs, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../../firebase/config';

/** The page offers "Ny plattformsadmin" (a callable creates one). */
export const CAN_CREATE_PLATFORM_ADMIN = true;

/** The page knows an account can be inactive: a badge, "Återaktivera", "Skicka inbjudan". Not here. */
export const USER_LIFECYCLE = false;

/** What the page says about removing a user, and what removing does here. */
export const REMOVE_COPY = {
  confirm: (email) => `Ta bort ${email}? Kontot och inloggningen tas bort permanent.`,
  selfTitle: 'Du kan inte ta bort ditt eget konto',
  title: 'Ta bort användaren',
  label: 'Ta bort',
  busy: 'Tar bort…',
  done: (email) => `${email} borttagen`,
  failed: 'Kunde inte ta bort användaren',
};

/** The admins: [{ uid, email, contactPerson, shopId, platform }], platform admins first, then by e-mail. */
export async function loadUsers() {
  const snap = await getDocs(query(collection(db, 'users'), where('role', '==', 'admin')));
  const rows = snap.docs.map((d) => {
    const x = d.data();
    return {
      uid: d.id,
      email: x.email || '',
      contactPerson: x.contactPerson || x.displayName || '',
      shopId: x.shopId || null,
      platform: x.platform === true,
    };
  });
  // Platform admins first, then by email.
  rows.sort((a, b) => (a.platform !== b.platform ? (a.platform ? -1 : 1) : a.email.localeCompare(b.email)));
  return rows;
}

/** Removes the user for good. Resolves null: the page drops the row. */
export async function removeUser(uid) {
  await httpsCallable(functions, 'deletePlatformUser')({ uid });
  return null;
}

/** Not offered here (see USER_LIFECYCLE). */
export async function reactivateUser() {
  throw new Error('not_available');
}

/** Not offered here (see USER_LIFECYCLE). */
export async function inviteUser() {
  throw new Error('not_available');
}

/** Creates a platform super-admin and mails the credentials. Resolves the callable's data. */
export async function createSuperAdmin({ email, name }) {
  const res = await httpsCallable(functions, 'createPlatformSuperAdmin')({ email, name });
  return res.data || {};
}
