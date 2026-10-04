// The discount code calls, under Node: node --test src/api/admin/discountCodes.test.mjs
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AdminApiError, setRequestShopId } from './client.js';
import { createDiscountCode, getDiscountCode, listDiscountCodes, updateDiscountCode } from './discountCodes.js';

const realFetch = globalThis.fetch;
let calls;
const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const stub = (handler) => {
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
};
beforeEach(() => { calls = []; setRequestShopId('test-shop-a'); });
afterEach(() => { globalThis.fetch = realFetch; setRequestShopId(null); });

describe('discount codes', () => {
  it('lists with X-Shop-Id and says truncated', async () => {
    stub(() => answer(200, { discountCodes: [{ discountCodeId: 'd1' }], truncated: true }));
    assert.deepEqual(await listDiscountCodes(), { discountCodes: [{ discountCodeId: 'd1' }], truncated: true });
    assert.equal(calls[0].url, '/_api/v1/admin/discount-codes');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers['x-shop-id'], 'test-shop-a');
  });

  it('an empty or odd answer is an empty list', async () => {
    stub(() => answer(200, {}));
    assert.deepEqual(await listDiscountCodes(), { discountCodes: [], truncated: false });
  });

  it('reads one by an escaped id, null on the opaque 404', async () => {
    stub(() => answer(200, { discountCode: { discountCodeId: 'a/b' } }));
    assert.deepEqual(await getDiscountCode('a/b'), { discountCodeId: 'a/b' });
    assert.equal(calls[0].url, '/_api/v1/admin/discount-codes/a%2Fb');
    stub(() => answer(404, { error: { code: 'not_found', message: 'Route not found' } }));
    assert.equal(await getDiscountCode('gone'), null);
  });

  it('creates with POST and edits with PATCH, the body as given', async () => {
    stub((_url, init) => answer(init.method === 'POST' ? 201 : 200, { discountCode: { discountCodeId: 'd2' } }));
    const body = { code: 'SOMMAR20', percentBp: 2000, scope: 'all', type: 'percent' };
    assert.deepEqual(await createDiscountCode(body), { discountCodeId: 'd2' });
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), body);
    await updateDiscountCode('d2', { active: false });
    assert.equal(calls[1].init.method, 'PATCH');
    assert.equal(calls[1].url, '/_api/v1/admin/discount-codes/d2');
    assert.deepEqual(JSON.parse(calls[1].init.body), { active: false });
  });

  it('a 409 carries its code: a taken name, or a used code that keeps its name', async () => {
    for (const code of ['conflict', 'discount_code_in_use']) {
      stub(() => answer(409, { error: { code, message: 'x' } }));
      await assert.rejects(updateDiscountCode('d2', { code: 'NEW' }), (e) => e instanceof AdminApiError && e.status === 409 && e.code === code);
    }
  });
});
