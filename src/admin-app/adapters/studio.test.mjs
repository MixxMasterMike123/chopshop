// The studio's shapes, pure: node --test src/admin-app/adapters/studio.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_MIN_DPI,
  artworkMinDpi,
  serverPlacement,
  sizeSlot,
  slotFrame,
  duplicateArticles,
  floorText,
  inkopText,
  mappingGroups,
  mappingsInScope,
  matchArticle,
  matchVariantArticle,
  normalizeLabel,
  planScopeMappings,
  productionFromPrinters,
  productionKey,
  quoteSummary,
  templateFromApi,
  templatesFromApi,
} from './studio.js';
import { applyPrinterAreas } from '../../config/printerAreas.js';
import { resolvePrinterUid } from '../../wagons/pod-wagon/printRouting.js';
import { garmentOfTemplate, templateSlots } from '../../config/podMockupTemplateHelpers.js';
import { containPlacement } from '../../wagons/pod-wagon/studio/placementMath.js';

const TEMPLATE = {
  id: 'tee_a', label: 'T-shirt', garment: 'tee', profileId: 'apparel_dtg', provisional: true,
  colorways: [{ id: 'vit', label: 'Vit', hex: '#ffffff' }, { id: 'svart', label: 'Svart', hex: '#000000' }],
  printAreas: { front: { x: 280, y: 210, w: 240, h: 280 }, back: { x: 280, y: 200, w: 240, h: 320 }, left_sleeve: { x: 644, y: 290, w: 56, h: 56 } },
  printAreaMm: { front: { w: 300, h: 350 }, back: { w: 300, h: 400 }, left_sleeve: { w: 80, h: 80 } },
  printOffsetTopMm: { front: 65 },
  pocketPositions: { left: { x: 440 } },
  photo: {
    w: 960, h: 1093, urls: { vit: 'https://pub.example/platform/studio/a/v1/image.webp' }, backUrls: { vit: 'https://pub.example/b.webp' },
    displacement: { w: 1920, h: 2186, urls: { front: 'https://pub.example/d.webp' }, scale: 30, blend: 'multiply', perColorway: { svart: { blend: 'normal' } } },
  },
};

const PRINTERS = [{
  printerId: 'p1', name: 'Tryckaren',
  capabilities: {
    models: {
      tee1: { garment: 'tee', name: 'Unisex tee', printAreasMm: { front: { w: 250, h: 350, offsetTopMm: 70 }, back: { w: 300, h: 400 } } },
      tee2: { garment: 'tee', name: 'Premium tee', printAreasMm: { front: { w: 300, h: 400 } }, provisional: true },
      cap: { garment: 'cap', printAreasMm: {} },
      unused: { garment: 'hoodie', printAreasMm: { front: { w: 1, h: 1 } } },
    },
    skus: {
      'T-VIT-S': { label: 'Vit / S', model: 'tee1' },
      'T-VIT-M': { label: 'vit/m', model: 'tee1' },
      'T-SV-S': { label: 'Svart / S', model: 'tee1' },
      'P-VIT-S': { label: 'Vit / S', model: 'tee2' },
      CAP: { label: 'Svart', model: 'cap' },
    },
  },
}];

describe('templates', () => {
  it('keeps the document shape the studio reads, field by field', () => {
    const t = templateFromApi({ ...TEMPLATE, sortOrder: 3, active: true, fileId: 'x' });
    assert.deepEqual(Object.keys(t).sort(), ['colorways', 'garment', 'id', 'label', 'photo', 'pocketPositions', 'printAreaMm', 'printAreas', 'printOffsetTopMm', 'profileId', 'provisional'].sort());
    assert.deepEqual(t.printAreas.front, TEMPLATE.printAreas.front);
    assert.equal(t.photo.urls.vit, TEMPLATE.photo.urls.vit);
    assert.equal(t.photo.displacement.perColorway.svart.blend, 'normal');
    assert.deepEqual(templateSlots(t), ['front', 'back', 'left_sleeve']);
    assert.equal(garmentOfTemplate(t), 'tee');
  });

  it('drops a template the studio could not draw', () => {
    assert.equal(templateFromApi({ ...TEMPLATE, colorways: [] }), null);
    assert.equal(templateFromApi({ ...TEMPLATE, printAreas: {} }), null);
    assert.equal(templateFromApi({ ...TEMPLATE, garment: undefined }), null);
    assert.equal(templateFromApi(null), null);
  });

  it('the list and its provisional flag (only the server\'s true)', () => {
    assert.deepEqual(templatesFromApi({ provisional: true, templates: [TEMPLATE, { id: 'bad' }] }).templates.map((t) => t.id), ['tee_a']);
    assert.equal(templatesFromApi({ templates: [] }).meta.provisional, false);
    assert.equal(templatesFromApi({ provisional: true, templates: [] }).meta.provisional, true);
  });
});

