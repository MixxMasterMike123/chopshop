// The shapes of the FJ pages under Node: node --test src/admin-app/adapters/platformConsole.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  API_FEATURE_KEYS,
  columnsOf,
  featuresMapOf,
  listedTenants,
  queueRowOf,
  queueStatusOf,
  reportActionMessage,
  reportRowOf,
  shopRowOf,
  sortShops,
  sortUsers,
  userActionMessage,
  userRowOf,
} from './platformConsole.js';

describe('add-ons', () => {
  const catalog = [{ key: 'affiliate' }, { key: 'discountCodes' }, { key: 'dining' }, { key: 'pod' }, { key: 'b2b' }, { key: 'writers' }];
  it('the columns are the catalogue entries the Worker knows, in order', () => {
    assert.deepEqual(columnsOf(catalog).map((a) => a.key), ['discountCodes', 'pod']);
    assert.equal(API_FEATURE_KEYS.length, 6);
  });
  it('the map holds the effective value of the keys the Worker knows, nothing else', () => {
    const views = [
      { key: 'pod', enabled: true },
      { key: 'discountCodes', enabled: false },
      { key: 'dining', enabled: true },
      { key: 'productReviews', enabled: 'yes' },
    ];
    assert.deepEqual(featuresMapOf(views), { pod: true, discountCodes: false, productReviews: false });
    assert.deepEqual(featuresMapOf(undefined), {});
  });
  it('a shop row, with a name that may be missing', () => {
    assert.deepEqual(shopRowOf({ tenantId: 'a', shopName: null }, []), { id: 'a', name: '', features: {} });
    assert.equal(shopRowOf({ tenantId: 'a', shopName: 'Shop' }, []).name, 'Shop');
  });
  it('a closed shop is not listed; shops sort by name, else id', () => {
    assert.deepEqual(listedTenants([{ status: 'active' }, { status: 'closed' }, { status: 'suspended' }]).length, 2);
    assert.deepEqual(sortShops([{ id: 'b', name: '' }, { id: 'a2', name: 'Zed' }, { id: 'c', name: 'Alfa' }]).map((s) => s.id), ['c', 'b', 'a2']);
  });
});

describe('users', () => {
  const base = { userId: 'u1', email: 'a@example.com', name: 'A', accountType: 'tenant_admin', status: 'active', hasPassword: true };
  it('a tenant admin lists its ACTIVE shops', () => {
    const row = userRowOf({ ...base, memberships: [{ tenantId: 's1', status: 'active' }, { tenantId: 's2', status: 'revoked' }, { tenantId: 's3', status: 'active' }] });
    assert.equal(row.shopId, 's1, s3');
    assert.equal(row.platform, false);
    assert.equal(row.uid, 'u1');
  });
  it('no live membership reads as no shop; a platform admin is flagged', () => {
    assert.equal(userRowOf({ ...base, memberships: [] }).shopId, null);
    assert.equal(userRowOf({ ...base, accountType: 'platform_admin' }).platform, true);
  });
  it('a suspended account is marked, a missing name is empty', () => {
    const row = userRowOf({ ...base, name: undefined, status: 'suspended' });
    assert.equal(row.suspended, true);
    assert.equal(row.contactPerson, '');
  });
  it('"Skicka inbjudan" (hasPassword false) for anyone who has not set a password of their own (CP5-WJ4)', () => {
    const issued = { createdAt: '2026-10-01T08:00:00.000Z', expiresAt: '2026-10-04T08:00:00.000Z', status: 'issued' };
    // Created password-less, never invited, or invited and not yet accepted.
    assert.equal(userRowOf({ ...base, hasPassword: false, invite: null }).hasPassword, false);
    assert.equal(userRowOf({ ...base, hasPassword: false, invite: { ...issued, pending: true } }).hasPassword, false);
    // Provisioned before CP5-WJ4 with a random password: the invite expired,
    // was revoked (mail not queued) or is still live, and was never used.
    for (const invite of [
      { ...issued, expired: true, pending: true },
      { ...issued, status: 'revoked', pending: true },
      { ...issued, pending: true },
    ]) {
      assert.equal(userRowOf({ ...base, hasPassword: true, invite }).hasPassword, false, JSON.stringify(invite));
    }
    // Their own password: set through the invite, or never invited at all.
    assert.equal(userRowOf({ ...base, hasPassword: true, invite: { ...issued, pending: false } }).hasPassword, true);
    assert.equal(userRowOf({ ...base, hasPassword: true, invite: null }).hasPassword, true);
    // A directory without the field (an older API) reads as before.
    assert.equal(userRowOf({ ...base, hasPassword: true, invite: issued }).hasPassword, true);
  });
  it('platform admins first, then by e-mail', () => {
    const rows = [{ platform: false, email: 'a' }, { platform: true, email: 'z' }, { platform: false, email: 'b' }, { platform: true, email: 'c' }];
    assert.deepEqual(sortUsers(rows).map((r) => r.email), ['c', 'z', 'a', 'b']);
  });
  it('refusals speak Swedish; other errors are not claimed', () => {
    assert.match(userActionMessage({ status: 409, code: 'platform_admin_reactivation' }), /plattformsadmin/);
    assert.match(userActionMessage({ status: 409, code: 'last_platform_admin' }), /Minst en/);
    assert.equal(userActionMessage({ status: 500, code: 'internal_error' }), null);
    assert.equal(userActionMessage(new Error('x')), null);
    assert.ok(userActionMessage({ status: 404, code: 'not_found' }));
  });
});

