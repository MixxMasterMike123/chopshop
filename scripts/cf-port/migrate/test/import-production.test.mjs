/**
 * CP7-T2: import.mjs's production preconditions P1, P3, P4, P5
 * (lib/production-evidence.mjs). One test per refusal; every one runs on the
 * fixture bundle and invented evidence, offline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runImport } from '../import.mjs';
import { buildFixtureBundle, rmDir, tmpDir } from './fixtures.mjs';
import { connectEvidence, freezeEvidence, paymentsEvidence, productionOptions } from './production-fixtures.mjs';

const IMPORT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'import.mjs');

async function withProduction(fn, { bundle = {}, ...options } = {}) {
  const base = tmpDir();
  try {
    const bundleDir = path.join(base, 'bundle');
    await buildFixtureBundle(bundleDir, bundle);
    const production = await productionOptions(base, { fixture: bundle, ...options });
    await fn({ base, bundleDir, production });
  } finally {
    rmDir(base);
  }
}

function refused(result, pattern) {
  assert.equal(result.ok, false, 'the plan must be refused');
  assert.ok(result.problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got ${JSON.stringify(result.problems)}`);
}

test('production with every precondition met: the plan is built, and says where its Connect flags and its freeze proof come from', async () => {
  await withProduction(({ bundleDir, production }) => {
    const result = runImport({ bundleDir, env: 'production', ...production });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.ok(result.reportLines.some((l) => /^re-scan: the second export \(2026-09-27T00:10:00\.000Z\) equals the bundle/.test(l)));
    assert.ok(result.reportLines.some((l) => /^connect: the flags of 1 account\(s\) are taken from the live read of 2026-09-27T00:20:00\.000Z \(P5\)/.test(l)));
  });
});

// ── P1 ──────────────────────────────────────────────────────────────────────

test('P1: production without --confirm production is refused before anything else', async () => {
  await withProduction(({ bundleDir, production }) => {
    const result = runImport({ bundleDir, env: 'production', ...production, confirm: null, freezeEvidencePath: null });
    assert.deepEqual(result.problems, ['REFUSED: --env production needs --confirm production (the explicit confirmation of a production run)']);
    refused(runImport({ bundleDir, env: 'production', ...production, confirm: 'yes' }), /needs --confirm production/);
  });
});

test('P1: --confirm production on staging is refused', async () => {
  await withProduction(({ bundleDir }) => {
    refused(runImport({ bundleDir, confirm: 'production', env: 'staging', scrubUnmapped: true }), /^--confirm production belongs to --env production only$/);
  });
});

test('P1: production without --expect-tenants is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production, expectTenants: null }), /--expect-tenants <n> is required for --env production/);
    refused(runImport({ bundleDir, env: 'production', ...production, expectTenants: 0 }), /--expect-tenants <n> is required/);
  });
});

test('P1: a plan that writes another number of tenants than --expect-tenants is refused, naming them', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production, expectTenants: 5 }), /^REFUSED: the plan writes 2 tenant\(s\) \(test-shop-a, test-shop-b\), --expect-tenants says 5 \(P1\)$/);
  });
});

test('P1: on staging --expect-tenants is optional, and checked when given', async () => {
  await withProduction(({ bundleDir }) => {
    assert.equal(runImport({ bundleDir, env: 'staging', scrubUnmapped: true }).ok, true);
    assert.equal(runImport({ bundleDir, env: 'staging', expectTenants: 2, scrubUnmapped: true }).ok, true);
    refused(runImport({ bundleDir, env: 'staging', expectTenants: 3, scrubUnmapped: true }), /the plan writes 2 tenant\(s\)/);
  });
});

test('production is refused while the pinned stripeAccountId is null: the Stripe evidence has nothing to match', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production, pinned: { stripeAccountId: null } }), /stripeAccountId is null: the Stripe evidence cannot be tied to the pinned platform account/);
  });
});

// ── P3: the freeze evidence ─────────────────────────────────────────────────

test('P3: production without --freeze-evidence is refused; so is a file that is not freeze evidence', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production, freezeEvidencePath: null }), /--freeze-evidence is required for --env production/);
    refused(runImport({ bundleDir, env: 'production', ...production, freezeEvidencePath: production.paymentsEvidencePath }), /--freeze-evidence is not freeze evidence/);
  });
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /^REFUSED: --freeze-evidence is not JSON$/);
  }, { evidence: { freeze: '{ "evidence": "freeze", "frozenAt": "2026-09-26T22:30:00.000Z", secret: x' } });
});

test('P3: a freeze step that is not an ISO time is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /--freeze-evidence webhookDisabledAt is not an ISO time/);
  }, { evidence: { freeze: freezeEvidence({ webhookDisabledAt: 'yesterday' }) } });
});

test('P3: a freeze step after frozenAt is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /--freeze-evidence editsStoppedAt is after frozenAt/);
  }, { evidence: { freeze: freezeEvidence({ editsStoppedAt: '2026-09-26T23:00:00.000Z' }) } });
});

test('P3: a bundle exported before the freeze was complete is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /the bundle was exported at 2026-09-27T00:00:00\.000Z, not after the freeze was complete/);
  }, { evidence: { freeze: freezeEvidence({ editsStoppedAt: '2026-09-27T00:30:00.000Z', frozenAt: '2026-09-27T00:30:00.000Z' }) } });
});

test('P3: a carried document written after the freeze is refused (maxUpdateTimeSeen)', async () => {
  // The fixture's documents carry 2023-11-14T22:13:20Z; a freeze before that is contradicted by them.
  const early = { checkoutsStoppedAt: '2023-01-01T00:00:00.000Z', editsStoppedAt: '2023-01-01T00:00:00.000Z', frozenAt: '2023-01-01T00:00:00.000Z', schedulesPausedAt: '2023-01-01T00:00:00.000Z', webhookDisabledAt: '2023-01-01T00:00:00.000Z' };
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /^REFUSED: shops holds a document written at 2023-11-14T22:13:20\.000Z, after the freeze was complete/);
  }, { evidence: { freeze: freezeEvidence(early), payments: paymentsEvidence({ readAt: '2023-01-01T00:00:00.000Z' }) } });
});

// ── P3: the re-scan ─────────────────────────────────────────────────────────

test('P3: production without --rescan-bundle is refused; so is the bundle itself given as its re-scan', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production, rescanBundleDir: null }), /--rescan-bundle is required for --env production/);
    refused(runImport({ bundleDir, env: 'production', ...production, rescanBundleDir: bundleDir }), /--rescan-bundle is the bundle itself/);
  });
});

test('P3: a re-scan not exported after the bundle is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /--rescan-bundle was exported at 2026-09-26T23:00:00\.000Z, not after the bundle/);
  }, { rescanExportedAt: '2026-09-26T23:00:00.000Z' });
});

test('P3: a re-scan that does not verify is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    const part = path.join(production.rescanBundleDir, 'shops', readdirSync(path.join(production.rescanBundleDir, 'shops')).find((f) => f.endsWith('.jsonl')));
    appendFileSync(part, '\n');
    refused(runImport({ bundleDir, env: 'production', ...production }), /--rescan-bundle does not verify/);
  });
});

test('P3: a carried collection that differs between the two exports is refused, by name', async () => {
  const base = tmpDir();
  try {
    const bundleDir = path.join(base, 'bundle');
    await buildFixtureBundle(bundleDir);
    const production = await productionOptions(base, { fixture: { schemaPatch: (schema) => { schema.shops['test-shop-b'].data.name = 'Renamed after the export'; } } });
    refused(runImport({ bundleDir, env: 'production', ...production }), /^REFUSED: written between the two exports \(P3\): shops$/);
  } finally {
    rmDir(base);
  }
});

test('P3: an archive collection that differs is reported, not refused', async () => {
  const base = tmpDir();
  try {
    const bundleDir = path.join(base, 'bundle');
    await buildFixtureBundle(bundleDir);
    const production = await productionOptions(base, { fixture: { schemaPatch: (schema) => { schema.orders = { 'order-late': { data: { shopId: 'test-shop-a', status: 'paid' } } }; } } });
    const result = runImport({ bundleDir, env: 'production', ...production });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.ok(result.reportLines.includes('re-scan: archive collection(s) that differ between the two exports (not carried; read them by hand, §4.5): orders'));
  } finally {
    rmDir(base);
  }
});

test('P3: an Auth user that differs other than by its sign-in time is refused; a sign-in alone is reported', async () => {
  const user = (overrides) => ({ disabled: false, displayName: 'Test Admin One', email: 'admin1@example.com', emailVerified: true, metadata: { creationTime: '2025-01-01T00:00:00.000Z', lastSignInTime: null }, providerData: [], uid: 'admin1', ...overrides });
  const others = [
    { disabled: false, displayName: 'Test Admin Two', email: 'admin2@example.com', emailVerified: true, metadata: { creationTime: '2025-01-01T00:00:00.000Z', lastSignInTime: null }, providerData: [], uid: 'admin2' },
    { disabled: false, displayName: 'Shop Admin', email: 'tenantadmin1@example.com', emailVerified: true, metadata: { creationTime: '2025-01-01T00:00:00.000Z', lastSignInTime: null }, providerData: [], uid: 'tenantadmin1' },
  ];
  for (const [changed, expectRefused] of [[user({ disabled: true }), true], [user({ metadata: { creationTime: '2025-01-01T00:00:00.000Z', lastSignInTime: '2026-09-27T00:05:00.000Z' } }), false]]) {
    const base = tmpDir();
    try {
      const bundleDir = path.join(base, 'bundle');
      await buildFixtureBundle(bundleDir, { authUsers: [user({}), ...others] });
      const production = await productionOptions(base, { fixture: { authUsers: [changed, ...others] } });
      const result = runImport({ bundleDir, env: 'production', ...production });
      if (expectRefused) {
        refused(result, /^REFUSED: 1 Auth user\(s\) differ between the two exports other than by a sign-in time \(P3\)$/);
      } else {
        assert.equal(result.ok, true, JSON.stringify(result.problems));
        assert.ok(result.reportLines.includes('re-scan: 1 Auth user(s) signed in between the two exports (only the sign-in time differs)'));
      }
    } finally {
      rmDir(base);
    }
  }
});

// ── P4 ──────────────────────────────────────────────────────────────────────

test('P4: production without --payments-evidence is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production, paymentsEvidencePath: null }), /--payments-evidence is required for --env production/);
  });
});

test('P4: a payments read made before checkouts stopped is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /--payments-evidence was read at 2026-09-26T17:00:00\.000Z, before checkouts stopped/);
  }, { evidence: { payments: paymentsEvidence({ readAt: '2026-09-26T17:00:00.000Z' }) } });
});

test('P4: a payments read with the key of another account than the pinned one is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /--payments-evidence was read with the key of acct_someone_else, not the pinned platform account acct_platform_test/);
  }, { evidence: { payments: paymentsEvidence({ platformAccountId: 'acct_someone_else' }) } });
});

test('P4: a payments read that leaves out a state is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /openPaymentIntents must list every state/);
  }, { evidence: { payments: paymentsEvidence({ openPaymentIntents: { requires_action: [], requires_capture: [], requires_confirmation: [], requires_payment_method: [] } }) } });
});

test('P4: an open PaymentIntent in the evidence is refused, named by state and id', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /^REFUSED: open PaymentIntents at Stripe \(P4, §4\.4\): requires_capture 1 \(pi_still_open\)$/);
  }, { evidence: { payments: paymentsEvidence({ openPaymentIntents: { processing: [], requires_action: [], requires_capture: ['pi_still_open'], requires_confirmation: [], requires_payment_method: [] } }) } });
});

test('P4: a pending printer notification is refused, and the count must be a count', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /^REFUSED: 2 printer notification\(s\) pending in the source \(P4\)$/);
  }, { evidence: { payments: paymentsEvidence({ printNotificationsPending: 2 }) } });
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /printNotificationsPending must be a count/);
  }, { evidence: { payments: paymentsEvidence({ printNotificationsPending: '0' }) } });
});

test('P4: a checkout of the bundle that is not terminal is refused, unless its PaymentIntent is listed as terminal', async () => {
  const bundle = { schemaPatch: (schema) => { schema.checkouts = { pi_left_open: { data: { shopId: 'test-shop-a', status: 'reminded' } }, pi_done: { data: { shopId: 'test-shop-a', status: 'completed' } } }; } };
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /^REFUSED: 1 checkout\(s\) of the source are not terminal .* pi_left_open \(P4\)$/);
  }, { bundle });
  await withProduction(({ bundleDir, production }) => {
    assert.equal(runImport({ bundleDir, env: 'production', ...production }).ok, true);
  }, { bundle, evidence: { payments: paymentsEvidence({ terminalCheckouts: ['pi_left_open'] }) } });
});

// ── P5 ──────────────────────────────────────────────────────────────────────

test('P5: production without --connect-evidence is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production, connectEvidencePath: null }), /--connect-evidence is required for --env production/);
  });
});

test('P5: Connect facts read before the export are refused (re-pull, never carry)', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /--connect-evidence was read at 2026-09-26T23:59:00\.000Z, before the export \(2026-09-27T00:00:00\.000Z\)/);
  }, { evidence: { connect: connectEvidence({ readAt: '2026-09-26T23:59:00.000Z' }) } });
});

test('P5: Connect facts read under another platform account are refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /--connect-evidence was read with the key of acct_sandbox_platform, not the pinned platform account/);
  }, { evidence: { connect: connectEvidence({ platformAccountId: 'acct_sandbox_platform' }) } });
});

test('P5: an account in the evidence without its three booleans is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /accounts\.acct_live_test_a must hold chargesEnabled, payoutsEnabled and detailsSubmitted as booleans/);
  }, { evidence: { connect: connectEvidence({ accounts: { acct_live_test_a: { chargesEnabled: 'true', detailsSubmitted: true, payoutsEnabled: true } } }) } });
});

test('P5: a shop whose account is not in the evidence is refused', async () => {
  await withProduction(({ bundleDir, production }) => {
    refused(runImport({ bundleDir, env: 'production', ...production }), /^REFUSED: shops\/test-shop-a: its Connect account acct_live_test_a is not in --connect-evidence/);
  }, { evidence: { connect: connectEvidence({ accounts: { acct_other: { chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true } } }) } });
});

test('P5: the plan writes the live flags, not the source\'s, says so, and its run id changes with them', async () => {
  await withProduction(async ({ base, bundleDir, production }) => {
    const sameAsSource = runImport({ bundleDir, env: 'production', ...production });
    const live = await productionOptions(base, { evidence: { connect: connectEvidence({ accounts: { acct_live_test_a: { chargesEnabled: false, detailsSubmitted: true, payoutsEnabled: false } } }) } });
    const result = runImport({ bundleDir, env: 'production', ...live });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const tenant = result.planJson.expected.tenants['test-shop-a'];
    assert.equal(tenant.chargesEnabled, false);
    assert.equal(tenant.payoutsEnabled, false);
    assert.equal(tenant.stripeAccountId, 'acct_live_test_a');
    assert.ok(result.reportLines.includes('shops/test-shop-a: Connect flags from the live read differ from the source: chargesEnabled true → false, payoutsEnabled true → false (P5: the live ones are written)'));
    assert.notEqual(result.planJson.runId, sameAsSource.planJson.runId);
  });
});

// ── staging ─────────────────────────────────────────────────────────────────

test('staging refuses the four evidence options: it never reads live facts', async () => {
  await withProduction(({ bundleDir, production }) => {
    for (const [key, flag] of [['freezeEvidencePath', '--freeze-evidence'], ['rescanBundleDir', '--rescan-bundle'], ['paymentsEvidencePath', '--payments-evidence'], ['connectEvidencePath', '--connect-evidence']]) {
      refused(runImport({ bundleDir, env: 'staging', scrubUnmapped: true, [key]: production[key] }), new RegExp(`^${flag} belong\\(s\\) to --env production: staging never reads live facts \\(S3\\)$`));
    }
  });
});

// ── the CLI on the real pinned file ─────────────────────────────────────────

test('the CLI in production mode: refused without --confirm, without a usable --expect-tenants, and on the real pins (stripeAccountId null); nothing written', async () => {
  const base = tmpDir();
  try {
    const bundleDir = path.join(base, 'bundle');
    await buildFixtureBundle(bundleDir);
    const out = path.join(base, 'out');
    const run = (...extra) => spawnSync(process.execPath, [IMPORT, '--env', 'production', '--bundle', bundleDir, '--out', out, ...extra], { encoding: 'utf8', env: { HOME: base, PATH: process.env.PATH } });
    const unconfirmed = run();
    assert.equal(unconfirmed.status, 1);
    assert.match(unconfirmed.stdout, /! REFUSED: --env production needs --confirm production/);
    const badCount = run('--confirm', 'production', '--expect-tenants', 'four');
    assert.equal(badCount.status, 1);
    assert.match(badCount.stderr, /IMPORT REFUSED: --expect-tenants must be a positive whole number/);
    const pins = run('--confirm', 'production', '--expect-tenants', '2');
    assert.equal(pins.status, 1);
    assert.match(pins.stdout, /! REFUSED: cloudflare\/pinned\.production\.json stripeAccountId is null/);
    assert.match(pins.stdout, /! REFUSED: --freeze-evidence is required for --env production/);
    assert.equal(existsSync(out), false, 'nothing written');
  } finally {
    rmDir(base);
  }
});
