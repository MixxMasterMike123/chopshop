// The platform console's shop calls (unit FI's section of platform.js), under Node:
//   node --test src/api/admin/platform-shops.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import {
  createTenant,
  createTenantAdminUser,
  getTenantConnect,
  getTenantDetail,
  grantTenantAdmin,
  patchTenant,
  provisionHostnameFor,
  requestStorefrontPreview,
  setTenantConnectEnabled,
  setTenantPublished,
  setTenantStatus,
  unusablePassword,
} from './platform.js';

const realFetch = globalThis.fetch;
let calls;

const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
}

const header = (call, name) => call.init.headers[name.toLowerCase()];
const body = (call) => JSON.parse(call.init.body);

beforeEach(() => {
  calls = [];
  // An admin page left an active shop behind: no platform call may carry it.
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('no platform call carries a shop (D70)', () => {
  it('detail, PATCH, publish, status, Connect, create, user, grant', async () => {
    stubFetch(() => answer(200, { tenant: { tenantId: 'x' }, connect: {}, user: { userId: 'u' }, membership: {} }));
    await getTenantDetail('x');
    await patchTenant('x', { commissionBps: 300 });
    await setTenantPublished('x', true);
    await setTenantPublished('x', false);
    await setTenantStatus('x', 'active');
    await setTenantStatus('x', 'suspended');
    await getTenantConnect('x');
    await setTenantConnectEnabled('x', true);
    await setTenantConnectEnabled('x', false);
    await createTenant({ tenantId: 'x', shopName: 'X', hostname: 'x.provisioned.invalid' });
    await createTenantAdminUser('a@example.com');
    await grantTenantAdmin('x', 'u');
    for (const call of calls) {
      assert.ok(call.url.startsWith('/_api/v1/platform/'), call.url);
      assert.equal(header(call, 'X-Shop-Id'), undefined, call.url);
      assert.equal(call.init.credentials, 'same-origin');
    }
    assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url.slice(5)}`), [
      'GET /v1/platform/tenants/x',
      'PATCH /v1/platform/tenants/x',
      'POST /v1/platform/tenants/x/publish',
      'POST /v1/platform/tenants/x/unpublish',
      'POST /v1/platform/tenants/x/activate',
      'POST /v1/platform/tenants/x/suspend',
      'GET /v1/platform/tenants/x/connect',
      'POST /v1/platform/tenants/x/connect/enable',
      'POST /v1/platform/tenants/x/connect/disable',
      'POST /v1/platform/tenants',
      'POST /v1/platform/users',
      'POST /v1/platform/tenants/x/admins',
    ]);
  });
});

describe('bodies', () => {
  it('PATCH sends exactly the patch', async () => {
    stubFetch(() => answer(200, { tenant: {} }));
    await patchTenant('x', { commissionBps: 250 });
    assert.deepEqual(body(calls[0]), { commissionBps: 250 });
  });
  it('create sends id, name and hostname only', async () => {
    stubFetch(() => answer(201, { tenant: { tenantId: 'x' } }));
    await createTenant({ tenantId: 'x', shopName: 'X', hostname: provisionHostnameFor('x') });
    assert.deepEqual(body(calls[0]), { tenantId: 'x', shopName: 'X', hostname: 'x.provisioned.invalid' });
  });
  it('a new admin is a tenant admin with an unusable password nobody chose', async () => {
    stubFetch(() => answer(201, { user: { userId: 'u', email: 'a@example.com', accountType: 'tenant_admin' } }));
    const user = await createTenantAdminUser('a@example.com');
    const sent = body(calls[0]);
    assert.deepEqual(Object.keys(sent).sort(), ['accountType', 'email', 'password']);
    assert.equal(sent.accountType, 'tenant_admin');
    assert.equal(sent.password.length, 96);
    assert.equal(user.userId, 'u');
  });
  it('the password is random each time and within the policy (8–128)', () => {
    const a = unusablePassword();
    const b = unusablePassword();
    assert.notEqual(a, b);
    assert.ok(a.length >= 8 && a.length <= 128);
  });
  it('grant sends the user id', async () => {
    stubFetch(() => answer(201, { membership: { userId: 'u' } }));
    await grantTenantAdmin('x', 'u');
    assert.deepEqual(body(calls[0]), { userId: 'u' });
  });
});

describe('answers', () => {
  it('a 404 detail or Connect view is null (session alive)', async () => {
    stubFetch((url) => (url === '/_api/v1/me' ? answer(200, { user: {} }) : answer(404, { error: { code: 'not_found' } })));
    assert.equal(await getTenantDetail('nope'), null);
    assert.equal(await getTenantConnect('nope'), null);
  });
  it('a refused commission rejects with the API code', async () => {
    stubFetch(() => answer(400, { error: { code: 'invalid_request', message: 'Request is not valid' } }));
    await assert.rejects(patchTenant('x', { commissionBps: 900 }), (e) => e.status === 400 && e.code === 'invalid_request');
  });
  it('a taken shop id rejects with 409', async () => {
    stubFetch(() => answer(409, { error: { code: 'conflict' } }));
    await assert.rejects(createTenant({ tenantId: 'x', shopName: 'X', hostname: 'h.invalid' }), (e) => e.status === 409);
  });
});

describe('the preview', () => {
  it('is an ADMIN request naming the shop (X-Shop-Id), not the tab\'s active shop', async () => {
    stubFetch(() => answer(200, { preview: { grant: 'g', expiresAt: '2026-10-03T12:30:00.000Z' } }));
    const preview = await requestStorefrontPreview('test-shop-c');
    assert.equal(calls[0].url, '/_api/v1/admin/preview');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(header(calls[0], 'X-Shop-Id'), 'test-shop-c');
    assert.deepEqual(preview, { grant: 'g', expiresAt: '2026-10-03T12:30:00.000Z' });
  });
});
