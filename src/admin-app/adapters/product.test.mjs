// The product adapter: node --test src/admin-app/adapters/product.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveVariantsFromGroups } from '../../utils/variantDerivation.js';
import {
  desiredVariants,
  droppedObjectIds,
  imageList,
  kr,
  moreInfoValue,
  orderEntries,
  planVariantSync,
  podFigures,
  productBodyProblem,
  productFromDetail,
  productFromListItem,
  productWriteBody,
  refusalMessage,
  sameImageList,
  screeningNoticeFor,
  shippingRatesOf,
  strictestFigures,
  variantProblem,
  weightGramsOf,
} from './product.js';

// utils/productUrls.js's skuFromName, restated (that module reads the build's
// environment, so a Node test cannot import it).
const skuFromName = (name) => {
  const slug = String(name ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/&/g, '-and-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-');
  return slug.replace(/_/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '') || 'produkt';
};

const img = (objectId, url, variantId = null) => ({ objectId, variantId, alt: null, position: 0, image: url ? { objectId, url, contentType: 'image/png', width: 1, height: 1 } : null });

const TEE = {
  product: {
    productId: 'p-tee', sku: 'tee', name: 'Tee', description: 'Soft', priceMinor: 24900, currency: 'SEK',
    status: 'active', isPod: true, screeningStatus: 'approved', weightGrams: 180, allowShipping: true,
    allowPickup: false, shippingRates: { sweden: { cost: 4900 } }, handle: 'tee_tee', featured: true,
    sortOrder: 2, compareAtPriceMinor: 29900, category: 'Tröjor', tags: ['Nyhet'], moreInfo: '<p>Info</p>',
    sizeGuide: 'S–XL', size: null, brand: null, eanCode: null, stock: null, launchDate: '2026-11-01', isPersonalized: false,
  },
  publication: { published: true, publishedAt: '2026-10-01T00:00:00.000Z' },
  variants: [
    { variantId: 'v-sv-s', sku: 'tee-svart-s', label: 'Svart / S', priceMinor: 24900, active: true, group: 'Svart', size: 'S', position: 0 },
    { variantId: 'v-sv-m', sku: 'tee-svart-m', label: 'Svart / M', priceMinor: 24900, active: true, group: 'Svart', size: 'M', position: 1 },
    { variantId: 'v-vi', sku: 'tee-vit', label: 'Vit', priceMinor: 27900, active: true, group: 'Vit', size: null, position: 2 },
    { variantId: 'v-old', sku: 'tee-rod', label: 'Röd', priceMinor: 24900, active: false, group: 'Röd', size: null, position: 3 },
  ],
  variantsTruncated: false,
  images: [
    img('o-main', 'https://img.example.com/main.png'),
    img('o-back', 'https://img.example.com/back.png'),
    img('o-gone', null),
    img('o-svart', 'https://img.example.com/svart.png', 'v-sv-m'),
    img('o-back', 'https://img.example.com/back.png', 'v-sv-s'),
    img('o-vit', 'https://img.example.com/vit.png', 'v-vi'),
  ],
};

describe('the list', () => {
  it('maps a row to the page product, money in kr', () => {
    const p = productFromListItem({
      productId: 'p1', sku: 'a', name: 'A', status: 'draft', featured: true, priceMinor: 12950, category: null,
      image: { url: 'https://img.example.com/a.png' }, isPod: false, takenDown: true, sortOrder: null, published: false,
    });
    assert.equal(p.id, 'p1');
    assert.equal(p.b2cPrice, 129.5);
    assert.equal(p.isActive, false);
    assert.equal(p.imageUrl, 'https://img.example.com/a.png');
    assert.equal(p.category, '');
    assert.ok(p.takedown);
    assert.equal('variants' in p, false, 'the list carries no variants: the column leaves');
  });
  it('hides an archived product (the build\'s "delete")', () => {
    assert.equal(productFromListItem({ productId: 'p', status: 'archived' }), null);
  });
  it('the order is the draft index', () => {
    assert.deepEqual(orderEntries([{ id: 'b' }, { id: 'a' }]), [{ productId: 'b', sortOrder: 0 }, { productId: 'a', sortOrder: 1 }]);
  });
});

