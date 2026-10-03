// The admin build's provider tree (CP5 brief FA.3). Each provider replaces a
// context of the Firebase build under the same hooks (the alias list of
// vite.admin.config.js): Session ← AuthContext, ActiveShop ← ShopContext,
// ShopFeatures ← ShopFeaturesContext, StoreSettings ← StoreSettingsContext,
// Translation ← TranslationContext (the storefront's, static locale files),
// Orders ← OrderContext. Inside the Router: the session sends the user to /login.
//
// `tree`: 'admin' or 'platform'. The platform tree has no active shop, so its
// pages never read a shop's features or settings.

import React from 'react';
import { AuthProvider } from './providers/Session.jsx';
import { ShopProvider } from './providers/ActiveShop.jsx';
import { ShopFeaturesProvider } from './providers/ShopFeatures.jsx';
import { StoreSettingsProvider } from './providers/StoreSettings.jsx';
import { OrderProvider } from './providers/Orders.jsx';
import { TranslationProvider } from '../storefront/providers/Translation.jsx';

export default function Providers({ tree = 'admin', children }) {
  return (
    <AuthProvider tree={tree}>
      <ShopProvider tree={tree}>
        <ShopFeaturesProvider>
          <StoreSettingsProvider>
            <TranslationProvider>
              <OrderProvider>{children}</OrderProvider>
            </TranslationProvider>
          </StoreSettingsProvider>
        </ShopFeaturesProvider>
      </ShopProvider>
    </AuthProvider>
  );
}
