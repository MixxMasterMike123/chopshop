/**
 * Geo + Language + Currency Detection System for B2C Shop
 * Handles intelligent detection based on geo-targeting, user preferences, and overrides
 * 
 * ONLY ACTIVE FOR: the storefront host (shop.* / shop-*)
 * (the admin/portal host always uses sv-SE + SEK)
 */

import { isShopHost } from './isShopHost';
import { detectCurrency, getCurrencySymbol, getCurrencyName } from './currencyDetection.js';

// Primary markets with full language + currency support
const PRIMARY_MARKETS = {
  'SE': { language: 'sv-SE', currency: 'SEK', name: 'Sverige' },
  'GB': { language: 'en-GB', currency: 'GBP', name: 'United Kingdom' },
  'UK': { language: 'en-GB', currency: 'GBP', name: 'United Kingdom' }, // Alternative code
  'US': { language: 'en-US', currency: 'USD', name: 'United States' }
};

// Secondary markets (English + local currency)
const SECONDARY_MARKETS = {
  // European Union (English + Euro)
  'DE': { language: 'en-GB', currency: 'EUR', name: 'Germany' },
  'FR': { language: 'en-GB', currency: 'EUR', name: 'France' },
  'IT': { language: 'en-GB', currency: 'EUR', name: 'Italy' },
  'ES': { language: 'en-GB', currency: 'EUR', name: 'Spain' },
  'NL': { language: 'en-GB', currency: 'EUR', name: 'Netherlands' },
  'BE': { language: 'en-GB', currency: 'EUR', name: 'Belgium' },
  'AT': { language: 'en-GB', currency: 'EUR', name: 'Austria' },
  'FI': { language: 'en-GB', currency: 'EUR', name: 'Finland' },
  'IE': { language: 'en-GB', currency: 'EUR', name: 'Ireland' },
  'PT': { language: 'en-GB', currency: 'EUR', name: 'Portugal' },
  
  // Nordic countries
  'NO': { language: 'en-GB', currency: 'NOK', name: 'Norway' },
  'DK': { language: 'en-GB', currency: 'DKK', name: 'Denmark' },
  
  // Major markets
  'BR': { language: 'en-GB', currency: 'BRL', name: 'Brazil' },
  'CH': { language: 'en-GB', currency: 'CHF', name: 'Switzerland' },
  'JP': { language: 'en-GB', currency: 'JPY', name: 'Japan' },
  'AU': { language: 'en-GB', currency: 'USD', name: 'Australia' },
  'CA': { language: 'en-GB', currency: 'USD', name: 'Canada' },
  'NZ': { language: 'en-GB', currency: 'USD', name: 'New Zealand' }
};

// Language to currency mapping (for manual language selection)
const LANGUAGE_CURRENCY_MAP = {
  'sv-SE': 'SEK',
  'en-GB': 'GBP', 
  'en-US': 'USD'
};

// Available languages for manual selection
const AVAILABLE_LANGUAGES = [
  { code: 'sv-SE', name: 'Svenska', flag: '🇸🇪', currency: 'SEK' },
  { code: 'en-GB', name: 'English (UK)', flag: '🇬🇧', currency: 'GBP' },
  { code: 'en-US', name: 'English (US)', flag: '🇺🇸', currency: 'USD' }
];

/**
 * Gets CloudFlare country from window object (injected by Worker)
 * @returns {string|null} Two-letter country code or null
 */
export const getCloudFlareCountry = () => {
  try {
    if (typeof window === 'undefined') {
      console.log('🌍 CloudFlare: Not in browser environment');
      return null;
    }
    
    console.log('🌍 CloudFlare Detection Debug:');
    console.log('  - window.CF_COUNTRY:', window.CF_COUNTRY);
    console.log('  - window.CF_GEO_LOADED:', window.CF_GEO_LOADED);
    console.log('  - Current hostname:', window.location.hostname);
    console.log('  - User agent:', navigator.userAgent.substring(0, 50) + '...');
    
    // Check CloudFlare injected data (from Worker)
    if (window.CF_COUNTRY && window.CF_GEO_LOADED) {
      console.log('🌍 CloudFlare country detected:', window.CF_COUNTRY);
      return window.CF_COUNTRY;
    }
    
    // Check if CF_COUNTRY exists but CF_GEO_LOADED doesn't
    if (window.CF_COUNTRY) {
      console.log('🌍 CloudFlare country detected (no geo loaded flag):', window.CF_COUNTRY);
      return window.CF_COUNTRY;
    }
    
    // Fallback: Check cached country
    const cached = localStorage.getItem('cf-country');
    console.log('🌍 Cached country check:', cached);
    if (cached) {
      console.log('🌍 Using cached country:', cached);
      return cached;
    }
    
    // Ultimate fallback: timezone detection
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    console.log('🌍 Browser timezone:', timezone);
    const timezoneCountryMap = {
      'Europe/Stockholm': 'SE',
      'Europe/London': 'GB',
      'Europe/Berlin': 'DE',
      'Europe/Paris': 'FR',
      'Europe/Rome': 'IT',
      'Europe/Madrid': 'ES',
      'Europe/Amsterdam': 'NL',
      'America/New_York': 'US',
      'America/Los_Angeles': 'US',
      'America/Chicago': 'US'
    };
    
    const country = timezoneCountryMap[timezone];
    if (country) {
      console.log('🌍 Country from timezone:', country);
      // Cache the timezone-detected country
      localStorage.setItem('cf-country', country);
      return country;
    }
    
    console.log('🌍 No country detected from any method');
    return null;
  } catch (error) {
    console.warn('Error getting CloudFlare country:', error);
    return null;
  }
};

