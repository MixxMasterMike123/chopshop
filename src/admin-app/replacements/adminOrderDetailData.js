// AdminOrderDetail's data layer — the ADMIN build's implementation (CP5 unit
// FD). The alias list of vite.admin.config.js puts this module in place of
// src/pages/admin/adminOrderDetailData.js (the older build's, Firebase); both
// export the same names with the same meaning.
//
//   fetchOrderUser    there are no buyer accounts (D81): the buyer is the
//                     order's e-mail address and recipient; always null.
//   refundWholeOrder  POST /v1/admin/orders/:id/refunds for what the server
//                     says is still refundable (`money.refundableMinor`), with
//                     one Idempotency-Key per click, reused on its retries.
//                     The amount is the server's; nothing is computed here.
//                     Resolves the outcome the page announces: `{ pending }`.
//                     A 202 (`reserved`: Stripe's answer did not come back)
//                     is NOT a refund yet — the webhook or the reconciliation
//                     settles it — so it is pending, with `message` to show
//                     instead of "Ordern återbetalad" (CP5-FX, finding 3).

import { refundOrder } from '../../api/admin/orders.js';
import { withUserMessage } from '../providers/ordersForShop.js';

/** Why the refund was made (the route requires a reason). */
export const REFUND_REASON = 'Hela ordern återbetalad från admin';

/** What the page says when the refund is under way but not confirmed. */
export const REFUND_PENDING_MESSAGE = 'Återbetalningen är påbörjad men inte bekräftad ännu. Ladda om sidan om en stund.';

const refusal = (code) => withUserMessage(Object.assign(new Error(code), { code }));

export async function fetchOrderUser(_userId) {
  return null;
}

export async function refundWholeOrder(orderId, order) {
  const amountMinor = order?.refundableMinor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw refusal('refund_not_allowed');
  }
  let refund;
  try {
    refund = await refundOrder(orderId, { amountMinor, reason: REFUND_REASON });
  } catch (error) {
    throw withUserMessage(error);
  }
  // Stripe answered no: the reservation was released, nothing was refunded.
  if (refund.state === 'failed') throw refusal('refund_failed');
  // Stripe's outcome is unknown: the money is held for the refund, not yet returned.
  if (refund.accepted === true || refund.state === 'reserved') {
    return { pending: true, message: REFUND_PENDING_MESSAGE, refund };
  }
  return { pending: false, refund };
}
