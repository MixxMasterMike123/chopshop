// The studio's flat prints, pure: node --test src/admin-app/adapters/studioFlat.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLEED_MM,
  createRevision,
  DEFAULT_BACKGROUND,
  SAFE_MM,
  finishLabel,
  fitRect,
  flatArea,
  flatEffectiveDpi,
  flatGarmentLabel,
  flatKeyParts,
  flatPlacement,
  flatProductsFromPrinters,
  flatPublishShape,
  flatQualifies,
  flatResolutionText,
  mappingPlacement,
  mappingSlotsBody,
  normalizeHex,
  samePlacement,
  sheetInchLabel,
  sheetSizeLabel,
  sheetVariantLabel,
  sizesInFinish,
} from './studioFlat.js';
import { matchArticle, planScopeMappings, productionFromPrinters } from './studio.js';

// The tenant view of the posters printer as the contract shapes it (CP12_BRIEFS.md):
// kind, garment, the front area in mm with its exact px; nothing of attributes or costs.
const poster = (w, h, pw, ph) => ({ garment: 'poster', kind: 'flat', name: `Poster ${w}x${h}`, printAreasMm: { front: { w, h, px: { w: pw, h: ph } } } });
const PRINTERS = [
  {
    printerId: 'prodigi-prints',
    name: 'Prodigi affischer',
    capabilities: {
      models: {
        'BFP-18X24': poster(450, 600, 5314, 7086),
        'BFP-12X16': poster(300, 400, 3543, 4724),
        'BFP-11X14': poster(280, 355, 3307, 4192),
        'BFP-NOPX': { garment: 'poster', kind: 'flat', printAreasMm: { front: { w: 400, h: 500 } } },
      },
      skus: {
        'GLOBAL-BFP-18X24.white-frame.18x24': { model: 'BFP-18X24' },
        'GLOBAL-BFP-12X16.white-frame.12x16': { label: 'White frame / 12x16', model: 'BFP-12X16' },
        'GLOBAL-BFP-11X14.white-frame.11x14': { model: 'BFP-11X14' },
        'GLOBAL-BFP-12X16.black-frame.12x16': { model: 'BFP-12X16' },
        'GLOBAL-BFP-16X20.white-frame.16x20': { model: 'BFP-NOPX' },
        'BADKEY': { model: 'BFP-12X16' },
      },
    },
  },
  {
    printerId: 'dev-printer',
    name: 'Testtryckeriet',
    capabilities: {
      models: { tee: { garment: 'tee', name: 'Tee', printAreasMm: { front: { w: 250, h: 350 } } } },
      skus: { 'TEE-S': { label: 'Vit / S', model: 'tee' } },
    },
  },
];

describe('flatProductsFromPrinters', () => {
  const families = flatProductsFromPrinters(PRINTERS);

  it('makes one family per printer and garment, only of flat models', () => {
    assert.equal(families.length, 1);
    const [f] = families;
    assert.equal(f.printerId, 'prodigi-prints');
    assert.equal(f.garment, 'poster');
    assert.equal(f.label, 'Affisch (ramad)');
    assert.equal(f.key, 'prodigi-prints/poster');
  });

  it('lists the usable sizes from the smallest sheet, leaving out a model without px and a key without finish/sheet', () => {
    const [f] = families;
    assert.deepEqual(f.sizes.map((s) => s.sku), [
      'GLOBAL-BFP-11X14.white-frame.11x14',
      'GLOBAL-BFP-12X16.black-frame.12x16',
      'GLOBAL-BFP-12X16.white-frame.12x16',
      'GLOBAL-BFP-18X24.white-frame.18x24',
    ]);
    const s = f.sizes.find((x) => x.sku === 'GLOBAL-BFP-12X16.white-frame.12x16');
    assert.deepEqual(s, {
      sku: 'GLOBAL-BFP-12X16.white-frame.12x16', modelKey: 'BFP-12X16', finish: 'white-frame', sheet: '12x16',
      label: '30 × 40 cm', variantLabel: '30 × 40', inchLabel: '12 × 16 tum', mm: { w: 300, h: 400 }, px: { w: 3543, h: 4724 },
    });
    assert.equal(f.sizes[0].label, '28 × 35,5 cm');
  });

  it('names the finishes in Swedish, in the order the sizes bring them', () => {
    assert.deepEqual(families[0].finishes.map((x) => [x.id, x.label]), [['white-frame', 'Vit ram'], ['black-frame', 'Svart ram']]);
    assert.deepEqual(sizesInFinish(families[0], 'black-frame').map((s) => s.sheet), ['12x16']);
  });

  it('answers nothing for no printers or rubbish', () => {
    assert.deepEqual(flatProductsFromPrinters(null), []);
    assert.deepEqual(flatProductsFromPrinters([{ printerId: 'x' }, null, 'p']), []);
  });

  it('keeps flat models out of the garment studio (productionFromPrinters)', () => {
    const { printersById, options } = productionFromPrinters(PRINTERS);
    assert.deepEqual(Object.keys(options), ['tee']);
    assert.ok(Object.values(printersById).every((e) => e.printerId === 'dev-printer'));
  });
});

