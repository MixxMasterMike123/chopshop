// The POD page's shapes and sentences: node --test src/admin-app/adapters/pod.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { slotLabel } from '../../config/podSlots.js';
import { garmentLabel } from '../../config/podGarments.js';
import {
  UNNAMED_ARTWORK,
  articleText,
  artworkRefusalMessage,
  artworkRow,
  extOfContentType,
  failedArtworkRow,
  mappingRefusalMessage,
  mappingRows,
  modelPrintsSlot,
  pickerProducts,
  pollDelay,
  printerChoices,
  profileFromApi,
  quoteRefusalMessage,
  quoteText,
  renameValue,
  renderState,
  scopeSlots,
  targetOfSku,
  uploadLabel,
  usagePillsByArtwork,
} from './pod.js';

const summary = (over = {}) => ({
  artworkId: 'a1', createdAt: 1759312800000, createdBySelf: true, effectiveDpi: 366, heightPx: 3600,
  label: 'Logga', originalObjectId: 'o1', profileId: 'apparel_dtg', rightsConfirmedAt: 1759312800000,
  status: 'ready', widthPx: 3600, ...over,
});

const printer = {
  printerId: 'fake-printer',
  name: 'Fake printer',
  garments: ['tee'],
  provisionalAreas: [],
  capabilities: {
    models: {
      tee: { garment: 'tee', name: 'Unisex Tee', printAreasMm: { front: { w: 250, h: 350 }, back: { w: 300, h: 400 } } },
      cap: { garment: 'cap', name: 'Keps', printAreasMm: { front: { w: 100, h: 50 } }, provisional: true },
      bag: { garment: 'bag', name: 'Kasse', printAreasMm: { back: { w: 300, h: 300 } } },
    },
    skus: {
      '2700004': { label: 'Svart / M', model: 'tee' },
      '2700003': { label: 'Svart / S', model: 'tee' },
      CAP1: { model: 'cap' },
      GHOST: { model: 'missing' },
    },
  },
};

describe('profiles', () => {
  it('the API profile → the older shape the upload modal reads', () => {
    assert.deepEqual(
      profileFromApi({ profileId: 'apparel_dtg', label: 'Textil', acceptedFormats: [{ ext: 'png' }, 'x'], maxFileMb: 100, minDpi: 300, printAreaMm: { w: 300, h: 400 }, active: true, sortOrder: 1 }),
      { id: 'apparel_dtg', label: 'Textil', accepted_formats: [{ ext: 'png' }], max_file_mb: 100, min_dpi: 300, print_area_mm: { w: 300, h: 400 } },
    );
    assert.equal(profileFromApi(null), null);
  });
});

describe('artwork rows', () => {
  it('a ready artwork with its detail, preview and original', () => {
    const row = artworkRow(summary(), {
      detail: { notices: [{ code: 'opaque', message: 'Ingen transparens.' }], reasons: [] },
      previewUrl: 'https://r2.example/preview',
      object: { contentType: 'image/jpeg', sizeBytes: 2048, sha256: 'ab'.repeat(32) },
    });
    assert.equal(row.id, 'a1');
    assert.equal(row.label, 'Logga');
    assert.equal(row.purpose, 'apparel_dtg');
    assert.equal(row.previewUrl, 'https://r2.example/preview');
    assert.deepEqual(row.validation, { effectiveDpi: 366, notices: [{ code: 'opaque', message: 'Ingen transparens.' }], reasons: [], tier: 'PASS' });
    assert.equal(row.ext, 'jpg');
    assert.equal(row.fileSizeBytes, 2048);
    assert.equal(row.sha256, 'ab'.repeat(32));
    // No print file and no original address reach the browser.
    assert.equal(row.printUrl, null);
    assert.equal(row.originalUrl, null);
  });

  it('a failed extra read leaves the row without that part, never drops it', () => {
    const row = artworkRow(summary({ label: null }));
    assert.equal(row.label, null);
    assert.equal(row.fileName, UNNAMED_ARTWORK);
    assert.equal(row.previewUrl, null);
    assert.deepEqual(row.validation.notices, []);
    assert.equal(row.ext, null);
  });

  it('only a ready artwork shows a preview; a rejected one carries its reasons as given', () => {
    const rejected = artworkRow(summary({ status: 'rejected' }), {
      detail: { reasons: [{ code: 'resolution_too_low', message: 'Bara 72 DPI.' }] },
      previewUrl: 'https://r2.example/x',
    });
    assert.equal(rejected.previewUrl, null);
    assert.equal(rejected.validation.tier, 'FAIL');
    assert.equal(rejected.validation.reasons[0].message, 'Bara 72 DPI.');
    assert.equal(artworkRow(summary({ status: 'processing' })).validation.tier, undefined);
  });

  it('a failed render, from what the tab remembers', () => {
    const row = failedArtworkRow({ artworkId: 'f1', label: 'Tröja', profileId: 'apparel_dtg', createdAt: 5 });
    assert.equal(row.status, 'failed');
    assert.equal(row.label, 'Tröja');
    assert.equal(row.createdAt, 5);
  });

  it('content types → extensions', () => {
    assert.equal(extOfContentType('image/png'), 'png');
    assert.equal(extOfContentType('image/jpeg'), 'jpg');
    assert.equal(extOfContentType('image/tiff'), 'tiff');
    assert.equal(extOfContentType('application/pdf'), 'pdf');
    assert.equal(extOfContentType('image/svg+xml'), 'svg');
    assert.equal(extOfContentType(''), null);
    assert.equal(extOfContentType(undefined), null);
  });

  it('where a render stands', () => {
    assert.equal(renderState(null).state, 'gone');
    assert.equal(renderState({ artwork: { status: 'processing' } }).state, 'processing');
    assert.equal(renderState({ artwork: { status: 'failed', reason: 'render_failed' } }).state, 'failed');
    assert.deepEqual(renderState({ artwork: { status: 'ready', notices: [{ code: 'opaque', message: 'm' }] } }), { state: 'ready', notices: [{ code: 'opaque', message: 'm' }], reasons: [] });
  });

  it('the poll waits 2 s, doubling, at most 10 s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(pollDelay), [2000, 4000, 8000, 10000, 10000, 10000]);
  });
});