/**
 * Detects optimal language and currency based on geo, user preferences, and overrides
 * @param {Object} options - Detection options
 * @param {string} options.userPreferredLang - Logged-in user's preferred language
 * @param {string} options.manualLanguage - Manual language selection
 * @param {string} options.manualCurrency - Manual currency selection
 * @param {boolean} options.respectUserPreferences - Whether to respect logged-in user prefs
 * @returns {Object} Language and currency detection result
 */
export const detectLanguageAndCurrency = (options = {}) => {
  try {
    const {
      userPreferredLang = null,
      manualLanguage = null,
      manualCurrency = null,
      respectUserPreferences = true
    } = options;
    
    // Check if we're on the B2C shop domain
    const isShopDomain = isShopHost();
    
    console.log('🔍 Detection Debug:', {
      isShopDomain,
      hostname: typeof window !== 'undefined' ? window.location.hostname : 'server',
      userPreferredLang,
      manualLanguage,
      manualCurrency
    });
    
    // If not on shop domain, always return Swedish (B2B portal)
    if (!isShopDomain) {
      console.log('🏠 B2B Portal: Using sv-SE + SEK');
      return {
        language: 'sv-SE',
        currency: 'SEK',
        source: 'b2b-portal',
        countryDetected: 'SE',
        market: 'primary'
      };
    }
    
    console.log('🛒 B2C Shop: Detecting language and currency...');
    
    // 1. Manual overrides take highest priority
    if (manualLanguage && manualCurrency) {
      console.log('👤 Manual override:', manualLanguage, '+', manualCurrency);
      return {
        language: manualLanguage,
        currency: manualCurrency,
        source: 'manual-override',
        countryDetected: getCloudFlareCountry(),
        market: 'manual'
      };
    }
    
    // 2. Logged-in user preferences (if enabled)
    if (respectUserPreferences && userPreferredLang) {
      const userCurrency = LANGUAGE_CURRENCY_MAP[userPreferredLang] || 'SEK';
      console.log('👤 User preference:', userPreferredLang, '+', userCurrency);
      return {
        language: userPreferredLang,
        currency: userCurrency,
        source: 'user-preference',
        countryDetected: getCloudFlareCountry(),
        market: 'user'
      };
    }
    
    // 3. Geo-based detection
    const country = getCloudFlareCountry();
    console.log('🌍 Detected country:', country);
    
    // TEMPORARY DEBUG: Force Germany detection for testing
    // TODO: Remove this after CloudFlare Worker is fixed
    const testCountry = country || 'DE'; // Force DE if no country detected
    console.log('🧪 DEBUG: Using country for detection:', testCountry);
    
    if (testCountry) {
      // Check primary markets first
      if (PRIMARY_MARKETS[testCountry]) {
        const market = PRIMARY_MARKETS[testCountry];
        console.log('🎯 Primary market detected:', testCountry, '→', market.language, '+', market.currency);
        return {
          language: market.language,
          currency: market.currency,
          source: country ? 'geo-primary' : 'debug-primary',
          countryDetected: testCountry,
          market: 'primary',
          countryName: market.name
        };
      }
      
      // Check secondary markets
      if (SECONDARY_MARKETS[testCountry]) {
        const market = SECONDARY_MARKETS[testCountry];
        console.log('🌍 Secondary market detected:', testCountry, '→', market.language, '+', market.currency);
        return {
          language: market.language,
          currency: market.currency,
          source: country ? 'geo-secondary' : 'debug-secondary',
          countryDetected: testCountry,
          market: 'secondary',
          countryName: market.name
        };
      }
      
      // Unknown country - use English + try to detect currency
      const detectedCurrency = detectCurrency(null, null);
      console.log('❓ Unknown country:', testCountry, '→ en-GB +', detectedCurrency);
      return {
        language: 'en-GB',
        currency: detectedCurrency,
        source: country ? 'geo-unknown' : 'debug-unknown',
        countryDetected: testCountry,
        market: 'unknown'
      };
    }
    
    // 4. Browser language fallback
    const browserLang = navigator.language || navigator.userLanguage;
    console.log('🌐 Browser language fallback:', browserLang);
    if (LANGUAGE_CURRENCY_MAP[browserLang]) {
      const currency = LANGUAGE_CURRENCY_MAP[browserLang];
      console.log('🌐 Browser language matched:', browserLang, '+', currency);
      return {
        language: browserLang,
        currency: currency,
        source: 'browser-language',
        countryDetected: null,
        market: 'fallback'
      };
    }
    
    // 5. Ultimate fallback - Swedish for B2C shop
    console.log('🏠 Ultimate fallback: sv-SE + SEK');
    return {
      language: 'sv-SE',
      currency: 'SEK',
      source: 'ultimate-fallback',
      countryDetected: null,
      market: 'fallback'
    };
    
  } catch (error) {
    console.error('Error detecting language and currency:', error);
    return {
      language: 'sv-SE',
      currency: 'SEK',
      source: 'error-fallback',
      countryDetected: null,
      market: 'error'
    };
  }
};

