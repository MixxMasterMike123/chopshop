// node --test src/api/admin/settings.test.mjs — the settings and legal-pages
// calls, and saveShopConfig's fenced partial write, against a stubbed fetch.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import { getSettings, putSettings } from './settings.js';
import { acceptLegalPages, getLegalPagesAcceptance, getLegalPagesStatus } from './legal.js';
import { loadShopConfig, saveShopConfig } from '../../admin-app/replacements/shopConfig.js';
import { STORE } from '../../config/store.js';

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

describe('saveShopConfig: the fenced partial write (CP5-FP)', () => {
  const T1 = '2026-10-01T09:00:00.000Z';
  const T2 = '2026-10-01T09:00:05.000Z';
  const stored = () => ({
    storeIdentity: { menu: [1], tagline: 'same', legal: { custom: { kopvillkor: true } } },
    returnAddress: null, vatRegistered: null, vatNumber: null, sellerType: null, updatedAt: T1,
  });

  /** The shop's settings and shop reads, then `onWrite` for the PATCH. */
  function serve(onWrite, settings = stored()) {
    stubFetch((url, init, n) => {
      if (init.method === 'PATCH') return onWrite(bodyOf({ init }), n);
      return answer(200, url.endsWith('/shop') ? { shop: { tenantId: 'test-shop-a', shopName: 'A' } } : { settings });
    });
  }

  it('loads, then PATCHes only what the patch changes, merged into the stored object, fenced on the read', async () => {
    serve((body) => answer(200, { settings: { ...stored(), storeIdentity: { ...stored().storeIdentity, ...body.storeIdentity }, returnAddress: body.returnAddress, updatedAt: T2 } }));
    await loadShopConfig('test-shop-a');
    const outcome = await saveShopConfig({
      tagline: 'same', shopName: 'never', logoUrl: '/images/logo.svg', returnAddress: ' R ', vatRegistered: null,
      legal: { customTexts: { kopvillkor: '<p>x</p>' } },
    }, 'test-shop-a');
    const patches = calls.filter((c) => c.init.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.equal(headerOf(patches[0], 'x-shop-id'), 'test-shop-a');
    assert.deepEqual(bodyOf(patches[0]), {
      expectedUpdatedAt: T1,
      storeIdentity: { legal: { custom: { kopvillkor: true }, customTexts: { kopvillkor: '<p>x</p>' } } },
      returnAddress: 'R',
    });
    assert.equal(outcome.readBack, false);
    assert.equal(outcome.saved.returnAddress, 'R');
  });

  it('the second save is fenced on the first one\'s answer', async () => {
    serve((body, n) => answer(200, { settings: { ...stored(), storeIdentity: { ...stored().storeIdentity, ...body.storeIdentity }, updatedAt: `2026-10-01T09:00:0${n}.000Z` } }));
    await loadShopConfig('test-shop-a');
    await Promise.all([
      saveShopConfig({ legal: { customTexts: { kopvillkor: 'a' } } }, 'test-shop-a'),
      saveShopConfig({ tagline: 'b' }, 'test-shop-a'),
    ]);
    const patches = calls.filter((c) => c.init.method === 'PATCH').map(bodyOf);
    assert.equal(patches.length, 2);
    assert.equal(patches[0].expectedUpdatedAt, T1);
    assert.notEqual(patches[1].expectedUpdatedAt, T1);
    assert.deepEqual(Object.keys(patches[1].storeIdentity), ['tagline']);
  });

  it('nothing changed: no request', async () => {
    serve(() => answer(500, {}));
    await loadShopConfig('test-shop-a');
    await saveShopConfig({ tagline: 'same', menu: [1], social: STORE.social }, 'test-shop-a');
    assert.equal(calls.filter((c) => c.init.method === 'PATCH').length, 0);
  });

  it('a page whose load failed saves nothing', async () => {
    setRequestShopId('test-shop-b');
    stubFetch(() => answer(500, {}));
    await assert.rejects(loadShopConfig('test-shop-b'));
    await assert.rejects(saveShopConfig({ tagline: 'x' }, 'test-shop-b'), (e) => /kunde inte läsas när sidan öppnades/.test(e.userMessage));
    assert.equal(calls.filter((c) => c.init.method === 'PATCH').length, 0);
  });

  it('a refusal does not stop the next save', async () => {
    serve((_body, n) => (n === 3 ? answer(400, { error: { code: 'invalid_request' } }) : answer(200, { settings: { ...stored(), updatedAt: T2 } })));
    await loadShopConfig('test-shop-a');
    await assert.rejects(saveShopConfig({ a: 1 }, 'test-shop-a'), (e) => e.code === 'invalid_request');
    await saveShopConfig({ a: 2 }, 'test-shop-a');
    assert.equal(calls.filter((c) => c.init.method === 'PATCH').length, 2);
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