describe('one product for the form', () => {
  const p = productFromDetail(TEE, { skuFromName, listItem: { takedown: null } });

  it('the images: own rows first, the main image first, an unresolved one left out', () => {
    assert.equal(p.b2cImageUrl, 'https://img.example.com/main.png');
    assert.deepEqual(p.b2cImageGallery, ['https://img.example.com/back.png']);
    assert.equal(p._objectIdByUrl['https://img.example.com/main.png'], 'o-main');
  });
  it('the rail: active variants grouped in position order, group images by the group rule', () => {
    assert.deepEqual(p.variantGroups.map((g) => g.label), ['Svart', 'Vit']);
    const [svart, vit] = p.variantGroups;
    assert.equal(svart.sku, 'tee-svart');
    assert.deepEqual(svart.sizes, ['S', 'M']);
    assert.equal(svart.price, null, 'the product price → inherited');
    assert.deepEqual(svart.images, ['https://img.example.com/svart.png', 'https://img.example.com/back.png']);
    assert.equal(vit.sku, 'tee-vit');
    assert.equal(vit.price, 279);
    assert.deepEqual(vit.sizes, []);
    assert.equal(p.hasVariants, true);
    assert.equal(p.variants.length, 3, 'the inactive variant is not in the rail');
  });
  it('the rail round-trips through the derivation to the same skus', () => {
    const groups = p.variantGroups.map((g) => ({ ...g, price: g.price ?? '', images: [] }));
    const { cleanVariants } = deriveVariantsFromGroups(groups, { productSku: 'tee', productPrice: 249, skuFromName });
    assert.deepEqual(cleanVariants.map((v) => v.sku), ['tee-svart-s', 'tee-svart-m', 'tee-vit']);
    const plan = planVariantSync(TEE.variants, desiredVariants(cleanVariants));
    assert.deepEqual(plan, { deletes: [], updates: [], creates: [] }, 'an untouched rail writes nothing');
  });
  it('the other fields', () => {
    assert.equal(p.isActive, true);
    assert.equal(p.availability.b2c, true);
    assert.equal(p.compareAtPrice, 299);
    assert.equal(p.shipping.sweden.cost, 49);
    assert.equal(p.shipping.eu.cost, 0);
    assert.deepEqual(p.delivery, { shipping: true, pickup: false });
    assert.deepEqual(p.weight, { value: 180, unit: 'g' });
    assert.equal(p.launchDate, '2026-11-01');
    assert.equal(p.descriptions.b2cMoreInfo, '<p>Info</p>');
    assert.equal(p.isPodProduct, true);
    assert.equal(p._server.published, true);
  });
  it('a draft reads "Tillgänglig i webbshoppen" on, as the Firebase default', () => {
    const draft = productFromDetail({ ...TEE, product: { ...TEE.product, status: 'draft' }, publication: null }, { skuFromName });
    assert.equal(draft.isActive, false);
    assert.equal(draft.availability.b2c, true);
    const hidden = productFromDetail({ ...TEE, publication: { published: false } }, { skuFromName });
    assert.equal(hidden.availability.b2c, false);
  });
  it('carries no cost, tier or printer field', () => {
    const text = JSON.stringify(p).toLowerCase();
    for (const word of ['podcost', 'printer', 'tier', 'commission', 'supplier', 'payout']) {
      assert.equal(text.includes(word), false, word);
    }
  });
});

