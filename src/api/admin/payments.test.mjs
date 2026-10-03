// The payments calls, under Node:
//   node --test src/api/admin/payments.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import {
  createConnectAccount,
  createLoginLink,
  createOnboardingLink,
  getConnect,
  getPlatformConnect,
  refreshConnect,
  setPlatformPayoutDelay,
} from './payments.js';

const realFetch = globalThis.fetch;
let calls;

const answer = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
}

const header = (call, name) => call.init.headers[name.toLowerCase()];
const VIEW = { enabled: true, hasAccount: false, status: 'none', chargesEnabled: false, requirementsDue: [] };

beforeEach(() => {
  calls = [];
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('the seller routes', () => {
  it('GET the status with X-Shop-Id', async () => {
    stubFetch(() => answer(200, { connect: VIEW }));
    assert.deepEqual(await getConnect({ shopId: 'test-shop-a' }), VIEW);
    assert.equal(calls[0].url, '/_api/v1/admin/payments/connect');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(header(calls[0], 'X-Shop-Id'), 'test-shop-a');
  });

  it('a 404 with the session alive reads as no view (null)', async () => {
    stubFetch((url) => (url === '/_api/v1/me' ? answer(200, { user: {} }) : answer(404, { error: { code: 'not_found' } })));
    assert.equal(await getConnect(), null);
    assert.equal(calls.length, 2);
  });

  it('a 404 whose /v1/me is 401 rejects unauthenticated', async () => {
    stubFetch((url) => (url === '/_api/v1/me' ? answer(401, { error: { code: 'unauthenticated' } }) : answer(404, {})));
    await assert.rejects(getConnect(), (e) => e.status === 401 && e.code === 'unauthenticated');
  });

  it('the four POSTs: paths, no body, X-Shop-Id', async () => {
    stubFetch((url) => {
      if (url.endsWith('/account')) return answer(201, { connect: { ...VIEW, hasAccount: true, status: 'onboarding' } });
      if (url.endsWith('/onboarding-link')) return answer(200, { onboarding: { url: 'https://connect.stripe.com/x', expiresAt: null } });
      if (url.endsWith('/refresh')) return answer(200, { connect: VIEW });
      return answer(200, { dashboard: { url: 'https://connect.stripe.com/express/x' } });
    });
    const created = await createConnectAccount({ shopId: 'test-shop-a' });
    assert.equal(created.pending, false);
    assert.equal(created.connect.status, 'onboarding');
    assert.deepEqual(await createOnboardingLink(), { url: 'https://connect.stripe.com/x', expiresAt: null });
    assert.deepEqual(await refreshConnect(), VIEW);
    assert.deepEqual(await createLoginLink(), { url: 'https://connect.stripe.com/express/x' });
    assert.deepEqual(
      calls.map((c) => c.url.replace('/_api/v1/admin/payments/connect', '')),
      ['/account', '/onboarding-link', '/refresh', '/login-link'],
    );
    for (const call of calls) {
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.body, undefined);
      assert.equal(header(call, 'X-Shop-Id'), 'test-shop-a');
    }
  });

  it('202: pending with Retry-After', async () => {
    stubFetch(() => answer(202, { accountCreation: 'pending', connect: VIEW }, { 'retry-after': '5' }));
    assert.deepEqual(await createConnectAccount(), { connect: VIEW, pending: true, retryAfterSeconds: 5 });
  });

  it('a refusal rejects with the API code', async () => {
    stubFetch(() => answer(502, { error: { code: 'connect_unavailable', message: 'x' } }));
    await assert.rejects(refreshConnect(), (e) => e.code === 'connect_unavailable' && e.status === 502);
  });
});

describe('the platform routes', () => {
  it('payout delay: PUT, the body, and NO X-Shop-Id even with an active shop', async () => {
    stubFetch(() => answer(200, { connect: { payoutDelayDays: 7 } }));
    assert.deepEqual(await setPlatformPayoutDelay('test-shop-a', 7), { payoutDelayDays: 7 });
    assert.equal(calls[0].url, '/_api/v1/platform/tenants/test-shop-a/connect/payout-delay');
    assert.equal(calls[0].init.method, 'PUT');
    assert.equal(calls[0].init.body, JSON.stringify({ delayDays: 7 }));
    assert.equal(header(calls[0], 'X-Shop-Id'), undefined);
  });

  it('minimum is sent as the word', async () => {
    stubFetch(() => answer(200, { connect: { payoutDelayDays: null } }));
    await setPlatformPayoutDelay('test-shop-a', 'minimum');
    assert.equal(calls[0].init.body, JSON.stringify({ delayDays: 'minimum' }));
  });

  it('the platform read, segment-encoded, no X-Shop-Id', async () => {
    stubFetch(() => answer(200, { connect: { payoutDelayDays: null }, operations: [] }));
    await getPlatformConnect('a b');
    assert.equal(calls[0].url, '/_api/v1/platform/tenants/a%20b/connect');
    assert.equal(header(calls[0], 'X-Shop-Id'), undefined);
  });
});
