// The dev API's rows for the shop's address (CP14) answer as the Worker does
// (invented data only):   node --test src/admin-app/dev/subdomain-dev.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';

function as(email, password) {
  const state = createState();
  const answer = route(state, 'POST', new URL('http://dev.invalid/_api/api/auth/sign-in/email'), {}, { email, password });
  const cookie = answer.setCookie.split(';')[0];
  const call = (method, path, { headers = {}, body = null } = {}) =>
    route(state, method, new URL(`http://dev.invalid/_api${path}`), { cookie, ...headers }, body);
  return { call };
}

describe("the shop's address", () => {
  it('the seller reads it with the settings and sets it alone; the refusals are the Worker codes', () => {
    const admin = as('admin@example.com', 'dev-password-1');
    const h = { 'x-shop-id': 'test-shop-a' };
    const read = admin.call('GET', '/v1/admin/settings', { headers: h });
    assert.equal(read.status, 200);
    assert.ok(read.body.settings);
    assert.equal(read.body.subdomain.hostname, 'test-shop-a.flippinstuff.se');

    const set = admin.call('PATCH', '/v1/admin/settings', { headers: h, body: { subdomainLabel: 'testa' } });
    assert.equal(set.status, 200);
    assert.equal(set.body.subdomain.label, 'testa');
    assert.deepEqual(set.body.subdomain.previous.map((p) => p.hostname), ['test-shop-a.flippinstuff.se']);

    const codes = (label) => admin.call('PATCH', '/v1/admin/settings', { headers: h, body: { subdomainLabel: label } }).body.error?.code;
    assert.equal(codes('Bad_Label'), 'subdomain_invalid');
    assert.equal(codes('www'), 'subdomain_reserved');
    assert.equal(admin.call('PATCH', '/v1/admin/settings', { headers: h, body: { subdomainLabel: 'x', returnAddress: 'y' } }).status, 400);
    // Any other PATCH is still FP's fenced write.
    assert.equal(admin.call('PATCH', '/v1/admin/settings', { headers: h, body: { returnAddress: 'y' } }).status, 400);
  });

  it('the platform reads and sets any shop; a label held (or in grace) is taken', () => {
    const platform = as('platform@example.com', 'dev-password-2');
    assert.equal(platform.call('GET', '/v1/platform/tenants/test-shop-b/subdomain').body.subdomain.label, null);
    assert.equal(platform.call('PUT', '/v1/platform/tenants/test-shop-b/subdomain', { body: { label: 'test-shop-a' } }).body.error.code, 'subdomain_taken');
    assert.equal(platform.call('PUT', '/v1/platform/tenants/test-shop-a/subdomain', { body: { label: 'alfa' } }).status, 200);
    assert.equal(platform.call('PUT', '/v1/platform/tenants/test-shop-b/subdomain', { body: { label: 'test-shop-a' } }).body.error.code, 'subdomain_taken');
    assert.equal(platform.call('PUT', '/v1/platform/tenants/test-shop-b/subdomain', { body: { label: 'bravo' } }).body.subdomain.hostname, 'bravo.flippinstuff.se');
  });
});
