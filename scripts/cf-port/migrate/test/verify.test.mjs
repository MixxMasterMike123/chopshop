import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { runChecks, KNOWN_NON_MANIFEST_TENANTS, CP3_ITEMS } from '../verify.mjs';
import { runImport } from '../import.mjs';
import { tmpDir, rmDir, buildFixtureBundle, FIXED_EMAIL_MAP } from './fixtures.mjs';

const NO_CONNECT = { chargesEnabled: false, commissionBps: null, connectEnabled: false, payoutDelayDays: null, payoutsEnabled: false, stripeAccountId: null, vatRateBp: 2500 };

function plan() {
  return {
    env: 'staging',
    expected: {
      identity: { baselineActive: { platform_admin: 1, tenant_admin: 1 }, carriedActive: { platform_admin: 2, tenant_admin: 1 } },
      podProfileIds: ['apparel_dtg'],
      screening: { sourceTermCount: 4, terms: ['kent', 'nike', '™'] },
      targetStateGiven: true,
      tenants: {
        'shop-a': { ...NO_CONNECT, connectEnabled: true, podEnabled: true, published: true, status: 'active' },
        'shop-b': { ...NO_CONNECT, podEnabled: false, published: false, status: 'suspended' },
      },
    },
  };
}

function matchingState() {
  return {
    identityActive: { platform_admin: 3, tenant_admin: 2 },
    platformSettings: { defaultCommissionBps: 500, refundApplicationFee: false, reverseDisputeOnCreated: true, reviewFirstProducts: 2, screeningHardBlock: false },
    podProfileIds: ['apparel_dtg', 'seeded_before'],
    printDefaults: { defaultPrinterId: null },
    printers: [{ id: 'snapwear', status: 'inactive', type: 'api' }],
    tenantFeaturesPod: { 'shop-a': true, 'shop-b': false },
    tenants: {
      'shop-a': { ...NO_CONNECT, connectEnabled: true, published: true, status: 'active' },
      'shop-b': { ...NO_CONNECT, published: false, status: 'suspended' },
    },
    terms: ['kent', 'nike', 'seeded-before', '™'],
  };
}

function failing(overrides = {}) {
  const args = { actualState: matchingState(), bundleVerified: true, env: 'staging', planJson: plan(), ...overrides };
  return runChecks(args).checks.filter((c) => !c.ok);
}

test('runChecks: a fully matching state passes every CP3 item, and every CP3 item is checked', () => {
  const { checks } = runChecks({ actualState: matchingState(), bundleVerified: true, env: 'staging', planJson: plan() });
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.deepEqual([...new Set(checks.map((c) => c.item))].sort((a, b) => a - b), CP3_ITEMS);
});

test('runChecks: refund_application_fee = true breaks item 1 only', () => {
  const state = matchingState();
  state.platformSettings.refundApplicationFee = true;
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [1]);
});

test('runChecks: default_commission_bps mismatch breaks item 2 only', () => {
  const state = matchingState();
  state.platformSettings.defaultCommissionBps = 800;
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [2]);
});

test('runChecks: reverse_dispute_on_created mismatch breaks item 3 only', () => {
  const state = matchingState();
  state.platformSettings.reverseDisputeOnCreated = false;
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [3]);
});

test('runChecks: item 4 — each Connect fact that differs from the plan fails, named by tenant and field', () => {
  for (const [field, value] of [['connectEnabled', false], ['stripeAccountId', 'acct_other'], ['chargesEnabled', true], ['payoutsEnabled', true], ['payoutDelayDays', 7], ['commissionBps', 5000], ['vatRateBp', 1200]]) {
    const state = matchingState();
    state.tenants['shop-a'][field] = value;
    const failed = failing({ actualState: state });
    assert.deepEqual(failed.map((c) => c.item), [4], field);
    assert.match(failed[0].actual, new RegExp(`shop-a: ${field}`));
  }
});

test('runChecks: item 4 cannot pass on the state file alone — a state that names its own expectation is ignored', () => {
  const state = matchingState();
  state.tenants['shop-a'].stripeAccountId = 'acct_wrong';
  state.expectedConnect = { 'shop-a': { ...state.tenants['shop-a'] } };
  assert.ok(failing({ actualState: state }).some((c) => c.item === 4));
});

