// The storefront response for the shop gate: the state of GET /v1/storefront
// (src/storefront/providers/Storefront.jsx `useStorefront()`) → the state
// ShopGate renders today (`{ status, shop }`, from `shops/{shopId}`). Pure;
// tested under Node (adapters.test.mjs).
//
//   loading    → 'checking'                     the gate's spinner
//   ready      → 'ok', an active published shop the page
//   not_found  → 'ok', a shop that is disabled   "Butiken är inte tillgänglig":
//                the API answers 404 alike for an unknown, a suspended and an
//                unpublished shop (brief F: such a shop shows what the gate
//                shows today for a shop that is not available)
//   no_shop    → 'unknown'                      the address names no shop:
//                the page the gate shows for it (the storefront's not-found
//                page, alias list)
//   error      → 'ok', no shop                  the API could not be reached:
//                the gate fails open, as it does today on a read error

export function toGateState(storefront) {
  switch (storefront?.status) {
    case 'loading':
      return { status: 'checking', shop: null };
    case 'ready':
      return { status: 'ok', shop: { status: 'active', published: true } };
    case 'not_found':
      return { status: 'ok', shop: { status: 'disabled' } };
    case 'no_shop':
      return { status: 'unknown', shop: null };
    default:
      return { status: 'ok', shop: null };
  }
}

/**
 * CP13: where "Logga in som affiliate" leads — the ADMIN host's sign-in page,
 * `<adminOrigin>/login`, from the storefront body's `adminOrigin` (the
 * canonical admin origin the API reports, or null). Never a hostname of its
 * own: no origin (or one that is not an http(s) origin) gives no link.
 */
export function affiliateLoginUrl(storefront) {
  const origin = storefront?.adminOrigin;
  if (typeof origin !== 'string' || origin === '') return null;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.origin}/login`;
}
