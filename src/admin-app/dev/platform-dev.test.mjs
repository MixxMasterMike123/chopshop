// The dev API's platform shop rows (unit FI), under Node:
//   node --test src/admin-app/dev/platform-dev.test.mjs
// Checked against the Worker's shapes and refusals (routes/platform-tenants.ts,
// platform/tenant-directory.ts, app.ts handlePlatformTenantRoute).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';

const call = (state, method, path, { headers = {}, body = null } = {}) =>
  route(state, method, new URL(path, 'http://dev.invalid'), headers, body);

function platform(state = createState()) {
  const answer = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'platform@example.com', password: 'dev-password-2' } });
  assert.equal(answer.status, 200);
  return { state, cookie: answer.setCookie.split(';')[0] };
}

describe('guards', () => {
  it('a tenant admin, no session or X-Shop-Id: the opaque 404', () => {
    const state = createState();
    const admin = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'admin@example.com', password: 'dev-password-1' } });
    const adminCookie = admin.setCookie.split(';')[0];
    assert.equal(call(state, 'GET', '/_api/v1/platform/tenants/test-shop-a', { headers: { cookie: adminCookie } }).status, 404);
    assert.equal(call(state, 'GET', '/_api/v1/platform/tenants/test-shop-a').status, 404);
    const { cookie } = platform(state);
    assert.equal(call(state, 'GET', '/_api/v1/platform/tenants/test-shop-a', { headers: { cookie, 'x-shop-id': 'test-shop-a' } }).status, 404);
  });
});

describe('the directory and the detail', () => {
  it('lists every shop with the directory shape; the scenarios empty and error', () => {
    const { state, cookie } = platform();
    const list = call(state, 'GET', '/_api/v1/platform/tenants?limit=100', { headers: { cookie } });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.tenants.map((t) => t.tenantId), ['test-shop-a', 'test-shop-b', 'test-shop-c']);
    assert.deepEqual(Object.keys(list.body.tenants[0]).sort(), ['domainCount', 'domains', 'published', 'shopName', 'status', 'tenantId']);
    assert.equal(call(state, 'GET', '/_api/v1/platform/tenants', { headers: { cookie: `${cookie}; admin_dev_fi=empty` } }).body.tenants.length, 0);
    assert.equal(call(state, 'GET', '/_api/v1/platform/tenants', { headers: { cookie: `${cookie}; admin_dev_fi=error` } }).status, 500);
  });
  it('the detail carries the commission and Connect facts; an unknown shop is 404', () => {
    const { state, cookie } = platform();
    const d = call(state, 'GET', '/_api/v1/platform/tenants/test-shop-a', { headers: { cookie } });
    assert.equal(d.status, 200);
    assert.deepEqual(Object.keys(d.body).sort(), ['domains', 'domainsTruncated', 'features', 'legal', 'settings', 'tenant']);
    assert.equal(d.body.tenant.commissionBps, 400);
    assert.deepEqual(Object.keys(d.body.tenant.connect).sort(), ['accountId', 'chargesEnabled', 'detailsSubmitted', 'payoutsEnabled', 'syncedAt']);
    assert.equal(d.body.features.length, 6);
    assert.equal(call(state, 'GET', '/_api/v1/platform/tenants/nope', { headers: { cookie } }).status, 404);
  });
});

