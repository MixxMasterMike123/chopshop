// The storefront's provider tree: the shop root, the storefront response, and
// the four providers the pages read (CP4 brief E). No auth provider, no order
// provider, no account: a visitor buys as a guest (D81).

import React from 'react';
import { ShopRootProvider } from './providers/ShopRoot.jsx';
import { StorefrontProvider } from './providers/Storefront.jsx';
import { StoreSettingsProvider } from './providers/StoreSettings.jsx';
import { ShopFeaturesProvider } from './providers/ShopFeatures.jsx';
import { TranslationProvider } from './providers/Translation.jsx';
import { CartProvider } from './providers/Cart.jsx';

export default function Providers({ children }) {
  return (
    <ShopRootProvider>
      <StorefrontProvider>
        <StoreSettingsProvider>
          <ShopFeaturesProvider>
            <TranslationProvider>
              <CartProvider>{children}</CartProvider>
            </TranslationProvider>
          </ShopFeaturesProvider>
        </StoreSettingsProvider>
      </StorefrontProvider>
    </ShopRootProvider>
  );
}
