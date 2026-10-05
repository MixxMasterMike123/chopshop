// The checkout's money shapes, under Node:
//   node --test src/storefront/adapters/*.test.mjs
// Invented data only.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  buildCheckoutRequest,
  checkoutRefusal,
  minorToKronor,
  toApiDeliveryMethod,
  toApiRecipient,
  toCheckoutTotals,
} from './checkout.js';
import { ApiError } from '../../api/client.js';
import { createCheckout, createPayment } from '../../api/checkout.js';

// The keys the API's parser admits (cloudflare/src/commerce/checkout.ts
// CHECKOUT_KEYS and ITEM_KEYS, cloudflare/src/legal/consent.ts CONSENT_KEYS,
// cloudflare/src/commerce/recipient.ts SHIPPING_KEYS and PICKUP_KEYS).
// Any other key is a 400 there; a price key would be one.
const CHECKOUT_KEYS = ['consent', 'deliveryMethod', 'discountCode', 'email', 'idempotencyKey', 'items', 'recipient', 'shippingCountry'];
const SHIPPING_RECIPIENT_KEYS = ['addressLine1', 'addressLine2', 'city', 'country', 'name', 'phone', 'postalCode'];
const PICKUP_RECIPIENT_KEYS = ['name', 'phone', 'pickupDate', 'pickupLocationId'];

// What Checkout.jsx hands StripePaymentForm as `shippingInfo` (invented).
const SHIPPING_INFO = {
  country: 'SE',
  firstName: ' Testa ',
  lastName: 'Köpare',
  address: ' Provvägen 2 ',
  apartment: '',
  city: 'Teststad',
  postalCode: '123 45',
};
const ITEM_KEYS = ['productId', 'quantity', 'variantId'];
// = cloudflare/src/legal/consent.ts CONSENT_KEYS (CP9-AC added `reminder`).
const CONSENT_KEYS = ['disclosureVersion', 'marketing', 'reminder', 'terms', 'withdrawalWaiver'];

const LINES = [
  { productId: 'prod-a', quantity: 2, variantId: 'var-a-m' },
  { productId: 'prod-b', quantity: 1 },
];

const PRICED = {
  checkoutId: '0b0f5a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  currency: 'SEK',
  deliveryMethod: 'shipping',
  discountCode: null,
  discountMinor: 0,
  expiresAt: 1_900_000_000_000,
  items: [
    { itemIndex: 0, lineTotalMinor: 39_800, name: 'Testtröja', productId: 'prod-a', quantity: 2, sku: 'TT-M', unitPriceMinor: 19_900, variantId: 'var-a-m' },
    { itemIndex: 1, lineTotalMinor: 9_950, name: 'Testmugg', productId: 'prod-b', quantity: 1, sku: 'TM', unitPriceMinor: 9_950, variantId: null },
  ],
  shippingCountry: 'SE',
  shippingMinor: 5_800,
  subtotalMinor: 49_750,
  totalMinor: 55_550,
  vatMinor: 11_110,
  vatRateBp: 2_500,
};

