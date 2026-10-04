// The platform 3D models' calls under Node (the CP5-FO section of platform.js):
//   node --test src/api/admin/platform-models.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AdminApiError, setRequestShopId } from './client.js';
import { put3dModel, readAll3dModels, set3dModelActive, uploadStudioFile } from './platform.js';

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
  // A shop is active in the tab: a platform call must still not carry it (D70).
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

const noShop = () => calls.every((c) => !('x-shop-id' in c.init.headers) && c.init.credentials === 'same-origin');

describe('readAll3dModels', () => {
  it('GETs the platform list, models and files; malformed parts read as empty', async () => {
    stubFetch(() => answer(200, { models: [{ modelId: 'a' }], files: { f: { url: 'u' } } }));
    assert.deepEqual(await readAll3dModels(), { models: [{ modelId: 'a' }], files: { f: { url: 'u' } } });
    assert.equal(calls[0].url, '/_api/v1/platform/pod/3d-models');
    assert.equal(calls[0].init.method, 'GET');
    stubFetch(() => answer(200, { models: null, files: [] }));
    assert.deepEqual(await readAll3dModels(), { models: [], files: {} });
    assert.ok(noShop());
  });
});

describe('put3dModel', () => {
  it('PUTs the whole document under the id (encoded) and says whether it was created', async () => {
    stubFetch(() => answer(201, { changed: true, model: { modelId: 'Ab_1' } }));
    assert.deepEqual(await put3dModel('Ab_1', { label: 'X' }), { model: { modelId: 'Ab_1' }, changed: true, created: true });
    assert.equal(calls[0].url, '/_api/v1/platform/pod/3d-models/Ab_1');
    assert.equal(calls[0].init.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[0].init.body), { label: 'X' });
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    stubFetch(() => answer(200, { changed: false, model: { modelId: 'Ab_1' } }));
    assert.deepEqual(await put3dModel('Ab_1', {}), { model: { modelId: 'Ab_1' }, changed: false, created: false });
    assert.ok(noShop());
  });

  it('a refusal rejects with the API\'s code and reason', async () => {
    stubFetch(() => answer(400, { error: { code: 'invalid_request', message: 'Request is not valid', reason: 'not_registered' } }));
    await assert.rejects(put3dModel('Ab_1', {}), (e) => e instanceof AdminApiError && e.status === 400 && e.reason === 'not_registered');
  });
});

describe('set3dModelActive', () => {
  it('PATCHes { active } only', async () => {
    stubFetch(() => answer(200, { changed: true, model: { modelId: 'm', active: false } }));
    assert.deepEqual(await set3dModelActive('m', false), { model: { modelId: 'm', active: false }, changed: true });
    assert.equal(calls[0].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(calls[0].init.body), { active: false });
    assert.ok(noShop());
  });
});

describe('uploadStudioFile', () => {
  it('POSTs the raw bytes with their type stated, never JSON', async () => {
    stubFetch(() => answer(201, { file: { fileId: 'f1', url: 'https://pub.example/x' } }));
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    assert.deepEqual(await uploadStudioFile(blob), { fileId: 'f1', url: 'https://pub.example/x' });
    assert.equal(calls[0].url, '/_api/v1/platform/pod/studio-files');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, blob);
    assert.equal(calls[0].init.headers['content-type'], 'image/webp');
    assert.ok(noShop());
  });

  it('a dark surface (404, /v1/me fine) fails as the API answered', async () => {
    stubFetch((url) => (url === '/_api/v1/me' ? answer(200, { user: {} }) : answer(404, { error: { code: 'not_found' } })));
    await assert.rejects(uploadStudioFile(new Blob(['x'], { type: 'image/png' })), (e) => e.status === 404);
  });
});
