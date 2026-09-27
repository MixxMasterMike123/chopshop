import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildTargetState, buildActualState, extractJsonArray, resultsOf, TARGET_QUERIES, ACTUAL_QUERIES } from '../state-from-queries.mjs';
import { scanForbiddenStatements } from '../lib/sql.mjs';
import { tmpDir, rmDir } from './fixtures.mjs';

/** The shape `wrangler d1 execute --json` prints. */
function wranglerJson(results) {
  return JSON.stringify([{ meta: { duration: 1 }, results, success: true }], null, 2);
}

function writeQueryFiles(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, results] of Object.entries(files)) {
    writeFileSync(path.join(dir, `${name}.json`), wranglerJson(results));
  }
}

function withExitStub(fn) {
  let message = null;
  const originalExit = process.exit;
  const originalError = console.error;
  process.exit = () => {
    throw new Error('exit');
  };
  console.error = (msg) => {
    message = msg;
  };
  try {
    fn();
  } catch {
    // expected when refused
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  return message;
}

const TARGET_FILES = {
  hostnames: [{ hostname: 'slice.example.test' }],
  identity_counts: [
    { account_type: 'platform_admin', n: 1, status: 'active' },
    { account_type: 'platform_admin', n: 4, status: 'suspended' },
    { account_type: 'tenant_admin', n: 2, status: 'active' },
  ],
  pod_profiles: [{ accepted_formats_json: '[{"ext":"png"}]', label: 'Textil', max_file_mb: 50, min_dpi: 300, print_area_h_mm: 400, print_area_w_mm: 300, profile_id: 'apparel_dtg' }],
  tenants: [{ tenant_id: 'bench-cp1' }, { tenant_id: 'slice-20260927' }],
  users: [
    { account_type: 'platform_admin', email: 'Platform@Example.com', id: 'user_1', status: 'active' },
    { account_type: null, email: 'no-identity@example.com', id: 'user_2', status: null },
  ],
};

const ACTUAL_FILES = {
  connect_facts: [
    { commission_bps: 500, connect_enabled: 1, payout_delay_days: 7, stripe_account_id: 'acct_sandbox_a', stripe_charges_enabled: 1, stripe_payouts_enabled: 0, tenant_id: 'shop-a', vat_rate_bp: 1200 },
    { commission_bps: null, connect_enabled: 0, payout_delay_days: null, stripe_account_id: null, stripe_charges_enabled: 0, stripe_payouts_enabled: 0, tenant_id: 'shop-b', vat_rate_bp: 2500 },
  ],
  identity_counts: [
    { account_type: 'platform_admin', n: 3, status: 'active' },
    { account_type: 'tenant_admin', n: 1, status: 'suspended' },
  ],
  platform_settings: [{ default_commission_bps: 500, refund_application_fee: 0, reverse_dispute_on_created: 1, review_first_products: 2, screening_hard_block: 0 }],
  pod_profiles: [{ profile_id: 'apparel_dtg' }],
  print_defaults: [{ default_printer_id: null }],
  printers: [{ id: 'snapwear', status: 'inactive', type: 'api' }],
  tenant_features_pod: [{ enabled: 1, tenant_id: 'shop-a' }, { enabled: 0, tenant_id: 'shop-b' }],
  tenants: [{ published: 1, status: 'active', tenant_id: 'shop-a' }, { published: 0, status: 'suspended', tenant_id: 'shop-b' }],
  terms: [{ term: 'kent' }, { term: 'nike' }],
};

test('every query is one read-only SELECT, and each kind has one file per query', () => {
  for (const queries of [TARGET_QUERIES, ACTUAL_QUERIES]) {
    for (const q of queries) {
      assert.match(q.sql, /^SELECT /, q.file);
      assert.equal(q.sql.split(';').filter((part) => part.trim() !== '').length, 1, `${q.file}: one statement`);
      assert.deepEqual(scanForbiddenStatements(q.sql), []);
      assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|PRAGMA|ATTACH)\b/i.test(q.sql), q.file);
    }
    assert.equal(new Set(queries.map((q) => q.file)).size, queries.length);
  }
  assert.deepEqual(TARGET_QUERIES.map((q) => q.file).sort(), Object.keys(TARGET_FILES).sort());
  assert.deepEqual(ACTUAL_QUERIES.map((q) => q.file).sort(), Object.keys(ACTUAL_FILES).sort());
});

test('extractJsonArray: skips the lines the preflight prints before the array', () => {
  const raw = `preflight: token sees exactly one account\npreflight: OK\n${wranglerJson([{ n: 1 }])}\n`;
  assert.deepEqual(resultsOf(extractJsonArray(raw)), [{ n: 1 }]);
  assert.throws(() => extractJsonArray('no array here'));
  assert.throws(() => resultsOf([{ success: true }]));
});