describe('labels and keys', () => {
  it('reads the finish and sheet from the key', () => {
    assert.deepEqual(flatKeyParts('GLOBAL-BFP-12X16.white-frame.12x16'), { finish: 'white-frame', sheet: '12x16' });
    assert.equal(flatKeyParts('NOPARTS'), null);
    assert.equal(flatKeyParts('a.b'), null);
  });
  it('says sizes in cm (the variant\'s without the unit) and inches', () => {
    assert.equal(sheetSizeLabel({ w: 450, h: 600 }), '45 × 60 cm');
    assert.equal(sheetSizeLabel({ w: 280, h: 355 }), '28 × 35,5 cm');
    assert.equal(sheetVariantLabel({ w: 280, h: 355 }), '28 × 35,5');
    assert.equal(sheetVariantLabel({ w: 280, h: 355 }).toUpperCase(), '28 × 35,5');
    assert.equal(sheetSizeLabel(null), '');
    assert.equal(sheetInchLabel('18x24'), '18 × 24 tum');
    assert.equal(sheetInchLabel('5_5x5_5'), '5,5 × 5,5 tum');
    assert.equal(sheetInchLabel('a4'), '');
  });
  it('labels finishes and families', () => {
    assert.equal(finishLabel('white-frame'), 'Vit ram');
    assert.equal(finishLabel('matte-paper'), 'Matte paper');
    assert.equal(flatGarmentLabel('postcard'), 'Vykort');
    assert.equal(flatGarmentLabel('mug'), 'mug');
  });
  it('reads a flat area only with exact pixels', () => {
    assert.deepEqual(flatArea(poster(300, 400, 3543, 4724)), { mm: { w: 300, h: 400 }, px: { w: 3543, h: 4724 } });
    assert.equal(flatArea({ printAreasMm: { front: { w: 300, h: 400, px: { w: 0, h: 4724 } } } }), null);
    assert.equal(flatArea({}), null);
  });
  it('keeps the bleed inside the safe margin', () => {
    assert.ok(BLEED_MM > 0 && SAFE_MM > BLEED_MM);
  });
});

describe('flatQualifies (contain at the sheet\'s exact px)', () => {
  const px = { w: 3543, h: 4724 };
  it('passes a portrait 3:4 original at the sheet size or larger', () => {
    assert.deepEqual(flatQualifies({ sourceWidthPx: 4200, sourceHeightPx: 5600 }, px), { ok: true, minW: 3543, minH: 4724 });
    assert.deepEqual(flatQualifies({ sourceWidthPx: 3543, sourceHeightPx: 4724 }, px), { ok: true, minW: 3543, minH: 4724 });
  });
  it('fails one pixel short and names the least size at the artwork\'s own aspect', () => {
    assert.deepEqual(flatQualifies({ sourceWidthPx: 3542, sourceHeightPx: 4723 }, px), { ok: false, minW: 3543, minH: 4724 });
    // A square binds on the width: 3543 × 3543.
    assert.deepEqual(flatQualifies({ sourceWidthPx: 3000, sourceHeightPx: 3000 }, px), { ok: false, minW: 3543, minH: 3543 });
    // A tall 1:3 binds on the height.
    assert.deepEqual(flatQualifies({ sourceWidthPx: 1000, sourceHeightPx: 3000 }, px), { ok: false, minW: 1575, minH: 4724 });
  });
  it('says the text, or nothing', () => {
    assert.equal(flatResolutionText({ ok: false, minW: 5314, minH: 7086 }), 'För låg upplösning (minst 5314×7086 px)');
    assert.equal(flatResolutionText({ ok: true, minW: 1, minH: 1 }), null);
    assert.equal(flatResolutionText(null), null);
  });
  it('under cover needs both axes (never enlarged), as the Worker\'s flatReachesPx', () => {
    // 4200×5600 (3:4) reaches 12x16 on both axes.
    assert.deepEqual(flatQualifies({ sourceWidthPx: 4200, sourceHeightPx: 5600 }, px, 'cover'), { ok: true, minW: 3543, minH: 4724 });
    // A square 4000 contains in 12x16 (width binds) but cannot fill it: needs 4724 × 4724.
    assert.equal(flatQualifies({ sourceWidthPx: 4000, sourceHeightPx: 4000 }, px, 'contain').ok, true);
    assert.deepEqual(flatQualifies({ sourceWidthPx: 4000, sourceHeightPx: 4000 }, px, 'cover'), { ok: false, minW: 4724, minH: 4724 });
    // A tall 1:3 must reach the width to fill: 3543 × 10629.
    assert.deepEqual(flatQualifies({ sourceWidthPx: 1000, sourceHeightPx: 3000 }, px, 'cover'), { ok: false, minW: 3543, minH: 10629 });
  });
  it('agrees with the Worker\'s one-axis contain rule on every aspect', () => {
    const reaches = (a, p, fit) => (fit === 'cover' ? a.w >= p.w && a.h >= p.h : a.w >= p.w || a.h >= p.h);
    for (const w of [1000, 3000, 3543, 3600, 4724, 6000]) {
      for (const h of [1000, 3543, 4724, 5000, 9000]) {
        for (const fit of ['contain', 'cover']) {
          assert.equal(flatQualifies({ sourceWidthPx: w, sourceHeightPx: h }, px, fit).ok, reaches({ w, h }, px, fit), `${w}×${h} ${fit}`);
        }
      }
    }
  });
  it('cannot judge an artwork without size', () => {
    assert.equal(flatQualifies({ sourceWidthPx: null, sourceHeightPx: 10 }, px), null);
    assert.equal(flatQualifies({ sourceWidthPx: 10, sourceHeightPx: 10 }, null), null);
  });
});

