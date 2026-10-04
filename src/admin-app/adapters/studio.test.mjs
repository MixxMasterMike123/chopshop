// The studio's shapes, pure: node --test src/admin-app/adapters/studio.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
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
