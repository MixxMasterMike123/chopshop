// The platform console's shop shapes (CP5 brief FI): the API's tenant views
// → the `shop` objects PlatformShops, PlatformShopDetail and shopCells read
// (the Firestore shops/{id} document's names). Pure; tested under Node.
//
// PLATFORM-ONLY facts (commission, Connect, who signed what) pass through
// here; only the platform console's data modules import this file.

import { signerLabelOf } from './signer.js';

/** The add-on keys the old document could hold that the API never names (deleted D2, not ported D81). */
const KEYS_THE_API_DOES_NOT_NAME = ['affiliate', 'ambassador', 'b2b', 'campaigns', 'dining', 'writers'];

/**
 * The console's two-state status: the API's `active` → 'active'; suspended,
 * provisioning and closed → 'disabled' (the pages' word for "not open"). The
 * API's own value stays on `tenantStatus`.
 */
export function pageStatusOf(apiStatus) {
  return apiStatus === 'active' ? 'active' : 'disabled';
}

/**
 * The shop's counts (`counts` of a list row with ?counts=1, and of the
 * detail; CP5-WK): { products, publishedProducts, orders }, each a whole
 * number or null when the answer did not carry it. There is no customer count.
 */
export function countsOf(raw) {
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  if (!raw || typeof raw !== 'object') return null;
  return { products: count(raw.products), publishedProducts: count(raw.publishedProducts), orders: count(raw.orders) };
}

/** The count columns of the list and the detail's card: [label, counts key, header title]. */
export const SHOP_COUNT_COLUMNS = Object.freeze([
  Object.freeze({ label: 'Produkter', key: 'products', title: 'Produkter som inte är arkiverade (utkast och aktiva)' }),
  Object.freeze({ label: 'Synliga', key: 'publishedProducts', title: 'Produkter som syns i butiken nu (0 medan butiken inte är publicerad eller är inaktiverad)' }),
  Object.freeze({ label: 'Ordrar', key: 'orders', title: 'Alla butikens ordrar' }),
]);

/** A row of GET /v1/platform/tenants → { id, name, status, tenantStatus, published, counts }. */
export function toListShop(item) {
  return {
    id: item.tenantId,
    name: item.shopName || null,
    status: pageStatusOf(item.status),
    tenantStatus: item.status,
    published: item.published === true,
    counts: countsOf(item.counts),
  };
}

/** The rows, sorted as the page sorted them (name, else id). */
export function toListShops(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.tenantId === 'string')
    .map(toListShop)
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

/**
 * The detail's `features` list → the map the page reads with
 * isFeatureEnabled(): every key the API names with its effective value, and
 * every key it does not name explicitly false (the old helper reads a missing
 * key as ON, which would show add-ons that do not exist here).
 */
export function featureMapOf(features) {
  const map = Object.fromEntries(KEYS_THE_API_DOES_NOT_NAME.map((key) => [key, false]));
  for (const f of Array.isArray(features) ? features : []) {
    if (f && typeof f.key === 'string') map[f.key] = f.enabled === true;
  }
  return map;
}

/**
 * GET /v1/platform/tenants/:id (+ GET …/connect, or null) → the page's shop.
 * `payments.stripeAccountId` is a boolean (the page only asks whether there
 * is one); `connectEnabled` comes from the Connect view (the detail has no
 * opt-in flag).
 */
export function toDetailShop(detail, connect = null) {
  const t = detail.tenant;
  const c = t.connect || {};
  return {
    id: t.tenantId,
    name: t.shopName || null,
    status: pageStatusOf(t.status),
    tenantStatus: t.status,
    published: t.published === true,
    supportEmail: t.supportEmail ?? null,
    vatRateBp: t.vatRateBp,
    features: featureMapOf(detail.features),
    payments: {
      chargesEnabled: c.chargesEnabled === true || connect?.chargesEnabled === true,
      stripeAccountId: Boolean(c.accountId || connect?.accountId),
      connectEnabled: connect?.enabled === true,
      commissionBps: Number.isInteger(t.commissionBps) ? t.commissionBps : null,
    },
    ...legalFactsOf(detail.legal),
    domains: Array.isArray(detail.domains) ? detail.domains : [],
  };
}

/**
 * The detail's `legal` → what the page reads of a shop's legal facts:
 *   legal                     the checkout's own gate, kept whole (legalReadinessFromLegal)
 *   storeIdentity.legal.acceptance   who adopted the legal pages, when, which template version
 *   platformTerms             who accepted the platform's terms (the latest version), when
 * `email` is the signer's label (signer.js): the person, or "Plattformen".
 */
