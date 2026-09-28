// LanguageCurrencyContext for the Cloudflare storefront (alias list,
// vite.storefront.config.js). The storefront is Swedish and priced in kronor
// only: the Firebase provider initialises sv-SE / SEK unconditionally on mount
// ("Storefront is Swedish-only … Always initialize sv-SE / SEK") and converts
// nothing when the currency is SEK. This module answers the same values at
// once, with no detection and no provider, so SmartPrice and every page that
// reads `useLanguageCurrency()` render as they do on the live shop host.
//
// Replaced because the Firebase provider reads the signed-in customer
// (SimpleAuthContext) and the translation detection, both of which pull the
// Firebase SDK into the build.

import { createContext } from 'react';

const inKronor = (sekPrice) => ({
  originalPrice: sekPrice,
  convertedPrice: sekPrice,
  formatted: `${sekPrice.toFixed(2)} kr`,
  currency: 'SEK',
  exchangeRate: 1.0,
});

const convertSEKPrice = async (sekPrice) => inKronor(sekPrice);

const VALUE = Object.freeze({
  language: 'sv-SE',
  currency: 'SEK',
  isLoading: false,
  isInitialized: true,
  isInitializing: false,
  detectionSource: 'default-swedish',
  countryDetected: 'SE',
  market: 'primary',
  isManual: false,

  selectLanguage: () => false,
  selectCurrency: () => false,
  resetToGeoDefaults: async () => {},
  updateLanguageAndCurrency: () => false,

  convertSEKPrice,
  convertSEKPriceExact: convertSEKPrice,
  getDisplayInfo: () => ({
    language: 'sv-SE',
    currency: 'SEK',
    currencySymbol: 'kr',
    detectionSource: 'default-swedish',
    countryDetected: 'SE',
    market: 'primary',
    isManual: false,
    isSupported: true,
    countryConfig: null,
  }),

  urlCountryCode: undefined,
  countryConfig: null,
  isCountrySupported: true,

  // The storefront build only ever serves a shop.
  isShopDomain: true,
  isPrimaryMarket: true,
  isSecondaryMarket: false,
});

export const LanguageCurrencyContext = createContext(VALUE);

export const useLanguageCurrency = () => VALUE;

export const LanguageCurrencyProvider = ({ children }) => children;
