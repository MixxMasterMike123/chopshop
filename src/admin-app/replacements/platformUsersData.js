// PlatformUsers' data layer: the ADMIN build's implementation (CP5 brief FJ).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/platform/platformUsersData.js (the older build's, Firebase); both
// export the same names with the same meaning, so the page is the same file in
// both builds.
//
// The list is GET /v1/platform/users, once for platform admins and once for
// shop admins (each to its end). "Ta bort" is DEACTIVATE (POST …/deactivate):
// the identity is switched off and every session ends, nothing is deleted, and
// the account can be switched on again (…/reactivate) and invited (…/invite).
// A platform admin cannot be reactivated over HTTP (D63): the page shows the
// server's refusal. Creating a platform admin over HTTP is refused by design
// (D51): the button leaves.

import { AdminApiError, notAvailable } from '../../api/admin/client.js';
import {
  deactivatePlatformUser,
  invitePlatformUser,
  reactivatePlatformUser,
  readAllPlatformUsers,
} from '../../api/admin/platform.js';
import { ADMIN_ACCOUNT_TYPES, sortUsers, userActionMessage, userRowOf } from '../adapters/platformConsole.js';

/** D51: a platform admin is not created over HTTP. */
export const CAN_CREATE_PLATFORM_ADMIN = false;

/** An account can be inactive here: a badge, "Återaktivera" and "Skicka inbjudan". */
export const USER_LIFECYCLE = true;

/**
 * What the page says about "Ta bort", and what it does here. The older
 * confirmation ("tas bort permanent") would be untrue: the account is switched
 * off, not deleted, and can be switched on again.
 */
export const REMOVE_COPY = {
  confirm: (email) => `Inaktivera ${email}? Inloggningen stängs av och alla inloggade sessioner avslutas. Kontot raderas inte och kan återaktiveras.`,
  selfTitle: 'Du kan inte inaktivera ditt eget konto',
  title: 'Inaktivera användaren',
  label: 'Inaktivera',
  busy: 'Inaktiverar…',
  done: (email) => `${email} inaktiverad`,
  failed: 'Kunde inte inaktivera användaren',
};

/** An API error → an Error in the page's language (the page shows `.message`). Others pass. */
function asPageError(error) {
  if (!(error instanceof AdminApiError)) return error;
  const message = userActionMessage(error);
  if (message === null) return error;
  const wrapped = new Error(message);
  wrapped.code = error.code;
  return wrapped;
}

async function run(call) {
  try {
    return await call();
  } catch (error) {
    throw asPageError(error);
  }
}

/** The admins: [{ uid, email, contactPerson, shopId, platform, suspended, hasPassword }]. */
export async function loadUsers() {
  const users = await readAllPlatformUsers(ADMIN_ACCOUNT_TYPES);
  return sortUsers(users.map(userRowOf));
}

/** Deactivates the user. Resolves the user's row (now suspended). */
export const removeUser = (uid) => run(async () => userRowOf(await deactivatePlatformUser(uid)));

/** Switches the account on again. Resolves the user's row. A platform admin is refused (D63). */
export const reactivateUser = (uid) => run(async () => userRowOf(await reactivatePlatformUser(uid)));

/** Mails the user an invitation (a link to set a password). */
export const inviteUser = (uid) => run(() => invitePlatformUser(uid));

/** Refused (D51). */
export async function createSuperAdmin() {
  throw notAvailable('Att skapa en plattformsadmin');
}
