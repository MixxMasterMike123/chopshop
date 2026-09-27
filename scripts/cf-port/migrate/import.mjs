#!/usr/bin/env node
/**
 * scripts/cf-port/migrate/import.mjs — CP3: bundle → plan. Reads an export
 * bundle (scripts/cf-port/migrate/export.mjs output) and writes, into --out
 * (outside the repo, dir 0700 / files 0600): plan.sql, plan.json, apply.md.
 *
 *   node scripts/cf-port/migrate/import.mjs --env staging --bundle <dir> --out <dir>
 *        [--email-map <file>] [--scrub-unmapped] [--connect-map <file>]
 *        [--target-state <file>] [--commission-default-for <shopId>]...
 *
 * NEVER talks to D1, Cloudflare, R2, Stripe, Google or Firebase. Reads only
 * local files (the bundle, the optional map/state files) and writes only
 * local files (--out).
 *
 * Rows handled (manifest row numbers, per docs/cf-port/CP3_GAP_ANALYSIS.md
 * §3.1 as corrected by DECISIONS.md D53/D72/D16):
 *   12 auditLogs, 45 printerCatalog, 46 printers, 56 shops, 62 users,
 *   65 shops legalAcceptances subcollection, 67 settings/platform,
 *   68 settings/app (assert absent), 69 settings/printRouting,
 *   70 settings/podProfiles, 72 settings/contentScreening.
 *
 * Rows explicitly DEFERRED (D53 moved podArtwork/podMappings/products to CP4,
 * D72 moved infringementReports to CP4, D16 makes translations a static file
 * not a D1 import; collections is CP4; pages is CP4; pod3dModels is CP6;
 * podMockupTemplates is CP6): each prints a reason and writes ZERO statements.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBundle, EXPECTED_SCHEMA_VERSION } from './lib/verify-bundle.mjs';
import { readCollection, readAuthUsers, readSettingsDocs, readSubcollection, bundleSha, readRootManifest } from './lib/bundle-reader.mjs';
import { emailMapFor, normalizeConnectMap, resolveConnectFacts, scrubOptionsProblem } from './lib/scrub.mjs';
import { buildPlanSql, sha256Hex } from './lib/plan.mjs';
import { writeFileSecure, ensureDir } from './lib/bundle-writer.mjs';
import { isInsideRepo } from './lib/outside-repo.mjs';
import { canonicalStringify } from './lib/typed-json.mjs';
import { planSafetyProblems } from './lib/plan-checks.mjs';

import { transformShop, ARCHIVED_SHOP_IDS } from './lib/transform-shops.mjs';
import { joinUsersToAuth, transformUser, hasActivePlatformAdminAfterImport } from './lib/transform-users.mjs';
import { transformSnapwearPrinter, SNAPWEAR_PRINTER_ID } from './lib/transform-printers.mjs';
import { transformPrintDefaults } from './lib/transform-print-defaults.mjs';
import { transformPodProfiles } from './lib/transform-pod-profiles.mjs';
import { transformContentScreening } from './lib/transform-screening.mjs';
import { transformPlatformSettings, assertSettingsAppAbsent } from './lib/transform-platform-settings.mjs';
import { transformLegalAcceptance } from './lib/transform-legal-acceptances.mjs';
import { transformAuditLog } from './lib/transform-audit-logs.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const IMPORTER_SCHEMA_VERSION = EXPECTED_SCHEMA_VERSION;

/** Rows this importer explicitly defers (manifest row number → reason). */
export const DEFERRED_ROWS = {
  20: 'collections → CP4 (products land in the same checkpoint)',
  33: 'infringementReports → CP4 (D72: a report FKs to a product, and products import in CP4)',
  40: 'pages → CP4',
  42: 'pod3dModels → CP6',
  43: 'podArtwork → CP4 (D53: moved with products + mappings, one dependency chain)',
  44: 'podMappings → CP4 (D53, same dependency chain as podArtwork)',
  51: 'products → CP4',
  58: 'translations_en_GB → rebuilt as a static JSON asset (D16), not a D1 import',
  59: 'translations_en_US → rebuilt as a static JSON asset (D16), not a D1 import',
  60: 'translations_sv_SE → rebuilt as a static JSON asset (D16), not a D1 import',
  71: 'settings/podMockupTemplates → CP6',
};
/** Target tables named by the deferred rows, for the "no statement names
 * these tables" test (a defence-in-depth check independent of the reason
 * strings above). */
