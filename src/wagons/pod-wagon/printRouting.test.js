import assert from 'node:assert/strict';
import test from 'node:test';
import * as printRouting from './printRouting.js';

const { resolvePrinterUid, isSlotPrintable } = printRouting;

// Two printers, as the studio sees them (printersPublic — capability only, no
// prices). KIM makes tees and hoodies; SMALAND is the catch-all default and
// makes only caps.
const KIM = { garments: ['tee', 'hoodie'] };
const SMALAND = { garments: ['cap'] };
const printersById = { kim: KIM, smaland: SMALAND };

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
  const routing = { byGarment: { cap: 'deleted-uid' }, defaultPrinterUid: 'smaland' };
  assert.equal(resolvePrinterUid('cap', routing, printersById), 'smaland');
});

test('a deactivated printer is never routed — explicit route AND default fall through', () => {
  const withInactiveKim = { ...printersById, kim: { ...printersById.kim, active: false } };
  const withInactiveSmaland = { ...printersById, smaland: { ...printersById.smaland, active: false } };
  assert.equal(resolvePrinterUid('hoodie', { byGarment: { hoodie: 'smaland' }, defaultPrinterUid: 'kim' }, printersById), 'kim');
  assert.equal(resolvePrinterUid('cap', { byGarment: { cap: 'smaland' }, defaultPrinterUid: 'kim' }, withInactiveSmaland), null);
  // …and a default that does not make the garment is no fallback either (A4).
  assert.equal(resolvePrinterUid('tee', { byGarment: { tee: 'kim' }, defaultPrinterUid: 'smaland' }, withInactiveKim), null);
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

test('unknown or missing garment routes to NOBODY — no printer lists it (SnapWear A4)', () => {
  const routing = { byGarment: { tee: 'kim' }, defaultPrinterUid: 'smaland' };
  assert.equal(resolvePrinterUid('parasol', routing, printersById), null);
  assert.equal(resolvePrinterUid(null, routing, printersById), null);
  assert.equal(resolvePrinterUid('   ', routing, printersById), null);
});

test('the default printer must also MAKE the garment (bypass closed, SnapWear A4)', () => {
  const routing = { byGarment: {}, defaultPrinterUid: 'smaland' };
  assert.equal(resolvePrinterUid('tee', routing, printersById), null); // Småland: caps only
  assert.equal(resolvePrinterUid('cap', routing, printersById), 'smaland');
});

test('isSlotPrintable: absent slot = cannot print; pocket rides on front; no frames = open', () => {
  const snap = {
    printAreasMm: {
      tee: { front: { w: 390, h: 490 }, back: { w: 390, h: 490 } },
    },
  };
  assert.equal(isSlotPrintable(snap, 'tee', 'front'), true);
  assert.equal(isSlotPrintable(snap, 'tee', 'pocket'), true);
  assert.equal(isSlotPrintable(snap, 'tee', 'left_sleeve'), false);
  assert.equal(isSlotPrintable(snap, 'hoodie', 'left_sleeve'), true); // no frames for hoodie
  assert.equal(isSlotPrintable(KIM, 'tee', 'left_sleeve'), true);     // no printAreasMm at all
});

test('A13: the client twin carries NO cost code (cost is server-only, quotePodCost)', () => {
  assert.equal('tierCostForSlots' in printRouting, false);
  assert.equal('podCostForSlotsRouted' in printRouting, false);
});
