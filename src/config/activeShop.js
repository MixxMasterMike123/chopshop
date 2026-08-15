// Active shop-admin tenant — the bridge that lets the ADMIN surface resolve a
// real (non-platform) shop admin to THEIR OWN shop, without ShopProvider needing
// auth context.
//
// Why this exists: ShopProvider sits OUTSIDE AuthProvider in the tree (it wraps
// StoreSettingsProvider, which needs shopId, which in turn wraps AuthProvider),
// so ShopProvider cannot call useAuth(). But a real shop admin logging into the
// admin host at /admin/* needs useShopId() to return their users/{uid}.shopId —
// the admin URL has no shop prefix, so path resolution alone yields the default
// shop. AuthContext knows the shopId the moment it loads the user doc; it
// publishes it here, and ShopProvider reads it.
//
// Precedence in ShopProvider (admin surface): impersonation session (P4.3, an
// operator viewing a tenant) > THIS (the logged-in shop admin's own shop) >
// path resolution. Platform operators have shopId null (no home shop) and
// their reads bypass scoping via the rules, so leaving them on the path-default
// is fine.
//
// This is auth state, not a security boundary — the Firestore/Storage rules
// remain the hard gate (a shop admin can only read their own shopId's data
// regardless of what this returns).

let activeShopId = null;
const listeners = new Set();

/** The logged-in shop admin's shopId, or null (logged out / platform / not yet loaded). */
export function getActiveShopId() {
  return activeShopId;
}

/**
 * Publish the logged-in admin's shopId (AuthContext calls this when the user doc
 * loads / on logout with null). Notifies subscribers so ShopProvider re-renders.
 */
export function setActiveShopId(shopId) {
  const next = shopId || null;
  if (next === activeShopId) return;
  activeShopId = next;
  listeners.forEach((fn) => {
    try { fn(next); } catch { /* ignore subscriber errors */ }
  });
}

/** Subscribe to changes; returns an unsubscribe fn. */
export function subscribeActiveShopId(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Deep-link managed-shop override ──────────────────────────────────────────
// Admin emails link to /admin/orders/{id}?shopId={shopId}. AdminShopIdIntake
// consumes that param on the admin host and stashes the shopId HERE, so the
// admin surface resolves the emailed shop on a cold navigation (email click)
// even for a platform operator (whose auth-published activeShopId is null and
// would otherwise leave them on the path-default shop).
//
// Precedence in ShopProvider (admin surface): impersonation session > THIS
// deep-link override > auth-published activeShopId > path default. It is stored
// separately from `activeShopId` so AuthContext's setActiveShopId(...) on user-
// doc load never clobbers it. sessionStorage keeps it alive across the param-
// strip navigation and any in-tab reloads, and per-tab siloed to the admin host.
//
// UI-only, like activeShopId itself: the Firestore/function rules stay the hard
// gate. A shopId the caller can't administer just yields permission-denied reads
// (the same failure mode as navigating there any other way) — no new auth check.
const DEEPLINK_KEY = '__admin_deeplink_shopId';
const deepLinkListeners = new Set();

/** The deep-linked managed shopId (from ?shopId=), or null. */
export function getDeepLinkShopId() {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(DEEPLINK_KEY) || null;
  } catch {
    return null;
  }
}

/** Stash (or clear, with null) the deep-linked managed shopId; notifies subscribers. */
export function setDeepLinkShopId(shopId) {
  if (typeof window === 'undefined') return;
  const next = shopId || null;
  if (next === getDeepLinkShopId()) return;
  try {
    if (next) window.sessionStorage.setItem(DEEPLINK_KEY, next);
    else window.sessionStorage.removeItem(DEEPLINK_KEY);
  } catch {
    /* sessionStorage unavailable (private mode edge) → override simply won't apply */
  }
  deepLinkListeners.forEach((fn) => {
    try { fn(next); } catch { /* ignore subscriber errors */ }
  });
}

/** Subscribe to deep-link override changes; returns an unsubscribe fn. */
export function subscribeDeepLinkShopId(fn) {
  deepLinkListeners.add(fn);
  return () => deepLinkListeners.delete(fn);
}

// ── Operator's last-picked shop (platform users only) ────────────────────────
// A platform operator's /admin/* has no shop in the URL and no own shopId (they
// publish activeShopId = null), so without this every admin visit would land on
// the shop picker. The picker writes the chosen shopId here and the admin
// surface reuses it on the next visit — the convenience the old default-shop
// default provided, but EXPLICIT: the operator chose this shop, and the top-bar
// chip names it.
//
// localStorage (not sessionStorage) so the choice survives a browser restart,
// and it is per-origin so it stays on the admin host. UI-only, like everything
// else in this module: the Firestore/Storage rules remain the hard gate, and a
// stale id just yields empty reads until the operator picks again.
//
// Precedence in ShopProvider (admin surface): impersonation > deep-link
// (?shopId=) > the shop admin's OWN shopId > THIS > unresolved (→ picker).
const LAST_SHOP_KEY = '__admin_last_shopId';
const lastShopListeners = new Set();

/** The operator's last explicitly-picked shopId, or null. */
export function getLastPickedShopId() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LAST_SHOP_KEY) || null;
  } catch {
    return null;
  }
}

/** Remember (or clear, with null) the operator's picked shopId; notifies subscribers. */
export function setLastPickedShopId(shopId) {
  if (typeof window === 'undefined') return;
  const next = shopId || null;
  if (next === getLastPickedShopId()) return;
  try {
    if (next) window.localStorage.setItem(LAST_SHOP_KEY, next);
    else window.localStorage.removeItem(LAST_SHOP_KEY);
  } catch {
    /* localStorage unavailable (private mode edge) → picker just asks each time */
  }
  lastShopListeners.forEach((fn) => {
    try { fn(next); } catch { /* ignore subscriber errors */ }
  });
}

/** Subscribe to last-picked-shop changes; returns an unsubscribe fn. */
export function subscribeLastPickedShopId(fn) {
  lastShopListeners.add(fn);
  return () => lastShopListeners.delete(fn);
}
