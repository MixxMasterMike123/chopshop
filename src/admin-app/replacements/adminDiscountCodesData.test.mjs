// AdminDiscountCodes' data layer on the API (CP8-DC), under Node:
//   node --test src/admin-app/replacements/adminDiscountCodesData.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from '../../api/admin/client.js';
import {
  SUPPORTS_DELETE,
  deleteDiscountCode,
  fmtDate,
  inputToDate,
  loadDiscountProducts,
  normalizeCode,
  saveDiscountCode,
  setDiscountCodeActive,
  tsToInput,
} from './adminDiscountCodesData.js';

const realFetch = globalThis.fetch;
let calls;
const stub = (handler) => {
  globalThis.fetch = async (url, init) => {
    calls.push({ init, url });
    return handler(url, init);
  };
};
const answer = (status, body) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  calls = [];
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

const FORM = {
  active: true,
  code: 'SOMMAR20',
  endsDay: '2026-10-31',
  maxUses: 10,
  minSpend: null,
  productIds: [],
  scope: 'all',
  startsDay: '2026-10-01',
  type: 'percent',
  value: 20,
};

describe('the admin build\'s discount codes', () => {
  it('has no delete: a code is deactivated', async () => {
    assert.equal(SUPPORTS_DELETE, false);
    await assert.rejects(deleteDiscountCode('test-shop-a', { id: 'd1' }));
  });

  it('normalises as the Worker does', () => {
    assert.equal(normalizeCode('  sommar20 '), 'SOMMAR20');
  });

  it('creates with POST and saves with a full PATCH', async () => {
    stub((_url, init) => answer(init.method === 'POST' ? 201 : 200, { discountCode: { discountCodeId: 'd1' } }));
    await saveDiscountCode({ form: FORM, id: null, shopId: 'test-shop-a' });
    await saveDiscountCode({ form: FORM, id: 'd1', shopId: 'test-shop-a' });
    assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
      ['POST', '/_api/v1/admin/discount-codes'],
      ['PATCH', '/_api/v1/admin/discount-codes/d1'],
    ]);
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.percentBp, 2000);
    assert.equal(new Date(body.endsAt).toISOString(), '2026-10-31T22:59:59.999Z');
  });

  it('throws a 409 with its code for the page to say', async () => {
    for (const code of ['conflict', 'discount_code_in_use']) {
      stub(() => answer(409, { error: { code, message: 'x' } }));
      await assert.rejects(saveDiscountCode({ form: FORM, id: 'd1', shopId: 'test-shop-a' }), (error) => error.code === code);
    }
    stub(() => answer(400, { error: { code: 'invalid_request', message: 'x' } }));
    await assert.rejects(saveDiscountCode({ form: FORM, id: null, shopId: 'test-shop-a' }), (error) => error.status === 400);
  });

  it('toggles with one field', async () => {
    stub(() => answer(200, { discountCode: { discountCodeId: 'd1' } }));
    await setDiscountCodeActive('test-shop-a', { id: 'd1' }, false);
    assert.deepEqual(JSON.parse(calls[0].init.body), { active: false });
  });

  it('offers every product not archived, by name', async () => {
    stub(() => answer(200, {
      nextCursor: null,
      products: [
        { name: 'Örhängen', productId: 'p3', sku: 'OR', status: 'active' },
        { name: 'Arkiverad', productId: 'p2', sku: 'AR', status: 'archived' },
        { name: 'Bägare', productId: 'p1', sku: 'BA', status: 'draft' },
      ],
    }));
    assert.deepEqual(await loadDiscountProducts('test-shop-a'), [
      { id: 'p1', name: 'Bägare', sku: 'BA' },
      { id: 'p3', name: 'Örhängen', sku: 'OR' },
    ]);
  });

  it('dates are Stockholm days both ways', () => {
    const start = inputToDate('2026-10-01');
    assert.equal(start.toISOString(), '2026-09-30T22:00:00.000Z');
    assert.equal(tsToInput(start.getTime()), '2026-10-01');
    assert.equal(tsToInput(null), '');
    assert.equal(inputToDate(''), null);
    assert.equal(fmtDate(Date.parse('2026-10-31T22:59:59.999Z')), '2026-10-31');
    assert.equal(fmtDate(null), '');
  });
});
