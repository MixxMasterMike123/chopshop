// The design studio's admin-build data layer, end to end against the dev API
// under Node (fetch is routed into dev-api.mjs's route()): the loaders, the
// quote, and the publish sequence with a failure at each step.
//   node --test src/admin-app/replacements/podStudioPublish.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createState, route } from '../dev/dev-api.mjs';
import { setPodClock } from '../dev/pod-dev.mjs';
import { setRequestShopId } from '../../api/admin/client.js';
import { deriveVariantsFromGroups } from '../../utils/variantDerivation.js';
import { forgetPendingRun, pendingRun, publishNewDesign, updateExistingFromDesign } from './podStudioPublish.js';
import { clearPodMockupTemplatesCache, getPodMockupTemplatesMeta, loadPodMockupTemplates } from './podMockupTemplates.js';
import { clearPrintRoutingCache, loadPrintRouting } from './podPrintRouting.js';
import { clearPodCostQuoteCache, quoteDesign, quotePodCost } from './podCostQuote.js';
import { productionKey } from '../adapters/studio.js';

const realFetch = globalThis.fetch;
let state;
let cookie;
let sent;
let inject; // (request) → a Response to answer instead, or undefined
let hold; // a promise every answer waits for, when set

// The pure helpers of utils/productUrls.js (its module imports what Node cannot load).
const skuFromName = (name) => String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'produkt';
const uniqueSku = (base, taken, self = '') => {
  const set = new Set([...taken].map((s) => s.toLowerCase()));
  if (self) set.delete(self.toLowerCase());
  if (!set.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!set.has(`${base}-${n}`.toLowerCase())) return `${base}-${n}`;
};
const DEPS = { skuFromName, uniqueSku, deriveVariantsFromGroups };

async function bodyOf(init) {
  if (typeof init.body === 'string') return JSON.parse(init.body);
  return null;
}

function useDevApi(email = 'admin@example.com', password = 'dev-password-1') {
  state = createState();
  const signIn = route(state, 'POST', new URL('http://dev.invalid/_api/api/auth/sign-in/email'), {}, { email, password });
  cookie = signIn.setCookie.split(';')[0];
  globalThis.fetch = async (url, init = {}) => {
    const headers = { cookie, ...Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])) };
    const body = await bodyOf(init);
    const request = { url: String(url), method: init.method || 'GET', headers, body };
    sent.push(request);
    if (hold) await hold;
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const injected = inject?.(request);
    if (injected) return injected;
    const answer = route(state, request.method, new URL(url, 'http://dev.invalid'), headers, body);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
}

const fail = (status, code) => new Response(JSON.stringify({ error: { code, message: code } }), { status });
const writes = () => sent.filter((r) => r.method !== 'GET' && r.url.includes('/v1/admin/'));
const read = (path) => route(state, 'GET', new URL(`http://dev.invalid/_api${path}`), { cookie, 'x-shop-id': 'test-shop-a' }).body;
const settled = (promise, ms = 50) => Promise.race([promise.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))]);

beforeEach(() => {
  sent = [];
  inject = null;
  hold = null;
  setPodClock(() => 1_760_000_000_000);
  forgetPendingRun();
  clearPodMockupTemplatesCache();
  clearPrintRoutingCache();
  clearPodCostQuoteCache();
  setRequestShopId('test-shop-a');
  useDevApi();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
  setPodClock(null);
});

// A tee in Vit (S, M) and Svart (S, M, L): Fjällogga on the chest, the back
// print on the back; Svart's chest prints another motif (a colour override).
const ART = { front: 'art-fjall', back: 'art-rygg' };
const OVERRIDE = { svart: { front: 'art-gammal' } };
function design(over = {}) {
  return {
    shopId: 'test-shop-a',
    currency: 'SEK',
    name: 'Fjälltröja',
    price: 299,
    colorways: [
      { id: 'vit', label: 'Vit', price: '', cells: [{ size: 'S', sku: 'DEV-TEE-WHT-S' }, { size: 'M', sku: 'DEV-TEE-WHT-M' }] },
      { id: 'svart', label: 'Svart', price: '', cells: [{ size: 'S', sku: 'DEV-TEE-BLK-S' }, { size: 'M', sku: 'DEV-TEE-BLK-M' }, { size: 'L', sku: 'DEV-TEE-BLK-L' }] },
    ],
    slots: ['front', 'back'],
    printerId: 'dev-printer',
    artworkFor: (slot, cw) => OVERRIDE[cw]?.[slot] ?? ART[slot],
    ...over,
  };
}

