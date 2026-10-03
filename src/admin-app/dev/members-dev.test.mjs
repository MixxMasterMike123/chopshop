// node --test src/admin-app/dev/members-dev.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createState, route } from './dev-api.mjs';

function signedIn(email = 'admin@example.com', password = 'dev-password-1') {
  const state = createState();
  const r = route(state, 'POST', new URL('http://x/_api/api/auth/sign-in/email'), {}, { email, password });
  const cookie = r.setCookie.split(';')[0];
  const call = (method, path, body = null, shop = 'test-shop-a', extra = '') =>
    route(state, method, new URL(`http://x/_api${path}`), { cookie: cookie + extra, 'x-shop-id': shop }, body);
  return { call };
}

describe('members dev rows', () => {
  it('lists the shop\'s admins with self marked, and no other shop\'s', () => {
    const { call } = signedIn();
    const a = call('GET', '/v1/admin/members').body.members;
    assert.equal(a.length, 4);
    assert.deepEqual(a.filter((m) => m.self).map((m) => m.userId), ['user-tenant-admin']);
    assert.equal(signedIn('admin-multi@example.com', 'dev-password-5').call('GET', '/v1/admin/members', null, 'test-shop-c').body.members.length, 1);
  });
  it('invites, then refuses the same address and bad bodies', () => {
    const { call } = signedIn();
    const r = call('POST', '/v1/admin/members', { email: 'New@Example.com', name: 'Nina' });
    assert.equal(r.status, 201);
    assert.equal(r.body.member.invited, true);
    assert.equal(call('POST', '/v1/admin/members', { email: 'new@example.com', name: 'Nina' }).body.error.code, 'already_member');
    assert.equal(call('POST', '/v1/admin/members', { email: 'x', name: 'N' }).status, 400);
    assert.equal(call('POST', '/v1/admin/members', { email: 'y@example.com', name: 'N', extra: 1 }).status, 400);
    assert.equal(call('POST', '/v1/admin/members', { email: 'platform@example.com', name: 'P' }).body.error.code, 'not_addable');
  });
  it('the scenarios: cap, mail, rate limit', () => {
    const { call } = signedIn();
    const ok = { email: 'z@example.com', name: 'Z' };
    assert.equal(call('POST', '/v1/admin/members', ok, 'test-shop-a', '; admin_dev_fh=full').body.error.code, 'member_limit');
    assert.equal(call('POST', '/v1/admin/members', ok, 'test-shop-a', '; admin_dev_fh=ratelimit').status, 429);
    assert.equal(call('POST', '/v1/admin/members', ok, 'test-shop-a', '; admin_dev_fh=noinvite').status, 503);
  });
  it('revoke: self, last admin, unknown, and a real one', () => {
    const { call } = signedIn();
    assert.equal(call('POST', '/v1/admin/members/user-tenant-admin/revoke').body.error.code, 'cannot_revoke_self');
    assert.equal(call('POST', '/v1/admin/members/nobody/revoke').status, 404);
    assert.equal(call('POST', '/v1/admin/members/user-member-a2/revoke').status, 200);
    assert.equal(call('GET', '/v1/admin/members').body.members.length, 3);
    // the last admin who counts: Maja and Oskar go, Ines is suspended, so only the caller counts (self wins)
    const c = signedIn('admin-c@example.com', 'dev-password-4');
    assert.equal(c.call('POST', '/v1/admin/members/user-tenant-admin-c/revoke', null, 'test-shop-c').body.error.code, 'cannot_revoke_self');
  });
  it('a request without the shop is the opaque 404', () => {
    const { call } = signedIn();
    assert.equal(call('GET', '/v1/admin/members', null, 'no-such-shop').status, 404);
  });
});