describe('writes', () => {
  it('the commission: within the cap 200 (the detail), over it 400, null clears', () => {
    const { state, cookie } = platform();
    const ok = call(state, 'PATCH', '/_api/v1/platform/tenants/test-shop-a', { headers: { cookie }, body: { commissionBps: 250 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.tenant.commissionBps, 250);
    const over = call(state, 'PATCH', '/_api/v1/platform/tenants/test-shop-a', { headers: { cookie }, body: { commissionBps: 801 } });
    assert.equal(over.status, 400);
    assert.equal(over.body.error.code, 'invalid_request');
    assert.equal(call(state, 'PATCH', '/_api/v1/platform/tenants/test-shop-a', { headers: { cookie }, body: { other: 1 } }).status, 400);
    const cleared = call(state, 'PATCH', '/_api/v1/platform/tenants/test-shop-a', { headers: { cookie }, body: { commissionBps: null } });
    assert.equal(cleared.body.tenant.commissionBps, null);
  });
  it('publish, unpublish, suspend, activate', () => {
    const { state, cookie } = platform();
    const h = { headers: { cookie } };
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants/test-shop-a/unpublish', h).body.tenant.published, false);
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants/test-shop-a/publish', h).body.tenant.published, true);
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants/test-shop-a/suspend', h).body.tenant.status, 'suspended');
    const list = call(state, 'GET', '/_api/v1/platform/tenants', h).body.tenants;
    assert.equal(list.find((t) => t.tenantId === 'test-shop-a').status, 'suspended');
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants/test-shop-a/activate', h).body.tenant.status, 'active');
  });
  it('Connect enable/disable shows in the platform Connect view', () => {
    const { state, cookie } = platform();
    const h = { headers: { cookie } };
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants/test-shop-c/connect/disable', h).body.connect.enabled, false);
    assert.equal(call(state, 'GET', '/_api/v1/platform/tenants/test-shop-c/connect', h).body.connect.enabled, false);
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants/test-shop-c/connect/enable', h).body.connect.enabled, true);
  });
});

describe('provisioning', () => {
  it('create → features → unpublish; the id again is 409', () => {
    const { state, cookie } = platform();
    const h = (body) => ({ headers: { cookie }, body });
    const made = call(state, 'POST', '/_api/v1/platform/tenants', h({ tenantId: 'ny-butik', shopName: 'Ny butik', hostname: 'ny-butik.provisioned.invalid' }));
    assert.equal(made.status, 201);
    assert.equal(made.body.tenant.tenantId, 'ny-butik');
    assert.equal(call(state, 'PUT', '/_api/v1/platform/tenants/ny-butik/features', h({ features: { pod: true } })).status, 200);
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants/ny-butik/unpublish', h()).body.tenant.published, false);
    const detail = call(state, 'GET', '/_api/v1/platform/tenants/ny-butik', h()).body;
    assert.equal(detail.features.find((f) => f.key === 'pod').enabled, true);
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants', h({ tenantId: 'ny-butik', shopName: 'X', hostname: 'other.invalid' })).status, 409);
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants', h({ tenantId: 'Bad', shopName: 'X', hostname: 'x.invalid' })).status, 400);
    // A fixture shop's features still go to the add-ons rows.
    assert.equal(call(state, 'GET', '/_api/v1/platform/tenants/test-shop-a/features', h()).status, 200);
  });
  it('a shop admin: create (no platform admin), grant, invite; a taken address is 409', () => {
    const { state, cookie } = platform();
    const h = (body) => ({ headers: { cookie }, body });
    assert.equal(call(state, 'POST', '/_api/v1/platform/users', h({ accountType: 'platform_admin', email: 'x@example.com', password: 'p'.repeat(20) })).status, 400);
    assert.equal(call(state, 'POST', '/_api/v1/platform/users', h({ accountType: 'tenant_admin', email: 'admin@example.com', password: 'p'.repeat(20) })).status, 409);
    // Without a password, as the console sends it (CP5-WJ4); a print operator needs one.
    assert.equal(call(state, 'POST', '/_api/v1/platform/users', h({ accountType: 'print_operator', email: 'p@example.com' })).status, 400);
    assert.equal(call(state, 'POST', '/_api/v1/platform/users', h({ accountType: 'tenant_admin', email: 'np@example.com', password: null })).status, 400);
    const user = call(state, 'POST', '/_api/v1/platform/users', h({ accountType: 'tenant_admin', email: 'ny@example.com' }));
    assert.equal(user.status, 201);
    const { userId } = user.body.user;
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants/test-shop-a/admins', h({ userId })).status, 201);
    assert.equal(call(state, 'POST', '/_api/v1/platform/tenants/test-shop-a/admins', h({ userId })).status, 409);
    const invite = call(state, 'POST', `/_api/v1/platform/users/${userId}/invite`, h());
    assert.equal(invite.status, 202);
    assert.deepEqual(Object.keys(invite.body.invite).sort(), ['expiresAt', 'surface', 'userId']);
    const noinvite = call(state, 'POST', `/_api/v1/platform/users/${userId}/invite`, { headers: { cookie: `${cookie}; admin_dev_fi=noinvite` } });
    assert.equal(noinvite.status, 503);
  });
});

describe('the preview grant', () => {
  it('needs the shop\'s admin context: a platform user without a grant gets 404, with one 200', () => {
    const { state, cookie } = platform();
    const headers = { cookie, 'x-shop-id': 'test-shop-a' };
    assert.equal(call(state, 'POST', '/_api/v1/admin/preview', { headers }).status, 404);
    call(state, 'POST', '/_api/v1/platform/tenants/test-shop-a/acting-as', { headers: { cookie }, body: { reason: 'förhandsvisning' } });
    const ok = call(state, 'POST', '/_api/v1/admin/preview', { headers });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body.preview).sort(), ['expiresAt', 'grant']);
  });
});