const productsNamed = (name) => read('/v1/admin/products?limit=100').products.filter((p) => p.name === name);

describe('the loaders', () => {
  it('templates: the shop\'s, in the studio\'s shape, every read with its shop header', async () => {
    const templates = await loadPodMockupTemplates();
    assert.deepEqual(templates.map((t) => t.id), ['dev_tee_flat', 'dev_tee_photo', 'dev_hoodie_flat', 'dev_cap_flat', 'dev_bag_flat']);
    assert.match(templates[1].photo.urls.vit, /^data:image\/png;base64,/);
    assert.equal(getPodMockupTemplatesMeta().provisional, true);
    assert.ok(sent.every((r) => r.headers['x-shop-id'] === 'test-shop-a'));
    await loadPodMockupTemplates();
    assert.equal(sent.length, 1, 'cached for the shop');
  });

  it('a failed template read rejects and is asked again (never "no templates")', async () => {
    inject = (r) => (r.url.endsWith('/mockup-templates') ? fail(500, 'internal') : undefined);
    await assert.rejects(loadPodMockupTemplates());
    inject = null;
    assert.equal((await loadPodMockupTemplates()).length, 5);
  });

  it('an answer that arrives after the tab moved shop is dropped for its caller; the cache keeps that shop\'s own', async () => {
    let release;
    hold = new Promise((r) => { release = r; });
    const late = loadPodMockupTemplates();
    setRequestShopId('test-shop-b');
    release();
    hold = null;
    assert.equal(await settled(late), false, 'the late answer never settles');
    // The cache holds the first shop's own answer (never the dropped caller's
    // promise): back on that shop it is served, not asked again, and never
    // anything of the other shop.
    setRequestShopId('test-shop-a');
    const before = sent.length;
    assert.equal((await loadPodMockupTemplates()).length, 5);
    assert.equal(sent.length, before);
    assert.ok(sent.every((r) => r.headers['x-shop-id'] === 'test-shop-a'));
  });

  it('routing: each printer model as the studio reads a printer; no figure', async () => {
    const { routing, printersById, production } = await loadPrintRouting();
    const tee = productionKey('dev-printer', 'tee-unisex');
    assert.equal(routing.byGarment.tee, tee);
    assert.deepEqual(production.options.tee, [tee]);
    assert.equal(routing.byGarment.bag, undefined);
    assert.deepEqual(Object.keys(printersById[tee].printAreasMm.tee), ['front', 'back']);
    assert.ok(printersById[tee].articles.some((a) => a.sku === 'DEV-TEE-WHT-S' && a.label === 'Vit / S'));
    assert.ok(!JSON.stringify(printersById).includes('hiddenPrices'));
    assert.ok(!/blank|Minor|price/i.test(JSON.stringify(printersById)));
  });
});

describe('the quote', () => {
  it('the older (garment, slots) quote answers no number, without a request', async () => {
    assert.deepEqual(await quotePodCost({ shopId: 'test-shop-a', garment: 'tee', slots: ['front'] }), { costSek: null, printerUid: null });
    assert.equal(sent.length, 0);
  });

  it('the design quote: the server\'s two numbers, memoised per shop; a failure is not memoised and is never 0', async () => {
    const q = await quoteDesign({ printerId: 'dev-printer', sku: 'DEV-TEE-BLK-S', slots: ['front', 'back'] });
    assert.deepEqual(Object.keys(q).sort(), ['currency', 'inkopMinor', 'priceFloorMinor']);
    await quoteDesign({ printerId: 'dev-printer', sku: 'DEV-TEE-BLK-S', slots: ['front', 'back'] });
    assert.equal(sent.length, 1);
    // Another shop's tab asks for itself (the memo is keyed by the shop); its answer is that shop's.
    setRequestShopId('test-shop-b');
    const forB = quoteDesign({ printerId: 'dev-printer', sku: 'DEV-TEE-BLK-S', slots: ['front', 'back'] });
    await settled(forB);
    assert.equal(sent.at(-1 - (sent.at(-1).url.endsWith('/v1/me') ? 1 : 0)).headers['x-shop-id'], 'test-shop-b');
    setRequestShopId('test-shop-a');
    inject = () => fail(500, 'internal');
    await assert.rejects(quoteDesign({ printerId: 'dev-printer', sku: 'DEV-TEE-WHT-S', slots: ['front'] }));
    inject = null;
    const again = await quoteDesign({ printerId: 'dev-printer', sku: 'DEV-TEE-WHT-S', slots: ['front'] });
    assert.ok(again.priceFloorMinor > 0);
    await assert.rejects(quoteDesign({ printerId: 'dev-printer', sku: 'DEV-CAP-BLK', slots: ['back'] }), (e) => e.code === 'slot_not_printable');
  });

  it('an ask that can be aborted is never shared through the memo', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(quoteDesign({ printerId: 'dev-printer', sku: 'DEV-TEE-BLK-M', slots: ['front'] }, { signal: controller.signal }));
    const q = await quoteDesign({ printerId: 'dev-printer', sku: 'DEV-TEE-BLK-M', slots: ['front'] });
    assert.ok(q.inkopMinor > 0);
  });
});

