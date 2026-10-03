// The POD page's admin-build data layer (unit FM), end to end against the dev
// API under Node: fetch is routed into dev-api.mjs's route().
//   node --test src/admin-app/replacements/podLibraryLoad.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createState, route } from '../dev/dev-api.mjs';
import { RENDER_MS, setPodClock } from '../dev/pod-dev.mjs';
import { setRequestShopId } from '../../api/admin/client.js';
import {
  forgetRender,
  loadArtworkRows,
  loadPodLibrary,
  renderNews,
  resetPodMemory,
  trackedRenders,
} from './podLibraryLoad.js';
import { saveArtworkUpload, waitForVerdict, precheckArtwork } from './podArtworkUploadData.js';
import { canRename, renameArtwork, rowAction, CAN_REPLACE } from './podArtworkLibraryData.js';
import { deleteArtwork } from './podArtwork.js';
import { addMapping, removeMapping, selectableForMapping, targetOf } from './podProductMappingData.js';
import { loadPodProfiles, clearPodProfilesCache } from './podProfiles.js';

const realFetch = globalThis.fetch;
let state;
let cookie;
let sent;
let now;
let hold; // when set, answers wait for this promise (a slow network)

async function bodyOf(init) {
  if (typeof init.body === 'string') return JSON.parse(init.body);
  if (init.body && typeof init.body.arrayBuffer === 'function') return { raw: Buffer.from(await init.body.arrayBuffer()) };
  return null;
}

function useDevApi(email = 'admin@example.com', password = 'dev-password-1') {
  state = createState();
  const signIn = route(state, 'POST', new URL('http://dev.invalid/_api/api/auth/sign-in/email'), {}, { email, password });
  cookie = signIn.setCookie.split(';')[0];
  globalThis.fetch = async (url, init = {}) => {
    const headers = { cookie, ...Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])) };
    const body = await bodyOf(init);
    sent.push({ url, method: init.method || 'GET', headers, body });
    const answer = route(state, init.method || 'GET', new URL(url, 'http://dev.invalid'), headers, body);
    if (hold) await hold;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
}

const noWait = { wait: async () => {}, now: () => now };

beforeEach(() => {
  sent = [];
  hold = null;
  now = 1_760_000_000_000;
  setPodClock(() => now);
  resetPodMemory();
  clearPodProfilesCache();
  setRequestShopId('test-shop-a');
  useDevApi();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
  setPodClock(null);
});

const pngFile = (name = 'logga.png', text = 'png bytes') => new File([Buffer.from(text)], name, { type: 'image/png' });
const profile = { id: 'apparel_dtg', max_file_mb: 100 };

describe('the library load', () => {
  it('rows with the detail, the preview and the original; the products and the mappings; every request for the shop', async () => {
    const lib = await loadPodLibrary('test-shop-a');
    const admin = sent.filter((r) => r.url.includes('/v1/admin/'));
    assert.ok(admin.length > 0 && admin.every((r) => r.headers['x-shop-id'] === 'test-shop-a'));
    // the one other request: the client's /v1/me check after the opaque 404 of an original with no metadata
    assert.ok(sent.filter((r) => !r.url.includes('/v1/admin/')).every((r) => r.url.endsWith('/v1/me') && !('x-shop-id' in r.headers)));
    const byId = new Map(lib.artwork.map((a) => [a.id, a]));
    assert.match(byId.get('art-fjall').previewUrl, /^data:image\/svg/);
    assert.equal(byId.get('art-rygg').validation.notices[0].code, 'opaque');
    assert.equal(byId.get('art-rygg').ext, 'jpg');
    assert.equal(byId.get('art-skarm').validation.tier, 'FAIL');
    assert.match(byId.get('art-skarm').validation.reasons[0].message, /72 DPI/);
    assert.equal(byId.get('art-gammal').label, null);
    assert.deepEqual(lib.profiles.map((p) => p.id), ['apparel_dtg', 'poster_large']);
    assert.ok(lib.products.some((p) => p.sku === 'tshirt-fjall' && p.variants.length === 6));
    assert.ok(!lib.products.some((p) => p.id === 'prod-old')); // archived
    assert.deepEqual(lib.mappings.map((m) => m.id), ['map-tee-svart-s', 'map-tee-svart-m']);
    assert.equal(lib.mappings[0].sku, 'tshirt-fjall-svart-s');
    assert.match(lib.mappings[1].problem, /Pausad/);
    assert.ok(lib.productSkus.has('tshirt-fjall-vit-m'));
  });

  it('nothing the library shows carries a price structure (one number)', async () => {
    const lib = await loadPodLibrary('test-shop-a');
    const text = JSON.stringify({ ...lib, productSkus: [...lib.productSkus] });
    for (const hidden of ['hiddenPrices', 'blank', 'tiers', 'shippingCost']) assert.ok(!text.includes(hidden), hidden);
  });

  it('a failed read of one artwork\'s detail keeps its row (never "removed")', async () => {
    const base = globalThis.fetch;
    globalThis.fetch = (url, init) => (String(url).endsWith('/v1/admin/pod/artwork/art-fjall') ? Promise.reject(new TypeError('offline')) : base(url, init));
    const rows = await loadArtworkRows('test-shop-a');
    const fjall = rows.find((a) => a.id === 'art-fjall');
    assert.ok(fjall);
    assert.equal(fjall.previewUrl, null);
    assert.equal(fjall.label, 'Fjällogga – bröst');
  });

  it('an answer that arrives after the tab moved to another shop is dropped, not shown', async () => {
    let release;
    hold = new Promise((resolve) => { release = resolve; });
    let settled = false;
    loadArtworkRows('test-shop-a').then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    setRequestShopId('test-shop-c');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
  });

  it('the profiles are cached per shop: another shop is asked anew', async () => {
    assert.equal((await loadPodProfiles()).length, 2);
    const before = sent.length;
    await loadPodProfiles();
    assert.equal(sent.length, before);
    useDevApi('admin-multi@example.com', 'dev-password-5');
    setRequestShopId('test-shop-c');
    await loadPodProfiles();
    assert.equal(sent.at(-1).headers['x-shop-id'], 'test-shop-c');
  });
});

