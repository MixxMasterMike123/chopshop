// The list walks builder F1 added to the client, under Node:
//   node --test src/api/lists.test.mjs
// fetch and location are stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { listAllPages, listPages, MAX_PAGE_LIST_PAGES } from './pages.js';
import { getWholeCollection, listCollections, MAX_COLLECTION_PAGES } from './collections.js';

const realFetch = globalThis.fetch;
let calls;

function stubFetch(handler) {
  globalThis.fetch = async (url) => {
    calls.push(url);
    const { status = 200, body } = handler(new URL(url, 'https://web.example.test'), calls.length);
    return new Response(JSON.stringify(body), { status });
  };
}

beforeEach(() => {
  calls = [];
  globalThis.location = { pathname: '/provbutiken/om-oss' };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.location;
});

describe('pages', () => {
  it('listPages asks for a kind, a language and a page', async () => {
    stubFetch(() => ({ body: { pages: [{ slug: 'a' }], nextCursor: 'c1' } }));
    const result = await listPages({ kind: 'page', lang: 'sv-SE', limit: 5 });
    assert.deepEqual(result, { pages: [{ slug: 'a' }], nextCursor: 'c1' });
    assert.equal(calls[0], '/_api/provbutiken/v1/pages?kind=page&lang=sv-SE&limit=5');
  });

  it('listAllPages follows the cursor to the end, 100 at a time', async () => {
    stubFetch((url, n) => ({
      body: { pages: [{ slug: `p${n}` }], nextCursor: n < 3 ? `c${n}` : null },
    }));
    const pages = await listAllPages({ kind: 'page' });
    assert.deepEqual(pages.map((p) => p.slug), ['p1', 'p2', 'p3']);
    assert.deepEqual(calls, [
      '/_api/provbutiken/v1/pages?kind=page&limit=100',
      '/_api/provbutiken/v1/pages?kind=page&cursor=c1&limit=100',
      '/_api/provbutiken/v1/pages?kind=page&cursor=c2&limit=100',
    ]);
  });

  it('listAllPages stops after its maximum of pages', async () => {
    stubFetch((url, n) => ({ body: { pages: [{ slug: `p${n}` }], nextCursor: `c${n}` } }));
    const pages = await listAllPages({ kind: 'page' });
    assert.equal(pages.length, MAX_PAGE_LIST_PAGES);
  });
});

describe('getWholeCollection', () => {
  it('walks every page of the collection\'s products', async () => {
    stubFetch((url, n) => ({
      body: {
        collection: { handle: 'sommar' },
        products: [{ productId: `p${n}` }],
        nextCursor: n < 2 ? `k${n}` : null,
      },
    }));
    const whole = await getWholeCollection('sommar');
    assert.deepEqual(whole, { collection: { handle: 'sommar' }, products: [{ productId: 'p1' }, { productId: 'p2' }] });
    assert.deepEqual(calls, [
      '/_api/provbutiken/v1/collections/sommar?limit=100',
      '/_api/provbutiken/v1/collections/sommar?cursor=k1&limit=100',
    ]);
  });

  it('is null for a collection the API does not answer', async () => {
    stubFetch(() => ({ status: 404, body: { error: { code: 'not_found', message: 'Collection not found' } } }));
    assert.equal(await getWholeCollection('saknas'), null);
  });

  it('stops after its maximum of pages', async () => {
    stubFetch((url, n) => ({ body: { collection: { handle: 'x' }, products: [{ productId: `p${n}` }], nextCursor: `k${n}` } }));
    const whole = await getWholeCollection('x');
    assert.equal(whole.products.length, MAX_COLLECTION_PAGES);
  });
});

describe('listCollections', () => {
  it('follows the cursor to the end, 100 at a time: a collection behind the first hundred is there', async () => {
    stubFetch((url, n) => ({
      body: { collections: [{ handle: `c${n}`, featured: n === 3 }], nextCursor: n < 3 ? `k${n}` : null },
    }));
    const collections = await listCollections();
    assert.deepEqual(collections.map((c) => c.handle), ['c1', 'c2', 'c3']);
    assert.equal(collections[2].featured, true);
    assert.deepEqual(calls, [
      '/_api/provbutiken/v1/collections?limit=100',
      '/_api/provbutiken/v1/collections?cursor=k1&limit=100',
      '/_api/provbutiken/v1/collections?cursor=k2&limit=100',
    ]);
  });

  it('stops after its maximum of pages', async () => {
    stubFetch((url, n) => ({ body: { collections: [{ handle: `c${n}` }], nextCursor: `k${n}` } }));
    assert.equal((await listCollections()).length, MAX_COLLECTION_PAGES);
  });
});
