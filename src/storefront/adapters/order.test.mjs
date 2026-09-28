// The buyer's order and the confirmation's source, under Node:
//   node --test src/storefront/adapters/*.test.mjs
// Invented data only.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { confirmationSource, toPageOrder } from './order.js';
import { loadPendingCheckout, loadReceiptToken, savePendingCheckout, saveReceiptToken } from '../../api/orders.js';

// The allowlisted buyer schema (cloudflare/src/commerce/receipts.ts BuyerOrder).
const BUYER_ORDER = {
  createdAt: '2026-09-28T10:15:30.000Z',
  currency: 'SEK',
  delivery: { country: 'SE', method: 'shipping' },
  email: 'k***@example.test',
  items: [
    { lineTotalMinor: 39_800, name: 'Testtröja', quantity: 2, unitPriceMinor: 19_900 },
    { lineTotalMinor: 9_950, name: 'Testmugg', quantity: 1, unitPriceMinor: 9_950 },
  ],
  orderId: '4f1c2b3a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  orderNumber: '20260928-ABCD2345',
  status: 'paid',
  totals: { discountMinor: 0, shippingMinor: 5_800, subtotalMinor: 49_750, totalMinor: 55_550, vatMinor: 11_110 },
  withdrawal: { waived: false },
};

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    keys: () => [...store.keys()],
  };
}

describe('toPageOrder', () => {
  it('turns the buyer order into the fields the page reads, figures in kronor from the server', () => {
    assert.deepEqual(toPageOrder(BUYER_ORDER), {
      id: BUYER_ORDER.orderId,
      orderNumber: '20260928-ABCD2345',
      status: 'paid',
      createdAt: { seconds: Date.parse('2026-09-28T10:15:30.000Z') / 1000 },
      payment: { status: 'paid' },
      customerInfo: { email: 'k***@example.test' },
      deliveryMethod: 'home',
      shippingInfo: { country: 'SE' },
      items: [
        { name: 'Testtröja', quantity: 2, price: 199 },
        { name: 'Testmugg', quantity: 1, price: 99.5 },
      ],
      subtotal: 497.5,
      shipping: 58,
      discountAmount: 0,
      vat: 111.1,
      total: 555.5,
      withdrawal: { waived: false },
    });
  });

  it('a line total the page prints (price × quantity) is the server\'s line total', () => {
    const page = toPageOrder(BUYER_ORDER);
    page.items.forEach((item, index) => {
      assert.equal(Math.round(item.price * item.quantity * 100), BUYER_ORDER.items[index].lineTotalMinor);
    });
  });

  it('a collected order has no address to print', () => {
    const page = toPageOrder({ ...BUYER_ORDER, delivery: { country: null, method: 'pickup' } });
    assert.equal(page.deliveryMethod, 'pickup');
    assert.deepEqual(page.shippingInfo, {});
  });

  it('without a recipient, carries nothing the buyer schema does not hold (no name, address, image, label, marketing)', () => {
    const page = toPageOrder(BUYER_ORDER);
    assert.equal(page.customerInfo.firstName, undefined);
    assert.equal(page.customerInfo.marketingOptIn, undefined);
    assert.equal(page.shippingInfo.address, undefined);
    assert.equal(page.pickupLocation, undefined);
    assert.equal(page.items[0].image, undefined);
    assert.equal(page.items[0].label, undefined);
    assert.equal(page.affiliateCode, undefined);
  });

  // D98: the recipient (cloudflare/src/commerce/recipient.ts RecipientView).
  const NONE = {
    addressLine1: null,
    addressLine2: null,
    city: null,
    country: null,
    phone: null,
    pickupDate: null,
    pickupLocationAddress: null,
    pickupLocationId: null,
    pickupLocationName: null,
    postalCode: null,
  };

  it("a shipped order's recipient: the name and the address where the page prints them", () => {
    const page = toPageOrder({
      ...BUYER_ORDER,
      recipient: {
        ...NONE,
        addressLine1: 'Provvägen 2',
        addressLine2: 'Lgh 3',
        city: 'Teststad',
        country: 'SE',
        deliveryMethod: 'shipping',
        name: 'Testa Köpare',
        postalCode: '123 45',
      },
    });
    assert.deepEqual(page.shippingInfo, {
      firstName: 'Testa Köpare',
      lastName: '',
      address: 'Provvägen 2',
      apartment: 'Lgh 3',
      postalCode: '123 45',
      city: 'Teststad',
      country: 'SE',
    });
    assert.equal(page.pickupLocation, undefined);
    assert.deepEqual(page.customerInfo, { email: 'k***@example.test' });
  });

  it("a collected order's recipient: the name, and the place as it was at checkout, with the date", () => {
    const page = toPageOrder({
      ...BUYER_ORDER,
      delivery: { country: null, method: 'pickup' },
      recipient: {
        ...NONE,
        deliveryMethod: 'pickup',
        name: 'Testa Köpare',
        pickupDate: '2026-10-01',
        pickupLocationAddress: 'Hämtvägen 3, 111 22 Hämtby',
        pickupLocationId: 'plats-1',
        pickupLocationName: 'Lördagsutlämningen',
      },
    });
    assert.equal(page.deliveryMethod, 'pickup');
    assert.deepEqual(page.shippingInfo, { firstName: 'Testa Köpare', lastName: '' });
    assert.deepEqual(page.pickupLocation, {
      id: 'plats-1',
      name: 'Lördagsutlämningen',
      address: 'Hämtvägen 3, 111 22 Hämtby',
      date: '2026-10-01',
    });
  });

  it('an order made before the recipient existed (recipient null) is shown as before', () => {
    assert.deepEqual(toPageOrder({ ...BUYER_ORDER, recipient: null }), toPageOrder(BUYER_ORDER));
  });

  it('is null for no order, and a time it cannot read is no time', () => {
    assert.equal(toPageOrder(null), null);
    assert.equal(toPageOrder(undefined), null);
    assert.equal(toPageOrder({ ...BUYER_ORDER, createdAt: 'nonsense' }).createdAt, null);
  });
});

