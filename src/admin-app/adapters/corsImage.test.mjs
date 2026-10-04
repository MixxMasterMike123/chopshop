// The studio's loader for drawn images, pure: node --test src/admin-app/adapters/corsImage.test.mjs

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { corsImageUrl, isSignedUrl, loadCorsImage } from '../../wagons/pod-wagon/studio/corsImage.js';

const PUBLIC = 'https://pub-example.r2.dev/platform/studio/0aad5183/v1/image.webp';
const SIGNED =
  'https://account.eu.r2.cloudflarestorage.com/bucket/pod/shop/preview/a.webp?X-Amz-Expires=300&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-SignedHeaders=host&X-Amz-Signature=67f9';

describe('corsImageUrl', () => {
  it('gives a public address its own cache entry', () => {
    assert.equal(corsImageUrl(PUBLIC), `${PUBLIC}?corsbust=2`);
    assert.equal(corsImageUrl(`${PUBLIC}?v=3`), `${PUBLIC}?v=3&corsbust=2`);
  });

  it('never adds anything to a signed address (an added parameter is a 403)', () => {
    assert.equal(isSignedUrl(SIGNED), true);
    assert.equal(corsImageUrl(SIGNED), SIGNED);
    assert.equal(isSignedUrl(PUBLIC), false);
  });

  it('leaves data:, blob: and relative addresses as they are', () => {
    for (const src of ['data:image/png;base64,AAAA', 'blob:https://admin.example/1', '/pod-garments/tee/white_front.webp']) {
      assert.equal(corsImageUrl(src), src);
    }
  });
});

describe('loadCorsImage', () => {
  const saved = { Image: globalThis.Image, fetch: globalThis.fetch, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  afterEach(() => {
    globalThis.Image = saved.Image;
    globalThis.fetch = saved.fetch;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  });

  /** An Image whose load succeeds or fails as told; every instance is recorded. */
  function fakeImage(outcome = 'load') {
    const made = [];
    globalThis.Image = class {
      constructor() { made.push(this); }
      set src(value) {
        this.requested = value;
        queueMicrotask(() => (outcome === 'load' ? this.onload() : this.onerror()));
      }
    };
    return made;
  }

  it('requests a public image in CORS mode from its own cache entry', async () => {
    const made = fakeImage();
    globalThis.fetch = () => assert.fail('a public image is not fetched');
    const img = await loadCorsImage(PUBLIC, 'x');
    assert.equal(img, made[0]);
    assert.equal(img.crossOrigin, 'anonymous');
    assert.equal(img.requested, `${PUBLIC}?corsbust=2`);
  });

  it('fetches a signed image unchanged, past the cache, and draws the blob', async () => {
    const made = fakeImage();
    const calls = [];
    const revoked = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, blob: async () => 'the-bytes' };
    };
    URL.createObjectURL = (blob) => `blob:made-from-${blob}`;
    URL.revokeObjectURL = (url) => revoked.push(url);
    const img = await loadCorsImage(SIGNED, 'x');
    assert.deepEqual(calls, [{ url: SIGNED, init: { mode: 'cors', credentials: 'omit', cache: 'no-store' } }]);
    assert.equal(img, made[0]);
    assert.equal(img.requested, 'blob:made-from-the-bytes');
    assert.deepEqual(revoked, ['blob:made-from-the-bytes']);
  });

  it("rejects with the caller's text when a signed image is refused or the network fails", async () => {
    fakeImage();
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(loadCorsImage(SIGNED, 'Kunde inte läsa bilden för mockupen.'), /^Error: Kunde inte läsa bilden för mockupen\.$/);
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(loadCorsImage(SIGNED, 'Kunde inte läsa bilden för mockupen.'), /^Error: Kunde inte läsa bilden för mockupen\.$/);
  });

  it("rejects with the caller's text when the image cannot be decoded, and frees a blob", async () => {
    fakeImage('error');
    await assert.rejects(loadCorsImage(PUBLIC, 'Kunde inte läsa bilden för 3D-mockupen.'), /3D-mockupen/);
    const revoked = [];
    globalThis.fetch = async () => ({ ok: true, blob: async () => 'b' });
    URL.createObjectURL = () => 'blob:one';
    URL.revokeObjectURL = (url) => revoked.push(url);
    await assert.rejects(loadCorsImage(SIGNED, 'x'), /^Error: x$/);
    assert.deepEqual(revoked, ['blob:one']);
  });
});
