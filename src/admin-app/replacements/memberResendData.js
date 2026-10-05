// "Skicka inbjudan igen" on AdminUsers (unit CP5-FP): its own module, without
// React, so it runs under Node against the dev API (pages/new/fpData.test.mjs);
// adminUsersData.js hands it to the page.
//
// POST /v1/admin/members/:userId/resend-invite (adminRequest, X-Shop-Id of
// the page's shop). The sentences are adapters/member.js's.

import { listMembers, resendMemberInvite } from '../../api/admin/members.js';
import { isLostAnswer } from '../adapters/platformModels.js';
import {
  RESEND_UNCLEAR,
  memberRowsOf,
  resendDoneMessage,
  resendGoneMessage,
  resendRefusal,
} from '../adapters/member.js';

const said = (message, reload = false) => Object.assign(new Error(message), { reload });

/**
 * "Skicka inbjudan igen" for `user` (a page row). → { message, notSent }; rejects with
 * an Error whose message is the seller's sentence and `reload` true when the
 * list must be read again. A 404 is told apart by reading the list: gone from
 * it → no longer a member; still in it → the route is off here (no invite
 * mail in this environment). A lost answer cannot be read back (nothing a
 * route shows moves), so it is said to be unclear; sending again is safe.
 */
export async function resendInvite(shopId, user) {
  try {
    const invite = await resendMemberInvite({ shopId, userId: user.id });
    // CP9-OB: `notSent` when no mail can leave this environment (the message says so).
    return { message: resendDoneMessage(user.email, invite), notSent: invite?.mailConfigured === false };
  } catch (error) {
    const refusal = resendRefusal(error, user.email);
    if (refusal) throw said(refusal.message, refusal.reload);
    if (error?.status === 404) {
      let listed = true;
      try {
        listed = memberRowsOf(await listMembers({ shopId })).some((row) => row.id === user.id);
      } catch {
        // The list cannot be read: say what the 404 can mean, both ways.
        throw said(`${user.email} hittades inte som administratör här, eller så kan inbjudningar inte skickas härifrån just nu. Ladda om sidan.`);
      }
      throw said(resendGoneMessage(listed, user.email), !listed);
    }
    if (isLostAnswer(error)) throw said(RESEND_UNCLEAR);
    throw said('Inbjudan kunde inte skickas igen.');
  }
}