export const DEFERRED_TARGET_TABLES = [
  'collections',
  'collection_products',
  'infringement_reports',
  'pages',
  'pod_3d_models',
  'pod_artwork',
  'pod_mappings',
  'products',
  'product_variants',
  'translations',
  'pod_mockup_templates',
];

function die(message) {
  console.error(`IMPORT REFUSED: ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function parseArgs(argv) {
  const out = { bundle: null, commissionDefaultFor: [], connectMap: null, emailMap: null, env: null, out: null, scrubUnmapped: false, targetState: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env') out.env = argv[++i] ?? die('--env needs a value');
    else if (arg === '--bundle') out.bundle = argv[++i] ?? die('--bundle needs a value');
    else if (arg === '--out') out.out = argv[++i] ?? die('--out needs a value');
    else if (arg === '--email-map') out.emailMap = argv[++i] ?? die('--email-map needs a value');
    else if (arg === '--scrub-unmapped') out.scrubUnmapped = true;
    else if (arg === '--connect-map') out.connectMap = argv[++i] ?? die('--connect-map needs a value');
    else if (arg === '--target-state') out.targetState = argv[++i] ?? die('--target-state needs a value');
    else if (arg === '--commission-default-for') out.commissionDefaultFor.push(argv[++i] ?? die('--commission-default-for needs a shop id'));
    else die(`unknown argument ${arg}`);
  }
  if (out.env !== 'staging' && out.env !== 'production') die('--env must be "staging" or "production"');
  if (!out.bundle) die('--bundle is required');
  if (!out.out) die('--out is required');
  return out;
}

/** Refuses an --out path that resolves inside the repo root (lib/outside-repo.mjs). */
function assertOutsideRepo(resolvedOutDir) {
  if (isInsideRepo(resolvedOutDir, REPO_ROOT)) {
    die(`--out ${resolvedOutDir} resolves inside the repo root (${REPO_ROOT}); the plan must be written OUTSIDE the repo`);
  }
}

function readJsonFileOrNull(filePath) {
  if (filePath === null) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Parses an optional --target-state JSON file into the shape the transform
 * modules expect. Absent = "assume an empty target" (loudly noted in report). */
function parseTargetState(raw) {
  if (raw === null) return null;
  const emails = new Map(Object.entries(raw.users?.emailToId ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const tenantIds = new Set(raw.tenants?.ids ?? []);
  const hostnames = new Set(raw.hostnames ?? []);
  const podProfileIds = new Map(Object.entries(raw.podProfiles ?? {}));
  const activePlatformAdminCount = typeof raw.users?.activePlatformAdminCount === 'number' ? raw.users.activePlatformAdminCount : 0;
  // Active identities per account type before the import (verify.mjs adds
  // what this plan carries to it). Absent in an older state file: unknown.
  const activeCounts = typeof raw.users?.activeCounts === 'object' && raw.users.activeCounts !== null ? raw.users.activeCounts : null;
  return { activeCounts, activePlatformAdminCount, emails, hostnames, podProfileIds, tenantIds };
}

/**
 * The core import routine, fully separated from process.argv / process.exit
 * so it is testable directly. Returns { ok, sections, report, problems,
 * planText, planSha, planJson, applyMdText } without writing anything unless
 * `write` is true (defaults to true for the CLI, false for tests that only
 * want the computed plan).
 */
export function runImport({ bundleDir, commissionDefaultFor = [], connectMapPath = null, emailMapPath = null, env, now = null, scrubUnmapped = false, targetStatePath = null }) {
  try {
    return runImportUnsafe({ bundleDir, commissionDefaultFor, connectMapPath, emailMapPath, env, now, scrubUnmapped, targetStatePath });
  } catch (error) {
    // A refusal raised deep inside a transform (e.g. UnmappedEmailError) is a
    // REFUSAL, not a crash: surface it through the same { ok:false, problems }
    // shape every other refusal uses, so a caller never has to special-case
    // "throws" vs "returns not ok".
    return { ok: false, problems: [error.message ?? String(error)] };
  }
}

function runImportUnsafe({ bundleDir, commissionDefaultFor, connectMapPath, emailMapPath, env, now, scrubUnmapped, targetStatePath }) {
  const problems = [];
  const reportLines = [];

  // C2: verify the bundle first.
  const verify = verifyBundle(bundleDir);
  if (!verify.ok) {
    return { ok: false, problems: ['bundle verification failed', ...verify.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)] };
  }
  const rootManifest = readRootManifest(bundleDir);
  if (rootManifest.schemaVersion !== IMPORTER_SCHEMA_VERSION) {
    return { ok: false, problems: [`bundle schemaVersion ${rootManifest.schemaVersion} is not the importer's expected version ${IMPORTER_SCHEMA_VERSION}`] };
  }

  const scrubProblem = scrubOptionsProblem(env, { emailMapGiven: emailMapPath !== null, scrubUnmapped });
  if (scrubProblem !== null) {
    return { ok: false, problems: [scrubProblem] };
  }
  const emailMapRaw = emailMapPath === null ? {} : readJsonFileOrNull(emailMapPath);
  const emailMap = emailMapFor(env, emailMapRaw);
  const connectMapRaw = connectMapPath === null ? {} : readJsonFileOrNull(connectMapPath);
  const connectMap = normalizeConnectMap(connectMapRaw);
  const targetStateRaw = targetStatePath === null ? null : readJsonFileOrNull(targetStatePath);
  const targetState = parseTargetState(targetStateRaw);
  if (targetState === null) {
    reportLines.push('no --target-state given: the plan assumes an EMPTY target (every collision check, adoption and profile-conflict check is skipped)');
  }

  // Review round 1, fix 3: THE PLAN'S CLOCK IS THE BUNDLE'S OWN exportedAt,
  // never the wall clock — lib/plan.mjs's own header already said so; this
  // is the fix that makes import.mjs actually do it. The same bundle run
  // through import.mjs at two different real times must produce the exact
  // same plan.sql. `now` is an OPTIONAL override (used only by tests that
  // want to inject a specific clock instead of the bundle's own timestamp)
  // and defaults to null; the CLI never passes it, so every real invocation
  // is deterministic from the bundle and the options alone.
  const nowDate = typeof now === 'function' ? now() : new Date(rootManifest.exportedAt);
  if (Number.isNaN(nowDate.getTime())) {
    return { ok: false, problems: ['the bundle manifest has no usable exportedAt: the plan has no clock'] };
  }
  const nowIso = nowDate.toISOString();
  const nowMillis = nowDate.getTime();
  const bSha = bundleSha(bundleDir);
  // The run id is deterministic: env + bundle sha + a hash of every option
  // that can change the plan's CONTENT (the email map, the connect map,
  // --scrub-unmapped, the target state) — never the wall clock. Two
  // independent runs with the same bundle and the same options therefore
  // produce the identical run id and hence a byte-identical plan.sql; a
  // changed option changes the run id (and the plan).
  const optionsFingerprint = sha256Hex(
    canonicalStringify({
      commissionDefaultFor: [...commissionDefaultFor].sort(),
      connectMap: connectMapRaw ?? {},
      emailMap: emailMapRaw ?? {},
      scrubUnmapped,
      targetState: targetStateRaw ?? {},
    }),
  );
  const runId = `import_${env}_${bSha.slice(0, 16)}_${optionsFingerprint.slice(0, 16)}`;

  const sections = [];
  const counts = {};

  function addSection(name, rows) {
    sections.push({ name, rows });
    counts[name] = rows.length;
  }

  // ── row 56: shops → tenants/tenant_domains/tenant_settings/tenant_features ──
  const shopDocs = readCollection(bundleDir, 'shops');
  const shopRows = [];
  const importedTenantIds = [];
  const expectedTenants = {};
  for (const doc of shopDocs) {
    if (ARCHIVED_SHOP_IDS.has(doc.id)) {
      reportLines.push(`shops/${doc.id}: D21 — archived, not imported`);
      continue;
    }
    const sourceStripeAccountId = doc.data?.payments?.stripeAccountId ?? null;
    const connectEnabled = doc.data?.payments?.connectEnabled === true;
    const connectFacts = {
      chargesEnabled: doc.data?.payments?.chargesEnabled === true,
      connectEnabled,
      detailsSubmitted: doc.data?.payments?.detailsSubmitted === true,
      disabledReason: null,
      payoutDelayDays: typeof doc.data?.payments?.payoutDelayDays === 'number' ? doc.data.payments.payoutDelayDays : null,
      payoutsEnabled: doc.data?.payments?.payoutsEnabled === true,
      requirementsDueJson: null,
      stripeAccountId: sourceStripeAccountId,
    };
    const resolvedConnect = resolveConnectFacts(connectFacts, connectMap, env);
    const result = transformShop({
      acceptCommissionDefault: commissionDefaultFor.includes(doc.id),
      connectFacts: { ...connectFacts, ...resolvedConnect },
      doc,
      emailMap,
      env,
      nowMillis,
      scrubUnmapped,
      targetState,
    });
    if (result.skipped === 'collision') {
      problems.push(`shops/${doc.id}: collision — ${result.report.collisions.join('; ')}`);
      continue;
    }
    for (const line of result.report.lines ?? []) reportLines.push(`shops/${doc.id}: ${line}`);
    for (const refusal of result.report.refusals ?? []) problems.push(`REFUSED: shops/${doc.id}: ${refusal}`);
    shopRows.push(...result.rows);
    importedTenantIds.push(doc.id);
    expectedTenants[doc.id] = result.report.expected;
  }
  for (const shopId of commissionDefaultFor) {
    if (!importedTenantIds.includes(shopId)) {
      problems.push(`REFUSED: --commission-default-for ${shopId}: no such shop is imported by this plan`);
    } else if (!reportLines.some((l) => l.startsWith(`shops/${shopId}: payments.commissionBps is `))) {
      problems.push(`REFUSED: --commission-default-for ${shopId}: that shop's commission needs no acceptance`);
    }
  }
  addSection('tenants+tenant_domains+tenant_settings+tenant_features', shopRows);

  // Fix 6: the set of tenant ids a tenant-admin membership may point at —
  // this plan's own imported shops, plus whatever --target-state already
  // has (a shop this run does not touch but that already exists).
  const knownTenantIds = new Set([...importedTenantIds, ...(targetState?.tenantIds ?? [])]);

  // ── row 62: users → user/account/identity_access/tenant_memberships/legacy_id_map ──
  const userDocs = readCollection(bundleDir, 'users');
  const authUsers = readAuthUsers(bundleDir);
  const { authOnlyCount, joined, mismatchedEmails } = joinUsersToAuth(userDocs, authUsers);
  reportLines.push(`users: ${authOnlyCount} Auth user(s) with no matching users/ document (not carried)`);
  if (mismatchedEmails.length > 0) {
    reportLines.push(`users: ${mismatchedEmails.length} document(s) where the Auth email differs from the users doc email (Auth email wins, D11) — counts only, no ids`);
  }

  const userRows = [];
  const legacyIdMap = {}; // legacyUid -> newUserId, for later sections (a plain object, not a Map: see the no-write-calls scan note on the transform modules for why)
  const userTransforms = [];
  let notCarriedCount = 0;
  let membershipSkippedCount = 0;
  for (const { authUser, uid, userDoc } of joined) {
    const result = transformUser({ authUser, emailMap, env, knownTenantIds, nowMillis, scrubUnmapped, targetState, uid, userDoc });
    userTransforms.push(result);
    if (!result.carried) {
      notCarriedCount += 1;
      continue;
    }
    userRows.push(...result.rows);
    legacyIdMap[uid] = result.report.newUserId;
    if (result.report.membershipSkippedUnknownTenant) membershipSkippedCount += 1;
  }
  reportLines.push(`users: ${notCarriedCount} document(s) not carried (D12 print_shop, or role/platform/shopId combination not carried)`);
  if (membershipSkippedCount > 0) {
    reportLines.push(`users: ${membershipSkippedCount} tenant-admin membership(s) skipped — the user's own shop is neither imported by this plan nor in --target-state (fix 6); the user was still carried`);
  }

  const targetActiveAdmins = targetState?.activePlatformAdminCount ?? 0;
  if (!hasActivePlatformAdminAfterImport(userTransforms, targetActiveAdmins)) {
    problems.push('REFUSED: after this import, no active platform_admin would exist (neither carried nor in --target-state)');
  }
  addSection('user+account+identity_access+tenant_memberships+legacy_id_map', userRows);

  // ── row 65: shops/*/legalAcceptances → legal_acceptances ──
  const legalAcceptanceDocs = readSubcollection(bundleDir, 'shops__legalAcceptances');
  const legalRows = [];
  const scanExemptLiterals = [];
  for (const doc of legalAcceptanceDocs) {
    const result = transformLegalAcceptance({ doc, emailMap, legacyIdMap, nowMillis, scrubUnmapped });
    for (const p of result.problems) problems.push(`legalAcceptances(${doc.path}): ${p}`);
    legalRows.push(...result.rows);
    scanExemptLiterals.push(...(result.scanExemptLiterals ?? []));
  }
  addSection('legal_acceptances', legalRows);

  // ── row 12: auditLogs → audit_events ──
  const auditLogDocs = readCollection(bundleDir, 'auditLogs');
  const auditRows = [];
  for (const doc of auditLogDocs) {
    const { rows } = transformAuditLog({ doc, legacyIdMap, nowMillis });
    auditRows.push(...rows);
  }
  addSection('audit_events', auditRows);

  // ── settings/* (rows 67-72) ──
  const settingsDocs = readSettingsDocs(bundleDir);

  // row 67 + 68
  const platformResult = transformPlatformSettings({ nowMillis, platformDoc: settingsDocs.platform?.data ?? null });
  for (const p of platformResult.problems) reportLines.push(`settings/platform: ${p}`);
  const appAssertion = assertSettingsAppAbsent({ appDoc: settingsDocs.app ?? null });
  if (!appAssertion.ok) problems.push(`settings/app: ${appAssertion.problem}`);

  // row 45 + 46: printerCatalog + printers (snapwear only, D12)
  const printerDocs = readCollection(bundleDir, 'printers');
  const catalogDocs = readCollection(bundleDir, 'printerCatalog');
  const snapwearPrinterDoc = printerDocs.find((d) => d.id === SNAPWEAR_PRINTER_ID) ?? null;
  const snapwearCatalogDoc = catalogDocs.find((d) => d.id === SNAPWEAR_PRINTER_ID) ?? null;
  const otherPrinterIds = printerDocs.filter((d) => d.id !== SNAPWEAR_PRINTER_ID).map((d) => d.id);
  if (otherPrinterIds.length > 0) {
    // Counted, never listed: these printer ids are user ids (fix 4).
    reportLines.push(`printers: D12 — ${otherPrinterIds.length} uid-keyed legacy print-shop printer(s) archived, not imported`);
  }
  const printerResult = transformSnapwearPrinter({ catalogDoc: snapwearCatalogDoc, env, nowMillis, printerDoc: snapwearPrinterDoc });
  for (const p of printerResult.problems) problems.push(`printers/snapwear: ${p}`);
  addSection('printers+printer_sku_tiers+printer_catalog', printerResult.rows);

  // row 69: print_defaults (default printer only, D52/D66)
  const printDefaultsResult = transformPrintDefaults({ env, nowMillis, printRoutingDoc: settingsDocs.printRouting ?? null });
  for (const p of printDefaultsResult.problems) reportLines.push(`settings/printRouting: ${p}`);
  addSection('print_defaults', printDefaultsResult.rows);

  // row 70: pod_profiles
  const podProfilesResult = transformPodProfiles({ nowMillis, podProfilesDoc: settingsDocs.podProfiles ?? null, targetState });
  for (const p of podProfilesResult.problems) reportLines.push(`settings/podProfiles: ${p}`);
  for (const c of podProfilesResult.report.conflicts) reportLines.push(`settings/podProfiles: profile ${c.profileId} already exists in the target — NOT overwritten; diff: ${JSON.stringify(c.diffs)}`);
  addSection('pod_profiles', podProfilesResult.rows);

  // row 72: content_screening_terms + platform_settings (screening)
  const screeningResult = transformContentScreening({ contentScreeningDoc: settingsDocs.contentScreening ?? null, nowMillis });
  for (const p of screeningResult.problems) reportLines.push(`settings/contentScreening: ${p}`);
  addSection('content_screening_terms+platform_settings(screening)', screeningResult.rows);

  addSection('platform_settings(defaults)', platformResult.rows);

  // ── deferred rows: zero statements, reasons printed ──
  for (const [row, reason] of Object.entries(DEFERRED_ROWS)) {
    reportLines.push(`row ${row} deferred: ${reason}`);
  }

  // ── assemble plan.sql (two-pass: build once to get its sha, embed the sha) ──
  const draft = buildPlanSql({ bundleSha: bSha, env, finishedAt: nowIso, planSha: '0'.repeat(64), runId, startedAt: nowIso }, sections, '0'.repeat(64));
  const planSha = sha256Hex(draft.text);
  const final = buildPlanSql({ bundleSha: bSha, env, finishedAt: nowIso, planSha, runId, startedAt: nowIso }, sections, planSha);

  // The checks every finished plan must pass (lib/plan-checks.mjs): allowed
  // statements only, D1's statement length, no Firebase Storage host and, on
  // staging, no source address outside the two named exceptions.
  const safety = planSafetyProblems({
    emailMap,
    env,
    exemptLiterals: scanExemptLiterals,
    planText: final.text,
    rows: sections.flatMap((section) => section.rows),
    sourceDocs: { auditLogs: auditLogDocs, authUsers, legalAcceptances: legalAcceptanceDocs, shops: shopDocs, users: userDocs },
  });
  problems.push(...safety.problems);
  if (safety.legalTextsAddressCount > 0) {
    reportLines.push(`legal_acceptances: ${safety.legalTextsAddressCount} source address(es) found inside texts_json snapshots (immutable evidence, not scrubbed, not printed)`);
  }

  const ok = problems.length === 0;

  // What the target must hold after the apply. verify.mjs compares the
  // queried state against THIS, so its checks rest on the plan, never on the
  // state file itself. No address and no user id in here.
  const carriedActive = { platform_admin: 0, tenant_admin: 0 };
  for (const u of userTransforms) {
    if (u.carried && !u.report.adopted && !u.report.suspended) carriedActive[u.report.accountType] += 1;
  }
  const expected = {
    identity: { baselineActive: targetState?.activeCounts ?? null, carriedActive },
    podProfileIds: [...podProfilesResult.report.imported, ...podProfilesResult.report.conflicts.map((c) => c.profileId)].sort(),
    screening: {
      sourceTermCount: Array.isArray(settingsDocs.contentScreening?.data?.blocklist) ? settingsDocs.contentScreening.data.blocklist.length : 0,
      terms: screeningResult.rows.filter((r) => r.table === 'content_screening_terms').map((r) => r.pk),
    },
    targetStateGiven: targetState !== null,
    tenants: expectedTenants,
  };

  const planJson = {
    bundleSha: bSha,
    counts: final.counts,
    deferred: Object.entries(DEFERRED_ROWS).map(([row, reason]) => ({ reason, row: Number(row) })),
    env,
    expected,
    planSha,
    problems,
    reportLines,
    runId,
    schemaVersion: IMPORTER_SCHEMA_VERSION,
  };

  return { ok, planJson, planSha, planText: final.text, problems, reportLines, sections };
}

