// The product calls against a fake fetch: node --test src/api/admin/products.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import {
  createVariant,
  deleteVariant,
  getPodQuote,
  getProduct,
  listAllProducts,
  publishProduct,
  replaceProductImages,
  setProductOrder,
  updateProduct,
} from './products.js';

const realFetch = globalThis.fetch;
let calls;
let script;

const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

beforeEach(() => {
  calls = [];
  script = [];
  setRequestShopId('test-shop-a');
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    return next(url, init);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('the product routes', () => {
  it('every request names the shop and goes to the admin path', async () => {
    script.push(() => answer(200, { product: { productId: 'p 1' } }));
    await updateProduct('p 1', { featured: true });
    assert.equal(calls[0].url, '/_api/v1/admin/products/p%201');
    assert.equal(calls[0].init.method, 'PATCH');
    assert.equal(calls[0].init.headers['x-shop-id'], 'test-shop-a');
    assert.deepEqual(JSON.parse(calls[0].init.body), { featured: true });
  });

  it('the list is read page after page', async () => {
    script.push(
      () => answer(200, { products: [{ productId: 'a' }], nextCursor: 'c1' }),
      () => answer(200, { products: [{ productId: 'b' }], nextCursor: null }),
    );
    const all = await listAllProducts();
    assert.deepEqual(all.map((p) => p.productId), ['a', 'b']);
    assert.equal(calls[0].url, '/_api/v1/admin/products?limit=100');
    assert.equal(calls[1].url, '/_api/v1/admin/products?cursor=c1&limit=100');
  });

  it('an unknown product is null (the opaque 404, the session still there)', async () => {
    script.push(
      () => answer(404, { error: { code: 'not_found' } }),
      () => answer(200, { user: {} }), // the /v1/me re-read
    );
    assert.equal(await getProduct('nope'), null);
  });

  it('the order is sent 200 entries at a time', async () => {
    const entries = Array.from({ length: 450 }, (_, i) => ({ productId: `p${i}`, sortOrder: i }));
    script.push(() => answer(200, {}), () => answer(200, {}), () => answer(200, {}));
    await setProductOrder(entries);
    assert.deepEqual(calls.map((c) => JSON.parse(c.init.body).length), [200, 200, 50]);
    assert.ok(calls.every((c) => c.url === '/_api/v1/admin/products/order' && c.init.method === 'PUT'));
  });

  it('variants, images and publish', async () => {
    script.push(
      () => answer(201, { variant: { variantId: 'v1' } }),
      () => answer(200, { outcome: 'deactivated', variant: { variantId: 'v1', active: false } }),
      () => answer(200, { images: [] }),
      () => answer(200, { product: { productId: 'p', screeningStatus: 'pending' } }),
    );
    assert.equal((await createVariant('p', { sku: 's' })).variantId, 'v1');
    assert.equal((await deleteVariant('p', 'v1')).outcome, 'deactivated');
    await replaceProductImages('p', [{ objectId: 'o', variantId: null }]);
    assert.equal((await publishProduct('p')).screeningStatus, 'pending');
    assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url}`), [
      'POST /_api/v1/admin/products/p/variants',
      'DELETE /_api/v1/admin/products/p/variants/v1',
      'PUT /_api/v1/admin/products/p/images',
      'POST /_api/v1/admin/products/p/publish',
    ]);
  });

  it('a refusal keeps its code', async () => {
    script.push(() => answer(422, { error: { code: 'price_below_floor', message: 'below' } }));
    await assert.rejects(updateProduct('p', { priceMinor: 1 }), (error) => error.status === 422 && error.code === 'price_below_floor');
  });
});

describe('the POD quote', () => {
  it('passes on the three fields and nothing else', async () => {
    script.push(() => answer(200, { inkopMinor: 14000, priceFloorMinor: 25300, currency: 'SEK', extra: 1 }));
    assert.deepEqual(await getPodQuote('p', { variantId: 'v' }), { inkopMinor: 14000, priceFloorMinor: 25300, currency: 'SEK' });
    assert.equal(calls[0].url, '/_api/v1/admin/pod/quote?productId=p&variantId=v');
  });
  it('no mapping that can be produced → null', async () => {
    script.push(() => answer(422, { error: { code: 'not_quotable' } }));
    assert.equal(await getPodQuote('p'), null);
  });
});
