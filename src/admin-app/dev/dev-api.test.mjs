// The admin's dev API, under Node: node --test src/admin-app/dev/dev-api.test.mjs
// The answers are checked against the shapes of CP5 brief §0.2 and the
// guards of the API; the last case proves the dev API is not in the admin's
// build output (when one exists).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { DEV_API_MARKER, SESSION_COOKIE, createState, loadFixtures, route } from './dev-api.mjs';
import { authStateFromMe, resolveActiveShopId } from '../../api/admin/session.js';
import { featuresOf } from '../providers/shapes.js';

const call = (state, method, path, { headers = {}, body = null } = {}) =>
  route(state, method, new URL(path, 'http://dev.invalid'), headers, body);

function signedIn(email, password) {
  const state = createState();
  const answer = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email, password } });
  assert.equal(answer.status, 200);
  const cookie = answer.setCookie.split(';')[0];
  return { state, cookie };
}

describe('sign-in, the session, sign-out', () => {
  it('a wrong password is Better Auth\'s 401, no cookie', () => {
    const state = createState();
    const answer = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'admin@example.com', password: 'nope' } });
    assert.equal(answer.status, 401);
    assert.equal(answer.body.code, 'INVALID_EMAIL_OR_PASSWORD');
    assert.equal(answer.setCookie, undefined);
  });

  it('/v1/me: 401 signed out; the §0.2 shape signed in; 401 again after sign-out', () => {
    const { state, cookie } = signedIn('admin@example.com', 'dev-password-1');
    assert.equal(call(state, 'GET', '/_api/v1/me').status, 401);
    const me = call(state, 'GET', '/_api/v1/me', { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(me.body).sort(), ['accountType', 'actingAs', 'memberships', 'platform', 'user']);
    assert.deepEqual(Object.keys(me.body.user).sort(), ['email', 'id', 'name']);
    assert.deepEqual(Object.keys(me.body.memberships[0]).sort(), ['published', 'role', 'shopName', 'status', 'tenantId']);
    assert.equal(cookie.startsWith(`${SESSION_COOKIE}=`), true);

    const out = call(state, 'POST', '/_api/api/auth/sign-out', { headers: { cookie } });
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /Max-Age=0/);
    assert.equal(call(state, 'GET', '/_api/v1/me', { headers: { cookie } }).status, 401);
  });

  it('the tenant admin resolves to the one active shop; the platform user to none', () => {
    const admin = signedIn('admin@example.com', 'dev-password-1');
    const meA = call(admin.state, 'GET', '/_api/v1/me', { headers: { cookie: admin.cookie } }).body;
    assert.equal(resolveActiveShopId(meA), 'test-shop-a');
    assert.equal(authStateFromMe(meA).isPlatform, false);

    const platform = signedIn('platform@example.com', 'dev-password-2');
    const meP = call(platform.state, 'GET', '/_api/v1/me', { headers: { cookie: platform.cookie } }).body;
    assert.equal(resolveActiveShopId(meP), null);
    assert.equal(authStateFromMe(meP).isPlatform, true);
  });
});

