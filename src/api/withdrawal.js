// The withdrawal function (DAL 2 kap. 10 a §; guest withdrawal stays, D11).
//
//   POST /v1/withdrawals   (cloudflare/src/routes/storefront-withdrawals.ts)
//     { orderNumber, statement: { name, contactEmail } }
//       contactEmail = the address the purchase was made with; the receipt is
//       mailed there
//     201 { withdrawal: { acknowledgement, alreadyReceived: false, eligible, reason } }
//         the message is recorded now, with the server's time of receipt;
//         eligible false carries reason 'personalized_exempt' | 'window_passed'
//     200 the same shape with alreadyReceived: true: a message for this order
//         is on record already, and this is ITS receipt
//     400 invalid_request
//     404 no order with that number and purchase address (one answer for both)
//     429 rate_limited

import { request } from './client.js';

export async function submitWithdrawal({ orderNumber, name, contactEmail }, { signal } = {}) {
  const { data } = await request('/v1/withdrawals', {
    method: 'POST',
    body: { orderNumber, statement: { name, contactEmail } },
    signal,
  });
  return data.withdrawal;
}
