/**
 * Public catalogue projection contract (P1-11, 2026-08-15 audit) — pure unit
 * tests over the COMPILED projection (functions/lib/catalog/projectProduct.js),
 * the exact code both the syncProductsPublicOnWrite trigger and the
 * backfill-products-public script run.
 *
 * The contract under test:
 *   • drafts/inactive/non-B2C products project to null (mirror doc deleted);
 *   • sensitive fields NEVER appear in the projection: b2bPrice, podCostSek,
 *     availability.b2b, isPodProduct, dimensions — including inside variants;
 *   • every storefront-load-bearing field survives (cards, detail page,
 *     cart line stamping, shipping math, JSON-LD, sorting);
 *   • sub-objects are allowlisted, not passed through (descriptions/delivery/
 *     availability/variant rows).
 *
 * RUN: node rules-tests/projection.test.cjs   (needs functions/lib built)
 */

const { projectPublicProduct } = require('../functions/lib/catalog/projectProduct.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

console.log('\n— unpublishable products project to null (absence hides drafts) —');
ok(projectPublicProduct(null) === null, 'null/deleted doc → null');
ok(projectPublicProduct(undefined) === null, 'undefined → null');
ok(projectPublicProduct({ shopId: 's', availability: { b2c: true } }) === null, 'isActive missing → null (strict ===true, mirrors storefront query)');
ok(projectPublicProduct({ shopId: 's', isActive: false, availability: { b2c: true } }) === null, 'isActive false → null');
ok(projectPublicProduct({ shopId: 's', isActive: true }) === null, 'availability missing → null');
ok(projectPublicProduct({ shopId: 's', isActive: true, availability: { b2c: false } }) === null, 'availability.b2c false → null');
ok(projectPublicProduct({ shopId: 's', isActive: true, availability: { b2b: true } }) === null, 'b2b-only product → null');

console.log('\n— sensitive fields are stripped (the P1-11 leak itself) —');
const raw = {
  shopId: 'shopA', isActive: true,
  availability: { b2c: true, b2b: true },
  name: 'Tee', sku: 'tee', category: 'Kläder', tags: ['dam'],
  b2cPrice: 199, basePrice: 149, compareAtPrice: 249,
  b2bPrice: 90,                       // wholesale — MUST NOT leak
  podCostSek: 60,                     // platform cost — MUST NOT leak
  isPodProduct: true,                 // fulfillment model — MUST NOT leak
  dimensions: { l: 1, w: 2, h: 3 },   // internal — not storefront-consumed
  descriptions: { b2c: 'Snygg', b2cMoreInfo: 'Mer', internalNote: 'marginal 40%' },
  delivery: { shipping: true, pickup: false, internalCarrier: 'postnord-avtal' },
  variants: [
    { sku: 'tee-s', label: 'S', price: 199, image: 'x.png', images: ['x.png'], group: 'Storlek', size: 'S', optionValues: ['S'], b2bPrice: 80, costSek: 55 },
    null,
  ],
  featured: true, sortOrder: 3, hasVariants: true,
  variantGroups: [
    { label: 'Svart', sku: 'tee-svart', price: null, image: 'x.png', images: ['x.png'], sizes: ['S'], costSek: 55 },
  ],
  options: [{ name: 'Storlek', values: ['S'], internalMargin: 0.4 }],
  b2cImageUrl: 'a.png', b2cImageGallery: ['a.png'], imageUrl: 'b.png',
  size: 'M', color: 'Svart', description: 'legacy',
  reviewCount: 4, ratingSum: 19, launchDate: '2026-01-01',
  sizeGuide: 'guide', isPersonalized: false,
  weight: 0.2, shipping: { sweden: 29, eu: 79 }, stock: 5, brand: 'ChopShop', eanCode: '7331234567890',
  createdAt: 't1', updatedAt: 't2',
};
const pub = projectPublicProduct(raw);
ok(pub !== null, 'published product projects');
ok(!('b2bPrice' in pub), 'b2bPrice stripped');
ok(!('podCostSek' in pub), 'podCostSek stripped');
ok(!('isPodProduct' in pub), 'isPodProduct stripped');
ok(!('dimensions' in pub), 'dimensions stripped');
ok(JSON.stringify(pub.availability) === JSON.stringify({ b2c: true }), 'availability reduced to {b2c:true} (b2b membership hidden)');
ok(!('internalNote' in (pub.descriptions || {})), 'descriptions sub-allowlisted (internal note dropped)');
ok(pub.descriptions.b2c === 'Snygg' && pub.descriptions.b2cMoreInfo === 'Mer', 'b2c descriptions survive');
ok(JSON.stringify(pub.delivery) === JSON.stringify({ shipping: true, pickup: false }), 'delivery reduced to shipping/pickup');
ok(pub.variants.length === 1, 'null variant rows dropped');
ok(!('b2bPrice' in pub.variants[0]) && !('costSek' in pub.variants[0]), 'variant rows sub-allowlisted (no per-row cost/wholesale)');
ok(['sku', 'label', 'price', 'image', 'images', 'group', 'size', 'optionValues'].every((k) => k in pub.variants[0]), 'variant public keys survive');
ok(!('costSek' in pub.variantGroups[0]), 'variantGroups rows sub-allowlisted (no per-colorway cost)');
ok(['label', 'sku', 'price', 'image', 'images', 'sizes'].every((k) => k in pub.variantGroups[0]), 'rail row public keys survive (incl. price:null inherit marker)');
ok(pub.variantGroups[0].price === null, 'null group price preserved (inherit-from-product marker)');
ok(!('internalMargin' in pub.options[0]), 'options rows sub-allowlisted');
ok(pub.options[0].name === 'Storlek' && pub.options[0].values.length === 1, 'legacy options keys survive');

console.log('\n— storefront-load-bearing fields survive —');
const mustSurvive = ['shopId', 'name', 'sku', 'category', 'tags', 'featured', 'sortOrder', 'hasVariants',
  'variantGroups', 'options', 'b2cPrice', 'basePrice', 'compareAtPrice', 'b2cImageUrl', 'b2cImageGallery',
  'imageUrl', 'size', 'color', 'description', 'reviewCount', 'ratingSum', 'launchDate', 'sizeGuide',
  'isPersonalized', 'weight', 'shipping', 'stock', 'brand', 'eanCode', 'isActive', 'createdAt', 'updatedAt'];
for (const k of mustSurvive) ok(k in pub, `${k} survives`);
ok(pub.isActive === true, 'isActive true (storefront queries filter on it)');

console.log('\n— sparse docs stay sparse (no undefined keys written) —');
const sparse = projectPublicProduct({ shopId: 's', isActive: true, availability: { b2c: true }, name: 'Bare' });
ok(Object.values(sparse).every((v) => v !== undefined), 'no undefined values');
ok(!('variants' in sparse) && !('descriptions' in sparse) && !('delivery' in sparse), 'absent sub-objects stay absent');
ok(JSON.stringify(sparse.availability) === JSON.stringify({ b2c: true }), 'availability still normalized');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