describe('the upload', () => {
  it('the browser judges nothing: the pre-check never blocks and defers to the server', () => {
    const gate = precheckArtwork({ widthPx: 10, heightPx: 10, ext: 'bmp', fileSizeBytes: 1 }, profile);
    assert.equal(gate.ok, true);
    assert.equal(gate.deferred, true);
    assert.equal(gate.effectiveDpi, null);
  });

  it('upload → processing → ready: the server\'s verdict and notices; the rights and the name are sent', async () => {
    const p = saveArtworkUpload({ file: pngFile('Fjäll.jpg.png'), shopId: 'test-shop-a', profile, label: '', rightsConfirmed: true }, {
      ...noWait,
      wait: async () => { now += RENDER_MS; },
    });
    const result = await p;
    assert.ok(result.artworkId);
    assert.deepEqual(result.notices.map((n) => n.code), ['opaque']); // "jpg" in the name: the dev render adds the notice
    const post = sent.find((r) => r.method === 'POST' && r.url.endsWith('/v1/admin/pod/artwork'));
    assert.deepEqual(post.body, { objectId: post.body.objectId, profileId: 'apparel_dtg', rightsConfirmed: true, label: 'Fjäll.jpg' });
    const reserve = sent.find((r) => r.url.endsWith('/v1/admin/objects'));
    assert.equal(reserve.body.kind, 'artwork_original');
    assert.deepEqual(trackedRenders('test-shop-a'), []);
  });

  it('nothing is sent without the rights confirmation', async () => {
    await assert.rejects(saveArtworkUpload({ file: pngFile(), shopId: 'test-shop-a', profile, label: 'x', rightsConfirmed: false }), /rätt att använda/);
    assert.equal(sent.length, 0);
  });

  it('a rejection is the server\'s reasons; the rejected artwork stays in the library', async () => {
    const result = await saveArtworkUpload({ file: pngFile('x.png'), shopId: 'test-shop-a', profile, label: 'avvisa', rightsConfirmed: true }, {
      ...noWait, wait: async () => { now += RENDER_MS; },
    });
    assert.equal(result.rejected, true);
    assert.equal(result.stored, true);
    assert.match(result.reasons[0].message, /DPI/);
    const rows = await loadArtworkRows('test-shop-a');
    assert.ok(rows.some((a) => a.label === 'avvisa' && a.status === 'rejected'));
  });

  it('a failed render is said as failed ("ladda upp igen"), never as done', async () => {
    await assert.rejects(
      saveArtworkUpload({ file: pngFile('y.png', 'other'), shopId: 'test-shop-a', profile, label: 'misslyckad', rightsConfirmed: true }, {
        ...noWait, wait: async () => { now += RENDER_MS; },
      }),
      /ladda upp den igen/,
    );
  });

  it('still processing when the wait ends: said as pending; the library shows it, then its verdict', async () => {
    const result = await saveArtworkUpload({ file: pngFile('z.png', 'slow'), shopId: 'test-shop-a', profile, label: 'långsam', rightsConfirmed: true }, {
      wait: async () => { now += 30_000; }, now: () => now, waitMs: 60_000,
    });
    assert.equal(result.pending, true);
    let rows = await loadArtworkRows('test-shop-a');
    assert.equal(rows.find((a) => a.id === result.artworkId).status, 'processing');
    assert.equal(await renderNews('test-shop-a', [result.artworkId]), false);
    now += 10 * 60_000;
    assert.equal(await renderNews('test-shop-a', [result.artworkId]), true);
    rows = await loadArtworkRows('test-shop-a');
    assert.equal(rows.find((a) => a.id === result.artworkId).status, 'ready');
  });

  it('a render the library saw processing that then fails stays visible as failed until dismissed', async () => {
    const objectBytes = Buffer.from('failing bytes');
    // Upload and create directly (the modal closed early), so the library is the one that sees it.
    const result = await saveArtworkUpload({ file: new File([objectBytes], 'f.png', { type: 'image/png' }), shopId: 'test-shop-a', profile, label: 'misslyckas senare', rightsConfirmed: true }, {
      wait: async () => {}, now: () => now, waitMs: 0,
    });
    assert.equal(result.pending, true);
    await loadArtworkRows('test-shop-a'); // seen processing
    now += RENDER_MS;
    let rows = await loadArtworkRows('test-shop-a');
    const failed = rows.find((a) => a.id === result.artworkId);
    assert.equal(failed.status, 'failed');
    assert.equal(rowAction(failed), 'reupload');
    assert.equal(canRename(failed), false);
    await deleteArtwork(failed, 'test-shop-a'); // dismissed: nothing sent to the server
    assert.ok(!sent.some((r) => r.method === 'DELETE'));
    rows = await loadArtworkRows('test-shop-a');
    assert.ok(!rows.some((a) => a.id === result.artworkId));
  });

  it('a remembered render whose detail cannot be read stays (as processing), then shows its failure', async () => {
    const result = await saveArtworkUpload({ file: pngFile('g.png', 'flaky'), shopId: 'test-shop-a', profile, label: 'misslyckas igen', rightsConfirmed: true }, {
      wait: async () => {}, now: () => now, waitMs: 0,
    });
    now += RENDER_MS; // the render fails: the list no longer carries it
    const base = globalThis.fetch;
    globalThis.fetch = (url, init) => (String(url).endsWith(`/pod/artwork/${result.artworkId}`) ? Promise.reject(new TypeError('offline')) : base(url, init));
    let rows = await loadArtworkRows('test-shop-a');
    assert.equal(rows.find((a) => a.id === result.artworkId)?.status, 'processing');
    assert.ok(trackedRenders('test-shop-a').some((t) => t.artworkId === result.artworkId));
    globalThis.fetch = base;
    rows = await loadArtworkRows('test-shop-a');
    assert.equal(rows.find((a) => a.id === result.artworkId)?.status, 'failed');
  });

  it('a failed detail read while waiting is asked again, not taken as a verdict', async () => {
    const base = globalThis.fetch;
    let failures = 1;
    globalThis.fetch = (url, init) => {
      if (/\/pod\/artwork\/[^/]+$/.test(String(url)) && failures-- > 0) return Promise.reject(new TypeError('offline'));
      return base(url, init);
    };
    const objectId = 'unused';
    void objectId;
    const verdict = await waitForVerdict('test-shop-a', 'art-fjall', noWait);
    assert.equal(verdict.state, 'ready');
  });
});