describe('publishing a new design', () => {
  it('draft → variants → one mapping per artwork per variant → active → published; no image; the shop on every request', async () => {
    const { result, error } = await publishNewDesign(design(), DEPS);
    assert.equal(error, undefined);
    assert.equal(result.published, true);
    assert.match(result.note, /inga produktbilder/);
    const kinds = writes().map((r) => `${r.method} ${r.url.replace(/^\/_api\/v1\/admin/, '').replace(/\/(prod|var|map)-[0-9a-f]+/g, '/:id')}`);
    assert.deepEqual(kinds, [
      'POST /products',
      ...Array(5).fill('POST /products/:id/variants'),
      ...Array(10).fill('POST /pod/mappings'),
      'PATCH /products/:id',
      'POST /products/:id/publish',
    ]);
    assert.ok(sent.every((r) => !r.url.includes('/v1/admin/') || r.headers['x-shop-id'] === 'test-shop-a'));
    assert.ok(!sent.some((r) => r.url.includes('/images')), 'no image written (FN2)');
    assert.equal(writes()[0].body.status, undefined, 'created as a draft');

    const detail = read(`/v1/admin/products/${result.productId}`);
    assert.equal(detail.publication.published, true);
    assert.deepEqual(detail.variants.map((v) => [v.label, v.size]), [['Vit / S', 'S'], ['Vit / M', 'M'], ['Svart / S', 'S'], ['Svart / M', 'M'], ['Svart / L', 'L']]);
    const mappings = read(`/v1/admin/pod/mappings?productId=${result.productId}`).mappings;
    const byVariant = (label) => mappings.filter((m) => m.variantId === detail.variants.find((v) => v.label === label).variantId)
      .map((m) => [m.artworkId, m.sku, m.slots.map((s) => s.slot).join('+')]);
    assert.deepEqual(byVariant('Vit / M'), [['art-fjall', 'DEV-TEE-WHT-M', 'front'], ['art-rygg', 'DEV-TEE-WHT-M', 'back']]);
    assert.deepEqual(byVariant('Svart / L'), [['art-gammal', 'DEV-TEE-BLK-L', 'front'], ['art-rygg', 'DEV-TEE-BLK-L', 'back']]);
    assert.equal(pendingRun('test-shop-a'), null);
  });

  it('one artwork on two slots is one mapping', async () => {
    const { result } = await publishNewDesign(design({
      colorways: [{ id: 'vit', label: 'Vit', price: '', cells: [{ size: 'S', sku: 'DEV-TEE-WHT-S' }] }],
      artworkFor: () => 'art-fjall',
    }), DEPS);
    const mappings = read(`/v1/admin/pod/mappings?productId=${result.productId}`).mappings;
    assert.deepEqual(mappings.map((m) => m.slots.map((s) => s.slot)), [['front', 'back']]);
  });

  it('a failed quote writes nothing and is never 0 kr', async () => {
    inject = (r) => (r.url.includes('/design-quote') ? fail(500, 'internal') : undefined);
    const out = await publishNewDesign(design(), DEPS);
    assert.match(out.error, /Inköpspriset kunde inte hämtas/);
    assert.equal(writes().length, 0);
  });

  it('a price under the server\'s floor is said at the price field, nothing written', async () => {
    const out = await publishNewDesign(design({ price: 199 }), DEPS);
    assert.equal(out.field, 'price');
    assert.match(out.error, /prisgolvet 254 kr/);
    assert.equal(writes().length, 0);
  });

  it('a colour\'s own price under its articles\' floor is refused before any write', async () => {
    const d = design();
    d.colorways[1].price = '200';
    const out = await publishNewDesign(d, DEPS);
    assert.equal(out.field, 'price');
    assert.match(out.error, /Priset för Svart/);
    assert.equal(writes().length, 0);
  });

  it('an article chosen twice, or a cell without one, is refused before any write', async () => {
    const twice = design();
    twice.colorways[1].cells[0].sku = 'DEV-TEE-WHT-S';
    assert.match((await publishNewDesign(twice, DEPS)).error, /Samma artikel/);
    const none = design();
    none.colorways[0].cells[1].sku = '';
    assert.match((await publishNewDesign(none, DEPS)).error, /artikel för varje/);
    assert.equal(writes().length, 0);
  });

  it('a variant that fails leaves a draft (said with what exists); the next try continues THAT draft', async () => {
    let posts = 0;
    inject = (r) => (r.method === 'POST' && r.url.endsWith('/variants') && ++posts === 3 ? fail(500, 'internal') : undefined);
    const first = await publishNewDesign(design(), DEPS);
    assert.equal(first.changed, true);
    assert.match(first.error, /finns som utkast och visas inte i butiken: 2 av 5 varianter är sparade/);
    const draft = pendingRun('test-shop-a');
    assert.ok(draft);
    assert.equal(read(`/v1/admin/products/${draft.productId}`).publication, null, 'not live');

    inject = null;
    sent = [];
    const second = await publishNewDesign(design(), DEPS);
    assert.equal(second.result.productId, draft.productId);
    assert.ok(!writes().some((r) => r.method === 'POST' && r.url.endsWith('/v1/admin/products')), 'no second product');
    assert.equal(writes().filter((r) => r.url.endsWith('/variants')).length, 3, 'only the missing variants');
    assert.equal(productsNamed('Fjälltröja').length, 1);
    assert.equal(read(`/v1/admin/products/${draft.productId}`).variants.length, 5);
  });

  it('a mapping that fails leaves a draft; the next try writes only the missing mappings', async () => {
    let posts = 0;
    inject = (r) => (r.url.endsWith('/pod/mappings') && r.method === 'POST' && ++posts === 4 ? fail(409, 'conflict') : undefined);
    const first = await publishNewDesign(design(), DEPS);
    assert.match(first.error, /5 av 5 varianter och 3 av 10 tryckkopplingar är sparade\. Produkten ändrades samtidigt/);
    inject = null;
    sent = [];
    const second = await publishNewDesign(design(), DEPS);
    assert.ok(second.result);
    assert.equal(writes().filter((r) => r.url.endsWith('/pod/mappings')).length, 7);
    assert.equal(writes().filter((r) => r.url.endsWith('/variants')).length, 0);
    const mappings = read(`/v1/admin/pod/mappings?productId=${second.result.productId}`).mappings.filter((m) => m.status === 'active');
    assert.equal(mappings.length, 10);
  });

  it('a refused publish (the floor) leaves the draft, said at the price field', async () => {
    inject = (r) => (r.url.endsWith('/publish') ? fail(422, 'price_below_floor') : undefined);
    const out = await publishNewDesign(design(), DEPS);
    assert.equal(out.field, 'price');
    assert.match(out.error, /finns som utkast.*5 av 5 varianter och 10 av 10 tryckkopplingar.*Priset ligger under prisgolvet/);
    inject = null;
    sent = [];
    const again = await publishNewDesign(design(), DEPS);
    assert.ok(again.result.published);
    assert.deepEqual(writes().map((r) => r.method), ['PATCH', 'POST'], 'only the product and the publish: nothing else differs');
  });

  it('a lost answer to the create: the product is found by its SKU and the next try continues it', async () => {
    inject = (r) => {
      if (r.method === 'POST' && r.url.endsWith('/v1/admin/products')) {
        route(state, 'POST', new URL(`http://dev.invalid${r.url}`), r.headers, r.body); // the server did it
        return fail(502, 'bad_gateway');
      }
      return undefined;
    };
    const first = await publishNewDesign(design(), DEPS);
    assert.match(first.error, /skapades som utkast/);
    inject = null;
    await publishNewDesign(design(), DEPS);
    assert.equal(productsNamed('Fjälltröja').length, 1);
  });

  it('a draft archived meanwhile is not continued: a new product is created', async () => {
    inject = (r) => (r.url.endsWith('/variants') ? fail(500, 'internal') : undefined);
    await publishNewDesign(design(), DEPS);
    const draft = pendingRun('test-shop-a');
    route(state, 'PATCH', new URL(`http://dev.invalid/_api/v1/admin/products/${draft.productId}`), { cookie, 'x-shop-id': 'test-shop-a' }, { status: 'archived' });
    inject = null;
    const out = await publishNewDesign(design(), DEPS);
    assert.notEqual(out.result.productId, draft.productId);
  });

  it('a quote that answers after the tab moved shop writes nothing', async () => {
    let release;
    hold = new Promise((r) => { release = r; });
    const run = publishNewDesign(design(), DEPS);
    await new Promise((r) => setTimeout(r, 5));
    setRequestShopId('test-shop-b');
    release();
    hold = null;
    assert.equal(await settled(run), false);
    assert.equal(writes().length, 0);
  });
});

