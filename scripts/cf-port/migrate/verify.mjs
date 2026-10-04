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
 * (`bench-cp1`, `slice-20260927`, `slice-connect-20260927`) are expected extras (D56).
 *
 * CP7-T2 — THE GO-LIVE ITEMS, production only (staging prints the nine as
 * DEFERRED exactly as before). Each is decided from what the tool has by
 * design, or stays DEFERRED with its reason and the manual check named:
 *
 *   5   DEFERRED: the endpoints and their API version live at Stripe
 *   8   the `goLive` section of --actual-state: every POD mapping's artwork
 *       is in its own shop. DEFERRED: the garment and the quote (the Worker's
 *       409 reasons) of each mapped product — needs the Worker, and applies
 *       when POD goes on (decision 1.4)
 *   9   goLive: every mapped artwork `ready` with its print and preview keys
 *       and sha256 (the objects' presence in R2 is not read: no network)
 *   10  goLive, added to the CP3 check: every artwork's profile resolves
 *   11  goLive: melodie-mc's legal readiness (the Worker's three conditions
 *       and the current platform terms accepted). Not ready is DEFERRED, not
 *       FAIL: the manifest calls it expected until Kent's step (§6.6), and the
 *       Worker keeps checkout closed until then
 *   12  with --catalogue-plan and --catalogue-actual-state: verify-catalogue.mjs's
 *       own checks, run in process (one source of truth, never restated);
 *       without them DEFERRED to the final run
 *   13  goLive: no text column of any table (lib/schema-text-columns.mjs, every
 *       table of the migrations) names the source's storage, and every stored
 *       object is active with its sha256. DEFERRED: the public host's 200 and
 *       404 (HTTP)
 *   16  the three locale files built in memory from the bundle
 *       (build-locales.mjs buildLocaleTexts) equal src/locales/ byte for byte (§5.3)
 *   18  goLive: orders, payment_events, checkouts, outbox_events all 0
 *   19  with --final only: docs/SnapWearDocs/LAUNCH_TODO.md read with the
 *       preflight's own list and rule (lib/launch-gate.mjs); without --final
 *       DEFERRED to the final run
 *
 *   --final   the run before the switch (manifest P6, runbook §5.9): needs
 *             --catalogue-plan and --catalogue-actual-state, and decides 19.
 *             Refused on staging, as the catalogue options are.
 *
 * An item is PASS only on evidence: a missing goLive section FAILs every item
 * that needs it. Prints values, counts, tenant ids and reasons only.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBundle } from './lib/verify-bundle.mjs';
import { bundleSha } from './lib/bundle-reader.mjs';
import { launchGateStatus, launchRequiredItems, LAUNCH_TODO_FILE, PREFLIGHT_FILE } from './lib/launch-gate.mjs';
import { textColumnsByTable } from './lib/schema-text-columns.mjs';
import { loadWorkerRules } from './lib/worker-rules.mjs';
import { printQueries } from './state-from-queries.mjs';
import { runChecks as runCatalogueChecks } from './verify-catalogue.mjs';
import { buildLocaleTexts, DEFAULT_OUT as LOCALES_DIR } from '../build-locales.mjs';

