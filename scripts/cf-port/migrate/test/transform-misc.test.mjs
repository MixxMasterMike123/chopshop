import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformPrintDefaults } from '../lib/transform-print-defaults.mjs';
import { transformPodProfiles } from '../lib/transform-pod-profiles.mjs';
import { transformPlatformSettings, assertSettingsAppAbsent } from '../lib/transform-platform-settings.mjs';
import { transformAuditLog } from '../lib/transform-audit-logs.mjs';
import { transformLegalAcceptance } from '../lib/transform-legal-acceptances.mjs';
import { normalizeEmailMap } from '../lib/scrub.mjs';

// ── print-defaults (row 69) ──

test('transformPrintDefaults: staging always writes NULL (D66), even when the source names snapwear', () => {
  const { report, rows } = transformPrintDefaults({ env: 'staging', nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), printRoutingDoc: { data: { defaultPrinterUid: 'snapwear' } } });
  assert.equal(report.defaultPrinterId, null);
  assert.match(rows[0].statement, /default_printer_id = NULL/);
});

test('transformPrintDefaults: production writes the real default when it is snapwear', () => {
  const { report, rows } = transformPrintDefaults({ env: 'production', nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), printRoutingDoc: { data: { defaultPrinterUid: 'snapwear' } } });
  assert.equal(report.defaultPrinterId, 'snapwear');
  assert.match(rows[0].statement, /default_printer_id = 'snapwear'/);
});

test('transformPrintDefaults: production refuses to invent a default for any printer other than snapwear (D12)', () => {
  const { problems, rows } = transformPrintDefaults({ env: 'production', nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), printRoutingDoc: { data: { defaultPrinterUid: 'some-other-uid' } } });
  assert.deepEqual(rows, []);
  assert.ok(problems.length > 0);
});

// ── pod-profiles (row 70) ──

test('transformPodProfiles: imports a profile not already in the target', () => {
  const doc = { data: { profiles: [{ accepted_formats: [{ ext: 'png' }], id: 'apparel_dtg', label: 'Textil', max_file_mb: 50, min_dpi: 300, print_area_mm: { h: 400, w: 300 } }] } };
  const { report, rows } = transformPodProfiles({ nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), podProfilesDoc: doc, targetState: null });
  assert.equal(rows.length, 1);
  assert.deepEqual(report.imported, ['apparel_dtg']);
});

test('transformPodProfiles: a profile already in the target is reported as a diff, never overwritten', () => {
  const doc = { data: { profiles: [{ accepted_formats: [{ ext: 'png' }], id: 'apparel_dtg', label: 'Textil (changed)', max_file_mb: 50, min_dpi: 300, print_area_mm: { h: 400, w: 300 } }] } };
  const existing = new Map([['apparel_dtg', { accepted_formats_json: '[{"ext":"png"}]', label: 'Textil (original)', max_file_mb: 50, min_dpi: 300, print_area_h_mm: 400, print_area_w_mm: 300 }]]);
  const { report, rows } = transformPodProfiles({ nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), podProfilesDoc: doc, targetState: { podProfileIds: existing } });
  assert.equal(rows.length, 0);
  assert.equal(report.conflicts.length, 1);
  assert.ok(report.conflicts[0].diffs.some((d) => d.field === 'label'));
});

test('transformPodProfiles: absent doc reports a problem, emits no rows', () => {
  const { problems, rows } = transformPodProfiles({ nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), podProfilesDoc: null, targetState: null });
  assert.deepEqual(rows, []);
  assert.ok(problems.length > 0);
});

// ── platform-settings (row 67 + 68) ──

test('transformPlatformSettings: always sets the pinned defaults (500 / true), never touches refund_application_fee', () => {
  const { report, rows } = transformPlatformSettings({ nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), platformDoc: null });
  assert.equal(report.defaultCommissionBps, 500);
  assert.equal(report.reverseDisputeOnCreated, true);
  assert.ok(!rows[0].statement.includes('refund_application_fee'));
});

test('transformPlatformSettings: a present doc is reported but its content is ignored (production has none, §0 census)', () => {
  const { problems, rows } = transformPlatformSettings({ nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), platformDoc: { defaultCommissionBps: 999 } });
  assert.ok(problems.some((p) => p.includes('unexpectedly present')));
  assert.ok(rows[0].statement.includes('500')); // still the pinned default, not 999
});

