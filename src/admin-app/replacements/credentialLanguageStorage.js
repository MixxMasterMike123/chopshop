// src/utils/credentialLanguageStorage.js for the admin build (alias list,
// vite.admin.config.js). The sign-in pages' language choice is kept under
// this build's own key, the one replacements/credentialTranslations.js reads
// (no cookie: nothing on the server reads it). The older admin's keys are
// read once there (legacyStorage.js).

import { writeLocal } from './legacyStorage.js';

export const CREDENTIAL_LANGUAGE_KEY = 'admin.credentialLanguage';

export function rememberCredentialLanguage(languageCode) {
  if (typeof languageCode === 'string' && /^[a-z]{2}-[A-Z]{2}$/.test(languageCode)) {
    writeLocal(CREDENTIAL_LANGUAGE_KEY, languageCode);
  }
}
