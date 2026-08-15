// Shared storefront-host test — replaces the hardcoded shop.b8shield.com checks
// that were scattered across geo/currency/wagon code. Those literals matched a
// dead brand domain, so they silently evaluated FALSE on the live storefront
// (shop-meteorpr.web.app and any custom domain), disabling the geo/currency
// detection they gated.
//
// Mirrors the surface rule in App.jsx: subdomain === 'shop' or a 'shop-' prefix
// (a Firebase hosting site id like `shop-meteorpr.web.app` has the whole site id
// as segment 0, so it can never be exactly "shop").
export const isShopHost = () => {
  if (typeof window === 'undefined') return false;
  const sub = (window.location.hostname || '').split('.')[0];
  return sub === 'shop' || sub.startsWith('shop-');
};