describe('reports', () => {
  const view = {
    reportId: 'r1', tenantId: 's1', productId: 'p1', productName: 'Tee', productUrl: null, reporterName: 'N', reporterEmail: 'n@example.com',
    reporterOrg: null, rightType: 'trademark', description: 'd', attestation: true, status: 'new', note: null,
    createdAt: '2026-10-01T08:00:00.000Z', handledAt: null,
  };
  it('the row has what the page reads, and a Timestamp-like date', () => {
    const row = reportRowOf(view);
    assert.equal(row.id, 'r1');
    assert.equal(row.shopId, 's1');
    assert.equal(row.createdAt.toMillis(), Date.parse('2026-10-01T08:00:00.000Z'));
    assert.equal(row.handledAt, null);
    assert.equal(row.reporterOrg, '');
    assert.equal(row.product, null);
  });
  it('a handled report has a date', () => {
    assert.equal(reportRowOf({ ...view, status: 'rejected', handledAt: '2026-10-02T08:00:00.000Z' }).handledAt.toMillis(), Date.parse('2026-10-02T08:00:00.000Z'));
  });
  it('the server\'s 409 codes in Swedish', () => {
    for (const code of ['conflict', 'product_mismatch', 'report_closed', 'tenant_mismatch', 'transition_refused']) {
      assert.ok(reportActionMessage({ status: 409, code }), code);
    }
    assert.equal(reportActionMessage({ code: 'something_else' }), null);
  });
});

describe('the screening queue', () => {
  const v = { productId: 'p', tenantId: 's', productName: 'N', hits: ['x'], decidedAt: '2026-10-01T08:00:00.000Z', takenDown: false, reason: null, status: 'pending' };
  it('three states', () => {
    assert.equal(queueStatusOf({ ...v, status: 'blocked' }), 'blocked');
    assert.equal(queueStatusOf({ ...v, reason: 'first_products' }), 'review');
    assert.equal(queueStatusOf({ ...v, reason: 'blocklist_hit' }), 'flagged');
    assert.equal(queueStatusOf({ ...v, status: 'flagged' }), 'flagged');
  });
  it('a taken-down product is not live; a pending one stays visible (D8)', () => {
    assert.equal(queueRowOf(v).isActive, true);
    assert.equal(queueRowOf({ ...v, status: 'flagged' }).isActive, true);
    assert.equal(queueRowOf({ ...v, status: 'blocked', takenDown: true }).isActive, false);
    assert.equal(queueRowOf(v).id, 'p');
    assert.deepEqual(queueRowOf(v).screening.hits, ['x']);
  });
});
