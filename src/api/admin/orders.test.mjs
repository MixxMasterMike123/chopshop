// The order calls, under Node:
//   node --test src/api/admin/orders.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import {
  cancelOrder,
  changeFulfilment,
  getOrder,
  listAllOrders,
  listOrders,
  refundOrder,
  searchQueryOf,
} from './orders.js';

const realFetch = globalThis.fetch;
let calls;

const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const header = (call, name) => call.init.headers[name.toLowerCase()];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = '0a000000-0000-4000-8000-000000000001';

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
}

beforeEach(() => {
  calls = [];
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('searchQueryOf: what the route can search', () => {
  it('an e-mail address, exact and lower-cased', () => {
    assert.equal(searchQueryOf('  Anna@Example.com '), 'anna@example.com');
  });
  it('an order number prefix', () => {
    assert.equal(searchQueryOf('20261003-a1'), '20261003-a1');
  });
  it('a name or a part of one, trimmed, as the Worker\'s grammar has it', () => {
    assert.equal(searchQueryOf('  Anna Exempel '), 'Anna Exempel');
    assert.equal(searchQueryOf('Åsa Öberg-Lund'), 'Åsa Öberg-Lund');
    assert.equal(searchQueryOf("O'Brien"), "O'Brien");
    assert.equal(searchQueryOf('O’Brien Jr.'), 'O’Brien Jr.');
    assert.equal(searchQueryOf('e\u0301va'), 'e\u0301va');
    assert.equal(searchQueryOf('a'.repeat(100)), 'a'.repeat(100));
  });
  it('nothing else: a broken address, characters outside the grammar, empty or too long text', () => {
    assert.equal(searchQueryOf('anna@'), null);
    assert.equal(searchQueryOf('   '), null);
    assert.equal(searchQueryOf(undefined), null);
    for (const bad of ['50%', 'a_b', 'a\\b', '<script>', 'a,b', 'a'.repeat(101)]) assert.equal(searchQueryOf(bad), null, bad);
  });
});

describe('the list', () => {
  it('maps the filters onto the query, with X-Shop-Id', async () => {
    stubFetch(() => answer(200, { orders: [], nextCursor: null, count: 0, totalMinor: 0 }));
    await listOrders({ status: 'paid', fulfilment: 'shipped', since: '2026-10-01T00:00:00.000Z', q: 'a@example.com', limit: 10, until: null });
    assert.equal(
      calls[0].url,
      '/_api/v1/admin/orders?status=paid&fulfilment=shipped&since=2026-10-01T00%3A00%3A00.000Z&q=a%40example.com&limit=10',
    );
    assert.equal(header(calls[0], 'X-Shop-Id'), 'test-shop-a');
    assert.equal(calls[0].init.method, 'GET');
  });

  it('walks every page by the cursor; count and totalMinor are the first answer\'s', async () => {
    stubFetch((url) => {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      if (cursor === null) return answer(200, { orders: [{ orderId: '1' }, { orderId: '2' }], nextCursor: 'c1', count: 3, totalMinor: 900 });
      return answer(200, { orders: [{ orderId: '3' }], nextCursor: null, count: 3, totalMinor: 900 });
    });
    const all = await listAllOrders();
    assert.deepEqual(all.orders.map((o) => o.orderId), ['1', '2', '3']);
    assert.equal(all.count, 3);
    assert.equal(all.totalMinor, 900);
    assert.equal(all.truncated, false);
    assert.match(calls[0].url, /limit=100/);
    assert.match(calls[1].url, /cursor=c1/);
  });

  it('stops at maxPages and says so', async () => {
    stubFetch(() => answer(200, { orders: [{ orderId: 'x' }], nextCursor: 'more', count: 9, totalMinor: 1 }));
    const all = await listAllOrders({}, { maxPages: 2 });
    assert.equal(calls.length, 2);
    assert.equal(all.truncated, true);
  });
});

describe('the detail', () => {
  it('reads `order`', async () => {
    stubFetch(() => answer(200, { order: { orderId: ID } }));
    assert.deepEqual(await getOrder(ID), { orderId: ID });
    assert.equal(calls[0].url, `/_api/v1/admin/orders/${ID}`);
  });

  it('a 404 (session alive) is null', async () => {
    stubFetch((url) => (url === '/_api/v1/me' ? answer(200, { user: {} }) : answer(404, { error: { code: 'not_found' } })));
    assert.equal(await getOrder(ID), null);
  });
});

describe('fulfilment: one Idempotency-Key per action', () => {
  it('POSTs the step with a UUID key; empty fields are not sent', async () => {
    stubFetch(() => answer(200, { fulfilment: { orderId: ID, from: 'unfulfilled', to: 'processing' } }));
    const result = await changeFulfilment(ID, { to: 'processing', trackingNumber: '  ' });
    assert.equal(result.to, 'processing');
    assert.equal(calls[0].url, `/_api/v1/admin/orders/${ID}/fulfilment`);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { to: 'processing' });
    assert.match(header(calls[0], 'Idempotency-Key'), UUID);
    assert.equal(header(calls[0], 'X-Shop-Id'), 'test-shop-a');
  });

  it('sends the tracking number on shipped, trimmed', async () => {
    stubFetch(() => answer(200, { fulfilment: { to: 'shipped' } }));
    await changeFulfilment(ID, { to: 'shipped', trackingNumber: ' RR1SE ' });
    assert.deepEqual(JSON.parse(calls[0].init.body), { to: 'shipped', trackingNumber: 'RR1SE' });
  });

  it('a network failure is retried with the SAME key', async () => {
    stubFetch((_url, _init, n) => {
      if (n === 1) throw new TypeError('fetch failed');
      return answer(200, { fulfilment: { to: 'processing' } });
    });
    await changeFulfilment(ID, { to: 'processing' }, { pauseMs: 0 });
    assert.equal(calls.length, 2);
    assert.equal(header(calls[0], 'Idempotency-Key'), header(calls[1], 'Idempotency-Key'));
  });

  it('two actions get two keys', async () => {
    stubFetch(() => answer(200, { fulfilment: {} }));
    await changeFulfilment(ID, { to: 'processing' });
    await changeFulfilment(ID, { to: 'shipped' });
    assert.notEqual(header(calls[0], 'Idempotency-Key'), header(calls[1], 'Idempotency-Key'));
  });

  it('a refusal is the answer: no retry, the reason kept', async () => {
    stubFetch(() => answer(409, { error: { code: 'fulfilment_not_allowed', reason: 'printer_ships', message: 'x' } }));
    await assert.rejects(
      changeFulfilment(ID, { to: 'shipped' }, { pauseMs: 0 }),
      (e) => e.status === 409 && e.code === 'fulfilment_not_allowed' && e.reason === 'printer_ships',
    );
    assert.equal(calls.length, 1);
  });

  it('a 5xx is retried, at most `attempts` times, with one key', async () => {
    stubFetch(() => answer(503, { error: { code: 'unavailable' } }));
    await assert.rejects(changeFulfilment(ID, { to: 'processing' }, { attempts: 3, pauseMs: 0 }), (e) => e.status === 503);
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((c) => header(c, 'Idempotency-Key'))).size, 1);
  });
});

describe('refund and cancel', () => {
  it('refund: amount and reason as given, a key; 202 is accepted-but-unsettled', async () => {
    stubFetch(() => answer(202, { refund: { refundId: 'r1', amountMinor: 500, state: 'reserved' } }));
    const refund = await refundOrder(ID, { amountMinor: 500, reason: 'r' });
    assert.deepEqual(refund, { refundId: 'r1', amountMinor: 500, state: 'reserved', accepted: true });
    assert.equal(calls[0].url, `/_api/v1/admin/orders/${ID}/refunds`);
    assert.deepEqual(JSON.parse(calls[0].init.body), { amountMinor: 500, reason: 'r' });
    assert.match(header(calls[0], 'Idempotency-Key'), UUID);
  });

  it('cancel: the reason, no key', async () => {
    stubFetch(() => answer(200, { cancellation: { orderId: ID } }));
    assert.deepEqual(await cancelOrder(ID, { reason: 'x' }), { orderId: ID });
    assert.equal(calls[0].url, `/_api/v1/admin/orders/${ID}/cancel`);
    assert.deepEqual(JSON.parse(calls[0].init.body), { reason: 'x' });
    assert.equal(header(calls[0], 'Idempotency-Key'), undefined);
  });
});
