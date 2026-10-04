/**
 * scripts/cf-port/migrate/test/production-fixtures.mjs — CP7-T2: the evidence
 * a production plan needs (lib/production-evidence.mjs), for the fixture
 * bundle (a helper, not a test file). All of it invented: the platform account
 * `acct_platform_test`, the fixture's live account `acct_live_test_a`, times
 * around the fixture's exportedAt (2026-09-27T00:00:00.000Z).
 */

import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildFixtureBundle } from './fixtures.mjs';

export const PLATFORM_ACCOUNT = 'acct_platform_test';
export const PINNED = Object.freeze({ stripeAccountId: PLATFORM_ACCOUNT });

export function freezeEvidence(overrides = {}) {
  return {
    checkoutsStoppedAt: '2026-09-26T18:00:00.000Z',
    editsStoppedAt: '2026-09-26T22:00:00.000Z',
    evidence: 'freeze',
    frozenAt: '2026-09-26T22:30:00.000Z',
    schedulesPausedAt: '2026-09-26T21:00:00.000Z',
    webhookDisabledAt: '2026-09-26T21:30:00.000Z',
    ...overrides,
  };
}

export function paymentsEvidence(overrides = {}) {
  return {
    evidence: 'open-payments',
    openPaymentIntents: { processing: [], requires_action: [], requires_capture: [], requires_confirmation: [], requires_payment_method: [] },
    platformAccountId: PLATFORM_ACCOUNT,
    printNotificationsPending: 0,
    readAt: '2026-09-26T21:15:00.000Z',
    terminalCheckouts: [],
    ...overrides,
  };
}

export function connectEvidence(overrides = {}) {
  return {
    accounts: { acct_live_test_a: { chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true } },
    evidence: 'connect-facts',
    platformAccountId: PLATFORM_ACCOUNT,
    readAt: '2026-09-27T00:20:00.000Z',
    ...overrides,
  };
}

/**
 * Writes the three evidence files and builds the re-scan bundle (the same
 * schema, exported ten minutes later; `buildRescan(dir, exportedAt)` for another
 * fixture than fixtures.mjs's) under `base`. → the production options
 * of runImport, every one present; `evidence` replaces a file's content.
 */
export async function productionOptions(base, { buildRescan = null, evidence = {}, fixture = {}, rescanExportedAt = '2026-09-27T00:10:00.000Z' } = {}) {
  const write = (name, value) => {
    const file = path.join(base, name);
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  // Built once per `base`: a second call (other evidence) reuses it.
  const rescanBundleDir = path.join(base, 'rescan');
  if (!existsSync(rescanBundleDir)) {
    if (buildRescan !== null) await buildRescan(rescanBundleDir, rescanExportedAt);
    else await buildFixtureBundle(rescanBundleDir, { ...fixture, exportedAt: rescanExportedAt });
  }
  return {
    confirm: 'production',
    connectEvidencePath: write('connect-facts.json', evidence.connect ?? connectEvidence()),
    expectTenants: 2,
    freezeEvidencePath: write('freeze-evidence.json', evidence.freeze ?? freezeEvidence()),
    paymentsEvidencePath: write('open-payments.json', evidence.payments ?? paymentsEvidence()),
    pinned: PINNED,
    rescanBundleDir,
  };
}
