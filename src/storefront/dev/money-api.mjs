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
// Each answer is the fixture's, whatever was asked: the priced checkout is the
// fixture's lines and figures (not the cart's), the order is read with any
// token. The one thing read from a request is the DISCOUNT CODE of the
// preview and the checkout (CP8-DC): a code in the shop's `discountCodes`
// table ({ "CODE": { "percentBp": 2000 } | { "valueMinor": 10000 } }) applies,
// worked out as the server does (ceil to the öre, a fixed amount clamped to
// the lines) against the preview's lines at the shop's dev prices, or the
// fixture checkout's or order's subtotal; any other code is the one "does not
// apply" answer. A shop's fixture can name a
// REFUSAL per route, to look at the page's state for it:
//   "checkout":   "closed" (404) | "waiver_required" | "disclosure_outdated" (400)
//                 | "unpurchasable" (422) | "rate_limited" (429)
//   "checkoutDiscount": "not_applied" (the checkout echoes the code with 0,
//                 as the server does for a race, the fee rule or the minimum)
//   "preview":    "rate_limited" (429) | "unavailable" (404)
//   "payment":    "closed" (404) | "unavailable" (502)
//   "receipt":    "pending" (keeps polling → the 90 s state) | "issued" | "gone" (404)
//   "order":      "gone" (404) | "discounted" (the order with the shop's first
//                 code and its amount)
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

// The server's shape rule for a code (cloudflare/src/commerce/discount-codes.ts).
const CODE_SHAPE = /^[^\s\u0000-\u001f\u007f-\u009f]{1,50}$/;

/** The VAT inside a total at the fixture's rate, rounded half up (shipping.ts vatMinor). */
function vatOf(totalMinor, rateBp) {
  return totalMinor - Math.round((totalMinor * 10_000) / (10_000 + rateBp));
}

/** What a code of the shop's table is worth against `baseMinor`, 0 when it names none. */
function codeAmount(fixture, code, baseMinor) {
  const terms = fixture.discountCodes?.[code];
  if (!terms || !Number.isSafeInteger(baseMinor) || baseMinor <= 0) return 0;
  if (Number.isSafeInteger(terms.percentBp)) return Math.ceil((baseMinor * terms.percentBp) / 10_000);
  return Number.isSafeInteger(terms.valueMinor) ? Math.min(terms.valueMinor, baseMinor) : 0;
}

/** The preview's lines at the dev shop's prices (fixtures.json), 0 for an unknown one. */
function linesMinor(shop, items) {
  return items.reduce((sum, item) => {
    const product = (shop.products ?? []).find((p) => p.productId === item?.productId);
    const variant = product?.variants?.find((v) => v.variantId === item?.variantId);
    const unit = variant?.priceMinor ?? product?.priceMinor ?? 0;
    return sum + unit * (Number.isSafeInteger(item?.quantity) ? item.quantity : 0);
  }, 0);
}

function discountPreview(fixture, body, shop) {
  if (fixture.refusals.preview === 'rate_limited') return rateLimited();
  if (fixture.refusals.preview === 'unavailable') return notFound();
  const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!CODE_SHAPE.test(code) || !Array.isArray(body?.items) || body.items.length === 0) {
    return error(400, 'invalid_request', 'Request is not valid');
  }
  const discountMinor = codeAmount(fixture, code, linesMinor(shop, body.items));
  return json(200, {
    discount: discountMinor > 0 ? { applies: true, code, discountMinor } : { applies: false, code, discountMinor: 0 },
  });
}

/** The fixture's checkout with the code of the request applied (or echoed with 0). */
function pricedCheckout(fixture, body) {
  const priced = { ...fixture.checkout, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  if (typeof body?.discountCode !== 'string') return priced;
  const code = body.discountCode.trim().toUpperCase();
  const discountMinor =
    fixture.refusals.checkoutDiscount === 'not_applied' ? 0 : codeAmount(fixture, code, priced.subtotalMinor);
  const totalMinor = priced.subtotalMinor + priced.shippingMinor - discountMinor;
  return { ...priced, discountCode: code, discountMinor, totalMinor, vatMinor: vatOf(totalMinor, priced.vatRateBp) };
}

function checkout(fixture, body) {
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
      return json(201, { checkout: pricedCheckout(fixture, body) });
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
  if (fixture.refusals.order === 'discounted') {
    const [code] = Object.keys(fixture.discountCodes ?? {});
    const totals = fixture.order.totals;
    const discountMinor = codeAmount(fixture, code, totals.subtotalMinor);
    const totalMinor = totals.subtotalMinor + totals.shippingMinor - discountMinor;
    return json(200, {
      order: {
        ...fixture.order,
        totals: { ...totals, discountCode: code ?? null, discountMinor, totalMinor, vatMinor: vatOf(totalMinor, 2_500) },
      },
    });
  }
  return json(200, { order: { ...fixture.order, totals: { discountCode: null, ...fixture.order.totals } } });
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

/** As withFixture, for a route that reads the write's body (and the shop's dev catalogue). */
const withFixtureBody = (answer) => (shop, url, _segments, options = {}) => {
  const fixture = moneyFixture(url);
  return fixture ? answer(fixture, options.body, shop) : notFound();
};

// [method, path pattern, handler(shop, url, segments, options)] — dev-api.mjs's row shape.
export const MONEY_ROUTES = [
  ['POST', '/v1/discount-codes/preview', withFixtureBody(discountPreview)],
  ['POST', '/v1/checkout', withFixtureBody(checkout)],
  ['POST', '/v1/checkout/:id/payment', withFixture(payment)],
  ['POST', '/v1/checkout/:id/receipt', withFixture(receipt)],
  ['GET', '/v1/orders/:id', withFixture(order)],
  ['POST', '/v1/withdrawals', withFixture(withdrawal)],
  ['POST', '/v1/reports', withFixture(report)],
];