describe('names', () => {
  it('the upload name: typed, else the file name without extension; ≤ 120; no control characters', () => {
    assert.equal(uploadLabel('  Logga fram ', 'x.png'), 'Logga fram');
    assert.equal(uploadLabel('', 'Fjäll logga.PNG'), 'Fjäll logga');
    assert.equal(uploadLabel('a\nb\u2028c', 'x.png'), 'a b c');
    assert.equal(uploadLabel('x'.repeat(200), 'f.png').length, 120);
    assert.equal(uploadLabel('', '.png'), null);
  });

  it('a rename writes nothing when cancelled or unchanged; an emptied name clears it', () => {
    assert.equal(renameValue(null, 'Logga'), undefined);
    assert.equal(renameValue('  Logga ', 'Logga'), undefined);
    assert.equal(renameValue('', null), undefined);
    assert.equal(renameValue('', 'Logga'), null);
    assert.equal(renameValue('Ny', 'Logga'), 'Ny');
    assert.equal(renameValue('Ny', null), 'Ny');
  });
});

describe('printers and articles', () => {
  it('only the capabilities a seller may see; articles sorted; slots the model can print', () => {
    const [choice] = printerChoices([{ ...printer, tiers: [{ blankCostMinor: 6000 }], currency: 'SEK', shippingCostMinor: 4900 }]);
    assert.deepEqual(Object.keys(choice).sort(), ['articles', 'name', 'printerId']);
    assert.deepEqual(choice.articles.map((a) => a.sku), ['CAP1', '2700003', '2700004']); // by garment and model, then the catalogue's order; GHOST has no model
    assert.deepEqual(choice.articles[1], { sku: '2700003', label: 'Svart / S', garment: 'tee', modelName: 'Unisex Tee', provisional: false, slots: ['front', 'back', 'pocket'] });
    assert.deepEqual(choice.articles[0].slots, ['front', 'pocket']);
    assert.equal(choice.articles[0].provisional, true);
    const json = JSON.stringify(choice);
    for (const hidden of ['6000', '4900', 'tiers', 'currency', 'shipping']) assert.ok(!json.includes(hidden), hidden);
  });

  it('the pocket is a position inside the front (the Worker\'s slotFrame)', () => {
    assert.equal(modelPrintsSlot(printer.capabilities.models.bag, 'pocket'), false);
    assert.equal(modelPrintsSlot(printer.capabilities.models.tee, 'pocket'), true);
    assert.equal(modelPrintsSlot(printer.capabilities.models.tee, 'left_sleeve'), false);
  });

  it('an article as the form names it', () => {
    const [choice] = printerChoices([printer]);
    assert.equal(articleText(choice.articles[1], garmentLabel), 'Svart / S — T-shirt · Unisex Tee (2700003)');
    assert.equal(articleText(choice.articles[0], garmentLabel), 'Keps · Keps (CAP1)');
  });
});

const listItem = (over) => ({ productId: 'p1', sku: 'tee', name: 'T-shirt', status: 'active', priceMinor: 29900, variantCount: 2, image: { url: 'https://img/tee' }, ...over });
const detail = {
  product: {},
  variants: [
    { variantId: 'v2', sku: 'tee-m', group: 'Svart', size: 'M', position: 2, active: true, priceMinor: null },
    { variantId: 'v1', sku: 'tee-s', group: 'Svart', size: 'S', position: 1, active: true, priceMinor: 31900 },
    { variantId: 'v3', sku: 'tee-old', group: 'Röd', size: 'S', position: 3, active: false },
  ],
  images: [{ variantId: 'v1', image: { url: 'https://img/v1' } }],
};

