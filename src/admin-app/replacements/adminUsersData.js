// AdminUsers' data layer: the ADMIN build's implementation (CP5 brief FH, D100).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/admin/adminUsersData.js (the older build's); both export the same
// names, so the page is one file in both builds.
//
// The page lists THIS SHOP's admins: GET /v1/admin/members, an invitation
// (POST), a removal (POST …/revoke) and a new invite link for someone who has
// not set a password yet (POST …/resend-invite, unit CP5-FP). Roles, a trade
// margin and the user create/edit pages do not exist here.

import { useMemo } from 'react';
import { useShopId } from '../../contexts/ShopContext';
import { inviteMember, listMembers, revokeMember } from '../../api/admin/members.js';
import { REVOKE_BLOCK, isInviteMailFailure, mailNotSentMessage, memberActionMessage, memberRowsOf } from '../adapters/member.js';
import { resendInvite } from './memberResendData.js';

/** The page shows the shop's own admins, with invite and remove. */
export const MEMBER_ADMINS = true;

/** An API error → an Error in the page's language (the page shows `.message`). Others pass. */
function asPageError(error) {
  const message = memberActionMessage(error);
  if (message === null) return error;
  const wrapped = new Error(message);
  wrapped.code = error.code;
  wrapped.status = error.status;
  wrapped.mailFailed = isInviteMailFailure(error);
  return wrapped;
}

async function guarded(call) {
  try {
    return await call();
  } catch (error) {
    throw asPageError(error);
  }
}

export { REVOKE_BLOCK };

/** The calls the page makes, for the active shop. Stable between renders of one shop. */
export function useUsersData() {
  const shopId = useShopId();
  return useMemo(() => ({
    getAllUsers: () => guarded(async () => memberRowsOf(await listMembers({ shopId }))),
    updateUserRole: async () => { throw new Error('Roller kan inte ändras här.'); },
    updateUserMarginal: async () => { throw new Error('Marginal finns inte här.'); },
    // CP9-OB: `notice` when the Worker says no mail can leave this environment.
    inviteAdmin: ({ email, name }) => guarded(async () => {
      const member = await inviteMember({ shopId, email, name });
      return member?.mailConfigured === false ? { ...member, notice: mailNotSentMessage(email) } : member;
    }),
    removeAdmin: (userId) => guarded(() => revokeMember({ shopId, userId })),
    resendInvite: (user) => resendInvite(shopId, user),
  }), [shopId]);
}
