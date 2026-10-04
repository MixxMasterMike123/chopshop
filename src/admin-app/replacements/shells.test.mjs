// The shells' data replacements (unit FB), under Node:
//   node --test src/admin-app/replacements/shells.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as olderShell from '../../components/layout/adminShellScope.js';
import { LEFT_ADMIN_PATHS, mayPickShop, maySwitchShop, scopeAdminNav } from './adminShellScope.js';
import { LEFT_PLATFORM_PATHS, badgeCountsOf, scopePlatformNav } from './platformLayoutData.js';
import { readWithLegacy } from './legacyStorage.js';
import { clearImpersonation, getImpersonation, publishActingAs } from './impersonation.js';
import { actingAsNoticeText, takeActingAsNotice } from './impersonationAudit.js';
import wagonRegistry from './wagonRegistry.js';

const ADMIN_NAV = [
  '/admin', '/admin/users', '/admin/b2c-customers', '/admin/orders', '/admin/products', '/admin/collections',
  '/admin/menu', '/admin/storefront', '/admin/pages', '/admin/payments', '/admin/skatteuppgifter', '/admin/settings',
].map((path) => ({ path, name: path }));

const PLATFORM_NAV = ['/shops', '/addons', '/models', '/dac7', '/printers', '/leads', '/reports', '/users', '/payments', '/settings']
  .map((path) => ({ path, name: path }));

describe('the admin shell\'s scope', () => {
  it('B2C Kunder and Mina skatteuppgifter leave; the rest stays in order', () => {
    assert.deepEqual(Object.keys(LEFT_ADMIN_PATHS).sort(), ['/admin/b2c-customers', '/admin/skatteuppgifter']);
    assert.deepEqual(
      scopeAdminNav(ADMIN_NAV).map((l) => l.path),
      ['/admin', '/admin/users', '/admin/orders', '/admin/products', '/admin/collections', '/admin/menu',
        '/admin/storefront', '/admin/pages', '/admin/payments', '/admin/settings'],
    );
  });

  it('the older build keeps every entry and its platform-only switching', () => {
    assert.equal(olderShell.scopeAdminNav(ADMIN_NAV), ADMIN_NAV);
    assert.equal(olderShell.mayPickShop({ isPlatform: true }), true);
    assert.equal(olderShell.mayPickShop({ isPlatform: false, memberships: [{}, {}] }), false);
  });

  it('picking: a platform user; a tenant admin with any membership; not an account with none', () => {
    assert.equal(mayPickShop({ isPlatform: true, memberships: [] }), true);
    assert.equal(mayPickShop({ isPlatform: false, memberships: [{ status: 'suspended' }] }), true);
    assert.equal(mayPickShop({ isPlatform: false, memberships: [] }), false);
    assert.equal(mayPickShop(null), false);
  });

  it('"Byt butik": only with another shop to work in', () => {
    const m = (...statuses) => statuses.map((status, i) => ({ tenantId: `s${i}`, status }));
    assert.equal(maySwitchShop({ isPlatform: false, memberships: m('active') }), false);
    assert.equal(maySwitchShop({ isPlatform: false, memberships: m('active', 'suspended') }), false);
    assert.equal(maySwitchShop({ isPlatform: false, memberships: m('active', 'active') }), true);
    assert.equal(maySwitchShop({ isPlatform: true, actingAs: [{}] }), false);
    assert.equal(maySwitchShop({ isPlatform: true, actingAs: [{}, {}] }), true);
  });

  it('POD is the one static add-on entry (gated by features.pod in the shell)', async () => {
    await wagonRegistry.ensureWagonsDiscovered();
    const items = wagonRegistry.getAdminMenuItemsSync();
    assert.deepEqual(items.map((i) => [i.wagonId, i.path]), [['pod-wagon', '/admin/pod']]);
    items[0].path = '/changed';
    assert.equal(wagonRegistry.getAdminMenuItemsSync()[0].path, '/admin/pod');
  });
});

describe('the console shell\'s scope', () => {
  it('DAC7 and Leads leave; 3D-modeller stays (CP5-FO); the "snart" placeholders stay', () => {
    assert.deepEqual(Object.keys(LEFT_PLATFORM_PATHS).sort(), ['/dac7', '/leads']);
    assert.deepEqual(scopePlatformNav(PLATFORM_NAV).map((i) => i.path),
      ['/shops', '/addons', '/models', '/printers', '/reports', '/users', '/payments', '/settings']);
  });

  it('the badge: newCount when it is a count, else no badge', () => {
    assert.deepEqual(badgeCountsOf({ newCount: 3 }), { reports: 3 });
    assert.deepEqual(badgeCountsOf({ newCount: 0 }), { reports: 0 });
    assert.deepEqual(badgeCountsOf({ newCount: '3' }), {});
    assert.deepEqual(badgeCountsOf(null), {});
  });
});