function buildApplyMd({ env, planSha }) {
  const dbName = readDatabaseNameFromPinned(env);
  const dbNameOrPlaceholder = dbName ?? '<DATABASE_NAME — could not be read from cloudflare/pinned.' + env + '.json>';
  return `# Apply this plan

**Environment:** ${env}
**Plan sha256:** ${planSha}
**Database:** ${dbNameOrPlaceholder} (from cloudflare/pinned.${env}.json d1.name)

## 1. Record a Time Travel bookmark first (D56)

\`\`\`
scripts/cf-preflight.sh ${env} -- d1 time-travel info ${dbNameOrPlaceholder}
\`\`\`
Write down the returned bookmark before continuing — this is the restore point if the apply needs to be rolled back.

## 2. Produce --target-state (optional but recommended)

\`\`\`
node scripts/cf-port/migrate/state-from-queries.mjs --print-queries target --env ${env}
\`\`\`
prints the exact, complete commands to run (each through the preflight script,
each redirected into a named file in a directory you choose OUTSIDE the repo —
the query results can contain email addresses). Then:
\`\`\`
node scripts/cf-port/migrate/state-from-queries.mjs --from <that directory> --kind target --out <target-state file, outside the repo>
\`\`\`
turns those files into the \`--target-state\` JSON \`import.mjs\` expects.

## 3. Apply the plan through the project's preflight script

\`\`\`
scripts/cf-preflight.sh ${env} -- d1 execute ${dbNameOrPlaceholder} --remote --file=plan.sql
\`\`\`

The preflight script performs the network-dependent preconditions this
importer cannot check itself (C1: account/D1/R2/Stripe pins; C3: every
migration this plan's tables need is already applied).

## 4. If the apply fails halfway

Every row this plan writes also writes an \`import_row_hashes\` row in the
same statement group. A partial apply therefore leaves some rows AND their
hashes committed, some not yet reached.

**The first statement in plan.sql — \`INSERT INTO import_runs ...\` — is
DELIBERATELY NOT idempotent.** It is a plain \`INSERT\`, not \`INSERT OR
IGNORE\` (0033: "a run id is never reused" is enforced, not merely
conventional): a run's identity must stay visible rather than be silently
repeated. Re-applying this EXACT plan.sql file a second time therefore
refuses on its own first line with "an import run starts running, once, one
at a time" — this is confirmed by a scripted test
(test/sqlite-execute.test.mjs) against a real SQLite database.

To resume after a failed apply of this exact file:
1. Confirm the run is still \`running\`:
   \`\`\`sql
   SELECT run_id, status FROM import_runs WHERE run_id = '<this plan's run_id>';
   \`\`\`
2. Re-apply plan.sql, but SKIP its first non-comment line (the \`INSERT INTO
   import_runs ...\` statement) — apply every statement from the first
   section onward. Every DATA row is \`INSERT OR IGNORE\` (a row already
   committed with the SAME content is skipped; a row not yet reached is
   inserted normally) and the row-hash bookkeeping is the same. The plan's
   OWN final statement (\`UPDATE import_runs SET status = 'completed' ...\`)
   completes the SAME run.
3. If a row's content changed between attempts (should never happen — the
   bundle is read-only and the plan is deterministic, C4), the matching
   \`import_row_hashes\` INSERT aborts with "import row hash mismatch: same
   id, different content" and the whole batch it is part of rolls back;
   investigate before retrying rather than forcing past this.

To abandon a stuck \`running\` row in favour of a FRESH plan (a different
bundle, different options, or simply starting over) instead of resuming this
exact file, close it first:
\`\`\`sql
UPDATE import_runs SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE run_id = '<the stuck run_id>' AND status = 'running';
\`\`\`
0033 allows at most one \`running\` run per environment, so a new run_id
cannot start until this one is closed.

## 5. Produce --actual-state and verify

\`\`\`
node scripts/cf-port/migrate/state-from-queries.mjs --print-queries actual --env ${env}
\`\`\`
prints the commands the same way step 2 did; then
\`\`\`
node scripts/cf-port/migrate/state-from-queries.mjs --from <that directory> --kind actual --out <actual-state file, outside the repo>
\`\`\`
and finally
\`\`\`
node scripts/cf-port/migrate/verify.mjs --env ${env} --bundle <bundle dir> --plan <this plan dir> --actual-state <that actual-state file>
\`\`\`
`;
}