describe('the library\'s rows', () => {
  it('rename writes only a changed name; the server\'s label after', async () => {
    const art = (await loadArtworkRows('test-shop-a')).find((a) => a.id === 'art-fjall');
    assert.equal(await renameArtwork('test-shop-a', art, '  Fjällogga – bröst '), null);
    assert.equal(await renameArtwork('test-shop-a', art, null), null);
    assert.ok(!sent.some((r) => r.method === 'PATCH'));
    const saved = await renameArtwork('test-shop-a', art, 'Fjäll, ny');
    assert.equal(saved.label, 'Fjäll, ny');
    assert.deepEqual(sent.find((r) => r.method === 'PATCH').body, { label: 'Fjäll, ny' });
    await assert.rejects(renameArtwork('test-shop-a', art, 'x'.repeat(121)), /högst 120/);
    assert.equal((await loadArtworkRows('test-shop-a')).find((a) => a.id === 'art-fjall').label, 'Fjäll, ny');
  });

  it('no revalidation and no file replace in this build', () => {
    assert.equal(CAN_REPLACE, false);
    assert.equal(rowAction({ status: 'rejected' }), null);
    assert.equal(rowAction({ status: 'processing' }), null);
  });

  it('a delete refused because a mapping names the artwork says why', async () => {
    await assert.rejects(deleteArtwork({ id: 'art-fjall', status: 'ready' }, 'test-shop-a'), /använts i en tryckkoppling/);
    await deleteArtwork({ id: 'art-rygg', status: 'ready' }, 'test-shop-a');
    assert.ok(!(await loadArtworkRows('test-shop-a')).some((a) => a.id === 'art-rygg'));
  });
});