describe('fitRect and the effective dpi', () => {
  it('contains: whole motif, centred, letterboxed', () => {
    assert.deepEqual(fitRect({ w: 100, h: 100 }, { w: 300, h: 400 }, 'contain'), { x: 0, y: 50, w: 300, h: 300, scale: 3 });
  });
  it('covers: fills the sheet, cropped at the edges', () => {
    assert.deepEqual(fitRect({ w: 100, h: 100 }, { w: 300, h: 400 }, 'cover'), { x: -50, y: 0, w: 400, h: 400, scale: 4 });
  });
  it('answers null without sizes', () => {
    assert.equal(fitRect({ w: 0, h: 1 }, { w: 1, h: 1 }, 'cover'), null);
  });
  it('measures the dpi at each fit', () => {
    const size = { mm: { w: 300, h: 400 } };
    assert.equal(flatEffectiveDpi({ sourceWidthPx: 3543, sourceHeightPx: 4724 }, size, 'contain'), 299); // floor of 299.99…
    assert.equal(flatEffectiveDpi({ sourceWidthPx: 3600, sourceHeightPx: 3600 }, size, 'contain'), 304);
    assert.equal(flatEffectiveDpi({ sourceWidthPx: 3600, sourceHeightPx: 3600 }, size, 'cover'), 228);
  });
});

describe('the frozen placement', () => {
  it('normalises colours', () => {
    assert.equal(normalizeHex('#FFF'), '#ffffff');
    assert.equal(normalizeHex('1A2b3C'), '#1a2b3c');
    assert.equal(normalizeHex('red'), null);
  });
  it('freezes contain with its background (white by default) and cover on white', () => {
    assert.deepEqual(flatPlacement('contain', '#000'), { fit: 'contain', background: '#000000' });
    assert.deepEqual(flatPlacement('contain', 'nonsense'), { fit: 'contain', background: DEFAULT_BACKGROUND });
    assert.deepEqual(flatPlacement('cover', '#000000'), { fit: 'cover', background: '#ffffff' });
    assert.throws(() => flatPlacement('stretch'));
  });
  it('writes a flat slot as an object with its placement, a garment\'s as names', () => {
    assert.deepEqual(mappingSlotsBody(['front', 'back'], null), ['front', 'back']);
    assert.deepEqual(mappingSlotsBody(['front'], { fit: 'contain', background: '#ABCDEF' }), [{ slot: 'front', fit: 'contain', background: '#abcdef' }]);
    assert.deepEqual(mappingSlotsBody(['front'], { fit: 'cover', background: '#abcdef' }), [{ slot: 'front', fit: 'cover', background: '#ffffff' }]);
  });
  it('reads a mapping\'s placement from the mapping or its front slot', () => {
    assert.deepEqual(mappingPlacement({ fit: 'cover' }), { fit: 'cover', background: '#ffffff' });
    assert.deepEqual(mappingPlacement({ slots: [{ slot: 'front', widthMm: 300, heightMm: 400, fit: 'contain', background: '#FFFFFF' }] }), { fit: 'contain', background: '#ffffff' });
    assert.equal(mappingPlacement({ slots: ['front'] }), null);
    assert.equal(mappingPlacement(null), null);
  });
  it('compares placements', () => {
    assert.ok(samePlacement(null, null));
    assert.ok(!samePlacement({ fit: 'cover' }, null));
    assert.ok(samePlacement({ fit: 'cover', background: '#ffffff' }, { fit: 'cover' }));
    assert.ok(!samePlacement({ fit: 'cover', background: '#000000' }, { fit: 'cover', background: '#ffffff' }));
    assert.ok(samePlacement({ fit: 'contain', background: '#FFF' }, { fit: 'contain', background: '#ffffff' }));
    assert.ok(!samePlacement({ fit: 'contain', background: '#fff' }, { fit: 'contain', background: '#000' }));
  });
});

