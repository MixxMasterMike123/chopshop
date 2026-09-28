// Checkout and payment (the CP2 routes, src/app.ts handleCheckoutRoute and
// handleCheckoutPaymentRoute). The server prices everything: the request names
// products, variants and quantities, never a price.

import { request, segment } from './client.js';

/** An idempotency key for one checkout attempt (8–128 of [A-Za-z0-9._-]). */
export function newIdempotencyKey() {
  return globalThis.crypto.randomUUID();
}

/**
 * POST /v1/checkout. `items`: `[{ productId, quantity, variantId? }]` (1–50,
 * quantity 1–999). `deliveryMethod`: 'shipping' | 'pickup'; `shippingCountry`
 * (ISO alpha-2) only for 'shipping'. `consent`: `{ terms: true, marketing?,
 * withdrawalWaiver?, disclosureVersion? }` (disclosureVersion only with a
 * ticked waiver). `recipient` (D98): who gets the order and where, as
 * storefront/adapters/checkout.js toApiRecipient builds it. No discount code
 * is sent: discount codes are not ported (D81).
 *
 * Resolves `{ checkout, replayed }`: the priced checkout (`checkoutId`,
 * `items`, `subtotalMinor`, `shippingMinor`, `vatMinor`, `vatRateBp`,
 * `discountMinor`, `totalMinor`, `currency`, `expiresAt`, …); `replayed` when
 * the same key was used before for the same request (200 instead of 201).
 * Refusals arrive as ApiError: 400 `invalid_request`, 400
 * `withdrawal_waiver_required` / `withdrawal_disclosure_outdated`, 404 (the
 * shop does not sell), 409 `conflict` (key reused for another request), 422
 * `unprocessable` (a line cannot be bought), 429 `rate_limited`.
 */
export async function createCheckout(
  { items, email, deliveryMethod, shippingCountry, consent, idempotencyKey, recipient },
  { signal } = {},
) {
  const body = {
    consent,
    deliveryMethod,
    email,
    idempotencyKey,
    items: items.map(({ productId, quantity, variantId }) =>
      variantId ? { productId, quantity, variantId } : { productId, quantity },
    ),
  };
  if (deliveryMethod === 'shipping') body.shippingCountry = shippingCountry;
  // D98: who gets the order and where (storefront/adapters/checkout.js
  // toApiRecipient). The server refuses a checkout without one.
  if (recipient !== undefined) body.recipient = recipient;

  const { status, data } = await request('/v1/checkout', { method: 'POST', body, signal });
  return { checkout: data.checkout, replayed: status === 200 };
}

/**
 * POST /v1/checkout/:id/payment — no body. Resolves `{ clientSecret,
 * paymentIntentId, created }` for Stripe.js. 404: the checkout cannot be paid
 * (unknown, expired, another shop's, or the shop cannot take payments).
 */
export async function createPayment(checkoutId, { signal } = {}) {
  const { status, data } = await request(`/v1/checkout/${segment(checkoutId)}/payment`, {
    method: 'POST',
    signal,
  });
  return { ...data.payment, created: status === 201 };
}
