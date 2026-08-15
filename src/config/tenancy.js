// Tenancy config — the single source of truth for "which shop is this?".
//
// The platform is becoming multi-tenant: every shop is a `shops/{shopId}`
// entity and all shop data is scoped by `shopId` (see
// docs/SUPERADMIN_TENANCY_PLAN.md). This file owns BOTH the default shop id
// and the path-grammar parsing, so there is exactly one place that knows how a
// URL maps to a shop — no duplicated parsing that can drift.
//
// Phase 0b (current): PATH-PREFIX grammar. Every storefront URL carries the
// shopId as the first path segment: `/{shopId}`, `/{shopId}/product/:slug`,
// `/{shopId}/cart`, etc. The bare `/` renders the platform Landing Page — there
// is no default shop to redirect to. resolveShopId derives the shop from
// segment[0]. This file is the SINGLE source of truth for the path grammar —
// no duplicated parsing elsewhere.

// UNRESOLVED SHOP SENTINEL — the replacement for the old b8shield default.
//
// There is deliberately NO default shop any more. A shopless admin context (a
// platform operator who hasn't picked a tenant, an unknown path) resolves to
// this sentinel instead of silently landing on a real shop's data. The admin
// surface renders a shop picker when it sees this value; storefront paths were
// already safe (unknown shop → LandingPage, see ShopGate).
//
// Why a sentinel and not null/undefined: every `shopId || DEFAULT_SHOP_ID`
// defense-in-depth site across the client and functions exists to guarantee a
// doc is never written UNTAGGED. A nullish shopId would silently defeat those
// guards and produce untagged docs; a non-empty string that matches no real
// shop keeps the guard intact and makes any leaked write obvious and greppable
// rather than invisible. Queries scoped to it simply return nothing.
//
// (Decided 2026-08-15: kill the b8shield default fallback. It was THE
// wrong-context seam — a platform operator's /admin/* silently resolved to
// b8shield, which is how the Kent wrong-shop Connect binding happened.)
export const UNRESOLVED_SHOP_ID = '__unresolved__';

// Back-compat alias. The ~20 `shopId || DEFAULT_SHOP_ID` sites keep compiling
// and now fall back to the inert sentinel instead of a real tenant. Prefer
// UNRESOLVED_SHOP_ID in new code; this alias is what remains to be cleaned up.
export const DEFAULT_SHOP_ID = UNRESOLVED_SHOP_ID;

/** True when a shopId is missing or the unresolved sentinel (i.e. no real shop). */
export const isUnresolvedShopId = (shopId) => !shopId || shopId === UNRESOLVED_SHOP_ID;

// Legacy 2-letter country codes that USED to be segment[0] (pre-/se-removal).
// A stale link may still land here mid-redirect; treat such a first segment as
// "no shop" → default. LegacyCountryRedirect handles the actual redirect.
export const COUNTRY_PREFIXES = ['se', 'gb', 'us'];

// First-segment values that are NOT shopIds — app surfaces / credential routes
// that can appear at the root before a shop prefix is applied. Treated as "no
// shop → default" so they never get mistaken for a tenant id.
//
// 'admin' is reserved here (architecture: reserve admin/platform/api/www from
// tenant registration). It matters for resolution: the shop-admin surface lives
// at /admin/* (no shop prefix), so without this, resolveShopId('/admin/products')
// would return the literal 'admin' as the shopId and every admin query would
// scope to a non-existent shop. Reserving it makes the admin surface resolve to
// the UNRESOLVED sentinel, which the admin surface answers with a shop picker
// (a shop admin's own shopId still wins via activeShop). 'platform' is reserved
// for the same reason (its surface is a separate host, but defensive).
export const NON_SHOP_FIRST_SEGMENTS = new Set([
  ...COUNTRY_PREFIXES,
  'login', 'register', 'forgot-password', 'reset-password',
  'affiliate-login', '__', 'account', 'admin', 'platform',
]);

/**
 * Resolve the current shopId from a URL pathname.
 *
 * Path-prefix grammar: segment[0] is the shopId (e.g. /sillmans/cart →
 * 'sillmans'). Returns UNRESOLVED_SHOP_ID for the bare root and for known
 * non-shop first segments (legacy country codes, credential routes, admin) —
 * there is no default shop, so a shopless path resolves to "no shop".
 *
 * NOTE: this does NOT validate that the shopId exists — that's done at render
 * (ShopContext/StoreSettings) so an unknown/disabled shop can show an
 * "unavailable" state rather than silently falling back to the default.
 *
 * @param {string} [pathname] - e.g. window.location.pathname
 * @returns {string} the resolved shopId
 */
export const resolveShopId = (pathname) => {
  const path = typeof pathname === 'string'
    ? pathname
    : (typeof window !== 'undefined' ? window.location.pathname : '/');
  const first = (path.split('/').filter(Boolean)[0] || '').toLowerCase();
  if (!first || NON_SHOP_FIRST_SEGMENTS.has(first)) return UNRESOLVED_SHOP_ID;
  return first;
};

/**
 * True when the path has NO real shop in it — the bare root or a non-shop first
 * segment (credential routes, legacy country codes, admin/platform). On such a
 * path resolveShopId() returns UNRESOLVED_SHOP_ID; callers that build links
 * (getCountryAwareUrl) use this to avoid manufacturing a store URL out of thin
 * air — a shopless context has no storefront to link to, so links resolve to
 * the platform Landing Page instead. (Decided 2026-06-25: a shopless context
 * must never default into a real store; 2026-08-15: there is no default at
 * all any more.)
 *
 * @param {string} [pathname]
 * @returns {boolean}
 */
export const isShoplessPath = (pathname) => {
  const path = typeof pathname === 'string'
    ? pathname
    : (typeof window !== 'undefined' ? window.location.pathname : '/');
  const first = (path.split('/').filter(Boolean)[0] || '').toLowerCase();
  return !first || NON_SHOP_FIRST_SEGMENTS.has(first);
};
