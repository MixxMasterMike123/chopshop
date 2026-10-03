// The order members bound to one shop (CP5-FX, finding 1), under Node:
//   node --test src/admin-app/providers/ordersForShop.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from '../../api/admin/client.js';
import { UNRESOLVED_SHOP_ID } from '../../config/tenancy.js';
import { ordersForShop, readForShop } from './ordersForShop.js';
import { loadDashboardStats } from '../replacements/adminDashboardData.js';

const realFetch = globalThis.fetch;
let calls;

const answer = (status, body) => new Response(JSON.stringify(body), { status });
const shopOf = (call) => call.init.headers['x-shop-id'];
const row = (orderId) => ({ orderId, orderNumber: orderId, createdAt: '2026-10-03T08:00:00.000Z', status: 'paid', fulfilment: 'unfulfilled', totalMinor: 100, currency: 'SEK' });

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
}

/** 'pending' when `promise` has not settled after a few turns of the event loop. */
async function outcomeOf(promise, ms = 30) {
  return Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

/** A fetch whose answer waits until `release()` is called. */
function heldFetch(body, status = 200) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  stubFetch(async () => {
    await gate;
    return answer(status, body);
  });
  return () => release();
}

beforeEach(() => {
  calls = [];
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('the order list of one shop', () => {
  it('a write goes to the shop it was made in, whatever shop is active', async () => {
    setRequestShopId('test-shop-b');
    stubFetch(() => answer(200, { fulfilment: { to: 'processing' } }));
    assert.equal(await ordersForShop('test-shop-a').updateOrderStatus('o-1', 'processing'), true);
    stubFetch(() => answer(200, { cancellation: {} }));
    assert.equal(await ordersForShop('test-shop-a').updateOrderStatus('o-1', 'cancelled'), true);
    assert.deepEqual(calls.map(shopOf), ['test-shop-a', 'test-shop-a']);
    assert.match(calls[1].url, /\/cancel$/);
  });

  it('reads the whole list for its shop while that shop is active', async () => {
    stubFetch((url) => {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      return cursor === null
        ? answer(200, { orders: [row('1')], nextCursor: 'c1', count: 2, totalMinor: 200 })
        : answer(200, { orders: [row('2')], nextCursor: null, count: 2, totalMinor: 200 });
    });
    const orders = await ordersForShop('test-shop-a').getAllOrders();
    assert.deepEqual(orders.map((o) => o.id), ['1', '2']);
    assert.deepEqual(calls.map(shopOf), ['test-shop-a', 'test-shop-a']);
  });

  it('a cursor of one shop is never sent to another: the walk stays on its shop when the tab moves', async () => {
    stubFetch((url) => {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      if (cursor === null) {
        setRequestShopId('test-shop-b'); // the seller picks another shop mid-walk
        return answer(200, { orders: [row('1')], nextCursor: 'c1', count: 2, totalMinor: 200 });
      }
      return answer(200, { orders: [row('2')], nextCursor: null, count: 2, totalMinor: 200 });
    });
    const result = await outcomeOf(ordersForShop('test-shop-a').getAllOrders());
    assert.deepEqual(calls.map(shopOf), ['test-shop-a', 'test-shop-a']);
    assert.equal(result, 'pending', 'the list of the previous shop is dropped');
  });

  it('functions of one shop never ask another, even when another is active (and its answer is then dropped)', async () => {
    setRequestShopId('test-shop-b');
    stubFetch((url) => (url.includes('/orders/')
      ? answer(200, { order: { orderId: 'o-1', items: [], statusHistory: [], shipments: [] } })
      : answer(200, { orders: [row('1')], nextCursor: null, count: 1, totalMinor: 100 })));
    const a = ordersForShop('test-shop-a');
    assert.equal(await outcomeOf(a.getAllOrders()), 'pending');
    assert.equal(await outcomeOf(a.getOrderById('o-1')), 'pending');
    assert.deepEqual(calls.map(shopOf), ['test-shop-a', 'test-shop-a']);
  });

  it('a list that arrives after the tab moved to another shop is dropped, never shown', async () => {
    const release = heldFetch({ orders: [row('1')], nextCursor: null, count: 1, totalMinor: 100 });
    const reading = ordersForShop('test-shop-a').getAllOrders();
    setRequestShopId('test-shop-b');
    release();
    assert.equal(await outcomeOf(reading), 'pending');
  });

  it('so is a failure of the previous shop: no error is left for the new one', async () => {
    const release = heldFetch({ error: { code: 'internal' } }, 500);
    const reading = ordersForShop('test-shop-a').getAllOrders();
    setRequestShopId('test-shop-b');
    release();
    assert.equal(await outcomeOf(reading), 'pending');
  });

  it('a failure while its shop is still active is reported', async () => {
    stubFetch(() => answer(500, { error: { code: 'internal' } }));
    const result = await outcomeOf(ordersForShop('test-shop-a').getAllOrders());
    assert.equal(result.error?.status, 500);
  });

  it('no shop yet (the picker): nothing is asked and nothing settles, so no "no shop" error stays behind', async () => {
    stubFetch(() => answer(200, { orders: [], nextCursor: null, count: 0, totalMinor: 0 }));
    setRequestShopId(null);
    for (const none of [null, UNRESOLVED_SHOP_ID]) {
      const { getAllOrders, getOrderById } = ordersForShop(none);
      assert.equal(await outcomeOf(getAllOrders()), 'pending');
      assert.equal(await outcomeOf(getOrderById('o-1')), 'pending');
    }
    assert.equal(calls.length, 0);
    await assert.rejects(ordersForShop(null).updateOrderStatus('o-1', 'processing'), (error) => error.code === 'no_shop');
  });

  it('another shop, other functions (the pages\' effects run again)', () => {
    const a = ordersForShop('test-shop-a');
    const b = ordersForShop('test-shop-b');
    assert.notEqual(a.getAllOrders, b.getAllOrders);
    assert.notEqual(a.getOrderById, b.getOrderById);
    assert.equal(typeof a.deleteOrder, 'undefined', 'no delete (D68)');
  });
});

describe('the order detail of one shop', () => {
  it('asks its shop; an answer after the tab moved is dropped', async () => {
    stubFetch(() => answer(200, { order: { orderId: 'o-1', items: [], statusHistory: [], shipments: [] } }));
    const order = await ordersForShop('test-shop-a').getOrderById('o-1');
    assert.equal(order.id, 'o-1');
    assert.equal(shopOf(calls[0]), 'test-shop-a');

    const release = heldFetch({ order: { orderId: 'o-1', items: [], statusHistory: [], shipments: [] } });
    const reading = ordersForShop('test-shop-a').getOrderById('o-1');
    setRequestShopId('test-shop-b');
    release();
    assert.equal(await outcomeOf(reading), 'pending');
  });
});

describe('the dashboard of one shop', () => {
  it('reads its shop\'s numbers; drops them when the tab moved; asks nothing without a shop', async () => {
    stubFetch(() => answer(200, { orders: [row('1')], nextCursor: null, count: 1, totalMinor: 12300 }));
    const stats = await loadDashboardStats('test-shop-a');
    assert.equal(stats.totalOrders, 1);
    assert.equal(stats.totalRevenue, 123);
    assert.equal(shopOf(calls[0]), 'test-shop-a');

    const release = heldFetch({ orders: [], nextCursor: null, count: 0, totalMinor: 0 });
    const reading = loadDashboardStats('test-shop-a');
    setRequestShopId('test-shop-b');
    release();
    assert.equal(await outcomeOf(reading), 'pending');

    calls = [];
    assert.equal(await outcomeOf(loadDashboardStats(UNRESOLVED_SHOP_ID)), 'pending');
    assert.equal(calls.length, 0);
  });
});

describe('readForShop', () => {
  it('hands the value or the failure on while the shop is active', async () => {
    assert.equal(await readForShop('test-shop-a', async (id) => `read ${id}`), 'read test-shop-a');
    await assert.rejects(readForShop('test-shop-a', async () => {
      throw new Error('refused');
    }), /refused/);
  });
});
