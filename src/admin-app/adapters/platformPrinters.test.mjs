// The platform printers page's adapter under Node (unit FK):
//   node --test src/admin-app/adapters/platformPrinters.test.mjs
// The round trip goes through the page's own form code (printerTierForm.js),
// so what is tested is what the page sends.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { docToForm, formToPricing, formToPrintAreas } from '../../components/platform/printerTierForm.js';
import { POD_GARMENTS } from '../../config/podGarments.js';
import {
  SLOT_IDS,
  kronorOf,
  minorOf,
  printerDocOf,
  printerErrorMessage,
  printerPatchOf,
  saveNoteOf,
  tierEditorNoteOf,
  editorFieldLabel,
  editorFieldsOf,
  previewConfirmText,
  previewNeedsConfirm,
} from './platformPrinters.js';

// An invented printer in the Worker's PlatformPrinterView shape: one model per
// garment (as the importer writes it), uniform prices per garment.
function view(overrides = {}) {
  return {
    printerId: 'fake-printer',
    tenantId: null,
    type: 'api',
    name: 'Exempeltryck',
    status: 'active',
    currency: 'SEK',
    shippingCostMinor: 3900,
    revision: 7,
    isDefault: true,
    catalog: null,
    capabilitiesValid: true,
    createdAt: '2026-09-20T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    capabilities: {
      models: {
        garment_tee: { garment: 'tee', printAreasMm: { front: { w: 280, h: 380, offsetTopMm: 70 }, back: { w: 280, h: 400 } } },
        garment_hoodie: { garment: 'hoodie', provisional: true, printAreasMm: { front: { w: 260, h: 300 } } },
        garment_mug: { garment: 'mug', printAreasMm: { front: { w: 90, h: 80 } } },
      },
      skus: {
        'TEE-S': { model: 'garment_tee', label: 'S' },
        'TEE-M': { model: 'garment_tee', label: 'M' },
        'HOOD-M': { model: 'garment_hoodie' },
        'MUG-1': { model: 'garment_mug' },
      },
    },
    tiers: [
      { sku: 'HOOD-M', blankCostMinor: 21300, printCostsMinor: { front: 3300, back: 3300 }, createdAt: 'x', updatedAt: 'x' },
      { sku: 'MUG-1', blankCostMinor: 1250, printCostsMinor: { front: 3300, back: 3300 }, createdAt: 'x', updatedAt: 'x' },
      { sku: 'TEE-M', blankCostMinor: 4750, printCostsMinor: { front: 3300, back: 3300 }, createdAt: 'x', updatedAt: 'x' },
      { sku: 'TEE-S', blankCostMinor: 4750, printCostsMinor: { front: 3300, back: 3300 }, createdAt: 'x', updatedAt: 'x' },
    ],
    ...overrides,
  };
}

/** What the page sends for a form (PlatformPrinters.jsx saveTier). */
function payloadOf(form) {
  const garments = POD_GARMENTS.filter((g) => form.garments.has(g.id)).map((g) => g.id);
  return {
    garments,
    pricing: formToPricing(form),
    printAreasMm: formToPrintAreas(form),
    provisionalAreas: garments.filter((g) => form.provisional.has(g)),
  };
}

const unchanged = (doc) => payloadOf(docToForm(doc));

