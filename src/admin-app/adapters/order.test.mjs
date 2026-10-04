// The order adapter, under Node:
//   node --test src/admin-app/adapters/order.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FULFILMENT_TRANSITIONS,
  badgeStatus,
  orderFromDetail,
  orderFromListRow,
  refusalMessage,
  statusOptionsOf,
} from './order.js';

const row = (over = {}) => ({
  orderId: 'o1',
  orderNumber: '20261003-AAAA',
  createdAt: '2026-10-03T08:00:00.000Z',
  paidAt: '2026-10-03T08:00:01.000Z',
  status: 'paid',
  fulfilment: 'unfulfilled',
  cancelledAt: null,
  deliveryMethod: 'shipping',
  totalMinor: 29950,
  currency: 'SEK',
  customerEmail: 'a@example.com',
  recipientName: 'Anna Exempel',
  pickupPlace: null,
  itemCount: 3,
  refundedMinor: 0,
  ...over,
});

describe('the badge: which track feeds the one status', () => {
  it('refunded wins over everything (a cancelled and refunded order reads refunded)', () => {
    assert.equal(badgeStatus(row({ status: 'refunded', fulfilment: 'shipped' })), 'refunded');
    assert.equal(badgeStatus(row({ status: 'refunded', cancelledAt: '2026-10-03T09:00:00.000Z' })), 'refunded');
  });
  it('then cancelled, over the fulfilment step', () => {
    assert.equal(badgeStatus(row({ cancelledAt: '2026-10-03T09:00:00.000Z', fulfilment: 'processing' })), 'cancelled');
    assert.equal(badgeStatus(row({ status: 'cancelled' })), 'cancelled');
    assert.equal(badgeStatus(row({ status: 'partially_refunded', cancelledAt: '2026-10-03T09:00:00.000Z' })), 'cancelled');
  });
  it('refunded to the charge counts as refunded (detail)', () => {
    assert.equal(badgeStatus({ status: 'partially_refunded', fulfilment: 'shipped', money: { chargedMinor: 100, refundedMinor: 100 } }), 'refunded');
  });
  it('a partial refund leaves the fulfilment step', () => {
    assert.equal(badgeStatus(row({ status: 'partially_refunded', fulfilment: 'shipped' })), 'shipped');
  });
  it('unfulfilled reads as confirmed, whatever the money', () => {
    assert.equal(badgeStatus(row()), 'confirmed');
    assert.equal(badgeStatus(row({ status: 'partially_refunded' })), 'confirmed');
  });
  it('otherwise the step', () => {
    for (const step of ['processing', 'shipped', 'ready_for_pickup', 'delivered', 'completed']) {
      assert.equal(badgeStatus(row({ fulfilment: step })), step);
    }
  });
});

describe('the status menu offers what the transition table allows', () => {
  it('parcel, unfulfilled: processing, shipped, cancel', () => {
    assert.deepEqual(statusOptionsOf(row()), ['processing', 'shipped', 'cancelled']);
  });
  it('pickup, unfulfilled: processing, ready_for_pickup, cancel', () => {
    assert.deepEqual(statusOptionsOf(row({ deliveryMethod: 'pickup' })), ['processing', 'ready_for_pickup', 'cancelled']);
  });
  it('processing: the next step of the method, cancel', () => {
    assert.deepEqual(statusOptionsOf(row({ fulfilment: 'processing' })), ['shipped', 'cancelled']);
    assert.deepEqual(statusOptionsOf(row({ fulfilment: 'processing', deliveryMethod: 'pickup' })), ['ready_for_pickup', 'cancelled']);
  });
  it('shipped: another parcel, delivered, completed; no cancel (a return case)', () => {
    assert.deepEqual(statusOptionsOf(row({ fulfilment: 'shipped' })), ['shipped', 'delivered', 'completed']);
  });
  it('ready_for_pickup → delivered, completed; delivered → completed; completed → nothing', () => {
    assert.deepEqual(statusOptionsOf(row({ fulfilment: 'ready_for_pickup', deliveryMethod: 'pickup' })), ['delivered', 'completed']);
    assert.deepEqual(statusOptionsOf(row({ fulfilment: 'delivered' })), ['completed']);
    assert.deepEqual(statusOptionsOf(row({ fulfilment: 'completed' })), []);
  });
  it('a closed order offers nothing; a partially refunded one stays open', () => {
    assert.deepEqual(statusOptionsOf(row({ status: 'refunded' })), []);
    assert.deepEqual(statusOptionsOf(row({ cancelledAt: '2026-10-03T09:00:00.000Z' })), []);
    assert.deepEqual(statusOptionsOf(row({ status: 'partially_refunded' })), ['processing', 'shipped', 'cancelled']);
  });
  it('never offers a step the Worker\'s table lacks, nor the wrong method\'s', () => {
    for (const from of Object.keys(FULFILMENT_TRANSITIONS)) {
      for (const deliveryMethod of ['shipping', 'pickup']) {
        for (const option of statusOptionsOf(row({ fulfilment: from, deliveryMethod }))) {
          if (option === 'cancelled') continue;
          assert.ok(FULFILMENT_TRANSITIONS[from].includes(option), `${from} → ${option}`);
          assert.notEqual(option, deliveryMethod === 'pickup' ? 'shipped' : 'ready_for_pickup');
        }
      }
    }
  });
});

