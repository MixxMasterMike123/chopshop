#!/usr/bin/env node
/**
 * scripts/cf-port/migrate/restore-archive.mjs — manifest §(c) "Restore",
 * steps 1, 2 and 4 for the D1 target only, as a plan generator like
 * import.mjs. The Firestore target of step 3 is OUT OF SCOPE for this
 * checkpoint: this tool refuses to attempt it and says so.
 *
 *   node scripts/cf-port/migrate/restore-archive.mjs --bundle <dir>
 *        --collection <name> --env <staging|production> --out <dir>
 *        [--email-map <file>] [--scrub-unmapped] [--connect-map <file>]
 *
 * Steps performed:
 *   1. sha256sum -c SHA256SUMS (via verifyBundle) — any mismatch stops.
 *   2. Decode the typed JSON (via lib/bundle-reader.mjs).
 *   4. Verify: count + sha256 over the canonical re-export of the restored
 *      rows equals the manifest — this is BUILT INTO the plan's own
 *      row-hash mechanism (import_row_hashes), so a restore plan carries the
 *      same self-verifying property an import plan does; this tool also
 *      prints the doc count it read so a human can compare it to the
 *      collection's manifest.json documentCount.
 *
 * Step 3 (Firestore target, rollback before Firebase deletion) is NOT
 * implemented here — this tool only ever writes a D1-bound plan.sql. A
 * request naming that target refuses with a clear message.
 *
 * A collection that has no transformation YET is refused with a clear
 * message naming the checkpoint that will add it (this checkpoint, CP3, only
 * wires the transformations CP3's own importer already has: shops, users,
 * printers/printerCatalog, legalAcceptances, auditLogs, and the settings/*
 * docs). Everything else (discountCodes, dac7Sellers, and the many archived
 * CRM/legacy collections) has no target schema yet — CP4+ ports them.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBundle } from './lib/verify-bundle.mjs';
import { readCollection, readAuthUsers, readSubcollection, bundleSha, readRootManifest } from './lib/bundle-reader.mjs';
import { emailMapFor, normalizeConnectMap, resolveConnectFacts, scrubOptionsProblem } from './lib/scrub.mjs';
import { buildPlanSql, sha256Hex } from './lib/plan.mjs';
import { writeFileSecure, ensureDir } from './lib/bundle-writer.mjs';
import { planSafetyProblems } from './lib/plan-checks.mjs';
import { isInsideRepo } from './lib/outside-repo.mjs';
import { canonicalStringify } from './lib/typed-json.mjs';

import { transformShop, ARCHIVED_SHOP_IDS } from './lib/transform-shops.mjs';
import { joinUsersToAuth, transformUser } from './lib/transform-users.mjs';
import { transformSnapwearPrinter, SNAPWEAR_PRINTER_ID } from './lib/transform-printers.mjs';
import { transformLegalAcceptance } from './lib/transform-legal-acceptances.mjs';
import { transformAuditLog } from './lib/transform-audit-logs.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Collections this checkpoint knows how to restore into D1, through the
 * SAME transformation code the importer uses (the brief's requirement: "the
 * same transformation code the importer uses"). Anything else is refused. */
export const SUPPORTED_COLLECTIONS = new Set(['auditLogs', 'printerCatalog', 'printers', 'shops', 'shops__legalAcceptances', 'users']);

