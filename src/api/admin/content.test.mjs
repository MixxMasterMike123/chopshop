// The collection and page calls against a fake fetch: node --test src/api/admin/content.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import {
  createCollection,
  createPage,
  deleteCollection,
  getCollection,
  getPage,
  listAllCollections,
  listAllPages,
  setCollectionProducts,
  updateCollection,
} from './content.js';

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

describe('the collection routes', () => {
  it('the list follows the cursor to its end, naming the shop', async () => {
    script.push(() => answer(200, { collections: [{ collectionId: 'a' }], nextCursor: 'c1' }));
    script.push(() => answer(200, { collections: [{ collectionId: 'b' }], nextCursor: null }));
    const all = await listAllCollections();
    assert.deepEqual(all.map((c) => c.collectionId), ['a', 'b']);
    assert.equal(calls[0].url, '/_api/v1/admin/collections?limit=100');
    assert.equal(calls[1].url, '/_api/v1/admin/collections?cursor=c1&limit=100');
    assert.equal(calls[0].init.headers['x-shop-id'], 'test-shop-a');
  });

  it('create, patch, members and delete go to their routes', async () => {
    script.push(() => answer(201, { collection: { collectionId: 'n' } }));
    script.push(() => answer(200, { collection: { collectionId: 'n' } }));
    script.push(() => answer(200, { collection: { collectionId: 'n' } }));
    script.push(() => answer(204));
    await createCollection({ title: 'X' });
    await updateCollection('a b', { featured: true });
    await setCollectionProducts('n', ['p1', 'p2']);
    await deleteCollection('n');
    assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
      ['POST', '/_api/v1/admin/collections'],
      ['PATCH', '/_api/v1/admin/collections/a%20b'],
      ['PUT', '/_api/v1/admin/collections/n/products'],
      ['DELETE', '/_api/v1/admin/collections/n'],
    ]);
    assert.deepEqual(JSON.parse(calls[2].init.body), ['p1', 'p2']);
  });

  it('an unknown collection is null, not an error', async () => {
    script.push(() => answer(404, { error: { code: 'not_found' } }));
    script.push(() => answer(200, { error: null }));
    // the session check after a 404 asks /v1/me: a live session
    assert.equal(await getCollection('nope'), null);
  });

  it('a refusal keeps the API code', async () => {
    script.push(() => answer(409, { error: { code: 'handle_taken', message: 'x' } }));
    await assert.rejects(() => createCollection({ title: 'X' }), (e) => e.status === 409 && e.code === 'handle_taken');
  });
});

describe('the page routes', () => {
  it('the list narrows by status; create reads the refusal of the content', async () => {
    script.push(() => answer(200, { pages: [{ pageId: 'p' }], nextCursor: null }));
    script.push(() => answer(400, { error: { code: 'content_refused', reason: 'script', language: 'sv-SE' } }));
    assert.equal((await listAllPages({ status: 'published' })).length, 1);
    assert.equal(calls[0].url, '/_api/v1/admin/pages?status=published&limit=100');
    await assert.rejects(
      () => createPage({ slug: 'x', title: { 'sv-SE': 'X' }, content: { 'sv-SE': '<script>' } }),
      (e) => e.code === 'content_refused' && e.details.reason === 'script' && e.details.language === 'sv-SE',
    );
  });

  it('an unknown page is null', async () => {
    script.push(() => answer(404, { error: { code: 'not_found' } }));
    script.push(() => answer(200, {}));
    assert.equal(await getPage('nope'), null);
  });
});