describe('the confirmation page: what it reads for its address', () => {
  beforeEach(() => {
    globalThis.sessionStorage = memoryStorage();
  });
  afterEach(() => {
    delete globalThis.sessionStorage;
  });

  const loaders = { loadReceiptToken, loadPendingCheckout };

  it("waits for the checkout of a payment this tab started", () => {
    savePendingCheckout('pi_test_0001', 'checkout-0001');
    assert.deepEqual(confirmationSource('pi_test_0001', loaders), { kind: 'checkout', checkoutId: 'checkout-0001' });
  });

  it('reads the order when this tab holds its receipt token', () => {
    saveReceiptToken(BUYER_ORDER.orderId, 'T'.repeat(43));
    assert.deepEqual(confirmationSource(BUYER_ORDER.orderId, loaders), {
      kind: 'order',
      orderId: BUYER_ORDER.orderId,
      token: 'T'.repeat(43),
    });
  });

  it('has nothing to read for an address this tab knows nothing of', () => {
    assert.deepEqual(confirmationSource('pi_other', loaders), { kind: 'none' });
    assert.deepEqual(confirmationSource('', loaders), { kind: 'none' });
    assert.deepEqual(confirmationSource(undefined, loaders), { kind: 'none' });
  });

  it('keeps the checkout id and the token in session storage only, under keys that name no person', () => {
    const local = memoryStorage();
    globalThis.localStorage = local;
    try {
      savePendingCheckout('pi_test_0002', 'checkout-0002');
      saveReceiptToken('order-0002', 'U'.repeat(43));
      assert.deepEqual(local.keys(), []);
      assert.deepEqual(globalThis.sessionStorage.keys().sort(), ['pending-checkout:pi_test_0002', 'receipt-token:order-0002']);
    } finally {
      delete globalThis.localStorage;
    }
  });

  it('a storage that refuses is survived: nothing is found, nothing throws', () => {
    globalThis.sessionStorage = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    };
    savePendingCheckout('pi_test_0003', 'checkout-0003');
    assert.equal(loadPendingCheckout('pi_test_0003'), null);
    assert.deepEqual(confirmationSource('pi_test_0003', loaders), { kind: 'none' });
  });
});