describe('the write body', () => {
  const formData = {
    name: '  Tee ', sku: 'tee', category: '', tags: ['Nyhet'], featured: true, isActive: true,
    descriptions: { b2c: '', b2cMoreInfo: '<p><br></p>' }, sizeGuide: '', launchDate: '2026-11-01T00:00',
    weight: { value: 0.25, unit: 'kg' }, delivery: { shipping: true, pickup: false },
    shipping: { sweden: { cost: 0 }, nordic: { cost: 0 }, eu: { cost: 0 }, worldwide: { cost: 0 } },
  };
  it('an update: status, öre, empty texts as null, the date part only', () => {
    const body = productWriteBody({ formData, sku: 'tee', price: 249.5, compareAtPrice: 0, create: false });
    assert.equal(body.status, 'active');
    assert.equal(body.priceMinor, 24950);
    assert.equal(body.compareAtPriceMinor, null);
    assert.equal(body.description, null);
    assert.equal(body.moreInfo, null, 'Quill\'s empty editor is no text');
    assert.equal(body.category, null);
    assert.equal(body.launchDate, '2026-11-01');
    assert.equal(body.weightGrams, 250);
    assert.equal(body.shippingRates, null, 'every region 0 = the fallback tariff');
    assert.equal('currency' in body, false);
    assert.equal(body.name, 'Tee');
  });
  it('a create: the currency, no status; an empty name takes the sku', () => {
    const body = productWriteBody({ formData: { ...formData, name: '' }, sku: 'x-1', price: 10, compareAtPrice: 0, create: true, currency: 'SEK' });
    assert.equal(body.currency, 'SEK');
    assert.equal('status' in body, false);
    assert.equal(body.name, 'x-1');
  });
  it('the carriage table in öre', () => {
    assert.deepEqual(shippingRatesOf({ sweden: { cost: 49 }, nordic: { cost: 0 } }), {
      sweden: { cost: 4900 }, nordic: { cost: 0 }, eu: { cost: 0 }, worldwide: { cost: 0 },
    });
    assert.equal(weightGramsOf({ value: 12.4, unit: 'g' }), 12);
  });
  it('a problem is named at its field', () => {
    const ok = productWriteBody({ formData, sku: 'tee', price: 1, compareAtPrice: 0, create: false });
    assert.equal(productBodyProblem(ok), null);
    assert.equal(productBodyProblem({ ...ok, description: 'x'.repeat(2001) }).field, 'description');
    assert.equal(productBodyProblem({ ...ok, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).field, 'tags');
    assert.equal(productBodyProblem({ ...ok, sku: 'x'.repeat(65) }).field, 'sku');
    assert.equal(variantProblem(Array.from({ length: 201 }, (_, i) => ({ sku: `s${i}`, label: 'a', group: 'a', size: null, priceMinor: 1 }))).field, 'variants');
  });
  it('moreInfo keeps real content', () => {
    assert.equal(moreInfoValue('<p>Hej</p>'), '<p>Hej</p>');
    assert.equal(moreInfoValue(''), null);
  });
});

describe('the variant sync', () => {
  const existing = TEE.variants;
  it('matched by sku: a rename is one PATCH, the row stays', () => {
    const plan = planVariantSync(existing, [
      { sku: 'tee-svart-s', label: 'Kol / S', group: 'Kol', size: 'S', priceMinor: 24900, position: 0 },
      { sku: 'tee-svart-m', label: 'Kol / M', group: 'Kol', size: 'M', priceMinor: 24900, position: 1 },
      { sku: 'tee-vit', label: 'Vit', group: 'Vit', size: null, priceMinor: 27900, position: 2 },
    ]);
    assert.deepEqual(plan.deletes, []);
    assert.deepEqual(plan.creates, []);
    assert.deepEqual(plan.updates.map((u) => [u.variantId, u.body]), [
      ['v-sv-s', { label: 'Kol / S', group: 'Kol' }],
      ['v-sv-m', { label: 'Kol / M', group: 'Kol' }],
    ]);
  });
  it('matched by group + size when the sku was edited; the rest created or removed', () => {
    const plan = planVariantSync(existing, [
      { sku: 'svart-small', label: 'Svart / S', group: 'Svart', size: 'S', priceMinor: 24900, position: 0 },
      { sku: 'tee-svart-l', label: 'Svart / L', group: 'Svart', size: 'L', priceMinor: 24900, position: 1 },
    ]);
    assert.deepEqual(plan.updates, [{ variantId: 'v-sv-s', sku: 'svart-small', body: { sku: 'svart-small' } }]);
    assert.deepEqual(plan.creates.map((c) => c.sku), ['tee-svart-l']);
    assert.deepEqual(plan.deletes, ['v-sv-m', 'v-vi'], 'only active variants are removed');
  });
  it('an inactive variant whose sku returns is reactivated, not created twice', () => {
    const plan = planVariantSync(existing, [{ sku: 'tee-rod', label: 'Röd', group: 'Röd', size: null, priceMinor: 24900, position: 0 }]);
    assert.deepEqual(plan.creates, []);
    assert.deepEqual(plan.updates, [{ variantId: 'v-old', sku: 'tee-rod', body: { position: 0, active: true } }]);
  });
});

describe('the images', () => {
  it('own first, then each group on its first variant; no object twice for one owner', () => {
    const list = imageList(['a', 'b', 'a'], [{ objectIds: ['c', 'b'], variantId: 'v1' }, { objectIds: ['c'], variantId: 'v1' }]);
    assert.deepEqual(list, [
      { objectId: 'a', variantId: null },
      { objectId: 'b', variantId: null },
      { objectId: 'c', variantId: 'v1' },
      { objectId: 'b', variantId: 'v1' },
    ]);
    assert.equal(sameImageList(list, list.map((r) => ({ ...r }))), true);
    assert.equal(sameImageList(list, list.slice(1)), false);
    assert.deepEqual(droppedObjectIds([{ objectId: 'a' }, { objectId: 'z' }], list), ['z']);
  });
});

describe('the server\'s numbers', () => {
  it('the floor in kr; Inköp in whole kr incl. the production VAT; nothing derived from either', () => {
    assert.deepEqual(podFigures({ inkopMinor: 14000, priceFloorMinor: 25300, currency: 'SEK' }), { floorKr: 253, inkopKr: 175 });
    assert.equal(podFigures(null), null);
    assert.equal(podFigures({ inkopMinor: 1.5, priceFloorMinor: 100 }), null);
  });
  it('several groups: the strictest floor', () => {
    const f = strictestFigures([{ inkopMinor: 100, priceFloorMinor: 20000 }, { inkopMinor: 200, priceFloorMinor: 30000 }]);
    assert.equal(f.floorKr, 300);
    assert.equal(strictestFigures([]), null);
  });
  it('kr of a non-integer is 0', () => {
    assert.equal(kr(undefined), 0);
    assert.equal(kr(1999), 19.99);
  });
});

describe('refusals in the page\'s words', () => {
  it('names the field or the variant', () => {
    assert.match(refusalMessage({ status: 422, code: 'price_below_floor' }, { step: 'product' }), /prisgolvet/);
    assert.match(refusalMessage({ status: 422, code: 'price_below_floor' }, { step: 'variant', label: 'Vit' }), /för Vit/);
    assert.match(refusalMessage({ status: 400, code: 'invalid_request' }, { step: 'product', moreInfo: '<script>' }), /Mer information/);
    assert.equal(refusalMessage({ status: 400, code: 'invalid_request' }, { step: 'product', moreInfo: null }), null);
    assert.match(refusalMessage({ status: 409, code: 'conflict' }, { step: 'variant', sku: 'x' }), /"x"/);
    assert.match(refusalMessage({ status: 409, code: 'variant_limit' }, { step: 'variant' }), /200/);
    assert.match(refusalMessage({ status: 422, code: 'pod_unavailable' }, { step: 'publish' }), /tillverkas/);
  });
  it('the screening verdicts that need a word', () => {
    assert.match(screeningNoticeFor('pending'), /granskas/);
    assert.match(screeningNoticeFor('blocked'), /stoppat/);
    assert.equal(screeningNoticeFor('approved'), null);
    assert.equal(screeningNoticeFor(null), null);
  });
});
