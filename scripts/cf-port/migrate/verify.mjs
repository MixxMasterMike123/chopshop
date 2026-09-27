#!/usr/bin/env node
/**
 * scripts/cf-port/migrate/verify.mjs — result → PASS/FAIL list.
 *
 *   node scripts/cf-port/migrate/verify.mjs --env staging --bundle <dir>
 *        --plan <dir> --actual-state <file>
 *   node scripts/cf-port/migrate/verify.mjs --env staging --print-queries
 *
 * NEVER talks to D1. `--actual-state` is a JSON file a human produces AFTER
 * the apply from read-only queries (state-from-queries.mjs); `--print-queries`
 * prints those queries instead of running any check.
 *
 * TWO SIDES, NEVER ONE. What the target holds comes from `--actual-state`.
 * What it must hold comes from the plan (`plan.json` `expected`, written by
 * import.mjs from the rows it generated), from the manifest's fixed go-live
 * values, and from the bundle. No check compares a value of the state file
 * with another value of the same file.
 *
 * Checks the items of manifest section (e) that belong to CP3: 1, 2, 3, 4, 6,
 * 7, 10, 14, 15, 17. Prints each as PASS or FAIL with the two values compared,
 * and every other item as DEFERRED with the checkpoint it belongs to. Exit
 * code 0 only when nothing FAILs.
 *
 * Adjusted to the decisions: robowatz archived (D21), staging default printer
 * NULL (D66), snapwear inactive on staging (D59), known non-manifest tenants
 * `bench-cp1` and `slice-20260927` are expected extras (D56).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBundle } from './lib/verify-bundle.mjs';
import { bundleSha } from './lib/bundle-reader.mjs';
import { printQueries } from './state-from-queries.mjs';

const KNOWN_NON_MANIFEST_TENANTS = new Set(['bench-cp1', 'slice-20260927']); // D56

const CP3_ITEMS = [1, 2, 3, 4, 6, 7, 10, 14, 15, 17];
const ALL_ITEM_NAMES = {
  1: 'platform_settings.refund_application_fee = false',
  2: 'platform_settings.default_commission_bps = 500',
  3: 'platform_settings.reverse_dispute_on_created = true',
  4: 'per-tenant Connect facts, commission and VAT rate equal the plan',
  5: 'production Stripe webhook endpoint pinned (out of scope: no network)',
  6: 'routing: default_printer_id + printer_sku status',
  7: 'screening: terms, review_first_products, hard_block',
  8: 'POD mappings (deferred to CP4: podMappings/products)',
  9: 'POD artwork (deferred to CP4: podArtwork)',
  10: 'pod_profiles: every profile of the export is in the target (artwork/mapping resolution deferred to CP4)',
  11: 'legal (melodie-mc) readiness (deferred: needs tenant_settings + legal_acceptances joined with checkout — CP4)',
  12: 'catalogue predicate counts (deferred to CP4: products)',
  13: 'storage: no Firebase Storage host in any D1 text column (deferred: full storage copy is a later checkpoint; CP3 only checks its own written tables)',
  14: 'users: active identities = before the import + carried by the plan',
  15: 'tenants: status/published/features.pod equal the plan',
  16: 'translations 1365/1365/1364 (deferred: static JSON asset, D16, not a D1 check)',
  17: 'archive: the bundle verifies (every collection manifest, count + sha256)',
  18: 'orders/payment_events/checkouts/outbox_events all empty (deferred: CP4/production cutover gate)',
  19: 'LAUNCH_TODO items ☑ (deferred: manual checklist, out of scope for this tool)',
};

/** Manifest (e) 14, the production go-live figure. */
const PRODUCTION_ACTIVE_IDENTITIES = { platform_admin: 2, tenant_admin: 1 };
const CONNECT_FACTS = ['connectEnabled', 'stripeAccountId', 'chargesEnabled', 'payoutsEnabled', 'payoutDelayDays', 'commissionBps', 'vatRateBp'];

