// Which shop this storefront address is for (D77): the root from the path on
// the shared host, '' on a shop's own domain (src/api/client.js decides).
// Re-read on every navigation, as ShopContext did. No impersonation, no
// active-shop store: those belong to the admin, not to the storefront.

import React, { createContext, useContext, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { storefrontRoot } from '../../api/client.js';

const ShopRootContext = createContext({ root: null, shopId: null });

export function ShopRootProvider({ children }) {
  const { pathname } = useLocation();
  const root = storefrontRoot(pathname);
  const value = useMemo(() => ({ root, shopId: root ? root.slice(1) : null }), [root]);
  return <ShopRootContext.Provider value={value}>{children}</ShopRootContext.Provider>;
}

/** The shop segment on the shared host; null on a shop's own domain and on an address with no shop. */
export function useShopId() {
  return useContext(ShopRootContext).shopId;
}

/** '/<shop>' on the shared host, '' on a shop's own domain, null for an address with no shop. */
export function useStorefrontRoot() {
  return useContext(ShopRootContext).root;
}