describe('the product picker', () => {
  it('products with their active variants; archived left out; SKU → product or variant', () => {
    const picker = pickerProducts([
      { item: listItem(), detail },
      { item: listItem({ productId: 'p2', sku: 'kasse', name: 'Arkiv', status: 'archived' }), detail: null },
      { item: listItem({ productId: 'p3', sku: '', name: 'Ankare', variantCount: 0 }), detail: null },
    ]);
    assert.deepEqual(picker.products.map((p) => p.name), ['Ankare', 'T-shirt']);
    const tee = picker.products[1];
    assert.deepEqual(tee.variants, [
      { sku: 'tee-s', label: 'Svart · S', image: 'https://img/v1', variantId: 'v1', priceMinor: 31900 },
      { sku: 'tee-m', label: 'Svart · M', image: null, variantId: 'v2', priceMinor: null },
    ]);
    assert.equal(picker.products[0].hasSku, false);
    assert.deepEqual(targetOfSku(picker.targets, 'tee'), { productId: 'p1', variantId: null, name: 'T-shirt' });
    assert.equal(targetOfSku(picker.targets, ' tee-m ').variantId, 'v2');
    assert.equal(targetOfSku(picker.targets, 'tee-old'), null); // inactive
    assert.equal(targetOfSku(picker.targets, 'kasse'), null); // archived
    assert.equal(targetOfSku(picker.targets, 'tee-m-xl'), null); // exact match only
    assert.ok(picker.skus.has('tee-s'));
  });

  it('a product whose detail could not be read is still listed (it can be mapped whole)', () => {
    const picker = pickerProducts([{ item: listItem(), detail: null }]);
    assert.deepEqual(picker.products[0].variants, []);
    assert.ok(picker.targets.has('tee'));
  });
});

describe('the mapping list', () => {
  const picker = pickerProducts([{ item: listItem(), detail }]);
  const printers = printerChoices([printer]);
  const art = new Map([['a1', { id: 'a1', purpose: 'apparel_dtg' }]]);
  const ctx = { byScope: picker.byScope, printers, artworkById: art, slotLabel };
  const base = { mappingId: 'm1', productId: 'p1', variantId: 'v1', artworkId: 'a1', printerId: 'fake-printer', sku: '2700003', slots: [{ slot: 'front', widthMm: 200, heightMm: 200 }, { slot: 'back', widthMm: 280, heightMm: 280 }], status: 'active', suspendedReason: null };

  it('one row per mapping, with the seller\'s SKU, all its slots and the article', () => {
    const [row] = mappingRows([base], ctx);
    assert.equal(row.sku, 'tee-s');
    assert.equal(row.slotsLabel, 'Bröst + Rygg');
    assert.deepEqual(row.slotIds, ['front', 'back']);
    assert.equal(row.garment, 'tee');
    assert.equal(row.profileId, 'apparel_dtg');
    assert.equal(row.placement, 'Fake printer · Svart / S — Unisex Tee (2700003)');
    assert.equal(row.problem, null);
  });

  it('a removed mapping is not listed; a paused one and one whose article is gone say why', () => {
    const rows = mappingRows([
      { ...base, mappingId: 'gone', status: 'inactive' },
      { ...base, mappingId: 'paused', status: 'suspended', suspendedReason: 'sku_unavailable' },
      { ...base, mappingId: 'lost', sku: 'NOPE' },
    ], ctx);
    assert.deepEqual(rows.map((r) => r.id), ['paused', 'lost']);
    assert.match(rows[0].problem, /Pausad/);
    assert.match(rows[1].problem, /finns inte längre/);
    assert.equal(rows[1].garment, null);
  });

  it('a mapping of a product the picker does not know shows its id (the orphan warning)', () => {
    const [row] = mappingRows([{ ...base, productId: 'p-archived', variantId: null }], ctx);
    assert.equal(row.sku, 'p-archived');
  });

  it('the quote covers the slots the scope\'s other mappings on the same article print', () => {
    const others = [
      base,
      { ...base, mappingId: 'x', variantId: 'v2', slots: [{ slot: 'pocket' }] },
      { ...base, mappingId: 'y', sku: 'OTHER', slots: [{ slot: 'pocket' }] },
      { ...base, mappingId: 'z', status: 'inactive', slots: [{ slot: 'pocket' }] },
    ];
    assert.deepEqual(scopeSlots(others, { productId: 'p1', variantId: 'v1', printerId: 'fake-printer', sku: '2700003', slots: ['pocket'] }), ['front', 'back', 'pocket']);
    assert.deepEqual(scopeSlots(others, { productId: 'p1', variantId: null, printerId: 'fake-printer', sku: '2700003', slots: ['front'] }), ['front']);
  });
});