test('runChecks: staging expects default_printer_id NULL (D66); a non-null value fails item 6', () => {
  const state = matchingState();
  state.printDefaults.defaultPrinterId = 'snapwear';
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [6]);
});

test('runChecks: production expects default_printer_id = snapwear, snapwear active, and the manifest identity figure', () => {
  const state = matchingState();
  state.printDefaults.defaultPrinterId = 'snapwear';
  state.printers = [{ id: 'snapwear', status: 'active', type: 'api' }];
  state.identityActive = { platform_admin: 2, tenant_admin: 1 };
  const planJson = plan();
  planJson.env = 'production';
  planJson.expected.identity.baselineActive = null;
  planJson.expected.targetStateGiven = false;
  state.terms = ['kent', 'nike', '™'];
  assert.deepEqual(failing({ actualState: state, env: 'production', planJson }), []);

  // Equal to the plan but not to the manifest's 2 + 1: still a failure on production.
  planJson.expected.identity.carriedActive = { platform_admin: 1, tenant_admin: 1 };
  state.identityActive = { platform_admin: 1, tenant_admin: 1 };
  assert.deepEqual(failing({ actualState: state, env: 'production', planJson }).map((c) => c.item), [14]);
});

test('runChecks: snapwear inactive on staging (D59); active or missing breaks item 6', () => {
  const state = matchingState();
  state.printers = [{ id: 'snapwear', status: 'active', type: 'api' }];
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [6]);
  state.printers = [];
  assert.ok(failing({ actualState: state }).every((c) => c.item === 6));
  assert.equal(failing({ actualState: state }).length, 2);
});

test('runChecks: item 7 — a term of the plan missing from the target fails', () => {
  const state = matchingState();
  state.terms = ['kent', 'nike'];
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [7]);
});

test('runChecks: item 7 — a state with no term list fails, it does not pass for want of data', () => {
  const state = matchingState();
  delete state.terms;
  state.termCount = 3;
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [7]);
});

test('runChecks: item 7 — into an empty target (no --target-state) an unknown extra term fails', () => {
  const planJson = plan();
  planJson.expected.targetStateGiven = false;
  planJson.expected.identity.baselineActive = null;
  const state = matchingState();
  state.identityActive = { platform_admin: 2, tenant_admin: 1 };
  assert.deepEqual(failing({ actualState: state, planJson }).map((c) => c.item), [7]);
  state.terms = ['kent', 'nike', '™'];
  assert.deepEqual(failing({ actualState: state, planJson }), []);
});

test('runChecks: review_first_products and hard_block mismatches break item 7', () => {
  const state = matchingState();
  state.platformSettings.reviewFirstProducts = 5;
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [7]);
  const other = matchingState();
  other.platformSettings.screeningHardBlock = true;
  assert.deepEqual(failing({ actualState: other }).map((c) => c.item), [7]);
});

test('runChecks: item 10 — a profile of the export missing from the target fails; so does a state with no list', () => {
  const state = matchingState();
  state.podProfileIds = ['seeded_before'];
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [10]);
  delete state.podProfileIds;
  state.podProfileCount = 8;
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [10]);
});

test('runChecks: item 14 — active identities must equal before + carried, per account type', () => {
  const state = matchingState();
  state.identityActive.platform_admin = 2;
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [14]);
  const other = matchingState();
  other.identityActive.tenant_admin = 3;
  assert.deepEqual(failing({ actualState: other }).map((c) => c.item), [14]);
});

test('runChecks: item 15 — known non-manifest tenants are not extras (D56); an unknown one is', () => {
  const state = matchingState();
  state.tenants['bench-cp1'] = {};
  state.tenants['slice-20260927'] = {};
  assert.deepEqual(failing({ actualState: state }), []);
  state.tenants['who-is-this'] = {};
  const failed = failing({ actualState: state });
  assert.deepEqual(failed.map((c) => c.item), [15]);
  assert.match(failed[0].actual, /who-is-this/);
});

test('runChecks: item 15 — a tenant of the plan missing from the target fails 15 and 4', () => {
  const state = matchingState();
  delete state.tenants['shop-b'];
  assert.deepEqual([...new Set(failing({ actualState: state }).map((c) => c.item))].sort((a, b) => a - b), [4, 15]);
});

test('runChecks: item 15 — status or published different from the plan fails', () => {
  const state = matchingState();
  state.tenants['shop-b'].status = 'active';
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [15]);
  const other = matchingState();
  other.tenants['shop-b'].published = true;
  assert.deepEqual(failing({ actualState: other }).map((c) => c.item), [15]);
});

