// The cart's discount code (CP8-DC), the parts that are pure. Under Node:
//   node --test src/storefront/adapters/*.test.mjs
//
// The code a buyer types is normalised as the server normalises it
// (cloudflare/src/commerce/discount-codes.ts normalizeDiscountCode and
// isValidDiscountCode): trimmed, upper case, 1–50 characters, no whitespace
// or control character inside. A code of the wrong shape never leaves the
// page; the server would answer 400 for it.
//
// What the cart shows comes from the preview (POST /v1/discount-codes/preview),
// which is display only: the payment step shows the server's checkout, whose
// answer counts.

const MAX_CODE_LENGTH = 50;
const FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f]/;

/** The code as the server will look it up. */
export function normalizeDiscountCode(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

/** The server's shape rule for a normalised code. */
export function isDiscountCodeShape(code) {
  return typeof code === 'string' && code.length >= 1 && code.length <= MAX_CODE_LENGTH && !FORBIDDEN.test(code);
}

/**
 * What an answer of the preview means for the cart: 'applies', 'not_applicable'
 * (the one answer for every code that does not apply), 'invalid_format' (400),
 * 'rate_limited' (429), or 'unavailable' (anything else: no answer, the shop
 * takes no checkout, a line cannot be bought).
 */
export function previewOutcome({ discount, error } = {}) {
  if (error) {
    if (error.status === 400) return 'invalid_format';
    if (error.status === 429) return 'rate_limited';
    return 'unavailable';
  }
  return discount?.applies === true && Number.isSafeInteger(discount.discountMinor) && discount.discountMinor > 0
    ? 'applies'
    : 'not_applicable';
}

/** The words of each outcome: [translation key, Swedish fallback]. */
export const DISCOUNT_MESSAGES = {
  applies: ['discount_code_added', 'Rabattkoden är tillagd.'],
  not_applicable: ['discount_code_not_applicable', 'Koden kan inte användas för den här varukorgen.'],
  invalid_format: ['discount_code_invalid_format', 'Ange koden utan mellanslag.'],
  rate_limited: ['discount_code_rate_limited', 'För många försök. Vänta en stund och försök igen.'],
  unavailable: ['discount_code_unavailable', 'Koden kunde inte kontrolleras just nu. Försök igen.'],
};

/**
 * The discount the cart shows, in öre: the last preview's amount, only when
 * it applies and is for the code the cart holds. Anything else shows none.
 */
export function previewedDiscountMinor(preview, storedCode) {
  return typeof storedCode === 'string' &&
    preview?.code === storedCode &&
    preview.applies === true &&
    Number.isSafeInteger(preview.discountMinor) &&
    preview.discountMinor > 0
    ? preview.discountMinor
    : 0;
}

/** The stored code of a cart read from storage: a well-shaped string or null. */
export function storedDiscountCode(value) {
  return typeof value === 'string' && isDiscountCodeShape(value) ? value : null;
}
