// Unit FE's rows of the dev API: node --test src/admin-app/dev/dev-api-settings.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';

const call = (state, method, path, { headers = {}, body = null } = {}) =>
  route(state, method, new URL(path, 'http://dev.invalid'), headers, body);

function signedIn(email, password) {
  const state = createState();
  const answer = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email, password } });
  assert.equal(answer.status, 200);
  return { state, headers: { cookie: answer.setCookie.split(';')[0] } };
}

const TEXTS = { kopvillkor: '<h1>K</h1>', angerratt: '<h1>A</h1>', integritetspolicy: '<h1>I</h1>' };
const MAP = { kopvillkor: false, angerratt: false, integritetspolicy: false };

describe('settings and legal pages (dev API)', () => {
  it('a new shop: nothing answered, then settings saved, then adopted → ready', () => {
    const { state, headers } = signedIn('admin-c@example.com', 'dev-password-4');
    const h = { ...headers, 'x-shop-id': 'test-shop-c' };
    let status = call(state, 'GET', '/_api/v1/admin/legal/status', { headers: h }).body;
    assert.deepEqual(status.readiness, { legalPagesAccepted: false, ready: false, returnAddress: false, vatAnswered: false });

    const put = call(state, 'PUT', '/_api/v1/admin/settings', { headers: h, body: { storeIdentity: { tagline: 't' }, returnAddress: ' R ', vatRegistered: false } });
    assert.equal(put.status, 200);
    assert.equal(put.body.settings.returnAddress, 'R');
    assert.deepEqual(call(state, 'GET', '/_api/v1/admin/settings', { headers: h }).body.settings.storeIdentity, { tagline: 't' });

    const adopted = call(state, 'POST', '/_api/v1/admin/legal/accept-pages', {
      headers: h, body: { templateVersion: '2026-09-07', texts: TEXTS, pod: false, custom: MAP },
    });
    assert.equal(adopted.status, 201);
    assert.deepEqual(Object.keys(adopted.body.acceptance).sort(), ['acceptanceId', 'acceptedAt', 'custom', 'customPages', 'pod', 'templateVersion', 'textsSha256']);
    status = call(state, 'GET', '/_api/v1/admin/legal/status', { headers: h }).body;
    assert.equal(status.readiness.ready, true);
    assert.equal(call(state, 'GET', '/_api/v1/admin/legal/pages', { headers: h }).body.acceptance.pageSha256.kopvillkor.length, 64);
  });

  it('refuses a platform key in the identity, a malformed adoption, refused HTML', () => {
    const { state, headers } = signedIn('admin@example.com', 'dev-password-1');
    const h = { ...headers, 'x-shop-id': 'test-shop-a' };
    const refused = call(state, 'PUT', '/_api/v1/admin/settings', { headers: h, body: { storeIdentity: { shopName: 'x' } } });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body.error.keys, ['shopName']);
    assert.equal(call(state, 'POST', '/_api/v1/admin/legal/accept-pages', { headers: h, body: { texts: TEXTS } }).status, 400);
    const html = call(state, 'POST', '/_api/v1/admin/legal/accept-pages', {
      headers: h, body: { templateVersion: 'v', texts: { ...TEXTS, angerratt: '<p onclick="x()">a</p>' }, pod: true, custom: { ...MAP, angerratt: true } },
    });
    assert.equal(html.status, 400);
    assert.equal(html.body.error.code, 'invalid_request');
  });

  it('an acting-as platform user reads, saves, but never adopts', () => {
    const { state, headers } = signedIn('platform-acting@example.com', 'dev-password-3');
    const h = { ...headers, 'x-shop-id': 'test-shop-a' };
    assert.equal(call(state, 'GET', '/_api/v1/admin/legal/status', { headers: h }).status, 200);
    assert.equal(call(state, 'PUT', '/_api/v1/admin/settings', { headers: h, body: { vatRegistered: true } }).status, 200);
    assert.equal(call(state, 'POST', '/_api/v1/admin/legal/accept-pages', {
      headers: h, body: { templateVersion: 'v', texts: TEXTS, pod: true, custom: MAP },
    }).status, 404);
  });
});