test('runChecks: item 15 — features.pod must be explicit AND equal to the plan', () => {
  const state = matchingState();
  delete state.tenantFeaturesPod['shop-b'];
  assert.deepEqual(failing({ actualState: state }).map((c) => c.item), [15]);
  const other = matchingState();
  other.tenantFeaturesPod['shop-a'] = false;
  assert.deepEqual(failing({ actualState: other }).map((c) => c.item), [15]);
});

test('runChecks: item 17 — a bundle that does not verify fails', () => {
  assert.deepEqual(failing({ bundleVerified: false }).map((c) => c.item), [17]);
});

test('runChecks: a plan.json without an expected block fails every check that needs it', () => {
  const failedItems = [...new Set(failing({ planJson: { env: 'staging' } }).map((c) => c.item))].sort((a, b) => a - b);
  assert.deepEqual(failedItems, [4, 7, 10, 14, 15]);
});

test('the expected block import.mjs writes is what runChecks reads: a state built from the plan passes, a changed one fails', async () => {
  const base = tmpDir();
  try {
    const bundleDir = path.join(base, 'bundle');
    await buildFixtureBundle(bundleDir);
    const emailMapPath = path.join(base, 'e.json');
    writeFileSync(emailMapPath, JSON.stringify(FIXED_EMAIL_MAP));
    const result = runImport({ bundleDir, emailMapPath, env: 'staging' });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const expected = result.planJson.expected;
    assert.deepEqual(Object.keys(expected.tenants).sort(), ['test-shop-a', 'test-shop-b']);
    assert.deepEqual(expected.identity.carriedActive, { platform_admin: 2, tenant_admin: 1 });
    assert.deepEqual(expected.podProfileIds, ['apparel_dtg']);
    assert.equal(expected.screening.sourceTermCount, 4);
    assert.equal(expected.screening.terms.length, 3);
    assert.equal(expected.tenants['test-shop-a'].stripeAccountId, null, 'an unmapped live account never reaches staging');
    assert.equal(expected.tenants['test-shop-b'].status, 'suspended');
    // No address and no user id in plan.json.
    const asText = JSON.stringify(result.planJson);
    assert.ok(!/@example\.com/.test(asText));
    for (const uid of ['admin1', 'admin2', 'tenantadmin1', 'disabledadmin', 'printshopuser', 'o7diaDJ01tRoBMs8d5OK9bPunMg1']) {
      assert.ok(!asText.includes(uid), `plan.json must not name the user id ${uid}`);
    }

    const state = {
      identityActive: { ...expected.identity.carriedActive },
      platformSettings: { defaultCommissionBps: 500, refundApplicationFee: false, reverseDisputeOnCreated: true, reviewFirstProducts: 2, screeningHardBlock: false },
      podProfileIds: [...expected.podProfileIds],
      printDefaults: { defaultPrinterId: null },
      printers: [{ id: 'snapwear', status: 'inactive', type: 'api' }],
      tenantFeaturesPod: Object.fromEntries(Object.entries(expected.tenants).map(([id, t]) => [id, t.podEnabled])),
      tenants: Object.fromEntries(Object.entries(expected.tenants).map(([id, t]) => [id, { ...t }])),
      terms: [...expected.screening.terms],
    };
    assert.deepEqual(runChecks({ actualState: state, bundleVerified: true, env: 'staging', planJson: result.planJson }).checks.filter((c) => !c.ok), []);
    state.tenants['test-shop-a'].published = false;
    assert.deepEqual(runChecks({ actualState: state, bundleVerified: true, env: 'staging', planJson: result.planJson }).checks.filter((c) => !c.ok).map((c) => c.item), [15]);
  } finally {
    rmDir(base);
  }
});

test('KNOWN_NON_MANIFEST_TENANTS is exactly bench-cp1 and slice-20260927', () => {
  assert.deepEqual([...KNOWN_NON_MANIFEST_TENANTS].sort(), ['bench-cp1', 'slice-20260927']);
});

test('CP3_ITEMS is exactly 1,2,3,4,6,7,10,14,15,17', () => {
  assert.deepEqual(CP3_ITEMS, [1, 2, 3, 4, 6, 7, 10, 14, 15, 17]);
});
