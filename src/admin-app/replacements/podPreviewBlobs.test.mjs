// The held previews, pure: node --test src/admin-app/replacements/podPreviewBlobs.test.mjs

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { heldPreviewCount, heldPreviewUrl, releaseHeldPreviews, resetHeldPreviews } from './podPreviewBlobs.js';

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

  it('an accepted library lets go of every preview its rows do not show', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const revoked = [];
    const realRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (address) => { revoked.push(address); realRevoke.call(URL, address); };
    try {
      const one = await heldPreviewUrl('shop-a', 'art-1', SIGNED, { fetchImpl });
      const two = await heldPreviewUrl('shop-a', 'art-2', SIGNED, { fetchImpl });
      const other = await heldPreviewUrl('shop-b', 'art-1', SIGNED, { fetchImpl });
      assert.equal(heldPreviewCount(), 3);
      // The accepted rows show art-2 (held), a row with no preview and a row
      // that kept its signed address: art-1 was deleted, shop-b is another shop.
      assert.equal(releaseHeldPreviews([two, null, SIGNED]), 2);
      assert.deepEqual(revoked.sort(), [one, other].sort());
      assert.equal(heldPreviewCount(), 1);
      assert.equal(await heldPreviewUrl('shop-a', 'art-2', SIGNED_LATER, { fetchImpl }), two);
      assert.equal(calls.length, 3);
      // A freed preview is fetched again when a list shows the artwork again.
      assert.notEqual(await heldPreviewUrl('shop-a', 'art-1', SIGNED_LATER, { fetchImpl }), one);
      assert.equal(calls.length, 4);
    } finally {
      URL.revokeObjectURL = realRevoke;
    }
  });

  it('a read that is never accepted frees nothing: the rows on screen keep their addresses', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const shown = await heldPreviewUrl('shop-a', 'art-1', SIGNED, { fetchImpl });
    // A refresh whose list no longer holds art-1 runs and then FAILS elsewhere
    // (profiles, mappings or products): nothing calls releaseHeldPreviews.
    await heldPreviewUrl('shop-a', 'art-2', SIGNED, { fetchImpl });
    assert.equal(heldPreviewCount(), 2);
    assert.equal(await heldPreviewUrl('shop-a', 'art-1', SIGNED_LATER, { fetchImpl }), shown);
    assert.equal(calls.length, 2);
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
