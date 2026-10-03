// The platform console's calls under Node (the CP5-FJ section of platform.js):
//   node --test src/api/admin/platformConsole.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import {
  decideScreening,
  deactivatePlatformUser,
  getPlatformUser,
  getTenantFeatures,
  handleReport,
  invitePlatformUser,
  listScreening,
  readAllPlatformUsers,
  readAllReports,
  readAllTenants,
  reactivatePlatformUser,
  putTenantFeatures,
  takedownReport,
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

beforeEach(() => {
  calls = [];
  // A shop is active in the tab: a platform call must still not carry it.
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

const noShopHeader = () => calls.every((c) => !('x-shop-id' in c.init.headers));

describe('no call carries a shop (D70)', () => {
  it('reads and writes alike', async () => {
    stubFetch(() => answer(200, { features: [], users: [], reports: [], screening: [], user: {}, report: {}, nextCursor: null }));
    await getTenantFeatures('test-shop-a');
    await putTenantFeatures('test-shop-a', { pod: true });
    await readAllPlatformUsers(['tenant_admin']);
    await deactivatePlatformUser('u1');
    await readAllReports();
    await handleReport('r1', { status: 'rejected' });
    await listScreening();
    await decideScreening('p1', 'approved');
    assert.ok(calls.length >= 8);
    assert.ok(noShopHeader());
  });
});

describe('features', () => {
  it('the list of shops is read to its end', async () => {
    stubFetch((url) =>
      url.includes('cursor=b')
        ? answer(200, { tenants: [{ tenantId: 'c' }], nextCursor: null })
        : answer(200, { tenants: [{ tenantId: 'a' }, { tenantId: 'b' }], nextCursor: 'b' }));
    const all = await readAllTenants();
    assert.deepEqual(all.map((t) => t.tenantId), ['a', 'b', 'c']);
    assert.equal(calls[0].url, '/_api/v1/platform/tenants?limit=100');
    assert.equal(calls[1].url, '/_api/v1/platform/tenants?limit=100&cursor=b');
  });

  it('GET and PUT one shop\'s add-ons', async () => {
    const views = [{ key: 'pod', enabled: true, defaultEnabled: false, source: 'explicit' }];
    stubFetch(() => answer(200, { features: views, tenantId: 'test-shop-a' }));
    assert.deepEqual(await getTenantFeatures('test-shop-a'), views);
    assert.deepEqual(await putTenantFeatures('test-shop-a', { pod: true }), views);
    assert.equal(calls[1].init.method, 'PUT');
    assert.equal(calls[1].init.body, JSON.stringify({ features: { pod: true } }));
  });

  it('a refused key (400) rejects with the code', async () => {
    stubFetch(() => answer(400, { error: { code: 'invalid_request', message: 'bad' } }));
    await assert.rejects(putTenantFeatures('test-shop-a', { affiliate: true }), (e) => e.status === 400 && e.code === 'invalid_request');
  });

  it('a shop id is one path segment', async () => {
    stubFetch(() => answer(200, { features: [] }));
    await getTenantFeatures('a/../b');
    assert.equal(calls[0].url, '/_api/v1/platform/tenants/a%2F..%2Fb/features');
  });
});

describe('users', () => {
  it('one filtered read per account type, each to its end', async () => {
    stubFetch((url) => {
      if (url.includes('accountType=platform_admin')) return answer(200, { users: [{ userId: 'p1' }], nextCursor: null });
      return url.includes('cursor=t1')
        ? answer(200, { users: [{ userId: 't2' }], nextCursor: null })
        : answer(200, { users: [{ userId: 't1' }], nextCursor: 't1' });
    });
    const all = await readAllPlatformUsers(['platform_admin', 'tenant_admin']);
    assert.deepEqual(all.map((u) => u.userId).sort(), ['p1', 't1', 't2']);
  });

  it('the detail, and the three actions as POST without a body', async () => {
    stubFetch((url) => (url.endsWith('/invite') ? answer(202, { invite: { userId: 'u1', surface: 'admin', expiresAt: 'x' } }) : answer(200, { user: { userId: 'u1' } })));
    assert.deepEqual(await getPlatformUser('u1'), { userId: 'u1' });
    assert.deepEqual(await deactivatePlatformUser('u1'), { userId: 'u1' });
    assert.deepEqual(await reactivatePlatformUser('u1'), { userId: 'u1' });
    assert.equal((await invitePlatformUser('u1')).surface, 'admin');
    assert.deepEqual(calls.map((c) => [c.init.method, c.url.replace('/_api/v1/platform/users/u1', '')]),
      [['GET', ''], ['POST', '/deactivate'], ['POST', '/reactivate'], ['POST', '/invite']]);
    assert.equal(calls[1].init.body, undefined);
  });

  it('a refusal rejects with the server\'s code (D63)', async () => {
    stubFetch(() => answer(409, { error: { code: 'platform_admin_reactivation', message: 'no' } }));
    await assert.rejects(reactivatePlatformUser('u1'), (e) => e.status === 409 && e.code === 'platform_admin_reactivation');
  });
});

describe('reports and the screening queue', () => {
  it('the list, a status filter, and the handle body', async () => {
    stubFetch((url) => (url.includes('/handle') ? answer(200, { report: { reportId: 'r1', status: 'rejected' } }) : answer(200, { reports: [{ reportId: 'r1' }], nextCursor: null, newCount: 1 })));
    assert.equal((await readAllReports({ status: 'new' })).length, 1);
    assert.equal(calls[0].url, '/_api/v1/platform/reports?status=new&limit=100');
    await handleReport('r1', { status: 'rejected', note: '' });
    await handleReport('r1', { status: 'reviewing' });
    assert.equal(calls[1].init.body, JSON.stringify({ status: 'rejected', note: '' }));
    assert.equal(calls[2].init.body, JSON.stringify({ status: 'reviewing' }));
  });

  it('the takedown sends only what is given; a 409 rejects with its code', async () => {
    stubFetch(() => answer(200, { report: { reportId: 'r1' }, screening: { productId: 'p1' } }));
    const out = await takedownReport('r1', { productId: 'p1', note: 'x' });
    assert.equal(out.screening.productId, 'p1');
    assert.equal(calls[0].init.body, JSON.stringify({ productId: 'p1', note: 'x' }));
    await takedownReport('r1');
    assert.equal(calls[1].init.body, JSON.stringify({}));
    stubFetch(() => answer(409, { error: { code: 'report_closed', message: 'closed' } }));
    await assert.rejects(takedownReport('r1'), (e) => e.code === 'report_closed');
  });

  it('the queue and a decision', async () => {
    stubFetch((url) => (url.endsWith('/p1') ? answer(200, { screening: { productId: 'p1', status: 'approved' } }) : answer(200, { screening: [{ productId: 'p1' }] })));
    assert.equal((await listScreening()).length, 1);
    assert.equal(calls[0].url, '/_api/v1/platform/screening');
    assert.equal((await decideScreening('p1', 'approved')).status, 'approved');
    assert.equal(calls[1].init.body, JSON.stringify({ decision: 'approved' }));
  });
});
