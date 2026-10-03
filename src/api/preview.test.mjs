// The preview grant in the storefront client (D57), under Node:
//   node --test src/api/preview.test.mjs
// location, history, sessionStorage and fetch are stubbed per test.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { capturePreviewGrant, clearPreviewGrant, PREVIEW_HEADER, previewGrant, request } from './client.js';

const SIGNATURE = 'A'.repeat(43);
const realFetch = globalThis.fetch;
let calls;
let replaced;
let store;

function grantUntil(expiresAt) {
  return `v1.${expiresAt}.${SIGNATURE}`;
}

function at(pathname, hash = '', search = '') {
  globalThis.location = { hash, pathname, search };
}

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

beforeEach(() => {
  calls = [];
  replaced = [];
  store = memoryStorage();
  globalThis.sessionStorage = store;
  globalThis.history = {
    replaceState: (state, _title, url) => replaced.push({ state, url }),
    state: { key: 'router-key' },
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ init, url });
    return new Response('{}', { status: 200 });
  };
  at('/sillmans/');
  clearPreviewGrant();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.location;
  delete globalThis.history;
  delete globalThis.sessionStorage;
});

describe('the preview grant', () => {
  it('is taken from the fragment, kept for the tab and removed from the address', () => {
    const grant = grantUntil(Date.now() + 60_000);
    at('/sillmans/product/mugg', `#preview=${grant}`, '?ref=x');
    assert.equal(previewGrant(), grant);
    assert.deepEqual(replaced, [{ state: { key: 'router-key' }, url: '/sillmans/product/mugg?ref=x' }]);
    assert.deepEqual(JSON.parse(store.data.get('storefront-preview')), { grant, root: '/sillmans' });
    // The address no longer holds it; the tab still does.
    at('/sillmans/produkter');
    assert.equal(previewGrant(), grant);
  });

  it('keeps the other parameters of the fragment', () => {
    const grant = grantUntil(Date.now() + 60_000);
    at('/sillmans/', `#a=1&preview=${grant}&b=2`);
    capturePreviewGrant();
    assert.equal(replaced[0].url, '/sillmans/#a=1&b=2');
  });

  it('is sent on every read, past the HTTP cache, and on no write', async () => {
    const grant = grantUntil(Date.now() + 60_000);
    at('/sillmans/', `#preview=${grant}`);
    await request('/v1/storefront');
    await request('/v1/checkout', { body: { items: [] }, method: 'POST' });
    assert.equal(calls[0].init.headers[PREVIEW_HEADER], grant);
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(calls[1].init.headers[PREVIEW_HEADER], undefined);
    assert.equal(calls[1].init.cache, undefined);
  });

  it('is not sent without a grant: reads use the HTTP cache as before', async () => {
    await request('/v1/products');
    assert.equal(calls[0].init.headers[PREVIEW_HEADER], undefined);
    assert.equal(calls[0].init.cache, undefined);
  });

  it("is the shop's own: another shop in the same tab gets nothing", async () => {
    at('/sillmans/', `#preview=${grantUntil(Date.now() + 60_000)}`);
    capturePreviewGrant();
    at('/melodie-mc/');
    assert.equal(previewGrant(), null);
    await request('/v1/storefront');
    assert.equal(calls[0].init.headers[PREVIEW_HEADER], undefined);
  });

  it('is forgotten when it expires', () => {
    const expiresAt = Date.now() + 60_000;
    at('/sillmans/', `#preview=${grantUntil(expiresAt)}`);
    assert.notEqual(previewGrant(), null);
    assert.equal(previewGrant(expiresAt), null);
    assert.equal(store.data.has('storefront-preview'), false);
  });

  it('a malformed value leaves the address and is not kept', () => {
    for (const value of ['garbage', `v2.${Date.now() + 60_000}.${SIGNATURE}`, `v1.123.${SIGNATURE}`, '']) {
      replaced = [];
      at('/sillmans/', `#preview=${encodeURIComponent(value)}`);
      assert.equal(previewGrant(), null, value);
      assert.equal(replaced.length, 1, value);
    }
  });

  it('is held in memory when the storage refuses', () => {
    globalThis.sessionStorage = {
      getItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    const grant = grantUntil(Date.now() + 60_000);
    at('/sillmans/', `#preview=${grant}`);
    assert.equal(previewGrant(), grant);
    at('/sillmans/produkter'); // the address without the fragment, as replaceState left it
    assert.equal(previewGrant(), grant);
    clearPreviewGrant();
    assert.equal(previewGrant(), null);
  });

  it('works without history or storage at all (the fragment still taken)', () => {
    delete globalThis.history;
    delete globalThis.sessionStorage;
    const grant = grantUntil(Date.now() + 60_000);
    at('/sillmans/', `#preview=${grant}`);
    assert.equal(previewGrant(), grant);
  });
});