describe('the quote as shown', () => {
  it('Inköp incl. the production VAT, the floor as the server gives it', () => {
    assert.equal(quoteText({ inkopMinor: 14000, priceFloorMinor: 25300, currency: 'SEK' }), 'Inköp 175 kr inkl. moms · prisgolv 253 kr');
    assert.equal(quoteText({ inkopMinor: 14000, priceFloorMinor: 25350, currency: 'SEK' }), 'Inköp 175 kr inkl. moms · prisgolv 253,50 kr');
    assert.equal(quoteText({ inkopMinor: null }), null);
  });
});

describe('refusals', () => {
  it('a mapping write', () => {
    assert.match(mappingRefusalMessage({ status: 422, code: 'price_below_floor' }), /under prisgolvet/);
    assert.match(mappingRefusalMessage({ status: 409, code: 'slot_taken' }), /redan ett original/);
    assert.match(mappingRefusalMessage({ status: 409, code: 'sku_mismatch' }), /annan artikel/);
    assert.match(mappingRefusalMessage({ status: 422, code: 'artwork_not_ready' }), /inte godkänt/);
    assert.match(mappingRefusalMessage({ status: 404, code: 'not_found' }), /finns inte/);
    assert.match(mappingRefusalMessage({ status: 401, code: 'unauthenticated' }), /Logga in/);
    assert.equal(mappingRefusalMessage({ status: 500, code: 'http_error' }), null);
  });

  it('a mapping removal', () => {
    assert.match(mappingRefusalMessage({ status: 422, code: 'price_below_floor' }, { removing: true }), /kan inte tas bort/);
    assert.equal(mappingRefusalMessage({ status: 500, code: 'x' }, { removing: true }), null);
  });

  it('the design quote', () => {
    assert.match(quoteRefusalMessage({ code: 'slot_not_printable' }), /placeringen/);
    assert.match(quoteRefusalMessage({ code: 'http_error' }), /kunde inte hämtas/);
  });

  it('an artwork', () => {
    assert.match(artworkRefusalMessage({ status: 409 }, { step: 'delete' }), /använts i en tryckkoppling/);
    assert.match(artworkRefusalMessage({ status: 429, code: 'rate_limited' }), /Vänta en minut/);
    assert.match(artworkRefusalMessage({ status: 400 }, { step: 'rename' }), /120 tecken/);
    assert.match(artworkRefusalMessage({ code: 'rights_not_confirmed' }), /rätt att använda/);
    assert.equal(artworkRefusalMessage({ status: 500 }), null);
  });
});

describe('"Används av": one pill per product (CP5-FP)', () => {
  const entries = [{
    item: { productId: 'p1', sku: '', name: 'Tröja Nord', status: 'active' },
    detail: { variants: ['S', 'M', 'L'].map((size, i) => ({ variantId: `v${i}`, sku: `TN-${size}`, size, active: true, position: i })), images: [] },
  }, {
    item: { productId: 'p2', sku: 'MUG-1', name: '', status: 'active' },
    detail: { variants: [], images: [] },
  }];
  const { byScope } = pickerProducts(entries);
  const mapping = (id, productId, variantId, artworkId, slots) => ({
    mappingId: id, productId, variantId, artworkId, printerId: 'fake-printer', sku: 'DEV', status: 'active',
    slots: slots.map((slot) => ({ slot, widthMm: 100, heightMm: 100 })),
  });

  it('a product mapped per variant is one pill with its variant count and every slot', () => {
    const rows = mappingRows([
      mapping('m0', 'p1', 'v0', 'art-1', ['front']),
      mapping('m1', 'p1', 'v1', 'art-1', ['front', 'back']),
      mapping('m2', 'p1', 'v2', 'art-1', ['front']),
      mapping('m3', 'p2', null, 'art-1', ['front']),
      mapping('m4', 'p1', 'v0', 'art-2', ['back']),
    ], { byScope, slotLabel });
    const pills = usagePillsByArtwork(rows, slotLabel);
    assert.deepEqual(pills.get('art-1').map(({ text, mono, variants, slots }) => ({ text, mono, variants, slots })), [
      { text: 'Tröja Nord', mono: false, variants: 3, slots: `${slotLabel('front')} + ${slotLabel('back')}` },
      { text: 'MUG-1', mono: true, variants: 0, slots: slotLabel('front') },
    ]);
    assert.equal(pills.get('art-2').length, 1);
    assert.equal(pills.get('art-2')[0].variants, 1);
  });
});
