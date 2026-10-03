// src/utils/credentialTranslations.js for the admin build (alias list,
// vite.admin.config.js): the sign-in pages' translations from the static
// locale files (D16, src/locales/<lang>.json) instead of Firestore. The same
// singleton with the same four members the pages call: getStoredLanguage(),
// setLanguage(code), t(key, fallback), and `currentLanguage`.
//
// Swedish is part of the bundle; another language is loaded when chosen. A
// key a file lacks falls back to the text in the code, as before. The chosen
// language is kept under this build's own key; the older admin's key is read
// once (by its suffix, legacyStorage.js: CP5-FB).

import { readWithLegacy } from './legacyStorage.js';

const STORAGE_KEY = 'admin.credentialLanguage';
const LEGACY_SUFFIXES = ['-credential-language', '-language'];
const DEFAULT_LANGUAGE = 'sv-SE';

const BUNDLED = import.meta.glob('../../locales/sv-SE.json', { eager: true, import: 'default' });
const LAZY = import.meta.glob(['../../locales/*.json', '!../../locales/sv-SE.json'], { import: 'default' });

const fileOf = (code) => `../../locales/${code}.json`;
const isCode = (code) => typeof code === 'string' && /^[a-z]{2}-[A-Z]{2}$/.test(code);

class CredentialTranslations {
  constructor() {
    this.translations = {};
    this.currentLanguage = this.getStoredLanguage();
    this.loaded = false;
  }

  getStoredLanguage() {
    try {
      const stored = readWithLegacy(STORAGE_KEY, LEGACY_SUFFIXES, isCode);
      if (isCode(stored) && (BUNDLED[fileOf(stored)] || LAZY[fileOf(stored)])) return stored;
    } catch {
      /* storage refused: the default */
    }
    return DEFAULT_LANGUAGE;
  }

  async loadTranslations(language) {
    const bundled = BUNDLED[fileOf(language)];
    let table = bundled && typeof bundled === 'object' ? bundled : null;
    if (!table && LAZY[fileOf(language)]) {
      try {
        const loaded = await LAZY[fileOf(language)]();
        table = loaded && typeof loaded === 'object' ? loaded : null;
      } catch (error) {
        console.warn('Translations: using the texts in the code:', error?.message);
      }
    }
    this.translations = table ?? {};
    this.currentLanguage = language;
    this.loaded = true;
  }

  t(key, fallback = null) {
    if (!this.loaded) return fallback || key;
    return this.translations[key] || fallback || key;
  }

  async setLanguage(language) {
    const code = isCode(language) ? language : DEFAULT_LANGUAGE;
    this.loaded = false;
    await this.loadTranslations(code);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, code);
    } catch {
      /* storage refused: chosen for this page only */
    }
  }
}

const credentialTranslations = new CredentialTranslations();

export default credentialTranslations;