/**
 * Gets available languages for manual selection
 * @returns {Array} Array of language options
 */
export const getAvailableLanguages = () => {
  return AVAILABLE_LANGUAGES;
};

/**
 * Validates if a language + currency combination is supported
 * @param {string} language - Language code
 * @param {string} currency - Currency code
 * @returns {boolean} True if combination is valid
 */
export const isValidLanguageCurrencyPair = (language, currency) => {
  if (!language || !currency) return false;
  
  // Check if it's a primary market combination
  const primaryMatch = Object.values(PRIMARY_MARKETS).find(
    market => market.language === language && market.currency === currency
  );
  
  if (primaryMatch) return true;
  
  // Check if language exists and currency is valid
  const languageExists = LANGUAGE_CURRENCY_MAP[language];
  const supportedCurrencies = ['SEK', 'EUR', 'USD', 'GBP', 'BRL', 'NOK', 'DKK', 'CHF', 'JPY'];
  
  return languageExists && supportedCurrencies.includes(currency);
};

/**
 * Gets currency for a specific language (for manual language changes)
 * @param {string} language - Language code
 * @returns {string} Default currency for that language
 */
export const getCurrencyForLanguage = (language) => {
  return LANGUAGE_CURRENCY_MAP[language] || 'SEK';
};

/**
 * Gets market information for a country
 * @param {string} country - Two-letter country code
 * @returns {Object} Market information
 */
export const getMarketInfo = (country) => {
  if (!country) return null;
  
  if (PRIMARY_MARKETS[country]) {
    return {
      ...PRIMARY_MARKETS[country],
      type: 'primary',
      hasFullSupport: true
    };
  }
  
  if (SECONDARY_MARKETS[country]) {
    return {
      ...SECONDARY_MARKETS[country],
      type: 'secondary',
      hasFullSupport: false
    };
  }
  
  return {
    language: 'en-GB',
    currency: 'SEK', // fallback
    name: 'Unknown',
    type: 'unknown',
    hasFullSupport: false
  };
};

/**
 * Creates a formatted display string for language + currency
 * @param {string} language - Language code
 * @param {string} currency - Currency code
 * @returns {string} Formatted display string
 */
export const getLanguageCurrencyDisplay = (language, currency) => {
  const langInfo = AVAILABLE_LANGUAGES.find(l => l.code === language);
  const currencySymbol = getCurrencySymbol(currency);
  const currencyName = getCurrencyName(currency);
  
  if (langInfo) {
    return `${langInfo.flag} ${langInfo.name} (${currencySymbol} ${currency})`;
  }
  
  return `${language} (${currencySymbol} ${currencyName})`;
};

/**
 * Stores user language and currency preferences
 * @param {string} language - Language code
 * @param {string} currency - Currency code
 */
export const storeUserPreferences = (language, currency) => {
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem('user-language-preference', language);
      localStorage.setItem('user-currency-preference', currency);
      localStorage.setItem('user-preferences-timestamp', Date.now().toString());
      console.log('💾 Stored user preferences:', language, '+', currency);
    }
  } catch (error) {
    console.warn('Error storing user preferences:', error);
  }
};

/**
 * Gets stored user preferences
 * @returns {Object} Stored preferences or null
 */
export const getStoredUserPreferences = () => {
  try {
    if (typeof window === 'undefined') return null;
    
    const language = localStorage.getItem('user-language-preference');
    const currency = localStorage.getItem('user-currency-preference');
    const timestamp = localStorage.getItem('user-preferences-timestamp');
    
    if (!language || !currency || !timestamp) return null;
    
    // Check if preferences are less than 30 days old
    const age = Date.now() - parseInt(timestamp);
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
    
    if (age > maxAge) {
      // Clear expired preferences
      localStorage.removeItem('user-language-preference');
      localStorage.removeItem('user-currency-preference');
      localStorage.removeItem('user-preferences-timestamp');
      return null;
    }
    
    return { language, currency };
  } catch (error) {
    console.warn('Error getting stored user preferences:', error);
    return null;
  }
}; 