describe('buildCheckoutRequest', () => {
  it('sends products, variants and quantities, and never a price', () => {
    const request = buildCheckoutRequest({
      items: LINES,
      email: '  kund@example.test ',
      deliveryMethod: 'home',
      shippingCountry: 'se',
      shippingInfo: SHIPPING_INFO,
      marketing: false,
      withdrawal: { required: false, accepted: null, noticeVersion: 'v1-2026-06' },
    });
    assert.deepEqual(request, {
      consent: { marketing: false, terms: true },
      deliveryMethod: 'shipping',
      email: 'kund@example.test',
      items: [
        { productId: 'prod-a', quantity: 2, variantId: 'var-a-m' },
        { productId: 'prod-b', quantity: 1 },
      ],
      recipient: {
        addressLine1: 'Provvägen 2',
        city: 'Teststad',
        country: 'SE',
        name: 'Testa Köpare',
        postalCode: '123 45',
      },
      shippingCountry: 'SE',
    });
    for (const key of Object.keys(request.recipient)) assert.ok(SHIPPING_RECIPIENT_KEYS.includes(key), key);
    for (const key of Object.keys(request)) assert.ok(CHECKOUT_KEYS.includes(key), key);
    for (const item of request.items) for (const key of Object.keys(item)) assert.ok(ITEM_KEYS.includes(key), key);
    for (const key of Object.keys(request.consent)) assert.ok(CONSENT_KEYS.includes(key), key);
    assert.ok(!JSON.stringify(request).match(/price|total|vat|shipping(Minor|Cost)|discount/i));
  });

  it('drops whatever else a cart line carries', () => {
    const request = buildCheckoutRequest({
      items: [{ productId: 'prod-a', quantity: 1, variantId: null, price: 1, name: 'x', sku: 'y' }],
      email: 'kund@example.test',
      deliveryMethod: 'home',
      shippingCountry: 'SE',
    });
    assert.deepEqual(request.items, [{ productId: 'prod-a', quantity: 1 }]);
  });

  it('sends no country for a collected order', () => {
    const request = buildCheckoutRequest({
      items: LINES,
      email: 'kund@example.test',
      deliveryMethod: 'pickup',
      shippingCountry: 'SE',
      marketing: true,
    });
    assert.equal(request.deliveryMethod, 'pickup');
    assert.equal('shippingCountry' in request, false);
    assert.deepEqual(request.consent, { marketing: true, terms: true });
  });

  it('sends the waiver and the version of the text shown only when the gate was required AND ticked', () => {
    const base = { items: LINES, email: 'kund@example.test', deliveryMethod: 'home', shippingCountry: 'SE' };
    const ticked = buildCheckoutRequest({ ...base, withdrawal: { required: true, accepted: true, noticeVersion: 'v1-2026-06' } });
    assert.deepEqual(ticked.consent, {
      disclosureVersion: 'v1-2026-06',
      marketing: false,
      terms: true,
      withdrawalWaiver: true,
    });
    for (const withdrawal of [
      { required: true, accepted: false, noticeVersion: 'v1-2026-06' },
      { required: false, accepted: true, noticeVersion: 'v1-2026-06' },
      { required: false, accepted: null, noticeVersion: 'v1-2026-06' },
      undefined,
    ]) {
      assert.deepEqual(buildCheckoutRequest({ ...base, withdrawal }).consent, { marketing: false, terms: true });
    }
  });

  it('is what the client sends, byte for byte, with the idempotency key beside it', async () => {
    const realFetch = globalThis.fetch;
    globalThis.location = { pathname: '/testbutik/checkout' };
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ checkout: PRICED }), { status: 201 });
    };
    try {
      const request = buildCheckoutRequest({
        items: LINES,
        email: 'kund@example.test',
        deliveryMethod: 'home',
        shippingCountry: 'SE',
        shippingInfo: SHIPPING_INFO,
        withdrawal: { required: true, accepted: true, noticeVersion: 'v1-2026-06' },
      });
      assert.equal(request.recipient.name, 'Testa Köpare');
      const { checkout, replayed } = await createCheckout({ ...request, idempotencyKey: 'key-0001' });
      assert.equal(sent.url, '/_api/testbutik/v1/checkout');
      assert.deepEqual(sent.body, { ...request, idempotencyKey: 'key-0001' });
      assert.equal(checkout.totalMinor, 55_550);
      assert.equal(replayed, false);
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.location;
    }
  });
});

