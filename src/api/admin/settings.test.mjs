// node --test src/api/admin/settings.test.mjs — the settings and legal-pages
// calls, and saveShopConfig's read-modify-write, against a stubbed fetch.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import { getSettings, putSettings } from './settings.js';
import { acceptLegalPages, getLegalPagesAcceptance, getLegalPagesStatus } from './legal.js';
import { saveShopConfig } from '../../admin-app/replacements/shopConfig.js';

const realFetch = globalThis.fetch;
let calls;

const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const headerOf = (call, name) => call.init.headers[name];
const bodyOf = (call) => JSON.parse(call.init.body);

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
}

const TEXTS = { kopvillkor: '<h1>K</h1>', angerratt: '<h1>A</h1>', integritetspolicy: '<h1>I</h1>' };

beforeEach(() => {
  calls = [];
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('settings calls', () => {
  it('GET and PUT /v1/admin/settings with the shop header', async () => {
    stubFetch((_url, init) => answer(200, { settings: { storeIdentity: {}, method: init.method } }));
    assert.equal((await getSettings()).method, 'GET');
    assert.equal((await putSettings({ returnAddress: 'r' })).method, 'PUT');
    assert.deepEqual(calls.map((c) => c.url), ['/_api/v1/admin/settings', '/_api/v1/admin/settings']);
    assert.equal(headerOf(calls[1], 'x-shop-id'), 'test-shop-a');
    assert.deepEqual(bodyOf(calls[1]), { returnAddress: 'r' });
  });

  it('a refused identity key comes back with its keys', async () => {
    stubFetch(() => answer(400, { error: { code: 'refused_store_identity_keys', keys: ['shopName'], message: 'm' } }));
    await assert.rejects(putSettings({ storeIdentity: { shopName: 'x' } }), (e) => e.code === 'refused_store_identity_keys' && e.details.keys[0] === 'shopName');
  });
});

describe('saveShopConfig: read-modify-write', () => {
  it('reads, merges the patch into the stored identity, PUTs the whole identity', async () => {
    stubFetch((_url, init) => init.method === 'GET'
      ? answer(200, { settings: { storeIdentity: { menu: [1], legal: { custom: { kopvillkor: true } } }, returnAddress: null } })
      : answer(200, { settings: { storeIdentity: bodyOf({ init }).storeIdentity } }));
    await saveShopConfig({ tagline: 't', shopName: 'never', returnAddress: 'R', legal: { customTexts: { kopvillkor: '<p>x</p>' } } }, 'test-shop-a');
    assert.deepEqual(calls.map((c) => c.init.method), ['GET', 'PUT']);
    assert.deepEqual(bodyOf(calls[1]), {
      storeIdentity: { menu: [1], tagline: 't', legal: { custom: { kopvillkor: true }, customTexts: { kopvillkor: '<p>x</p>' } } },
      returnAddress: 'R',
    });
  });

  it('two saves in a row: the second reads what the first wrote', async () => {
    let stored = { storeIdentity: {} };
    stubFetch(async (_url, init) => {
      if (init.method === 'GET') return answer(200, { settings: structuredClone(stored) });
      await new Promise((r) => setTimeout(r, 5));
      stored = { ...stored, ...bodyOf({ init }) };
      return answer(200, { settings: stored });
    });
    await Promise.all([
      saveShopConfig({ legal: { customTexts: { kopvillkor: 'a' } } }, 'test-shop-a'),
      saveShopConfig({ tagline: 'b' }, 'test-shop-a'),
    ]);
    assert.deepEqual(calls.map((c) => c.init.method), ['GET', 'PUT', 'GET', 'PUT']);
    assert.deepEqual(stored.storeIdentity, { legal: { customTexts: { kopvillkor: 'a' } }, tagline: 'b' });
  });

  it('a failed save does not stop the next one', async () => {
    stubFetch((_url, init, n) => (n === 1 ? answer(500, {}) : answer(200, { settings: { storeIdentity: {} }, m: init.method })));
    await assert.rejects(saveShopConfig({ a: 1 }, 'test-shop-a'));
    await saveShopConfig({ a: 2 }, 'test-shop-a');
    assert.deepEqual(calls.map((c) => c.init.method), ['GET', 'GET', 'PUT']);
  });
});

describe('legal-pages calls', () => {
  it('status and acceptance reads', async () => {
    stubFetch((url) => answer(200, url.endsWith('/status') ? { accepted: true, readiness: { ready: true } } : { acceptance: null }));
    assert.equal((await getLegalPagesStatus()).accepted, true);
    assert.equal(await getLegalPagesAcceptance(), null);
    assert.deepEqual(calls.map((c) => c.url), ['/_api/v1/admin/legal/status', '/_api/v1/admin/legal/pages']);
  });

  it('accept-pages sends exactly { templateVersion, texts, pod, custom }', async () => {
    stubFetch(() => answer(201, { acceptance: { acceptanceId: 'a', acceptedAt: 't', templateVersion: '2026-09-07' } }));
    const acceptance = await acceptLegalPages({
      templateVersion: '2026-09-07', texts: TEXTS, pod: false,
      customPages: { kopvillkor: true, angerratt: false, integritetspolicy: false },
    });
    assert.equal(acceptance.acceptanceId, 'a');
    assert.equal(calls[0].url, '/_api/v1/admin/legal/accept-pages');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(headerOf(calls[0], 'x-shop-id'), 'test-shop-a');
    assert.deepEqual(bodyOf(calls[0]), {
      templateVersion: '2026-09-07',
      texts: TEXTS,
      pod: false,
      custom: { kopvillkor: true, angerratt: false, integritetspolicy: false },
    });
  });

  it('a malformed adoption is refused before anything is sent', async () => {
    stubFetch(() => answer(201, {}));
    await assert.rejects(acceptLegalPages({ templateVersion: '2026-09-07', texts: { kopvillkor: 'x' }, pod: false, customPages: {} }));
    assert.equal(calls.length, 0);
  });
});