test('assertSettingsAppAbsent: passes when absent, fails when present', () => {
  assert.deepEqual(assertSettingsAppAbsent({ appDoc: null }), { ok: true, problem: null });
  const result = assertSettingsAppAbsent({ appDoc: { anything: true } });
  assert.equal(result.ok, false);
});

// ── audit logs (row 12) ──

test('transformAuditLog: preserves the Firestore id as event_id, maps actor uid through legacy_id_map', () => {
  const legacyIdMap = { admin1: 'new-user-id-1' };
  const { rows } = transformAuditLog({ doc: { data: { action: 'product.takedown', actorUid: 'admin1', shopId: 'shop-a' }, id: 'log-1' }, legacyIdMap, nowMillis: 1735689600000 });
  const stmt = rows[0].statement;
  assert.match(stmt, /'log-1'/);
  assert.match(stmt, /'new-user-id-1'/);
});

test('transformAuditLog: an unmapped actor uid is kept in metadata_json, actor_user_id NULL', () => {
  const legacyIdMap = {};
  const { rows } = transformAuditLog({ doc: { data: { action: 'product.takedown', actorUid: 'unmapped-uid' }, id: 'log-2' }, legacyIdMap, nowMillis: 1735689600000 });
  const stmt = rows[0].statement;
  assert.match(stmt, /legacyActorUid/);
  assert.match(stmt, /"unmapped-uid"/);
});

// ── legal acceptances (row 65) ──

const emailMap = normalizeEmailMap({ 'tenant1@example.com': 'tenant1-test@example.com' });

test('transformLegalAcceptance: keeps legacy_uid verbatim, maps user_id via legacy_id_map, canonical texts hash', () => {
  const legacyIdMap = { tenantadmin1: 'new-user-id-1' };
  const doc = {
    data: {
      acceptedAt: '2025-01-02T00:00:00.000Z',
      acceptedAtIso: '2025-01-02T00:00:00.000Z',
      custom: { a: false },
      email: 'tenant1@example.com',
      pod: true,
      shopId: 'shop-a',
      templateVersion: '1',
      texts: { kopvillkor: '<p>x</p>' },
      type: 'legalPages',
      uid: 'tenantadmin1',
    },
    id: 'accept1',
    path: 'shops/shop-a/legalAcceptances/accept1',
  };
  const { problems, report, rows } = transformLegalAcceptance({ doc, emailMap, legacyIdMap, nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), scrubUnmapped: false });
  assert.deepEqual(problems, []);
  assert.equal(report.adopted, true);
  const stmt = rows[0].statement;
  assert.match(stmt, /'tenantadmin1'/); // legacy_uid verbatim
  assert.match(stmt, /'new-user-id-1'/); // mapped user_id
  assert.match(stmt, /'import'/); // source
  assert.match(stmt, /'[0-9a-f]{64}'/); // texts_sha256
});

test('transformLegalAcceptance: an unmappable uid keeps legacy_uid, user_id NULL', () => {
  const legacyIdMap = {}; // empty: uid not carried
  const doc = {
    data: { acceptedAt: '2025-01-02T00:00:00.000Z', email: 'tenant1@example.com', shopId: 'shop-a', texts: { kopvillkor: '<p>x</p>' }, type: 'legalPages', uid: 'someone-not-carried' },
    id: 'accept2',
    path: 'shops/shop-a/legalAcceptances/accept2',
  };
  const { report, rows } = transformLegalAcceptance({ doc, emailMap, legacyIdMap, nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), scrubUnmapped: false });
  assert.equal(report.adopted, false);
  const columnsMatch = rows[0].statement.match(/INTO legal_acceptances \((.*)\) VALUES/)[1];
  const columns = columnsMatch.split(', ');
  const valuesMatch = rows[0].statement.match(/VALUES \((.*)\);/)[1];
  const values = valuesMatch.split(', ');
  assert.equal(values[columns.indexOf('user_id')], 'NULL');
  assert.equal(values[columns.indexOf('legacy_uid')], "'someone-not-carried'");
});

test('transformLegalAcceptance: a row with no uid at all is skipped and reported (0037 requires legacy_uid)', () => {
  const doc = { data: { email: 'tenant1@example.com', shopId: 'shop-a', texts: {}, type: 'legalPages' }, id: 'accept3', path: 'shops/shop-a/legalAcceptances/accept3' };
  const { problems, rows } = transformLegalAcceptance({ doc, emailMap, legacyIdMap: {}, nowMillis: Date.parse('2026-01-01T00:00:00.000Z'), scrubUnmapped: false });
  assert.deepEqual(rows, []);
  assert.ok(problems.length > 0);
});