describe('buildCheckoutRequest: the cart\'s discount code (CP8-DC)', () => {
  const base = { items: LINES, email: 'kund@example.test', deliveryMethod: 'pickup', shippingCountry: 'SE' };

  it('sends the code the cart holds, trimmed, as the one key the server takes for it', () => {
    const request = buildCheckoutRequest({ ...base, discountCode: ' SOMMAR20 ' });
    assert.equal(request.discountCode, 'SOMMAR20');
    for (const key of Object.keys(request)) assert.ok(CHECKOUT_KEYS.includes(key), key);
  });

  it('sends no code, and the same request as before, without one', () => {
    const without = buildCheckoutRequest(base);
    for (const discountCode of [undefined, null, '', '   ', 20, { code: 'X' }]) {
      const request = buildCheckoutRequest({ ...base, discountCode });
      assert.equal('discountCode' in request, false, String(discountCode));
      assert.equal(JSON.stringify(request), JSON.stringify(without));
    }
  });

  it('the client sends it, and leaves it out when there is none', async () => {
    const realFetch = globalThis.fetch;
    globalThis.location = { pathname: '/testbutik/checkout' };
    const bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ checkout: { ...PRICED, discountCode: 'SOMMAR20' } }), { status: 201 });
    };
    try {
      await createCheckout({ ...buildCheckoutRequest({ ...base, discountCode: 'SOMMAR20' }), idempotencyKey: 'key-0002' });
      await createCheckout({ ...buildCheckoutRequest(base), idempotencyKey: 'key-0003' });
      assert.equal(bodies[0].discountCode, 'SOMMAR20');
      assert.equal('discountCode' in bodies[1], false);
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.location;
    }
  });
});

describe('buildCheckoutRequest: the reminder box (CP9-AC)', () => {
  const base = { items: LINES, email: 'kund@example.test', deliveryMethod: 'pickup', shippingCountry: 'SE', marketing: false };

  it('sends `consent.reminder: true` only when the box was ticked', () => {
    const request = buildCheckoutRequest({ ...base, reminder: true });
    assert.deepEqual(request.consent, { marketing: false, reminder: true, terms: true });
    for (const key of Object.keys(request.consent)) assert.ok(CONSENT_KEYS.includes(key), key);
  });

  it('sends no reminder key, and the same request as before, unless it is literally true', () => {
    const before = buildCheckoutRequest(base);
    for (const reminder of [undefined, null, false, 'true', 1, {}, []]) {
      const request = buildCheckoutRequest({ ...base, reminder });
      assert.equal('reminder' in request.consent, false, String(reminder));
      assert.equal(JSON.stringify(request), JSON.stringify(before));
    }
  });

  it('never takes it from another box: marketing ticked is marketing only', () => {
    const request = buildCheckoutRequest({ ...base, marketing: true });
    assert.deepEqual(request.consent, { marketing: true, terms: true });
  });
});

describe('toApiRecipient (D98)', () => {
  it('a parcel: the name is first + last name, the texts trimmed, an empty second line left out, the country the shipping country', () => {
    assert.deepEqual(
      toApiRecipient({ deliveryMethod: 'home', shippingCountry: 'no', shippingInfo: { ...SHIPPING_INFO, apartment: ' Lgh 3 ', phone: ' 070-1 ' } }),
      {
        addressLine1: 'Provvägen 2',
        addressLine2: 'Lgh 3',
        city: 'Teststad',
        country: 'NO',
        name: 'Testa Köpare',
        phone: '070-1',
        postalCode: '123 45',
      },
    );
  });

  it('a pickup: the name and the chosen occasion, never an address', () => {
    const withDate = toApiRecipient({
      deliveryMethod: 'pickup',
      shippingCountry: 'SE',
      shippingInfo: { ...SHIPPING_INFO, address: '', city: '', postalCode: '' },
      pickupLocationId: 'plats-1',
      pickupDate: '2026-10-01',
    });
    assert.deepEqual(withDate, { name: 'Testa Köpare', pickupDate: '2026-10-01', pickupLocationId: 'plats-1' });
    for (const key of Object.keys(withDate)) assert.ok(PICKUP_RECIPIENT_KEYS.includes(key), key);

    assert.deepEqual(
      toApiRecipient({ deliveryMethod: 'pickup', shippingInfo: SHIPPING_INFO, pickupLocationId: 'plats-2', pickupDate: '' }),
      { name: 'Testa Köpare', pickupLocationId: 'plats-2' },
    );
  });

  it('a pickup request carries it beside no country', () => {
    const request = buildCheckoutRequest({
      items: LINES,
      email: 'kund@example.test',
      deliveryMethod: 'pickup',
      shippingCountry: 'SE',
      shippingInfo: SHIPPING_INFO,
      pickupLocationId: 'plats-1',
    });
    assert.equal('shippingCountry' in request, false);
    assert.deepEqual(request.recipient, { name: 'Testa Köpare', pickupLocationId: 'plats-1' });
  });

  it('invents nothing: a form without a name sends an empty one, for the server to refuse', () => {
    assert.equal(toApiRecipient({ deliveryMethod: 'pickup', pickupLocationId: 'p' }).name, '');
  });
});