describe('the mapping form', () => {
  const choiceOf = (over = {}) => ({ printerId: 'dev-printer', articleSku: 'DEV-TEE-WHT-S', chosenSlots: ['front'], ...over });

  it('only approved artwork can be picked', () => {
    assert.equal(selectableForMapping({ status: 'ready' }), true);
    assert.equal(selectableForMapping({ status: 'rejected' }), false);
    assert.equal(selectableForMapping({ status: 'processing' }), false);
  });

  it('a variant mapped: printer, article, slots; the server\'s numbers in the message; the list reads it back', async () => {
    const { products } = await loadPodLibrary('test-shop-a');
    assert.deepEqual(targetOf(products, 'tshirt-fjall-vit-s'), { productId: 'prod-tee', variantId: 'var-tee-vit-s', priceMinor: 29900 });
    const { message } = await addMapping({ shopId: 'test-shop-a', sku: 'tshirt-fjall-vit-s', artworkId: 'art-fjall', choice: choiceOf(), products });
    assert.match(message, /^Koppling sparad · Inköp 125 kr inkl\. moms · prisgolv \d+ kr$/);
    const post = sent.find((r) => r.method === 'POST' && r.url.endsWith('/pod/mappings'));
    assert.deepEqual(post.body, { productId: 'prod-tee', variantId: 'var-tee-vit-s', artworkId: 'art-fjall', printerId: 'dev-printer', sku: 'DEV-TEE-WHT-S', slots: ['front'] });
    const lib = await loadPodLibrary('test-shop-a');
    const row = lib.mappings.find((m) => m.sku === 'tshirt-fjall-vit-s');
    assert.equal(row.slotsLabel, 'Bröst');
    assert.equal(row.garment, 'tee');
  });

  it('the whole product by its own SKU (no variantId sent)', async () => {
    const { products } = await loadPodLibrary('test-shop-a');
    await addMapping({ shopId: 'test-shop-a', sku: 'hoodie-skiss', artworkId: 'art-rygg', choice: choiceOf({ articleSku: 'DEV-HOOD-BLK-M', chosenSlots: ['front', 'back'] }), products });
    const post = sent.find((r) => r.method === 'POST' && r.url.endsWith('/pod/mappings'));
    assert.ok(!('variantId' in post.body));
    assert.deepEqual(post.body.slots, ['front', 'back']);
  });

  it('refused before any request: an unknown SKU, no printer, no article, no slot', async () => {
    const { products } = await loadPodLibrary('test-shop-a');
    const before = sent.length;
    await assert.rejects(addMapping({ shopId: 'test-shop-a', sku: 'nope', artworkId: 'art-fjall', choice: choiceOf(), products }), /Ingen produkt/);
    await assert.rejects(addMapping({ shopId: 'test-shop-a', sku: 'tshirt-fjall', artworkId: 'art-fjall', choice: choiceOf({ printerId: '' }), products }), /Välj tryckeri/);
    await assert.rejects(addMapping({ shopId: 'test-shop-a', sku: 'tshirt-fjall', artworkId: 'art-fjall', choice: choiceOf({ articleSku: '' }), products }), /Välj artikel/);
    await assert.rejects(addMapping({ shopId: 'test-shop-a', sku: 'tshirt-fjall', artworkId: 'art-fjall', choice: choiceOf({ chosenSlots: [] }), products }), /minst en placering/);
    assert.equal(sent.length, before);
  });

  it('the floor refusal and the slot refusal are said at the form', async () => {
    const { products } = await loadPodLibrary('test-shop-a');
    await assert.rejects(
      addMapping({ shopId: 'test-shop-a', sku: 'tshirt-fjall-sand', artworkId: 'art-fjall', choice: choiceOf({ articleSku: 'DEV-HOOD-BLK-M' }), products }),
      /under prisgolvet/,
    );
    await addMapping({ shopId: 'test-shop-a', sku: 'tshirt-fjall-vit-s', artworkId: 'art-fjall', choice: choiceOf(), products });
    await assert.rejects(
      addMapping({ shopId: 'test-shop-a', sku: 'tshirt-fjall-vit-s', artworkId: 'art-gammal', choice: choiceOf(), products }),
      /redan ett original/,
    );
  });

  it('removing a mapping: the DELETE route; the list no longer shows it', async () => {
    await removeMapping({ m: { id: 'map-tee-svart-s', mappingId: 'map-tee-svart-s' }, shopId: 'test-shop-a' });
    const lib = await loadPodLibrary('test-shop-a');
    assert.ok(!lib.mappings.some((m) => m.id === 'map-tee-svart-s'));
    await assert.rejects(removeMapping({ m: { id: 'nope', mappingId: 'nope' }, shopId: 'test-shop-a' }), /finns inte längre/);
  });

  it('forgetRender of an unknown id is harmless', () => {
    forgetRender('test-shop-a', 'nope');
    assert.deepEqual(trackedRenders('test-shop-a'), []);
  });
});
