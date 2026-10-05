// The reminder links of the storefront's DEV API (CP9-AC): the resume link and
// the unsubscribe, in the API's exact shapes
// (cloudflare/src/routes/storefront-checkout-recovery.ts). Rows of
// dev-api.mjs's ROUTES.
//
// INVENTED DATA ONLY. The answer is chosen by the token, so every state of the
// two pages can be looked at (`/<shop>/aterta/<token>`, `/<shop>/avregistrera/<token>`):
//   oppen   open: the shop's money fixture checkout lines (dev-api's catalogue
//           has them), plus one product that no longer exists (the toast)
//   klar    completed: the checkout became an order
//   borta   open, but no line exists any more (nothing to restore)
//   fel     502 (the pages' error state)
//   anything else: the one 404 (a link that does not work)
// The unsubscribe answers 200 for oppen, klar and borta, 502 for fel, else 404.

import { moneyFixture } from './money-api.mjs';

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const unavailable = () => json(502, { error: { code: 'unavailable', message: 'The shop could not be reached' } });

function lineRefs(url) {
  const items = moneyFixture(url)?.checkout?.items ?? [];
  return items.map(({ productId, quantity, variantId }) =>
    variantId ? { productId, quantity, variantId } : { productId, quantity },
  );
}

function resolve(_shop, url, [token]) {
  switch (token) {
    case 'oppen':
      return json(200, { recovery: { items: [...lineRefs(url), { productId: 'p-utgangen', quantity: 1 }], status: 'open' } });
    case 'klar':
      return json(200, { recovery: { status: 'completed' } });
    case 'borta':
      return json(200, { recovery: { items: [{ productId: 'p-utgangen', quantity: 1 }], status: 'open' } });
    case 'fel':
      return unavailable();
    default:
      return notFound();
  }
}

function unsubscribe(_shop, _url, [token]) {
  if (token === 'fel') return unavailable();
  return ['oppen', 'klar', 'borta'].includes(token) ? json(200, { unsubscribed: true }) : notFound();
}

// [method, path pattern, handler(shop, url, segments, options)] — dev-api.mjs's row shape.
export const RECOVERY_ROUTES = [
  ['POST', '/v1/checkout-recovery/:token', resolve],
  ['POST', '/v1/checkout-recovery/:token/unsubscribe', unsubscribe],
];
