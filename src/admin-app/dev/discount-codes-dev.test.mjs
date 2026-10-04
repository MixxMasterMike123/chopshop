// node --test src/admin-app/dev/discount-codes-dev.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createState, route } from './dev-api.mjs';
import { discountCodeRowFromApi } from '../adapters/discountCode.js';

function signedIn(email = 'admin@example.com', password = 'dev-password-1') {
  const state = createState();
  const r = route(state, 'POST', new URL('http://x/_api/api/auth/sign-in/email'), {}, { email, password });
  const cookie = r.setCookie.split(';')[0];
  const call = (method, path, body = null, shop = 'test-shop-a') =>
    route(state, method, new URL(`http://x/_api${path}`), { cookie, 'x-shop-id': shop }, body);
  return { call };
}

describe('discount code dev rows (CP8-DC)', () => {
  it('lists the shop\'s codes newest first, in the Worker\'s shape, each a page row', () => {
    const { call } = signedIn();
    const { status, body } = call('GET', '/v1/admin/discount-codes');
    assert.equal(status, 200);
    assert.equal(body.truncated, false);
    assert.deepEqual(body.discountCodes.map((c) => c.code), ['SOMMAR20', 'VINTER100', 'TROJA15', 'VAR10']);
    for (const code of body.discountCodes) {
      assert.equal('createdAt' in code, false);
      assert.ok(discountCodeRowFromApi(code));
    }
  });

  it('is the opaque 404 on every route of a shop with the add-on off', () => {
    const { call } = signedIn('admin-multi@example.com', 'dev-password-5');
    for (const [method, path] of [['GET', '/v1/admin/discount-codes'], ['POST', '/v1/admin/discount-codes'], ['GET', '/v1/admin/discount-codes/x'], ['PATCH', '/v1/admin/discount-codes/x']]) {
      assert.equal(call(method, path, { code: 'X' }, 'test-shop-c').status, 404, `${method} ${path}`);
    }
  });

  it('creates, refuses a taken name and a fixed code worth 0, edits', () => {
    const { call } = signedIn();
    const created = call('POST', '/v1/admin/discount-codes', { code: ' host15 ', percentBp: 1500, scope: 'all', type: 'percent' });
    assert.equal(created.status, 201);
    assert.equal(created.body.discountCode.code, 'HOST15');
    assert.equal(call('POST', '/v1/admin/discount-codes', { code: 'HOST15', percentBp: 1000, scope: 'all', type: 'percent' }).body.error.code, 'conflict');
    assert.equal(call('POST', '/v1/admin/discount-codes', { code: 'NOLL', scope: 'all', type: 'fixed', valueMinor: 0 }).status, 400);
    const id = created.body.discountCode.discountCodeId;
    const renamed = call('PATCH', `/v1/admin/discount-codes/${id}`, { code: 'HOST20', percentBp: 2000 });
    assert.equal(renamed.body.discountCode.code, 'HOST20');
    assert.equal(call('GET', `/v1/admin/discount-codes/${id}`).body.discountCode.percentBp, 2000);
  });

  it('a used or held code keeps its name; its other fields may change', () => {
    const { call } = signedIn();
    assert.equal(call('PATCH', '/v1/admin/discount-codes/dc-dev-sommar20', { code: 'NYTTNAMN' }).body.error.code, 'discount_code_in_use');
    const deactivated = call('PATCH', '/v1/admin/discount-codes/dc-dev-sommar20', { active: false });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.discountCode.active, false);
    assert.equal(call('DELETE', '/v1/admin/discount-codes/dc-dev-sommar20').status, 404);
  });
});
