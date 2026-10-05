// AddShopUserModal's data layer — the ADMIN build's implementation (CP5
// brief FI). The alias list of vite.admin.config.js puts this module in place
// of src/components/platform/addShopUserData.js (the older build's,
// Firebase); both export the same names with the same meaning.
//
// A shop admin is INVITED, never given a password:
//   1. POST /v1/platform/users { accountType: 'tenant_admin', email }
//      No password: the identity is created password-less in one step
//      (provision-users.ts createInvitedUser, CP5-WJ4). 409 → the address is taken.
//   2. POST /v1/platform/tenants/:id/admins { userId }
//   3. POST /v1/platform/users/:id/invite → the password-set link (72 h) by
//      e-mail; a failure here, or an answer saying no mail can leave this
//      environment (`mailConfigured` false, CP9-OB), is the modal's
//      `emailNotice` branch: the person cannot sign in until a mail arrives.
// The name field is not shown (NAME_FIELD false): no route stores a name.

import { createTenantAdminUser, grantTenantAdmin, invitePlatformUser } from '../../api/admin/platform.js';
import { inviteErrorText, isConflict } from '../adapters/platformShops.js';
import { mailNotSentMessage } from '../adapters/member.js';

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
  // CP9-OB: what the Worker says happened, never more. `emailNotice` is the
  // whole sentence the modal shows when no mail left.
  try {
    const invite = await invitePlatformUser(user.userId);
    return invite?.mailConfigured === false
      ? { emailSent: false, emailNotice: mailNotSentMessage(email) }
      : { emailSent: true };
  } catch (error) {
    return {
      emailSent: false,
      emailError: inviteErrorText(error),
      emailNotice: `Inget mejl skickades (${inviteErrorText(error)}). ${email} kan inte logga in förrän en inbjudan har gått fram. Skicka den igen under Användare.`,
    };
  }
}
