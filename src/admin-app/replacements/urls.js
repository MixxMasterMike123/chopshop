// src/config/urls.js for the admin build (alias list, vite.admin.config.js).
// The admin is its own origin; the storefront is the web Worker's. No Cloud
// Functions: `functionUrl` refuses (no page of this build may call one).
//
// Each value is read by its own name: the original reads `import.meta.env`
// whole, which inlines EVERY `VITE_*` variable of the environment into the
// bundle.

import { notAvailable } from '../../api/admin/client.js';

const STOREFRONT_ORIGIN = import.meta.env.VITE_STOREFRONT_ORIGIN || '';

const here = () => (typeof window !== 'undefined' ? window.location.origin : '');

export const APP_URLS = {
  // This admin's own origin.
  get ADMIN_URL() {
    return here();
  },
  // The storefront's origin (shop links are `${B2C_SHOP}/<shop>/…`). Empty
  // when the build was made without VITE_STOREFRONT_ORIGIN.
  B2C_SHOP: STOREFRONT_ORIGIN,
  get B2B_PORTAL() {
    return here();
  },
  get LOGO_URL() {
    return `${here()}/images/logo.svg`;
  },
  getPortalUrl: () => here(),
  getLogoUrl: () => `${here()}/images/logo.svg`,
  getShopUrl: () => STOREFRONT_ORIGIN,
};

export const functionUrl = () => {
  throw notAvailable('En molnfunktion');
};

export const getCurrentDomain = () => here();

export const getPortalUrl = () => here();

export default APP_URLS;
