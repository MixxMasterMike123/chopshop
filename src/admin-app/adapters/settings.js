// The settings page's shapes (CP5 brief FE), pure, tested under Node in
// settings.test.mjs. Nothing here talks to the API: src/api/admin/settings.js
// and src/api/admin/legal.js send, src/admin-app/replacements/* call both.
//
//   settingsPutBody(current, patch)   the whole identity for PUT /v1/admin/settings
//                                     (the read-modify-write saveShopConfig used
//                                     before the fenced PATCH)
//   settingsPatchBody(base, patch, defaults)  the fenced partial write (CP5-FP):
//                                     PATCH /v1/admin/settings with the changed
//                                     top-level keys only; settingsAfterPatch,
//                                     patchHolds and settingsConflictMessage beside it
//   readinessFromStatus(status)       GET /v1/admin/legal/status → the page's
//                                     { ready, blockers } (legalPageReadiness.js shape)
//   acceptanceFromView(view)          GET /v1/admin/legal/pages `acceptance` → the
//                                     pointer the page reads (storeIdentity.legal.acceptance)
//                                     (`email` is the signer's label: signer.js)
//   acceptPagesBody(input)            the exact body of POST /v1/admin/legal/accept-pages
//   refusedTextKeys(details)          the pages a refused text is laid at (error.details.pages)

import { sameValue } from './merge.js';
import { signerLabelOf } from './signer.js';

/**
 * Identity keys the API refuses in `storeIdentity` (cloudflare/src/platform/
 * tenant-config.ts REFUSED_STORE_IDENTITY_KEYS), plus the page-local `__loaded`.
 * The four gate keys among them travel as top-level fields instead (GATE_KEYS);
 * the rest are the platform's (D99) or not the seller's at all.
 */
export const REFUSED_IDENTITY_KEYS = Object.freeze([
  'commissionBps', 'currency', 'defaultCurrency', 'defaultLocale', 'features', 'payments',
  'platformTerms', 'published', 'returnAddress', 'sellerType', 'shopId', 'shopName', 'status',
  'stripeAccountId', 'supportEmail', 'tenantId', 'vatNumber', 'vatRate', 'vatRateBp', 'vatRegistered',
]);
const LOCAL_KEYS = ['__loaded'];
/** `legal.*` keys the API refuses (the adoption pointer lives in legal_acceptances). */
export const REFUSED_LEGAL_KEYS = Object.freeze(['acceptance']);

/** The legal-readiness fields: top-level fields of the PUT, not identity keys. */
export const GATE_KEYS = Object.freeze(['returnAddress', 'vatRegistered', 'vatNumber', 'sellerType']);

/** The three legal pages, as the API names them (legal-pages.ts LEGAL_PAGE_KEYS). */
export const LEGAL_KEYS = Object.freeze(['kopvillkor', 'angerratt', 'integritetspolicy']);

/** legal-pages.ts / platform-terms.ts TERMS_VERSION_PATTERN. */
const VERSION_PATTERN = /^[0-9A-Za-z._-]{1,32}$/;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * Firestore's `setDoc(…, { merge: true })`, which the older build's
 * saveShopConfig used: plain objects merge key by key at every depth; arrays,
 * strings, numbers, booleans and null replace; `undefined` is skipped. A new
 * object is returned; neither argument is changed.
 */
export function mergeLikeFirestore(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeLikeFirestore(out[key], value);
    else if (isPlainObject(value)) out[key] = mergeLikeFirestore({}, value);
    else out[key] = value;
  }
  return out;
}

