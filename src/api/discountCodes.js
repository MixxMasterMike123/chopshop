// The discount code preview (CP8-DC, cloudflare/src/routes/storefront-discount-preview.ts):
//
//   POST /v1/discount-codes/preview   { code?, refCode?, items: [{ productId, quantity, variantId? }] }
//     (CP13: at least one code; `refCode` is the link's code, `?ref=`; the
//     answer's `code` is the code that applied — the link's when it won)
//     200 { discount: { applies: true,  code, discountMinor } }   the code applies
//     200 { discount: { applies: false, code, discountMinor: 0 } } any other case,
//         one answer whatever the reason
//     400 invalid_request   a malformed code (whitespace, empty, over 50) or lines
//     404                   the shop takes no checkout
//     422 unprocessable     a line cannot be bought
//     429 rate_limited      too many previews from this visitor
//
// DISPLAY ONLY: nothing is held or written. The checkout prices the order and
// its answer is the one that counts (it can only be stricter).

import { request } from './client.js';

/** Resolves the `discount` object; refusals arrive as ApiError. A code that is not a non-empty string is left out. */
export async function previewDiscountCode({ code, refCode, items }, { signal } = {}) {
  const body = {};
  if (typeof code === 'string' && code !== '') body.code = code;
  if (typeof refCode === 'string' && refCode !== '') body.refCode = refCode;
  body.items = items.map(({ productId, quantity, variantId }) =>
    variantId ? { productId, quantity, variantId } : { productId, quantity },
  );
  const { data } = await request('/v1/discount-codes/preview', { method: 'POST', body, signal });
  return data.discount;
}
