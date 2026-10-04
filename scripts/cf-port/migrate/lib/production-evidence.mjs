/**
 * scripts/cf-port/migrate/lib/production-evidence.mjs — CP7-T2: the manifest's
 * production preconditions (MIGRATION_MANIFEST.md §d) that import.mjs checks
 * before it builds a production plan. import.mjs never talks to the source,
 * Stripe or D1, so a fact it cannot read itself comes in as an EVIDENCE FILE
 * the operator makes by the runbook's read-only step; each is checked against
 * the bundle and against the others, and a contradiction refuses the plan.
 *
 *   P1  --confirm production (lib/api-session.mjs confirmationProblem) and
 *       --expect-tenants <n>, a positive integer (import.mjs compares it with
 *       the tenants the plan writes)
 *   P3  --freeze-evidence <file> (runbook §4.10) and --rescan-bundle <dir> (the
 *       second export, runbook §5.2 step 3):
 *         { "evidence": "freeze", "frozenAt": ISO, "checkoutsStoppedAt": ISO,
 *           "schedulesPausedAt": ISO, "webhookDisabledAt": ISO, "editsStoppedAt": ISO }
 *       frozenAt is the moment the freeze was complete (after its last step;
 *       no step may be later). Refused: a step after frozenAt; a bundle
 *       exported before frozenAt; a carried (or mixed, or verify-only)
 *       collection whose maxUpdateTimeSeen is after frozenAt; a re-scan that
 *       does not verify, is the bundle itself, or was not exported after it;
 *       any such collection that differs between the two exports (parts
 *       sha256, document count, or the _verify file), or exists in one only;
 *       an Auth user that differs other than by its last sign-in time. An
 *       archive collection that differs is REPORTED (names only), not refused:
 *       the manifest's P3 names the carried ones, and §4.5 reads the payments.
 *   P4  --payments-evidence <file> (runbook §4.10, from §4.4's read):
 *         { "evidence": "open-payments", "readAt": ISO, "platformAccountId": "acct_…",
 *           "openPaymentIntents": { "requires_payment_method": [], "requires_confirmation": [],
 *             "requires_action": [], "requires_capture": [], "processing": [] },
 *           "printNotificationsPending": 0, "terminalCheckouts": [] }
 *       Refused: a read before checkouts stopped (the freeze evidence); a key
 *       of another account than the pinned stripeAccountId (refused while that
 *       pin is null); a state missing, or any PaymentIntent listed; a pending
 *       printer notification; a checkout of the bundle (archive) whose status
 *       is not completed, failed or skipped, unless its id is listed in
 *       terminalCheckouts (its PaymentIntent read as terminal at Stripe, §4.5).
 *   P5  --connect-evidence <file> (runbook §5.4, read from live Stripe):
 *         { "evidence": "connect-facts", "readAt": ISO, "platformAccountId": "acct_…",
 *           "accounts": { "acct_…": { "chargesEnabled": bool, "payoutsEnabled": bool,
 *             "detailsSubmitted": bool } } }
 *       Refused: a read before the export (re-pull, never carry); another
 *       account than the pinned one (a successful GET /v1/accounts/{id} under
 *       the platform key is the proof that the account belongs to it); an
 *       account without its three booleans. import.mjs refuses a shop whose
 *       account is not in the file, and writes THESE flags, not the source's.
 *
 * Reads local files only. Prints nothing: problems and report lines name
 * files, keys, collections, times and ids, never a file's content.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { confirmationProblem } from './api-session.mjs';
import { readAuthUsers, readCollection, readRootManifest } from './bundle-reader.mjs';
import { verifyBundle } from './verify-bundle.mjs';

export const FREEZE_STEPS = Object.freeze(['checkoutsStoppedAt', 'schedulesPausedAt', 'webhookDisabledAt', 'editsStoppedAt']);
export const OPEN_PAYMENT_INTENT_STATES = Object.freeze(['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture', 'processing']);
/** The source's checkout statuses that end a checkout (functions/src/checkout-recovery). */
export const TERMINAL_CHECKOUT_STATUSES = Object.freeze(['completed', 'failed', 'skipped']);
const COMPARED_FATES = ['carry', 'mixed', 'verify-only'];
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function timeOf(value) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** { evidence } or { problem }: the file exists, is JSON and is of `kind`. */
export function readEvidence(flag, filePath, kind) {
  if (filePath === null || filePath === undefined) return { problem: `${flag} is required for --env production` };
  if (!existsSync(filePath)) return { problem: `${flag} ${filePath} does not exist` };
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { problem: `${flag} is not JSON` };
  }
  if (evidence === null || typeof evidence !== 'object' || evidence.evidence !== kind) {
    return { problem: `${flag} is not ${kind} evidence (it must say "evidence": "${kind}")` };
  }
  return { evidence };
}

