// Translations for the Cloudflare storefront (D16): a static file per
// language, `src/locales/<lang>.json` (`{ "<key>": "<text>" }`), built from the
// export by the importer (brief S). `useTranslation()` returns the same value
// as TranslationContext.jsx.
//
// The default language's file is part of the bundle, so the first paint is
// already translated; any other language is loaded when chosen. While no file
// exists (until S delivers them), every key falls back to the text in the
// code, as it does today when a key is missing. The storefront is Swedish only
// (SE-only launch): the language is sv-SE unless `?lang=` names another one.

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const DEFAULT_LANGUAGE = 'sv-SE';

const AVAILABLE_LANGUAGES = [
  { code: 'sv-SE', name: 'Svenska', flag: '🇸🇪' },
  { code: 'en-GB', name: 'English (UK)', flag: '🇬🇧' },
  { code: 'en-US', name: 'English (US)', flag: '🇺🇸' },
];

// Zero or one match each: Vite resolves both at build time.
const BUNDLED = import.meta.glob('../../locales/sv-SE.json', { eager: true, import: 'default' });
const LAZY = import.meta.glob(['../../locales/*.json', '!../../locales/sv-SE.json'], { import: 'default' });

function fileOf(code) {
  return `../../locales/${code}.json`;
}

function isSupported(code) {
  return AVAILABLE_LANGUAGES.some((language) => language.code === code);
}

function initialLanguage() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('lang');
    return fromUrl && isSupported(fromUrl) ? fromUrl : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

function bundled(code) {
  const table = BUNDLED[fileOf(code)];
  return table && typeof table === 'object' ? table : null;
}

const TranslationContext = createContext(null);

export function TranslationProvider({ children }) {
  const [currentLanguage, setCurrentLanguage] = useState(initialLanguage);
  const [translations, setTranslations] = useState(() => bundled(currentLanguage) ?? {});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const table = bundled(currentLanguage);
    if (table) {
      setTranslations(table);
      return undefined;
    }
    const load = LAZY[fileOf(currentLanguage)];
    if (!load) {
      setTranslations({});
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    load()
      .then((loaded) => {
        if (!cancelled) setTranslations(loaded && typeof loaded === 'object' ? loaded : {});
      })
      .catch((error) => {
        console.warn('Translations: using the texts in the code:', error?.message);
        if (!cancelled) setTranslations({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentLanguage]);

  const changeLanguage = useCallback(async (code) => {
    setCurrentLanguage(isSupported(code) ? code : DEFAULT_LANGUAGE);
  }, []);

  // Same lookup and interpolation as TranslationContext.jsx.
  const t = (key, fallback = '', variables = {}) => {
    let text = translations[key] || fallback || key;
    if (variables && Object.keys(variables).length > 0) {
      Object.entries(variables).forEach(([variable, value]) => {
        text = text.replace(new RegExp(`{{${variable}}}`, 'g'), value);
      });
    }
    return text;
  };

  const value = {
    currentLanguage,
    translations,
    loading,
    changeLanguage,
    t,
    getAvailableLanguages: () => AVAILABLE_LANGUAGES,
    isLanguageSupported: isSupported,
  };

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation() {
  const context = useContext(TranslationContext);
  if (!context) {
    throw new Error('useTranslation must be used within a TranslationProvider');
  }
  return context;
}
