// The discount preview's client, under Node:
//   node --test src/api/*.test.mjs
// fetch and location are stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { previewDiscountCode } from './discountCodes.js';

const realFetch = globalThis.fetch;
let calls;

function stubFetch(status, body, headers = {}) {
  globalThis.fetch = async (url, init) => {
    calls.push({ init, url });
    return new Response(JSON.stringify(body), { headers, status });
  };
}

beforeEach(() => {
  calls = [];
  globalThis.location = { pathname: '/provbutik/cart' };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.location;
});

describe('previewDiscountCode', () => {
  it('posts the code and the lines (the checkout\'s keys only) and resolves the discount', async () => {
    stubFetch(200, { discount: { applies: true, code: 'SOMMAR20', discountMinor: 5_980 } });
    const discount = await previewDiscountCode({
      code: 'SOMMAR20',
      items: [
        { extra: 'x', price: 1, productId: 'p1', quantity: 2, variantId: 'v1' },
        { productId: 'p2', quantity: 1, variantId: null },
      ],
    });
    assert.deepEqual(discount, { applies: true, code: 'SOMMAR20', discountMinor: 5_980 });
    assert.equal(calls[0].url, '/_api/provbutik/v1/discount-codes/preview');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      code: 'SOMMAR20',
      items: [{ productId: 'p1', quantity: 2, variantId: 'v1' }, { productId: 'p2', quantity: 1 }],
    });
  });

  it('a code that does not apply is an answer, not an error', async () => {
    stubFetch(200, { discount: { applies: false, code: 'NOPE', discountMinor: 0 } });
    assert.deepEqual(await previewDiscountCode({ code: 'NOPE', items: [{ productId: 'p1', quantity: 1 }] }), {
      applies: false,
      code: 'NOPE',
      discountMinor: 0,
    });
  });

  it('a refusal arrives as ApiError with its status, code and Retry-After', async () => {
    stubFetch(429, { error: { code: 'rate_limited', message: 'Too many requests' } }, { 'retry-after': '120' });
    await assert.rejects(
      previewDiscountCode({ code: 'X', items: [{ productId: 'p1', quantity: 1 }] }),
      (error) => error.name === 'ApiError' && error.status === 429 && error.code === 'rate_limited' && error.retryAfterSeconds === 120,
    );
  });
});