describe('the admin routes and their guard', () => {
  it('/v1/admin/shop and /settings for a shop the user may use, in the §0.2 shape', () => {
    const { state, cookie } = signedIn('admin@example.com', 'dev-password-1');
    const shop = call(state, 'GET', '/_api/v1/admin/shop', { headers: { cookie, 'x-shop-id': 'test-shop-a' } });
    assert.equal(shop.status, 200);
    assert.deepEqual(Object.keys(shop.body.shop).sort(), [
      'currency', 'defaultLocale', 'features', 'published', 'shopName', 'status', 'supportEmail', 'tenantId', 'vatRateBp',
    ]);
    assert.equal(featuresOf(shop.body.shop).pod, true);
    for (const value of Object.values(shop.body.shop.features)) assert.equal(typeof value, 'boolean');
    const settings = call(state, 'GET', '/_api/v1/admin/settings', { headers: { cookie, 'x-shop-id': 'test-shop-a' } });
    assert.deepEqual(Object.keys(settings.body.settings).sort(), [
      'returnAddress', 'sellerType', 'storeIdentity', 'updatedAt', 'vatNumber', 'vatRegistered',
    ]);
  });

  it('the opaque 404: no session, no X-Shop-Id, a suspended shop, a foreign shop, a platform user without a grant, an unknown route', () => {
    const admin = signedIn('admin@example.com', 'dev-password-1');
    const platform = signedIn('platform@example.com', 'dev-password-2');
    const cases = [
      [admin.state, {}, '/_api/v1/admin/shop'],
      [admin.state, { cookie: admin.cookie }, '/_api/v1/admin/shop'],
      [admin.state, { cookie: admin.cookie, 'x-shop-id': 'test-shop-b' }, '/_api/v1/admin/shop'],
      [admin.state, { cookie: admin.cookie, 'x-shop-id': 'other-shop' }, '/_api/v1/admin/shop'],
      [platform.state, { cookie: platform.cookie, 'x-shop-id': 'test-shop-a' }, '/_api/v1/admin/shop'],
      [admin.state, { cookie: admin.cookie, 'x-shop-id': 'test-shop-a' }, '/_api/v1/admin/products'],
    ];
    for (const [state, headers, path] of cases) {
      const answer = call(state, 'GET', path, { headers });
      assert.equal(answer.status, 404, JSON.stringify(headers));
      assert.equal(answer.body.error.code, 'not_found');
    }
  });

  it('a grant opens the shop to a platform user (FB will add the route that opens it)', () => {
    const fixtures = loadFixtures();
    fixtures.users[1].actingAs = [{ tenantId: 'test-shop-a', expiresAt: '2999-01-01T00:00:00.000Z' }];
    const state = createState(fixtures);
    const signIn = call(state, 'POST', '/_api/api/auth/sign-in/email', { body: { email: 'platform@example.com', password: 'dev-password-2' } });
    const cookie = signIn.setCookie.split(';')[0];
    assert.equal(call(state, 'GET', '/_api/v1/admin/shop', { headers: { cookie, 'x-shop-id': 'test-shop-a' } }).status, 200);
    const me = call(state, 'GET', '/_api/v1/me', { headers: { cookie } }).body;
    assert.deepEqual(me.actingAs.map((g) => g.tenantId), ['test-shop-a']);
  });

  it('a platform route refuses X-Shop-Id and anyone but a platform user', () => {
    const admin = signedIn('admin@example.com', 'dev-password-1');
    const platform = signedIn('platform@example.com', 'dev-password-2');
    assert.equal(call(admin.state, 'GET', '/_api/v1/platform/tenants', { headers: { cookie: admin.cookie } }).status, 404);
    assert.equal(
      call(platform.state, 'GET', '/_api/v1/platform/tenants', { headers: { cookie: platform.cookie, 'x-shop-id': 'test-shop-a' } }).status,
      404,
    );
  });
});

describe('the password reset', () => {
  it('the link lands on /reset-password with the token, or with the error', () => {
    const state = createState();
    assert.deepEqual(call(state, 'GET', '/_api/api/auth/reset-password/devresettoken0000000001'), {
      status: 302,
      location: '/reset-password?token=devresettoken0000000001',
    });
    assert.equal(call(state, 'GET', '/_api/api/auth/reset-password/unknowntoken00000000').location, '/reset-password?error=INVALID_TOKEN');
  });

  it("the new password: Better Auth's refusals, then 200", () => {
    const state = createState();
    const post = (body) => call(state, 'POST', '/_api/api/auth/reset-password', { body });
    assert.equal(post({ newPassword: 'long-enough-1', token: 'nope' }).body.code, 'INVALID_TOKEN');
    assert.equal(post({ newPassword: 'short', token: 'devresettoken0000000001' }).body.code, 'PASSWORD_TOO_SHORT');
    assert.equal(post({ newPassword: 'long-enough-1', token: 'devresettoken0000000001' }).status, 200);
    assert.equal(call(state, 'POST', '/_api/api/auth/request-password-reset', { body: { email: 'x@example.com' } }).status, 200);
  });
});

describe('invented data only, never in the build', () => {
  it('fixture addresses are example.com and the shops are test shops', () => {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures.json'), 'utf8');
    for (const email of text.match(/[\w.+-]+@[\w.-]+/g) ?? []) assert.match(email, /@([\w-]+\.)*example\.com$/, email);
  });

  it('the admin build holds no part of the dev API', () => {
    const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cloudflare', 'admin', 'dist');
    if (!existsSync(dist)) return;
    const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    for (const file of walk(dist)) {
      const text = readFileSync(file);
      assert.equal(text.includes(DEV_API_MARKER), false, file);
      assert.equal(text.includes('dev-password-1'), false, file);
    }
  });
});
