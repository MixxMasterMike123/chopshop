// The pure parts of the admin providers: node --test src/admin-app/providers/shapes.test.mjs

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { STORE } from '../../config/store.js';
import { featuresOf, mergeSettings, settingsFromAdmin } from './shapes.js';
import { cleanShopId, getChosenShopId, setChosenShopId, shopIdOnArrival, subscribeChosenShopId } from './activeShopStore.js';

describe('featuresOf', () => {
  it('booleans only; anything else is dropped (and so reads off)', () => {
    assert.deepEqual(featuresOf({ features: { pod: true, pickup: false, affiliate: 'yes', reviews: 1 } }), { pod: true, pickup: false });
    assert.deepEqual(featuresOf(null), {});
    assert.deepEqual(featuresOf({}), {});
  });
});

describe('the store settings the pages read', () => {
  const settings = {
    storeIdentity: { tagline: 'Invented', logoObjectId: 'obj-1', accent: '#123456' },
    returnAddress: 'Example Street 1',
    vatRegistered: true,
    vatNumber: 'SE000000000001',
    sellerType: 'company',
    updatedAt: '2026-10-01T09:00:00.000Z',
  };
  const shop = { tenantId: 'test-shop-a', shopName: 'Test Shop A', supportEmail: 'support@shop-a.example.com', currency: 'SEK', vatRateBp: 2500 };

  it('the identity as saved, the gate fields beside it, the platform-owned identity from the shop', () => {
    const saved = settingsFromAdmin(settings, shop);
    assert.equal(saved.tagline, 'Invented');
    assert.equal(saved.logoObjectId, 'obj-1');
    assert.equal(saved.returnAddress, 'Example Street 1');
    assert.equal(saved.vatRegistered, true);
    assert.equal(saved.shopName, 'Test Shop A');
    assert.equal(saved.supportEmail, 'support@shop-a.example.com');
    assert.equal(saved.vatRate, 0.25);
    assert.equal(saved.updatedAt, undefined);
  });

  it('the shop wins over an identity key of the same name (the platform owns the name, D99)', () => {
    const saved = settingsFromAdmin({ storeIdentity: { shopName: 'Old name' } }, shop);
    assert.equal(saved.shopName, 'Test Shop A');
  });

  it('either answer may be missing', () => {
    assert.deepEqual(settingsFromAdmin(null, null), {});
    assert.equal(settingsFromAdmin(null, shop).shopName, 'Test Shop A');
    assert.equal(settingsFromAdmin(settings, null).shopName, undefined);
  });

  it('merged over the static defaults with non-empty values only, __loaded', () => {
    const merged = mergeSettings({ shopName: 'Test Shop A', tagline: '', vatRegistered: false, vatNumber: null });
    assert.equal(merged.shopName, 'Test Shop A');
    assert.equal(merged.tagline, STORE.tagline);
    assert.equal(merged.vatRegistered, false);
    assert.equal(merged.vatNumber, STORE.vatNumber);
    assert.equal(merged.__loaded, true);
    assert.equal(merged.logoUrl, STORE.logoUrl);
  });
});

describe("the tab's chosen shop", () => {
  afterEach(() => {
    setChosenShopId(null);
    delete globalThis.sessionStorage;
  });

  it('kept in sessionStorage, told to the listeners, cleared with null', () => {
    const store = new Map();
    globalThis.sessionStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    const seen = [];
    const off = subscribeChosenShopId((id) => seen.push(id));
    setChosenShopId('test-shop-a');
    assert.equal(getChosenShopId(), 'test-shop-a');
    assert.equal(store.get('admin.activeShopId'), 'test-shop-a');
    setChosenShopId('test-shop-a');
    setChosenShopId(null);
    off();
    assert.deepEqual(seen, ['test-shop-a', null]);
    assert.equal(getChosenShopId(), null);
  });

  it('works when storage throws (kept in memory)', () => {
    globalThis.sessionStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    setChosenShopId('test-shop-b');
    assert.equal(getChosenShopId(), 'test-shop-b');
  });

  it('only a shop id of the grammar is taken, from storage, a choice or ?shopId=', () => {
    assert.equal(cleanShopId('Test'), null);
    assert.equal(cleanShopId('../x'), null);
    assert.equal(cleanShopId('a'.repeat(64)), null);
    setChosenShopId('<script>');
    assert.equal(getChosenShopId(), null);
    assert.equal(shopIdOnArrival('?shopId=test-shop-a&return=1'), 'test-shop-a');
    assert.equal(shopIdOnArrival('?shopId=BAD'), null);
    assert.equal(shopIdOnArrival(''), null);
  });
});