/** P3, the freeze evidence against the bundle. → { problems, freeze: { step: ms } | null } */
export function freezeProblems(evidence, bundleDir, rootManifest) {
  const problems = [];
  const times = {};
  for (const key of ['frozenAt', ...FREEZE_STEPS]) {
    times[key] = timeOf(evidence[key]);
    if (times[key] === null) problems.push(`--freeze-evidence ${key} is not an ISO time (YYYY-MM-DDTHH:MM:SS.sssZ)`);
  }
  if (problems.length > 0) return { freeze: null, problems };
  for (const key of FREEZE_STEPS) {
    if (times[key] > times.frozenAt) problems.push(`--freeze-evidence ${key} is after frozenAt: frozenAt is the moment the freeze was complete, after its last step`);
  }
  const exportedAt = timeOf(rootManifest.exportedAt);
  if (exportedAt === null || exportedAt <= times.frozenAt) {
    problems.push(`the bundle was exported at ${rootManifest.exportedAt}, not after the freeze was complete (frozenAt ${evidence.frozenAt}): export again after the freeze (P3)`);
  }
  for (const collection of rootManifest.collections ?? []) {
    if (!COMPARED_FATES.includes(collection.fate) || collection.fate === 'verify-only') continue;
    const manifestPath = path.join(bundleDir, collection.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const seen = JSON.parse(readFileSync(manifestPath, 'utf8')).maxUpdateTimeSeen ?? null;
    const seenAt = seen === null ? null : Date.parse(seen);
    if (seenAt !== null && !Number.isNaN(seenAt) && seenAt > times.frozenAt) {
      problems.push(`${collection.name} holds a document written at ${seen}, after the freeze was complete (frozenAt ${evidence.frozenAt}) (P3)`);
    }
  }
  return { freeze: times, problems };
}

function fileSha(filePath) {
  return existsSync(filePath) ? createHash('sha256').update(readFileSync(filePath)).digest('hex') : null;
}

/** What identifies one collection's content in a bundle (null: not there). */
function collectionFingerprint(bundleDir, collection) {
  if (collection.fate === 'verify-only') return fileSha(path.join(bundleDir, '_verify', `${collection.name}.jsonl`));
  const manifestPath = path.join(bundleDir, collection.name, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return JSON.stringify([manifest.documentCount ?? null, (manifest.parts ?? []).map((part) => part.sha256)]);
}

/** An Auth record without the time of its last sign-in (a sign-in is not a write to carried data). */
function authWithoutSignIn(user) {
  const { metadata, ...rest } = user;
  const { lastSignInTime, ...kept } = metadata ?? {};
  return JSON.stringify({ ...rest, metadata: kept });
}

/** P3, the re-scan: the second export against the first. → { problems, reportLines } */
export function rescanProblems(bundleDir, rescanDir, rootManifest) {
  if (rescanDir === null || rescanDir === undefined) {
    return { problems: ['--rescan-bundle is required for --env production: the second export proves nothing was written after the first (P3, runbook §5.2 step 3)'], reportLines: [] };
  }
  if (!existsSync(rescanDir)) return { problems: [`--rescan-bundle ${rescanDir} does not exist`], reportLines: [] };
  if (path.resolve(rescanDir) === path.resolve(bundleDir)) return { problems: ['--rescan-bundle is the bundle itself: it must be the second export'], reportLines: [] };
  if (!verifyBundle(rescanDir).ok) return { problems: ['--rescan-bundle does not verify (its SHA256SUMS or a manifest)'], reportLines: [] };
  const rescan = readRootManifest(rescanDir);
  const problems = [];
  const reportLines = [];
  if (rescan.schemaVersion !== rootManifest.schemaVersion) problems.push(`--rescan-bundle has schemaVersion ${rescan.schemaVersion}, the bundle ${rootManifest.schemaVersion}`);
  const bundleAt = timeOf(rootManifest.exportedAt);
  const rescanAt = timeOf(rescan.exportedAt);
  if (bundleAt === null || rescanAt === null || rescanAt <= bundleAt) {
    problems.push(`--rescan-bundle was exported at ${rescan.exportedAt}, not after the bundle (${rootManifest.exportedAt}): it must be the second export`);
  }
  const byName = (manifest) => Object.fromEntries((manifest.collections ?? []).map((c) => [c.name, c]));
  const before = byName(rootManifest);
  const after = byName(rescan);
  const changed = [];
  const archiveChanged = [];
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const collection = before[name] ?? after[name];
    const compared = COMPARED_FATES.includes(before[name]?.fate) || COMPARED_FATES.includes(after[name]?.fate);
    const same = before[name] !== undefined && after[name] !== undefined && collectionFingerprint(bundleDir, before[name]) === collectionFingerprint(rescanDir, after[name]) && before[name].fate === after[name].fate;
    if (same) continue;
    if (compared) changed.push(name);
    else if (collection.fate === 'archive') archiveChanged.push(name);
    else changed.push(name);
  }
  if (changed.length > 0) problems.push(`written between the two exports (P3): ${changed.join(', ')}`);
  if (archiveChanged.length > 0) reportLines.push(`re-scan: archive collection(s) that differ between the two exports (not carried; read them by hand, §4.5): ${archiveChanged.join(', ')}`);

  const usersBefore = readAuthUsers(bundleDir);
  const usersAfter = readAuthUsers(rescanDir);
  const keyed = (users, fn) => Object.fromEntries(users.map((user) => [user.uid, fn(user)]));
  const plainBefore = keyed(usersBefore, (u) => JSON.stringify(u));
  const plainAfter = keyed(usersAfter, (u) => JSON.stringify(u));
  const strippedBefore = keyed(usersBefore, authWithoutSignIn);
  const strippedAfter = keyed(usersAfter, authWithoutSignIn);
  const uids = [...new Set([...Object.keys(plainBefore), ...Object.keys(plainAfter)])];
  const authChanged = uids.filter((uid) => strippedBefore[uid] !== strippedAfter[uid]).length;
  const signInsOnly = uids.filter((uid) => strippedBefore[uid] === strippedAfter[uid] && plainBefore[uid] !== plainAfter[uid]).length;
  if (authChanged > 0) problems.push(`${authChanged} Auth user(s) differ between the two exports other than by a sign-in time (P3)`);
  if (signInsOnly > 0) reportLines.push(`re-scan: ${signInsOnly} Auth user(s) signed in between the two exports (only the sign-in time differs)`);
  if (problems.length === 0) reportLines.push(`re-scan: the second export (${rescan.exportedAt}) equals the bundle in every carried, mixed and verify-only collection (P3)`);
  return { problems, reportLines };
}

/** The pinned production platform account, or the refusal. */
export function pinnedAccountProblem(pinned) {
  const account = pinned?.stripeAccountId ?? null;
  return typeof account === 'string' && account.startsWith('acct_')
    ? null
    : 'cloudflare/pinned.production.json stripeAccountId is null: the Stripe evidence cannot be tied to the pinned platform account (§2.3)';
}

/** P4, the open money state. */
export function paymentsProblems(evidence, { bundleDir, freeze, pinned, rootManifest }) {
  const problems = [];
  const readAt = timeOf(evidence.readAt);
  if (readAt === null) problems.push('--payments-evidence readAt is not an ISO time (YYYY-MM-DDTHH:MM:SS.sssZ)');
  else if (freeze !== null && readAt < freeze.checkoutsStoppedAt) problems.push(`--payments-evidence was read at ${evidence.readAt}, before checkouts stopped: read it again (P4, §4.4)`);
  if (pinnedAccountProblem(pinned) === null && evidence.platformAccountId !== pinned.stripeAccountId) {
    problems.push(`--payments-evidence was read with the key of ${typeof evidence.platformAccountId === 'string' ? evidence.platformAccountId : 'no account'}, not the pinned platform account ${pinned.stripeAccountId}`);
  }
  const open = evidence.openPaymentIntents;
  if (open === null || typeof open !== 'object' || !OPEN_PAYMENT_INTENT_STATES.every((state) => Array.isArray(open[state]))) {
    problems.push(`--payments-evidence openPaymentIntents must list every state: ${OPEN_PAYMENT_INTENT_STATES.join(', ')}`);
  } else {
    const listed = OPEN_PAYMENT_INTENT_STATES.filter((state) => open[state].length > 0);
    if (listed.length > 0) {
      problems.push(`open PaymentIntents at Stripe (P4, §4.4): ${listed.map((state) => `${state} ${open[state].length} (${open[state].map(String).join(', ')})`).join('; ')}`);
    }
  }
  if (!Number.isInteger(evidence.printNotificationsPending) || evidence.printNotificationsPending < 0) {
    problems.push('--payments-evidence printNotificationsPending must be a count (the export dry run\'s printNotifications line)');
  } else if (evidence.printNotificationsPending > 0) {
    problems.push(`${evidence.printNotificationsPending} printer notification(s) pending in the source (P4)`);
  }
  const terminal = evidence.terminalCheckouts ?? [];
  if (!Array.isArray(terminal) || !terminal.every((id) => typeof id === 'string')) {
    problems.push('--payments-evidence terminalCheckouts must be a list of checkout ids');
  } else if ((rootManifest.collections ?? []).some((c) => c.name === 'checkouts')) {
    const open = readCollection(bundleDir, 'checkouts').filter((doc) => !TERMINAL_CHECKOUT_STATUSES.includes(doc.data?.status) && !terminal.includes(doc.id));
    if (open.length > 0) {
      problems.push(`${open.length} checkout(s) of the source are not terminal (status ${TERMINAL_CHECKOUT_STATUSES.join('/')}) and not in terminalCheckouts: ${open.map((doc) => doc.id).join(', ')} (P4)`);
    }
  }
  return problems;
}

/** P5, the Connect facts read from live Stripe. → { problems, accounts } */
export function connectProblems(evidence, { pinned, rootManifest }) {
  const problems = [];
  const readAt = timeOf(evidence.readAt);
  const exportedAt = timeOf(rootManifest.exportedAt);
  if (readAt === null) problems.push('--connect-evidence readAt is not an ISO time (YYYY-MM-DDTHH:MM:SS.sssZ)');
  else if (exportedAt === null || readAt < exportedAt) problems.push(`--connect-evidence was read at ${evidence.readAt}, before the export (${rootManifest.exportedAt}): re-pull it right before the plan (P5)`);
  if (pinnedAccountProblem(pinned) === null && evidence.platformAccountId !== pinned.stripeAccountId) {
    problems.push(`--connect-evidence was read with the key of ${typeof evidence.platformAccountId === 'string' ? evidence.platformAccountId : 'no account'}, not the pinned platform account ${pinned.stripeAccountId}`);
  }
  const accounts = {};
  if (evidence.accounts === null || typeof evidence.accounts !== 'object' || Array.isArray(evidence.accounts)) {
    problems.push('--connect-evidence accounts must be an object of account id → flags');
  } else {
    for (const [id, flags] of Object.entries(evidence.accounts)) {
      if (!['chargesEnabled', 'payoutsEnabled', 'detailsSubmitted'].every((key) => typeof flags?.[key] === 'boolean')) {
        problems.push(`--connect-evidence accounts.${id} must hold chargesEnabled, payoutsEnabled and detailsSubmitted as booleans`);
        continue;
      }
      accounts[id] = { chargesEnabled: flags.chargesEnabled, detailsSubmitted: flags.detailsSubmitted, payoutsEnabled: flags.payoutsEnabled };
    }
  }
  return { accounts, problems };
}

/**
 * Every production precondition this tool checks before the transforms, in
 * the manifest's order. The confirmation is asked first and alone.
 * → { problems, reportLines, connectAccounts }
 */
export function productionPreconditions({ bundleDir, confirm, connectEvidencePath, expectTenants, freezeEvidencePath, paymentsEvidencePath, pinned, rescanBundleDir, rootManifest }) {
  const confirmation = confirmationProblem('production', confirm);
  if (confirmation !== null) return { connectAccounts: null, problems: [`REFUSED: ${confirmation}`], reportLines: [] };
  const problems = [];
  const reportLines = [];
  if (!Number.isInteger(expectTenants) || expectTenants < 1) problems.push('--expect-tenants <n> is required for --env production: the number of tenants the plan must write (P1)');
  const pinProblem = pinnedAccountProblem(pinned);
  if (pinProblem !== null) problems.push(pinProblem);

  const freezeFile = readEvidence('--freeze-evidence', freezeEvidencePath, 'freeze');
  let freeze = null;
  if (freezeFile.problem) problems.push(freezeFile.problem);
  else {
    const result = freezeProblems(freezeFile.evidence, bundleDir, rootManifest);
    freeze = result.freeze;
    problems.push(...result.problems);
  }
  const rescan = rescanProblems(bundleDir, rescanBundleDir, rootManifest);
  problems.push(...rescan.problems);
  reportLines.push(...rescan.reportLines);

  const paymentsFile = readEvidence('--payments-evidence', paymentsEvidencePath, 'open-payments');
  if (paymentsFile.problem) problems.push(paymentsFile.problem);
  else problems.push(...paymentsProblems(paymentsFile.evidence, { bundleDir, freeze, pinned, rootManifest }));

  const connectFile = readEvidence('--connect-evidence', connectEvidencePath, 'connect-facts');
  let connectAccounts = null;
  if (connectFile.problem) problems.push(connectFile.problem);
  else {
    const result = connectProblems(connectFile.evidence, { pinned, rootManifest });
    problems.push(...result.problems);
    connectAccounts = result.accounts;
    if (result.problems.length === 0) reportLines.push(`connect: the flags of ${Object.keys(connectAccounts).length} account(s) are taken from the live read of ${connectFile.evidence.readAt} (P5), not from the source`);
  }
  return { connectAccounts, problems: problems.map((p) => `REFUSED: ${p}`), reportLines };
}

/** The refusal of a production-only option on staging, or null. */
export function stagingEvidenceProblem({ confirm, connectEvidencePath, freezeEvidencePath, paymentsEvidencePath, rescanBundleDir }) {
  const confirmation = confirmationProblem('staging', confirm);
  if (confirmation !== null) return confirmation;
  const given = [['--freeze-evidence', freezeEvidencePath], ['--rescan-bundle', rescanBundleDir], ['--payments-evidence', paymentsEvidencePath], ['--connect-evidence', connectEvidencePath]]
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([flag]) => flag);
  return given.length > 0 ? `${given.join(', ')} belong(s) to --env production: staging never reads live facts (S3)` : null;
}
