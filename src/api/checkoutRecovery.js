// The two links of an abandoned-checkout reminder (CP9-AC,
// cloudflare/src/routes/storefront-checkout-recovery.ts). Both are POST and
// carry no body: the token in the path is the whole request.
//
//   POST /v1/checkout-recovery/:token
//     200 { recovery: { status: 'open', items: [{ productId, quantity, variantId? }] } }
//         the lines as references only: no price, no name, no address
//     200 { recovery: { status: 'completed' } }  the checkout became an order
//     404 the link does not work (any reason, one answer)
//   POST /v1/checkout-recovery/:token/unsubscribe
//     200 { unsubscribed: true }   now or before
//     404 the link does not work
//   both: 429 rate_limited

import { ApiError, request, segment } from './client.js';

const badResponse = () => new ApiError({ status: 200, code: 'bad_response', message: 'The answer had an unknown shape' });

/**
 * The resume link's cart: `{ status: 'open', items }`, `{ status: 'completed', items: [] }`,
 * or `{ status: 'invalid', items: [] }` for the one 404. Anything else rejects.
 */
export async function resolveCheckoutRecovery(token, { signal } = {}) {
  let data;
  try {
    ({ data } = await request(`/v1/checkout-recovery/${segment(token)}`, { method: 'POST', signal }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { status: 'invalid', items: [] };
    throw error;
  }
  const recovery = data?.recovery;
  if (recovery?.status === 'completed') return { status: 'completed', items: [] };
  if (recovery?.status === 'open' && Array.isArray(recovery.items)) return { status: 'open', items: recovery.items };
  throw badResponse();
}

/** true: unsubscribed (now or before); false: the link does not work. Anything else rejects. */
export async function unsubscribeCheckoutReminders(token, { signal } = {}) {
  let data;
  try {
    ({ data } = await request(`/v1/checkout-recovery/${segment(token)}/unsubscribe`, { method: 'POST', signal }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
  if (data?.unsubscribed === true) return true;
  throw badResponse();
}
