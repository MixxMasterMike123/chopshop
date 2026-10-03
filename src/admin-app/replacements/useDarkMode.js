// src/hooks/useDarkMode.js for the admin build (alias list,
// vite.admin.config.js). The same hook (`isDarkMode`, `toggleDarkMode`,
// `setDarkMode`; `.dark` on <html>), the choice kept under this build's own
// key. The older admin's key is read once (by its suffix, legacyStorage.js).

import { useEffect, useState } from 'react';
import { readWithLegacy, writeLocal } from './legacyStorage.js';

export const DARK_MODE_KEY = 'admin.darkMode';
const LEGACY_SUFFIXES = ['_dark_mode'];
const isBoolText = (v) => v === 'true' || v === 'false';

/** The stored choice (false when none). Pure apart from storage. */
export function storedDarkMode() {
  return readWithLegacy(DARK_MODE_KEY, LEGACY_SUFFIXES, isBoolText) === 'true';
}

export const useDarkMode = () => {
  const [isDarkMode, setIsDarkMode] = useState(() => (typeof window !== 'undefined' ? storedDarkMode() : false));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    writeLocal(DARK_MODE_KEY, JSON.stringify(isDarkMode));
  }, [isDarkMode]);

  return {
    isDarkMode,
    toggleDarkMode: () => setIsDarkMode((prev) => !prev),
    setDarkMode: (value) => setIsDarkMode(value),
  };
};