function die(message) {
  console.error(`RESTORE REFUSED: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { bundle: null, collection: null, connectMap: null, emailMap: null, env: null, idMap: null, out: null, scrubUnmapped: false, target: 'd1' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bundle') out.bundle = argv[++i] ?? die('--bundle needs a value');
    else if (arg === '--collection') out.collection = argv[++i] ?? die('--collection needs a value');
    else if (arg === '--env') out.env = argv[++i] ?? die('--env needs a value');
    else if (arg === '--out') out.out = argv[++i] ?? die('--out needs a value');
    else if (arg === '--email-map') out.emailMap = argv[++i] ?? die('--email-map needs a value');
    else if (arg === '--scrub-unmapped') out.scrubUnmapped = true;
    else if (arg === '--connect-map') out.connectMap = argv[++i] ?? die('--connect-map needs a value');
    else if (arg === '--target') out.target = argv[++i] ?? die('--target needs a value');
    else if (arg === '--id-map') out.idMap = argv[++i] ?? die('--id-map needs a value');
    else die(`unknown argument ${arg}`);
  }
  if (out.target !== 'd1') {
    die(
      `--target ${out.target} is not supported. This checkpoint (CP3) implements manifest §(c) Restore steps 1, 2 and 4 for the D1 target ONLY. ` +
        'Step 3\'s Firestore target (rollback before Firebase deletion) is out of scope here and is not planned for any specific later checkpoint in this brief — raise it with the reviewer before relying on it.',
    );
  }
  if (!out.bundle) die('--bundle is required');
  if (!out.collection) die('--collection is required');
  if (!out.env || (out.env !== 'staging' && out.env !== 'production')) die('--env must be "staging" or "production"');
  if (!out.out) die('--out is required');
  if (!SUPPORTED_COLLECTIONS.has(out.collection)) {
    die(
      `--collection ${out.collection} has no D1 transformation yet in this checkpoint (CP3). Supported: ${[...SUPPORTED_COLLECTIONS].join(', ')}. ` +
        'Every other manifest collection (discountCodes, dac7Sellers, the archived CRM/legacy collections, …) gets its transformation when that feature ports (CP4 or later) — see docs/cf-port/MIGRATION_MANIFEST.md §(c) step 3/4 and DECISIONS.md for which checkpoint owns it.',
    );
  }
  return out;
}

function assertOutsideRepo(resolvedOutDir) {
  if (isInsideRepo(resolvedOutDir, REPO_ROOT)) {
    die(`--out ${resolvedOutDir} resolves inside the repo root (${REPO_ROOT}); the plan must be written OUTSIDE the repo`);
  }
}

/**
 * Builds a restore plan for one supported collection, reusing the exact
 * transform functions import.mjs uses for the same manifest row.
 */
export function runRestore(args) {
  try {
    return runRestoreUnsafe(args);
  } catch (error) {
    // A refusal raised inside a transform is a refusal, not a crash (as in import.mjs).
    return { ok: false, problems: [error.message ?? String(error)] };
  }
}

function runRestoreUnsafe({ bundleDir, collection, connectMapPath = null, emailMapPath = null, env, idMapPath = null, now = null, scrubUnmapped = false }) {
  if (env === 'production') {
    // A restore plan opens with an import_runs row of its own, and 0033 allows
    // production ONE completed run (`import_runs_insert_guard`): after the
    // import, every restore would be refused by its first statement, and
    // before it a restore would use up the one run. No plan that cannot be
    // applied is written.
    return {
      ok: false,
      problems: [
        'REFUSED: a restore into production is not supported yet. A restore plan records a run in import_runs, and production accepts one completed run (0033): ' +
          'restores need bookkeeping of their own, which the checkpoint that first restores an archived collection adds.',
      ],
    };
  }
  const scrubProblem = scrubOptionsProblem(env, { emailMapGiven: emailMapPath !== null, scrubUnmapped });
  if (scrubProblem !== null) {
    return { ok: false, problems: [scrubProblem] };
  }
  const verify = verifyBundle(bundleDir);
  if (!verify.ok) {
    return { ok: false, problems: ['bundle verification failed', ...verify.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)] };
  }
  const rootManifest = readRootManifest(bundleDir);

  const emailMapRaw = emailMapPath ? JSON.parse(readFileSync(emailMapPath, 'utf8')) : {};
  const emailMap = emailMapFor(env, emailMapRaw);
  const connectMapRaw = connectMapPath ? JSON.parse(readFileSync(connectMapPath, 'utf8')) : {};
  const connectMap = normalizeConnectMap(connectMapRaw);
  // --id-map (accepted answer to open question 4): a plain JSON object
  // { legacyUid: newUserId }, the SAME shape transform-legal-acceptances.mjs
  // and transform-audit-logs.mjs expect for their own legacyIdMap parameter.
  // Without it, kept the legacy id and left the mapped user NULL, as 0037/
  // 0001 both allow for an import.
  const suppliedIdMap = idMapPath ? JSON.parse(readFileSync(idMapPath, 'utf8')) : {};

  // Review round 1, fix 3: the plan's clock is the bundle's own exportedAt,
  // never the wall clock (see import.mjs for the full rationale); `now` is an
  // optional test-only override.
  const nowDate = typeof now === 'function' ? now() : new Date(rootManifest.exportedAt);
  const nowIso = nowDate.toISOString();
  const nowMillis = nowDate.getTime();
  const bSha = bundleSha(bundleDir);
  const optionsFingerprint = sha256Hex(canonicalStringify({ connectMap: connectMapRaw, emailMap: emailMapRaw, scrubUnmapped }));
  const runId = `restore_${collection}_${env}_${bSha.slice(0, 16)}_${optionsFingerprint.slice(0, 16)}`;

  const problems = [];
  const reportLines = [];
  const rows = [];
  const sourceDocs = {};
  const scanExemptLiterals = [];
  let sourceDocCount = 0;

  if (collection === 'shops') {
    const docs = readCollection(bundleDir, 'shops');
    sourceDocs.shops = docs;
    sourceDocCount = docs.length;
    for (const doc of docs) {
      if (ARCHIVED_SHOP_IDS.has(doc.id)) continue;
      const connectFacts = {
        chargesEnabled: doc.data?.payments?.chargesEnabled === true,
        connectEnabled: doc.data?.payments?.connectEnabled === true,
        detailsSubmitted: doc.data?.payments?.detailsSubmitted === true,
        disabledReason: null,
        payoutDelayDays: typeof doc.data?.payments?.payoutDelayDays === 'number' ? doc.data.payments.payoutDelayDays : null,
        payoutsEnabled: doc.data?.payments?.payoutsEnabled === true,
        requirementsDueJson: null,
        stripeAccountId: doc.data?.payments?.stripeAccountId ?? null,
      };
      const resolved = resolveConnectFacts(connectFacts, connectMap, env);
      const result = transformShop({ connectFacts: { ...connectFacts, ...resolved }, doc, emailMap, env, nowMillis, scrubUnmapped, targetState: null });
      for (const refusal of result.report.refusals ?? []) problems.push(`REFUSED: shops/${doc.id}: ${refusal}`);
      for (const line of result.report.lines ?? []) reportLines.push(`shops/${doc.id}: ${line}`);
      rows.push(...result.rows);
    }
  } else if (collection === 'users') {
    const userDocs = readCollection(bundleDir, 'users');
    const authUsers = readAuthUsers(bundleDir);
    const { joined } = joinUsersToAuth(userDocs, authUsers);
    sourceDocs.users = userDocs;
    sourceDocs.authUsers = authUsers;
    sourceDocCount = userDocs.length;
    for (const { authUser, uid, userDoc } of joined) {
      // knownTenantIds: null (fix 6 defaults to "every tenant known") — a
      // standalone users restore has no shops pass and no --target-state
      // option in this checkpoint, so there is nothing to validate a
      // membership's tenant_id against here; documented as a limitation
      // alongside the module's other restore-only gaps (no legacy_id_map).
      const result = transformUser({ authUser, emailMap, env, knownTenantIds: null, nowMillis, scrubUnmapped, targetState: null, uid, userDoc });
      if (result.carried) rows.push(...result.rows);
    }
  } else if (collection === 'printers' || collection === 'printerCatalog') {
    const printerDocs = readCollection(bundleDir, 'printers');
    const catalogDocs = readCollection(bundleDir, 'printerCatalog');
    sourceDocCount = collection === 'printers' ? printerDocs.length : catalogDocs.length;
    const printerDoc = printerDocs.find((d) => d.id === SNAPWEAR_PRINTER_ID) ?? null;
    const catalogDoc = catalogDocs.find((d) => d.id === SNAPWEAR_PRINTER_ID) ?? null;
    const result = transformSnapwearPrinter({ catalogDoc, env, nowMillis, printerDoc });
    for (const p of result.problems) problems.push(p);
    rows.push(...result.rows);
  } else if (collection === 'shops__legalAcceptances') {
    const docs = readSubcollection(bundleDir, 'shops__legalAcceptances');
    sourceDocs.legalAcceptances = docs;
    sourceDocCount = docs.length;
    // --id-map (accepted answer to open question 4): a standalone restore has
    // no prior user-import pass of its own to draw a legacy id map from, so
    // the caller may supply one directly. Without it, every acceptance
    // restores with legacy_uid only (user_id NULL), as 0037 permits.
    if (Object.keys(suppliedIdMap).length === 0) {
      reportLines.push('shops__legalAcceptances restore: no --id-map given, every row restores with user_id NULL, legacy_uid set (0037 permits this)');
    }
    for (const doc of docs) {
      const result = transformLegalAcceptance({ doc, emailMap, legacyIdMap: suppliedIdMap, nowMillis, scrubUnmapped });
      for (const p of result.problems) problems.push(p);
      rows.push(...result.rows);
      scanExemptLiterals.push(...(result.scanExemptLiterals ?? []));
    }
  } else if (collection === 'auditLogs') {
    const docs = readCollection(bundleDir, 'auditLogs');
    sourceDocs.auditLogs = docs;
    sourceDocCount = docs.length;
    if (Object.keys(suppliedIdMap).length === 0) {
      reportLines.push('auditLogs restore: no --id-map given, every actor uid is kept as legacyActorUid, actor_user_id NULL');
    }
    for (const doc of docs) {
      const { rows: r } = transformAuditLog({ doc, legacyIdMap: suppliedIdMap, nowMillis });
      rows.push(...r);
    }
  }

  const sections = [{ name: collection, rows }];
  const draft = buildPlanSql({ bundleSha: bSha, env, finishedAt: nowIso, planSha: '0'.repeat(64), runId, startedAt: nowIso }, sections, '0'.repeat(64));
  const planSha = sha256Hex(draft.text);
  const final = buildPlanSql({ bundleSha: bSha, env, finishedAt: nowIso, planSha, runId, startedAt: nowIso }, sections, planSha);

  const safety = planSafetyProblems({ emailMap, env, exemptLiterals: scanExemptLiterals, planText: final.text, rows, sourceDocs });
  problems.push(...safety.problems);

  const ok = problems.length === 0;
  const planJson = {
    bundleSha: bSha,
    collection,
    counts: final.counts,
    env,
    planSha,
    problems,
    reportLines,
    runId,
    sourceDocCount,
  };

  return { ok, planJson, planSha, planText: final.text, problems, reportLines };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolvedBundle = path.resolve(args.bundle);
  const resolvedOut = path.resolve(args.out);
  assertOutsideRepo(resolvedOut);
  if (!existsSync(resolvedBundle)) die(`bundle directory does not exist: ${resolvedBundle}`);

  const result = runRestore({
    bundleDir: resolvedBundle,
    collection: args.collection,
    connectMapPath: args.connectMap ? path.resolve(args.connectMap) : null,
    emailMapPath: args.emailMap ? path.resolve(args.emailMap) : null,
    env: args.env,
    idMapPath: args.idMap ? path.resolve(args.idMap) : null,
    scrubUnmapped: args.scrubUnmapped,
  });

  if (!result.ok) {
    console.error('REFUSED — problems found');
    for (const p of result.problems) console.log(`  ! ${p}`);
    process.exit(1);
  }

  ensureDir(resolvedOut);
  writeFileSecure(path.join(resolvedOut, 'plan.sql'), Buffer.from(result.planText, 'utf8'));
  writeFileSecure(path.join(resolvedOut, 'plan.json'), Buffer.from(JSON.stringify(result.planJson, null, 2) + '\n', 'utf8'));

  console.log(`plan sha256: ${result.planSha}`);
  console.log(`source doc count: ${result.planJson.sourceDocCount}`);
  console.log(`wrote: ${resolvedOut}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { parseArgs, assertOutsideRepo };
