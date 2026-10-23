// The shop's platform address (CP14): `<label>.<base domain>`, e.g.
// melodiemc.flippinstuff.se. Pure; tested under Node in shopAddress.test.mjs.
// The API decides (cloudflare/src/tenancy/subdomain.ts): this module only
// tidies what is typed, says early what the API would refuse for its
// characters, and turns the API's error codes into Swedish.
//
//   normalizeLabel(typed)          lowercase, trimmed (what is sent)
//   labelProblem(label)            null, or the Swedish message for a label
//                                  the API refuses for its grammar
//   addressPreview(label, base)    'label.base' (null without a base)
//   addressErrorMessage(error)     the API error → Swedish (upptagen / reserverad /
//                                  ogiltigt tecken / av / generic)

export const LABEL_MAX_LENGTH = 63;
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export const ADDRESS_COPY = {
  title: 'Butikens adress',
  help: 'Adressen kunderna når butiken på. Små bokstäver a–z, siffror och bindestreck.',
  moved: 'Byter du adress skickas besökare på den gamla vidare till den nya i 90 dagar. Därefter kan en annan butik ta den.',
  none: 'Butiken har ingen adress ännu.',
  save: 'Spara adress',
  saving: 'Sparar…',
  saved: (hostname) => `Butikens adress sparad: ${hostname}`,
  unchanged: 'Adressen är oförändrad.',
  previous: (hostname, until) => `${hostname} skickas vidare hit till ${until}.`,
  invalid: 'Ogiltigt tecken. Använd bara a–z, 0–9 och bindestreck, inte först eller sist.',
  tooLong: `Högst ${LABEL_MAX_LENGTH} tecken.`,
  empty: 'Skriv en adress.',
  reserved: 'Adressen är reserverad för plattformen. Välj en annan.',
  taken: 'Adressen är upptagen. Välj en annan.',
  off: 'Butiksadresser är inte påslagna på plattformen ännu.',
  failed: 'Kunde inte spara adressen. Försök igen.',
};

export function normalizeLabel(typed) {
  return typeof typed === 'string' ? typed.trim().toLowerCase() : '';
}

export function labelProblem(label) {
  if (typeof label !== 'string' || label === '') return ADDRESS_COPY.empty;
  if (label.length > LABEL_MAX_LENGTH) return ADDRESS_COPY.tooLong;
  if (!LABEL_PATTERN.test(label) || label.startsWith('xn--')) return ADDRESS_COPY.invalid;
  return null;
}

export function addressPreview(label, base) {
  if (!base) return null;
  return `${label || '…'}.${base}`;
}

export function addressErrorMessage(error) {
  switch (error?.code) {
    case 'subdomain_invalid':
      return ADDRESS_COPY.invalid;
    case 'subdomain_reserved':
      return ADDRESS_COPY.reserved;
    case 'subdomain_taken':
      return ADDRESS_COPY.taken;
    case 'subdomains_off':
      return ADDRESS_COPY.off;
    default:
      return ADDRESS_COPY.failed;
  }
}

/** An ISO time → a Swedish date (2027-01-21), or the input when it does not parse. */
export function swedishDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso ?? '') : date.toLocaleDateString('sv-SE');
}