describe('production (the printers as the studio\'s routing)', () => {
  const prod = productionFromPrinters(PRINTERS);
  const k1 = productionKey('p1', 'tee1');
  const k2 = productionKey('p1', 'tee2');

  it('one entry per model with articles; a model without a frame is never the default', () => {
    assert.deepEqual(prod.options.tee, [k1, k2]);
    assert.deepEqual(prod.options.cap, [productionKey('p1', 'cap')]);
    assert.equal(prod.options.hoodie, undefined); // no article
    assert.equal(prod.routing.byGarment.tee, k1);
    assert.equal(prod.routing.byGarment.cap, undefined); // no frame: nothing to print on
    assert.deepEqual(prod.printersById[k1].articles.map((a) => a.sku), ['T-VIT-S', 'T-VIT-M', 'T-SV-S']);
    assert.equal(prod.printersById[k2].label, 'Tryckaren · Premium tee (preliminära mått)');
  });

  it('the studio\'s own routing and frame code run on it unchanged', () => {
    assert.equal(resolvePrinterUid('tee', prod.routing, prod.printersById), k1);
    assert.equal(resolvePrinterUid('cap', prod.routing, prod.printersById), null);
    const t = applyPrinterAreas(templateFromApi(TEMPLATE), prod.printersById[k1].printAreasMm.tee);
    assert.deepEqual(templateSlots(t), ['front', 'back']); // the sleeve: no frame
    assert.deepEqual(t.printAreaMm.front, { w: 250, h: 350 });
  });

  it('carries no figure but the frames (one number: no price on this answer)', () => {
    const text = JSON.stringify(prod);
    for (const word of ['price', 'cost', 'tier', 'Minor']) assert.ok(!text.toLowerCase().includes(word.toLowerCase()), word);
  });
});

describe('articles', () => {
  const articles = productionFromPrinters(PRINTERS).printersById[productionKey('p1', 'tee1')].articles;

  it('preselects the one article whose label reads colour / size (label or id, case and spacing free)', () => {
    assert.equal(normalizeLabel(' Vit /M '), 'vit / m');
    assert.equal(matchArticle(articles, { id: 'vit', label: 'Vit' }, 'S'), 'T-VIT-S');
    assert.equal(matchArticle(articles, { id: 'white', label: 'vit' }, 'M'), 'T-VIT-M');
    assert.equal(matchArticle(articles, { id: 'svart', label: 'Black' }, 'S'), 'T-SV-S');
    assert.equal(matchArticle(articles, { id: 'vit', label: 'Vit' }, 'XL'), '');
    assert.equal(matchVariantArticle(articles, 'Vit · S'), 'T-VIT-S');
  });

  it('two articles with the same label: nothing is guessed', () => {
    const twice = [...articles, { sku: 'X', label: 'VIT / S' }];
    assert.equal(matchArticle(twice, { id: 'vit', label: 'Vit' }, 'S'), '');
  });

  it('names an article chosen twice', () => {
    assert.deepEqual(duplicateArticles(['A', '', 'B', 'A']), ['A']);
    assert.deepEqual(duplicateArticles(['A', 'B']), []);
  });
});

