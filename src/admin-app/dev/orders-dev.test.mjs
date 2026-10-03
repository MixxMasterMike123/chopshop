// The dev API's order routes (unit FD), under Node:
//   node --test src/admin-app/dev/orders-dev.test.mjs
// They answer in the Worker's shapes, with its refusals; the adapter reads
// them as the pages will.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';
import { orderFromDetail, orderFromListRow } from '../adapters/order.js';

const call = (state, method, path, { headers = {}, body = null } = {}) =>
  route(state, method, new URL(path, 'http://dev.invalid'), headers, body);

function admin() {
  const state = createState();
  const answer = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'admin@example.com', password: 'dev-password-1' } });
  const cookie = answer.setCookie.split(';')[0];
  const headers = (extra = {}) => ({ cookie, 'x-shop-id': 'test-shop-a', ...extra });
  return { state, headers };
}

const key = () => crypto.randomUUID();
const PARCEL = '0a000000-0000-4000-8000-000000000001';
const PICKUP = '0a000000-0000-4000-8000-000000000002';
const POD = '0a000000-0000-4000-8000-000000000003';
const CANCELLED = '0a000000-0000-4000-8000-000000000005';
const SHIPPED = '0a000000-0000-4000-8000-000000000004';

describe('the order list', () => {
  it('newest first, window counters, and the adapter reads every row', () => {
    const { state, headers } = admin();
    const list = call(state, 'GET', '/_api/v1/admin/orders', { headers: headers() });
    assert.equal(list.status, 200);
    assert.equal(list.body.count, list.body.orders.length);
    const times = list.body.orders.map((o) => Date.parse(o.createdAt));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    for (const row of list.body.orders) assert.ok(orderFromListRow(row).id);
  });

  it('pages by the cursor', () => {
    const { state, headers } = admin();
    const first = call(state, 'GET', '/_api/v1/admin/orders?limit=4', { headers: headers() });
    const second = call(state, 'GET', `/_api/v1/admin/orders?limit=4&cursor=${first.body.nextCursor}`, { headers: headers() });
    assert.equal(first.body.orders.length, 4);
    assert.ok(second.body.orders.length > 0);
    assert.equal(new Set([...first.body.orders, ...second.body.orders].map((o) => o.orderId)).size, first.body.orders.length + second.body.orders.length);
  });

  it('q: an e-mail address exactly, an order number prefix; other text is a 400', () => {
    const { state, headers } = admin();
    assert.equal(call(state, 'GET', '/_api/v1/admin/orders?q=BO.PROV@example.com', { headers: headers() }).body.count, 1);
    assert.equal(call(state, 'GET', '/_api/v1/admin/orders?q=20261002', { headers: headers() }).body.count, 2);
    assert.equal(call(state, 'GET', '/_api/v1/admin/orders?q=Bo%20Prov', { headers: headers() }).status, 400);
  });

  it('the empty shop (cookie)', () => {
    const { state, headers } = admin();
    const list = call(state, 'GET', '/_api/v1/admin/orders', { headers: headers({ cookie: `${headers().cookie}; admin_dev_orders=empty` }) });
    assert.deepEqual([list.body.orders.length, list.body.count, list.body.totalMinor], [0, 0, 0]);
  });

  it('no shop header: the opaque 404', () => {
    const { state, headers } = admin();
    assert.equal(call(state, 'GET', '/_api/v1/admin/orders', { headers: { cookie: headers().cookie } }).status, 404);
  });
});

describe('fulfilment, as the Worker decides it', () => {
  const step = (ctx, id, body, k = key()) =>
    call(ctx.state, 'POST', `/_api/v1/admin/orders/${id}/fulfilment`, { headers: ctx.headers({ 'idempotency-key': k }), body });

  it('a parcel walks processing → shipped (with a shipment) → delivered → completed', () => {
    const ctx = admin();
    assert.equal(step(ctx, PARCEL, { to: 'processing' }).status, 200);
    assert.equal(step(ctx, PARCEL, { to: 'shipped', trackingNumber: 'RR9SE' }).body.fulfilment.shipment.trackingNumber, 'RR9SE');
    assert.equal(step(ctx, PARCEL, { to: 'delivered' }).status, 200);
    assert.equal(step(ctx, PARCEL, { to: 'completed' }).status, 200);
    const detail = orderFromDetail(call(ctx.state, 'GET', `/_api/v1/admin/orders/${PARCEL}`, { headers: ctx.headers() }).body.order);
    assert.equal(detail.status, 'completed');
    assert.deepEqual(detail.statusOptions, []);
    assert.equal(detail.trackingNumber, 'RR9SE');
  });

  it('the refusals', () => {
    const ctx = admin();
    const reason = (id, body) => step(ctx, id, body).body.error?.reason;
    assert.equal(reason(PICKUP, { to: 'shipped' }), 'delivery_method');
    assert.equal(reason(PARCEL, { to: 'ready_for_pickup' }), 'delivery_method');
    assert.equal(reason(PARCEL, { to: 'completed' }), 'transition');
    assert.equal(reason(SHIPPED, { to: 'shipped' }), 'tracking_required');
    assert.equal(reason(POD, { to: 'shipped' }), 'printer_ships');
    assert.equal(reason(CANCELLED, { to: 'processing' }), 'order_closed');
    assert.equal(step(ctx, POD, { to: 'processing' }).status, 200, 'processing stays open to a POD order');
  });

  it('the key: required; the same key and body replay; another body is a conflict', () => {
    const ctx = admin();
    assert.equal(call(ctx.state, 'POST', `/_api/v1/admin/orders/${PARCEL}/fulfilment`, { headers: ctx.headers(), body: { to: 'processing' } }).body.error.code, 'idempotency_key_required');
    const k = key();
    const first = step(ctx, PARCEL, { to: 'processing' }, k);
    assert.deepEqual(step(ctx, PARCEL, { to: 'processing' }, k).body, first.body);
    assert.equal(step(ctx, PARCEL, { to: 'shipped' }, k).body.error.code, 'conflict');
  });
});

describe('refund and cancel', () => {
  it('a full refund closes the order; the badge reads refunded and the menu offers nothing', () => {
    const ctx = admin();
    const before = call(ctx.state, 'GET', `/_api/v1/admin/orders/${PARCEL}`, { headers: ctx.headers() }).body.order;
    const refund = call(ctx.state, 'POST', `/_api/v1/admin/orders/${PARCEL}/refunds`, {
      headers: ctx.headers({ 'idempotency-key': key() }),
      body: { amountMinor: before.money.refundableMinor, reason: 'x' },
    });
    assert.equal(refund.status, 201);
    const after = orderFromDetail(call(ctx.state, 'GET', `/_api/v1/admin/orders/${PARCEL}`, { headers: ctx.headers() }).body.order);
    assert.equal(after.status, 'refunded');
    assert.deepEqual(after.statusOptions, []);
    assert.equal(after.refundableMinor, 0);
  });

  it('cancel: open order → cancelled; a shipped order is a return case', () => {
    const ctx = admin();
    const cancel = (id) => call(ctx.state, 'POST', `/_api/v1/admin/orders/${id}/cancel`, { headers: ctx.headers(), body: { reason: 'x' } });
    assert.equal(cancel(PARCEL).status, 200);
    assert.equal(orderFromDetail(call(ctx.state, 'GET', `/_api/v1/admin/orders/${PARCEL}`, { headers: ctx.headers() }).body.order).status, 'cancelled');
    assert.equal(cancel(SHIPPED).body.error.code, 'return_case');
  });
});
