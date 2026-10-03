// AdminUsers' data layer: the OLDER build's implementation. It wraps what the
// page called on useAuth() before (getAllUsers, updateUserRole,
// updateUserMarginal), unchanged. The admin build swaps this module for
// src/admin-app/replacements/adminUsersData.js (vite.admin.config.js), which
// exports the same names.

import { useAuth } from '../../contexts/AuthContext';

/** The older page lists every user, with roles and a trade margin; no invite. */
export const MEMBER_ADMINS = false;

export const REVOKE_BLOCK = {};

export function useUsersData() {
  const { getAllUsers, updateUserRole, updateUserMarginal } = useAuth();
  return {
    getAllUsers,
    updateUserRole,
    updateUserMarginal,
    inviteAdmin: async () => { throw new Error('Inbjudan finns inte i den här versionen.'); },
    removeAdmin: async () => { throw new Error('Borttagning finns inte i den här versionen.'); },
  };
}