describe('the design\'s mappings', () => {
  it('the slots that print the same artwork share one mapping', () => {
    const art = { front: 'a1', back: 'a2', pocket: 'a1' };
    assert.deepEqual(mappingGroups(['back', 'pocket', 'front'], (s) => art[s]), [
      { artworkId: 'a1', slots: ['front', 'pocket'] },
      { artworkId: 'a2', slots: ['back'] },
    ]);
    assert.throws(() => mappingGroups(['front'], () => null));
  });

  const wanted = [{ artworkId: 'a1', printerId: 'p1', sku: 'S1', slots: ['front'] }, { artworkId: 'a2', printerId: 'p1', sku: 'S1', slots: ['back'] }];

  it('writes nothing when the server already holds the design', () => {
    const existing = [
      { mappingId: 'm1', artworkId: 'a1', printerId: 'p1', sku: 'S1', slots: [{ slot: 'front' }], status: 'active' },
      { mappingId: 'm2', artworkId: 'a2', printerId: 'p1', sku: 'S1', slots: [{ slot: 'back' }], status: 'active' },
      { mappingId: 'old', artworkId: 'a9', printerId: 'p1', sku: 'S1', slots: [{ slot: 'front' }], status: 'inactive' },
    ];
    assert.deepEqual(planScopeMappings(existing, wanted), { keep: ['m1', 'm2'], deletes: [], posts: [] });
  });

  it('removes what differs first (other artwork, other slots, another article, suspended), then posts', () => {
    const existing = [
      { mappingId: 'm1', artworkId: 'a1', printerId: 'p1', sku: 'S1', slots: [{ slot: 'front' }, { slot: 'back' }], status: 'active' },
      { mappingId: 'm3', artworkId: 'a3', printerId: 'p1', sku: 'S2', slots: [{ slot: 'pocket' }], status: 'active' },
      { mappingId: 'm4', artworkId: 'a2', printerId: 'p1', sku: 'S1', slots: [{ slot: 'back' }], status: 'suspended' },
    ];
    const plan = planScopeMappings(existing, wanted);
    assert.deepEqual(plan.keep, []);
    assert.deepEqual(plan.deletes, ['m1', 'm3', 'm4']);
    assert.deepEqual(plan.posts, wanted);
  });

  it('a scope is the product\'s own (null) or one variant\'s', () => {
    const ms = [{ mappingId: 'a', variantId: null }, { mappingId: 'b', variantId: 'v1' }, { mappingId: 'c' }];
    assert.deepEqual(mappingsInScope(ms, null).map((m) => m.mappingId), ['a', 'c']);
    assert.deepEqual(mappingsInScope(ms, 'v1').map((m) => m.mappingId), ['b']);
  });
});

describe('the quote, as the panel shows it', () => {
  const q = (inkopMinor, priceFloorMinor) => ({ state: 'ok', quote: { inkopMinor, priceFloorMinor, currency: 'SEK' } });

  it('nothing chosen, pending, failed (never 0 kr), ok', () => {
    assert.deepEqual(quoteSummary([], {}), { state: 'empty' });
    assert.deepEqual(quoteSummary(['A'], {}), { state: 'pending' });
    assert.deepEqual(quoteSummary(['A', 'B'], { A: q(10000, 19700), B: { state: 'loading' } }), { state: 'pending' });
    assert.deepEqual(quoteSummary(['A', 'B'], { A: q(10000, 19700), B: { state: 'refused', message: 'Nej' } }), { state: 'failed', message: 'Nej' });
    assert.deepEqual(quoteSummary(['A'], { A: { state: 'failed' } }), { state: 'failed', message: null });
    assert.deepEqual(quoteSummary(['A'], { A: { state: 'ok', quote: {} } }), { state: 'failed', message: null });
    const pending = quoteSummary(['A'], {});
    assert.equal(inkopText(pending), '—');
    assert.equal(floorText(pending), '—');
  });

  it('the strictest floor and the Inköp range, the server\'s figures only (Inköp incl. the production VAT)', () => {
    const s = quoteSummary(['A', 'B', 'A'], { A: q(10000, 19700), B: q(10500, 20400) });
    assert.deepEqual(s, { state: 'ok', floorKr: 204, inkopMinKr: 125, inkopMaxKr: 131 });
    assert.equal(floorText(s), '204 kr');
    assert.equal(inkopText(s), '125–131 kr');
    assert.equal(inkopText(quoteSummary(['A'], { A: q(10000, 19700) })), '125 kr');
  });
});