/** Reads cloudflare/pinned.<env>.json's d1.name, or null if the file or the
 * field is missing (apply.md then prints a placeholder rather than
 * pretending it knows the database name). */
function readDatabaseNameFromPinned(env) {
  try {
    const pinnedPath = path.join(REPO_ROOT, 'cloudflare', `pinned.${env}.json`);
    const pinned = JSON.parse(readFileSync(pinnedPath, 'utf8'));
    return typeof pinned?.d1?.name === 'string' ? pinned.d1.name : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolvedBundle = path.resolve(args.bundle);
  const resolvedOut = path.resolve(args.out);
  assertOutsideRepo(resolvedOut);

  if (!existsSync(resolvedBundle)) die(`bundle directory does not exist: ${resolvedBundle}`);

  step(`reading bundle ${resolvedBundle}`);
  const result = runImport({
    bundleDir: resolvedBundle,
    connectMapPath: args.connectMap ? path.resolve(args.connectMap) : null,
    emailMapPath: args.emailMap ? path.resolve(args.emailMap) : null,
    commissionDefaultFor: args.commissionDefaultFor,
    env: args.env,
    scrubUnmapped: args.scrubUnmapped,
    targetStatePath: args.targetState ? path.resolve(args.targetState) : null,
  });

  if (!result.ok) {
    step('REFUSED — problems found');
    for (const p of result.problems) console.log(`  ! ${p}`);
    process.exit(1);
  }

  step('plan built');
  for (const [name, count] of Object.entries(result.planJson.counts)) {
    console.log(`  ${name.padEnd(60)} ${count}`);
  }
  if (result.reportLines.length > 0) {
    step('report');
    for (const line of result.reportLines) console.log(`  - ${line}`);
  }

  ensureDir(resolvedOut);
  writeFileSecure(path.join(resolvedOut, 'plan.sql'), Buffer.from(result.planText, 'utf8'));
  writeFileSecure(path.join(resolvedOut, 'plan.json'), Buffer.from(JSON.stringify(result.planJson, null, 2) + '\n', 'utf8'));
  writeFileSecure(path.join(resolvedOut, 'apply.md'), Buffer.from(buildApplyMd({ env: args.env, planSha: result.planSha }), 'utf8'));

  step('done');
  console.log(`  plan sha256: ${result.planSha}`);
  console.log(`  wrote: ${resolvedOut}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { parseArgs, assertOutsideRepo, buildApplyMd, REPO_ROOT };
