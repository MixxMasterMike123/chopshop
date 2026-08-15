/**
 * Language + Currency Context for B2C Shop
 * Manages intelligent language and currency detection, user preferences, and overrides
 * Integrates with existing TranslationContext
 */

import { isShopHost } from '../utils/isShopHost';
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from './TranslationContext';
import { useSimpleAuth } from './SimpleAuthContext'; // B2C auth context
import { 
  getCountryConfig,
  isCountrySupported,
  getCurrencyCode,
  getCurrencySymbol,
  getLanguageForCountry,
  DEFAULT_COUNTRY,
  FALLBACK_LANGUAGE
} from '../utils/internationalCountries';
import { 
  getOptimalLanguageForCountry,
  checkTranslationExists 
} from '../utils/translationDetection';
import { convertPrice, convertPriceSmart } from '../utils/priceConversion.js';

const LanguageCurrencyContext = createContext();

/**
 * Hook to use Language + Currency context
 */
export const useLanguageCurrency = () => {
  const context = useContext(LanguageCurrencyContext);
  if (!context) {
    throw new Error('useLanguageCurrency must be used within a LanguageCurrencyProvider');
  }
  return context;
};

/**
 * Enhanced Language + Currency Provider for International E-commerce
 */
export const LanguageCurrencyProvider = ({ children }) => {
  // Get country from URL params
  const { countryCode: urlCountryCode } = useParams();
  
  // State management
  const [language, setLanguage] = useState('sv-SE');
  const [currency, setCurrency] = useState('SEK');
  const [detectionSource, setDetectionSource] = useState('loading');
  const [countryDetected, setCountryDetected] = useState(null);
  const [market, setMarket] = useState('primary');
  const [isLoading, setIsLoading] = useState(true);
  const [manualOverride, setManualOverride] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Get existing contexts
  const { changeLanguage: setTranslationLanguage } = useTranslation();
  const { currentUser } = useSimpleAuth(); // B2C user context

  /**
   * Safely updates translation language with error checking (NON-BLOCKING)
   */
  const safeSetTranslationLanguage = useCallback((language) => {
    try {
      if (typeof setTranslationLanguage === 'function') {
        console.log('🔤 Updating translation language to:', language, '(non-blocking)');
        // Make translation loading non-blocking for performance
        setTranslationLanguage(language).catch(error => {
          console.error('❌ Error setting translation language (non-critical):', error);
        });
      } else {
        console.warn('⚠️ setTranslationLanguage is not available:', typeof setTranslationLanguage);
      }
    } catch (error) {
      console.error('❌ Error setting translation language:', error);
    }
  }, [setTranslationLanguage]);

  /**
   * Updates both language and currency state with international support (NON-BLOCKING)
   */
  const updateLanguageAndCurrency = useCallback((newLanguage, newCurrency, source = 'manual', detectedCountry = null) => {
    console.log('🔄 Updating language and currency:', newLanguage, '+', newCurrency, 'from', source);
    
    // Update local state
    setLanguage(newLanguage);
    setCurrency(newCurrency);
    console.log(`💱 Currency state updated to: ${newCurrency}`);
    setDetectionSource(source);
    setCountryDetected(detectedCountry);
    setMarket(detectedCountry === 'se' ? 'primary' : 'secondary');
    
    // Update translation context safely (non-blocking)
    safeSetTranslationLanguage(newLanguage);
    
    // Store preferences if manual
    if (source === 'manual' || source === 'user-selection') {
      localStorage.setItem('user-language-preference', newLanguage);
      localStorage.setItem('user-currency-preference', newCurrency);
      setManualOverride(true);
    }
    
    console.log(`✅ Language/Currency update complete: ${newLanguage} + ${newCurrency}`);
    return true;
  }, [safeSetTranslationLanguage]);

  /**
   * Get country from URL path (fallback when useParams() is slow)
   */
  const getCountryFromPath = () => {
    if (typeof window === 'undefined') return null;
    
    const pathname = window.location.pathname;
    const segments = pathname?.split('/')?.filter(Boolean) || [];
    const countryCode = segments[0];
    
    if (countryCode && countryCode.length === 2) {
      return countryCode.toLowerCase();
    }
    
    return null;
  };

  /**
   * Initialize from URL country code with international support
   */
  const initializeFromUrlCountry = useCallback((countryCode) => {
    if (!countryCode) {
      console.log('🌍 LanguageCurrency: No country code provided');
      return false;
    }
    
    // Prevent multiple simultaneous initializations for same country
    if (isInitializing) {
      console.log('🌍 LanguageCurrency: Already initializing, skipping');
      return false;
    }
    
    setIsInitializing(true);
    
    try {
      const code = countryCode.toLowerCase();
      console.log(`🌍 LanguageCurrency: Initializing from URL country: ${code}`);
      
      // Get country configuration
      const countryConfig = getCountryConfig(code);
      
      if (!countryConfig) {
        console.log(`❓ Unknown country: ${code}, using default`);
        updateLanguageAndCurrency('sv-SE', 'SEK', 'unknown-country-fallback', 'SE');
        setIsInitialized(true);
        return true;
      }
      
      // Get optimal language for this country
      const optimalLanguage = getOptimalLanguageForCountry(code);
      const currency = countryConfig.currency;
      const isSupported = countryConfig.isSupported;
      
      console.log(`🌍 Country ${code}: ${optimalLanguage} + ${currency} (${isSupported ? 'supported' : 'unsupported'})`);
      
      updateLanguageAndCurrency(
        optimalLanguage, 
        currency, 
        'url-country', 
        code.toUpperCase()
      );
      
      setIsInitialized(true);
      return true;
    } finally {
      setIsInitializing(false);
    }
  }, [isInitializing]); // Keep isInitializing to prevent simultaneous calls

  /**
   * Manual language selection with URL country awareness
   */
  const selectLanguage = useCallback((newLanguage) => {
    console.log('👤 Manual language selection:', newLanguage);
    
    // If we have a URL country, get its currency
    let targetCurrency = 'SEK';
    if (urlCountryCode) {
      targetCurrency = getCurrencyCode(urlCountryCode) || 'SEK';
      console.log(`🔍 URL country ${urlCountryCode} → currency: ${targetCurrency}`);
    } else {
      // Map language to default currency
      const languageCurrencyMap = {
        'sv-SE': 'SEK',
        'en-GB': 'GBP',  // 🇬🇧 Fixed: GB should use GBP, not EUR
        'en-US': 'USD'
      };
      targetCurrency = languageCurrencyMap[newLanguage] || 'SEK';
      console.log(`🔍 Fallback mapping ${newLanguage} → currency: ${targetCurrency}`);
    }
    
    console.log(`🎯 selectLanguage: ${newLanguage} + ${targetCurrency} (from ${urlCountryCode ? 'URL' : 'mapping'})`);
    
    const success = updateLanguageAndCurrency(
      newLanguage, 
      targetCurrency, 
      'user-selection',
      urlCountryCode?.toUpperCase() || countryDetected
    );
    
    if (success) {
      console.log('✅ Language selection successful:', newLanguage, '→', targetCurrency);
    }
    
    return success;
  }, [urlCountryCode, countryDetected, updateLanguageAndCurrency]);

  /**
   * Manual currency selection (keeps current language)
   */
  const selectCurrency = useCallback((newCurrency) => {
    const success = updateLanguageAndCurrency(
      language, 
      newCurrency, 
      'user-selection',
      countryDetected
    );
    
    if (success) {
      console.log('👤 User selected currency:', newCurrency);
    }
    
    return success;
  }, [language, countryDetected, updateLanguageAndCurrency]);

  /**
   * Reset to geo-detected defaults
   */
  const resetToGeoDefaults = useCallback(async () => {
    // Clear stored preferences
    if (typeof window !== 'undefined') {
      localStorage.removeItem('user-language-preference');
      localStorage.removeItem('user-currency-preference');
    }
    
    setManualOverride(false);
    
    // Re-initialize from URL
    if (urlCountryCode) {
      await initializeFromUrlCountry(urlCountryCode);
    }
  }, [urlCountryCode, initializeFromUrlCountry]);

  /**
   * Converts a SEK price to current currency (SMART conversion with .99 psychological pricing)
   */
  const convertSEKPrice = useCallback(async (sekPrice) => {
    try {
      console.log(`💰 Converting ${sekPrice} SEK to ${currency} (SMART .99 pricing)`);
      
      if (currency === 'SEK') {
        console.log(`💰 No conversion needed: ${sekPrice} SEK`);
        return {
          originalPrice: sekPrice,
          convertedPrice: sekPrice,
          formatted: `${sekPrice.toFixed(2)} kr`,
          currency: 'SEK',
          exchangeRate: 1.0
        };
      }
      
      console.log(`💰 Converting ${sekPrice} SEK → ${currency} (SMART)...`);
      const result = await convertPriceSmart(sekPrice, currency);
      console.log(`💰 SMART conversion result:`, result);
      return result;
    } catch (error) {
      console.error('💰 Error converting price:', error);
      return {
        originalPrice: sekPrice,
        convertedPrice: sekPrice,
        formatted: `${sekPrice.toFixed(2)} kr`,
        currency: 'SEK',
        exchangeRate: 1.0,
        error: error.message
      };
    }
  }, [currency]);

  /**
   * Converts a SEK price to current currency (EXACT conversion for commissions/calculations)
   */
  const convertSEKPriceExact = useCallback(async (sekPrice) => {
    try {
      console.log(`💰 Converting ${sekPrice} SEK to ${currency} (EXACT)`);
      
      if (currency === 'SEK') {
        console.log(`💰 No conversion needed: ${sekPrice} SEK`);
        return {
          originalPrice: sekPrice,
          convertedPrice: sekPrice,
          formatted: `${sekPrice.toFixed(2)} kr`,
          currency: 'SEK',
          exchangeRate: 1.0
        };
      }
      
      console.log(`💰 Converting ${sekPrice} SEK → ${currency} (EXACT)...`);
      const result = await convertPrice(sekPrice, currency);
      console.log(`💰 EXACT conversion result:`, result);
      return result;
    } catch (error) {
      console.error('💰 Error converting price:', error);
      return {
        originalPrice: sekPrice,
        convertedPrice: sekPrice,
        formatted: `${sekPrice.toFixed(2)} kr`,
        currency: 'SEK',
        exchangeRate: 1.0,
        error: error.message
      };
    }
  }, [currency]);

  /**
   * Gets display information
   */
  const getDisplayInfo = useCallback(() => {
    return {
      language,
      currency,
      currencySymbol: getCurrencySymbol(countryDetected?.toLowerCase() || 'se'),
      detectionSource,
      countryDetected,
      market,
      isManual: manualOverride,
      isSupported: urlCountryCode ? isCountrySupported(urlCountryCode) : true,
      countryConfig: urlCountryCode ? getCountryConfig(urlCountryCode) : null
    };
  }, [language, currency, detectionSource, countryDetected, market, manualOverride, urlCountryCode]);

  // Initial detection on mount
  useEffect(() => {
    const initialize = async () => {
      // Storefront is Swedish-only (i18n deferred; /{countryCode} URL prefix
      // removed). Always initialize sv-SE / SEK — no geo-detection, no waiting.
      if (!isInitialized) {
        updateLanguageAndCurrency('sv-SE', 'SEK', 'default-swedish', 'SE');
        setIsInitialized(true);
      }
      setIsLoading(false);
    };

    initialize();
  }, [isInitialized]);

  // Re-detect when URL country changes (only when URL params change)
  useEffect(() => {
    const handleUrlChange = async () => {
      if (urlCountryCode && !isInitializing) {
        console.log(`🔄 URL params changed to: ${urlCountryCode}`);
        
        // **FAST PATH FOR SUPPORTED COUNTRIES** ⚡
        const countryConfig = getCountryConfig(urlCountryCode.toLowerCase());
        if (countryConfig && countryConfig.isSupported) {
          console.log(`⚡ FAST PATH: URL change to supported country ${urlCountryCode} → direct update`);
          const language = countryConfig.language;
          const currency = countryConfig.currency;
          
          console.log(`🎯 Direct update: ${language} + ${currency} (supported)`);
          updateLanguageAndCurrency(language, currency, 'supported-country-fast', urlCountryCode.toUpperCase());
          
          // Force a small delay to ensure React state updates are processed
          await new Promise(resolve => setTimeout(resolve, 10));
          
          setIsInitialized(true);
          console.log(`⚡ URL FAST PATH COMPLETE: ${language} + ${currency} → Ready for price conversion`);
          return; // Skip complex logic
        }
        
        // **COMPLEX PATH FOR UNSUPPORTED COUNTRIES** 🔄
        console.log(`🔄 COMPLEX PATH: URL change to unsupported country ${urlCountryCode} → complex logic`);
        setIsInitialized(false);
        initializeFromUrlCountry(urlCountryCode);
      }
    };
    
    handleUrlChange();
  }, [urlCountryCode, isInitializing]); // Allow re-initialization when URL changes

  // Timeout fallback for when no redirect happens (ONLY for unsupported countries)
  useEffect(() => {
    if (isShopHost() && !isInitialized) {
      
      // Check if we have country from either params or path
      const countryFromParams = urlCountryCode;
      const countryFromPath = getCountryFromPath();
      const hasCountry = countryFromParams || countryFromPath;
      
      if (!hasCountry) {
        console.log('🕐 Setting timeout for geo-redirect fallback (reduced to 100ms for better UX)');
        const timeoutId = setTimeout(() => {
          // Double-check that no country was detected during timeout
          const finalCountryFromParams = urlCountryCode;
          const finalCountryFromPath = getCountryFromPath();
          const finalHasCountry = finalCountryFromParams || finalCountryFromPath;
          
          if (!finalHasCountry && !isInitialized) {
            console.log('🕐 No redirect after 100ms, using Swedish defaults');
            updateLanguageAndCurrency('sv-SE', 'SEK', 'timeout-fallback', 'SE');
            setIsInitialized(true);
            setIsLoading(false);
          } else if (finalHasCountry && !isInitialized) {
            // Country was detected during timeout - process it immediately
            console.log('🔄 TIMEOUT COMPLEX: Detected country during timeout - processing immediately');
            // Check if it's a supported country before using complex logic
            const countryConfig = getCountryConfig(finalHasCountry.toLowerCase());
            if (countryConfig && countryConfig.isSupported) {
              console.log(`⚡ TIMEOUT FAST PATH: Detected supported country ${finalHasCountry} during timeout`);
              const language = countryConfig.language;
              const currency = countryConfig.currency;
              updateLanguageAndCurrency(language, currency, 'supported-country-timeout', finalHasCountry.toUpperCase());
              // Force a small delay to ensure React state updates are processed
              setTimeout(() => {
                setIsInitialized(true);
                setIsLoading(false);
                console.log(`⚡ TIMEOUT FAST PATH COMPLETE: ${language} + ${currency} → Ready for price conversion`);
              }, 10);
            } else {
              console.log(`🔄 TIMEOUT COMPLEX: Detected unsupported country ${finalHasCountry} during timeout`);
              initializeFromUrlCountry(finalHasCountry);
            }
          }
        }, 100); // Reduced from 500ms to 100ms for better UX
        
        return () => clearTimeout(timeoutId);
      } else {
        console.log(`🌍 Country detected: ${hasCountry} (from ${countryFromParams ? 'params' : 'path'}), no timeout needed`);
      }
    }
  }, [urlCountryCode, isInitialized]); // Allow to re-run when URL changes

  // Context value
  const contextValue = {
    // Current state
    language,
    currency,
    isLoading,
    isInitialized,
    isInitializing,
    detectionSource,
    countryDetected,
    market,
    isManual: manualOverride,
    
    // Actions
    selectLanguage,
    selectCurrency,
    resetToGeoDefaults,
    updateLanguageAndCurrency,
    
    // Utilities
    convertSEKPrice,
    convertSEKPriceExact,
    getDisplayInfo,
    
    // International support
    urlCountryCode,
    countryConfig: urlCountryCode ? getCountryConfig(urlCountryCode) : null,
    isCountrySupported: urlCountryCode ? isCountrySupported(urlCountryCode) : true,
    
    // Computed properties
    isShopDomain: isShopHost(),
    isPrimaryMarket: market === 'primary',
    isSecondaryMarket: market === 'secondary'
  };

  return (
    <LanguageCurrencyContext.Provider value={contextValue}>
      {children}
    </LanguageCurrencyContext.Provider>
  );
};

// Export the context for advanced usage
export { LanguageCurrencyContext }; 