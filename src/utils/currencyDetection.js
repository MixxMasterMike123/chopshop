/**
 * Currency Detection Service for B2C Shop
 * Detects user's preferred currency based on CloudFlare geo-targeting, 
 * language preferences, and fallback logic
 * 
 * ONLY ACTIVE FOR: the storefront host (shop.* / shop-*)
 * (the admin/portal host always uses SEK)
 */

import { isShopHost } from './isShopHost';

// Country to currency mapping
const COUNTRY_TO_CURRENCY = {
  // European Union (Euro)
  'DE': 'EUR', 'FR': 'EUR', 'IT': 'EUR', 'ES': 'EUR', 'NL': 'EUR', 
  'BE': 'EUR', 'AT': 'EUR', 'FI': 'EUR', 'IE': 'EUR', 'PT': 'EUR',
  'LU': 'EUR', 'MT': 'EUR', 'CY': 'EUR', 'SI': 'EUR', 'SK': 'EUR',
  'EE': 'EUR', 'LV': 'EUR', 'LT': 'EUR', 'GR': 'EUR',
  
  // English-speaking countries (GBP/USD)
  'GB': 'GBP', 'UK': 'GBP',
  'US': 'USD', 'CA': 'USD', 'AU': 'USD', 'NZ': 'USD',
  
  // Brazil
  'BR': 'BRL',
  
  // Nordic countries (SEK/NOK/DKK)
  'SE': 'SEK', 'NO': 'NOK', 'DK': 'DKK',
  
  // Other major markets
  'CH': 'CHF', 'JP': 'JPY', 'CN': 'CNY', 'IN': 'INR', 'MX': 'MXN'
};

// Language to currency mapping (fallback)
const LANGUAGE_TO_CURRENCY = {
  'sv-SE': 'SEK',
  'en-GB': 'GBP', 
  'en-US': 'USD',
  'en-AU': 'USD',
  'en-CA': 'USD',
  'pt-BR': 'BRL',
  'de-DE': 'EUR',
  'fr-FR': 'EUR',
  'es-ES': 'EUR',
  'it-IT': 'EUR',
  'nl-NL': 'EUR'
};

/**
 * Gets the CloudFlare country code from headers
 * @returns {string|null} Two-letter country code or null
 */
export const getCloudFlareCountry = () => {
  try {
    // Check if we're in a browser environment
    if (typeof window === 'undefined') return null;
    
    // CloudFlare sets CF-IPCountry header, but we need to detect it differently in browser
    // We'll use a combination of approaches:
    
    // 1. Check if CloudFlare country is available in window object (if set by server)
    if (window.CF_COUNTRY) {
      return window.CF_COUNTRY;
    }
    
    // 2. Check localStorage for cached country
    const cachedCountry = localStorage.getItem('cf-country');
    if (cachedCountry) {
      return cachedCountry;
    }
    
    // 3. Use browser's timezone as fallback detection
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) {
      // Simple timezone to country mapping for major markets
      const timezoneCountryMap = {
        'Europe/Stockholm': 'SE',
        'Europe/London': 'GB', 
        'America/New_York': 'US',
        'America/Los_Angeles': 'US',
        'America/Chicago': 'US',
        'America/Sao_Paulo': 'BR',
        'Europe/Berlin': 'DE',
        'Europe/Paris': 'FR',
        'Europe/Rome': 'IT',
        'Europe/Madrid': 'ES',
        'Europe/Amsterdam': 'NL'
      };
      
      return timezoneCountryMap[timezone] || null;
    }
    
    return null;
  } catch (error) {
    console.warn('Error detecting CloudFlare country:', error);
    return null;
  }
};

/**
 * Detects user's preferred currency based on multiple factors
 * @param {string} userLanguage - User's preferred language (e.g., 'sv-SE')
 * @param {string} manualOverride - Manual currency selection by user
 * @returns {string} Currency code (e.g., 'SEK', 'EUR', 'USD')
 */