/** The identity part of a page's patch: without the refused, gate and local keys, nor legal.acceptance. */
export function identityPartOf(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (REFUSED_IDENTITY_KEYS.includes(key) || LOCAL_KEYS.includes(key)) continue;
    if (key === 'legal' && isPlainObject(value)) {
      out.legal = Object.fromEntries(Object.entries(value).filter(([k]) => !REFUSED_LEGAL_KEYS.includes(k)));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The gate fields a patch carries, in the API's types ('' clears to null). */
export function gateFieldsOf(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (Object.hasOwn(patch, 'returnAddress')) {
    const value = patch.returnAddress;
    out.returnAddress = typeof value === 'string' && value.trim() !== '' ? value : null;
  }
  if (Object.hasOwn(patch, 'vatRegistered')) {
    out.vatRegistered = typeof patch.vatRegistered === 'boolean' ? patch.vatRegistered : null;
  }
  if (Object.hasOwn(patch, 'vatNumber')) {
    const value = patch.vatNumber;
    out.vatNumber = typeof value === 'string' && value.trim() !== '' ? value : null;
  }
  if (Object.hasOwn(patch, 'sellerType')) {
    out.sellerType = patch.sellerType === 'company' || patch.sellerType === 'individual' ? patch.sellerType : null;
  }
  return out;
}

/**
 * The read-modify-write of saveShopConfig. `current` is the `settings` of
 * GET /v1/admin/settings read just before; `patch` is what the page passes,
 * in the flat Firestore shape (identity keys and gate keys side by side).
 * PUT replaces the stored identity whole, so the body carries ALL of it: the
 * current identity with the patch's identity keys merged in as Firestore
 * merged them. The platform's keys (D99: name, support address, VAT rate,
 * currency) are dropped, never sent.
 */
export function settingsPutBody(current, patch) {
  const stored = isPlainObject(current?.storeIdentity) ? current.storeIdentity : {};
  // A stored copy of a refused key (an import, a hand fix) is never sent back.
  const base = identityPartOf(stored);
  return {
    storeIdentity: mergeLikeFirestore(base, identityPartOf(patch)),
    ...gateFieldsOf(patch),
  };
}

// ── the fenced partial write (unit CP5-FP) ──────────────────────────────────
// PATCH /v1/admin/settings { expectedUpdatedAt, storeIdentity?: { key: value },
// returnAddress?, vatRegistered?, vatNumber?, sellerType? }: each named
// top-level identity key is REPLACED, and nothing is written unless the row is
// still at `expectedUpdatedAt` (409 conflict + the stored settings otherwise).

const isEmptyValue = (value) => value === undefined || value === null || value === '';

/** A gate field as the Worker stores it: text trimmed, empty text null (tenant-config.ts parseOptionalText). */
function storedGateValue(key, value) {
  if ((key === 'returnAddress' || key === 'vatNumber') && typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

/**
 * THE body of the PATCH for a page's patch (the flat shape, as for
 * settingsPutBody) against `base`, the settings the page read (a GET's or the
 * last write's `settings`): only the identity keys and gate fields whose value
 * the patch CHANGES, fenced on `base.updatedAt`. The PATCH replaces a key
 * whole, so an object in the patch (`legal: { customTexts: … }`) is merged into
 * the stored object first, as Firestore's merge write did. A key the page
 * showed from `defaults` (STORE) because nothing is stored, sent back as it
 * was, is no change. The platform's keys and legal.acceptance are never sent.
 * null: nothing changes, so no request is owed.
 */
export function settingsPatchBody(base, patch, defaults = {}) {
  const stored = identityPartOf(isPlainObject(base?.storeIdentity) ? base.storeIdentity : {});
  const storeIdentity = {};
  for (const [key, value] of Object.entries(identityPartOf(patch))) {
    if (value === undefined) continue;
    const next = isPlainObject(value)
      ? mergeLikeFirestore(isPlainObject(stored[key]) ? stored[key] : {}, value)
      : value;
    if (sameValue(next, stored[key])) continue;
    if (isEmptyValue(stored[key]) && Object.hasOwn(defaults, key) && sameValue(next, defaults[key])) continue;
    storeIdentity[key] = next;
  }
  const gates = {};
  for (const [key, value] of Object.entries(gateFieldsOf(patch))) {
    const next = storedGateValue(key, value);
    if (next !== (base?.[key] ?? null)) gates[key] = next;
  }
  if (Object.keys(storeIdentity).length === 0 && Object.keys(gates).length === 0) return null;
  return {
    expectedUpdatedAt: typeof base?.updatedAt === 'string' ? base.updatedAt : null,
    ...(Object.keys(storeIdentity).length > 0 ? { storeIdentity } : {}),
    ...gates,
  };
}

/** The top-level keys a PATCH body writes (identity keys, then gate fields). */
export function patchedKeys(body) {
  return [...Object.keys(body?.storeIdentity ?? {}), ...GATE_KEYS.filter((key) => Object.hasOwn(body ?? {}, key))];
}

/** The settings as the page expects them once `body` is written over `base` (updatedAt aside). */
export function settingsAfterPatch(base, body) {
  const identity = isPlainObject(base?.storeIdentity) ? base.storeIdentity : {};
  const out = { ...(base ?? {}), storeIdentity: { ...identity, ...(body?.storeIdentity ?? {}) } };
  for (const key of GATE_KEYS) if (Object.hasOwn(body ?? {}, key)) out[key] = body[key];
  return out;
}

/** Whether `stored` (a GET after a lost answer) holds every value `body` writes. */
export function patchHolds(stored, body) {
  if (!stored || typeof stored !== 'object') return false;
  const identity = isPlainObject(stored.storeIdentity) ? stored.storeIdentity : {};
  for (const [key, value] of Object.entries(body?.storeIdentity ?? {})) {
    if (!sameValue(identity[key], value)) return false;
  }
  return GATE_KEYS.every((key) => !Object.hasOwn(body ?? {}, key) || (stored[key] ?? null) === body[key]);
}

/**
 * The settings pages' fields as the seller reads them, by top-level key (the
 * identity's, the gate fields, and the addresses AdminStorefront edits in
 * place of its image ids), for the sentence about a change that was lost.
 */
export const SETTINGS_FIELD_LABELS = Object.freeze({
  legalName: 'Juridiskt företagsnamn',
  tagline: 'Slogan',
  phone: 'Telefon',
  logoUrl: 'Logotyp',
  logoObjectId: 'Logotyp',
  address: 'Adress',
  pickupLocations: 'Upphämtningsställen',
  companyDescription: 'Företagsbeskrivning',
  orgNumber: 'Organisationsnummer',
  businessInfo: 'Företagsinfo',
  social: 'Sociala länkar',
  trustpilot: 'Trustpilot',
  legal: 'Juridiska texter',
  returnAddress: 'Returadress',
  vatRegistered: 'Momsregistrerad',
  vatNumber: 'Momsregistreringsnummer',
  sellerType: 'Säljartyp',
  templateId: 'Mall',
  accent: 'Accentfärg',
  faviconUrl: 'Favicon',
  faviconObjectId: 'Favicon',
  heroImageUrl: 'Hero-bild',
  heroObjectId: 'Hero-bild',
  heroHeadline: 'Hero-text',
  heroSubtitle: 'Hero-text',
  heroCtaLabel: 'Hero-text',
  heroSecondaryLabel: 'Hero-text',
  frontpageCategory: 'Startsida',
  featuredLimit: 'Startsida',
  featuredTitle: 'Startsida',
  collectionsTitle: 'Startsida',
  productsTitle: 'Startsida',
  productsSubtitle: 'Startsida',
  reviewsTitle: 'Startsida',
  reviewsSubtitle: 'Startsida',
  introTitle: 'Introtext',
  introBody: 'Introtext',
  storyTitle: 'Berättelse',
  story: 'Berättelse',
  gallery: 'Galleri',
  blocks: 'Startsidans block',
  menu: 'Menyn',
});

const listText = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} och ${names.at(-1)}`);

/**
 * What a page says after its write was refused because the settings changed
 * since it read them (409 conflict): nothing was saved, the page now shows
 * what is stored with the person's edits kept where the other change did not
 * touch them, and — `lost`, mergeThree's paths — which edits were not kept.
 * `lostAnswer`: the write's answer was lost and the read-back found another
 * change and not this one (whether this one landed first is not known).
 */
export function settingsConflictMessage(lost = [], { lostAnswer = false } = {}) {
  const names = [...new Set(lost.map((path) => SETTINGS_FIELD_LABELS[path[0]] ?? null))];
  const known = names.filter(Boolean);
  const head = lostAnswer
    ? 'Anslutningen bröts, och när inställningarna lästes igen hade någon annan ändrat dem: din ändring finns inte bland det som är sparat. Sidan visar nu det som är sparat.'
    : 'Någon annan har ändrat butikens inställningar sedan sidan lästes in, så din ändring sparades inte. Sidan visar nu det som är sparat.';
  if (names.length === 0) {
    return `${head} Det du ändrat finns kvar; kontrollera och spara igen.`;
  }
  const what = known.length === 0 ? 'ett av fälten'
    : names.length > known.length ? `${listText(known)} och ett fält till`
      : listText(known);
  return `${head} Din ändring av ${what} gick förlorad, eftersom den andra ändringen gällde samma fält: gör om den om den behövs. Det du ändrat i andra fält finns kvar; kontrollera och spara igen.`;
}

// ── the legal readiness ─────────────────────────────────────────────────────

/** The labels of src/utils/legalPageReadiness.js, for the same keys. */
export const READINESS_LABELS = Object.freeze({
  platformTerms: 'Plattformsvillkoren är inte godkända',
  returnAddress: 'Returadress saknas',
  vatRegistered: 'Momsregistrering ej angiven (krävs för att momstexten ska matcha kassan)',
  acceptance: 'Villkoren är inte godkända av butiksägaren',
});

/**
 * The server's checkout gate (GET /v1/admin/legal/status) in the page's
 * shape. `ready` is the checkout's own rule (checkout.ts): the platform terms
 * accepted (or in their grace period) AND the three legal conditions.
 * Null when the answer is not the route's shape.
 */
export function readinessFromStatus(status) {
  const readiness = status && typeof status === 'object' ? status.readiness : null;
  if (!readiness || typeof readiness !== 'object') return null;
  const termsOpen = status.accepted === true || status.inGrace === true;
  const blockers = [];
  if (!termsOpen) blockers.push({ key: 'platformTerms', label: READINESS_LABELS.platformTerms });
  if (readiness.returnAddress !== true) blockers.push({ key: 'returnAddress', label: READINESS_LABELS.returnAddress });
  if (readiness.vatAnswered !== true) blockers.push({ key: 'vatRegistered', label: READINESS_LABELS.vatRegistered });
  if (readiness.legalPagesAccepted !== true) blockers.push({ key: 'acceptance', label: READINESS_LABELS.acceptance });
  return { ready: blockers.length === 0 && readiness.ready === true, blockers };
}

/**
 * The adoption pointer the page reads (`storeIdentity.legal.acceptance` in
 * the older build: { uid, email, acceptedAt, templateVersion, acceptanceId }).
 * The view names its signer (`acceptedBy`): `email` is the signer's label (the
 * address, or "Plattformen" for a platform signer); there is no uid. A view
 * without a signer (the POST's answer) has no `email` key. An imported
 * adoption may carry `version` instead of `templateVersion`.
 */
export function acceptanceFromView(view) {
  if (!view || typeof view !== 'object' || typeof view.acceptedAt !== 'string') return null;
  const templateVersion = typeof view.templateVersion === 'string' ? view.templateVersion
    : typeof view.version === 'string' ? view.version : '';
  const signer = signerLabelOf(view.acceptedBy);
  return {
    ...(signer ? { email: signer } : {}),
    acceptedAt: view.acceptedAt,
    templateVersion,
    acceptanceId: typeof view.acceptanceId === 'string' ? view.acceptanceId : '',
  };
}

/** The per-page `custom` map: true exactly where the page is the seller's own text. */
export function customPagesOf(custom) {
  const map = {};
  for (const key of LEGAL_KEYS) map[key] = Boolean(custom && custom[key] === true);
  return map;
}

/**
 * THE body of POST /v1/admin/legal/accept-pages, exactly the four keys the
 * route takes (legal-pages.ts parseAcceptPagesInput), or a thrown Error naming
 * what is wrong. `texts` are sent as they are: the caller passes the very
 * strings it showed. `customPages` is the per-page map (customPagesOf).
 */
export function acceptPagesBody({ templateVersion, texts, pod, customPages }) {
  if (typeof templateVersion !== 'string' || !VERSION_PATTERN.test(templateVersion)) {
    throw new Error('templateVersion is not a version');
  }
  if (typeof pod !== 'boolean') throw new Error('pod must be a boolean');
  const sent = {};
  for (const key of LEGAL_KEYS) {
    const text = texts ? texts[key] : undefined;
    if (typeof text !== 'string' || text.length === 0) throw new Error(`the text of ${key} is empty`);
    sent[key] = text;
  }
  if (Object.keys(texts).some((key) => !LEGAL_KEYS.includes(key))) throw new Error('texts names an unknown page');
  const custom = {};
  for (const key of LEGAL_KEYS) {
    if (typeof customPages?.[key] !== 'boolean') throw new Error(`custom.${key} must be a boolean`);
    custom[key] = customPages[key];
  }
  return { templateVersion, texts: sent, pod, custom };
}

/**
 * Whether the texts the page would adopt now differ from the latest adoption
 * (`adopted` = the `acceptance` of GET /v1/admin/legal/pages) so that the
 * seller must adopt again: another template version; a page switched between
 * the template and the seller's own text; an own text whose SHA-256 (`shas`,
 * of the custom keys) is not the adopted page's. A template page's text is
 * not compared: it carries the date it was rendered on. null when nothing
 * was adopted.
 */
export function textsChangedSince(adopted, { templateVersion, customPages, shas = {} }) {
  if (!adopted || typeof adopted !== 'object') return null;
  const adoptedVersion = typeof adopted.templateVersion === 'string' ? adopted.templateVersion
    : typeof adopted.version === 'string' ? adopted.version : null;
  if (adoptedVersion !== templateVersion) return true;
  const map = isPlainObject(adopted.customPages) ? adopted.customPages : null;
  const pageSha = isPlainObject(adopted.pageSha256) ? adopted.pageSha256 : {};
  for (const key of LEGAL_KEYS) {
    const ownNow = customPages?.[key] === true;
    if (ownNow && shas[key] !== pageSha[key]) return true;
    if (!ownNow && map && map[key] === true) return true;
  }
  // An adoption that kept only the summary: some page was the seller's own.
  if (!map && adopted.custom === true && !LEGAL_KEYS.some((key) => customPages?.[key] === true)) return true;
  return false;
}

/** The pages' names in the seller's language (the keys are the API's). */
export const LEGAL_PAGE_NAMES = Object.freeze({
  kopvillkor: 'Köpvillkor',
  angerratt: 'Ångerrätt',
  integritetspolicy: 'Integritetspolicy',
});

/**
 * The pages a 400 `invalid_request` of accept-pages names (`error.details.pages`,
 * in the Worker's key order; the unknown ones are ignored). Empty when it names
 * none: then the body itself was malformed, not a text refused.
 */
export function refusedTextKeys(details) {
  const pages = details && typeof details === 'object' && Array.isArray(details.pages) ? details.pages : [];
  return LEGAL_KEYS.filter((key) => pages.includes(key));
}

/** "Köpvillkor och Ångerrätt": the pages as a sentence part. */
export function pageNamesOf(keys) {
  const names = keys.map((key) => LEGAL_PAGE_NAMES[key]).filter(Boolean);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} och ${names.at(-1)}`;
}
