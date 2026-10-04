// The studio's media planner and the 3D adapter (CP5 unit FN2), pure.
//   node --test src/admin-app/adapters/studioMedia.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IMAGE_ROWS_MAX,
  droppedStudioObjects,
  mockupAlt,
  mockupCoverage,
  models3dFromApi,
  planStudioImages,
  sameStudioList,
  studioObjectsBySide,
} from './studioMedia.js';

const COLOURS = [
  { id: 'vit', label: 'Vit', variantIds: ['v-vit-s', 'v-vit-m'] },
  { id: 'svart', label: 'Svart', variantIds: ['v-svart-s', 'v-svart-m'] },
];
const mock = (colorwayId, slot) => ({ key: `${colorwayId}:${slot}`, colorwayId, slot, objectId: `o-${colorwayId}-${slot}` });
const FRONT_BACK = [mock('vit', 'front'), mock('vit', 'back'), mock('svart', 'front'), mock('svart', 'back')];
const short = (list) => list.map((r) => `${r.variantId ?? '-'}:${r.objectId}`);

describe('the image list of a new product', () => {
  it('the hero first, every mockup in the product\'s rows, each colour front then back on its first variant, each row marked', () => {
    const { list } = planStudioImages({ colours: COLOURS, mockups: FRONT_BACK, heroKey: 'svart:front', fresh: true });
    assert.deepEqual(short(list), [
      '-:o-svart-front', '-:o-vit-front', '-:o-vit-back', '-:o-svart-back',
      'v-vit-s:o-vit-front', 'v-vit-s:o-vit-back',
      'v-svart-s:o-svart-front', 'v-svart-s:o-svart-back',
    ]);
    assert.equal(list[0].alt, 'Svart – framsida');
    assert.equal(list.at(-1).alt, 'Svart – baksida');
  });

  it('a design printed on the back only shows the back first; a pocket stays in the product\'s rows', () => {
    const { list } = planStudioImages({ colours: COLOURS.slice(0, 1), mockups: [mock('vit', 'pocket'), mock('vit', 'back')], fresh: true });
    assert.deepEqual(short(list), ['-:o-vit-pocket', '-:o-vit-back', 'v-vit-s:o-vit-pocket', 'v-vit-s:o-vit-back']);
    const backOnly = planStudioImages({ colours: COLOURS.slice(0, 1), mockups: [mock('vit', 'back')], fresh: true }).list;
    assert.deepEqual(short(backOnly), ['-:o-vit-back', 'v-vit-s:o-vit-back']);
  });

  it('over the cap: the product\'s rows keep the hero, each colour keeps its own; beyond that it is refused', () => {
    const colours = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, label: `Färg ${i}`, variantIds: [`v${i}`] }));
    const mockups = colours.flatMap((c) => [mock(c.id, 'front'), mock(c.id, 'back')]);
    const plan = planStudioImages({ colours, mockups, fresh: true });
    assert.equal(plan.compacted, true);
    assert.equal(plan.list.length, 21);
    assert.equal(plan.list[0].objectId, 'o-c0-front');
    const many = Array.from({ length: 16 }, (_, i) => ({ id: `c${i}`, label: `F ${i}`, variantIds: [`v${i}`] }));
    const refused = planStudioImages({ colours: many, mockups: many.flatMap((c) => [mock(c.id, 'front'), mock(c.id, 'back')]), fresh: true });
    assert.deepEqual(refused, { error: 'too_many', count: 33 });
    assert.ok(refused.count > IMAGE_ROWS_MAX);
  });
});

