// The platform printers' calls under Node (the CP5-FK section of platform.js):
//   node --test src/api/admin/platform-printers.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AdminApiError, setRequestShopId } from './client.js';
import { patchPrinter, putDefaultPrinter, readAllPrinters } from './platform.js';

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
  // A shop is active in the tab: a printer call must still not carry it (D70,
  // and the Worker refuses any printer route that names a shop).
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('readAllPrinters', () => {
  it('reads every page (50 at a time) and keeps the default from the first', async () => {
    stubFetch((url) => {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      return cursor === null
        ? answer(200, { printers: [{ printerId: 'a' }], nextCursor: 'a', defaultPrinterId: 'a' })
        : answer(200, { printers: [{ printerId: 'b' }], nextCursor: null, defaultPrinterId: 'a' });
    });
    const { printers, defaultPrinterId } = await readAllPrinters();
    assert.deepEqual(printers.map((p) => p.printerId), ['a', 'b']);
    assert.equal(defaultPrinterId, 'a');
    assert.equal(calls[0].url, '/_api/v1/platform/printers?limit=50');
    assert.equal(calls[1].url, '/_api/v1/platform/printers?limit=50&cursor=a');
    assert.ok(calls.every((c) => !('x-shop-id' in c.init.headers)));
    assert.ok(calls.every((c) => c.init.credentials === 'same-origin'));
  });

  it('no default → null; a dark surface (404) fails as the API answered', async () => {
    stubFetch(() => answer(200, { printers: [], nextCursor: null, defaultPrinterId: null }));
    assert.deepEqual(await readAllPrinters(), { printers: [], defaultPrinterId: null });
    // 404 on the list, then /v1/me answers 200: the 404 stands.
    stubFetch((url) => (url === '/_api/v1/me' ? answer(200, { user: {} }) : answer(404, { error: { code: 'not_found' } })));
    await assert.rejects(readAllPrinters(), (e) => e instanceof AdminApiError && e.status === 404);
  });
});

describe('patchPrinter', () => {
  it('sends the body as JSON with PATCH, the id as one segment, no shop', async () => {
    stubFetch(() => answer(200, { printer: { printerId: 'p 1' }, diff: { fields: ['status'] }, suspendedMappings: 2 }));
    const out = await patchPrinter('p 1', { status: 'inactive' });
    assert.equal(calls[0].url, '/_api/v1/platform/printers/p%201');
    assert.equal(calls[0].init.method, 'PATCH');
    assert.equal(calls[0].init.body, JSON.stringify({ status: 'inactive' }));
    assert.equal('x-shop-id' in calls[0].init.headers, false);
    assert.deepEqual(out, { printer: { printerId: 'p 1' }, diff: { fields: ['status'] }, suspendedMappings: 2 });
  });

  it('a refusal carries its code and problems', async () => {
    stubFetch(() => answer(400, { error: { code: 'invalid_tiers', message: 'x', problems: ['tier A: no'] } }));
    await assert.rejects(patchPrinter('a', { status: 'active' }), (e) =>
      e.code === 'invalid_tiers' && e.status === 400 && e.details.problems[0] === 'tier A: no');
  });
});

describe('putDefaultPrinter', () => {
  it('sets and clears', async () => {
    stubFetch((_url, init) => answer(200, { defaultPrinter: { printerId: JSON.parse(init.body).printerId, printerActive: true } }));
    assert.equal((await putDefaultPrinter('a')).printerId, 'a');
    assert.equal((await putDefaultPrinter(null)).printerId, null);
    assert.equal(calls[1].init.body, '{"printerId":null}');
    assert.ok(calls.every((c) => c.url === '/_api/v1/platform/printers/default' && c.init.method === 'PUT'));
    assert.ok(calls.every((c) => !('x-shop-id' in c.init.headers)));
  });
});