// A Storage of the browser's shape, enough for the code under test.
class FakeStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

describe('the older keys, read once by their suffix', () => {
  const real = { local: globalThis.localStorage, session: globalThis.sessionStorage };
  afterEach(() => {
    globalThis.localStorage = real.local;
    globalThis.sessionStorage = real.session;
  });
  const isBool = (v) => v === 'true' || v === 'false';

  it('the new key wins; else the older key\'s value is carried over (and kept)', () => {
    globalThis.localStorage = new FakeStorage({ 'admin.darkMode': 'false', 'legacy_dark_mode': 'true' });
    assert.equal(readWithLegacy('admin.darkMode', ['_dark_mode'], isBool), 'false');

    globalThis.localStorage = new FakeStorage({ 'legacy_dark_mode': 'true' });
    assert.equal(readWithLegacy('admin.darkMode', ['_dark_mode'], isBool), 'true');
    assert.equal(globalThis.localStorage.getItem('admin.darkMode'), 'true');
    assert.equal(globalThis.localStorage.getItem('legacy_dark_mode'), 'true');
  });

  it('a value the caller does not accept is not carried over; nothing → null', () => {
    globalThis.localStorage = new FakeStorage({ 'legacy_dark_mode': 'maybe', 'x-language': 'sv-SE' });
    assert.equal(readWithLegacy('admin.darkMode', ['_dark_mode'], isBool), null);
    assert.equal(readWithLegacy('admin.credentialLanguage', ['-credential-language', '-language'], (v) => /^[a-z]{2}-[A-Z]{2}$/.test(v)), 'sv-SE');
  });

  it('a storage that throws is no storage', () => {
    globalThis.localStorage = { get length() { throw new Error('denied'); }, getItem() { throw new Error('denied'); } };
    assert.equal(readWithLegacy('admin.darkMode', ['_dark_mode']), null);
  });
});

describe('the acting-as session of the tab', () => {
  it('getImpersonation answers the grant of the published shop only, while it is live', () => {
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    publishActingAs({ grants: [{ tenantId: 'a', shopName: 'A', expiresAt: later }], shopId: 'a' });
    assert.equal(getImpersonation()?.shopName, 'A');
    publishActingAs({ grants: [{ tenantId: 'a', shopName: 'A', expiresAt: later }], shopId: 'b' });
    assert.equal(getImpersonation(), null);
    publishActingAs({ grants: [{ tenantId: 'a', expiresAt: new Date(Date.now() - 1).toISOString() }], shopId: 'a' });
    assert.equal(getImpersonation(), null);
    publishActingAs({ grants: null, shopId: null });
    assert.equal(getImpersonation(), null);
  });

  it('clearImpersonation: a run-out grant leaves the "gått ut" notice; a live one (Avsluta) leaves none here', () => {
    const real = globalThis.sessionStorage;
    globalThis.sessionStorage = new FakeStorage();
    try {
      publishActingAs({ grants: [{ tenantId: 'a', shopName: 'A', expiresAt: new Date(Date.now() + 60_000).toISOString() }], shopId: 'a' });
      clearImpersonation();
      assert.equal(takeActingAsNotice(), null);
      publishActingAs({ grants: [{ tenantId: 'a', shopName: 'A', expiresAt: new Date(Date.now() - 1).toISOString() }], shopId: 'a' });
      clearImpersonation();
      assert.deepEqual(takeActingAsNotice(), { shopName: 'A', reason: 'expired' });
    } finally {
      globalThis.sessionStorage = real;
      publishActingAs({ grants: [], shopId: null });
    }
  });

  it('the end notice is taken once', () => {
    const real = globalThis.sessionStorage;
    globalThis.sessionStorage = new FakeStorage({ 'admin.actingAsNotice': JSON.stringify({ shopName: 'A', reason: 'expired' }) });
    try {
      const n = takeActingAsNotice();
      assert.match(actingAsNoticeText(n), /A har gått ut/);
      assert.equal(takeActingAsNotice(), null);
      assert.match(actingAsNoticeText({ shopName: 'A', reason: 'manual' }), /avslutat/);
      assert.equal(actingAsNoticeText(null), null);
    } finally {
      globalThis.sessionStorage = real;
    }
  });
});
