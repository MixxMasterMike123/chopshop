// A shop's own admins (CP5 brief FH, D100; the Worker:
// cloudflare/src/routes/admin-members.ts, report docs/cf-port/CP5_WC_REPORT.md).
//
//   GET  /v1/admin/members                    { members: [{ userId, email, name, status, invited, joinedAt, self }] }
//   POST /v1/admin/members {email, name}      201 { member }
//   POST /v1/admin/members/:userId/revoke     200 { revoked: { userId } }
//   POST /v1/admin/members/:userId/resend-invite  202 { invite: { userId, surface, expiresAt } }
//        409 not_invited | not_invitable · 429 · 503 email_unavailable · 404 (CP5-FP)
//
// All of them carry X-Shop-Id (adminRequest). Acting-as is admitted by the
// Worker; nothing here differs for it.

import { adminRequest, segment } from './client.js';

export const MEMBERS_PATH = '/v1/admin/members';

/** The shop's active admins, oldest first (at most 100). → the API's member rows */
export async function listMembers({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', MEMBERS_PATH, { shopId, signal });
  return Array.isArray(data?.members) ? data.members : [];
}

/** Adds an admin and sends the invitation. → the API's member row */
export async function inviteMember({ shopId, email, name }) {
  const { data } = await adminRequest('POST', MEMBERS_PATH, { shopId, json: { email, name } });
  return data?.member ?? null;
}

/** Ends one person's admin access to this shop. → { userId } */
export async function revokeMember({ shopId, userId }) {
  const { data } = await adminRequest('POST', `${MEMBERS_PATH}/${segment(userId)}/revoke`, { shopId });
  return data?.revoked ?? { userId };
}

/**
 * A new invite link for a member who has not set a password yet (CP5-WK;
 * unit CP5-FP). → { userId, surface, expiresAt } (never the link). The
 * previous unused link stops working.
 */
export async function resendMemberInvite({ shopId, userId }) {
  const { data } = await adminRequest('POST', `${MEMBERS_PATH}/${segment(userId)}/resend-invite`, { shopId });
  return data?.invite ?? null;
}
