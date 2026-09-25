import assert from 'node:assert/strict';
import test from 'node:test';
import * as podPricing from './podPricing.js';

const { priceFloor, inklMoms, sellerProfitInkl, sellerProfitExVat, sellerMargin } = podPricing;

// The studio receives the production cost as ONE quoted number (quotePodCost,
// A13) — 140 kr ex moms is a tee + front print on Kim's tier incl. the cut.
const QUOTED = 140;

test('A13: the client pricing module cannot build a cost (no cut, no tier math)', () => {
  assert.equal('PLATFORM_CUT_SEK' in podPricing, false);
  assert.equal('podCostForSlots' in podPricing, false);
});

test('quoted cost 140 ex → golv 196 inkl (pricing-verdict figure)', () => {
  assert.equal(priceFloor(QUOTED), 196);
});

test('display twins: profit inkl = profit ex × 1,25; margin ratio identical', () => {
  const cost = QUOTED;
  const price = 299;
  const ex = sellerProfitExVat(price, cost);
  assert.ok(ex > 0);
  assert.equal(sellerProfitInkl(price, cost), ex * 1.25);
  // Margin is profit/price on the same basis — unaffected by which basis is shown.
  assert.equal(sellerMargin(price, cost), ex / (price / 1.25));
});

test('at the floor the seller profit is ~0 (never negative)', () => {
  const cost = QUOTED;
  const p = sellerProfitInkl(priceFloor(cost), cost);
  assert.ok(p >= 0 && p < 1.5, `profit at floor was ${p}`);
});

test('unknown cost → null everywhere, never NaN', () => {
  assert.equal(inklMoms(undefined), null);
  assert.equal(sellerProfitInkl(299, undefined), null);
  assert.equal(priceFloor(undefined), null);
});
