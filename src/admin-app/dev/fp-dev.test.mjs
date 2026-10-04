// The dev API's rows of unit CP5-FP behave as the Worker's guards and
// refusals do (invented data only):
//   node --test src/admin-app/dev/fp-dev.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';

function as(email, password) {
  const state = createState();
  const answer = route(state, 'POST', new URL('http://dev.invalid/_api/api/auth/sign-in/email'), {}, { email, password });
  const cookie = answer.setCookie.split(';')[0];
  const call = (method, path, { headers = {}, body = null } = {}) =>
    route(state, method, new URL(`http://dev.invalid/_api${path}`), { cookie, ...headers }, body);
  return { state, call };
}

describe('the platform\'s print jobs', () => {
  it('a platform session only, never with X-Shop-Id; one value per filter, case-sensitive', () => {
    const admin = as('admin@example.com', 'dev-password-1');
    assert.equal(admin.call('GET', '/v1/platform/print-jobs').status, 404);
    const platform = as('platform@example.com', 'dev-password-2');
    assert.equal(platform.call('GET', '/v1/platform/print-jobs', { headers: { 'x-shop-id': 'test-shop-a' } }).status, 404);
    assert.equal(platform.call('GET', '/v1/platform/print-jobs?state=none&state=shipped').status, 400);
    assert.equal(platform.call('GET', '/v1/platform/print-jobs?dispatchState=Accepted').status, 400);
    assert.equal(platform.call('GET', '/v1/platform/print-jobs?limit=101').status, 400);
    assert.equal(platform.call('GET', '/v1/platform/print-jobs?sort=x').status, 400);
    const page = platform.call('GET', '/v1/platform/print-jobs?limit=2');
    assert.equal(page.body.jobs.length, 2);
    assert.equal(page.body.nextCursor, page.body.jobs[1].jobId);
    assert.equal(platform.call('GET', '/v1/platform/print-jobs').body.jobs.some((j) => j.sku === 'TOTE-01'), false, 'a line that is not a printer line is no job');
  });

  it('the status: forward only, tracking with shipped only, an unknown job 404', () => {
    const { call } = as('platform@example.com', 'dev-password-2');
    const path = '/v1/platform/print-jobs/1a2b3c4d-0000-4000-8000-000000001042-2/status';
    assert.equal(call('POST', path, { body: { state: 'produced', trackingNumber: 'X' } }).status, 400);
    assert.equal(call('POST', path, { body: { state: 'produced' } }).body.changed, true);
    assert.equal(call('POST', path, { body: { state: 'in_production' } }).body.error.reason, 'backwards');
    assert.equal(call('POST', '/v1/platform/print-jobs/1a2b3c4d-0000-4000-8000-000000009999-1/status', { body: { state: 'produced' } }).status, 404);
  });
});

describe('the printer\'s exception (CP6-PS4)', () => {
  const path = (order, line = 1) => `/v1/platform/print-jobs/${order}-${line}/status`;
  const O1042 = '1a2b3c4d-0000-4000-8000-000000001042';
  const O1051 = 'b4c5d6e7-0000-4000-8000-000000001051';

  it('the bodies are exactly one key; the list\'s filter takes none | out_of_stock and holds closed ones too', () => {
    const { call } = as('platform@example.com', 'dev-password-2');
    assert.equal(call('POST', path(O1042), { body: { exception: 'out_of_stock', state: 'produced' } }).status, 400);
    assert.equal(call('POST', path(O1042), { body: { exception: 'lost' } }).status, 400);
    assert.equal(call('GET', '/v1/platform/print-jobs?exception=Out_of_stock').status, 400);
    const listed = call('GET', '/v1/platform/print-jobs?exception=out_of_stock').body.jobs.map((j) => j.orderNumber);
    assert.deepEqual(listed, ['1051', '1052', '1053', '2002']);
    assert.ok(call('GET', '/v1/platform/print-jobs?exception=none').body.jobs.every((j) => j.exception === null));
  });

  it('the route\'s order of refusals, and the auto-ship after a close', () => {
    const { call } = as('platform@example.com', 'dev-password-2');
    assert.equal(call('POST', path('5e6f7081-0000-4000-8000-000000001046'), { body: { exception: 'out_of_stock' } }).body.error.reason, 'not_accepted');
    assert.equal(call('POST', path('4d5e6f70-0000-4000-8000-000000001045'), { body: { exception: 'out_of_stock' } }).body.error.reason, 'refunded');
    assert.equal(call('POST', path(O1042, 1), { body: { exception: 'out_of_stock' } }).body.changed, true);
    assert.equal(call('POST', path(O1042, 1), { body: { state: 'in_production' } }).body.error.reason, 'out_of_stock');
    const closed = call('POST', path(O1051), { body: { exception: 'resolved' } }).body;
    assert.deepEqual([closed.changed, closed.orderShipped, typeof closed.job.exceptionResolvedAt], [true, true, 'string']);
    assert.equal(call('POST', path(O1051), { body: { state: 'shipped' } }).body.error.reason, 'exception_resolved');
  });
});

describe('the settings PATCH', () => {
  it('fenced on expectedUpdatedAt: a stale fence is 409 with the stored settings; a shop the user cannot use is 404', () => {
    const { call } = as('admin@example.com', 'dev-password-1');
    const h = { 'x-shop-id': 'test-shop-a' };
    const stale = call('PATCH', '/v1/admin/settings', { headers: h, body: { expectedUpdatedAt: '2020-01-01T00:00:00.000Z', storeIdentity: { tagline: 'x' } } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'conflict');
    assert.equal(stale.body.settings.storeIdentity.tagline, 'Invented goods for testing.');
    const ok = call('PATCH', '/v1/admin/settings', { headers: h, body: { expectedUpdatedAt: '2026-10-01T09:00:00.000Z', storeIdentity: { tagline: 'x' } } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.settings.updatedAt > '2026-10-01T09:00:00.000Z');
    assert.equal(call('PATCH', '/v1/admin/settings', { headers: h, body: { storeIdentity: { tagline: 'x' } } }).status, 400, 'the fence is required');
    assert.equal(call('PATCH', '/v1/admin/settings', { headers: h, body: { expectedUpdatedAt: null, storeIdentity: { shopName: 'x' } } }).body.error.code, 'refused_store_identity_keys');
    assert.equal(call('PATCH', '/v1/admin/settings', { headers: { 'x-shop-id': 'test-shop-c' }, body: { expectedUpdatedAt: null, storeIdentity: { a: 1 } } }).status, 404);
  });
});
