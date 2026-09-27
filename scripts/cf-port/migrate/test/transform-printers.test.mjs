import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformSnapwearPrinter, SNAPWEAR_PRINTER_ID } from '../lib/transform-printers.mjs';

const printerDoc = {
  data: {
    garments: ['tee', 'hoodie'],
    name: 'Snapwear (Test)',
    pricing: { blankCostSek: { hoodie: 130, tee: 45 }, printCostSek: { back: 37, front: 37, pocket: 37 } },
    printAreasMm: { hoodie: { front: { h: 400, w: 300 } }, tee: { back: { h: 400, w: 300 }, front: { h: 400, w: 300 } } },
    provisionalAreas: [],
    shippingSek: 25,
    type: 'api',
  },
  id: 'snapwear',
};
const catalogDoc = {
  data: {
    models: { '64000': { back: { h: 400, w: 300 }, front: { h: 400, w: 300 } } },
    skus: { 'HOODIE-BLK-L': { garment: 'hoodie', model: '64000' }, 'TEE-BLK-M': { garment: 'tee', model: '64000' } },
    source: { generator: 'test-fixture' },
  },
  id: 'snapwear',
};

test('transformSnapwearPrinter: staging imports snapwear INACTIVE (D59)', () => {
  const { rows } = transformSnapwearPrinter({ catalogDoc, env: 'staging', nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), printerDoc });
  const printerRow = rows.find((r) => r.table === 'printers').statement;
  assert.match(printerRow, /'inactive'/);
  assert.match(printerRow, /'api'/);
});

test('transformSnapwearPrinter: production imports snapwear ACTIVE', () => {
  const { rows } = transformSnapwearPrinter({ catalogDoc, env: 'production', nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), printerDoc });
  const printerRow = rows.find((r) => r.table === 'printers').statement;
  assert.match(printerRow, /'active'/);
});

test('transformSnapwearPrinter: derives per-SKU tiers in exact integer öre from Firebase per-garment SEK', () => {
  const { report, rows } = transformSnapwearPrinter({ catalogDoc, env: 'staging', nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), printerDoc });
  const teeTier = rows.find((r) => r.table === 'printer_sku_tiers' && r.pk === 'snapwear:TEE-BLK-M').statement;
  // 45 kr -> 4500 öre
  assert.match(teeTier, /4500/);
  // print cost 37 kr -> 3700 öre, present in the print_costs_json
  assert.match(teeTier, /3700/);
  assert.equal(report.skuCount, 2);
});

test('transformSnapwearPrinter: a SKU whose garment has no blankCostSek entry is dropped and reported, never invented', () => {
  const patchedPrinter = { ...printerDoc, data: { ...printerDoc.data, pricing: { blankCostSek: { hoodie: 130 }, printCostSek: printerDoc.data.pricing.printCostSek } } }; // tee removed
  const { problems, report, rows } = transformSnapwearPrinter({ catalogDoc, env: 'staging', nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), printerDoc: patchedPrinter });
  const teeRow = rows.find((r) => r.table === 'printer_sku_tiers' && r.pk === 'snapwear:TEE-BLK-M');
  assert.equal(teeRow, undefined);
  assert.ok(report.skusDropped.includes('TEE-BLK-M'));
  assert.ok(problems.some((p) => p.includes('TEE-BLK-M')));
});

test('transformSnapwearPrinter: printer_catalog row carries a 64-hex-char sha256 over the stored bytes', () => {
  const { rows } = transformSnapwearPrinter({ catalogDoc, env: 'staging', nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), printerDoc });
  const catalogRow = rows.find((r) => r.table === 'printer_catalog').statement;
  assert.match(catalogRow, /'[0-9a-f]{64}'/);
});

test('transformSnapwearPrinter: absent printer/catalog docs report a problem and emit no rows', () => {
  const { problems, rows } = transformSnapwearPrinter({ catalogDoc: null, env: 'staging', nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), printerDoc: null });
  assert.deepEqual(rows, []);
  assert.ok(problems.length > 0);
});

test('SNAPWEAR_PRINTER_ID is "snapwear"', () => {
  assert.equal(SNAPWEAR_PRINTER_ID, 'snapwear');
});
