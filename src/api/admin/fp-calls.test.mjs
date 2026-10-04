// node --test src/api/admin/fp-calls.test.mjs — the calls of unit CP5-FP
// against a stubbed fetch: method, address, body, and X-Shop-Id on every
// admin call and never on a platform call.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import { patchSettings } from './settings.js';
import { getConnectBalance } from './payments.js';
import { resendMemberInvite } from './members.js';
import { getPrinter, listPrintJobs, previewPrinterPatch, readAllTenants, setPrintJobStatus } from './platform.js';

const realFetch = globalThis.fetch;
let calls;

const answer = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return handler(url, init);
  };
}

beforeEach(() => {
  calls = [];
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('admin calls (X-Shop-Id)', () => {
  it('PATCH /v1/admin/settings; a 409 conflict carries the stored settings', async () => {
    stubFetch(() => answer(200, { settings: { updatedAt: 'b' } }));
    assert.deepEqual(await patchSettings({ expectedUpdatedAt: 'a', storeIdentity: { tagline: 't' } }), { settings: { updatedAt: 'b' } });
    assert.equal(calls[0].init.method, 'PATCH');
    assert.equal(calls[0].url, '/_api/v1/admin/settings');
    assert.equal(calls[0].init.headers['x-shop-id'], 'test-shop-a');
    stubFetch(() => answer(409, { error: { code: 'conflict', message: 'm' }, settings: { updatedAt: 'c', storeIdentity: { tagline: 'x' } } }));
    await assert.rejects(patchSettings({ expectedUpdatedAt: 'a', storeIdentity: { tagline: 't' } }),
      (e) => e.code === 'conflict' && e.stored.updatedAt === 'c' && e.stored.storeIdentity.tagline === 'x');
  });

  it('GET …/connect/balance; a 429 carries Retry-After', async () => {
    stubFetch(() => answer(200, { balance: { available: [], pending: [], payoutSchedule: null, retrievedAt: 't' } }));
    assert.equal((await getConnectBalance({ shopId: 'test-shop-c' })).retrievedAt, 't');
    assert.equal(calls[0].url, '/_api/v1/admin/payments/connect/balance');
    assert.equal(calls[0].init.headers['x-shop-id'], 'test-shop-c');
    stubFetch(() => answer(429, { error: { code: 'rate_limited' } }, { 'retry-after': '60' }));
    await assert.rejects(getConnectBalance(), (e) => e.status === 429 && e.retryAfterSeconds === 60);
  });

  it('POST …/members/:userId/resend-invite, the id encoded, no body', async () => {
    stubFetch(() => answer(202, { invite: { userId: 'u/1', surface: 'admin', expiresAt: 'x' } }));
    assert.equal((await resendMemberInvite({ shopId: 'test-shop-a', userId: 'u/1' })).surface, 'admin');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].url, '/_api/v1/admin/members/u%2F1/resend-invite');
    assert.equal(calls[0].init.body, undefined);
  });
});

describe('platform calls (never X-Shop-Id)', () => {
  it('the directory with ?counts=1', async () => {
    stubFetch(() => answer(200, { tenants: [{ tenantId: 'a', counts: { products: 1 } }], nextCursor: null }));
    const rows = await readAllTenants({ counts: true });
    assert.equal(rows[0].counts.products, 1);
    assert.equal(calls[0].url, '/_api/v1/platform/tenants?counts=1&limit=100');
    assert.equal('x-shop-id' in calls[0].init.headers, false);
    await readAllTenants();
    assert.equal(calls[1].url, '/_api/v1/platform/tenants?limit=100');
  });

  it('the printer PATCH\'s dry run, and the single read (404 → null)', async () => {
    stubFetch(() => answer(200, { dryRun: true, diff: { fields: [] }, revision: 7, suspendedMappings: 2 }));
    assert.deepEqual(await previewPrinterPatch('fake-printer', { expectedRevision: 7, tiers: { remove: ['X'] } }),
      { diff: { fields: [] }, revision: 7, suspendedMappings: 2 });
    assert.deepEqual(calls[0].body, { expectedRevision: 7, tiers: { remove: ['X'] }, dryRun: true });
    assert.equal(calls[0].init.method, 'PATCH');
    stubFetch((url) => (url.endsWith('/v1/me') ? answer(200, { user: {} }) : answer(404, { error: { code: 'not_found' } })));
    assert.equal(await getPrinter('gone'), null);
    assert.ok(calls.every((c) => !('x-shop-id' in c.init.headers)));
  });

  it('the print jobs: one value per filter, and the status', async () => {
    stubFetch(() => answer(200, { jobs: [{ jobId: 'j' }], nextCursor: 'j' }));
    const page = await listPrintJobs({ dispatchState: 'accepted', tenantId: 'test-shop-a', cursor: 'c', limit: 50, state: undefined });
    assert.deepEqual(page, { jobs: [{ jobId: 'j' }], nextCursor: 'j' });
    assert.equal(calls[0].url, '/_api/v1/platform/print-jobs?dispatchState=accepted&tenantId=test-shop-a&cursor=c&limit=50');
    stubFetch(() => answer(200, { changed: true, orderShipped: true, job: { state: 'shipped' } }));
    assert.deepEqual(await setPrintJobStatus('o-1', { state: 'shipped', trackingNumber: 'T' }), { job: { state: 'shipped' }, changed: true, orderShipped: true });
    assert.equal(calls[1].url, '/_api/v1/platform/print-jobs/o-1/status');
    assert.deepEqual(calls[1].body, { state: 'shipped', trackingNumber: 'T' });
    assert.ok(calls.every((c) => !('x-shop-id' in c.init.headers)));
  });
});
