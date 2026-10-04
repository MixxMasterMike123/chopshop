/**
 * CP7-T2: verify.mjs's go-live items (manifest (e) 5, 8, 9, 11, 12, 13, 16,
 * 18, 19, and the rest of 10) — decided from the state, the plans, the bundle
 * and the repository, or DEFERRED with the reason and the manual check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalArgsProblem, runChecks, runGoLiveChecks } from '../verify.mjs';
import { runImport } from '../import.mjs';
import { buildFixtureBundle, rmDir, tmpDir } from './fixtures.mjs';
import { productionOptions } from './production-fixtures.mjs';

const VERIFY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'verify.mjs');
const TABLES = ['orders', 'products', 'tenants'];

function goLiveState(overrides = {}) {
  return {
    goLive: {
      counts: { checkouts: 0, orders: 0, outbox_events: 0, payment_events: 0, pod_artwork: 0, pod_artwork_profile_unresolved: 0, pod_mapped_artwork_not_ready: 0, pod_mappings: 0, pod_mappings_unresolved: 0, stored_objects: 524, stored_objects_not_active_with_sha256: 0, ...(overrides.counts ?? {}) },
      legal: { 'melodie-mc': { currentTermsAccepted: true, legalPagesAccepted: true, returnAddress: true, vatAnswered: true, ...(overrides.legal ?? {}) } },
      storageTexts: { hits: overrides.hits ?? {}, scanned: overrides.scanned ?? TABLES },
    },
  };
}

const LOCALES = { 'en-GB': { read: 1365, same: true, written: 1300 }, 'en-US': { read: 1364, same: true, written: 1299 }, 'sv-SE': { read: 1365, same: true, written: 1301 } };

function run(overrides = {}) {
  return runGoLiveChecks({
    actualState: goLiveState(overrides.state ?? {}),
    catalogueChecks: [{ name: 'public shop-a', ok: true }],
    final: true,
    launch: { duplicate: null, notDone: [], problem: null },
    locales: LOCALES,
    schemaTables: TABLES,
    ...overrides.args,
  });
}
const failedItems = (result) => [...new Set(result.checks.filter((c) => !c.ok).map((c) => c.item))];
const deferredItems = (result) => [...new Set(result.deferred.map((d) => d.item))];

test('a ready target, a passing catalogue, equal locale files and a done checklist: nothing fails; only the live checks stay deferred, each with its manual check', () => {
  const result = run();
  assert.deepEqual(failedItems(result), []);
  assert.deepEqual([...new Set(result.checks.map((c) => c.item))].sort((a, b) => a - b), [8, 9, 10, 11, 12, 13, 16, 18, 19]);
  assert.deepEqual(deferredItems(result), [5, 8, 13]);
  assert.match(result.deferred.find((d) => d.item === 5).reason, /needs live Stripe\. Manual: .*cf-preflight\.sh production --bootstrap -- whoami/);
  assert.match(result.deferred.find((d) => d.item === 8).reason, /no mapping exists: this applies when POD goes on/);
  assert.match(result.deferred.find((d) => d.item === 13).reason, /needs HTTP reads\. Manual: §7\.2/);
});

test('without a goLive section every item that needs it FAILs: nothing passes for want of evidence', () => {
  const result = runGoLiveChecks({ actualState: {}, catalogueChecks: [{ name: 'x', ok: true }], final: true, launch: { duplicate: null, notDone: [], problem: null }, locales: LOCALES, schemaTables: TABLES });
  assert.deepEqual(failedItems(result).sort((a, b) => a - b), [8, 9, 10, 11, 13, 18]);
  assert.ok(result.checks.filter((c) => !c.ok).every((c) => /no goLive section/.test(c.note)));
});

test('#18: an order, a payment event, a checkout or an outbox row fails', () => {
  for (const key of ['orders', 'payment_events', 'checkouts', 'outbox_events']) {
    assert.deepEqual(failedItems(run({ state: { counts: { [key]: 1 } } })), [18], key);
  }
});

test('#8, #9, #10: an unresolved mapping, a mapped artwork not ready, an artwork without its profile each fail their item; a mapping makes the quote a Worker check', () => {
  assert.deepEqual(failedItems(run({ state: { counts: { pod_mappings: 1, pod_mappings_unresolved: 1 } } })), [8]);
  assert.deepEqual(failedItems(run({ state: { counts: { pod_artwork: 1, pod_mapped_artwork_not_ready: 1 } } })), [9]);
  assert.deepEqual(failedItems(run({ state: { counts: { pod_artwork: 1, pod_artwork_profile_unresolved: 1 } } })), [10]);
  assert.match(run({ state: { counts: { pod_mappings: 3 } } }).deferred.find((d) => d.item === 8).reason, /^needs the Worker's quote/);
});

test('#11: melodie-mc not ready is DEFERRED with what is missing (expected until §6.6), never PASS; a missing melodie-mc FAILs', () => {
  const result = run({ state: { legal: { currentTermsAccepted: false, returnAddress: false } } });
  assert.deepEqual(failedItems(result), []);
  assert.ok(!result.checks.some((c) => c.item === 11));
  assert.match(result.deferred.find((d) => d.item === 11).reason, /^not ready — missing: return address, current platform terms accepted\. Expected until Kent's step \(§6\.6\)/);
  const state = goLiveState();
  delete state.goLive.legal['melodie-mc'];
  assert.deepEqual(failedItems(runGoLiveChecks({ actualState: state, final: false, locales: LOCALES, schemaTables: TABLES })), [11]);
});

test('#13: a text naming the source\'s storage fails; so does a table the scan did not cover, and an object not active with its sha256', () => {
  assert.deepEqual(failedItems(run({ state: { hits: { products: 2 } } })), [13]);
  assert.match(run({ state: { scanned: ['orders', 'tenants'] } }).checks.find((c) => c.item === 13 && !c.ok).actual, /tables not scanned: products/);
  assert.deepEqual(failedItems(run({ state: { counts: { stored_objects_not_active_with_sha256: 1 } } })), [13]);
  assert.deepEqual(failedItems(run({ args: { schemaTables: [] } })), [13], 'an empty schema list is no evidence');
});

test('#12: a failing check of verify-catalogue.mjs fails the item; without the catalogue inputs it waits for the final run', () => {
  const failing = run({ args: { catalogueChecks: [{ name: 'public shop-a', ok: true }, { name: 'storage shop-b', ok: false }] } });
  assert.deepEqual(failedItems(failing), [12]);
  assert.match(failing.checks.find((c) => c.item === 12).actual, /1 failing: storage shop-b/);
  assert.deepEqual(failedItems(run({ args: { catalogueChecks: [] } })), [12], 'no check at all is no evidence');
  const notYet = run({ args: { catalogueChecks: null, final: false } });
  assert.match(notYet.deferred.find((d) => d.item === 12).reason, /the final run \(--final --catalogue-plan/);
});

test('#16: a locale file that differs from the build fails', () => {
  assert.deepEqual(failedItems(run({ args: { locales: { ...LOCALES, 'sv-SE': { read: 1365, same: false, written: 1301 } } } })), [16]);
  assert.deepEqual(failedItems(run({ args: { locales: null } })), [16]);
});

test('#19: decided by the final run only — an open item, a duplicate or an unreadable checklist fails it', () => {
  assert.match(run({ args: { final: false } }).deferred.find((d) => d.item === 19).reason, /decided by the final run/);
  assert.match(run({ args: { launch: { duplicate: null, notDone: ['A6', 'B6'], problem: null } } }).checks.find((c) => c.item === 19).actual, /open: A6, B6/);
  assert.deepEqual(failedItems(run({ args: { launch: { duplicate: 'B3', notDone: [], problem: null } } })), [19]);
  assert.deepEqual(failedItems(run({ args: { launch: { duplicate: null, notDone: [], problem: 'cannot read' } } })), [19]);
});

test('--final and the catalogue options: production only, together, and --final needs them', () => {
  const args = (overrides) => ({ catalogueActualState: null, cataloguePlan: null, env: 'production', final: false, ...overrides });
  assert.equal(finalArgsProblem(args({})), null);
  assert.equal(finalArgsProblem(args({ catalogueActualState: 's', cataloguePlan: 'p', final: true })), null);
  assert.match(finalArgsProblem(args({ env: 'staging', final: true })), /belong to --env production/);
  assert.match(finalArgsProblem(args({ cataloguePlan: 'p', env: 'staging' })), /belong to --env production/);
  assert.match(finalArgsProblem(args({ cataloguePlan: 'p' })), /go together/);
  assert.match(finalArgsProblem(args({ final: true })), /--final needs --catalogue-plan and --catalogue-actual-state/);
});

test('the CLI: production prints the go-live items with their reasons; staging prints the nine DEFERRED lines as before; --final on staging is refused', async () => {
  const base = tmpDir();
  try {
    const bundleDir = path.join(base, 'bundle');
    await buildFixtureBundle(bundleDir);
    const production = await productionOptions(base);
    const result = runImport({ bundleDir, env: 'production', ...production });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const planDir = path.join(base, 'plan');
    mkdirSync(planDir);
    writeFileSync(path.join(planDir, 'plan.json'), JSON.stringify(result.planJson));
    const expected = result.planJson.expected;
    const state = {
      ...goLiveState({ scanned: [] }),
      identityActive: { platform_admin: 2, tenant_admin: 1 },
      platformSettings: { defaultCommissionBps: 500, refundApplicationFee: false, reverseDisputeOnCreated: true, reviewFirstProducts: 2, screeningHardBlock: false },
      podProfileIds: [...expected.podProfileIds],
      printDefaults: { defaultPrinterId: 'snapwear' },
      printers: [{ id: 'snapwear', status: 'active', type: 'api' }],
      tenantFeaturesPod: Object.fromEntries(Object.entries(expected.tenants).map(([id, t]) => [id, t.podEnabled])),
      tenants: Object.fromEntries(Object.entries(expected.tenants).map(([id, t]) => [id, { ...t }])),
      terms: [...expected.screening.terms],
    };
    const statePath = path.join(base, 'actual-state.json');
    writeFileSync(statePath, JSON.stringify(state));
    const cli = (...extra) => spawnSync(process.execPath, [VERIFY, '--bundle', bundleDir, '--plan', planDir, '--actual-state', statePath, ...extra], { encoding: 'utf8' });
    const out = cli('--env', 'production');
    assert.equal(out.status, 1, 'the fixture holds no translations and scans no table: #13 and #16 fail');
    assert.match(out.stdout, /^\[PASS\] #18 orders, payment_events, checkouts, outbox_events all 0/m);
    assert.match(out.stdout, /^\[FAIL\] #13 storage: no text column of any table names the source's storage .*tables not scanned: /m);
    assert.match(out.stdout, /^\[FAIL\] #16 translations: the locale files equal the build from this bundle .*sv-SE read 0, written 0, DIFFERS/m);
    assert.match(out.stdout, /^\[DEFERRED\] #5 .* — needs live Stripe\./m);
    assert.match(out.stdout, /^\[DEFERRED\] #19 .* — decided by the final run/m);
    assert.match(out.stdout, /not the final run \(--final, §5\.9\): \d item\(s\) deferred/);
    assert.ok(!out.stdout.includes('@example.com'), 'no address printed');

    const refusedFinal = cli('--env', 'staging', '--final');
    assert.equal(refusedFinal.status, 1);
    assert.match(refusedFinal.stderr, /VERIFY REFUSED: --final, --catalogue-plan and --catalogue-actual-state belong to --env production/);
    const noCatalogue = cli('--env', 'production', '--final');
    assert.match(noCatalogue.stderr, /VERIFY REFUSED: --final needs --catalogue-plan and --catalogue-actual-state/);
    const wrongKind = cli('--env', 'production', '--final', '--catalogue-plan', planDir, '--catalogue-actual-state', statePath);
    assert.match(wrongKind.stderr, /VERIFY REFUSED: --catalogue-plan is not a catalogue plan/);
  } finally {
    rmDir(base);
  }
});

test('staging is untouched: runChecks still checks the CP3 items only and defers the same nine', () => {
  const { deferredItems: deferred } = runChecks({ actualState: {}, bundleVerified: true, env: 'staging', planJson: {} });
  assert.deepEqual(deferred, [5, 8, 9, 11, 12, 13, 16, 18, 19]);
});