describe('money units', () => {
  it('öre ↔ kronor exactly, at most two decimals', () => {
    assert.equal(kronorOf(4750), 47.5);
    assert.equal(kronorOf(7), 0.07);
    assert.equal(minorOf(0.07), 7);
    assert.equal(minorOf(47.5), 4750);
    assert.equal(minorOf(60), 6000);
    assert.equal(minorOf(undefined), undefined);
    assert.ok(Number.isNaN(minorOf(1.234)));
    assert.ok(Number.isNaN(minorOf(-1)));
    assert.ok(Number.isNaN(minorOf(100_000.01)));
    assert.equal(kronorOf(-5), undefined);
  });
  it('the slots are the Worker\'s PRINT_SLOTS', () => {
    assert.deepEqual(SLOT_IDS, ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve']);
  });
});

describe('printerDocOf', () => {
  it('projects models and tiers onto garments, slots and kronor', () => {
    const doc = printerDocOf(view());
    assert.equal(doc.id, 'fake-printer');
    assert.equal(doc.type, 'api');
    assert.equal(doc.active, true);
    assert.equal(doc.revision, 7);
    assert.deepEqual(doc.garments, ['tee', 'hoodie']); // a garment the page does not know (mug) is left out
    assert.deepEqual(doc.pricing.blankCostSek, { tee: 47.5, hoodie: 213 });
    assert.deepEqual(doc.pricing.printCostSek, { front: 33, back: 33 });
    assert.deepEqual(doc.printAreasMm, {
      tee: { front: { w: 280, h: 380, offsetTopMm: 70 }, back: { w: 280, h: 400 } },
      hoodie: { front: { w: 260, h: 300 } },
    });
    assert.deepEqual(doc.provisionalAreas, ['hoodie']);
    assert.deepEqual(doc.mixed, { blank: [], print: [], areas: [], provisional: [] });
    assert.equal(tierEditorNoteOf(doc), null);
  });

  it('an inactive printer reads inactive; an unpriced garment has no blank price', () => {
    const v = view({ status: 'inactive', tiers: [] });
    const doc = printerDocOf(v);
    assert.equal(doc.active, false);
    assert.deepEqual(doc.pricing, { blankCostSek: {}, printCostSek: {} });
  });

  it('values that differ between models or SKUs are mixed, shown empty, and named in the note', () => {
    const v = view();
    v.capabilities.models.tee_fitted = { garment: 'tee', provisional: true, printAreasMm: { front: { w: 230, h: 330, offsetTopMm: 70 }, back: { w: 280, h: 400 } } };
    v.capabilities.skus['TEE-F'] = { model: 'tee_fitted' };
    v.tiers.push({ sku: 'TEE-F', blankCostMinor: 5900, printCostsMinor: { front: 2500, back: 3300 } });
    const doc = printerDocOf(v);
    assert.deepEqual(doc.mixed, { blank: ['tee'], print: ['front'], areas: ['tee/front'], provisional: ['tee'] });
    assert.equal(doc.pricing.blankCostSek.tee, undefined);
    assert.equal(doc.pricing.printCostSek.front, undefined);
    assert.equal(doc.pricing.printCostSek.back, 33);
    assert.equal(doc.printAreasMm.tee.front, undefined);
    assert.deepEqual(doc.printAreasMm.tee.back, { w: 280, h: 400 });
    const note = tierEditorNoteOf(doc);
    assert.match(note, /T-shirt \(blankpris\)/);
    assert.match(note, /Bröst \(tryckpris\)/);
    assert.match(note, /T-shirt bröst \(tryckyta\)/);
    assert.match(note, /lämnas orört/);
  });

  it('a tenant printer and an invalid document are said in the note', () => {
    assert.match(tierEditorNoteOf(printerDocOf(view({ tenantId: 'test-shop-a' }))), /butiks eget tryckeri/);
    assert.match(tierEditorNoteOf(printerDocOf(view({ capabilitiesValid: false }))), /ogiltigt/);
  });
});

describe('printerPatchOf', () => {
  it('nothing changed → no request', () => {
    const doc = printerDocOf(view());
    assert.deepEqual(printerPatchOf(doc, unchanged(doc)), { body: null });
  });

  it('a garment\'s blank price goes to every SKU of that garment, fenced on the revision', () => {
    const doc = printerDocOf(view());
    const form = docToForm(doc);
    form.blank.tee = '52';
    const { body } = printerPatchOf(doc, payloadOf(form));
    assert.equal(body.expectedRevision, 7);
    assert.equal(body.capabilities, undefined);
    assert.deepEqual(body.tiers, {
      upsert: [
        { sku: 'TEE-M', blankCostMinor: 5200, printCostsMinor: { front: 3300, back: 3300 } },
        { sku: 'TEE-S', blankCostMinor: 5200, printCostsMinor: { front: 3300, back: 3300 } },
      ],
    });
  });

  it('a print price goes to every tier, also of a garment the page does not show', () => {
    const doc = printerDocOf(view());
    const form = docToForm(doc);
    form.print.front = '29,50'; // a comma is a decimal point (printerTierForm.js)
    form.print.pocket = '20';
    const { body } = printerPatchOf(doc, payloadOf(form));
    assert.equal(body.tiers.upsert.length, 4);
    for (const tier of body.tiers.upsert) {
      assert.deepEqual(tier.printCostsMinor, { front: 2950, back: 3300, pocket: 2000 });
    }
    assert.equal(body.tiers.upsert.find((t) => t.sku === 'MUG-1').blankCostMinor, 1250);
  });

  it('an emptied print price is removed from every tier; an emptied blank price unprices the garment', () => {
    const doc = printerDocOf(view());
    const form = docToForm(doc);
    form.print.back = '';
    form.blank.hoodie = '';
    const { body } = printerPatchOf(doc, payloadOf(form));
    assert.deepEqual(body.tiers.remove, ['HOOD-M']);
    assert.deepEqual(body.tiers.upsert.map((t) => t.sku), ['MUG-1', 'TEE-M', 'TEE-S']);
    for (const tier of body.tiers.upsert) assert.deepEqual(tier.printCostsMinor, { front: 3300 });
  });

  it('a price given to an unpriced garment creates its tiers with the printer-wide print prices', () => {
    const v = view();
    v.tiers = v.tiers.filter((t) => t.sku !== 'HOOD-M');
    const doc = printerDocOf(v);
    assert.equal(doc.pricing.blankCostSek.hoodie, undefined);
    const form = docToForm(doc);
    form.blank.hoodie = '199';
    const { body } = printerPatchOf(doc, payloadOf(form));
    assert.deepEqual(body.tiers, { upsert: [{ sku: 'HOOD-M', blankCostMinor: 19900, printCostsMinor: { front: 3300, back: 3300 } }] });
  });

  it('a frame goes to every model of its garment; an emptied frame is removed; the rest of the document is kept', () => {
    const v = view();
    v.capabilities.models.tee_two = { garment: 'tee', name: 'Två', printAreasMm: { front: { w: 280, h: 380, offsetTopMm: 70 }, back: { w: 280, h: 400 } } };
    const doc = printerDocOf(v);
    const form = docToForm(doc);
    form.areas.tee.front = { w: '300', h: '400', top: '' };
    form.areas.tee.back = { w: '', h: '', top: '' };
    const { body } = printerPatchOf(doc, payloadOf(form));
    assert.equal(body.tiers, undefined);
    assert.deepEqual(body.capabilities.models.garment_tee.printAreasMm, { front: { w: 300, h: 400 } });
    assert.deepEqual(body.capabilities.models.tee_two, { garment: 'tee', name: 'Två', printAreasMm: { front: { w: 300, h: 400 } } });
    assert.deepEqual(body.capabilities.models.garment_hoodie, v.capabilities.models.garment_hoodie);
    assert.deepEqual(body.capabilities.models.garment_mug, v.capabilities.models.garment_mug);
    assert.deepEqual(body.capabilities.skus, v.capabilities.skus);
    // The view handed in is not changed.
    assert.deepEqual(v.capabilities.models.garment_tee.printAreasMm.back, { w: 280, h: 400 });
  });

  it('the provisional flag is set and cleared on every model of the garment', () => {
    const doc = printerDocOf(view());
    const form = docToForm(doc);
    form.provisional = new Set(['tee']);
    const { body } = printerPatchOf(doc, payloadOf(form));
    assert.equal(body.capabilities.models.garment_tee.provisional, true);
    assert.equal('provisional' in body.capabilities.models.garment_hoodie, false);
  });

  it('a mixed field left untouched is not written; a value typed into it goes to all', () => {
    const v = view();
    v.tiers.find((t) => t.sku === 'TEE-S').blankCostMinor = 4500; // TEE-S 45 kr, TEE-M 47.50 kr
    const doc = printerDocOf(v);
    assert.deepEqual(doc.mixed.blank, ['tee']);
    assert.deepEqual(printerPatchOf(doc, unchanged(doc)), { body: null });
    const form = docToForm(doc);
    form.print.front = '30';
    const { body } = printerPatchOf(doc, payloadOf(form));
    assert.equal(body.tiers.upsert.find((t) => t.sku === 'TEE-S').blankCostMinor, 4500);
    assert.equal(body.tiers.upsert.find((t) => t.sku === 'TEE-M').blankCostMinor, 4750);
    form.blank.tee = '46';
    const all = printerPatchOf(doc, payloadOf(form)).body;
    assert.deepEqual(all.tiers.upsert.filter((t) => t.sku.startsWith('TEE')).map((t) => t.blankCostMinor), [4600, 4600]);
  });

  it('refuses, without a request: adding or removing a garment, a frame or price it cannot store, another currency', () => {
    const doc = printerDocOf(view());
    let form = docToForm(doc);
    form.garments.add('bag');
    form.garments.delete('hoodie');
    let out = printerPatchOf(doc, payloadOf(form));
    assert.equal(out.body, undefined);
    assert.match(out.problems.join(' '), /Tygkasse finns inte i tryckeriets katalog/);
    assert.match(out.problems.join(' '), /Hoodie tas inte bort/);

    form = docToForm(doc);
    form.areas.tee.front = { w: '280.5', h: '380', top: '' };
    form.blank.tee = '47.555';
    form.print.back = '100001';
    out = printerPatchOf(doc, payloadOf(form));
    assert.equal(out.problems.length, 3);
    assert.match(out.problems[0], /hela millimeter/);

    form = docToForm(doc);
    form.areas.tee.front = { w: '280', h: '380', top: '7.5' };
    assert.match(printerPatchOf(doc, payloadOf(form)).problems[0], /hela millimeter/);

    const eur = printerDocOf(view({ currency: 'EUR' }));
    form = docToForm(eur);
    form.blank.tee = '50';
    assert.match(printerPatchOf(eur, payloadOf(form)).problems[0], /EUR/);
  });

  it('refuses a tenant printer and an invalid document, before anything else', () => {
    const tenant = printerDocOf(view({ tenantId: 'test-shop-a' }));
    assert.match(printerPatchOf(tenant, unchanged(tenant)).problems[0], /Butikens eget tryckeri/);
    const broken = printerDocOf(view({ capabilitiesValid: false }));
    assert.match(printerPatchOf(broken, unchanged(broken)).problems[0], /ogiltigt/);
    assert.match(printerPatchOf(null, {}).problems[0], /hittades inte/);
  });
});

describe('the server\'s answers', () => {
  it('the save note says what the edit did to live products', () => {
    assert.equal(saveNoteOf({ diff: { belowFloor: { count: 0, products: [] } }, suspendedMappings: 0 }), null);
    assert.equal(
      saveNoteOf({ diff: { belowFloor: { count: 2, products: [] } }, suspendedMappings: 1 }),
      '1 produktkoppling pausades: tryckeriet kan inte längre göra den. 2 produkter ligger nu under prisgolvet.',
    );
    assert.match(saveNoteOf({ diff: { belowFloor: { count: null, tooManyToCheck: true } }, suspendedMappings: 3 }), /3 produktkopplingar.*för många/);
  });

  it('the refusals in the page\'s language', () => {
    assert.match(printerErrorMessage({ status: 409, code: 'revision_mismatch' }), /Ladda om sidan/);
    assert.match(printerErrorMessage({ status: 409, code: 'tenant_printer' }), /redigeras inte här/);
    assert.match(printerErrorMessage({ status: 422, code: 'tenant_printer' }), /standardtryckeri/);
    assert.match(printerErrorMessage({ status: 400, code: 'printer_not_allowed' }), /miljön/);
    assert.equal(printerErrorMessage({ status: 400, code: 'invalid_tiers', details: { problems: ['tier X: no'] } }), 'Servern godtog inte ändringen: tier X: no');
    assert.match(printerErrorMessage({ status: 422, code: 'printer_inactive' }), /aktivt/);
    assert.equal(printerErrorMessage({ status: 500, code: 'internal_error' }), null);
  });
});

describe('the save\'s dry run (CP5-FP)', () => {
  const quiet = { diff: { suspensions: [], belowFloor: { count: 0, products: [] } }, revision: 3, suspendedMappings: 0 };

  it('asks only when the save would pause mappings or leave products under their floor', () => {
    assert.equal(previewNeedsConfirm(quiet), false);
    assert.equal(previewNeedsConfirm({ ...quiet, suspendedMappings: 1 }), true);
    assert.equal(previewNeedsConfirm({ ...quiet, diff: { ...quiet.diff, belowFloor: { count: 2, products: [] } } }), true);
    assert.equal(previewNeedsConfirm({ ...quiet, diff: { ...quiet.diff, belowFloor: { count: null, tooManyToCheck: true } } }), true);
  });

  it('lists what the route gives, at most eight, then how many more', () => {
    const suspensions = Array.from({ length: 10 }, (_, i) => ({ mappingId: `m${i}`, productId: `p${i}`, reason: 'unpriced', sku: `S${i}`, tenantId: 'shop' }));
    const text = previewConfirmText({ diff: { suspensions, belowFloor: { count: 1, products: [{ tenantId: 'shop', productId: 'p1', variantId: null, priceMinor: 19900, newFloorMinor: 21900, live: true }] } }, suspendedMappings: 10 }, { printerName: 'Fake' });
    assert.match(text, /^Spara ändringen av Fake\?/);
    assert.match(text, /10 produktkopplingar pausas/);
    assert.equal((text.match(/artikeln saknar pris/g) || []).length, 8);
    assert.match(text, /· och 2 till/);
    assert.match(text, /1 produkt hamnar under prisgolvet.*\n· shop · produkt p1: pris 199,00 kr, nytt golv 219,00 kr, till salu nu/);
    assert.match(previewConfirmText(quiet, { rebased: true }), /ändrades av någon annan/);
  });

  it('the editor\'s fields and their names, for a merge', () => {
    const fields = editorFieldsOf({ garments: ['hoodie', 'tee'], pricing: { blankCostSek: { tee: 50 } }, printAreasMm: {}, provisionalAreas: [] });
    assert.deepEqual(fields.garments, ['hoodie', 'tee']);
    assert.deepEqual(fields.pricing.printCostSek, {});
    assert.match(editorFieldLabel(['pricing', 'blankCostSek', 'tee']), /\(blankpris\)$/);
    assert.match(editorFieldLabel(['printAreasMm', 'tee', 'front']), /\(tryckyta\)$/);
  });
});