describe('a list row', () => {
  it('kronor, a Timestamp, the badge, the page\'s fields', () => {
    const o = orderFromListRow(row({ deliveryMethod: 'pickup', pickupPlace: 'Butiken' }));
    assert.equal(o.id, 'o1');
    assert.equal(o.total, 299.5);
    assert.equal(o.createdAt.toDate().toISOString(), '2026-10-03T08:00:00.000Z');
    assert.equal(o.status, 'confirmed');
    assert.equal(o.moneyStatus, 'paid');
    assert.equal(o.source, 'b2c');
    assert.deepEqual(o.customerInfo, { email: 'a@example.com', name: 'Anna Exempel' });
    assert.deepEqual(o.pickupLocation, { name: 'Butiken' });
    assert.equal(o.itemCount, 3);
    assert.equal(o.items, undefined, 'no invented lines');
    assert.deepEqual(o.statusOptions, ['processing', 'ready_for_pickup', 'cancelled']);
  });
  it('no recipient (before 0045): no name', () => {
    assert.equal(orderFromListRow(row({ recipientName: null })).customerInfo.name, null);
  });
});

const DETAIL = {
  orderId: 'o2',
  orderNumber: '20261001-BBBB',
  createdAt: '2026-10-01T18:00:00.000Z',
  paidAt: '2026-10-01T18:00:05.000Z',
  status: 'partially_refunded',
  fulfilment: 'shipped',
  cancelledAt: null,
  currency: 'SEK',
  customerEmail: 'd@example.com',
  deliveryMethod: 'shipping',
  shippingCountry: 'SE',
  items: [
    { lineNo: 1, sku: 'TEE-S', name: 'T-shirt', variantLabel: 'S', quantity: 2, unitPriceMinor: 24900, lineTotalMinor: 49800, podState: 'none' },
    { lineNo: 2, sku: 'POD-1', name: 'Tryck', variantLabel: null, quantity: 1, unitPriceMinor: 10000, lineTotalMinor: 10000, podState: 'queued' },
  ],
  money: { chargedMinor: 64700, dispute: null, feeMinor: 1490, refundableMinor: 39800, refundedMinor: 24900, refundPendingMinor: 0 },
  payout: { amountMinor: 38310, eligibleAt: '2026-10-15T18:00:05.000Z', state: 'pending' },
  refunds: [],
  totals: { subtotalMinor: 59800, shippingMinor: 4900, discountMinor: 0, vatMinor: 12940, totalMinor: 64700 },
  consent: { marketing: false, recordedAt: '2026-10-01T17:59:00.000Z', terms: true, withdrawal: { disclosureVersion: 'v1', personalizedItems: [1], waived: true } },
  recipient: {
    deliveryMethod: 'shipping', name: 'David Prov', phone: '070', addressLine1: 'Gatan 4', addressLine2: null,
    postalCode: '444 44', city: 'Malmö', country: 'SE', pickupDate: null, pickupLocationAddress: null, pickupLocationId: null, pickupLocationName: null,
  },
  shipments: [{ trackingNumber: 'RR1SE', carrier: 'PostNord', createdAt: '2026-10-01T20:00:00.000Z' }],
  statusHistory: [
    { track: 'payment', from: null, to: 'paid', at: '2026-10-01T18:00:05.000Z', by: 'system', reason: null },
    { track: 'fulfilment', from: 'unfulfilled', to: 'shipped', at: '2026-10-01T20:00:00.000Z', by: 'platform', reason: null },
  ],
  withdrawal: { waived: true },
  withdrawalRequest: null,
};

