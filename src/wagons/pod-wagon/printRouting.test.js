import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePrinterUid, tierCostForSlots, podCostForSlotsRouted } from './printRouting.js';
import { PLATFORM_CUT_SEK } from './podPricing.js';

// Two printers. KIM makes tees and hoodies (Kim's list 2026-08-10, ex moms);
// SMALAND is the catch-all default and makes only caps.
const KIM = {
  garments: ['tee', 'hoodie'],
  pricing: { blankCostSek: { tee: 60, hoodie: 380 }, printCostSek: { front: 40, back: 40, pocket: 20 } },
};
const SMALAND = {
  garments: ['cap'],
  pricing: { blankCostSek: { cap: 50 }, printCostSek: { front: 35 } },
};
const printersById = { kim: KIM, smaland: SMALAND };

// The template's LEGACY prices — the pre-routing basis, deliberately different
// from Kim's so a test can tell which basis produced a number.
const legacyTee = { blankCostSek: 70, printCostSek: { front: 45, back: 45 } };

test('explicit route wins when the printer offers the garment', () => {
  const routing = { byGarment: { tee: 'kim' }, defaultPrinterUid: 'smaland' };
  assert.equal(resolvePrinterUid('tee', routing, printersById), 'kim');
});

test('route to a printer that does NOT list the garment falls through to the default', () => {
  // Stale rule: hoodie was routed to Småland, who never made hoodies.
  const routing = { byGarment: { hoodie: 'smaland' }, defaultPrinterUid: 'kim' };
  assert.equal(resolvePrinterUid('hoodie', routing, printersById), 'kim');
});

test('route to a printer with no tier doc at all falls through to the default', () => {
  const routing = { byGarment: { tee: 'deleted-uid' }, defaultPrinterUid: 'smaland' };
  assert.equal(resolvePrinterUid('tee', routing, printersById), 'smaland');
});

test('a deactivated printer is never routed — explicit route AND default fall through', () => {
  const withInactiveKim = { ...printersById, kim: { ...printersById.kim, active: false } };
  assert.equal(resolvePrinterUid('tee', { byGarment: { tee: 'kim' }, defaultPrinterUid: 'smaland' }, withInactiveKim), 'smaland');
  assert.equal(resolvePrinterUid('tee', { byGarment: {}, defaultPrinterUid: 'kim' }, withInactiveKim), null);
  // absent flag = active (pre-mirror docs)
  assert.equal(resolvePrinterUid('tee', { byGarment: { tee: 'kim' } }, printersById), 'kim');
});

test('no default and no usable route → null', () => {
  assert.equal(resolvePrinterUid('tee', { byGarment: {} }, printersById), null);
  assert.equal(resolvePrinterUid('tee', { byGarment: { tee: 'gone' }, defaultPrinterUid: null }, printersById), null);
  assert.equal(resolvePrinterUid('tee', null, null), null);
});

test('a default that has no tier doc is not a printer either', () => {
  assert.equal(resolvePrinterUid('tee', { byGarment: {}, defaultPrinterUid: 'gone' }, printersById), null);
});

test('unknown or missing garment goes straight to the default', () => {
  const routing = { byGarment: { tee: 'kim' }, defaultPrinterUid: 'smaland' };
  assert.equal(resolvePrinterUid('parasol', routing, printersById), 'smaland');
  assert.equal(resolvePrinterUid(null, routing, printersById), 'smaland');
  assert.equal(resolvePrinterUid('   ', routing, printersById), 'smaland');
});

test('tierCostForSlots: blank + one print price per designed slot', () => {
  assert.equal(tierCostForSlots(KIM, 'tee', ['front']), 100);       // 60 + 40
  assert.equal(tierCostForSlots(KIM, 'tee', []), 60);                // blank only
});

test('tierCostForSlots: front+back charges one print more than front alone', () => {
  assert.equal(tierCostForSlots(KIM, 'tee', ['front', 'back']) - tierCostForSlots(KIM, 'tee', ['front']), 40);
});

test('tierCostForSlots: missing blank price for the garment → null', () => {
  assert.equal(tierCostForSlots(KIM, 'cap', ['front']), null);       // Kim never quoted caps
  assert.equal(tierCostForSlots(KIM, null, ['front']), null);
  assert.equal(tierCostForSlots(null, 'tee', ['front']), null);
});

test('tierCostForSlots: an unpriced SLOT counts 0, it does not null the cost', () => {
  assert.equal(tierCostForSlots(SMALAND, 'cap', ['front', 'back']), 85); // 50 + 35 + 0
});

test('routed cost = printer tier + the platform cut; tee front = 60+40+40 = 140', () => {
  const routing = { byGarment: { tee: 'kim' }, defaultPrinterUid: null };
  const r = podCostForSlotsRouted({ garment: 'tee', slots: ['front'], routing, printersById, template: legacyTee });
  assert.deepEqual(r, { cost: 140, source: 'printer', printerUid: 'kim' });
  assert.equal(r.cost, 60 + 40 + PLATFORM_CUT_SEK);
});

test('no routing configured → the template legacy prices, printerUid null', () => {
  const r = podCostForSlotsRouted({ garment: 'tee', slots: ['front'], routing: {}, printersById: {}, template: legacyTee });
  assert.deepEqual(r, { cost: 70 + 45 + PLATFORM_CUT_SEK, source: 'template', printerUid: null });
});

test('routed printer without a blank price for the garment falls back to the template', () => {
  // Småland is the default but has never quoted a tee.
  const routing = { byGarment: {}, defaultPrinterUid: 'smaland' };
  const r = podCostForSlotsRouted({ garment: 'tee', slots: ['front'], routing, printersById, template: legacyTee });
  assert.equal(r.source, 'template');
  assert.equal(r.printerUid, null);
});

test('neither basis can price it → cost null, source null', () => {
  const r = podCostForSlotsRouted({ garment: 'tee', slots: ['front'], routing: {}, printersById: {}, template: {} });
  assert.deepEqual(r, { cost: null, source: null, printerUid: null });
});

test('the routed cost tracks the DESIGNED slots (front+back costs one print more)', () => {
  const routing = { byGarment: { tee: 'kim' }, defaultPrinterUid: null };
  const one = podCostForSlotsRouted({ garment: 'tee', slots: ['front'], routing, printersById, template: legacyTee });
  const two = podCostForSlotsRouted({ garment: 'tee', slots: ['front', 'back'], routing, printersById, template: legacyTee });
  assert.equal(two.cost - one.cost, 40);
});
