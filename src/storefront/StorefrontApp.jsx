// The Cloudflare storefront's router (CP4 brief E). It holds the staying
// addresses of the address grammar (docs/cf-port/CP4_BRIEFS.md) and nothing
// else: an address of a page that left the build (D81) shows the shop's
// not-found page. `<root>` is '/:shopId' on the shared host (the shop is the
// first segment, D77) and '' on a shop's own domain. The route parameters
// keep the names the pages read today (`slug`, `category`, `handle`, `tag`,
// `orderId`), so a page swaps in without a change of its own.

import React from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import ScrollToTop from '../components/ScrollToTop';
import { storefrontRoot } from '../api/client.js';
import Providers from './Providers.jsx';
import PreviewBanner from './PreviewBanner.jsx';
import * as Pages from './pages.jsx';

/** The grammar, relative to `<root>`. Order matters only for the last row. */
export const STOREFRONT_ROUTES = [
  { path: '/', page: 'PublicStorefront' },
  { path: '/product/:slug', page: 'PublicProductPage' },
  { path: '/produkter', page: 'AllProductsPage' },
  { path: '/kategori/:category', page: 'CollectionPage' },
  { path: '/samling/:handle', page: 'ProductCollectionPage' },
  { path: '/tagg/:tag', page: 'TagPage' },
  { path: '/cart', page: 'ShoppingCart' },
  { path: '/checkout', page: 'Checkout' },
  { path: '/order-return', page: 'OrderReturn' },
  { path: '/order-confirmation/:orderId', page: 'OrderConfirmation' },
  { path: '/angra', page: 'WithdrawalPage' },
  { path: '/rapportera-intrang', page: 'InfringementReportPage' },
  // CP9-AC: the two links of an abandoned-checkout reminder.
  { path: '/aterta/:token', page: 'CheckoutRecoveryPage' },
  { path: '/avregistrera/:token', page: 'CheckoutUnsubscribePage' },
  // A legal page keeps today's address, `<root>/legal/<slug>`.
  { path: '/legal/:slug', page: 'DynamicRouteHandler' },
  // A content page or a post: one segment (`<root>/<slug>`).
  { path: '/:slug', page: 'DynamicRouteHandler' },
];

function routePath(prefix, path) {
  if (path === '/') return prefix || '/';
  return `${prefix}${path}`;
}

export default function StorefrontApp() {
  // '' on a shop's own domain (read once: the Worker's tag never changes);
  // otherwise the shop is the first segment.
  const prefix = storefrontRoot('/') === '' ? '' : '/:shopId';

  return (
    <BrowserRouter>
      <ScrollToTop />
      <Providers>
        <div className="min-h-screen bg-gray-50">
          <Toaster
            position="top-right"
            toastOptions={{ duration: 4000, style: { background: '#363636', color: '#fff' } }}
          />
          <Routes>
            {STOREFRONT_ROUTES.map(({ path, page }) => {
              const Page = Pages[page];
              return (
                <Route
                  key={path}
                  path={routePath(prefix, path)}
                  element={
                    <Pages.ShopGate>
                      <Page />
                    </Pages.ShopGate>
                  }
                />
              );
            })}
            <Route path="*" element={<Pages.NotFound />} />
          </Routes>
          <PreviewBanner />
        </div>
      </Providers>
    </BrowserRouter>
  );
}
