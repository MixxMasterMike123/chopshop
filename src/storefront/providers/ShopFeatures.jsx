// ShopFeatures for the Cloudflare storefront: `useShopFeatures()` returns the
// same `{ features, loading, isEnabled(key) }` as ShopFeaturesContext.jsx.
//
// The source is the storefront response's `features`, where the API has
// already applied the shop's switches, the defaults AND "is this feature
// ported" (D81): a feature that is not ported reads false whatever the shop's
// row says. So a key is on only when the response says a literal true. While
// the response is on its way, or when it failed, every key reads off: no
// button of a feature flashes in and then fails.

import React, { createContext, useContext, useMemo } from 'react';
import { useStorefront } from './Storefront.jsx';

const ShopFeaturesContext = createContext({ features: {}, loading: true });

export function useShopFeatures() {
  const ctx = useContext(ShopFeaturesContext);
  return {
    features: ctx.features,
    loading: ctx.loading,
    isEnabled: (key) => ctx.features[key] === true,
  };
}

export function ShopFeaturesProvider({ children }) {
  const { status, storefront } = useStorefront();
  const value = useMemo(() => {
    const raw = status === 'ready' ? storefront.features : null;
    const features = {};
    if (raw && typeof raw === 'object') {
      for (const [key, enabled] of Object.entries(raw)) {
        if (typeof enabled === 'boolean') features[key] = enabled;
      }
    }
    return { features, loading: status === 'loading' };
  }, [status, storefront]);

  return <ShopFeaturesContext.Provider value={value}>{children}</ShopFeaturesContext.Provider>;
}
