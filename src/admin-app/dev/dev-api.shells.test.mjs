// The dev API's shell rows (unit FB), under Node:
//   node --test src/admin-app/dev/dev-api.shells.test.mjs
// Checked against the API's shapes and guards (routes/acting-as.ts,
// routes/legal-admin.ts, routes/admin-session.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';

const call = (state, method, path, { headers = {}, body = null } = {}) =>
  route(state, method, new URL(path, 'http://dev.invalid'), headers, body);

function signedIn(email, password, state = createState()) {
  const answer = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email, password } });
  assert.equal(answer.status, 200);
  return { state, cookie: answer.setCookie.split(';')[0] };
}

describe('/v1/me', () => {
  it('refuses X-Shop-Id with 400, signed in or not (as the API)', () => {
    const { state, cookie } = signedIn('admin@example.com', 'dev-password-1');
    assert.equal(call(state, 'GET', '/_api/v1/me', { headers: { cookie, 'x-shop-id': 'test-shop-a' } }).status, 400);
    assert.equal(call(createState(), 'GET', '/_api/v1/me', { headers: { 'x-shop-id': 'test-shop-a' } }).status, 400);
  });
});

describe('acting-as', () => {
  it('a platform user opens a grant: /v1/me lists it, the shop\'s admin routes admit it, DELETE ends it', () => {
    const { state, cookie } = signedIn('platform@example.com', 'dev-password-2');
    const shopHeaders = { cookie, 'x-shop-id': 'test-shop-a' };
    assert.equal(call(state, 'GET', '/_api/v1/admin/shop', { headers: shopHeaders }).status, 404);

    const opened = call(state, 'POST', '/_api/v1/platform/tenants/test-shop-a/acting-as', { headers: { cookie }, body: { reason: 'felsöker' } });
    assert.equal(opened.status, 201);
    assert.deepEqual(Object.keys(opened.body).sort(), ['expiresAt', 'tenantId']);
    assert.equal(opened.body.tenantId, 'test-shop-a');

    const me = call(state, 'GET', '/_api/v1/me', { headers: { cookie } }).body;
    assert.deepEqual(me.actingAs.map((g) => [g.tenantId, g.shopName]), [['test-shop-a', 'Test Shop A']]);
    assert.equal(call(state, 'GET', '/_api/v1/admin/shop', { headers: shopHeaders }).status, 200);

    assert.equal(call(state, 'DELETE', '/_api/v1/platform/tenants/test-shop-a/acting-as', { headers: { cookie } }).status, 204);
    assert.equal(call(state, 'DELETE', '/_api/v1/platform/tenants/test-shop-a/acting-as', { headers: { cookie } }).status, 404);
    assert.deepEqual(call(state, 'GET', '/_api/v1/me', { headers: { cookie } }).body.actingAs, []);
    assert.equal(call(state, 'GET', '/_api/v1/admin/shop', { headers: shopHeaders }).status, 404);
  });

  it('refusals: a suspended or unknown shop, a bad reason, X-Shop-Id, a tenant admin', () => {
    const { state, cookie } = signedIn('platform@example.com', 'dev-password-2');
    const post = (path, body, headers = { cookie }) => call(state, 'POST', path, { headers, body }).status;
    assert.equal(post('/_api/v1/platform/tenants/test-shop-b/acting-as', { reason: 'x' }), 404);
    assert.equal(post('/_api/v1/platform/tenants/no-such-shop/acting-as', { reason: 'x' }), 404);
    assert.equal(post('/_api/v1/platform/tenants/test-shop-a/acting-as', { reason: '   ' }), 400);
    assert.equal(post('/_api/v1/platform/tenants/test-shop-a/acting-as', { reason: 'x'.repeat(501) }), 400);
    assert.equal(post('/_api/v1/platform/tenants/test-shop-a/acting-as', { reason: 'x', extra: 1 }), 400);
    assert.equal(post('/_api/v1/platform/tenants/test-shop-a/acting-as', { reason: 'x' }, { cookie, 'x-shop-id': 'test-shop-a' }), 404);
    const admin = signedIn('admin@example.com', 'dev-password-1', state);
    assert.equal(post('/_api/v1/platform/tenants/test-shop-a/acting-as', { reason: 'x' }, { cookie: admin.cookie }), 404);
  });

  it('the directory and the reports badge, for the console', () => {
    const { state, cookie } = signedIn('platform@example.com', 'dev-password-2');
    const list = call(state, 'GET', '/_api/v1/platform/tenants', { headers: { cookie } }).body;
    assert.deepEqual(list.tenants.map((t) => [t.tenantId, t.status]), [
      ['test-shop-a', 'active'], ['test-shop-b', 'suspended'], ['test-shop-c', 'active'],
    ]);
    assert.equal(list.nextCursor, null);
    assert.equal(typeof call(state, 'GET', '/_api/v1/platform/reports?status=new&limit=1', { headers: { cookie } }).body.newCount, 'number');
  });
});

