import assert from 'node:assert/strict';
import test from 'node:test';
import { orderedVariantMockupUrls } from './mockupVariantImages.js';
import { deriveVariantsFromGroups } from '../../../utils/variantDerivation.js';

test('orders the matching front first and back second', () => {
  const mockups = [
    { colorwayId: 'red', slot: 'back' },
    { colorwayId: 'black', slot: 'front' },
    { colorwayId: 'red', slot: 'front' },
  ];
  assert.deepEqual(orderedVariantMockupUrls({
    colorwayId: 'red', mockups, urls: ['red-back', 'black-front', 'red-front'],
  }), ['red-front', 'red-back']);
});

test('uses the available back as primary when a front mockup is absent', () => {
  assert.deepEqual(orderedVariantMockupUrls({
    colorwayId: 'navy', mockups: [{ colorwayId: 'navy', slot: 'back' }], urls: ['navy-back'],
  }), ['navy-back']);
});

test('does not attach pocket or sleeve mockups as variant secondary images', () => {
  const mockups = [
    { colorwayId: 'white', slot: 'front' },
    { colorwayId: 'white', slot: 'left_sleeve' },
    { colorwayId: 'white', slot: 'back' },
  ];
  assert.deepEqual(orderedVariantMockupUrls({
    colorwayId: 'white', mockups, urls: ['front', 'sleeve', 'back'],
  }), ['front', 'back']);
});

test('falls back to the product hero when a selected color has no mockup', () => {
  assert.deepEqual(orderedVariantMockupUrls({
    colorwayId: 'sand', mockups: [], urls: [], fallbackUrl: 'hero',
  }), ['hero']);
});

test('propagates front and back to every sellable size variant', () => {
  const images = orderedVariantMockupUrls({
    colorwayId: 'red',
    mockups: [
      { colorwayId: 'red', slot: 'front' },
      { colorwayId: 'red', slot: 'back' },
    ],
    urls: ['red-front', 'red-back'],
  });
  const { cleanGroups, cleanVariants } = deriveVariantsFromGroups([{
    label: 'Röd', sku: '', price: '', images, sizes: ['S', 'M'],
  }], {
    productSku: 'tee', productPrice: 299, skuFromName: (value) => value.toLowerCase(),
  });

  assert.deepEqual(cleanGroups[0].images, ['red-front', 'red-back']);
  assert.equal(cleanGroups[0].image, 'red-front');
  assert.deepEqual(cleanVariants.map((variant) => variant.images), [
    ['red-front', 'red-back'],
    ['red-front', 'red-back'],
  ]);
});
