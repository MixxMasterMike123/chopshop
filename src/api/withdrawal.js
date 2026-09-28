// The withdrawal function (DAL 2 kap. 10 a §; guest withdrawal stays, D11).
//
// NOT BACKED YET. The API has no withdrawal route: Firebase's
// `submitWithdrawal` is PORT in the inventory and was not built in CP2 or
// CP3, and no CP4 brief owns it. This module is written against a PROPOSED
// shape, the callable's own, so the page can be wired now:
//   POST /v1/withdrawals
//     { orderNumber, statement: { name, contactEmail } }
//     200 { withdrawal: { eligible: true, acknowledgement } }
//     200 { withdrawal: { eligible: false, reason: 'personalized_exempt' | 'window_passed' } }
//     404 no order with that number and purchase email (one answer for both)
//     429 too many attempts
// Until the route exists the web Worker does not forward the path (it is not
// on its allowlist), so a call rejects with ApiError 404. See
// docs/cf-port/CP4_E_REPORT.md, open questions.

import { request } from './client.js';

export async function submitWithdrawal({ orderNumber, name, contactEmail }, { signal } = {}) {
  const { data } = await request('/v1/withdrawals', {
    method: 'POST',
    body: { orderNumber, statement: { name, contactEmail } },
    signal,
  });
  return data.withdrawal;
}