describe('updating an existing product', () => {
  const input = (over = {}) => ({
    shopId: 'test-shop-a',
    productId: 'prod-tee',
    slots: ['front', 'back'],
    printerId: 'dev-printer',
    articles: {
      'var-tee-svart-s': 'DEV-TEE-BLK-S', 'var-tee-svart-m': 'DEV-TEE-BLK-M', 'var-tee-svart-l': 'DEV-TEE-BLK-L',
      'var-tee-vit-s': 'DEV-TEE-WHT-S', 'var-tee-vit-m': 'DEV-TEE-WHT-M', 'var-tee-sand': 'DEV-TEE-SND-M',
    },
    colorways: [{ id: 'vit', label: 'Vit' }, { id: 'svart', label: 'Svart' }],
    overrideColorwayIds: [],
    artworkFor: (slot) => ART[slot],
    ...over,
  });

  it('writes only the mappings that differ; a second run writes nothing; the product itself is not touched', async () => {
    const { result } = await updateExistingFromDesign(input());
    assert.equal(result.updated, true);
    const first = writes();
    assert.ok(!first.some((r) => r.url.includes('/products')), 'no product, variant or image write');
    // Svart / S already printed Fjällogga on the chest: kept; its back is added.
    const svartS = first.filter((r) => r.body?.variantId === 'var-tee-svart-s');
    assert.deepEqual(svartS.map((r) => [r.body.artworkId, r.body.slots]), [['art-rygg', ['back']]]);
    // Svart / M's suspended mapping is removed first.
    assert.ok(first.some((r) => r.method === 'DELETE' && r.url.endsWith('/map-tee-svart-m')));
    sent = [];
    await updateExistingFromDesign(input());
    assert.equal(writes().length, 0);
  });

  it('a colour override needs its colour on the product (exact name)', async () => {
    const out = await updateExistingFromDesign(input({
      colorways: [{ id: 'navy', label: 'Marinblå' }],
      overrideColorwayIds: ['navy'],
    }));
    assert.match(out.error, /Marinblå kan inte kopplas/);
    assert.equal(writes().length, 0);
  });

  it('a variant without an article, or under the floor, writes nothing', async () => {
    const missing = input();
    delete missing.articles['var-tee-sand'];
    assert.match((await updateExistingFromDesign(missing)).error, /artikel för varje variant/);
    const cheap = await updateExistingFromDesign(input({ productId: 'prod-tee', articles: { ...input().articles, 'var-tee-sand': 'DEV-HOOD-BLK-M' } }));
    assert.match(cheap.error, /Priset för Sand ligger under prisgolvet \d+ kr/);
    assert.equal(writes().length, 0);
  });

  it('a product of another shop is not found', async () => {
    const out = await updateExistingFromDesign(input({ shopId: 'test-shop-b' }));
    assert.equal(out.error, 'Produkten finns inte längre.');
  });
});
