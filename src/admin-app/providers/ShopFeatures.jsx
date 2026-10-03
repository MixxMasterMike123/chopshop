// The admin build's replacement for src/contexts/ShopFeaturesContext.jsx
// (alias list, vite.admin.config.js). `useShopFeatures()` returns the same
// `{ features, loading, isEnabled(key) }`, from `GET /v1/admin/shop` of the
// active shop (CP5 brief §0.2).
//
// The API has applied the shop's switches, the defaults AND "is this feature
// ported" (D81): `features` holds every key the admin's menu reads, each a
// boolean, a feature not ported reads false. So a key is on only when the
// answer says a literal true; a key the answer does not name is off. (The
// Firebase context read a missing legacy key as ON; here that would light up
// a menu entry of a feature that does not exist.) While the answer is on its
// way, or when it failed, every key is off.
//
// `useAdminShop()` gives the rest of the same answer (the shop's name, status,
// support address, currency, VAT): the StoreSettings provider and the shells
// read it, so the shop is asked for once.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { adminRequest } from '../../api/admin/client.js';
import { useActiveShop } from './ActiveShop.jsx';
import { useAuth } from './Session.jsx';
import { featuresOf } from './shapes.js';

const ShopFeaturesContext = createContext({ features: {}, loading: true });
const AdminShopContext = createContext({ shop: null, status: 'none', reload: async () => {} });

export function useShopFeatures() {
  const ctx = useContext(ShopFeaturesContext);
  return {
    features: ctx.features,
    loading: ctx.loading,
    isEnabled: (key) => ctx.features[key] === true,
  };
}

/** `{ shop, status: 'none' | 'loading' | 'ready' | 'error', reload }` */
export function useAdminShop() {
  return useContext(AdminShopContext);
}

export function ShopFeaturesProvider({ children }) {
  const { shopId } = useActiveShop();
  // While the session is read, the shop is not known yet: that is loading,
  // not "no shop" (AddonGate waits on `loading` before it turns anyone away).
  const { loading: sessionLoading } = useAuth();
  const [state, setState] = useState({ shopId: null, shop: null, status: 'none' });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!shopId) {
      setState({ shopId: null, shop: null, status: 'none' });
      return undefined;
    }
    const controller = new AbortController();
    setState({ shopId, shop: null, status: 'loading' });
    adminRequest('GET', '/v1/admin/shop', { shopId, signal: controller.signal })
      .then(({ data }) => setState({ shopId, shop: data?.shop ?? null, status: 'ready' }))
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        console.warn('Shop: every feature off (could not load the shop):', error?.message);
        setState({ shopId, shop: null, status: 'error' });
      });
    return () => controller.abort();
  }, [shopId, generation]);

  const reload = useCallback(async () => setGeneration((n) => n + 1), []);

  // An answer for an earlier shop is never shown under the new one.
  const current =
    sessionLoading
      ? { shopId, shop: null, status: 'loading' }
      : state.shopId === shopId
        ? state
        : { shopId, shop: null, status: shopId ? 'loading' : 'none' };

  const features = useMemo(
    () => ({ features: current.status === 'ready' ? featuresOf(current.shop) : {}, loading: current.status === 'loading' }),
    [current.status, current.shop],
  );
  const adminShop = useMemo(
    () => ({ shop: current.shop, status: current.status, reload }),
    [current.shop, current.status, reload],
  );

  return (
    <AdminShopContext.Provider value={adminShop}>
      <ShopFeaturesContext.Provider value={features}>{children}</ShopFeaturesContext.Provider>
    </AdminShopContext.Provider>
  );
}
