// The dev API's rows for add-ons, users, reports and screening (unit FJ), under Node:
//   node --test src/admin-app/dev/platform-rest-dev.test.mjs
// Checked against the Worker's guards and refusals (platform-tenants.ts,
// platform-users.ts, platform-reports.ts, pod-platform.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';

const call = (state, method, path, { headers = {}, body = null } = {}) =>
  route(state, method, new URL(path, 'http://dev.invalid'), headers, body);

function platform() {
  const state = createState();
  const answer = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'platform@example.com', password: 'dev-password-2' } });
  const cookie = answer.setCookie.split(';')[0];
  return { state, get: (p, h = {}) => call(state, 'GET', p, { headers: { cookie, ...h } }), post: (p, b, h = {}) => call(state, 'POST', p, { headers: { cookie, ...h }, body: b }), put: (p, b) => call(state, 'PUT', p, { headers: { cookie }, body: b }), cookie };
}

describe('the guards', () => {
  it('a signed-out request, a tenant admin and a request naming a shop all get the opaque 404', () => {
    const state = createState();
    assert.equal(call(state, 'GET', '/_api/v1/platform/users').status, 404);
    const admin = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'admin@example.com', password: 'dev-password-1' } });
    assert.equal(call(state, 'GET', '/_api/v1/platform/reports', { headers: { cookie: admin.setCookie.split(';')[0] } }).status, 404);
    const p = platform();
    assert.equal(p.get('/_api/v1/platform/screening', { 'x-shop-id': 'test-shop-a' }).status, 404);
  });
});

describe('add-ons', () => {
  it('every allowed key with its effective value and source', () => {
    const { body } = platform().get('/_api/v1/platform/tenants/test-shop-a/features');
    assert.deepEqual(body.features.map((f) => f.key), ['abandonedCheckout', 'contentStudio', 'discountCodes', 'marketingMaterials', 'pod', 'productReviews']);
    assert.deepEqual(body.features.find((f) => f.key === 'pod'), { defaultEnabled: false, enabled: true, key: 'pod', source: 'explicit' });
    assert.deepEqual(body.features.find((f) => f.key === 'productReviews'), { defaultEnabled: true, enabled: true, key: 'productReviews', source: 'default' });
  });
  it('a PUT names keys the Worker allows; the others keep their value', () => {
    const p = platform();
    const answer = p.put('/_api/v1/platform/tenants/test-shop-a/features', { features: { discountCodes: true } });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.features.find((f) => f.key === 'discountCodes').enabled, true);
    assert.equal(answer.body.features.find((f) => f.key === 'pod').enabled, true);
  });
  it('refuses a key not ported or deleted, a non-boolean, an empty set and an unknown shop', () => {
    const p = platform();
    for (const features of [{ affiliate: true }, { dining: false }, { pod: 'yes' }, {}]) {
      assert.equal(p.put('/_api/v1/platform/tenants/test-shop-a/features', { features }).status, 400, JSON.stringify(features));
    }
    assert.equal(p.put('/_api/v1/platform/tenants/no-such/features', { features: { pod: true } }).status, 404);
  });
});

describe('users', () => {
  it('the directory filters by account type and pages by user id', () => {
    const p = platform();
    const admins = p.get('/_api/v1/platform/users?accountType=tenant_admin').body.users;
    assert.ok(admins.length >= 3 && admins.every((u) => u.accountType === 'tenant_admin'));
    const first = p.get('/_api/v1/platform/users?limit=2').body;
    assert.equal(first.users.length, 2);
    assert.ok(first.nextCursor);
    assert.equal(p.get(`/_api/v1/platform/users?limit=100&cursor=${first.nextCursor}`).body.users[0].userId > first.nextCursor, true);
    assert.equal(p.get('/_api/v1/platform/users?accountType=nope').status, 400);
    assert.equal(p.get('/_api/v1/platform/users?bogus=1').status, 400);
  });
  it('deactivate and reactivate, with the Worker\'s refusals', () => {
    const p = platform();
    const base = '/_api/v1/platform/users/';
    assert.equal(p.post(`${base}user-platform/deactivate`).body.error.code, 'cannot_deactivate_self');
    assert.equal(p.post(`${base}user-tenant-admin/deactivate`).body.user.status, 'suspended');
    assert.equal(p.post(`${base}user-tenant-admin/deactivate`).body.error.code, 'not_active');
    assert.equal(p.post(`${base}user-tenant-admin/reactivate`).body.user.status, 'active');
    assert.equal(p.post(`${base}user-tenant-admin/reactivate`).body.error.code, 'not_suspended');
    assert.equal(p.post(`${base}user-platform-old/reactivate`).body.error.code, 'platform_admin_reactivation');
    assert.equal(p.post(`${base}nobody/deactivate`).status, 404);
  });
  it('the last active platform admin stays', () => {
    const p = platform();
    const base = '/_api/v1/platform/users/';
    assert.equal(p.post(`${base}user-platform-2/deactivate`).status, 200);
    assert.equal(p.post(`${base}user-platform-2/reactivate`).status, 409);
    // only the signed-in operator is left active; deactivating self is refused first
    assert.equal(p.post(`${base}user-platform/deactivate`).body.error.code, 'cannot_deactivate_self');
  });
  it('an invite: 202 for an active admin, 409 for a suspended one, 503 in the noinvite scenario', () => {
    const p = platform();
    assert.equal(p.post('/_api/v1/platform/users/user-tenant-admin-c/invite').status, 202);
    assert.equal(p.post('/_api/v1/platform/users/user-tenant-admin-gone/invite').body.error.code, 'not_invitable');
    assert.equal(p.post('/_api/v1/platform/users/user-tenant-admin-c/invite', undefined, { cookie: `${p.cookie}; admin_dev_fj=noinvite` }).status, 503);
  });
});

