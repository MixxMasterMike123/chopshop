// The settings page's shapes (CP5 brief FE), pure, tested under Node in
// settings.test.mjs. Nothing here talks to the API: src/api/admin/settings.js
// and src/api/admin/legal.js send, src/admin-app/replacements/* call both.
//
//   settingsPutBody(current, patch)   the read-modify-write of saveShopConfig:
//                                     the whole identity for PUT /v1/admin/settings
//   readinessFromStatus(status)       GET /v1/admin/legal/status → the page's
//                                     { ready, blockers } (legalPageReadiness.js shape)
//   acceptanceFromView(view)          GET /v1/admin/legal/pages `acceptance` → the
//                                     pointer the page reads (storeIdentity.legal.acceptance)
//   acceptPagesBody(input)            the exact body of POST /v1/admin/legal/accept-pages

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
 * The API's view names no person (no uid, no address): both are absent.
 * An imported adoption may carry `version` instead of `templateVersion`.
 */
export function acceptanceFromView(view) {
  if (!view || typeof view !== 'object' || typeof view.acceptedAt !== 'string') return null;
  const templateVersion = typeof view.templateVersion === 'string' ? view.templateVersion
    : typeof view.version === 'string' ? view.version : '';
  return {
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

/**
 * The pages a 400 `invalid_request` of accept-pages is laid at. The route
 * answers the same 400 for a malformed body and for a text its HTML check
 * refuses, without naming the page; the body is built by acceptPagesBody and
 * the templates render to markup the check admits (staging-legal.mjs adopts
 * them unchanged), so the refusal is the seller's own text: every page that
 * is custom. Empty when none is.
 */
export function refusedTextKeys(customPages) {
  return LEGAL_KEYS.filter((key) => customPages?.[key] === true);
}
