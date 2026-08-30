import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLATFORM_CUT_SEK, podCostForSlots, priceFloor, inklMoms, sellerProfitInkl, sellerProfitExVat, sellerMargin,
} from './podPricing.js';

// Kim's tier (2026-08-10, ex moms): tee 60, front 40, back 40, pocket 20.
const tee = { blankCostSek: 60, printCostSek: { front: 40, back: 40, pocket: 20 } };

test('platform cut is 40 kr EX moms (= 50 inkl), printer-independent', () => {
  assert.equal(PLATFORM_CUT_SEK, 40);
  assert.equal(inklMoms(PLATFORM_CUT_SEK), 50);
});

test('tee + front print: cost 140 ex → golv 196 inkl (pricing-verdict figure)', () => {
  const cost = podCostForSlots(tee, ['front']);
  assert.equal(cost, 140);
  assert.equal(priceFloor(cost), 196);
});

test('front+back charges one more print than front alone', () => {
  assert.equal(podCostForSlots(tee, ['front', 'back']) - podCostForSlots(tee, ['front']), 40);
});

test('display twins: profit inkl = profit ex × 1,25; margin ratio identical', () => {
  const cost = podCostForSlots(tee, ['front']);
  const price = 299;
  const ex = sellerProfitExVat(price, cost);
  assert.ok(ex > 0);
  assert.equal(sellerProfitInkl(price, cost), ex * 1.25);
  // Margin is profit/price on the same basis — unaffected by which basis is shown.
  assert.equal(sellerMargin(price, cost), ex / (price / 1.25));
});

test('at the floor the seller profit is ~0 (never negative)', () => {
  const cost = podCostForSlots(tee, ['front']);
  const p = sellerProfitInkl(priceFloor(cost), cost);
  assert.ok(p >= 0 && p < 1.5, `profit at floor was ${p}`);
});

test('unknown cost → null everywhere, never NaN', () => {
  assert.equal(inklMoms(undefined), null);
  assert.equal(sellerProfitInkl(299, undefined), null);
  assert.equal(podCostForSlots({}, ['front']), null);
});