describe('reports and the screening queue', () => {
  it('newest first, a status filter, and newCount whatever the filter', () => {
    const p = platform();
    const all = p.get('/_api/v1/platform/reports').body;
    assert.deepEqual(all.reports.map((r) => r.reportId), ['rep-0004', 'rep-0003', 'rep-0002', 'rep-0001']);
    assert.equal(all.newCount, 1);
    const reviewing = p.get('/_api/v1/platform/reports?status=reviewing&limit=1').body;
    assert.equal(reviewing.reports.length, 1);
    assert.equal(reviewing.newCount, 1);
    assert.equal(p.get('/_api/v1/platform/reports?status=zzz').status, 400);
    const page = p.get('/_api/v1/platform/reports?limit=1').body;
    assert.equal(p.get(`/_api/v1/platform/reports?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`).body.reports[0].reportId, 'rep-0003');
  });
  it('handle: the transitions of the trigger; takedown: closed, mismatch, and the product goes into the queue as blocked', () => {
    const p = platform();
    const r = '/_api/v1/platform/reports/';
    assert.equal(p.post(`${r}rep-0004/handle`, { status: 'taken_down' }).status, 400);
    assert.equal(p.post(`${r}rep-0004/handle`, { status: 'reviewing', note: ' hold ' }).body.report.note, 'hold');
    assert.equal(p.post(`${r}rep-0002/handle`, { status: 'reviewing' }).body.error.code, 'transition_refused');
    assert.equal(p.post(`${r}rep-0001/handle`, { status: 'reviewing' }).body.report.status, 'reviewing');
    assert.equal(p.post(`${r}rep-0003/takedown`, { productId: 'other' }).body.error.code, 'product_mismatch');
    const done = p.post(`${r}rep-0003/takedown`, { productId: 'prod-a-2', note: 'ok' });
    assert.equal(done.body.report.status, 'taken_down');
    assert.equal(done.body.screening.status, 'blocked');
    assert.equal(p.post(`${r}rep-0003/takedown`, {}).body.error.code, 'report_closed');
    assert.ok(p.get('/_api/v1/platform/screening').body.screening.some((s) => s.productId === 'prod-a-2' && s.takenDown));
  });
  it('the queue shows pending, flagged and blocked, oldest first; a decision changes one product', () => {
    const p = platform();
    const queue = p.get('/_api/v1/platform/screening').body.screening;
    assert.deepEqual(queue.map((s) => s.productId), ['prod-c-3', 'prod-c-2', 'prod-a-5']);
    assert.equal(p.post('/_api/v1/platform/screening/prod-c-3', { decision: 'approved' }).body.screening.takenDown, false);
    assert.equal(p.post('/_api/v1/platform/screening/prod-a-5', { decision: 'blocked' }).body.screening.takenDown, true);
    assert.equal(p.post('/_api/v1/platform/screening/prod-a-5', { decision: 'maybe' }).status, 400);
    assert.equal(p.post('/_api/v1/platform/screening/nope', { decision: 'approved' }).status, 404);
    assert.equal(p.get('/_api/v1/platform/screening?status=zzz').status, 400);
  });
  it('the scenarios: empty lists, and 500 on a read', () => {
    const p = platform();
    const empty = { cookie: `${p.cookie}; admin_dev_fj=empty` };
    assert.deepEqual(p.get('/_api/v1/platform/reports', empty).body.reports, []);
    assert.deepEqual(p.get('/_api/v1/platform/screening', empty).body.screening, []);
    assert.deepEqual(p.get('/_api/v1/platform/users', empty).body.users, []);
    const broken = { cookie: `${p.cookie}; admin_dev_fj=error` };
    assert.equal(p.get('/_api/v1/platform/users', broken).status, 500);
    assert.equal(p.get('/_api/v1/platform/tenants/test-shop-a/features', broken).status, 500);
  });
});
