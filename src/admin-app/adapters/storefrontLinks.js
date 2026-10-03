// The storefront addresses the admin pages link to (CP5-FX, finding 9).
// PURE: no React, no fetch, no browser API; tested under Node
// (storefrontLinks.test.mjs).
//
// The admin is its own origin; the storefront is the web Worker's
// (VITE_STOREFRONT_ORIGIN), and a shop lives at `<origin>/<shop>` on that
// shared host (D77), with the address grammar of the storefront's router
// (src/storefront/StorefrontApp.jsx): the home `/`, a content page
// `/<slug>`, a collection `/samling/<handle>`. A path relative to the admin's
// origin would open the admin instead.
//
// An UNPUBLISHED shop has no public storefront (D57): its link opens the
// PREVIEW instead, `<address>#preview=<grant>` with a grant of
// POST /v1/admin/preview (CP4_D2_REPORT.md "Reviewer wiring" 1). The grant
// rides in the fragment, which no server and no Referer ever sees; the
// storefront takes it from any address under the shop's root.

const segment = (value) => encodeURIComponent(String(value));

/** The paths, relative to the shop's root. */
export const homePath = () => '/';
export const pagePath = (slug) => `/${segment(slug)}`;
export const collectionPath = (handle) => `/samling/${segment(handle)}`;

/** `<origin>/<shop><path>`, or null without a shop. */
export function storefrontUrl(origin, shopId, path = '/') {
  if (typeof shopId !== 'string' || shopId === '') return null;
  const base = String(origin ?? '').replace(/\/+$/, '');
  return `${base}/${segment(shopId)}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The preview address of a storefront address. */
export function withPreviewGrant(url, grant) {
  return `${url}#preview=${grant}`;
}

/**
 * The props of a link to `path` of the shop's storefront: `{ href }` for a
 * published shop; for an unpublished one (or one whose state is not known)
 * also `onClick`, which keeps the browser from opening the plain address (it
 * would show the not-found page) and calls `openPreview(shopId, path)`.
 */
export function storefrontLinkProps({ origin, shopId, published, path, openPreview }) {
  const href = storefrontUrl(origin, shopId, path);
  if (href === null) return {};
  if (published === true) return { href };
  return {
    href,
    onClick: (event) => {
      event?.preventDefault?.();
      openPreview(shopId, path);
    },
  };
}
