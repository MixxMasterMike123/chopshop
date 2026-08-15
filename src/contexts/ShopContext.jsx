import React, { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { resolveShopId, UNRESOLVED_SHOP_ID } from '../config/tenancy';
import { getImpersonationShopId } from '../config/impersonation';
import {
  getActiveShopId,
  subscribeActiveShopId,
  getDeepLinkShopId,
  subscribeDeepLinkShopId,
  getLastPickedShopId,
  subscribeLastPickedShopId,
} from '../config/activeShop';

/**
 * ShopContext — provides the current tenant's shopId to the whole app.
 *
 * This is the runtime entry point for multi-tenancy: every shop-scoped read,
 * the storefront config seam, and (later) the security-rule scoping key off the
 * shopId this resolves. The grammar that maps a URL to a shop lives in ONE
 * place — config/tenancy.js resolveShopId — so this provider never parses paths
 * itself; it just exposes the resolved value.
 *
 * Phase 0b: path-prefix grammar — segment[0] of the URL is the shopId
 * (resolveShopId in config/tenancy.js). This provider re-resolves on every
 * navigation (useLocation), so client-side route changes between shops update
 * the tenant. Resolution is synchronous (from the path) — no loading flash.
 * Must be rendered INSIDE the Router.
 *
 * ADMIN surface resolution order (impersonationEnabled, /admin/* has no shop
 * prefix so path resolution there is always the default shop):
 *   1. P4.3 impersonation session — a platform operator viewing a tenant
 *      (config/impersonation.js). Overrides everything.
 *   2. P4.6 active shop-admin shopId — the logged-in (non-platform) shop admin's
 *      OWN users/{uid}.shopId, published by AuthContext via config/activeShop.js
 *      (ShopProvider can't read auth context — it sits outside AuthProvider).
 *   3. The operator's LAST PICKED shop (config/activeShop.js) — a platform
 *      operator has no own shopId, so this is what the shop picker wrote on
 *      their previous visit.
 *   4. Path resolution — which on /admin/* yields UNRESOLVED_SHOP_ID. The admin
 *      surface answers that by rendering the shop picker instead of a dashboard.
 *      There is NO default shop: an operator who hasn't chosen must choose, and
 *      never silently edits some tenant's live data (2026-08-15).
 * All of these are UI resolution only — the DB rules remain the hard access gate
 * (a shop admin can read only their own shopId's data no matter what this says).
 * Honored ONLY in admin mode — never storefront/platform.
 */
const ShopContext = createContext(UNRESOLVED_SHOP_ID);

export function useShopId() {
  return useContext(ShopContext);
}

export function ShopProvider({ children, impersonationEnabled = false }) {
  const location = useLocation();
  // Subscribe to the published shop-admin shopId so a real shop admin's surface
  // re-resolves the moment their user doc loads (admin mode only, below).
  const activeShopId = useSyncExternalStore(subscribeActiveShopId, getActiveShopId);
  // Deep-link override (?shopId= on the admin host, stashed by AdminShopIdIntake).
  const deepLinkShopId = useSyncExternalStore(subscribeDeepLinkShopId, getDeepLinkShopId);
  // The operator's last explicitly-picked shop (platform users have no own shopId).
  const lastPickedShopId = useSyncExternalStore(subscribeLastPickedShopId, getLastPickedShopId);
  const shopId = useMemo(
    () => {
      // Admin surface precedence: impersonation > deep-link (?shopId=) >
      //   shop-admin's own shop > operator's last pick > path (= unresolved).
      if (impersonationEnabled) {
        const impersonated = getImpersonationShopId();
        if (impersonated) return impersonated;
        if (deepLinkShopId) return deepLinkShopId;
        if (activeShopId) return activeShopId;
        // A path-resolved shop still wins over the remembered pick, so an
        // explicit /{shopId} URL is never overridden by a stale choice.
        const fromPath = resolveShopId(location.pathname);
        if (fromPath !== UNRESOLVED_SHOP_ID) return fromPath;
        if (lastPickedShopId) return lastPickedShopId;
        return UNRESOLVED_SHOP_ID;
      }
      return resolveShopId(location.pathname);
    },
    // location.search is included so stripping the ?impersonate=/?shopId= param
    // after intake (a same-document nav) re-evaluates the resolved shop.
    [location.pathname, location.search, impersonationEnabled, activeShopId, deepLinkShopId, lastPickedShopId]
  );

  return (
    <ShopContext.Provider value={shopId}>
      {children}
    </ShopContext.Provider>
  );
}
