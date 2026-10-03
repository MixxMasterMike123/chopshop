// The platform console's shop shapes (CP5 brief FI): the API's tenant views
// → the `shop` objects PlatformShops, PlatformShopDetail and shopCells read
// (the Firestore shops/{id} document's names). Pure; tested under Node.
//
// PLATFORM-ONLY facts (commission, Connect) pass through here; only the
// platform console's data modules import this file.

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

/** A row of GET /v1/platform/tenants → { id, name, status, tenantStatus, published }. */
export function toListShop(item) {
  return {
    id: item.tenantId,
    name: item.shopName || null,
    status: pageStatusOf(item.status),
    tenantStatus: item.status,
    published: item.published === true,
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
    legalSummary: {
      returnAddressSet: detail.settings?.returnAddressSet === true,
      vatAnswered: detail.settings?.vatAnswered === true,
    },
    domains: Array.isArray(detail.domains) ? detail.domains : [],
  };
}

/** The label the old readiness gave the acceptance blocker; here it is not known (no platform read yet). */
export const ACCEPTANCE_UNKNOWN = {
  key: 'acceptanceUnknown',
  label: 'Butiksägarens godkännande av sidorna kan inte läsas här ännu',
};

/**
 * getLegalReadiness()'s shape from the detail's settings summary. The return
 * address and the VAT answer are known; the seller's adoption of the pages is
 * not in the platform detail, so it is always listed as unknown and the shop
 * never reads "ready" here (a warning too many rather than a false OK).
 */
export function legalReadinessFromSummary(summary) {
  const blockers = [];
  if (summary?.returnAddressSet !== true) blockers.push({ key: 'returnAddress', label: 'Returadress saknas' });
  if (summary?.vatAnswered !== true) {
    blockers.push({ key: 'vatRegistered', label: 'Momsregistrering ej angiven (krävs för att momstexten ska matcha kassan)' });
  }
  blockers.push(ACCEPTANCE_UNKNOWN);
  return { ready: false, blockers, missing: [], needsReacceptance: false };
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
