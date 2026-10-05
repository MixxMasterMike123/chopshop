// The checkout's money shapes (CP4 brief F2). Pure functions: no React, no
// fetch, no storage, so they run under Node beside the client's tests.
//
//   buildCheckoutRequest  what the page sends to POST /v1/checkout: products,
//                         variants and quantities, the buyer's e-mail address,
//                         the delivery, the recipient, the consents. NEVER a
//                         price.
//   toApiRecipient        who gets the order and where (D98), from what the
//                         form collects.
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

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * `recipient` of POST /v1/checkout (cloudflare/src/commerce/recipient.ts
 * parseRecipient) from what the checkout form collects:
 *   `shippingInfo`  { firstName, lastName, address, apartment, postalCode,
 *                   city, phone? } — the name is first + last name
 *   `pickupLocationId`, `pickupDate`  the chosen pickup occasion
 * A parcel sends { name, addressLine1, addressLine2?, postalCode, city,
 * country, phone? }, `country` the request's shipping country; a pickup
 * { name, phone?, pickupLocationId, pickupDate? }. Texts are trimmed; an empty
 * optional field is left out. What the server refuses (an empty name, an
 * unknown place) is the server's to refuse: nothing is invented here.
 */
export function toApiRecipient({ deliveryMethod, shippingCountry, shippingInfo, pickupLocationId, pickupDate }) {
  const info = shippingInfo && typeof shippingInfo === 'object' ? shippingInfo : {};
  const recipient = { name: [text(info.firstName), text(info.lastName)].filter(Boolean).join(' ') };
  const phone = text(info.phone);
  if (phone) recipient.phone = phone;

  if (toApiDeliveryMethod(deliveryMethod) === 'pickup') {
    recipient.pickupLocationId = String(pickupLocationId ?? '');
    if (text(pickupDate)) recipient.pickupDate = text(pickupDate);
    return recipient;
  }

  recipient.addressLine1 = text(info.address);
  if (text(info.apartment)) recipient.addressLine2 = text(info.apartment);
  recipient.postalCode = text(info.postalCode);
  recipient.city = text(info.city);
  recipient.country = String(shippingCountry || '').toUpperCase();
  return recipient;
}

/**
 * The body of POST /v1/checkout (without the idempotency key, which the
 * caller keeps per request).
 *
 * `items`: the cart's lines as the cart provider gives them
 * (`[{ productId, quantity, variantId? }]`). `shippingInfo`,
 * `pickupLocationId`, `pickupDate`: the recipient (toApiRecipient). `withdrawal`: the page's gate,
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
 *
 * `discountCode` (CP8-DC): the code the CART holds (`cart.discountCode`), never
 * the text of a field; sent only when it is a non-empty string, so a request
 * without one is the same request as before, and the payment is made again
 * only when a code is added or removed.
 *
 * `reminder` (CP9-AC): the box "Påminn mig via e-post om jag inte slutför
 * köpet", shown only while the shop sends reminders. `consent.reminder: true`
 * is sent ONLY when it is literally true: an unticked or hidden box leaves the
 * request byte for byte what it was, so its idempotency key and the frozen
 * consent of every unticked checkout are unchanged
 * (cloudflare/src/legal/consent.ts rule 4).
 */
export function buildCheckoutRequest({
  items,
  email,
  deliveryMethod,
  shippingCountry,
  shippingInfo,
  pickupLocationId,
  pickupDate,
  marketing,
  reminder,
  withdrawal,
  discountCode,
}) {
  const method = toApiDeliveryMethod(deliveryMethod);
  const consent = { terms: true, marketing: marketing === true };
  if (reminder === true) consent.reminder = true;
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
  request.recipient = toApiRecipient({ deliveryMethod: method, shippingCountry, shippingInfo, pickupLocationId, pickupDate });
  if (typeof discountCode === 'string' && discountCode.trim() !== '') {
    request.discountCode = discountCode.trim();
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
 * The discount keys keep the names the page reads. The server echoes the code
 * the request sent (`discountCode`) and answers 0 when it did not apply
 * (CP8-DC); the discount rows open only for an amount above 0.
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
