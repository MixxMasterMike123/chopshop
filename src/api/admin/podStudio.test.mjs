// The studio's asset reads against a fake fetch: node --test src/api/admin/podStudio.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AdminApiError, setRequestShopId } from './client.js';
import { list3dModels, listMockupTemplates } from './podStudio.js';

const realFetch = globalThis.fetch;
let calls;
let script;

const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

beforeEach(() => {
  calls = [];
  script = [];
  setRequestShopId('test-shop-a');
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    return next(url, init);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('the studio asset reads', () => {
  it('read the templates and the models of the shop, with its header', async () => {
    script.push(
      () => answer(200, { provisional: true, templates: [{ id: 't' }] }),
      () => answer(200, { models: [{ id: 'm' }] }),
    );
    assert.deepEqual(await listMockupTemplates(), { provisional: true, templates: [{ id: 't' }] });
    assert.deepEqual(await list3dModels({ shopId: 'test-shop-b' }), [{ id: 'm' }]);
    assert.deepEqual(calls.map((c) => [c.init.method ?? 'GET', c.url, c.init.headers['x-shop-id']]), [
      ['GET', '/_api/v1/admin/pod/mockup-templates', 'test-shop-a'],
      ['GET', '/_api/v1/admin/pod/3d-models', 'test-shop-b'],
    ]);
  });

  it('a missing list reads as empty, and provisional only when the server says true', async () => {
    script.push(() => answer(200, {}), () => answer(200, { models: 'x' }));
    assert.deepEqual(await listMockupTemplates(), { provisional: false, templates: [] });
    assert.deepEqual(await list3dModels(), []);
  });

  it('a refused read rejects (a failed read is not an empty list)', async () => {
    script.push(() => answer(500, { error: { code: 'internal', message: 'x' } }));
    await assert.rejects(listMockupTemplates(), (e) => e instanceof AdminApiError && e.status === 500);
  });

  it('asks nothing without a shop', async () => {
    setRequestShopId(null);
    await assert.rejects(listMockupTemplates(), (e) => e.code === 'no_shop');
    assert.equal(calls.length, 0);
  });
});