describe('the image list of an existing product', () => {
  const seller = [
    { objectId: 'own-main', variantId: null, alt: null },
    { objectId: 'own-detail', variantId: null, alt: null },
    { objectId: 'hand-black', variantId: 'v-svart-m', alt: null },
    { objectId: 'hand-sand', variantId: 'v-sand', alt: null },
  ];

  it('without the box: the seller\'s main image and colour images stay; the mockups follow in the gallery; an empty colour is filled', () => {
    const plan = planStudioImages({ rows: seller, colours: COLOURS, mockups: FRONT_BACK });
    assert.deepEqual(short(plan.list), [
      '-:own-main', '-:own-detail', '-:o-vit-front', '-:o-vit-back', '-:o-svart-front', '-:o-svart-back',
      'v-svart-m:hand-black', 'v-sand:hand-sand',
      'v-vit-s:o-vit-front', 'v-vit-s:o-vit-back',
    ]);
    assert.deepEqual(plan.keptSeller, ['Svart']);
  });

  it('with the box: the hero becomes the main image (the old one kept next), the studio\'s come first on a colour', () => {
    const plan = planStudioImages({ rows: seller, colours: COLOURS, mockups: FRONT_BACK, replaceImages: true });
    assert.deepEqual(short(plan.list), [
      '-:o-vit-front', '-:own-main', '-:own-detail', '-:o-vit-back', '-:o-svart-front', '-:o-svart-back',
      'v-svart-s:o-svart-front', 'v-svart-s:o-svart-back', 'v-svart-m:hand-black', 'v-sand:hand-sand',
      'v-vit-s:o-vit-front', 'v-vit-s:o-vit-back',
    ]);
  });

  it('the studio\'s earlier rows are replaced in place, the seller\'s kept; a colour not published is not touched', () => {
    const before = planStudioImages({ rows: seller, colours: COLOURS, mockups: FRONT_BACK, replaceImages: true }).list;
    const changed = FRONT_BACK.map((m) => (m.key === 'svart:back' ? { ...m, objectId: 'o-svart-back-2' } : m));
    const after = planStudioImages({ rows: before, colours: COLOURS, mockups: changed }).list;
    assert.deepEqual(short(after), short(before).map((k) => k.replace('o-svart-back', 'o-svart-back-2')));
    assert.deepEqual(droppedStudioObjects(before, after, COLOURS), ['o-svart-back']);
    // Only Vit published now: Svart's studio rows (and the seller's) stay exactly as they were.
    const vitOnly = planStudioImages({ rows: before, colours: COLOURS.slice(0, 1), mockups: FRONT_BACK.slice(0, 2) }).list;
    assert.deepEqual(short(vitOnly.filter((r) => r.variantId?.startsWith('v-svart'))), short(before.filter((r) => r.variantId?.startsWith('v-svart'))));
    assert.ok(vitOnly.some((r) => r.objectId === 'o-svart-front' && r.variantId === null));
  });

  it('the same mockups again: the same list (nothing to write)', () => {
    const once = planStudioImages({ rows: seller, colours: COLOURS, mockups: FRONT_BACK }).list;
    const twice = planStudioImages({ rows: once, colours: COLOURS, mockups: FRONT_BACK }).list;
    assert.ok(sameStudioList(once, twice));
  });

  it('a row the studio wrote whose alt was cleared is the seller\'s now: kept, never removed', () => {
    const rows = [{ objectId: 'o-old-front', variantId: null, alt: null }, { objectId: 'o-old-front', variantId: 'v-vit-s', alt: null }];
    const { list } = planStudioImages({ rows, colours: COLOURS.slice(0, 1), mockups: FRONT_BACK.slice(0, 2) });
    assert.ok(list.some((r) => r.objectId === 'o-old-front' && r.variantId === null));
    assert.ok(list.some((r) => r.objectId === 'o-old-front' && r.variantId === 'v-vit-s'));
    assert.deepEqual(droppedStudioObjects(rows, list, COLOURS), []);
  });

  it('rows on an INACTIVE size of a colour are the colour\'s: the studio\'s go, the new sit on the first active size, the seller\'s stay (Codex FN2 r1)', () => {
    const rows = [
      { objectId: 'o-old', variantId: 'v-svart-s', alt: 'Svart – framsida' },
      { objectId: 'hand', variantId: 'v-svart-s', alt: null },
    ];
    const colours = [{ id: 'svart', label: 'Svart', variantIds: ['v-svart-m'], siblingIds: ['v-svart-s', 'v-svart-m'] }];
    const { list } = planStudioImages({ rows, colours, mockups: FRONT_BACK.slice(2) });
    assert.deepEqual(short(list.filter((r) => r.variantId)), ['v-svart-m:o-svart-front', 'v-svart-m:o-svart-back', 'v-svart-s:hand']);
    // Every size of the colour inactive: the old studio row still goes; the mockups stay in the gallery.
    const none = planStudioImages({ rows, colours: [{ ...colours[0], variantIds: [] }], mockups: FRONT_BACK.slice(2) });
    assert.deepEqual(short(none.list.filter((r) => r.variantId)), ['v-svart-s:hand']);
    assert.deepEqual(none.galleryOnly, ['Svart']);
  });

  it('a colour the product has no variant of: its mockups in the gallery only, said', () => {
    const plan = planStudioImages({ rows: [], colours: [{ id: 'vit', label: 'Vit', variantIds: [] }], mockups: FRONT_BACK.slice(0, 2) });
    assert.deepEqual(short(plan.list), ['-:o-vit-front', '-:o-vit-back']);
    assert.deepEqual(plan.galleryOnly, ['Vit']);
  });
});

describe('the mockups\' coverage and identity', () => {
  it('a colour without any mockup, and a side missing for another', () => {
    const out = mockupCoverage({ mockups: FRONT_BACK.slice(0, 3), colours: [...COLOURS, { id: 'sand', label: 'Sand' }], slots: ['front', 'back'] });
    assert.deepEqual(out, { colourless: ['Sand'], missingSides: [{ label: 'Svart', slot: 'back' }] });
  });

  it('the product\'s object for the same colour and side, by its alt text', () => {
    const rows = [{ objectId: 'x', variantId: null, alt: mockupAlt('Svart', 'back') }, { objectId: 'y', variantId: null, alt: 'Svart' }];
    assert.deepEqual(studioObjectsBySide(rows, FRONT_BACK, COLOURS), { 'svart:back': 'x' });
  });
});

describe('the 3D models', () => {
  it('the seller shape as the studio reads it: sorted by Swedish label, output null left to the compositor, broken entries dropped', () => {
    const models = models3dFromApi([
      { id: 'b', label: 'Ärmlös', views: { front: {} }, output: null, perColorway: {} },
      { id: 'a', label: 'T-shirt', views: { front: {} }, output: { w: 1600, h: 1800 }, perColorway: {} },
      { id: 'c', label: 'Hoodie', views: { front: {} } },
      { label: 'utan id', views: {} },
      null,
    ]);
    assert.deepEqual(models.map((m) => m.id), ['c', 'a', 'b']);
    assert.equal('output' in models[2], false);
    assert.deepEqual(models[1].output, { w: 1600, h: 1800 });
    assert.deepEqual(models3dFromApi(undefined), []);
  });
});
