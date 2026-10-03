// Where the sign-in pages' language switcher (CredentialLanguageSwitcher.jsx)
// keeps the chosen language — the OLDER build's keys. The admin build
// (vite.admin.config.js) swaps this module, by its alias list, for
// src/admin-app/replacements/credentialLanguageStorage.js (its own key).
//
// The switcher's former inline writes, moved and unchanged.

export function rememberCredentialLanguage(languageCode) {
  // Store in unified key (shared with main app)
  localStorage.setItem('b8shield-language', languageCode);
  // Also store in credential-specific key for backward compatibility
  localStorage.setItem('b8shield-credential-language', languageCode);
  
  // Store in cookie for 30 days (unified key)
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + 30);
  document.cookie = `b8shield-language=${languageCode}; expires=${expiryDate.toUTCString()}; path=/`;
  // Also set credential-specific cookie for backward compatibility
  document.cookie = `b8shield-credential-language=${languageCode}; expires=${expiryDate.toUTCString()}; path=/`;
}
