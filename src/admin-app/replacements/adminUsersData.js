// AdminUsers' data layer: the ADMIN build's implementation (CP5 brief FH, D100).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/admin/adminUsersData.js (the older build's); both export the same
// names, so the page is one file in both builds.
//
// The page lists THIS SHOP's admins: GET /v1/admin/members, an invitation
// (POST) and a removal (POST …/revoke). Roles, a trade margin and the user
// create/edit pages do not exist here.

import { useMemo } from 'react';
import { useShopId } from '../../contexts/ShopContext';
import { inviteMember, listMembers, revokeMember } from '../../api/admin/members.js';
import { REVOKE_BLOCK, isInviteMailFailure, memberActionMessage, memberRowsOf } from '../adapters/member.js';

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
    inviteAdmin: ({ email, name }) => guarded(() => inviteMember({ shopId, email, name })),
    removeAdmin: (userId) => guarded(() => revokeMember({ shopId, userId })),
  }), [shopId]);
}
