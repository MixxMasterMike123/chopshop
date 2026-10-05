// CP9-OB: the identity texts that are placeholders, never a shop's own values.
//
// Until CP9-OB, src/config/store.js shipped six identity texts as defaults
// ("My Shop", "My Company", "hello@example.com", …). The older admin showed
// them as the form's VALUES and saved its whole form, so shops hold them as if
// they were their own (the import carried them: melodie-mc's legal name and
// address, three shops' support address). Such a value is NOT set: the admin
// shows the field empty, the legal pages cannot be adopted with it, the
// storefront prints nothing for it. The Worker applies the same list
// (cloudflare/src/legal/legal-identity.ts; adapters/placeholderIdentity.test.mjs
// pins the two together). Pure; shared by both builds.

/** The texts, as store.js shipped them. Compared without tags, spaces and case. */
export const PLACEHOLDER_IDENTITY_TEXTS = Object.freeze([
  'My Shop',
  'My Company',
  'Quality products, delivered.',
  'hello@example.com',
  'My Company<br>123 Main Street<br>City',
]);

/** The identity keys that had such a default. */
export const PLACEHOLDER_IDENTITY_KEYS = Object.freeze([
  'shopName', 'legalName', 'tagline', 'supportEmail', 'address', 'companyDescription',
]);

/** The generic logo (public/images/logo.svg): a drawing that reads "My Shop". */
export const PLACEHOLDER_LOGO_URL = '/images/logo.svg';

const normalized = (value) => String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

const PLACEHOLDERS = new Set(PLACEHOLDER_IDENTITY_TEXTS.map(normalized));

export const isPlaceholderText = (value) => typeof value === 'string' && PLACEHOLDERS.has(normalized(value));

/** An address at a placeholder domain (the order mails' rule, order-emails.ts realShopAddress). */
export const isPlaceholderAddress = (value) =>
  typeof value === 'string' && /@example\.(com|org|net|se)$/i.test(value.trim());

/** A text the shop really set: something in it, and not a placeholder. */
export const isRealText = (value) => typeof value === 'string' && normalized(value) !== '' && !isPlaceholderText(value);

/** A support address the shop really has: not empty, not at a placeholder domain. */
export const isRealAddress = (value) => isRealText(value) && !isPlaceholderAddress(value);

/** `values` with every placeholder of PLACEHOLDER_IDENTITY_KEYS made '' (a new object). */
export function withoutPlaceholderIdentity(values) {
  const out = { ...(values || {}) };
  for (const key of PLACEHOLDER_IDENTITY_KEYS) {
    const value = out[key];
    if (typeof value !== 'string') continue;
    if (isPlaceholderText(value) || (key === 'supportEmail' && isPlaceholderAddress(value))) out[key] = '';
  }
  return out;
}

/** The shop's own logo address, or '' when it has none (the generic drawing is none). */
export const ownLogoUrl = (url) => (typeof url === 'string' && url.trim() && url.trim() !== PLACEHOLDER_LOGO_URL ? url : '');
