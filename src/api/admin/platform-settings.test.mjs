// The CP5-FL calls under Node: the platform settings, the brand filter and the
// terms versions (platform.js, never X-Shop-Id), and the shop's forwards
// (redirects.js, always X-Shop-Id: the shop named, else the active one).
//   node --test src/api/admin/platform-settings.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AdminApiError, setRequestShopId } from './client.js';
import {
  addScreeningTerm,
  archiveTermsVersionText,
  deleteScreeningTerm,
  getPlatformSettings,
  getTermsVersionText,
  listTermsVersions,
  patchPlatformSettings,
  publishTermsVersion,
  readAllScreeningTerms,
  rescreenStale,
  updateScreeningTerm,
} from './platform.js';
import { deleteRedirects, listRedirects, putRedirects } from './redirects.js';

const realFetch = globalThis.fetch;
let calls;

const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return handler(url, init);
  };
}

beforeEach(() => {
  calls = [];
  setRequestShopId('test-shop-a'); // a shop active in the tab
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

const noShop = () => calls.length > 0 && calls.every((c) => !('x-shop-id' in c.init.headers) && c.init.credentials === 'same-origin');

describe('the platform settings', () => {
  it('GET reads { settings }; PATCH sends the named fields only and reads { settings, rescreen }', async () => {
    stubFetch(() => answer(200, { settings: { defaultCommissionBps: 500 } }));
    assert.deepEqual(await getPlatformSettings(), { defaultCommissionBps: 500 });
    stubFetch(() => answer(200, { settings: { defaultCommissionBps: 600 }, rescreen: null }));
    assert.deepEqual(await patchPlatformSettings({ defaultCommissionBps: 600 }), { settings: { defaultCommissionBps: 600 }, rescreen: null });
    assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
      ['GET', '/_api/v1/platform/settings'],
      ['PATCH', '/_api/v1/platform/settings'],
    ]);
    assert.deepEqual(calls[1].body, { defaultCommissionBps: 600 });
    assert.ok(noShop());
  });

  it('a refusal keeps the field the Worker names', async () => {
    stubFetch(() => answer(400, { error: { code: 'setting_not_editable', field: 'refundApplicationFee', message: 'x' } }));
    await assert.rejects(patchPlatformSettings({ refundApplicationFee: true }),
      (e) => e instanceof AdminApiError && e.code === 'setting_not_editable' && e.details.field === 'refundApplicationFee');
  });
});

describe('the brand filter', () => {
  it('reads every page of 500 to the end of the cursor, the version from the first page', async () => {
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1
        ? answer(200, { terms: [{ term: 'a' }], nextCursor: 'YQ', termsVersion: 7 })
        : answer(200, { terms: [{ term: 'b' }], nextCursor: null, termsVersion: 8 });
    });
    assert.deepEqual(await readAllScreeningTerms(), { terms: [{ term: 'a' }, { term: 'b' }], termsVersion: 7 });
    assert.deepEqual(calls.map((c) => c.url), [
      '/_api/v1/platform/screening-terms?limit=500',
      '/_api/v1/platform/screening-terms?limit=500&cursor=YQ',
    ]);
    assert.ok(noShop());
  });

  it('POST, PATCH and DELETE address a term by its key; the rescreen is a bare POST', async () => {
    stubFetch(() => answer(201, { term: { term: 'x', termKey: 'eA' }, rescreen: { blockedNow: 0 } }));
    await addScreeningTerm({ term: 'X', kind: 'brand', hardBlock: false, note: null });
    stubFetch(() => answer(200, { term: { term: 'x' }, rescreen: null }));
    await updateScreeningTerm('eA', { hardBlock: true });
    stubFetch(() => answer(200, { deleted: true, rescreen: { blockedNow: 0 } }));
    assert.equal((await deleteScreeningTerm('eA')).deleted, true);
    stubFetch(() => answer(200, { rescreened: 3, pending: 0, unverified: 0 }));
    assert.deepEqual(await rescreenStale(), { rescreened: 3, pending: 0, unverified: 0 });
    assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
      ['POST', '/_api/v1/platform/screening-terms'],
      ['PATCH', '/_api/v1/platform/screening-terms/eA'],
      ['DELETE', '/_api/v1/platform/screening-terms/eA'],
      ['POST', '/_api/v1/platform/screening-terms/rescreen'],
    ]);
    assert.deepEqual(calls[0].body, { term: 'X', kind: 'brand', hardBlock: false }); // no note: not sent
    assert.deepEqual(calls[1].body, { hardBlock: true });
    assert.equal(calls[3].body, undefined);
    assert.ok(noShop());
  });
});

