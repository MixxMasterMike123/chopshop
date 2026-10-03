// The dev API's Connect rows (unit FF), under Node:
//   node --test src/admin-app/dev/dev-api.payments.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SESSION_COOKIE, createState, route } from './dev-api.mjs';

function signIn(state, email, password) {
  const answer = route(state, 'POST', new URL('http://dev.invalid/_api/api/auth/sign-in/email'), {}, { email, password });
  assert.equal(answer.status, 200);
  return answer.setCookie.split(';')[0].split('=')[1];
}

const call = (state, method, path, { token, scenario = 'none', shopId, body = null } = {}) => {
  const headers = { cookie: `${SESSION_COOKIE}=${token}; admin_dev_connect=${scenario}` };
  if (shopId) headers['x-shop-id'] = shopId;
  return route(state, method, new URL(`http://dev.invalid/_api${path}`), headers, body);
};

describe('dev API: Connect', () => {
  it('the seller walk: none → create → onboarding → refresh → restricted → link → refresh → active', () => {
    const state = createState();
    const token = signIn(state, 'admin@example.com', 'dev-password-1');
    const o = { token, shopId: 'test-shop-a' };
    assert.equal(call(state, 'GET', '/v1/admin/payments/connect', o).body.connect.status, 'none');
    assert.equal(call(state, 'POST', '/v1/admin/payments/connect/account', o).status, 201);
    assert.equal(call(state, 'POST', '/v1/admin/payments/connect/refresh', o).body.connect.status, 'restricted');
    assert.equal(call(state, 'POST', '/v1/admin/payments/connect/onboarding-link', o).status, 200);
    assert.equal(call(state, 'POST', '/v1/admin/payments/connect/refresh', o).body.connect.status, 'active');
    assert.equal(call(state, 'POST', '/v1/admin/payments/connect/login-link', o).status, 200);
  });

  it('not enabled: status 200 enabled:false, create 404; notfound scenario: status 404', () => {
    const state = createState();
    const token = signIn(state, 'admin@example.com', 'dev-password-1');
    const o = { token, shopId: 'test-shop-a', scenario: 'disabled' };
    assert.equal(call(state, 'GET', '/v1/admin/payments/connect', o).body.connect.enabled, false);
    assert.equal(call(state, 'POST', '/v1/admin/payments/connect/account', o).status, 404);
    assert.equal(call(state, 'GET', '/v1/admin/payments/connect', { ...o, scenario: 'notfound' }).status, 404);
  });

  it('acting as: the login link is the opaque 404; the payout delay is a platform route without X-Shop-Id', () => {
    const state = createState();
    const token = signIn(state, 'platform-acting@example.com', 'dev-password-3');
    const o = { token, scenario: 'active' };
    assert.equal(call(state, 'POST', '/v1/admin/payments/connect/login-link', { ...o, shopId: 'test-shop-a' }).status, 404);
    const path = '/v1/platform/tenants/test-shop-a/connect/payout-delay';
    assert.equal(call(state, 'PUT', path, { ...o, shopId: 'test-shop-a', body: { delayDays: 7 } }).status, 404);
    assert.equal(call(state, 'PUT', path, { ...o, body: { delayDays: 14 } }).body.connect.payoutDelayDays, 14);
    assert.equal(call(state, 'PUT', path, { ...o, body: { delayDays: 'minimum' } }).body.connect.payoutDelayDays, null);
    assert.equal(call(state, 'PUT', path, { ...o, body: { delayDays: 400 } }).status, 400);
  });

  it('a tenant admin gets the opaque 404 on the platform routes', () => {
    const state = createState();
    const token = signIn(state, 'admin@example.com', 'dev-password-1');
    assert.equal(call(state, 'GET', '/v1/platform/tenants/test-shop-a/connect', { token }).status, 404);
  });
});
