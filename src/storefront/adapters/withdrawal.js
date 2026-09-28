// The withdrawal function's shapes (CP4 brief F2, G). Pure.
//
// The API: POST /v1/withdrawals (cloudflare/src/routes/storefront-withdrawals.ts)
//   { orderNumber, statement: { name, contactEmail } }
//   201/200 { withdrawal: { acknowledgement, alreadyReceived, eligible, reason } }
//   400 invalid_request · 404 (one answer: no such order, or not its address) · 429
// The client (src/api/withdrawal.js) takes `{ orderNumber, name, contactEmail }`.

/** The three facts the buyer states, trimmed (the server trims as well). */
export function toWithdrawalRequest({ orderNumber, name, contactEmail }) {
  return {
    orderNumber: String(orderNumber ?? '').trim(),
    name: String(name ?? '').trim(),
    contactEmail: String(contactEmail ?? '').trim(),
  };
}

/**
 * The receipt as the page prints it: the keys the page reads, under the
 * names the source's function used (the API kept them).
 */
function toPageAcknowledgement(acknowledgement) {
  return {
    submittedAt: acknowledgement.submittedAt,
    orderNumber: acknowledgement.orderNumber,
    statement: acknowledgement.statement,
    withdrawnItems: Array.isArray(acknowledgement.withdrawnItems)
      ? acknowledgement.withdrawnItems.map((item) => ({ name: item.name, sku: item.sku, quantity: item.quantity }))
      : [],
  };
}

/**
 * The page's two states from the answer:
 *   { acknowledgement, refusal: null }   the message is received: the receipt
 *   { acknowledgement: null, refusal }   the order has no right that the
 *                                        function can take ('personalized_exempt'
 *                                        | 'window_passed'), as the page shows
 *                                        it today
 * A second message for the same order (`alreadyReceived`) answers the FIRST
 * message's receipt, whose time of receipt is the first one's.
 */
export function toWithdrawalView(answer) {
  if (!answer || typeof answer !== 'object') return { acknowledgement: null, refusal: null };
  if (answer.eligible === false) {
    return { acknowledgement: null, refusal: answer.reason || 'unknown' };
  }
  return {
    acknowledgement: answer.acknowledgement && typeof answer.acknowledgement === 'object'
      ? toPageAcknowledgement(answer.acknowledgement)
      : null,
    refusal: null,
  };
}

/** An ApiError of the route → 'not_found' | 'rate_limited' | 'other'. */
export function withdrawalErrorKind(error) {
  if (error?.status === 404) return 'not_found';
  if (error?.status === 429) return 'rate_limited';
  return 'other';
}
