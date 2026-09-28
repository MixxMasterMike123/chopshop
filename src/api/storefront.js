// GET /v1/storefront — the one public read the storefront paints from.
// Shape (CP4 brief D; today's route answers the first three keys only):
//   { name, locale, currency,
//     identity,                                  allowlisted store identity keys
//     branding: { logo, hero, favicon, emailLogo }   each PublicImage | null
//     menu: [{ …, path }], features: { <key>: boolean },
//     pickupLocations, templateId, theme, accent }
// 404 (unknown, unpublished or suspended shop) → null.

import { readOne } from './client.js';

export function getStorefront({ signal } = {}) {
  return readOne('/v1/storefront', 'storefront', { signal });
}
