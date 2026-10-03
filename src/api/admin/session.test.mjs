// The session calls and the pure state the Session and ActiveShop providers
// are built on: node --test src/api/admin/session.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import {
  authStateFromMe,
  endActingAs,
  liveGrantsOf,
  requestPasswordReset,
  resetPassword,
  resolveActiveShopId,
  shopEntryOf,
  signIn,
  signOut,
  usableShopIds,
} from './session.js';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const LATER = '2026-10-03T13:00:00.000Z';
const EARLIER = '2026-10-03T11:00:00.000Z';

const tenantAdmin = {
  user: { id: 'u-1', email: 'admin@example.com', name: 'Test Admin' },
  accountType: 'tenant_admin',
  platform: false,
  memberships: [
    { tenantId: 'test-shop-a', shopName: 'Test Shop A', status: 'active', published: true, role: 'admin' },
    { tenantId: 'test-shop-b', shopName: 'Test Shop B', status: 'suspended', published: false, role: 'admin' },
  ],
  actingAs: [],
};

const platformUser = {
  user: { id: 'u-2', email: 'platform@example.com', name: '' },
  accountType: 'platform_admin',
  platform: true,
  memberships: [],
  actingAs: [
    { tenantId: 'test-shop-a', shopName: 'Test Shop A', expiresAt: LATER },
    { tenantId: 'test-shop-b', shopName: 'Test Shop B', expiresAt: EARLIER },
  ],
};

describe('authStateFromMe: the shape useAuth() hands the pages', () => {
  it('signed out', () => {
    for (const me of [null, undefined, {}, { user: {} }]) {
      assert.deepEqual(authStateFromMe(me), { currentUser: null, userProfile: null, isAdmin: false, isPlatform: false });
    }
  });

  it('a tenant admin: role admin, not platform', () => {
    const s = authStateFromMe(tenantAdmin);
    assert.deepEqual(s.currentUser, { uid: 'u-1', email: 'admin@example.com', displayName: 'Test Admin' });
    assert.equal(s.userProfile.role, 'admin');
    assert.equal(s.isAdmin, true);
    assert.equal(s.isPlatform, false);
  });

  it('a platform user: role admin AND platform (AdminRoute passes while acting as a shop)', () => {
    const s = authStateFromMe(platformUser);
    assert.equal(s.userProfile.role, 'admin');
    assert.equal(s.isPlatform, true);
    assert.equal(s.currentUser.displayName, null);
  });

  it('platform needs both the account type and the flag', () => {
    assert.equal(authStateFromMe({ ...platformUser, platform: false }).isPlatform, false);
    assert.equal(authStateFromMe({ ...tenantAdmin, platform: true }).isPlatform, false);
  });

  it('an account type the admin does not serve has no role', () => {
    const s = authStateFromMe({ ...tenantAdmin, accountType: 'printer' });
    assert.equal(s.userProfile.role, null);
    assert.equal(s.isAdmin, false);
  });
});

describe('the usable shops and the active one', () => {
  it("a tenant admin's active memberships only (a suspended shop is listed, not usable)", () => {
    assert.deepEqual(usableShopIds(tenantAdmin, NOW), ['test-shop-a']);
  });

  it("a platform user's open grants only", () => {
    assert.deepEqual(usableShopIds(platformUser, NOW), ['test-shop-a']);
    assert.deepEqual(liveGrantsOf(platformUser, NOW).map((g) => g.tenantId), ['test-shop-a']);
    assert.deepEqual(usableShopIds({ ...platformUser, actingAs: [] }, NOW), []);
  });

  it('a platform user never uses a membership; a tenant admin never a grant', () => {
    assert.deepEqual(usableShopIds({ ...platformUser, memberships: tenantAdmin.memberships, actingAs: [] }, NOW), []);
    assert.deepEqual(usableShopIds({ ...tenantAdmin, memberships: [], actingAs: platformUser.actingAs }, NOW), []);
  });

  it('a grant without a readable expiry is not live', () => {
    assert.deepEqual(liveGrantsOf({ ...platformUser, actingAs: [{ tenantId: 'x', expiresAt: 'soon' }] }, NOW), []);
  });

  it('order: the arrival ?shopId=, then the tab\'s choice, then the only usable shop', () => {
    const two = {
      ...tenantAdmin,
      memberships: [
        { tenantId: 'shop-1', status: 'active' },
        { tenantId: 'shop-2', status: 'active' },
      ],
    };
    assert.equal(resolveActiveShopId(two, { requested: 'shop-2', chosen: 'shop-1' }, NOW), 'shop-2');
    assert.equal(resolveActiveShopId(two, { chosen: 'shop-1' }, NOW), 'shop-1');
    assert.equal(resolveActiveShopId(two, {}, NOW), null, 'two shops and no choice: the picker');
    assert.equal(resolveActiveShopId(tenantAdmin, {}, NOW), 'test-shop-a', 'one shop: that one');
  });

  it('a shop the user may not use is never active, whoever asks for it', () => {
    assert.equal(resolveActiveShopId(tenantAdmin, { requested: 'test-shop-b' }, NOW), 'test-shop-a');
    assert.equal(resolveActiveShopId(tenantAdmin, { requested: 'foreign-shop', chosen: 'other' }, NOW), 'test-shop-a');
    assert.equal(resolveActiveShopId(platformUser, { chosen: 'test-shop-b' }, NOW), 'test-shop-a', 'the expired grant');
    assert.equal(resolveActiveShopId(null, { requested: 'test-shop-a' }, NOW), null, 'signed out');
    assert.equal(resolveActiveShopId({ ...platformUser, actingAs: [] }, { requested: 'test-shop-a' }, NOW), null);
  });

  it('the entry of a shop: its membership or its grant', () => {
    assert.equal(shopEntryOf(tenantAdmin, 'test-shop-b').status, 'suspended');
    assert.equal(shopEntryOf(tenantAdmin, null), null);
    assert.equal(shopEntryOf(tenantAdmin, 'nope'), null);
  });
});

describe('the session calls', () => {
  const realFetch = globalThis.fetch;
  let calls;
  beforeEach(() => {
    calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: true }), { status: 200 });
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    setRequestShopId(null);
  });

  it("each goes to Better Auth's exact route with its exact body", async () => {
    await signIn('admin@example.com', 'secret-1');
    await signOut();
    await requestPasswordReset('admin@example.com');
    await resetPassword('devresettoken0000000001', 'new-secret-1');
    assert.deepEqual(
      calls.map((c) => [c.init.method, c.url, c.init.body]),
      [
        ['POST', '/_api/api/auth/sign-in/email', '{"email":"admin@example.com","password":"secret-1"}'],
        ['POST', '/_api/api/auth/sign-out', '{}'],
        ['POST', '/_api/api/auth/request-password-reset', '{"email":"admin@example.com"}'],
        ['POST', '/_api/api/auth/reset-password', '{"newPassword":"new-secret-1","token":"devresettoken0000000001"}'],
      ],
    );
  });

  it('a reset without a token is refused before it is sent', async () => {
    await assert.rejects(resetPassword('', 'x'), { code: 'INVALID_TOKEN' });
    assert.equal(calls.length, 0);
  });

  it('ending a grant is a platform DELETE without X-Shop-Id', async () => {
    setRequestShopId('test-shop-a');
    await endActingAs('test-shop-a');
    assert.equal(calls[0].url, '/_api/v1/platform/tenants/test-shop-a/acting-as');
    assert.equal(calls[0].init.method, 'DELETE');
    assert.equal(calls[0].init.headers['x-shop-id'], undefined);
  });
});