describe('the platform\'s terms', () => {
  const shop = (cookie, extra = '') => ({ cookie: `${cookie}${extra}`, 'x-shop-id': 'test-shop-a' });

  it('status keeps the legal-pages readiness and carries the terms keys; the text is the archived format', () => {
    const { state, cookie } = signedIn('admin@example.com', 'dev-password-1');
    const status = call(state, 'GET', '/_api/v1/admin/legal/status', { headers: shop(cookie) }).body;
    assert.deepEqual(Object.keys(status).sort(),
      ['accepted', 'acceptedAt', 'acceptedVersion', 'currentVersion', 'graceDeadline', 'identityMissing', 'inGrace', 'latestAcceptance', 'readiness']);
    assert.deepEqual(status.latestAcceptance.acceptedBy, { kind: 'admin', name: 'Test Admin', email: 'admin@example.com' });
    assert.equal(status.accepted, true);
    assert.equal(typeof status.readiness.ready, 'boolean');
    const terms = call(state, 'GET', '/_api/v1/admin/legal/terms', { headers: shop(cookie) }).body;
    assert.equal(terms.version, status.currentVersion);
    assert.deepEqual(Object.keys(JSON.parse(terms.text)), ['version', 'terms', 'dpa']);
  });

  it('unaccepted → accept (201), again (200), a stale version (409), a bad body (400)', () => {
    const { state, cookie } = signedIn('admin@example.com', 'dev-password-1');
    const headers = shop(cookie, '; admin_dev_terms=unaccepted');
    const status = call(state, 'GET', '/_api/v1/admin/legal/status', { headers }).body;
    assert.equal(status.accepted, false);
    const accept = (body) => call(state, 'POST', '/_api/v1/admin/legal/accept-terms', { headers, body });
    assert.equal(accept({ termsVersion: '2000-01-01' }).status, 409);
    assert.equal(accept({ termsVersion: status.currentVersion, extra: 1 }).status, 400);
    const first = accept({ termsVersion: status.currentVersion });
    assert.equal(first.status, 201);
    assert.equal(first.body.acceptance.termsVersion, status.currentVersion);
    assert.equal(accept({ termsVersion: status.currentVersion }).status, 200);
    assert.equal(call(state, 'GET', '/_api/v1/admin/legal/status', { headers }).body.accepted, true);
  });

  it('an acting-as platform user reads the status but may not accept', () => {
    const { state, cookie } = signedIn('platform@example.com', 'dev-password-2');
    call(state, 'POST', '/_api/v1/platform/tenants/test-shop-a/acting-as', { headers: { cookie }, body: { reason: 'x' } });
    const headers = shop(cookie, '; admin_dev_terms=unaccepted');
    const status = call(state, 'GET', '/_api/v1/admin/legal/status', { headers });
    assert.equal(status.status, 200);
    assert.equal(call(state, 'POST', '/_api/v1/admin/legal/accept-terms', { headers, body: { termsVersion: status.body.currentVersion } }).status, 404);
  });

  it('notext: a current version with no archived text', () => {
    const { state, cookie } = signedIn('admin@example.com', 'dev-password-1');
    const terms = call(state, 'GET', '/_api/v1/admin/legal/terms', { headers: shop(cookie, '; admin_dev_terms=notext') }).body;
    assert.equal(terms.text, null);
    assert.equal(terms.textArchived, false);
  });
});
