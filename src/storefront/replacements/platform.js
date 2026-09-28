// src/config/platform.js for the Cloudflare storefront (alias list,
// vite.storefront.config.js). The same two values of the build: the platform
// operator's legal name and organisation number (the platform terms page and
// the legal-page renderer's merge fields).
//
// Replaced because the Firebase module reads `import.meta.env` as a whole
// object, which makes the build inline EVERY `VITE_*` variable of the
// environment into the bundle (the Firebase project's configuration
// included). Here each value is read by its own name, so only these two are.

export const PLATFORM = {
  // Legal name of the platform operator (the company behind the platform).
  legalName: import.meta.env.VITE_PLATFORM_LEGAL_NAME || 'Meteor PR AB',
  // Org number of the platform operator.
  orgNumber: import.meta.env.VITE_PLATFORM_ORG_NUMBER || '',
};