// D56, plus the tenant of scripts/cf-port/connect-proof-staging.mjs.
const KNOWN_NON_MANIFEST_TENANTS = new Set(['bench-cp1', 'slice-20260927', 'slice-connect-20260927']);

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
  const out = { actualState: null, bundle: null, catalogueActualState: null, cataloguePlan: null, env: null, final: false, plan: null, printQueries: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env') out.env = argv[++i] ?? die('--env needs a value');
    else if (arg === '--final') out.final = true;
    else if (arg === '--catalogue-plan') out.cataloguePlan = argv[++i] ?? die('--catalogue-plan needs a value');
    else if (arg === '--catalogue-actual-state') out.catalogueActualState = argv[++i] ?? die('--catalogue-actual-state needs a value');
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
    // CP7-T2: production checks the artwork's profiles as a go-live item, so its name drops the deferral.
    record(checks, 10, env === 'production' ? 'pod_profiles: every profile of the export is in the target' : ALL_ITEM_NAMES[10], Array.isArray(actualState.podProfileIds) && expected.podProfileIds.length > 0 && missing.length === 0, `${expected.podProfileIds.length} profile(s)`, missing.length === 0 ? `${actualIds.length} in the target, none missing` : `missing: ${missing.join(', ')}`);
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

/** The legal tenant of manifest (e) 11. */
const LEGAL_TENANT = 'melodie-mc';
const NO_GO_LIVE = 'the actual state has no goLive section: collect every query of --print-queries actual --env production';

/**
 * CP7-T2: the go-live items (production). Pure: every input is passed in.
 *   actualState      with its `goLive` section (state-from-queries.mjs)
 *   schemaTables     the tables the text scan must cover (textColumnsByTable)
 *   locales          { language: { read, written, same } } (item 16)
 *   catalogueChecks  verify-catalogue.mjs runChecks' result, or null (item 12)
 *   launch           { notDone, duplicate, problem } or null (item 19, --final)
 *   final            the run before the switch
 * → { checks, deferred: [{ item, name, reason }] }
 */
function runGoLiveChecks({ actualState, catalogueChecks = null, final = false, launch = null, locales = null, schemaTables = [] }) {
  const checks = [];
  const deferred = [];
  const defer = (item, name, reason) => deferred.push({ item, name, reason });
  const goLive = actualState?.goLive ?? null;
  const counts = goLive?.counts ?? null;

  defer(5, 'the production Stripe webhook endpoints exist as pinned, on API version 2023-10-16', 'needs live Stripe. Manual: with ~/.config/chopshop/stripe.production.env in place, `scripts/cf-preflight.sh production --bootstrap -- whoami` prints "pinned Stripe webhook endpoint we_… exists: enabled -> <url>" for both pinned endpoints; the API version is read on each endpoint in the Dashboard');

  if (counts === null) {
    for (const [item, name] of [[8, 'POD mappings: every artwork in its own shop'], [9, 'POD artwork: every mapped artwork ready, with its print and preview'], [10, 'pod_profiles: every artwork\'s profile resolves'], [11, `legal readiness (${LEGAL_TENANT})`], [13, 'storage: no text column names the source\'s storage; every stored object active with sha256'], [18, 'orders, payment_events, checkouts, outbox_events all 0']]) {
      record(checks, item, name, false, 'the goLive section', null, NO_GO_LIVE);
    }
  } else {
    record(checks, 8, 'POD mappings: every artwork in its own shop', counts.pod_mappings_unresolved === 0, 0, `${counts.pod_mappings} mapping(s), ${counts.pod_mappings_unresolved} unresolved`,
      counts.pod_mappings === 0 ? 'no mapping: POD is off at go-live (decision 1.4); no tool imports POD mappings yet' : '');
    defer(8, 'the garment and the quote of every mapped POD product (no 409 block reason)', counts.pod_mappings === 0
      ? 'no mapping exists: this applies when POD goes on (decision 1.4; blockers 12, 13). Manual then: the Worker\'s quote of each mapped product of melodie-mc'
      : 'needs the Worker\'s quote. Manual: quote each mapped product of melodie-mc; none may answer no-printer-for-garment, routed-line-unpriced, pod-requires-connect or production-exceeds-gross');
    record(checks, 9, 'POD artwork: every mapped artwork ready, with its print and preview', counts.pod_mapped_artwork_not_ready === 0, 0, `${counts.pod_artwork} artwork(s), ${counts.pod_mapped_artwork_not_ready} mapped and not ready`,
      'the keys and sha256 are read; the objects\' presence in R2 is not (no network)');
    record(checks, 10, 'pod_profiles: every artwork\'s profile resolves', counts.pod_artwork_profile_unresolved === 0, 0, `${counts.pod_artwork} artwork(s), ${counts.pod_artwork_profile_unresolved} unresolved`);

    const legal = goLive.legal?.[LEGAL_TENANT];
    if (legal === undefined) {
      record(checks, 11, `legal readiness (${LEGAL_TENANT})`, false, `${LEGAL_TENANT} in the target`, '(tenant missing)');
    } else {
      const missing = [['returnAddress', 'return address'], ['vatAnswered', 'VAT answer'], ['legalPagesAccepted', 'legal pages adopted'], ['currentTermsAccepted', 'current platform terms accepted']]
        .filter(([key]) => legal[key] !== true)
        .map(([, label]) => label);
      if (missing.length === 0) record(checks, 11, `legal readiness (${LEGAL_TENANT})`, true, 'ready', 'ready');
      else defer(11, `legal readiness (${LEGAL_TENANT})`, `not ready — missing: ${missing.join(', ')}. Expected until Kent's step (§6.6); the Worker keeps the shop's checkout closed until then. Manual after §6.6: collect the go-live queries again, or GET /_api/v1/platform/tenants/${LEGAL_TENANT}`);
    }

    const scanned = Array.isArray(goLive.storageTexts?.scanned) ? goLive.storageTexts.scanned : [];
    const notScanned = schemaTables.filter((table) => !scanned.includes(table));
    const hits = goLive.storageTexts?.hits ?? {};
    record(checks, 13, 'storage: no text column of any table names the source\'s storage', schemaTables.length > 0 && notScanned.length === 0 && Object.keys(hits).length === 0,
      `0 rows in ${schemaTables.length} table(s)`, `rows: ${JSON.stringify(hits)}; tables not scanned: ${notScanned.join(', ') || 'none'}`);
    record(checks, 13, 'storage: every stored object active, with its sha256', counts.stored_objects_not_active_with_sha256 === 0, 0, `${counts.stored_objects} object(s), ${counts.stored_objects_not_active_with_sha256} not active with sha256`);
    record(checks, 18, 'orders, payment_events, checkouts, outbox_events all 0', ['orders', 'payment_events', 'checkouts', 'outbox_events'].every((key) => counts[key] === 0),
      '0, 0, 0, 0', `${counts.orders}, ${counts.payment_events}, ${counts.checkouts}, ${counts.outbox_events}`, 'as of the queries: collect them again right before checkout opens');
  }
  defer(13, 'storage: public objects answer 200 on the public host; private and production keys 404', 'needs HTTP reads. Manual: §7.2 (a private key answers 404 on the public host) and a sample of public objects answering 200; needs r2.publicBaseUrl (blocker 16)');

  if (catalogueChecks === null) {
    defer(12, 'catalogue: the public projection per shop, by verify-catalogue.mjs', 'decided after the catalogue: the final run (--final --catalogue-plan <dir> --catalogue-actual-state <file>, §5.9)');
  } else {
    const failed = catalogueChecks.filter((c) => !c.ok);
    record(checks, 12, 'catalogue: every check of verify-catalogue.mjs passes', catalogueChecks.length > 0 && failed.length === 0, `${catalogueChecks.length} check(s), none failing`,
      failed.length === 0 ? `${catalogueChecks.length} passing` : `${failed.length} failing: ${failed.map((c) => c.name).join('; ')}`);
  }

  if (locales === null) {
    record(checks, 16, 'translations: the locale files equal the build from this bundle', false, 'the build compared', null, 'the locale files were not built');
  } else {
    const entries = Object.entries(locales);
    record(checks, 16, 'translations: the locale files equal the build from this bundle', entries.length === 3 && entries.every(([, l]) => l.same === true), 'sv-SE, en-GB, en-US equal',
      entries.map(([language, l]) => `${language} read ${l.read}, written ${l.written}, ${l.same ? 'same' : 'DIFFERS'}`).join('; '), 'src/locales/ is what the storefront is built from (D16); the census read 1365 / 1365 / 1364');
  }

  if (!final) {
    defer(19, 'LAUNCH_TODO: every gated A and B item ☑', 'decided by the final run (--final, §5.9)');
  } else if (launch === null || launch.problem) {
    record(checks, 19, 'LAUNCH_TODO: every gated A and B item ☑', false, 'the checklist read', null, launch?.problem ?? 'the checklist was not read');
  } else {
    record(checks, 19, 'LAUNCH_TODO: every gated A and B item ☑', launch.duplicate === null && launch.notDone.length === 0, 'none open',
      launch.duplicate !== null ? `item ${launch.duplicate} appears twice` : `open: ${launch.notDone.join(', ') || 'none'}`, 'the preflight\'s list and rule (check 6); decision 1.3 may narrow the list there');
  }

  deferred.sort((a, b) => a.item - b.item);
  return { checks, deferred };
}

/** What --final and the catalogue options need, or the refusal (null when none). */
function finalArgsProblem(args) {
  const catalogue = args.cataloguePlan !== null || args.catalogueActualState !== null;
  if (args.env !== 'production' && (args.final || catalogue)) return '--final, --catalogue-plan and --catalogue-actual-state belong to --env production (the go-live verify)';
  if (catalogue && (args.cataloguePlan === null || args.catalogueActualState === null)) return '--catalogue-plan and --catalogue-actual-state go together';
  if (args.final && !catalogue) return '--final needs --catalogue-plan and --catalogue-actual-state (item 12, after the catalogue)';
  return null;
}

/** The inputs of runGoLiveChecks that main reads from disk (production). */
async function goLiveInputs(args, bundleDir) {
  let catalogueChecks = null;
  if (args.cataloguePlan !== null) {
    const planPath = path.join(path.resolve(args.cataloguePlan), 'plan.json');
    if (!existsSync(planPath)) die(`no plan.json in ${path.resolve(args.cataloguePlan)}`);
    const cataloguePlan = JSON.parse(readFileSync(planPath, 'utf8'));
    if (cataloguePlan.kind !== 'catalogue') die('--catalogue-plan is not a catalogue plan (import-catalogue.mjs)');
    if (cataloguePlan.env !== args.env) die(`the catalogue plan was built for ${cataloguePlan.env}, not ${args.env}`);
    if (cataloguePlan.bundleSha !== bundleSha(bundleDir)) die('the catalogue plan was not built from this bundle (bundle sha differs)');
    const catalogueState = JSON.parse(readFileSync(path.resolve(args.catalogueActualState), 'utf8'));
    catalogueChecks = runCatalogueChecks({ actualState: catalogueState, bundleVerified: verifyBundle(bundleDir).ok === true, planJson: cataloguePlan, rules: await loadWorkerRules() });
  }
  const locales = {};
  for (const [language, built] of Object.entries(await buildLocaleTexts({ bundleDir }))) {
    const file = path.join(LOCALES_DIR, `${language}.json`);
    locales[language] = { read: built.counts.read, same: existsSync(file) && readFileSync(file, 'utf8') === built.text, written: built.counts.written };
  }
  let launch = null;
  if (args.final) {
    try {
      launch = { ...launchGateStatus(readFileSync(LAUNCH_TODO_FILE, 'utf8'), launchRequiredItems(readFileSync(PREFLIGHT_FILE, 'utf8'))), problem: null };
    } catch (error) {
      launch = { duplicate: null, notDone: [], problem: error.message };
    }
  }
  return { catalogueChecks, launch, locales, schemaTables: Object.keys(textColumnsByTable()).sort() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.env !== 'staging' && args.env !== 'production') die('--env must be "staging" or "production"');
  const finalProblem = finalArgsProblem(args);
  if (finalProblem !== null) die(finalProblem);
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
  const goLive = args.env === 'production' ? runGoLiveChecks({ actualState, final: args.final, ...(await goLiveInputs(args, path.resolve(args.bundle))) }) : null;
  if (goLive !== null) checks.push(...goLive.checks);
  checks.sort((a, b) => a.item - b.item);

  for (const check of checks) {
    const label = check.ok ? 'PASS' : 'FAIL';
    console.log(`[${label}] #${check.item} ${check.name} — expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}${check.note ? ` (${check.note})` : ''}`);
  }
  if (goLive === null) {
    for (const item of deferredItems) {
      console.log(`[DEFERRED] #${item} ${ALL_ITEM_NAMES[item]}`);
    }
  } else {
    for (const entry of goLive.deferred) {
      console.log(`[DEFERRED] #${entry.item} ${entry.name} — ${entry.reason}`);
    }
  }

  const ok = checks.every((c) => c.ok);
  console.log(ok ? '\nPASS: verify complete, nothing failed' : '\nFAIL: one or more checks failed');
  if (goLive !== null) {
    const items = [...new Set(goLive.deferred.map((entry) => entry.item))];
    console.log(`${args.final ? 'FINAL run' : 'not the final run (--final, §5.9)'}: ${items.length} item(s) deferred, each with the check named on its line: ${items.map((n) => `#${n}`).join(', ')}`);
  }
  process.exitCode = ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`VERIFY REFUSED: ${error?.message ?? error}`);
    process.exit(1);
  });
}

export { parseArgs, runChecks, runGoLiveChecks, finalArgsProblem, KNOWN_NON_MANIFEST_TENANTS, CP3_ITEMS, ALL_ITEM_NAMES, LEGAL_TENANT };
