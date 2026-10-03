// The admin pages' links to the storefront — the OLDER build's: the admin and
// the storefront share one origin, so each link is the path it always was.
// AdminStorefront ("Förhandsgranska butik"), AdminPages and AdminPageEdit
// ("Visa sida") and AdminCollectionEdit ("Visa") take their links from here.
// The admin build swaps this module, by its alias list (vite.admin.config.js),
// for src/admin-app/replacements/storefrontLinks.js: the storefront's origin
// and the shop, and the preview of an unpublished shop. Same names, same
// meaning: each function answers the props of its link.

import { getCollectionUrl } from '../../utils/productUrls';

const LINKS = Object.freeze({
  home: () => ({ href: '/' }),
  page: (slug) => ({ href: `/${slug}` }),
  collection: (handle) => ({ href: getCollectionUrl(handle) }),
});

/** `{ home(), page(slug), collection(handle) }`, each the props of its link. */
export function useStorefrontLinks() {
  return LINKS;
}
