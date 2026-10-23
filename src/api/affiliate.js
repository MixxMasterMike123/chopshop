// The storefront's affiliate routes (CP13, cloudflare/src/routes/affiliate-storefront.ts;
// design §5.1, §7.1). Both answer the opaque 404 while the shop is not public
// or its `affiliate` add-on is off.
//
//   GET  /v1/affiliate-terms
//     200 { terms: { version, publishedAt, sha256, text } }   rendered for the shop
//   POST /v1/affiliate-applications
//     { name, email, phone?, socials?: { website?, instagram?, youtube?, facebook?, tiktok? },
//       promotionMethod, message? (≤ 2000), preferredLang: 'sv'|'en', termsVersion, termsAccepted: true }
//     202 { applicationId }   always after validation (also for an address that
//                             already applied: the answer never tells)
//     400 invalid_request     a malformed body, or not the current terms version
//     429 rate_limited        5 an hour per visitor, 20 a day per shop

import { request } from './client.js';

/** The channels the form offers, in the API's words. */
export const PROMOTION_METHODS = ['blog', 'youtube', 'instagram', 'facebook', 'tiktok', 'forum', 'other'];
/** The link fields the API takes, in the form's order. */
export const SOCIAL_KEYS = ['website', 'instagram', 'youtube', 'facebook', 'tiktok'];
export const MESSAGE_MAX = 2000;

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The body of POST /v1/affiliate-applications from the form's state. Texts
 * are trimmed; an empty optional field is left out (the API reads absent and
 * empty alike, the body stays small). Nothing is decided here that the server
 * decides (the e-mail rule, the lengths): it refuses with 400.
 */
export function toApplicationBody(form, termsVersion) {
  const body = {
    name: trimmed(form?.name),
    email: trimmed(form?.email),
    promotionMethod: trimmed(form?.promotionMethod),
    preferredLang: form?.preferredLang === 'en' ? 'en' : 'sv',
    termsVersion: String(termsVersion ?? ''),
    termsAccepted: form?.termsAccepted === true,
  };
  const phone = trimmed(form?.phone);
  if (phone) body.phone = phone;
  const message = trimmed(form?.message);
  if (message) body.message = message;
  const socials = {};
  for (const key of SOCIAL_KEYS) {
    const value = trimmed(form?.socials?.[key]);
    if (value) socials[key] = value;
  }
  if (Object.keys(socials).length > 0) body.socials = socials;
  return body;
}

/** The form's required fields are filled and the terms ticked (the button's state). */
export function applicationReady(form) {
  return Boolean(
    trimmed(form?.name) &&
      trimmed(form?.email) &&
      PROMOTION_METHODS.includes(trimmed(form?.promotionMethod)) &&
      (form?.preferredLang === 'sv' || form?.preferredLang === 'en') &&
      form?.termsAccepted === true &&
      trimmed(form?.message).length <= MESSAGE_MAX,
  );
}

/**
 * What a refusal of the application means for the page: 'rate_limited'
 * (429), 'invalid' (400: a field the server refused, or the terms changed
 * under the page), 'closed' (404: the program is not open here), 'other'.
 */
export function applicationRefusal(error) {
  if (error?.status === 429) return 'rate_limited';
  if (error?.status === 400) return 'invalid';
  if (error?.status === 404) return 'closed';
  return 'other';
}

/** The shop's current affiliate terms: `{ version, publishedAt, sha256, text }`. */
export async function getAffiliateTerms({ signal } = {}) {
  const { data } = await request('/v1/affiliate-terms', { signal });
  return data.terms;
}

/** Sends the application; resolves `{ applicationId }`. Refusals arrive as ApiError. */
export async function submitAffiliateApplication(body, { signal } = {}) {
  const { data } = await request('/v1/affiliate-applications', { method: 'POST', body, signal });
  return { applicationId: data?.applicationId ?? null };
}
