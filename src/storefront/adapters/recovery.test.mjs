// The reminder link's cart plan (CP9-AC), under Node:
//   node --test src/storefront/adapters/recovery.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recoveryPlan, recoveryProductIds } from './recovery.js';

const MUG = { productId: 'p-mug', name: 'Mugg', priceMinor: 12_900, variants: [] };
const TEE = {
  productId: 'p-tee',
  name: 'T-shirt',
  priceMinor: 29_900,
  variants: [
    { variantId: 'v-tee-m', sku: 'TEE-M', label: 'M', priceMinor: 29_900 },
    { variantId: 'v-tee-l', sku: 'TEE-L', label: 'L', priceMinor: 31_900 },
  ],
};

describe('recoveryPlan', () => {
  it('matches each line against the LIVE product and its variant, keeping the quantity', () => {
    const plan = recoveryPlan(
      [
        { productId: 'p-tee', quantity: 2, variantId: 'v-tee-l' },
        { productId: 'p-mug', quantity: 1 },
      ],
      { 'p-mug': MUG, 'p-tee': TEE },
    );
    assert.equal(plan.missing, 0);
    assert.deepEqual(plan.lines, [
      { product: TEE, quantity: 2, variant: TEE.variants[1] },
      { product: MUG, quantity: 1, variant: null },
    ]);
  });

  it('counts a product the read answered 404 for, an unknown variant and a malformed line as missing', () => {
    const plan = recoveryPlan(
      [
        { productId: 'p-gone', quantity: 1 },
        { productId: 'p-tee', quantity: 1, variantId: 'v-tee-xl' },
        { productId: 'p-mug', quantity: 0 },
        { productId: 'p-mug', quantity: 1.5 },
        { productId: 'p-mug', quantity: 1000 },
        { quantity: 1 },
        null,
        { productId: 'p-mug', quantity: 3 },
      ],
      { 'p-gone': null, 'p-mug': MUG, 'p-tee': TEE },
    );
    assert.equal(plan.missing, 7);
    assert.deepEqual(plan.lines, [{ product: MUG, quantity: 3, variant: null }]);
  });

  it('reads no price from the link: a price in an answer changes nothing', () => {
    const plan = recoveryPlan(
      [{ productId: 'p-mug', priceMinor: 1, quantity: 1, unitPriceMinor: 1 }],
      { 'p-mug': MUG },
    );
    assert.deepEqual(plan.lines, [{ product: MUG, quantity: 1, variant: null }]);
    assert.equal(plan.lines[0].product.priceMinor, 12_900);
  });

  it('is empty for no items', () => {
    assert.deepEqual(recoveryPlan(undefined, {}), { lines: [], missing: 0 });
  });
});

describe('recoveryProductIds', () => {
  it('names each product once, in the link order', () => {
    assert.deepEqual(
      recoveryProductIds([{ productId: 'b' }, { productId: 'a' }, { productId: 'b' }, { productId: '' }, {}]),
      ['b', 'a'],
    );
  });
});
