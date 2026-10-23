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

// ── CP13: the link's code (`?ref=CODE`, design §2.1, §2.2, §7.4) ─────────────
//
// A landing on any storefront page with `?ref=` puts the normalised code into
// the shop's own cart as `{ refCode, source: 'link', refAt }` (refAt: the
// landing's time in milliseconds) and takes the parameter out of the address.
// Nothing else is stored: no cookie, no key of its own. The stamp is dropped
// 30 days after the landing and by a completed checkout (the cart is
// emptied). The count of the landing is the server's (the web Worker passes
// the code on the SEO call it already makes); the page calls nothing for it.
//
// The preview and the checkout get the link's code as `refCode` beside the
// typed `code`; the server decides which one counts (the link wins).

export const REF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The affiliate code grammar after normalisation (the web Worker's and the
 * API's own, cloudflare/src/affiliate/affiliates.ts): 3–20 of A–Z, 0–9 and
 * '-'. A `ref` outside it is no affiliate's code and is never stored (a live
 * stamp stays as it was).
 */
export const REF_CODE_PATTERN = /^[A-Z0-9-]{3,20}$/;

/** The `ref` of a query string, normalised; null when absent, repeated or not of the affiliate grammar. */
export function refCodeFromSearch(search) {
  let values;
  try {
    values = new URLSearchParams(search ?? '').getAll('ref');
  } catch {
    return null;
  }
  if (values.length !== 1) return null;
  const code = normalizeDiscountCode(values[0]);
  return REF_CODE_PATTERN.test(code) ? code : null;
}

/** True when a query string carries a `ref` parameter at all. */
export function hasRefParameter(search) {
  try {
    return new URLSearchParams(search ?? '').has('ref');
  } catch {
    return false;
  }
}

/** The query string without its `ref` parameters: '' or '?…' (the other parameters in their order). */
export function searchWithoutRef(search) {
  const params = new URLSearchParams(search ?? '');
  params.delete('ref');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

const NO_REF = Object.freeze({ refCode: null, source: null, refAt: null });

/**
 * The link stamp of a cart read from storage (or held in memory) at `now`:
 * `{ refCode, source: 'link', refAt }` when it is well shaped and the landing
 * is at most 30 days old, else all three null.
 */
export function storedRef(saved, now = Date.now()) {
  if (!saved || typeof saved !== 'object' || saved.source !== 'link') return { ...NO_REF };
  const refCode = typeof saved.refCode === 'string' && REF_CODE_PATTERN.test(saved.refCode) ? saved.refCode : null;
  const refAt = saved.refAt;
  if (refCode === null || !Number.isSafeInteger(refAt) || now - refAt > REF_MAX_AGE_MS) return { ...NO_REF };
  return { refCode, source: 'link', refAt };
}

/** The body of the preview for the cart's two codes (typed, link); null when there is neither. */
export function previewCodes(typed, ref) {
  const body = {};
  if (typeof typed === 'string' && typed !== '') body.code = typed;
  if (typeof ref === 'string' && ref !== '') body.refCode = ref;
  return Object.keys(body).length === 0 ? null : body;
}

/**
 * The last preview, when it was asked for exactly these two codes; else null.
 * A preview: `{ applies, code, discountMinor, typed, ref }` (`code`: the code
 * the server answered for, the link's when the link won).
 */
export function currentPreview(preview, typed, ref) {
  return preview && preview.typed === (typed ?? null) && preview.ref === (ref ?? null) ? preview : null;
}

/** The discount of a current preview, in öre (0 unless it applies). */
export function currentDiscountMinor(preview) {
  return preview?.applies === true && Number.isSafeInteger(preview.discountMinor) && preview.discountMinor > 0
    ? preview.discountMinor
    : 0;
}

/**
 * What the cart says under the code box, from the current preview:
 *   { kind: 'link_added', code }            the link's code applies ("Länkkod X tillagd – rabatten visas i summeringen";
 *                                           no percent: the preview names no rate, and one read back from a
 *                                           possibly stale cart price could be wrong)
 *   { kind: 'link_overridden', code }       a typed code was set aside for it ("Länkkoden X används i stället")
 *   { kind: 'not_applicable', code }        the typed code applies to nothing here
 *   null                                    nothing to say (no code, not asked yet)
 */
export function discountNoticeOf(preview, { typed = null, ref = null } = {}) {
  if (!preview) return null;
  if (ref && preview.applies === true && preview.code === ref && currentDiscountMinor(preview) > 0) {
    return typed && typed !== ref
      ? { kind: 'link_overridden', code: ref }
      : { kind: 'link_added', code: ref };
  }
  if (typed && preview.applies !== true) return { kind: 'not_applicable', code: typed };
  return null;
}

/** The words of the link notices: [translation key, Swedish fallback] ({{code}}). */
export const LINK_MESSAGES = {
  link_added: ['discount_link_added', 'Länkkod {{code}} tillagd – rabatten visas i summeringen'],
  link_overridden: ['discount_link_overridden', 'Länkkoden {{code}} används i stället'],
};
