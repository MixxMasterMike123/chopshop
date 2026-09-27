import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformShop, ARCHIVED_SHOP_IDS } from '../lib/transform-shops.mjs';
import { normalizeEmailMap } from '../lib/scrub.mjs';

const emailMap = normalizeEmailMap({ 'owner@example.com': 'owner-test@example.com' });
const noConnect = { chargesEnabled: false, connectEnabled: false, detailsSubmitted: false, disabledReason: null, payoutDelayDays: null, payoutsEnabled: false, requirementsDueJson: null, stripeAccountId: null };

test('transformShop: D21 archives robowatz, emitting nothing', () => {
  const result = transformShop({
    connectFacts: noConnect,
    doc: { data: { name: 'Robowatz' }, id: 'robowatz' },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
  });
  assert.equal(result.skipped, 'archived');
  assert.deepEqual(result.rows, []);
  assert.ok(ARCHIVED_SHOP_IDS.has('robowatz'));
});

test('transformShop: status active->active, published carried verbatim', () => {
  const result = transformShop({
    connectFacts: noConnect,
    doc: { data: { name: 'Shop', published: true, status: 'active' }, id: 'shop-a' },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
  });
  const tenantsStmt = result.rows.find((r) => r.table === 'tenants').statement;
  assert.match(tenantsStmt, /'active'/);
  assert.match(tenantsStmt, / 1,/); // published=1 somewhere among the values
});

test('transformShop: status disabled->suspended (D59)', () => {
  const result = transformShop({
    connectFacts: noConnect,
    doc: { data: { name: 'Shop', published: false, status: 'disabled' }, id: 'shop-b' },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
  });
  const tenantsStmt = result.rows.find((r) => r.table === 'tenants').statement;
  assert.match(tenantsStmt, /'suspended'/);
});

test('transformShop: an unknown status maps to provisioning', () => {
  const result = transformShop({
    connectFacts: noConnect,
    doc: { data: { name: 'Shop', status: 'weird' }, id: 'shop-c' },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
  });
  const tenantsStmt = result.rows.find((r) => r.table === 'tenants').statement;
  assert.match(tenantsStmt, /'provisioning'/);
});

test('transformShop: a shop with no features field at all still gets an explicit pod row (D22)', () => {
  const result = transformShop({
    connectFacts: noConnect,
    doc: { data: { name: 'Shop', status: 'active' }, id: 'shop-d' },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
  });
  const podRow = result.rows.find((r) => r.table === 'tenant_features' && r.pk === 'shop-d:pod');
  assert.ok(podRow, 'expected an explicit pod row even with no features field');
  assert.match(podRow.statement, /'pod', 0,/); // opt-in default OFF
});

test('transformShop: empty-string identity fields become NULL', () => {
  const result = transformShop({
    connectFacts: noConnect,
    doc: { data: { name: 'Shop', status: 'active', storeIdentity: { returnAddress: '', supportEmail: '', vatNumber: '' } }, id: 'shop-e' },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
  });
  const settingsStmt = result.rows.find((r) => r.table === 'tenant_settings').statement;
  assert.match(settingsStmt, /NULL, NULL, NULL, NULL,/); // return_address, vat_registered, vat_number, seller_type all NULL
});

test('transformShop: mixed timestamp shapes — ISO string updatedAt is accepted verbatim (normalised)', () => {
  const result = transformShop({
    connectFacts: noConnect,
    doc: { data: { name: 'Shop', status: 'active', updatedAt: '2026-03-01T00:00:00.000Z' }, id: 'shop-f' },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
  });
  const tenantsStmt = result.rows.find((r) => r.table === 'tenants').statement;
  // tenants.created_at/updated_at are INTEGER milliseconds (0001), not ISO
  // text — the source's ISO updatedAt string is parsed to millis and stored
  // as the plain integer literal Date.parse('2026-03-01T00:00:00.000Z').
  assert.match(tenantsStmt, new RegExp(String(Date.parse('2026-03-01T00:00:00.000Z'))));
});

test('transformShop: refused store-identity keys are dropped and reported', () => {
  const result = transformShop({
    connectFacts: noConnect,
    doc: { data: { name: 'Shop', status: 'active', storeIdentity: { commissionBps: 500, shopName: 'X', supportEmail: 'owner@example.com' } }, id: 'shop-g' },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
  });
  const settingsStmt = result.rows.find((r) => r.table === 'tenant_settings').statement;
  assert.ok(!settingsStmt.includes('commissionBps'));
  assert.ok(!settingsStmt.includes('shopName'));
  assert.ok(result.report.lines.some((l) => l.includes('commissionBps')));
});

test('transformShop: a Firebase Storage branding URL is removed and reported', () => {
  const result = transformShop({
    connectFacts: noConnect,
    doc: {
      data: { name: 'Shop', status: 'active', storeIdentity: { logoUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/y.png' } },
      id: 'shop-h',
    },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
  });
  const settingsStmt = result.rows.find((r) => r.table === 'tenant_settings').statement;
  assert.ok(!settingsStmt.includes('firebasestorage.googleapis.com'));
  assert.ok(result.report.lines.some((l) => l.includes('logoUrl removed')));
});

test('transformShop: a collision against --target-state is reported and no rows are dropped for other reasons', () => {
  const result = transformShop({
    connectFacts: noConnect,
    doc: { data: { name: 'Shop', status: 'active' }, id: 'shop-i' },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
    targetState: { hostnames: new Set(), tenantIds: new Set(['shop-i']) },
  });
  assert.equal(result.skipped, 'collision');
  assert.ok(result.report.collisions.some((c) => c.includes('shop-i')));
});
