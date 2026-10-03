// The shapes of the three platform console pages of unit FJ (add-ons, users,
// reports and the screening queue). Pure: tested under Node
// (platformConsole.test.mjs). Time goes through toTimestamp (src/api/admin/
// time.js), so the reports page keeps calling what it called on a Firestore
// timestamp.

import { toTimestamp } from '../../api/admin/time.js';

// ── add-ons ─────────────────────────────────────────────────────────────────

/**
 * The add-ons the Worker accepts (tenant-config.ts FEATURE_KEYS). A key
 * outside this list is refused by the PUT: the pre-pivot CRM add-ons (deleted,
 * D2) and affiliate and wholesale (PORT-LATER, D62). The column of such a key
 * leaves the page.
 */
export const API_FEATURE_KEYS = Object.freeze([
  'abandonedCheckout',
  'contentStudio',
  'discountCodes',
  'marketingMaterials',
  'pod',
  'productReviews',
]);

/** The columns of the add-on table: the catalogue's entries the Worker knows, in the catalogue's order. */
export const columnsOf = (catalog) => catalog.filter((addon) => API_FEATURE_KEYS.includes(addon.key));

/** The page's `features` map from the API's views: the EFFECTIVE value of each key. */
export function featuresMapOf(views) {
  const map = {};
  for (const view of Array.isArray(views) ? views : []) {
    if (view && API_FEATURE_KEYS.includes(view.key)) map[view.key] = view.enabled === true;
  }
  return map;
}

/** One row of the page's shop list. */
export const shopRowOf = (tenant, views) => ({
  id: tenant.tenantId,
  name: typeof tenant.shopName === 'string' ? tenant.shopName : '',
  features: featuresMapOf(views),
});

/** Closed shops are final (nothing can be changed on one): the page does not list them. */
export const listedTenants = (tenants) => tenants.filter((t) => t && t.status !== 'closed');

export const sortShops = (shops) => [...shops].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

// ── users ───────────────────────────────────────────────────────────────────

export const ADMIN_ACCOUNT_TYPES = Object.freeze(['platform_admin', 'tenant_admin']);

/** One row of the page's user list from a directory user. */
export function userRowOf(user) {
  const shops = (Array.isArray(user.memberships) ? user.memberships : [])
    .filter((m) => m && m.status === 'active')
    .map((m) => m.tenantId);
  return {
    uid: user.userId,
    email: user.email || '',
    contactPerson: user.name || '',
    shopId: shops.length > 0 ? shops.join(', ') : null,
    platform: user.accountType === 'platform_admin',
    suspended: user.status === 'suspended',
    // Whether the account can sign in with a password yet: an invitation is for those that cannot.
    hasPassword: user.hasPassword === true,
  };
}

/** Platform admins first, then by e-mail (as the page always sorted). */
export const sortUsers = (rows) =>
  [...rows].sort((a, b) => (a.platform !== b.platform ? (a.platform ? -1 : 1) : a.email.localeCompare(b.email)));

const USER_REFUSALS = {
  cannot_deactivate_self: 'Du kan inte inaktivera ditt eget konto.',
  last_platform_admin: 'Minst en aktiv plattformsadmin måste finnas kvar.',
  not_active: 'Kontot är inte aktivt.',
  no_identity: 'Användaren har ingen inloggning att ändra.',
  not_suspended: 'Kontot är inte inaktiverat.',
  platform_admin_reactivation: 'En plattformsadmin kan inte återaktiveras härifrån. Servern vägrar.',
  not_invitable: 'Användaren kan inte bjudas in (kontot måste vara aktivt och vara admin).',
  email_unavailable: 'Inbjudan kunde inte köas för utskick. Försök igen om en stund.',
};

/** A refusal of a user action in the page's language; null when the error is not one of the API's. */
export function userActionMessage(error) {
  if (!error || typeof error.code !== 'string') return null;
  if (error.status === 404) return 'Användaren hittades inte, eller så är inbjudningar inte påslagna här.';
  return USER_REFUSALS[error.code] ?? null;
}

// ── reports ─────────────────────────────────────────────────────────────────

/** A report view of the API → the object the reports page reads. */
export function reportRowOf(view) {
  return {
    id: view.reportId,
    shopId: view.tenantId,
    productId: view.productId || '',
    productName: view.productName || '',
    productUrl: view.productUrl || '',
    reporterName: view.reporterName || '',
    reporterEmail: view.reporterEmail || '',
    reporterOrg: view.reporterOrg || '',
    rightType: view.rightType,
    description: view.description || '',
    attestation: view.attestation === true,
    status: view.status,
    note: view.note || '',
    createdAt: toTimestamp(view.createdAt),
    handledAt: view.handledAt ? toTimestamp(view.handledAt) : null,
    // The storefront address needs the product's slug, which the report does not carry.
    product: null,
  };
}

const REPORT_REFUSALS = {
  conflict: 'Anmälan ändrades under tiden. Ladda om och försök igen.',
  product_mismatch: 'Anmälan gäller en annan produkt.',
  report_closed: 'Anmälan är redan avslutad.',
  tenant_mismatch: 'Produkten tillhör inte butiken i anmälan.',
  transition_refused: 'Anmälan kan inte flyttas till den statusen.',
};

/** A refusal of a report or screening action in the page's language; null for anything else. */
export function reportActionMessage(error) {
  if (!error || typeof error.code !== 'string') return null;
  return REPORT_REFUSALS[error.code] ?? null;
}

// ── the screening queue ─────────────────────────────────────────────────────

/**
 * The page's three queue states from the API's. `pending` is the new shop's
 * routine review when its reason is `first_products`, a blocklist hit otherwise.
 */
export function queueStatusOf(view) {
  if (view.status === 'blocked') return 'blocked';
  if (view.status === 'pending' && view.reason === 'first_products') return 'review';
  return 'flagged';
}

/** A screening view → the product object of the queue list. */
export function queueRowOf(view) {
  const status = queueStatusOf(view);
  return {
    id: view.productId,
    shopId: view.tenantId,
    name: view.productName || '',
    // A pending product stays visible (D8: approval before the first SALE); a taken-down one is off.
    isActive: view.takenDown !== true,
    screening: {
      status,
      hits: Array.isArray(view.hits) ? view.hits : [],
      at: toTimestamp(view.decidedAt),
    },
  };
}
