// Uploads against a fake fetch: node --test src/api/admin/uploads.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import { PUBLIC_IMAGE_MAX_BYTES, getObject, sha256Hex, sizeCap, uploadObject } from './uploads.js';

const realFetch = globalThis.fetch;
let calls;
let script;

function answer(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

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

const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'logo.png', { type: 'image/png' });
const pngHash = createHash('sha256').update(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])).digest('hex');

describe('sha256', () => {
  it('is the hex digest of the bytes', async () => {
    assert.equal(await sha256Hex(png), pngHash);
    assert.equal(await sha256Hex(new Uint8Array([])), createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  });
});

describe('uploadObject', () => {
  it('reserve → PUT the bytes → the object, with X-Shop-Id on both', async () => {
    script.push(
      () => answer(201, { object: { objectId: 'obj-1', objectKey: 'shops/test-shop-a/shop_branding/obj-1/v1/logo.png' } }),
      () => answer(200, { object: { objectId: 'obj-1', kind: 'shop_branding', url: 'https://img.example.com/x.png', width: 1, height: 1 } }),
    );
    const result = await uploadObject(png, { kind: 'shop_branding' });
    assert.equal(result.objectId, 'obj-1');
    assert.equal(result.url, 'https://img.example.com/x.png');

    assert.equal(calls[0].url, '/_api/v1/admin/objects');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      contentType: 'image/png',
      kind: 'shop_branding',
      sha256: pngHash,
      sizeBytes: png.size,
      fileName: 'logo.png',
    });
    assert.equal(calls[1].url, '/_api/v1/admin/objects/obj-1/content');
    assert.equal(calls[1].init.method, 'PUT');
    assert.equal(calls[1].init.body, png);
    assert.equal(calls[1].init.headers['content-type'], 'image/png');
    for (const call of calls) assert.equal(call.init.headers['x-shop-id'], 'test-shop-a');
  });

  it('a private kind answers no address', async () => {
    script.push(
      () => answer(201, { object: { objectId: 'obj-2', objectKey: 'k' } }),
      () => answer(200, { object: { objectId: 'obj-2', kind: 'artwork_original' } }),
    );
    const result = await uploadObject(png, { kind: 'artwork_original' });
    assert.equal(result.url, null);
  });

  it('a refused upload removes the pending reservation and rejects with the API\'s reason', async () => {
    script.push(
      () => answer(201, { object: { objectId: 'obj-3', objectKey: 'k' } }),
      () => answer(400, { error: { code: 'invalid_request', message: 'Request is not valid', reason: 'type_not_as_stated' } }),
      () => answer(204),
    );
    await assert.rejects(uploadObject(png, { kind: 'product_media' }), { status: 400, reason: 'type_not_as_stated' });
    assert.equal(calls[2].url, '/_api/v1/admin/objects/obj-3');
    assert.equal(calls[2].init.method, 'DELETE');
  });

  it('a file over the cap is refused before anything is sent', async () => {
    const big = { size: PUBLIC_IMAGE_MAX_BYTES + 1, type: 'image/jpeg', name: 'big.jpg', arrayBuffer: async () => new ArrayBuffer(0) };
    await assert.rejects(uploadObject(big, { kind: 'product_media' }), { code: 'payload_too_large' });
    const empty = new File([], 'empty.png', { type: 'image/png' });
    await assert.rejects(uploadObject(empty, { kind: 'product_media' }), { code: 'payload_too_large' });
    assert.equal(calls.length, 0);
  });

  it('the caps: public image 15 MiB, SVG 512 KiB, private 100 MB', () => {
    assert.equal(sizeCap('product_media', 'image/png'), 15 * 1024 * 1024);
    assert.equal(sizeCap('shop_branding', 'image/svg+xml'), 512 * 1024);
    assert.equal(sizeCap('artwork_original', 'image/png'), 100_000_000);
  });

  it('a reservation that names no object is a bad answer', async () => {
    script.push(() => answer(201, { object: {} }));
    await assert.rejects(uploadObject(png, { kind: 'product_media' }), { code: 'bad_response' });
  });

  it('a long file name is cut to 200 characters', async () => {
    script.push(
      () => answer(201, { object: { objectId: 'obj-4', objectKey: 'k' } }),
      () => answer(200, { object: { objectId: 'obj-4' } }),
    );
    const file = new File([new Uint8Array([1])], `${'a'.repeat(300)}.png`, { type: 'image/png' });
    await uploadObject(file, { kind: 'product_media' });
    assert.equal(JSON.parse(calls[0].init.body).fileName.length, 200);
  });
});

describe('getObject', () => {
  it('404 is null (after the /v1/me re-read says the session is fine)', async () => {
    script.push(
      () => answer(404, { error: { code: 'not_found' } }),
      () => answer(200, { user: { id: 'u' } }),
    );
    assert.equal(await getObject('obj-x'), null);
  });
});