export const detectCurrency = (userLanguage = null, manualOverride = null) => {
  try {
    // Check if we're on the B2C shop domain
    const isShopDomain = isShopHost();
    
    // If not on shop domain, always return SEK (B2B portal)
    if (!isShopDomain) {
      console.log('🏠 Currency: B2B portal - using SEK');
      return 'SEK';
    }
    
    console.log('🛒 Currency: B2C shop - detecting currency...');
    
    // 1. Manual override takes highest priority
    if (manualOverride && isValidCurrency(manualOverride)) {
      console.log('💰 Currency: Manual override ->', manualOverride);
      return manualOverride;
    }
    
    // 2. CloudFlare geo-targeting
    const cfCountry = getCloudFlareCountry();
    if (cfCountry && COUNTRY_TO_CURRENCY[cfCountry]) {
      const geoCurrency = COUNTRY_TO_CURRENCY[cfCountry];
      console.log('🌍 Currency: Geo-targeting ->', cfCountry, '→', geoCurrency);
      return geoCurrency;
    }
    
    // 3. User language preference
    if (userLanguage && LANGUAGE_TO_CURRENCY[userLanguage]) {
      const langCurrency = LANGUAGE_TO_CURRENCY[userLanguage];
      console.log('🗣️ Currency: Language preference ->', userLanguage, '→', langCurrency);
      return langCurrency;
    }
    
    // 4. Browser language fallback
    const browserLang = navigator.language || navigator.userLanguage;
    if (browserLang && LANGUAGE_TO_CURRENCY[browserLang]) {
      const browserCurrency = LANGUAGE_TO_CURRENCY[browserLang];
      console.log('🌐 Currency: Browser language ->', browserLang, '→', browserCurrency);
      return browserCurrency;
    }
    
    // 5. Default fallback to SEK
    console.log('🏠 Currency: Fallback to SEK');
    return 'SEK';
    
  } catch (error) {
    console.warn('Error detecting currency:', error);
    return 'SEK'; // Always fallback to SEK
  }
};

/**
 * Validates if a currency code is supported
 * @param {string} currency - Currency code to validate
 * @returns {boolean} True if currency is supported
 */
export const isValidCurrency = (currency) => {
  const supportedCurrencies = ['SEK', 'EUR', 'USD', 'GBP', 'BRL', 'NOK', 'DKK', 'CHF', 'JPY', 'CNY', 'INR', 'MXN'];
  return supportedCurrencies.includes(currency);
};

/**
 * Gets currency symbol for display
 * @param {string} currency - Currency code
 * @returns {string} Currency symbol
 */
export const getCurrencySymbol = (currency) => {
  const symbols = {
    'SEK': 'kr',
    'EUR': '€',
    'USD': '$',
    'GBP': '£',
    'BRL': 'R$',
    'NOK': 'kr',
    'DKK': 'kr',
    'CHF': 'CHF',
    'JPY': '¥',
    'CNY': '¥',
    'INR': '₹',
    'MXN': '$'
  };
  
  return symbols[currency] || currency;
};

/**
 * Gets currency name for display
 * @param {string} currency - Currency code
 * @returns {string} Currency name
 */
export const getCurrencyName = (currency) => {
  const names = {
    'SEK': 'Swedish Krona',
    'EUR': 'Euro',
    'USD': 'US Dollar',
    'GBP': 'British Pound',
    'BRL': 'Brazilian Real',
    'NOK': 'Norwegian Krone',
    'DKK': 'Danish Krone',
    'CHF': 'Swiss Franc',
    'JPY': 'Japanese Yen',
    'CNY': 'Chinese Yuan',
    'INR': 'Indian Rupee',
    'MXN': 'Mexican Peso'
  };
  
  return names[currency] || currency;
};

/**
 * Sets CloudFlare country in localStorage (for caching)
 * @param {string} country - Two-letter country code
 */
export const setCachedCountry = (country) => {
  try {
    if (typeof window !== 'undefined' && country) {
      localStorage.setItem('cf-country', country);
      localStorage.setItem('cf-country-timestamp', Date.now().toString());
    }
  } catch (error) {
    console.warn('Error caching country:', error);
  }
};

/**
 * Gets cached country with expiration check (24 hours)
 * @returns {string|null} Cached country code or null if expired
 */
export const getCachedCountry = () => {
  try {
    if (typeof window === 'undefined') return null;
    
    const country = localStorage.getItem('cf-country');
    const timestamp = localStorage.getItem('cf-country-timestamp');
    
    if (!country || !timestamp) return null;
    
    const age = Date.now() - parseInt(timestamp);
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    if (age > maxAge) {
      localStorage.removeItem('cf-country');
      localStorage.removeItem('cf-country-timestamp');
      return null;
    }
    
    return country;
  } catch (error) {
    console.warn('Error getting cached country:', error);
    return null;
  }
}; 