test('buildTargetState: the shape import.mjs reads, active identities per account type', () => {
  const base = tmpDir();
  try {
    writeQueryFiles(base, TARGET_FILES);
    assert.deepEqual(buildTargetState(base), {
      hostnames: ['slice.example.test'],
      podProfiles: { apparel_dtg: { accepted_formats_json: '[{"ext":"png"}]', label: 'Textil', max_file_mb: 50, min_dpi: 300, print_area_h_mm: 400, print_area_w_mm: 300 } },
      tenants: { ids: ['bench-cp1', 'slice-20260927'] },
      users: {
        activeCounts: { platform_admin: 1, tenant_admin: 2 },
        activePlatformAdminCount: 1,
        emailToId: { 'Platform@Example.com': 'user_1', 'no-identity@example.com': 'user_2' },
        identities: { user_1: { accountType: 'platform_admin', status: 'active' }, user_2: null },
      },
    });
  } finally {
    rmDir(base);
  }
});

test('buildActualState: holds the queried values and nothing to compare them with', () => {
  const base = tmpDir();
  try {
    writeQueryFiles(base, ACTUAL_FILES);
    const state = buildActualState(base);
    assert.deepEqual(state, {
      identityActive: { platform_admin: 3, tenant_admin: 0 },
      platformSettings: { defaultCommissionBps: 500, refundApplicationFee: false, reverseDisputeOnCreated: true, reviewFirstProducts: 2, screeningHardBlock: false },
      podProfileIds: ['apparel_dtg'],
      printDefaults: { defaultPrinterId: null },
      printers: [{ id: 'snapwear', status: 'inactive', type: 'api' }],
      tenantFeaturesPod: { 'shop-a': true, 'shop-b': false },
      tenants: {
        'shop-a': { chargesEnabled: true, commissionBps: 500, connectEnabled: true, payoutDelayDays: 7, payoutsEnabled: false, published: true, status: 'active', stripeAccountId: 'acct_sandbox_a', vatRateBp: 1200 },
        'shop-b': { chargesEnabled: false, commissionBps: null, connectEnabled: false, payoutDelayDays: null, payoutsEnabled: false, published: false, status: 'suspended', stripeAccountId: null, vatRateBp: 2500 },
      },
      terms: ['kent', 'nike'],
    });
    for (const key of Object.keys(state)) {
      assert.ok(!/^expected/i.test(key), `the actual state must not carry an expectation (${key})`);
    }
  } finally {
    rmDir(base);
  }
});

test('a missing or unreadable query file refuses, and the refusal never quotes the file', () => {
  const base = tmpDir();
  try {
    writeQueryFiles(base, TARGET_FILES);
    writeFileSync(path.join(base, 'users.json'), '[ { "results": [ { "email": "secret.person@example.com", ');
    const unreadable = withExitStub(() => buildTargetState(base));
    assert.match(unreadable, /users\.json is not the output of/);
    assert.ok(!unreadable.includes('secret.person'));

    const empty = tmpDir();
    try {
      assert.match(withExitStub(() => buildTargetState(empty)), /missing query output file/);
    } finally {
      rmDir(empty);
    }
  } finally {
    rmDir(base);
  }
});

test('buildTargetState: a users result without the identity columns refuses; NULL means "no identity" only when the query said so', () => {
  const cases = [
    [[{ email: 'a@example.com', id: 'user_1' }], /has no account_type \/ status columns/],
    [[{ account_type: 'platform_admin', email: 'a@example.com', id: 'user_1' }], /has no account_type \/ status columns/],
    [[{ account_type: 'platform_admin', email: 'a@example.com', id: 'user_1', status: null }], /not both text or both NULL/],
    [[{ account_type: null, email: 'a@example.com', id: 'user_1', status: 'active' }], /not both text or both NULL/],
    [[{ account_type: 1, email: 'a@example.com', id: 'user_1', status: 'active' }], /not both text or both NULL/],
    [[{ account_type: 'platform_admin', email: null, id: 'user_1', status: 'active' }], /without a text id and email/],
    [[{ account_type: 'platform_admin', email: 'a@example.com', status: 'active' }], /without a text id and email/],
  ];
  for (const [users, expected] of cases) {
    const base = tmpDir();
    try {
      writeQueryFiles(base, { ...TARGET_FILES, users });
      const message = withExitStub(() => buildTargetState(base));
      assert.match(String(message), expected, JSON.stringify(users));
      assert.ok(!String(message).includes('a@example.com'), 'the refusal names no address');
    } finally {
      rmDir(base);
    }
  }
  const base = tmpDir();
  try {
    writeQueryFiles(base, { ...TARGET_FILES, users: [] });
    assert.deepEqual(buildTargetState(base).users.identities, {}, 'no user at all is a valid result');
  } finally {
    rmDir(base);
  }
});
