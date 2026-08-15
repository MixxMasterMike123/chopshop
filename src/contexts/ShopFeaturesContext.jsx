// ShopFeaturesContext — provides the active shop's add-on entitlement map
// (shops/{shopId}.features) to the whole app, loaded once per shopId. The single
// gate everyone calls is isEnabled(key); it is DEFAULT-ON (a feature is enabled
// unless explicitly set to false), so shops predating the field and any shop
// missing the field keep all add-ons until an operator disables one from the
// platform console. See docs/ADDONS_PLATFORM_CONTROL_PLAN.md + config/addons.js.
import React, { createContext, useContext, useState, useEffect } from 'react';
import { loadShopFeatures } from '../config/shopConfig';
import { isFeatureEnabled } from '../config/addons';
import { useShopId } from './ShopContext';

const ShopFeaturesContext = createContext({ features: {}, loading: true });

/**
 * useShopFeatures() → { features, isEnabled(key), loading }
 * isEnabled(key) is the canonical add-on gate (default-ON for missing flags).
 */
export function useShopFeatures() {
  const ctx = useContext(ShopFeaturesContext);
  return {
    features: ctx.features,
    loading: ctx.loading,
    isEnabled: (key) => isFeatureEnabled(ctx.features, key),
  };
}

export function ShopFeaturesProvider({ children }) {
  const shopId = useShopId();
  // Start with {} → default-ON for every key while the read is in flight, so
  // add-on menus/routes never flash-hide on first paint.
  const [features, setFeatures] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    loadShopFeatures(shopId)
      .then((f) => {
        if (cancelled) return;
        setFeatures(f && typeof f === 'object' ? f : {});
      })
      .catch((err) => {
        // Degrade to {} (default-ON) — never hide add-ons on a read error.
        console.warn('ShopFeatures: using default-on (could not load features):', err?.message);
        if (!cancelled) setFeatures({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [shopId]);

  return (
    <ShopFeaturesContext.Provider value={{ features, loading }}>
      {children}
    </ShopFeaturesContext.Provider>
  );
}
