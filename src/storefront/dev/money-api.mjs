// The money routes of the storefront's DEV API (CP4 brief F2): checkout,
// payment, the receipt poll, the buyer's order, the withdrawal and the report,
// in the API's exact shapes (cloudflare/src/commerce/checkout.ts,
// commerce/receipts.ts, routes/receipts.ts, commerce/withdrawals.ts,
// routes/storefront-reports.ts). Rows of dev-api.mjs's ROUTES.
//
// INVENTED DATA ONLY (money-fixtures.json): no product, name or address of a
// real shop or a real person, nothing of the earlier brand. The buyer's order
// carries the recipient (D98, commerce/recipient.ts RecipientView) in the
// API's shape. The payment's client secret is an
// invented string: nothing here calls the payment provider.
//
// The dev server does not hand a handler the request's body or headers, so
// each answer is the fixture's, whatever was asked: the priced checkout is the
// fixture's lines and figures (not the cart's), the order is read with any
// token. A shop's fixture can name a REFUSAL per route, to look at the page's
// state for it:
//   "checkout":   "closed" (404) | "waiver_required" | "disclosure_outdated" (400)
//                 | "unpurchasable" (422) | "rate_limited" (429)
//   "payment":    "closed" (404) | "unavailable" (502)
//   "receipt":    "pending" (keeps polling → the 90 s state) | "issued" | "gone" (404)
//   "order":      "gone" (404)
//   "withdrawal": "not_found" (404) | "rate_limited" (429) | "personalized_exempt"
//                 | "window_passed" | "already_received"
//   "report":     "invalid" (400) | "rate_limited" (429)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// STOREFRONT_DEV_MONEY_FIXTURES: another fixture file (e.g. a scratch copy
// with a refusal set), read on every request like this one.
const FIXTURES =
  process.env.STOREFRONT_DEV_MONEY_FIXTURES || join(dirname(fileURLToPath(import.meta.url)), 'money-fixtures.json');

/** The money fixture of the shop the request names, or null. */
export function moneyFixture(url, file = FIXTURES) {
  const m = /^\/_api\/([a-z0-9][a-z0-9-]{0,62})\//.exec(url.pathname);
  if (!m) return null;
  const shops = JSON.parse(readFileSync(file, 'utf8')).shops;
  const shop = shops[m[1]];
  if (!shop) return null;
  return shop.extends ? { ...shops[shop.extends], ...shop, refusals: { ...shop.refusals } } : { ...shop, refusals: { ...shop.refusals } };
}

const json = (status, body, headers) => ({ status, body, headers });
const error = (status, code, message, headers) => json(status, { error: { code, message } }, headers);
const notFound = (message = 'Route not found') => error(404, 'not_found', message);
const rateLimited = () => error(429, 'rate_limited', 'Too many requests', { 'Retry-After': '60' });

function checkout(fixture) {
  switch (fixture.refusals.checkout) {
    case 'closed':
      return notFound('Checkout not found');
    case 'waiver_required':
    case 'disclosure_outdated':
      return error(400, `withdrawal_${fixture.refusals.checkout}`, 'The basket needs a consent the request did not give');
    case 'unpurchasable':
      return error(422, 'unprocessable', 'Request could not be processed');
    case 'rate_limited':
      return rateLimited();
    default:
      return json(201, { checkout: { ...fixture.checkout, expiresAt: Date.now() + 24 * 60 * 60 * 1000 } });
  }
}

function payment(fixture, checkoutId) {
  if (fixture.refusals.payment === 'closed' || checkoutId !== fixture.checkout.checkoutId) return notFound('Checkout not found');
  if (fixture.refusals.payment === 'unavailable') return error(502, 'payment_unavailable', 'Payment could not be prepared');
  return json(201, { payment: fixture.payment });
}

function receipt(fixture, checkoutId) {
  if (fixture.refusals.receipt === 'gone' || checkoutId !== fixture.checkout.checkoutId) return notFound('Order not found');
  if (fixture.refusals.receipt === 'pending') return json(200, { receipt: { status: 'pending' } });
  if (fixture.refusals.receipt === 'issued') return json(200, { receipt: { status: 'issued' } });
  return json(200, { receipt: { orderId: fixture.order.orderId, receiptToken: fixture.receiptToken, status: 'ready' } });
}

function order(fixture, orderId) {
  if (fixture.refusals.order === 'gone' || orderId !== fixture.order.orderId) return notFound('Order not found');
  return json(200, { order: fixture.order });
}

function withdrawal(fixture) {
  const answer = { ...fixture.withdrawal };
  switch (fixture.refusals.withdrawal) {
    case 'not_found':
      return notFound();
    case 'rate_limited':
      return rateLimited();
    case 'personalized_exempt':
    case 'window_passed':
      return json(201, { withdrawal: { ...answer, eligible: false, reason: fixture.refusals.withdrawal } });
    case 'already_received':
      return json(200, { withdrawal: { ...answer, alreadyReceived: true } });
    default:
      return json(201, { withdrawal: answer });
  }
}

function report(fixture) {
  if (fixture.refusals.report === 'invalid') return error(400, 'invalid_request', 'Request is not valid');
  if (fixture.refusals.report === 'rate_limited') return rateLimited();
  return json(201, { report: { reportId: fixture.reportId } });
}

const withFixture = (answer) => (_shop, url, segments) => {
  const fixture = moneyFixture(url);
  return fixture ? answer(fixture, ...segments) : notFound();
};

// [method, path pattern, handler(shop, url, segments)] — dev-api.mjs's row shape.
export const MONEY_ROUTES = [
  ['POST', '/v1/checkout', withFixture(checkout)],
  ['POST', '/v1/checkout/:id/payment', withFixture(payment)],
  ['POST', '/v1/checkout/:id/receipt', withFixture(receipt)],
  ['GET', '/v1/orders/:id', withFixture(order)],
  ['POST', '/v1/withdrawals', withFixture(withdrawal)],
  ['POST', '/v1/reports', withFixture(report)],
];
