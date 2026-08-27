// ShopFeaturesContext — provides the active shop's add-on entitlement map
// (shops/{shopId}.features) to the whole app, loaded once per shopId. The single
// gate everyone calls is isEnabled(key). Polarity is PER KEY (config/addons.js):
// legacy keys are DEFAULT-ON (enabled unless explicitly false) so shops predating
// the field keep their add-ons; the OPT-IN keys (`pod`, `contentStudio`) are the
// inverse — enabled only on a literal true, so a missing flag means a things shop
// rather than a silently POD-entitled one.
// See docs/ADDONS_PLATFORM_CONTROL_PLAN.md + config/addons.js.
import React, { createContext, useContext, useState, useEffect } from 'react';
import { loadShopFeatures } from '../config/shopConfig';
import { isFeatureEnabled } from '../config/addons';
import { useShopId } from './ShopContext';

const ShopFeaturesContext = createContext({ features: {}, loading: true });

/**
 * useShopFeatures() → { features, isEnabled(key), loading }
 * isEnabled(key) is the canonical add-on gate. For an OPT-IN key, a false
 * result while `loading` is true means "not loaded yet", not "off" — callers
 * that bake the value into something persistent (e.g. DynamicPage rendering a
 * legal page) should wait on `loading` rather than read twice.
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
  // Start with {} → each key resolves to its own default while the read is in
  // flight: legacy keys stay ON (no flash-hide of an entitled add-on), opt-in
  // keys stay OFF (no flash of POD/Studio surfaces in a things shop).
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
        // Degrade to {} — legacy keys stay ON (never hide a paid add-on on a
        // transient read error); opt-in keys stay OFF (fail closed).
        console.warn('ShopFeatures: using per-key defaults (could not load features):', err?.message);
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