export function legalFactsOf(legal) {
  if (!legal || typeof legal !== 'object') return { legal: null, storeIdentity: {}, platformTerms: null };
  const adoption = legal.pagesAdoption;
  const latest = legal.terms?.latestAcceptance;
  return {
    legal,
    storeIdentity: adoption && typeof adoption.acceptedAt === 'string'
      ? { legal: { acceptance: { email: signerLabelOf(adoption.acceptedBy), acceptedAt: adoption.acceptedAt, templateVersion: adoption.templateVersion ?? '' } } }
      : {},
    platformTerms: latest && typeof latest.acceptedAt === 'string'
      ? { email: signerLabelOf(latest.acceptedBy), acceptedAt: latest.acceptedAt, version: latest.version ?? '' }
      : null,
  };
}

/** The labels of the older build's readiness (src/utils/legalPageReadiness.js), for the same keys. */
const BLOCKER_LABELS = Object.freeze({
  platformTerms: 'Plattformsvillkoren är inte godkända',
  returnAddress: 'Returadress saknas',
  vatRegistered: 'Momsregistrering ej angiven (krävs för att momstexten ska matcha kassan)',
  acceptance: 'Villkoren är inte godkända av butiksägaren',
});

/**
 * getLegalReadiness()'s shape from the detail's `legal`. `ready` is the
 * checkout's own answer (`checkoutOpen`: the platform terms gate AND the three
 * legal conditions, one predicate with the checkout). The blockers say which
 * part is missing. A detail without `legal` is never ready.
 */
export function legalReadinessFromLegal(legal) {
  const readiness = legal?.readiness;
  if (!readiness || typeof readiness !== 'object') {
    return { ready: false, blockers: [{ key: 'acceptance', label: BLOCKER_LABELS.acceptance }], missing: [], needsReacceptance: false };
  }
  const blockers = [];
  if (legal.terms?.gateOpen !== true) blockers.push({ key: 'platformTerms', label: BLOCKER_LABELS.platformTerms });
  if (readiness.returnAddress !== true) blockers.push({ key: 'returnAddress', label: BLOCKER_LABELS.returnAddress });
  if (readiness.vatAnswered !== true) blockers.push({ key: 'vatRegistered', label: BLOCKER_LABELS.vatRegistered });
  if (readiness.legalPagesAccepted !== true) blockers.push({ key: 'acceptance', label: BLOCKER_LABELS.acceptance });
  return { ready: legal.checkoutOpen === true, blockers, missing: [], needsReacceptance: false };
}

/** A refused commission in the page's words (the page checks 0–100 % itself; the server's cap decides). */
export function commissionErrorMessage(error) {
  if (error?.code === 'invalid_request' || error?.status === 400) {
    return 'Avgiften godtogs inte av servern (över plattformens tak eller ogiltig).';
  }
  if (error?.status === 409) return 'Butiken är stängd – avgiften kan inte ändras.';
  if (error?.code === 'network_error') return 'Servern kunde inte nås. Försök igen.';
  return 'Kunde inte spara avgift.';
}

/** A shop id is free, or the id or the hostname is taken: the create route's 409. */
export const isConflict = (error) => error?.status === 409;

/**
 * The provisioned shop's add-ons: the preset's values for the keys the API
 * allows (the others are not sent: the API refuses an unknown key).
 */
export function provisionFeaturesOf(presetFeatures, allowedKeys) {
  const out = {};
  for (const key of allowedKeys) {
    if (typeof presetFeatures?.[key] === 'boolean') out[key] = presetFeatures[key];
  }
  return out;
}

/** The API's add-on keys (cloudflare/src/platform/tenant-config.ts FEATURE_KEYS). */
export const API_FEATURE_KEYS = ['abandonedCheckout', 'contentStudio', 'discountCodes', 'marketingMaterials', 'pod', 'productReviews'];

/** The invite's failure, in the modal's words. */
export function inviteErrorText(error) {
  if (error?.status === 503 || error?.code === 'email_unavailable') return 'e-posten kunde inte köas just nu';
  if (error?.status === 404) return 'inbjudningar är inte konfigurerade här';
  if (error?.code === 'not_invitable') return 'kontot kan inte bjudas in';
  return error?.message || 'okänt fel';
}

/** An open acting-as grant on `shopId` among /v1/me's `actingAs`, at `now`. */
export function hasOpenGrant(me, shopId, now = Date.now()) {
  const grants = Array.isArray(me?.actingAs) ? me.actingAs : [];
  return grants.some((g) => g && g.tenantId === shopId && Date.parse(g.expiresAt) > now);
}

/** The storefront address of a preview (CP4-D2 reviewer wiring): `<root>/<shop>/#preview=<grant>`. */
export function previewUrlOf(storefrontOrigin, shopId, grant) {
  return `${storefrontOrigin}/${shopId}/#preview=${grant}`;
}
