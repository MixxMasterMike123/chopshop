/**
 * Checkout invariants (P0-03, 2026-08-15 audit) — pure unit tests.
 *
 * Runs the exported helpers from the COMPILED functions bundle
 * (functions/lib/payment/createPaymentIntent.js):
 *
 *   • validateCartLine(product, item, shopId, deliveryMethod)
 *       — tenant ownership, B2C availability, active/delivery/variant/price
 *         checks, and the SERVER-derived line snapshot (sku/name/label/image
 *         must come from the product doc, never the client payload).
 *   • shopCheckoutBlockReason(shop)
 *       — disabled (kill-switch) and published===false (GO-LIVE gate) shops
 *         must not be charged against.
 *
 * These tests FAIL against the pre-fix behavior (no tenant/availability check,
 * client-controlled SKU) and pass only with the remediation in place.
 *
 * RUN: node rules-tests/checkout-invariants.test.cjs   (needs functions/lib built)
 */

// The compiled module's import chain constructs the Firestore client at load
// (config/database.js), which needs an initialized app. No I/O ever happens —
// the helpers under test are pure.
const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-rules-test' });

const { validateCartLine, shopCheckoutBlockReason, resolvePickupLocation, withdrawalConsentBlockReason } =
  require('../functions/lib/payment/createPaymentIntent.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };
const throws = (fn, m, msgPart) => {
  try { fn(); fail++; console.log('  ❌', m, '— expected a throw, got success'); }
  catch (e) {
    if (msgPart && !String(e.message).includes(msgPart)) {
      fail++; console.log('  ❌', m, `— threw, but "${e.message}" lacks "${msgPart}"`);
    } else { pass++; console.log('  ✅', m); }
  }
};

// A representative shopA product with variants (v2 model).
const productA = {
  shopId: 'shopA',
  isActive: true,
  b2cPrice: 100,
  sku: 'REAL-SKU',
  name: { 'sv-SE': 'Mössa', 'en-US': 'Beanie' },
  b2cImageUrl: 'https://img/real.png',
  variants: [
    { sku: 'REAL-SKU-RED', label: 'Röd', price: 120, image: 'https://img/red.png' },
    { sku: 'REAL-SKU-BLUE', label: 'Blå', price: null }, // inherits product price
  ],
};

console.log('\n=== validateCartLine — tenant + availability invariants (P0-03) ===');
throws(() => validateCartLine({ ...productA, shopId: 'shopB' }, { productId: 'p1', quantity: 1 }, 'shopA', 'home'),
  'FOREIGN product (shopB doc, shopA checkout) → rejected', 'not in shop');
throws(() => validateCartLine(null, { productId: 'ghost', quantity: 1 }, 'shopA', 'home'),
  'unknown product → rejected', 'Unknown product');
throws(() => validateCartLine({ ...productA, isActive: false }, { productId: 'p1', quantity: 1 }, 'shopA', 'home'),
  'inactive product → rejected', 'not available');
throws(() => validateCartLine({ ...productA, availability: { b2c: false, b2b: true } }, { productId: 'p1', quantity: 1 }, 'shopA', 'home'),
  'B2B-only product (availability.b2c false) → rejected in B2C checkout', 'not available for B2C');
ok(validateCartLine({ ...productA, availability: { b2b: false } }, { productId: 'p1', quantity: 1 }, 'shopA', 'home').price === 100,
  'availability.b2c ABSENT → default-on (existing catalogs unaffected)');
throws(() => validateCartLine({ ...productA, shopId: undefined }, { productId: 'p1', quantity: 1 }, 'shopA', 'home'),
  'product with NO shopId → rejected (never priceable into any shop)', 'not in shop');

console.log('\n=== validateCartLine — quantity/variant/price guards (pre-existing, kept) ===');
throws(() => validateCartLine(productA, { productId: 'p1', quantity: 0 }, 'shopA', 'home'), 'quantity 0 → rejected');
throws(() => validateCartLine(productA, { productId: 'p1', quantity: 1001 }, 'shopA', 'home'), 'quantity 1001 → rejected');
throws(() => validateCartLine(productA, { quantity: 1 }, 'shopA', 'home'), 'missing productId → rejected');
throws(() => validateCartLine(productA, { productId: 'p1', variantSku: 'NOPE', quantity: 1 }, 'shopA', 'home'),
  'unknown variantSku → rejected', 'Unknown variant');
throws(() => validateCartLine({ ...productA, b2cPrice: 0, basePrice: 0 }, { productId: 'p1', quantity: 1 }, 'shopA', 'home'),
  'no valid price → rejected', 'no valid price');
throws(() => validateCartLine({ ...productA, delivery: { pickup: false } }, { productId: 'p1', quantity: 1 }, 'shopA', 'pickup'),
  'pickup on a shipping-only product → rejected', 'pickup');
throws(() => validateCartLine({ ...productA, delivery: { shipping: false } }, { productId: 'p1', quantity: 1 }, 'shopA', 'home'),
  'home delivery on a pickup-only product → rejected', 'home delivery');

console.log('\n=== validateCartLine — SERVER-derived snapshot (client metadata ignored) ===');
{
  // The client forges every display/fulfilment field — none may survive.
  const forged = {
    productId: 'p1', quantity: 2,
    sku: 'EVIL-POD-SKU', name: 'Evil', label: 'Evil', price: 1, image: 'https://evil/x.png',
  };
  const line = validateCartLine(productA, forged, 'shopA', 'home');
  ok(line.sku === 'REAL-SKU', 'SKU comes from the product doc (print routing), never the client');
  ok(line.price === 100, 'price comes from the product doc, never the client');
  ok(line.name === 'Mössa', 'name flattens from the product doc (sv-SE first)');
  ok(line.label === '', 'no variant → empty label (client label ignored)');
  ok(line.image === 'https://img/real.png', 'image comes from the product doc');
  ok(line.quantity === 2, 'quantity is the one client-owned field (validated)');
}
{
  const line = validateCartLine(productA, { productId: 'p1', variantSku: 'REAL-SKU-RED', quantity: 1, sku: 'EVIL' }, 'shopA', 'home');
  ok(line.sku === 'REAL-SKU-RED', 'variant line: SKU from the matched variant');
  ok(line.price === 120, 'variant line: price from the matched variant');
  ok(line.label === 'Röd', 'variant line: label from the matched variant');
  ok(line.image === 'https://img/red.png', 'variant line: image from the matched variant');
}
{
  const line = validateCartLine(productA, { productId: 'p1', variantSku: 'REAL-SKU-BLUE', quantity: 1 }, 'shopA', 'home');
  ok(line.price === 100, 'variant with null price inherits the product price');
  ok(line.image === 'https://img/real.png', 'variant without image falls back to product image');
}
{
  const line = validateCartLine({ ...productA, isPersonalized: true }, { productId: 'p1', quantity: 1 }, 'shopA', 'home');
  ok(line.isPersonalized === true, 'isPersonalized derives from the LIVE product doc');
}
{
  const line = validateCartLine({ ...productA, isPodProduct: true }, { productId: 'p1', quantity: 1 }, 'shopA', 'home');
  ok(line.isPodProduct === true, 'isPodProduct derives from the LIVE product doc for snapshot protection');
}

console.log('\n=== shopCheckoutBlockReason — live-shop gate (P0-03) ===');
ok(shopCheckoutBlockReason(null) === 'unknown-shop', 'missing shop doc → blocked');
ok(shopCheckoutBlockReason({ status: 'disabled' }) === 'shop-disabled', 'kill-switched shop → blocked');
ok(shopCheckoutBlockReason({ status: 'active', published: false }) === 'shop-not-published', 'published===false (GO-LIVE gate) → blocked');
ok(shopCheckoutBlockReason({ status: 'active' }) === null, 'active shop without published field → live (existing shops unaffected)');
ok(shopCheckoutBlockReason({ status: 'active', published: true }) === null, 'published shop → live');

console.log('\n=== resolvePickupLocation — pickup gate (P1-06) ===');
{
  const shop = { storeIdentity: { pickupLocations: [
    { id: 'loc-1', name: 'Butiken Söder', address: 'Gatan 1' },
    { id: 'loc-2', name: 'Lagret', address: 'Vägen 2' },
  ] } };
  const r = resolvePickupLocation(shop, 'loc-2');
  ok(r && r.name === 'Lagret' && r.address === 'Vägen 2', 'valid id → SERVER config name/address (never client copies)');
  ok(resolvePickupLocation(shop, 'loc-999') === null, 'unknown location id → null (charge rejected)');
  ok(resolvePickupLocation(shop, '') === null, 'missing id → null');
  ok(resolvePickupLocation({}, 'loc-1') === null, 'shop WITHOUT pickup config → null (no free-shipping tamper)');
  ok(resolvePickupLocation({ storeIdentity: { pickupLocations: [] } }, 'loc-1') === null, 'empty pickup list → null');

  const datedShop = { storeIdentity: { pickupLocations: [
    { id: 'loc-1', name: 'Butiken', dates: ['2026-08-16', '2026-08-17'] },
  ] } };
  ok(resolvePickupLocation(datedShop, 'loc-1', '2026-08-16', '2026-08-15')?.date === '2026-08-16',
    'configured future pickup date → accepted and server-resolved');
  ok(resolvePickupLocation(datedShop, 'loc-1', '2026-08-18', '2026-08-15') === null,
    'unconfigured pickup date → rejected');
  ok(resolvePickupLocation(datedShop, 'loc-1', '', '2026-08-15') === null,
    'location with configured dates requires a date');
  ok(resolvePickupLocation(datedShop, 'loc-1', '2026-08-16', '2026-08-17') === null,
    'past configured pickup date → rejected');
  ok(resolvePickupLocation(shop, 'loc-1', '2099-01-01', '2026-08-15')?.date === '',
    'dateless location strips a client-authored date');
}

console.log('\n=== withdrawalConsentBlockReason — personalized charge gate (P1-07) ===');
ok(withdrawalConsentBlockReason(false, null) === null, 'standard cart needs no consent');
ok(withdrawalConsentBlockReason(true, null) === 'consent-required', 'personalized cart without consent → blocked');
ok(withdrawalConsentBlockReason(true, { accepted: false }) === 'consent-required', 'explicitly unaccepted → blocked');
ok(withdrawalConsentBlockReason(true, { accepted: true, noticeFingerprint: 'h123' }) === 'notice-version-required',
  'accepted without notice version → blocked');
ok(withdrawalConsentBlockReason(true, { accepted: true, noticeVersion: 'v1', noticeFingerprint: 'forged' }) === 'notice-fingerprint-invalid',
  'malformed notice fingerprint → blocked');
ok(withdrawalConsentBlockReason(true, { accepted: true, noticeVersion: 'v1', noticeFingerprint: 'h1a2b3c' }) === null,
  'complete accepted consent proof → allowed');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