describe('the print size, as the Worker sizes it (Codex FN1 round 1)', () => {
  const profiles = [{ id: 'apparel_dtg', min_dpi: 300 }, { id: 'poster_low', min_dpi: 150 }, { id: 'no_floor', min_dpi: null }];
  const template = { printAreas: { front: { x: 0, y: 0, w: 250, h: 350 }, back: { x: 0, y: 0, w: 300, h: 400 }, pocket: { x: 0, y: 0, w: 100, h: 100 } },
    printAreaMm: { front: { w: 250, h: 350 }, back: { w: 300, h: 400 }, pocket: { w: 100, h: 100 } } };
  const frames = { front: { w: 250, h: 350, offsetTopMm: 70 }, back: { w: 300, h: 400 } };
  const art = (w, h, purpose) => ({ sourceWidthPx: w, sourceHeightPx: h, purpose, previewUrl: 'x' });

  it('the DPI floor is the ARTWORK\'s own profile\'s, else 300 (no profile, a profile without a floor, no list)', () => {
    assert.equal(artworkMinDpi(art(1, 1, 'poster_low'), profiles), 150);
    assert.equal(artworkMinDpi(art(1, 1, 'apparel_dtg'), profiles), 300);
    assert.equal(artworkMinDpi(art(1, 1, 'gone'), profiles), DEFAULT_MIN_DPI);
    assert.equal(artworkMinDpi(art(1, 1, 'no_floor'), profiles), 300);
    assert.equal(artworkMinDpi(art(1, 1, 'poster_low'), []), 300);
    assert.equal(artworkMinDpi(art(1, 1, 'poster_low'), undefined), 300);
  });

  it('sizeSlot is the Worker\'s: contain-fit, capped at the floor, whole mm; null under 1 mm', () => {
    assert.deepEqual(sizeSlot(3000, 3000, { w: 250, h: 350 }, 300), { widthMm: 250, heightMm: 250 }); // the frame binds (cap 254 mm)
    assert.deepEqual(sizeSlot(2000, 2000, { w: 250, h: 350 }, 300), { widthMm: 169, heightMm: 169 }); // the cap binds (169.33 mm)
    assert.deepEqual(sizeSlot(4200, 5600, { w: 300, h: 400 }, 300), { widthMm: 300, heightMm: 400 }); // the dev API stores 300 × 400 for this one
    assert.deepEqual(sizeSlot(1000, 3000, { w: 250, h: 350 }, 150), { widthMm: 116, heightMm: 350 }); // the height binds (116.67)
    assert.equal(sizeSlot(10, 10, { w: 250, h: 350 }, 300), null);
    assert.equal(sizeSlot(3000, 3000, { w: 250, h: 350 }, 0), null);
  });

  it('the frame is the model\'s; the pocket a 100 × 100 spot inside the front', () => {
    assert.deepEqual(slotFrame(frames, 'front'), { w: 250, h: 350 });
    assert.deepEqual(slotFrame(frames, 'pocket'), { w: 100, h: 100 });
    assert.deepEqual(slotFrame({ front: { w: 80, h: 350 } }, 'pocket'), { w: 80, h: 100 });
    assert.equal(slotFrame(frames, 'left_sleeve'), null);
    assert.equal(slotFrame(null, 'front'), null);
  });

  it('an artwork whose profile differs from the template\'s is sized by its own floor (not the template\'s)', () => {
    const low = art(2000, 2000, 'poster_low');
    const p = serverPlacement(template, 'front', low, { frames, profiles });
    assert.equal(p.wMm, 250); // 150 DPI: the frame binds
    // The older path, with the template's 300-DPI profile, would have shown 169 mm.
    assert.equal(Math.floor(containPlacement(template, 'front', low, 300).wMm), 169);
    assert.deepEqual(p, { xMm: 0, yMm: 50, wMm: 250, rotationDeg: 0 });
  });

  it('the profile list unavailable → 300, the cap binds, and the print is centred in the slot', () => {
    const p = serverPlacement(template, 'front', art(2000, 2000, 'poster_low'), { frames, profiles: [] });
    assert.deepEqual(p, { xMm: 40.5, yMm: 90.5, wMm: 169, rotationDeg: 0 });
  });

  it('no frame (the model cannot print the slot) or too small → no placement', () => {
    assert.equal(serverPlacement(template, 'left_sleeve', art(3000, 3000, 'apparel_dtg'), { frames, profiles }), null);
    assert.equal(serverPlacement(template, 'front', art(3000, 3000, 'apparel_dtg'), { frames: null, profiles }), null);
    assert.equal(serverPlacement(template, 'front', art(10, 10, 'apparel_dtg'), { frames, profiles }), null);
  });
});