function die(message) {
  console.error(`VERIFY REFUSED: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { actualState: null, bundle: null, env: null, plan: null, printQueries: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env') out.env = argv[++i] ?? die('--env needs a value');
    else if (arg === '--bundle') out.bundle = argv[++i] ?? die('--bundle needs a value');
    else if (arg === '--plan') out.plan = argv[++i] ?? die('--plan needs a value');
    else if (arg === '--actual-state') out.actualState = argv[++i] ?? die('--actual-state needs a value');
    else if (arg === '--print-queries') out.printQueries = true;
    else die(`unknown argument ${arg}`);
  }
  return out;
}

function record(checks, item, name, ok, expected, actual, note = '') {
  checks.push({ actual, expected, item, name, note, ok: ok === true });
}

/**
 * Pure: every input is passed in.
 *   actualState     what the target holds (state-from-queries.mjs --kind actual)
 *   planJson        the applied plan's plan.json (its `expected` block)
 *   bundleVerified  the result of verifying the bundle the plan was built from
 *   env             'staging' | 'production'
 * A missing `expected` block fails every check that needs it: nothing passes
 * for want of something to compare with.
 */
function runChecks({ actualState, bundleVerified, env, planJson }) {
  const checks = [];
  const expected = planJson?.expected ?? null;
  const noExpected = 'plan.json has no "expected" block: rebuild the plan with this version of import.mjs';

  record(checks, 1, ALL_ITEM_NAMES[1], actualState.platformSettings?.refundApplicationFee === false, false, actualState.platformSettings?.refundApplicationFee);
  record(checks, 2, ALL_ITEM_NAMES[2], actualState.platformSettings?.defaultCommissionBps === 500, 500, actualState.platformSettings?.defaultCommissionBps);
  record(checks, 3, ALL_ITEM_NAMES[3], actualState.platformSettings?.reverseDisputeOnCreated === true, true, actualState.platformSettings?.reverseDisputeOnCreated);

  // Item 4: the Connect facts of every tenant the plan wrote. The Stripe API
  // confirmation of manifest (e) 4 needs the network and is out of scope.
  if (expected === null) {
    record(checks, 4, ALL_ITEM_NAMES[4], false, 'an expected block', null, noExpected);
  } else {
    const differing = [];
    for (const [tenantId, want] of Object.entries(expected.tenants)) {
      const got = actualState.tenants?.[tenantId];
      const fields = got === undefined ? ['(tenant missing)'] : CONNECT_FACTS.filter((f) => (got[f] ?? null) !== (want[f] ?? null));
      if (fields.length > 0) differing.push(`${tenantId}: ${fields.join('+')}`);
    }
    record(checks, 4, ALL_ITEM_NAMES[4], differing.length === 0, `${Object.keys(expected.tenants).length} tenant(s) equal to the plan`, differing.join('; ') || '(all equal)');
  }

  // Item 6: routing.
  const expectedDefaultPrinter = env === 'staging' ? null : 'snapwear'; // D66
  record(checks, 6, `${ALL_ITEM_NAMES[6]} (default_printer_id)`, actualState.printDefaults?.defaultPrinterId === expectedDefaultPrinter, expectedDefaultPrinter, actualState.printDefaults?.defaultPrinterId);
  const expectedSnapwearStatus = env === 'staging' ? 'inactive' : 'active'; // D59
  const snapwear = (actualState.printers ?? []).find((p) => p.id === 'snapwear');
  record(checks, 6, `${ALL_ITEM_NAMES[6]} (printers.snapwear.status)`, snapwear?.status === expectedSnapwearStatus, expectedSnapwearStatus, snapwear?.status ?? '(missing)');
  record(checks, 6, `${ALL_ITEM_NAMES[6]} (printers.snapwear.type)`, snapwear?.type === 'api', 'api', snapwear?.type ?? '(missing)');

  // Item 7: screening. Every term the plan wrote is in the target; into an
  // empty target (no --target-state) the target holds exactly those.
  if (expected === null) {
    record(checks, 7, `${ALL_ITEM_NAMES[7]} (terms)`, false, 'an expected block', null, noExpected);
  } else {
    const actualTerms = Array.isArray(actualState.terms) ? actualState.terms : [];
    const missing = expected.screening.terms.filter((term) => !actualTerms.includes(term));
    const exact = expected.targetStateGiven || actualTerms.length === expected.screening.terms.length;
    record(
      checks,
      7,
      `${ALL_ITEM_NAMES[7]} (terms)`,
      Array.isArray(actualState.terms) && missing.length === 0 && exact,
      `${expected.screening.terms.length} term(s) of the plan present${expected.targetStateGiven ? '' : ', and no other'}`,
      `${actualTerms.length} in the target, ${missing.length} of the plan missing`,
      `the source document lists ${expected.screening.sourceTermCount}; the plan writes one row per distinct normalised term`,
    );
  }
  record(checks, 7, `${ALL_ITEM_NAMES[7]} (review_first_products)`, actualState.platformSettings?.reviewFirstProducts === 2, 2, actualState.platformSettings?.reviewFirstProducts);
  record(checks, 7, `${ALL_ITEM_NAMES[7]} (hard_block)`, actualState.platformSettings?.screeningHardBlock === false, false, actualState.platformSettings?.screeningHardBlock);

  // Item 10: every profile id of the export is in the target.
  if (expected === null) {
    record(checks, 10, ALL_ITEM_NAMES[10], false, 'an expected block', null, noExpected);
  } else {
    const actualIds = Array.isArray(actualState.podProfileIds) ? actualState.podProfileIds : [];
    const missing = expected.podProfileIds.filter((id) => !actualIds.includes(id));
    record(checks, 10, ALL_ITEM_NAMES[10], Array.isArray(actualState.podProfileIds) && expected.podProfileIds.length > 0 && missing.length === 0, `${expected.podProfileIds.length} profile(s)`, missing.length === 0 ? `${actualIds.length} in the target, none missing` : `missing: ${missing.join(', ')}`);
  }

  // Item 14: active identities = those before the import + those the plan
  // carries. Without --target-state the importer assumed an empty target, so
  // "before" is 0. Production must also equal the manifest's figure.
  if (expected === null) {
    record(checks, 14, ALL_ITEM_NAMES[14], false, 'an expected block', null, noExpected);
  } else {
    const want = {};
    const got = {};
    for (const type of Object.keys(PRODUCTION_ACTIVE_IDENTITIES)) {
      want[type] = (expected.identity.baselineActive?.[type] ?? 0) + (expected.identity.carriedActive?.[type] ?? 0);
      got[type] = actualState.identityActive?.[type] ?? 0;
    }
    const equalsPlan = Object.keys(want).every((type) => want[type] === got[type]);
    const equalsManifest = env !== 'production' || Object.keys(want).every((type) => got[type] === PRODUCTION_ACTIVE_IDENTITIES[type]);
    record(
      checks,
      14,
      ALL_ITEM_NAMES[14],
      equalsPlan && equalsManifest,
      JSON.stringify(env === 'production' ? { ...want, manifest: PRODUCTION_ACTIVE_IDENTITIES } : want),
      JSON.stringify(got),
      expected.identity.baselineActive === null ? 'no --target-state was given to the import: 0 identities assumed before it' : '',
    );
  }

  // Item 15: tenants.
  if (expected === null) {
    record(checks, 15, `${ALL_ITEM_NAMES[15]}`, false, 'an expected block', null, noExpected);
  } else {
    const expectedIds = Object.keys(expected.tenants);
    const actualIds = Object.keys(actualState.tenants ?? {});
    const missing = expectedIds.filter((id) => !actualIds.includes(id));
    const extras = actualIds.filter((id) => !expectedIds.includes(id) && !KNOWN_NON_MANIFEST_TENANTS.has(id));
    record(
      checks,
      15,
      `${ALL_ITEM_NAMES[15]} (the tenants of the plan, and no unknown other)`,
      missing.length === 0 && extras.length === 0,
      expectedIds.join(', '),
      `missing: ${missing.join(', ') || 'none'}; unknown extras: ${extras.join(', ') || 'none'}`,
      `known non-manifest tenants are not extras: ${[...KNOWN_NON_MANIFEST_TENANTS].join(', ')} (D56)`,
    );
    const differing = [];
    for (const [tenantId, want] of Object.entries(expected.tenants)) {
      const got = actualState.tenants?.[tenantId];
      if (got === undefined) continue; // reported as missing above
      if (got.status !== want.status) differing.push(`${tenantId}: status ${got.status} (plan ${want.status})`);
      if (got.published !== want.published) differing.push(`${tenantId}: published ${got.published} (plan ${want.published})`);
    }
    record(checks, 15, `${ALL_ITEM_NAMES[15]} (status, published)`, missing.length === 0 && differing.length === 0, 'equal to the plan', differing.join('; ') || (missing.length === 0 ? '(all equal)' : '(tenants missing)'));
    const podDiffering = [];
    for (const [tenantId, want] of Object.entries(expected.tenants)) {
      const got = actualState.tenantFeaturesPod?.[tenantId];
      if (got === undefined) podDiffering.push(`${tenantId}: no explicit row`);
      else if (got !== want.podEnabled) podDiffering.push(`${tenantId}: ${got} (plan ${want.podEnabled})`);
    }
    record(checks, 15, `${ALL_ITEM_NAMES[15]} (features.pod explicit and equal)`, podDiffering.length === 0, 'an explicit pod row per tenant, equal to the plan', podDiffering.join('; ') || '(all equal)');
  }

  // Item 17: the bundle the plan was built from verifies, checked by this
  // run. The RETIRED.md listing of manifest (e) 17 is a manual step.
  record(checks, 17, ALL_ITEM_NAMES[17], bundleVerified === true, true, bundleVerified);

  const deferredItems = Object.keys(ALL_ITEM_NAMES)
    .map(Number)
    .filter((n) => !CP3_ITEMS.includes(n));

  return { checks, deferredItems };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.env !== 'staging' && args.env !== 'production') die('--env must be "staging" or "production"');
  if (args.printQueries) {
    printQueries('actual', args.env);
    return;
  }
  if (!args.bundle || !args.plan || !args.actualState) {
    die('--bundle, --plan and --actual-state are all required (or pass --print-queries)');
  }
  const planJsonPath = path.join(path.resolve(args.plan), 'plan.json');
  if (!existsSync(planJsonPath)) die(`no plan.json in ${path.resolve(args.plan)}`);
  const planJson = JSON.parse(readFileSync(planJsonPath, 'utf8'));
  if (planJson.env !== args.env) die(`the plan was built for ${planJson.env}, not ${args.env}`);
  if (planJson.bundleSha !== bundleSha(path.resolve(args.bundle))) die('the plan was not built from this bundle (bundle sha differs)');
  const actualState = JSON.parse(readFileSync(path.resolve(args.actualState), 'utf8'));
  const bundleVerified = verifyBundle(path.resolve(args.bundle)).ok === true;

  const { checks, deferredItems } = runChecks({ actualState, bundleVerified, env: args.env, planJson });

  for (const check of checks) {
    const label = check.ok ? 'PASS' : 'FAIL';
    console.log(`[${label}] #${check.item} ${check.name} — expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}${check.note ? ` (${check.note})` : ''}`);
  }
  for (const item of deferredItems) {
    console.log(`[DEFERRED] #${item} ${ALL_ITEM_NAMES[item]}`);
  }

  const ok = checks.every((c) => c.ok);
  console.log(ok ? '\nPASS: verify complete, nothing failed' : '\nFAIL: one or more checks failed');
  process.exitCode = ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

export { parseArgs, runChecks, KNOWN_NON_MANIFEST_TENANTS, CP3_ITEMS, ALL_ITEM_NAMES };