describe('toApiDeliveryMethod', () => {
  it("names the page's 'home' as the API's 'shipping'", () => {
    assert.equal(toApiDeliveryMethod('home'), 'shipping');
    assert.equal(toApiDeliveryMethod('pickup'), 'pickup');
    assert.equal(toApiDeliveryMethod(undefined), 'shipping');
  });
});

describe('toCheckoutTotals', () => {
  it("prints the server's figures, in kronor, and computes none", () => {
    assert.deepEqual(toCheckoutTotals(PRICED, 0.25), {
      subtotal: 497.5,
      shipping: 58,
      vat: 111.1,
      total: 555.5,
      vatRate: 0.25,
      discountAmount: 0,
      discountCode: null,
      discountPercentage: 0,
      discountSource: null,
    });
  });

  it('takes the rate from the server, not from the page', () => {
    assert.equal(toCheckoutTotals({ ...PRICED, vatRateBp: 1_200 }, 0.25).vatRate, 0.12);
    assert.equal(toCheckoutTotals({ ...PRICED, vatRateBp: 0, vatMinor: 0 }, 0.25).vatRate, 0);
  });

  it('shows no figure at all before the server has priced the order', () => {
    const totals = toCheckoutTotals(null, 0.25);
    assert.equal(totals.subtotal, null);
    assert.equal(totals.shipping, null);
    assert.equal(totals.vat, null);
    assert.equal(totals.total, null);
    assert.equal(totals.vatRate, 0.25);
    assert.equal(totals.discountAmount, 0);
  });

  it('never invents a figure from a field that is not a whole number of öre', () => {
    const totals = toCheckoutTotals({ ...PRICED, totalMinor: '55550', vatMinor: 1.5 }, 0.25);
    assert.equal(totals.total, null);
    assert.equal(totals.vat, null);
    assert.equal(minorToKronor(undefined), null);
    assert.equal(minorToKronor(0), 0);
  });
});

describe('checkoutRefusal', () => {
  const refusal = (status, code) => checkoutRefusal(new ApiError({ status, code, message: 'x' }));

  it('names each refusal of the checkout and payment routes', () => {
    assert.equal(refusal(400, 'withdrawal_waiver_required'), 'waiver_required');
    assert.equal(refusal(400, 'withdrawal_disclosure_outdated'), 'disclosure_outdated');
    assert.equal(refusal(404, 'not_found'), 'closed');
    assert.equal(refusal(422, 'unprocessable'), 'unpurchasable');
    assert.equal(refusal(409, 'conflict'), 'conflict');
    assert.equal(refusal(429, 'rate_limited'), 'rate_limited');
    assert.equal(refusal(400, 'invalid_request'), 'other');
    assert.equal(refusal(502, 'payment_unavailable'), 'other');
    assert.equal(refusal(0, 'network_error'), 'other');
    assert.equal(checkoutRefusal(new Error('x')), 'other');
    assert.equal(checkoutRefusal(undefined), 'other');
  });
});

describe('the payment of a priced checkout', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.location = { pathname: '/testbutik/checkout' };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete globalThis.location;
  });

  it('asks for the payment by the checkout id alone, with no body', async () => {
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({ payment: { clientSecret: 'pi_test_0001_secret_0001', paymentIntentId: 'pi_test_0001' } }),
        { status: 201 },
      );
    };
    const payment = await createPayment(PRICED.checkoutId);
    assert.equal(seen.url, `/_api/testbutik/v1/checkout/${PRICED.checkoutId}/payment`);
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.body, undefined);
    assert.deepEqual(payment, { clientSecret: 'pi_test_0001_secret_0001', paymentIntentId: 'pi_test_0001', created: true });
  });
});