describe('planScopeMappings with a flat placement', () => {
  const live = (fit, background) => ({ mappingId: 'm1', status: 'active', artworkId: 'a1', printerId: 'p', sku: 'K', slots: [{ slot: 'front', widthMm: 300, heightMm: 400, fit, background }] });
  const want = (placement) => [{ artworkId: 'a1', printerId: 'p', sku: 'K', slots: ['front'], placement }];
  it('keeps a mapping frozen with the same placement', () => {
    assert.deepEqual(planScopeMappings([live('contain', '#ffffff')], want({ fit: 'contain', background: '#FFFFFF' })), { keep: ['m1'], deletes: [], posts: [] });
  });
  it('replaces one frozen with another fit or background', () => {
    const plan = planScopeMappings([live('contain', '#ffffff')], want({ fit: 'cover' }));
    assert.deepEqual(plan.deletes, ['m1']);
    assert.equal(plan.posts.length, 1);
    assert.deepEqual(planScopeMappings([live('contain', '#ffffff')], want({ fit: 'contain', background: '#000000' })).deletes, ['m1']);
  });
  it('re-posts when only the background changed under cover (as the Worker stores it)', () => {
    const plan = planScopeMappings([live('cover', '#000000')], want({ fit: 'cover' }));
    assert.deepEqual(plan.deletes, ['m1']);
    assert.equal(plan.posts.length, 1);
    assert.deepEqual(planScopeMappings([live('cover', '#ffffff')], want({ fit: 'cover' })).keep, ['m1']);
  });
  it('a garment row (no placement) is compared as before', () => {
    const garment = [{ artworkId: 'a1', printerId: 'p', sku: 'K', slots: ['front'] }];
    assert.deepEqual(planScopeMappings([live(undefined, undefined)], garment).keep, ['m1']);
  });
});

describe('flatPublishShape', () => {
  const [family] = flatProductsFromPrinters(PRINTERS);
  it('gives the panel one colourway (the finish), the ticked sizes and their articles', () => {
    const shape = flatPublishShape(family, 'white-frame', ['GLOBAL-BFP-18X24.white-frame.18x24', 'GLOBAL-BFP-11X14.white-frame.11x14', 'GLOBAL-BFP-12X16.black-frame.12x16']);
    assert.deepEqual(shape.template.colorways, [{ id: 'white-frame', label: 'Vit ram', hex: '#f4f3ef' }]);
    assert.deepEqual(shape.sizeLabels, ['28 × 35,5', '45 × 60']);
    assert.deepEqual(shape.production.articles.map((a) => a.label), ['Vit ram / 28 × 35,5', 'Vit ram / 45 × 60']);
    assert.equal(shape.production.printerId, 'prodigi-prints');
    assert.deepEqual(shape.production.articles.map((a) => a.sku), ['GLOBAL-BFP-11X14.white-frame.11x14', 'GLOBAL-BFP-18X24.white-frame.18x24']);
  });
  it('labels the articles so the panel preselects each size (matchArticle)', () => {
    const shape = flatPublishShape(family, 'white-frame', family.sizes.map((s) => s.sku));
    const cw = shape.template.colorways[0];
    for (const [i, size] of shape.sizeLabels.entries()) {
      assert.equal(matchArticle(shape.production.articles, cw, size), shape.production.articles[i].sku);
    }
  });
  it('is null with nothing ticked or an unknown finish', () => {
    assert.equal(flatPublishShape(family, 'white-frame', []), null);
    assert.equal(flatPublishShape(family, 'gold', family.sizes.map((s) => s.sku)), null);
  });
});

describe('createRevision (a render installs only while its design is current)', () => {
  it('a render started before a change is stale after it', () => {
    const rev = createRevision();
    const started = rev.current();
    assert.ok(rev.isCurrent(started));
    rev.bump(); // the seller went back and changed the fit
    assert.ok(!rev.isCurrent(started), 'the stale render is discarded');
    const again = rev.current();
    assert.ok(rev.isCurrent(again));
    assert.equal(rev.bump(), again + 1);
  });
});
