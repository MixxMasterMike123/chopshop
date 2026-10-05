// CP9-OB: the storefront's page titles name the shop's own name, never a
// default text, and say nothing where it has none. Pure:
// node --test src/storefront/adapters/seoTitles.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  generateShopStructuredData,
  getCartSeoTitle,
  getCheckoutSeoTitle,
  getLegalSeoDescription,
  getLegalSeoTitle,
  getProductSeoDescription,
  getProductSeoTitle,
  getShopSeoDescription,
  getShopSeoTitle,
} from '../replacements/productUrls.js';

const SHOP = { shopName: 'Dry Run Artist', tagline: '', companyDescription: '', supportEmail: '' };
const TEE = { name: 'Dry Run Tee' };

describe('the storefront page titles', () => {
  it('carry the shop\'s own name (the dry run read "Dry Run Tee | My Shop")', () => {
    assert.equal(getProductSeoTitle(TEE, SHOP), 'Dry Run Tee | Dry Run Artist');
    assert.equal(getProductSeoDescription(TEE, SHOP), 'Dry Run Tee – Dry Run Artist');
    assert.equal(getCartSeoTitle(SHOP), 'Varukorg | Dry Run Artist');
    assert.equal(getCheckoutSeoTitle(SHOP), 'Kassa | Dry Run Artist');
    assert.equal(getLegalSeoTitle('terms', SHOP), 'Köpvillkor | Dry Run Artist');
    assert.equal(getLegalSeoDescription('terms', SHOP), 'Köpvillkor – Dry Run Artist.');
    assert.equal(getShopSeoTitle('sv-SE', { ...SHOP, tagline: 'Merch' }), 'Dry Run Artist - Merch');
  });

  it('say nothing where the shop has no name yet (the first paint): no "| " and no default text', () => {
    for (const store of [{}, undefined, { shopName: '  ' }]) {
      assert.equal(getProductSeoTitle(TEE, store), 'Dry Run Tee');
      assert.equal(getProductSeoDescription(TEE, store), 'Dry Run Tee');
      assert.equal(getCartSeoTitle(store), 'Varukorg');
      assert.equal(getCheckoutSeoTitle(store), 'Kassa');
      assert.equal(getLegalSeoTitle('privacy', store), 'Integritetspolicy');
      assert.equal(getLegalSeoDescription('privacy', store), 'Integritetspolicy.');
    }
    assert.equal(getShopSeoTitle('sv-SE', {}), '');
    assert.equal(getShopSeoDescription('sv-SE', {}), '');
  });

  it('the home\'s structured data names a contact only when the shop has an address', () => {
    assert.equal(generateShopStructuredData('sv-SE', SHOP).contactPoint, undefined);
    assert.equal(generateShopStructuredData('sv-SE', { ...SHOP, supportEmail: 'hej@butik.se' }).contactPoint.email, 'hej@butik.se');
    assert.equal(generateShopStructuredData('sv-SE', SHOP).name, 'Dry Run Artist');
  });
});
