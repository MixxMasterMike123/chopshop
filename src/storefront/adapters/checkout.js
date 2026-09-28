// The checkout's money shapes (CP4 brief F2). Pure functions: no React, no
// fetch, no storage, so they run under Node beside the client's tests.
//
//   buildCheckoutRequest  what the page sends to POST /v1/checkout: products,
//                         variants and quantities, the buyer's e-mail address,
//                         the delivery, the consents. NEVER a price.
//   toCheckoutTotals      the server's priced checkout as the figures the page
//                         prints (kronor, as the page's price components take
//                         them). No checkout yet → no figure at all.
//   checkoutRefusal       an ApiError of the checkout or payment route → what
//                         the page shows for it.
//
// The API's shapes: cloudflare/src/commerce/checkout.ts (the request, the
// priced checkout, every refusal), cloudflare/src/legal/consent.ts (the
// consents), app.ts handleCheckoutRoute / handleCheckoutPaymentRoute.

/** The page's delivery word ('home' | 'pickup') as the API names it. */
export function toApiDeliveryMethod(method) {
  return method === 'pickup' ? 'pickup' : 'shipping';
}

/**
 * The body of POST /v1/checkout (without the idempotency key, which the
 * caller keeps per request).
 *
 * `items`: the cart's lines as the cart provider gives them
 * (`[{ productId, quantity, variantId? }]`). `withdrawal`: the page's gate,
 * `{ required, accepted, noticeVersion }`. The waiver and the version of the
 * text the buyer was shown are sent only when the gate was required AND
 * ticked; the server decides which lines are personalised and refuses a basket
 * that needs a waiver it did not get.
 *
 * `terms: true`: the page has no box for the purchase terms; the buyer accepts
 * them by completing the purchase ("Genom att slutföra beställningen …
 * godkänner butikens köpvillkor", printed under the payment form). This body is
 * sent on the payment step, where that sentence is on the screen, and a
 * checkout becomes an order only when the buyer pays.
 */
export function buildCheckoutRequest({ items, email, deliveryMethod, shippingCountry, marketing, withdrawal }) {
  const method = toApiDeliveryMethod(deliveryMethod);
  const consent = { terms: true, marketing: marketing === true };
  if (withdrawal?.required === true && withdrawal?.accepted === true) {
    consent.withdrawalWaiver = true;
    consent.disclosureVersion = String(withdrawal.noticeVersion || '');
  }

  const request = {
    consent,
    deliveryMethod: method,
    email: String(email ?? '').trim(),
    items: (Array.isArray(items) ? items : []).map(({ productId, quantity, variantId }) =>
      variantId ? { productId, quantity, variantId } : { productId, quantity },
    ),
  };
  if (method === 'shipping') {
    request.shippingCountry = String(shippingCountry || '').toUpperCase();
  }
  return request;
}

/** Minor units (öre) → the kronor the page's price components print; null when not a number. */
export function minorToKronor(minor) {
  return Number.isSafeInteger(minor) ? minor / 100 : null;
}

/**
 * The figures of the checkout's summary, from the server's priced checkout.
 * Before there is one, every figure is null: the page shows no total, no VAT
 * and no carriage the server has not given (its price component then renders
 * its "no price" state). `vatRate` is the server's rate once priced, else the
 * page's own default (only the label of the VAT line reads it).
 *
 * The discount keys keep the names the page reads; nothing sends a code (D81),
 * so the server answers 0 and the discount rows stay closed.
 */
export function toCheckoutTotals(checkout, fallbackVatRate) {
  if (!checkout || typeof checkout !== 'object') {
    return {
      subtotal: null,
      shipping: null,
      vat: null,
      total: null,
      vatRate: fallbackVatRate,
      discountAmount: 0,
      discountCode: null,
      discountPercentage: 0,
      discountSource: null,
    };
  }
  const discountAmount = minorToKronor(checkout.discountMinor) ?? 0;
  return {
    subtotal: minorToKronor(checkout.subtotalMinor),
    shipping: minorToKronor(checkout.shippingMinor),
    vat: minorToKronor(checkout.vatMinor),
    total: minorToKronor(checkout.totalMinor),
    vatRate: Number.isSafeInteger(checkout.vatRateBp) ? checkout.vatRateBp / 10_000 : fallbackVatRate,
    discountAmount,
    discountCode: typeof checkout.discountCode === 'string' ? checkout.discountCode : null,
    discountPercentage: 0,
    discountSource: discountAmount > 0 ? 'campaign' : null,
  };
}

/**
 * What a refusal of POST /v1/checkout or POST /v1/checkout/:id/payment means
 * for the page:
 *   'waiver_required'      400 withdrawal_waiver_required: the basket holds a
 *                          personalised line; the page shows its gate
 *   'disclosure_outdated'  400 withdrawal_disclosure_outdated: the text the
 *                          page showed is not the server's current one
 *   'closed'               404: the shop does not sell (unknown, not active,
 *                          its legal gate, no payment account), or the
 *                          checkout can no longer be paid
 *   'unpurchasable'        422: a line cannot be bought, or not the chosen way
 *   'conflict'             409: the idempotency key was used for another request
 *   'rate_limited'         429
 *   'other'                anything else (400 invalid_request, 502, network)
 */
export function checkoutRefusal(error) {
  const code = error?.code;
  const status = error?.status;
  if (code === 'withdrawal_waiver_required') return 'waiver_required';
  if (code === 'withdrawal_disclosure_outdated') return 'disclosure_outdated';
  if (status === 404) return 'closed';
  if (status === 422) return 'unpurchasable';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  return 'other';
}
