// The dev API's CP5-FL rows under Node: the guards are the API's (a platform
// route for a platform user without X-Shop-Id only; a forward for a member of
// the shop only), the shapes are the Worker's, the data is invented.
//   node --test src/admin-app/dev/fl-dev.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import { createState, route } from './dev-api.mjs';
import { SEED_TEXT, normalizeTerm, termKeyOf } from './platform-settings-dev.mjs';

let state;
const url = (path) => new URL(`http://dev.invalid/_api${path}`);

function session(email, password) {
  const answer = route(state, 'POST', url('/api/auth/sign-in/email'), {}, { email, password });
  return answer.setCookie.split(';')[0];
}

beforeEach(() => {
  state = createState();
});

describe('the platform rows', () => {
  it('answer a platform user; 404 with X-Shop-Id, to a tenant admin and without a session', () => {
    const platform = session('platform@example.com', 'dev-password-2');
    const tenant = session('admin@example.com', 'dev-password-1');
    for (const path of ['/v1/platform/settings', '/v1/platform/screening-terms', '/v1/platform/legal/terms-versions']) {
      assert.equal(route(state, 'GET', url(path), { cookie: platform }).status, 200, path);
      assert.equal(route(state, 'GET', url(path), { cookie: platform, 'x-shop-id': 'test-shop-a' }).status, 404, path);
      assert.equal(route(state, 'GET', url(path), { cookie: tenant }).status, 404, path);
      assert.equal(route(state, 'GET', url(path), {}).status, 404, path);
    }
  });

  it('the settings carry every field of the Worker\'s view; a pinned field is refused by name', () => {
    const cookie = session('platform@example.com', 'dev-password-2');
    const { settings } = route(state, 'GET', url('/v1/platform/settings'), { cookie }).body;
    assert.deepEqual(Object.keys(settings).sort(), ['defaultCommissionBps', 'refundApplicationFee', 'reverseDisputeOnCreated',
      'reviewFirstProducts', 'screeningHardBlock', 'screeningTermsVersion', 'updatedAt', 'updatedBy']);
    const refused = route(state, 'PATCH', url('/v1/platform/settings'), { cookie }, { reverseDisputeOnCreated: false });
    assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.field], [400, 'setting_not_editable', 'reverseDisputeOnCreated']);
    assert.equal(route(state, 'PATCH', url('/v1/platform/settings'), { cookie }, { defaultCommissionBps: 801 }).status, 400);
  });

  it('terms: stored folded, keyed by base64url, pages of `limit`, duplicates by the folded form', () => {
    assert.equal(normalizeTerm('  Håkan  Hellström! '), 'hakan hellstrom');
    assert.equal(normalizeTerm('™'), '™');
    assert.equal(normalizeTerm('\u0007x'), null);
    assert.equal(termKeyOf('ac dc'), Buffer.from('ac dc').toString('base64url'));
    const cookie = session('platform@example.com', 'dev-password-2');
    const first = route(state, 'GET', url('/v1/platform/screening-terms?limit=5'), { cookie }).body;
    assert.equal(first.terms.length, 5);
    const rest = route(state, 'GET', url(`/v1/platform/screening-terms?limit=5&cursor=${first.nextCursor}`), { cookie }).body;
    assert.equal(rest.nextCursor, null);
    assert.equal(first.terms.length + rest.terms.length, 8);
    const dup = route(state, 'POST', url('/v1/platform/screening-terms'), { cookie }, { term: 'Glimmer-KRAFT' });
    assert.equal(dup.status, 201); // "glimmer kraft" is not "glimmerkraft"
    const again = route(state, 'POST', url('/v1/platform/screening-terms'), { cookie }, { term: 'glimmer  kraft' });
    assert.deepEqual([again.status, again.body.error.code], [409, 'duplicate_term']);
  });

  it('the seed\'s hash is the hash of the code\'s text; a text that does not hash to it is refused', () => {
    const cookie = session('platform@example.com', 'dev-password-2');
    const { versions } = route(state, 'GET', url('/v1/platform/legal/terms-versions'), { cookie }).body;
    const seed = versions.find((v) => v.version === '2026-09-07');
    assert.equal(seed.sha256, createHash('sha256').update(SEED_TEXT).digest('hex'));
    const wrong = route(state, 'PUT', url('/v1/platform/legal/terms-versions/2026-09-07/text'), { cookie }, { text: 'x' });
    assert.deepEqual([wrong.status, wrong.body.error.code], [409, 'terms_text_hash_mismatch']);
    assert.equal(route(state, 'PUT', url('/v1/platform/legal/terms-versions/2026-09-07/text'), { cookie }, { text: SEED_TEXT }).status, 201);
    assert.equal(route(state, 'PUT', url('/v1/platform/legal/terms-versions/2026-09-07/text'), { cookie }, { text: SEED_TEXT }).status, 200);
  });
});

describe('the forwards rows', () => {
  it('answer a member of the shop only; refuse what the Worker refuses, per entry', () => {
    const cookie = session('admin@example.com', 'dev-password-1');
    assert.equal(route(state, 'GET', url('/v1/admin/redirects'), { cookie, 'x-shop-id': 'test-shop-a' }).status, 200);
    assert.equal(route(state, 'GET', url('/v1/admin/redirects'), { cookie, 'x-shop-id': 'test-shop-c' }).status, 404);
    assert.equal(route(state, 'GET', url('/v1/admin/redirects'), { cookie }).status, 404);
    const put = (redirects) => route(state, 'PUT', url('/v1/admin/redirects'), { cookie, 'x-shop-id': 'test-shop-a' }, { redirects });
    assert.deepEqual(put([{ fromPath: '/x1', toPath: '/x2' }, { fromPath: '/x2', toPath: '/x3' }]).body.error.problems, [{ index: 0, reason: 'chain' }]);
    assert.deepEqual(put([{ fromPath: '/z1', toPath: '/z1/' }]).body.error.problems, [{ index: 0, reason: 'same_path' }]);
    assert.deepEqual(put([{ fromPath: '/u1', toPath: 'https://evil.test' }, { fromPath: '/cart', toPath: '/' }]).body.error.problems,
      [{ index: 0, reason: 'invalid_path' }, { index: 1, reason: 'reserved_path' }]);
    assert.deepEqual(put([{ fromPath: '/w1', toPath: '/products/😀-tee' }]).body.error.problems, [{ index: 0, reason: 'chain' }]);
    const ok = put([{ fromPath: '/v1/', toPath: '/v2' }]);
    assert.deepEqual([ok.status, ok.body.redirects[0].fromPath], [200, '/v1']);
    assert.equal(route(state, 'DELETE', url('/v1/admin/redirects'), { cookie, 'x-shop-id': 'test-shop-a' }, { fromPaths: ['/v1', '/unknown'] }).status, 204);
  });
});
