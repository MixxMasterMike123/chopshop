// Acting-as and the platform-terms calls, under Node:
//   node --test src/api/admin/actingAs.test.mjs
// fetch is stubbed per test; nothing leaves the process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from './client.js';
import {
  ACTING_AS_TTL_MS,
  closeActingAs,
  listTenants,
  openActingAs,
  pickerShopsOf,
  sessionOfGrant,
} from './actingAs.js';
import { acceptPlatformTermsVersion, getPlatformTermsStatus, getPlatformTermsText } from './legal.js';

const realFetch = globalThis.fetch;
let calls;

const answer = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
}

beforeEach(() => {
  calls = [];
  setRequestShopId('test-shop-a');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

describe('openActingAs', () => {
  it('POSTs the trimmed reason to the shop\'s acting-as route, same origin, never with X-Shop-Id', async () => {
    stubFetch(() => answer(201, { tenantId: 'test-shop-a', expiresAt: '2026-10-03T18:00:00.000Z' }));
    const granted = await openActingAs('test-shop-a', '  felsöker en order  ');
    assert.deepEqual(granted, { tenantId: 'test-shop-a', expiresAt: '2026-10-03T18:00:00.000Z' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/_api/v1/platform/tenants/test-shop-a/acting-as');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.equal(calls[0].init.headers['x-shop-id'], undefined);
    assert.deepEqual(JSON.parse(calls[0].init.body), { reason: 'felsöker en order' });
  });

  it('refuses a blank or over-long reason before sending anything', async () => {
    stubFetch(() => answer(201, {}));
    for (const reason of ['', '   ', 'x'.repeat(501), null]) {
      await assert.rejects(openActingAs('test-shop-a', reason), (e) => e.code === 'bad_request');
    }
    assert.equal(calls.length, 0);
  });

  it('a 404 (shop not active, or not a platform user) rejects and stands after the /v1/me check', async () => {
    stubFetch((url) => (url.endsWith('/v1/me') ? answer(200, { user: { id: 'u' } }) : answer(404, { error: { code: 'not_found' } })));
    await assert.rejects(openActingAs('test-shop-b', 'skäl'), (e) => e.status === 404);
  });

  it('encodes the shop id as one segment', async () => {
    stubFetch(() => answer(201, { tenantId: 'x', expiresAt: null }));
    await openActingAs('a/b', 'skäl');
    assert.equal(calls[0].url, '/_api/v1/platform/tenants/a%2Fb/acting-as');
  });
});

describe('closeActingAs', () => {
  it('DELETE → true on 204, false on 404 (no live grant), other failures reject', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    assert.equal(await closeActingAs('test-shop-a'), true);
    assert.equal(calls[0].init.method, 'DELETE');
    assert.equal(calls[0].init.headers['x-shop-id'], undefined);

    stubFetch((url) => (url.endsWith('/v1/me') ? answer(200, { user: { id: 'u' } }) : answer(404, {})));
    assert.equal(await closeActingAs('test-shop-a'), false);

    stubFetch(() => answer(500, {}));
    await assert.rejects(closeActingAs('test-shop-a'), (e) => e.status === 500);
  });
});

describe('listTenants', () => {
  it('reads one page of the directory', async () => {
    stubFetch(() => answer(200, { tenants: [{ tenantId: 'a' }], nextCursor: 'a' }));
    assert.deepEqual(await listTenants({ status: 'active', limit: 10 }), { tenants: [{ tenantId: 'a' }], nextCursor: 'a' });
    assert.equal(calls[0].url, '/_api/v1/platform/tenants?status=active&limit=10');
    assert.equal(calls[0].init.headers['x-shop-id'], undefined);
  });
});

describe('sessionOfGrant', () => {
  const now = Date.parse('2026-10-03T17:00:00.000Z');
  const grants = [
    { tenantId: 'a', shopName: 'Shop A', expiresAt: '2026-10-03T17:30:00.000Z' },
    { tenantId: 'a', shopName: 'Shop A', expiresAt: '2026-10-03T17:45:00.000Z' },
    { tenantId: 'b', shopName: null, expiresAt: '2026-10-03T16:59:59.000Z' },
  ];

  it('the latest live grant of the shop, in the banner\'s shape', () => {
    const s = sessionOfGrant(grants, 'a', now);
    assert.equal(s.shopId, 'a');
    assert.equal(s.shopName, 'Shop A');
    assert.equal(s.expiresAt, Date.parse('2026-10-03T17:45:00.000Z'));
    assert.equal(s.startedAt, s.expiresAt - ACTING_AS_TTL_MS);
    assert.equal(s.auditId, 'a');
    assert.equal(s.reason, '');
  });

  it('null for a run-out grant, another shop, no shop, or no list', () => {
    assert.equal(sessionOfGrant(grants, 'b', now), null);
    assert.equal(sessionOfGrant(grants, 'c', now), null);
    assert.equal(sessionOfGrant(grants, null, now), null);
    assert.equal(sessionOfGrant(null, 'a', now), null);
    assert.equal(sessionOfGrant([{ tenantId: 'a', expiresAt: 'not a date' }], 'a', now), null);
  });

  it('runs out exactly at expiresAt', () => {
    assert.equal(sessionOfGrant([{ tenantId: 'a', expiresAt: '2026-10-03T17:00:00.000Z' }], 'a', now), null);
  });
});

describe('pickerShopsOf', () => {
  it('a tenant admin: every membership, a suspended or closed one marked disabled, sorted by name', () => {
    const me = {
      accountType: 'tenant_admin',
      memberships: [
        { tenantId: 'c', shopName: 'Charlie', status: 'active' },
        { tenantId: 'b', shopName: 'Bravo', status: 'suspended' },
        { tenantId: 'a', shopName: null, status: 'closed' },
      ],
      actingAs: [{ tenantId: 'z', expiresAt: '2999-01-01T00:00:00.000Z' }],
    };
    assert.deepEqual(pickerShopsOf(me), [
      { id: 'a', name: null, status: 'disabled' },
      { id: 'b', name: 'Bravo', status: 'disabled' },
      { id: 'c', name: 'Charlie', status: 'active' },
    ]);
  });

  it('a platform user: its live grants only, one row per shop', () => {
    const now = Date.parse('2026-10-03T17:00:00.000Z');
    const me = {
      accountType: 'platform_admin',
      memberships: [{ tenantId: 'm', status: 'active' }],
      actingAs: [
        { tenantId: 'a', shopName: 'A', expiresAt: '2026-10-03T17:10:00.000Z' },
        { tenantId: 'a', shopName: 'A', expiresAt: '2026-10-03T17:20:00.000Z' },
        { tenantId: 'b', shopName: 'B', expiresAt: '2026-10-03T16:00:00.000Z' },
      ],
    };
    assert.deepEqual(pickerShopsOf(me, now), [{ id: 'a', name: 'A', status: 'active' }]);
  });

  it('nothing for no answer', () => {
    assert.deepEqual(pickerShopsOf(null), []);
  });
});

describe('the platform-terms calls (legal.js, CP5-FB section)', () => {
  it('status and text: GET with the active shop', async () => {
    stubFetch(() => answer(200, { currentVersion: 'v1', accepted: false }));
    assert.deepEqual(await getPlatformTermsStatus(), { currentVersion: 'v1', accepted: false });
    assert.equal(calls[0].url, '/_api/v1/admin/legal/status');
    assert.equal(calls[0].init.headers['x-shop-id'], 'test-shop-a');

    stubFetch(() => answer(200, { version: 'v1', text: '{}' }));
    assert.deepEqual(await getPlatformTermsText({ shopId: 'test-shop-c' }), { version: 'v1', text: '{}' });
    assert.equal(calls[1].url, '/_api/v1/admin/legal/terms');
    assert.equal(calls[1].init.headers['x-shop-id'], 'test-shop-c');
  });

  it('accept: POST exactly { termsVersion }, resolves the acceptance; 409 rejects with its code', async () => {
    stubFetch(() => answer(201, { acceptance: { termsVersion: 'v1', acceptedAt: '2026-10-03T17:00:00.000Z' } }));
    assert.deepEqual(await acceptPlatformTermsVersion('v1'), { termsVersion: 'v1', acceptedAt: '2026-10-03T17:00:00.000Z' });
    assert.equal(calls[0].url, '/_api/v1/admin/legal/accept-terms');
    assert.deepEqual(JSON.parse(calls[0].init.body), { termsVersion: 'v1' });

    stubFetch(() => answer(409, { error: { code: 'terms_version_not_current' }, currentVersion: 'v2' }));
    await assert.rejects(acceptPlatformTermsVersion('v1'), (e) => e.code === 'terms_version_not_current');
  });

  it('refuses without an active shop, sending nothing', async () => {
    setRequestShopId(null);
    stubFetch(() => answer(200, {}));
    await assert.rejects(getPlatformTermsStatus(), (e) => e.code === 'no_shop');
    assert.equal(calls.length, 0);
  });
});