describe('the terms versions', () => {
  it('lists, publishes NOW (no publishedAt), reads and archives a text by the encoded label', async () => {
    stubFetch(() => answer(200, { versions: [{ version: '2026-09-07', current: true }] }));
    assert.deepEqual(await listTermsVersions(), [{ version: '2026-09-07', current: true }]);
    stubFetch(() => answer(201, { version: { version: 'v2' } }));
    assert.deepEqual(await publishTermsVersion({ version: 'v2', text: '{}' }), { version: 'v2' });
    stubFetch(() => answer(200, { version: 'v.2', text: null, textArchived: false }));
    await getTermsVersionText('v.2');
    stubFetch(() => answer(201, { version: { version: 'v2' } }));
    assert.deepEqual(await archiveTermsVersionText('v2', 'T'), { version: { version: 'v2' }, created: true });
    stubFetch(() => answer(200, { version: { version: 'v2' } }));
    assert.equal((await archiveTermsVersionText('v2', 'T')).created, false);
    assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
      ['GET', '/_api/v1/platform/legal/terms-versions'],
      ['POST', '/_api/v1/platform/legal/terms-versions'],
      ['GET', '/_api/v1/platform/legal/terms-versions/v.2/text'],
      ['PUT', '/_api/v1/platform/legal/terms-versions/v2/text'],
      ['PUT', '/_api/v1/platform/legal/terms-versions/v2/text'],
    ]);
    assert.deepEqual(calls[1].body, { version: 'v2', text: '{}' });
    assert.deepEqual(calls[3].body, { text: 'T' });
    assert.ok(noShop());
  });
});

describe('the shop\'s forwards', () => {
  it('every call carries the named shop (else the active one)', async () => {
    stubFetch(() => answer(200, { redirects: [{ fromPath: '/a', toPath: '/b' }], nextCursor: 'Lw' }));
    assert.deepEqual(await listRedirects({ shopId: 'test-shop-c', cursor: 'L2E', limit: 100 }),
      { redirects: [{ fromPath: '/a', toPath: '/b' }], nextCursor: 'Lw' });
    stubFetch(() => answer(200, { redirects: [{ fromPath: '/a', toPath: '/b' }] }));
    assert.deepEqual(await putRedirects([{ fromPath: '/a', toPath: '/b' }], { shopId: 'test-shop-c' }), [{ fromPath: '/a', toPath: '/b' }]);
    stubFetch(() => new Response(null, { status: 204 }));
    await deleteRedirects(['/a']);
    assert.deepEqual(calls.map((c) => [c.init.method, c.url, c.init.headers['x-shop-id']]), [
      ['GET', '/_api/v1/admin/redirects?cursor=L2E&limit=100', 'test-shop-c'],
      ['PUT', '/_api/v1/admin/redirects', 'test-shop-c'],
      ['DELETE', '/_api/v1/admin/redirects', 'test-shop-a'],
    ]);
    assert.deepEqual(calls[1].body, { redirects: [{ fromPath: '/a', toPath: '/b' }] });
    assert.deepEqual(calls[2].body, { fromPaths: ['/a'] });
  });

  it('without a shop nothing is sent', async () => {
    setRequestShopId(null);
    stubFetch(() => answer(200, {}));
    await assert.rejects(listRedirects(), (e) => e.code === 'no_shop');
    assert.equal(calls.length, 0);
  });

  it('a refusal keeps the per-entry problems', async () => {
    stubFetch(() => answer(400, { error: { code: 'refused_redirects', message: 'x', problems: [{ index: 0, reason: 'chain' }] } }));
    await assert.rejects(putRedirects([{ fromPath: '/a', toPath: '/b' }]),
      (e) => e.code === 'refused_redirects' && e.details.problems[0].reason === 'chain');
  });
});
