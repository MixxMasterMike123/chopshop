// The held previews, pure: node --test src/admin-app/replacements/podPreviewBlobs.test.mjs

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { heldPreviewUrl, resetHeldPreviews } from './podPreviewBlobs.js';

const SIGNED = 'https://account.eu.r2.cloudflarestorage.com/bucket/pod/shop-a/preview/art-1.webp?X-Amz-Expires=300&X-Amz-Signature=aa';
const SIGNED_LATER = 'https://account.eu.r2.cloudflarestorage.com/bucket/pod/shop-a/preview/art-1.webp?X-Amz-Expires=300&X-Amz-Signature=bb';

function fakeFetch(answer = () => ({ ok: true, blob: async () => new Blob(['preview']) })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return answer(url);
  };
  return { calls, fetchImpl };
}

describe('heldPreviewUrl', () => {
  beforeEach(resetHeldPreviews);

  it('fetches a signed preview once, unchanged and past the cache, and answers a blob: address', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const address = await heldPreviewUrl('shop-a', 'art-1', SIGNED, { fetchImpl });
    assert.match(address, /^blob:/);
    assert.deepEqual(calls, [{ url: SIGNED, init: { mode: 'cors', credentials: 'omit', cache: 'no-store' } }]);
    // A later library read brings a NEW signed address for the same artwork:
    // the held one is answered and nothing is fetched.
    assert.equal(await heldPreviewUrl('shop-a', 'art-1', SIGNED_LATER, { fetchImpl }), address);
    assert.equal(calls.length, 1);
  });

  it('keeps previews apart per shop and per artwork', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const a = await heldPreviewUrl('shop-a', 'art-1', SIGNED, { fetchImpl });
    const b = await heldPreviewUrl('shop-b', 'art-1', SIGNED, { fetchImpl });
    const c = await heldPreviewUrl('shop-a', 'art-2', SIGNED, { fetchImpl });
    assert.equal(new Set([a, b, c]).size, 3);
    assert.equal(calls.length, 3);
  });

  it('two reads at once end on one address', async () => {
    const { fetchImpl } = fakeFetch();
    const [a, b] = await Promise.all([
      heldPreviewUrl('shop-a', 'art-1', SIGNED, { fetchImpl }),
      heldPreviewUrl('shop-a', 'art-1', SIGNED_LATER, { fetchImpl }),
    ]);
    assert.equal(a, b);
  });

  it('a refused or failed fetch keeps the signed address, and is tried again next time', async () => {
    const refused = fakeFetch(() => ({ ok: false, status: 403 }));
    assert.equal(await heldPreviewUrl('shop-a', 'art-1', SIGNED, { fetchImpl: refused.fetchImpl }), SIGNED);
    const down = { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } };
    assert.equal(await heldPreviewUrl('shop-a', 'art-1', SIGNED, down), SIGNED);
    const { calls, fetchImpl } = fakeFetch();
    assert.match(await heldPreviewUrl('shop-a', 'art-1', SIGNED_LATER, { fetchImpl }), /^blob:/);
    assert.equal(calls.length, 1);
  });

  it('an address that is not signed is answered as it is, with no fetch', async () => {
    const { calls, fetchImpl } = fakeFetch();
    for (const url of ['data:image/svg+xml;base64,AAAA', '/_api/dev/preview.png', 'https://pub.example/x.webp']) {
      assert.equal(await heldPreviewUrl('shop-a', 'art-1', url, { fetchImpl }), url);
    }
    assert.equal(await heldPreviewUrl('shop-a', 'art-1', null, { fetchImpl }), null);
    assert.equal(calls.length, 0);
  });
});