describe('the detail', () => {
  const o = orderFromDetail(DETAIL);

  it('the badge and the options', () => {
    assert.equal(o.status, 'shipped');
    assert.deepEqual(o.statusOptions, ['shipped', 'delivered', 'completed']);
  });
  it('totals in kronor, as the server gave them', () => {
    assert.equal(o.subtotal, 598);
    assert.equal(o.shipping, 49);
    assert.equal(o.vat, 129.4);
    assert.equal(o.total, 647);
  });
  it('THE ONE NUMBER: the fee and the payout are the server\'s, untouched', () => {
    assert.deepEqual(o.connect, { isDestinationCharge: true, applicationFeeAmount: 1490 });
    assert.equal(o.serverPayoutSek, 383.1);
    assert.equal(o.payment.refundedTotalSek, 249);
    assert.equal(o.refundableMinor, 39800);
  });
  it('lines: unit price in kronor, the label, the POD state', () => {
    assert.deepEqual(o.items[0], { lineNo: 1, name: 'T-shirt', label: 'S', sku: 'TEE-S', quantity: 2, price: 249, lineTotal: 498, podState: 'none' });
    assert.equal(o.items[1].podState, 'queued');
  });
  it('the buyer and the address', () => {
    assert.equal(o.customerInfo.email, 'd@example.com');
    assert.equal(`${o.customerInfo.firstName} ${o.customerInfo.lastName}`.trim(), 'David Prov');
    assert.deepEqual(o.shippingInfo, { address: 'Gatan 4', apartment: '', postalCode: '444 44', city: 'Malmö', country: 'SE' });
    assert.equal(o.pickupLocation, null);
    assert.equal(o.trackingNumber, 'RR1SE');
  });
  it('a pickup order: the place and the date, no address', () => {
    const p = orderFromDetail({
      ...DETAIL,
      deliveryMethod: 'pickup',
      recipient: { ...DETAIL.recipient, deliveryMethod: 'pickup', pickupLocationName: 'Butiken', pickupLocationAddress: 'Testgatan 5', pickupDate: '2026-10-08' },
    });
    assert.equal(p.shippingInfo, null);
    assert.equal(p.pickupLocation.name, 'Butiken');
    assert.equal(p.pickupLocation.date, '2026-10-08');
  });
  it('the history: both tracks in the page\'s words, an actor kind, no id', () => {
    assert.deepEqual(o.statusHistory.map((h) => [h.from, h.to, h.displayName]), [
      ['pending', 'paid', 'System'],
      ['confirmed', 'shipped', 'Plattformen'],
    ]);
    assert.equal(o.statusHistory[0].changedAt.toDate().toISOString(), '2026-10-01T18:00:05.000Z');
  });
  it('the withdrawal consent card', () => {
    assert.deepEqual(o.withdrawal, { required: true, consent: true, noticeVersion: 'v1', consentAt: '2026-10-01T17:59:00.000Z' });
    assert.equal(orderFromDetail({ ...DETAIL, consent: null }).withdrawal, null);
  });
  it('names the campaign code of the discount (CP8-DC), null without one', () => {
    assert.equal(o.discountCode, null);
    const coded = orderFromDetail({ ...DETAIL, totals: { ...DETAIL.totals, discountCode: 'SOMMAR20', discountMinor: 5980, totalMinor: 58720 } });
    assert.equal(coded.discountCode, 'SOMMAR20');
    assert.equal(coded.discountAmount, 59.8);
    assert.equal(orderFromDetail({ ...DETAIL, totals: { ...DETAIL.totals, discountCode: '' } }).discountCode, null);
  });
  it('carries no field the seller must not see', () => {
    const text = JSON.stringify(o).toLowerCase();
    for (const word of ['commission', 'printer', 'supplier', 'jobref', 'production']) assert.ok(!text.includes(word), word);
  });
});

describe('refusals: a Swedish sentence each', () => {
  it('every fulfilment reason, the cancel and refund refusals', () => {
    for (const reason of ['order_closed', 'delivery_method', 'transition', 'tracking_required', 'printer_ships']) {
      assert.match(refusalMessage({ code: 'fulfilment_not_allowed', reason }), /\.$/);
    }
    assert.match(refusalMessage({ code: 'return_case' }), /retur/);
    assert.match(refusalMessage({ code: 'refund_not_allowed' }), /återbetalas/);
    assert.match(refusalMessage({ reason: 'printer_ships' }), /tryckeriet/);
  });
  it('an unknown error has none', () => {
    assert.equal(refusalMessage({ code: 'http_error' }), null);
    assert.equal(refusalMessage(null), null);
  });
});
