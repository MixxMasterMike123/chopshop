// THE SWAP TABLE — one line per storefront page (CP4 brief E, brief F).
//
// Every page under src/pages/shop and the shell under src/components/shop
// imports the Firebase SDK today, so each line below is a stand-in. Builder F
// swaps a page in by changing its ONE line, once the page reads from src/api
// and the providers of src/storefront:
//
//   export const PublicStorefront = pending('PublicStorefront');
// becomes
//   export { default as PublicStorefront } from '../pages/shop/PublicStorefront.jsx';
//
// `node cloudflare/web/check-storefront-build.mjs` then proves the build still
// holds no Firebase code. The router (StorefrontApp.jsx) never changes for a
// swap.

import NotFoundPage from './NotFound.jsx';
import { pending, pendingGate } from './Pending.jsx';

// The shop's not-found page (no Firebase page exists for it).
export const NotFound = NotFoundPage;

// Shell.
export { default as ShopGate } from '../components/shop/ShopGate.jsx';

// Catalogue.
export { default as PublicStorefront } from '../pages/shop/PublicStorefront.jsx';
export { default as AllProductsPage } from '../pages/shop/AllProductsPage.jsx';
export { default as TagPage } from '../pages/shop/TagPage.jsx';
export { default as CollectionPage } from '../pages/shop/CollectionPage.jsx';
export { default as ProductCollectionPage } from '../pages/shop/ProductCollectionPage.jsx';
export { default as PublicProductPage } from '../pages/shop/PublicProductPage.jsx';

// Content.
// An address that is no content page renders the handler's children: the
// shop's not-found page (the Firebase router sent it to the shop's home).
import DynamicRouteHandlerPage from '../components/shop/DynamicRouteHandler.jsx';
export const DynamicRouteHandler = () => (
  <DynamicRouteHandlerPage>
    <NotFoundPage />
  </DynamicRouteHandlerPage>
);

// Reports.
export { default as InfringementReportPage } from '../pages/shop/InfringementReportPage.jsx';

// Money.
export { default as ShoppingCart } from '../pages/shop/ShoppingCart.jsx';
export { default as Checkout } from '../pages/shop/Checkout.jsx';
export { default as OrderReturn } from '../pages/shop/OrderReturn.jsx';
export { default as OrderConfirmation } from '../pages/shop/OrderConfirmation.jsx';
export { default as WithdrawalPage } from '../pages/shop/WithdrawalPage.jsx';
// CP9-AC: Övergiven kassa, the reminder's resume and unsubscribe links.
export { default as CheckoutRecoveryPage } from '../pages/shop/CheckoutRecoveryPage.jsx';
export { default as CheckoutUnsubscribePage } from '../pages/shop/CheckoutUnsubscribePage.jsx';
