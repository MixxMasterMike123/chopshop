// The public storefront response (GET /v1/storefront), read once per shop and
// shared by StoreSettings, ShopFeatures and the gate. Never blocks a render:
// the providers paint from their static defaults while it is on its way.

import React, { createContext, useContext, useEffect, useState } from 'react';
import { getStorefront } from '../../api/storefront.js';
import { useStorefrontRoot } from './ShopRoot.jsx';

/**
 * status: 'loading' | 'ready' | 'not_found' (no such shop, or not public) |
 *         'error' (the API could not be reached) | 'no_shop' (the address names none)
 */
const StorefrontContext = createContext({ status: 'loading', storefront: null, error: null });

export function StorefrontProvider({ children }) {
  const root = useStorefrontRoot();
  const [state, setState] = useState(() => ({
    status: root === null ? 'no_shop' : 'loading',
    storefront: null,
    error: null,
  }));

  useEffect(() => {
    if (root === null) {
      setState({ status: 'no_shop', storefront: null, error: null });
      return undefined;
    }

    const controller = new AbortController();
    setState({ status: 'loading', storefront: null, error: null });
    getStorefront({ signal: controller.signal }).then(
      (storefront) => {
        if (controller.signal.aborted) return;
        setState(
          storefront
            ? { status: 'ready', storefront, error: null }
            : { status: 'not_found', storefront: null, error: null },
        );
      },
      (error) => {
        if (controller.signal.aborted) return;
        console.warn('Storefront: could not load the shop:', error?.message);
        setState({ status: 'error', storefront: null, error });
      },
    );
    return () => controller.abort();
  }, [root]);

  return <StorefrontContext.Provider value={state}>{children}</StorefrontContext.Provider>;
}

export function useStorefront() {
  return useContext(StorefrontContext);
}
