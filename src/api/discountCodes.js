// The discount code preview (CP8-DC, cloudflare/src/routes/storefront-discount-preview.ts):
//
//   POST /v1/discount-codes/preview   { code, items: [{ productId, quantity, variantId? }] }
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

/** Resolves the `discount` object; refusals arrive as ApiError. */
export async function previewDiscountCode({ code, items }, { signal } = {}) {
  const { data } = await request('/v1/discount-codes/preview', {
    method: 'POST',
    body: {
      code,
      items: items.map(({ productId, quantity, variantId }) =>
        variantId ? { productId, quantity, variantId } : { productId, quantity },
      ),
    },
    signal,
  });
  return data.discount;
}
