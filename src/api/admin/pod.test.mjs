// The POD calls against a fake fetch: node --test src/api/admin/pod.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import {
  createArtwork,
  createMapping,
  deleteArtwork,
  deleteMapping,
  getArtwork,
  getDesignQuote,
  listArtwork,
  listMappings,
  listPrinters,
  listProfiles,
  renameArtwork,
} from './pod.js';

const realFetch = globalThis.fetch;
let calls;
let script;

const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

beforeEach(() => {
  calls = [];
  script = [];
  setRequestShopId('test-shop-a');
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    return next(url, init);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('the POD routes', () => {
  it('every request names the shop and goes to the admin POD path', async () => {
    script.push(
      () => answer(200, { profiles: [{ profileId: 'apparel_dtg' }] }),
      () => answer(200, { artwork: [{ artworkId: 'a' }] }),
      () => answer(200, { printers: [] }),
      () => answer(200, { mappings: [] }),
    );
    assert.equal((await listProfiles()).length, 1);
    assert.equal((await listArtwork()).length, 1);
    await listPrinters();
    await listMappings({ productId: 'p 1' });
    assert.deepEqual(calls.map((c) => c.url), [
      '/_api/v1/admin/pod/profiles',
      '/_api/v1/admin/pod/artwork',
      '/_api/v1/admin/pod/printers',
      '/_api/v1/admin/pod/mappings?productId=p+1',
    ]);
    assert.ok(calls.every((c) => c.init.headers['x-shop-id'] === 'test-shop-a'));
  });

  it('an explicit shop wins over the tab\'s', async () => {
    script.push(() => answer(200, { artwork: [] }));
    await listArtwork({ shopId: 'test-shop-c' });
    assert.equal(calls[0].init.headers['x-shop-id'], 'test-shop-c');
  });

  it('the detail: the artwork and its preview; a failed render as failed; the opaque 404 as null', async () => {
    script.push(
      () => answer(200, { artwork: { artworkId: 'a/1', status: 'ready' }, previewUrl: 'https://r2.example/p' }),
      () => answer(200, { artwork: { artworkId: 'b', status: 'failed', reason: 'render_failed' }, previewUrl: null }),
      () => answer(404, { error: { code: 'not_found' } }),
      () => answer(200, { user: {} }), // the client's /v1/me check after a 404: still signed in
    );
    assert.deepEqual(await getArtwork('a/1'), { artwork: { artworkId: 'a/1', status: 'ready' }, previewUrl: 'https://r2.example/p' });
    assert.equal(calls[0].url, '/_api/v1/admin/pod/artwork/a%2F1');
    assert.equal((await getArtwork('b')).artwork.status, 'failed');
    assert.equal(await getArtwork('c'), null);
  });

  it('an upload is never sent without the uploader\'s own rights confirmation', async () => {
    for (const rightsConfirmed of [undefined, false, 'true', 1, null]) {
      await assert.rejects(createArtwork({ objectId: 'o', profileId: 'p', rightsConfirmed }), (e) => e.code === 'rights_not_confirmed');
    }
    assert.equal(calls.length, 0);
  });

  it('the upload body: objectId, profileId, rightsConfirmed true and the label; 202 = processing', async () => {
    script.push(() => answer(202, { artwork: { artworkId: 'n', status: 'processing' } }));
    const created = await createArtwork({ objectId: 'o', profileId: 'apparel_dtg', rightsConfirmed: true, label: 'Logga' });
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(calls[0].body, { objectId: 'o', profileId: 'apparel_dtg', rightsConfirmed: true, label: 'Logga' });
    assert.deepEqual(created, { status: 202, artwork: { artworkId: 'n', status: 'processing' } });
  });

  it('no label is no key (the API stores none)', async () => {
    script.push(() => answer(202, { artwork: { artworkId: 'n', status: 'processing' } }));
    await createArtwork({ objectId: 'o', profileId: 'apparel_dtg', rightsConfirmed: true, label: null });
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['objectId', 'profileId', 'rightsConfirmed']);
  });

  it('rename sends only the label; delete; a refusal keeps its status and code', async () => {
    script.push(
      () => answer(200, { artwork: { artworkId: 'a', label: 'Ny' } }),
      () => answer(204),
      () => answer(409, { error: { code: 'conflict', message: 'Artwork is used by a POD mapping' } }),
    );
    assert.equal((await renameArtwork('a', 'Ny')).label, 'Ny');
    assert.deepEqual(calls[0].body, { label: 'Ny' });
    assert.equal(calls[0].init.method, 'PATCH');
    await deleteArtwork('a');
    assert.equal(calls[1].init.method, 'DELETE');
    await assert.rejects(deleteArtwork('a'), (e) => e.status === 409 && e.code === 'conflict');
  });

  it('a mapping: the body as the route takes it; 201 = created; the scope\'s quote passed on', async () => {
    script.push(
      () => answer(201, { mapping: { mappingId: 'm' }, inkopMinor: 14000, priceFloorMinor: 25300, currency: 'SEK' }),
      () => answer(200, { mapping: { mappingId: 'm' }, inkopMinor: 10000, priceFloorMinor: 19700, currency: 'SEK' }),
    );
    const a = await createMapping({ productId: 'p', artworkId: 'a', printerId: 'x', sku: 'K', slots: ['front', 'back'] });
    assert.deepEqual(calls[0].body, { productId: 'p', artworkId: 'a', printerId: 'x', sku: 'K', slots: ['front', 'back'] });
    assert.deepEqual(a, { created: true, mapping: { mappingId: 'm' }, quote: { inkopMinor: 14000, priceFloorMinor: 25300, currency: 'SEK' } });
    const b = await createMapping({ productId: 'p', variantId: 'v', artworkId: 'a', printerId: 'x', sku: 'K', slots: ['front'] });
    assert.equal(calls[1].body.variantId, 'v');
    assert.equal(b.created, false);
  });

  it('a mapping refusal rejects with its code', async () => {
    script.push(() => answer(422, { error: { code: 'price_below_floor', message: 'x' } }));
    await assert.rejects(
      createMapping({ productId: 'p', artworkId: 'a', printerId: 'x', sku: 'K', slots: ['front'] }),
      (e) => e.status === 422 && e.code === 'price_below_floor',
    );
  });

  it('removing a mapping', async () => {
    script.push(() => answer(204));
    await deleteMapping('m 1');
    assert.equal(calls[0].url, '/_api/v1/admin/pod/mappings/m%201');
    assert.equal(calls[0].init.method, 'DELETE');
  });

  it('the design quote: printer, article and slots once each; only the two numbers come back', async () => {
    script.push(() => answer(200, { inkopMinor: 14000, priceFloorMinor: 25300, currency: 'SEK', blankMinor: 6000 }));
    const quote = await getDesignQuote({ printerId: 'fake-printer', sku: '2700003', slots: ['front', 'back'] });
    const url = new URL(calls[0].url, 'http://x');
    assert.equal(url.pathname, '/_api/v1/admin/pod/design-quote');
    assert.deepEqual([...url.searchParams.entries()], [['printerId', 'fake-printer'], ['sku', '2700003'], ['slots', 'front,back']]);
    assert.deepEqual(quote, { inkopMinor: 14000, priceFloorMinor: 25300, currency: 'SEK' });
  });

  it('the design quote\'s refusal rejects with its code', async () => {
    script.push(() => answer(422, { error: { code: 'slot_not_printable', message: 'This choice cannot be produced' } }));
    await assert.rejects(getDesignQuote({ printerId: 'x', sku: 'K', slots: ['left_sleeve'] }), (e) => e.code === 'slot_not_printable');
  });

  it('without a shop nothing is sent', async () => {
    setRequestShopId(null);
    await assert.rejects(listArtwork(), (e) => e.code === 'no_shop');
    assert.equal(calls.length, 0);
  });
});
