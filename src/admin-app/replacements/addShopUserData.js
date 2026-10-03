// AddShopUserModal's data layer — the ADMIN build's implementation (CP5
// brief FI). The alias list of vite.admin.config.js puts this module in place
// of src/components/platform/addShopUserData.js (the older build's,
// Firebase); both export the same names with the same meaning.
//
// A shop admin is INVITED, never given a password:
//   1. POST /v1/platform/users { accountType: 'tenant_admin', email, password }
//      The route still requires an initial password (provision-users.ts, the
//      interim model); the console sends an unusable random one that no one
//      sees (platform.js unusablePassword). 409 → the address is taken.
//   2. POST /v1/platform/tenants/:id/admins { userId }
//   3. POST /v1/platform/users/:id/invite → the password-set link (72 h) by
//      e-mail; a failure here is the modal's "e-post misslyckades" branch.
// The name field is not shown (NAME_FIELD false): no route stores a name.

import { createTenantAdminUser, grantTenantAdmin, invitePlatformUser } from '../../api/admin/platform.js';
import { inviteErrorText, isConflict } from '../adapters/platformShops.js';

export const NAME_FIELD = false;

export async function addShopUser({ shop, email }) {
  let user;
  try {
    user = await createTenantAdminUser(email);
  } catch (error) {
    if (isConflict(error)) {
      throw new Error('Det finns redan ett konto med den e-postadressen.');
    }
    throw new Error('Kunde inte skapa kontot.');
  }
  try {
    await grantTenantAdmin(shop.id, user.userId);
  } catch (error) {
    console.error('grant failed', error);
    throw new Error(`Kontot ${email} skapades men kunde inte kopplas till butiken (${error?.code || 'fel'}).`);
  }
  try {
    await invitePlatformUser(user.userId);
    return { emailSent: true };
  } catch (error) {
    return { emailSent: false, emailError: inviteErrorText(error) };
  }
}
