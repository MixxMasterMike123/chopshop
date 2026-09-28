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
export const ShopGate = pendingGate(NotFoundPage);

// Catalogue.
export const PublicStorefront = pending('PublicStorefront');
export const AllProductsPage = pending('AllProductsPage');
export const TagPage = pending('TagPage');
export const CollectionPage = pending('CollectionPage');
export const ProductCollectionPage = pending('ProductCollectionPage');
export const PublicProductPage = pending('PublicProductPage');

// Content.
export const DynamicRouteHandler = pending('DynamicRouteHandler');

// Reports.
export const InfringementReportPage = pending('InfringementReportPage');

// Money.
export const ShoppingCart = pending('ShoppingCart');
export const Checkout = pending('Checkout');
export const OrderReturn = pending('OrderReturn');
export const OrderConfirmation = pending('OrderConfirmation');
export const WithdrawalPage = pending('WithdrawalPage');
