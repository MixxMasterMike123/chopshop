#!/usr/bin/env node
/**
 * scripts/cf-port/migrate/state-from-queries.mjs — turns the read-only query
 * results a human collects into the `--target-state`/`--actual-state` JSON
 * files `import.mjs`/`verify.mjs` expect (review round 1, "also needed").
 *
 *   node scripts/cf-port/migrate/state-from-queries.mjs --print-queries target|actual --env <env>
 *   node scripts/cf-port/migrate/state-from-queries.mjs --from <directory> --kind target|actual --out <file>
 *
 * NEVER talks to D1 itself — it only prints commands (for a human, or a
 * script the human runs, to execute through the preflight script) and reads
 * back their JSON output from local files.
 *
 * CP7-T2:
 *   - production's commands carry `--bootstrap` (`scripts/cf-preflight.sh
 *     production --bootstrap -- d1 execute …`). Without it every production
 *     command is launch-gated (preflight check 6), so a read-only SELECT could
 *     not run before the launch checklist is ☑. `--bootstrap` admits only
 *     whoami, d1, r2 and queues, and still checks the credentials file, the
 *     pinned identity, the account wrangler sees and the configuration's
 *     account id (checks 1–4); every printed command is one SELECT. Staging's
 *     commands are unchanged.
 *   - `--print-queries actual --env production` also prints the GO-LIVE
 *     queries verify.mjs needs for manifest (e) 8, 9, 10, 11, 13 and 18:
 *     `go_live_counts` (orders, payment events, checkouts, outbox, POD
 *     mappings and artwork, stored objects), `go_live_legal` (each tenant's
 *     legal readiness facts) and `storage_texts_<n>` (every text column of
 *     every table, lib/schema-text-columns.mjs). `--kind actual` reads them
 *     into a `goLive` section when they are there; some but not all of them
 *     refuses. The section holds counts and booleans only: the return address
 *     is read as "set or not" (the Worker's JavaScript trim), never kept.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSecure, ensureDir } from './lib/bundle-writer.mjs';
import { isInsideRepo } from './lib/outside-repo.mjs';
import { STORAGE_TEXTS_FILE_PREFIX, storageTextQueries, textColumnsByTable } from './lib/schema-text-columns.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function die(message) {
  console.error(`STATE-FROM-QUERIES REFUSED: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { env: null, from: null, kind: null, out: null, printQueries: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--print-queries') out.printQueries = argv[++i] ?? die('--print-queries needs a value (target|actual)');
    else if (arg === '--env') out.env = argv[++i] ?? die('--env needs a value');
    else if (arg === '--from') out.from = argv[++i] ?? die('--from needs a value');
    else if (arg === '--kind') out.kind = argv[++i] ?? die('--kind needs a value (target|actual)');
    else if (arg === '--out') out.out = argv[++i] ?? die('--out needs a value');
    else die(`unknown argument ${arg}`);
  }
  return out;
}

function assertOutsideRepo(resolvedPath) {
  if (isInsideRepo(resolvedPath, REPO_ROOT)) {
    die(`the state file must be written OUTSIDE the repo (it can contain email addresses): ${resolvedPath} resolves inside ${REPO_ROOT}`);
  }
}

function readPinned(env) {
  const pinnedPath = path.join(REPO_ROOT, 'cloudflare', `pinned.${env}.json`);
  if (!existsSync(pinnedPath)) {
    die(`cloudflare/pinned.${env}.json does not exist — cannot determine the D1 database name`);
  }
  return JSON.parse(readFileSync(pinnedPath, 'utf8'));
}

/**
 * The named queries this tool needs, one file per query (so `--from`'s
 * directory has one predictably-named file per query result). Each query is
 * `{ file, sql, sqlLabel }`; `file` is the base name (no extension) the
 * operator's output file must use inside the `--from` directory, e.g.
 * `users.json`.
 */
const TARGET_QUERIES = [
  {
    file: 'users',
    sql: `SELECT u."id" AS id, u."email" AS email, ia.account_type AS account_type, ia.status AS status FROM "user" AS u LEFT JOIN identity_access AS ia ON ia.user_id = u."id";`,
  },
  { file: 'identity_counts', sql: `SELECT account_type, status, COUNT(*) AS n FROM identity_access GROUP BY account_type, status;` },
  { file: 'tenants', sql: `SELECT tenant_id FROM tenants;` },
  { file: 'hostnames', sql: `SELECT hostname FROM tenant_domains;` },
  {
    file: 'pod_profiles',
    sql: `SELECT profile_id, label, min_dpi, print_area_w_mm, print_area_h_mm, max_file_mb, accepted_formats_json FROM pod_profiles;`,
  },
];

const ACTUAL_QUERIES = [
  {
    file: 'platform_settings',
    sql: `SELECT default_commission_bps, refund_application_fee, reverse_dispute_on_created, screening_hard_block, review_first_products FROM platform_settings WHERE id = 1;`,
  },
  { file: 'terms', sql: `SELECT term FROM content_screening_terms ORDER BY term;` },
  { file: 'print_defaults', sql: `SELECT default_printer_id FROM print_defaults WHERE id = 1;` },
  { file: 'printers', sql: `SELECT id, status, type FROM printers;` },
  { file: 'tenants', sql: `SELECT tenant_id, status, published FROM tenants ORDER BY tenant_id;` },
  { file: 'tenant_features_pod', sql: `SELECT tenant_id, enabled FROM tenant_features WHERE feature_key = 'pod';` },
  {
    file: 'connect_facts',
    sql: `SELECT tenant_id, connect_enabled, stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled, payout_delay_days, commission_bps, vat_rate_bp FROM tenants ORDER BY tenant_id;`,
  },
  {
    file: 'identity_counts',
    sql: `SELECT account_type, status, COUNT(*) AS n FROM identity_access GROUP BY account_type, status;`,
  },
  { file: 'pod_profiles', sql: `SELECT profile_id FROM pod_profiles ORDER BY profile_id;` },
];

/**
 * CP7-T2: the go-live queries of verify.mjs (production only). Each is one
 * SELECT of scalar subqueries; none is a compound SELECT.
 */
const GO_LIVE_QUERIES = [
  {
    file: 'go_live_counts',
    sql: [
      'SELECT (SELECT COUNT(*) FROM orders) AS orders,',
      '(SELECT COUNT(*) FROM payment_events) AS payment_events,',
      '(SELECT COUNT(*) FROM checkouts) AS checkouts,',
      '(SELECT COUNT(*) FROM outbox_events) AS outbox_events,',
      '(SELECT COUNT(*) FROM pod_mappings) AS pod_mappings,',
      '(SELECT COUNT(*) FROM pod_mappings AS m WHERE NOT EXISTS (SELECT 1 FROM pod_artwork AS a WHERE a.artwork_id = m.artwork_id AND a.tenant_id = m.tenant_id)) AS pod_mappings_unresolved,',
      '(SELECT COUNT(*) FROM pod_artwork) AS pod_artwork,',
      "(SELECT COUNT(*) FROM pod_artwork AS a WHERE EXISTS (SELECT 1 FROM pod_mappings AS m WHERE m.artwork_id = a.artwork_id AND m.tenant_id = a.tenant_id) AND (a.status IS NOT 'ready' OR a.print_object_key IS NULL OR a.print_sha256 IS NULL OR a.preview_object_key IS NULL OR a.preview_sha256 IS NULL)) AS pod_mapped_artwork_not_ready,",
      '(SELECT COUNT(*) FROM pod_artwork AS a WHERE a.profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM pod_profiles AS p WHERE p.profile_id = a.profile_id)) AS pod_artwork_profile_unresolved,',
      '(SELECT COUNT(*) FROM stored_objects) AS stored_objects,',
      "(SELECT COUNT(*) FROM stored_objects WHERE status IS NOT 'active' OR sha256 IS NULL OR length(sha256) != 64) AS stored_objects_not_active_with_sha256;",
    ].join(' '),
  },
  {
    file: 'go_live_legal',
    // The Worker's readLegalReadiness (src/legal/legal-pages.ts) and its
    // current platform terms version (src/legal/platform-terms.ts readTermsStatus).
    sql: [
      'SELECT t.tenant_id AS tenant_id, s.return_address AS return_address, s.vat_registered AS vat_registered,',
      "EXISTS (SELECT 1 FROM legal_acceptances AS a WHERE a.tenant_id = t.tenant_id AND a.type = 'legalPages') AS legal_pages_accepted,",
      "EXISTS (SELECT 1 FROM platform_terms_acceptances AS p WHERE p.tenant_id = t.tenant_id AND p.terms_version = (SELECT v.version FROM platform_terms_versions AS v WHERE v.published_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY v.published_at DESC, v.version DESC LIMIT 1)) AS current_terms_accepted",
      'FROM tenants AS t LEFT JOIN tenant_settings AS s ON s.tenant_id = t.tenant_id ORDER BY t.tenant_id;',
    ].join(' '),
  },
];

/** The go-live queries: the two fixed ones, then the text scan of the schema. */
function goLiveQueries() {
  return [...GO_LIVE_QUERIES, ...storageTextQueries(textColumnsByTable())];
}

/**
 * The preflight invocation a printed command runs through. Production reads
 * with `--bootstrap`, which admits d1 and skips the launch gate (see the header).
 */
function preflightCommand(env) {
  return env === 'production' ? 'scripts/cf-preflight.sh production --bootstrap --' : `scripts/cf-preflight.sh ${env} --`;
}

function printQueries(kind, env) {
  const pinned = readPinned(env);
  const dbName = pinned.d1?.name;
  if (!dbName) die(`cloudflare/pinned.${env}.json has no d1.name`);

  const base = kind === 'target' ? TARGET_QUERIES : kind === 'actual' ? ACTUAL_QUERIES : die(`--print-queries must be "target" or "actual", got ${JSON.stringify(kind)}`);
  const queries = kind === 'actual' && env === 'production' ? [...base, ...goLiveQueries()] : base;

  console.log(`# Read-only ${kind}-state queries for env=${env}, database=${dbName}.`);
  console.log('# Run each through the preflight script, redirecting into a named file in a');
  console.log('# directory you choose (the directory holds addresses — keep it outside the repo).');
  console.log('#');
  console.log(`# mkdir -p /path/outside/repo/state-queries-${kind}`);
  for (const q of queries) {
    console.log('');
    console.log(`# -> ${q.file}.json`);
    console.log(`${preflightCommand(env)} d1 execute ${dbName} --remote --json --command="${q.sql.replace(/"/g, '\\"')}" > /path/outside/repo/state-queries-${kind}/${q.file}.json`);
  }
  console.log('');
  console.log(`node scripts/cf-port/migrate/state-from-queries.mjs --from /path/outside/repo/state-queries-${kind} --kind ${kind} --out /path/outside/repo/${kind}-state.json`);
}

/**
 * `wrangler d1 execute ... --json` output can have leading lines that are
 * NOT JSON (the preflight script's own progress lines print to stdout in
 * some wrangler versions before the JSON array). This tolerates that by
 * taking the text from the first line that starts with `[`.
 */
function extractJsonArray(rawText) {
  const lines = rawText.split('\n');
  const startIndex = lines.findIndex((line) => line.trimStart().startsWith('['));
  if (startIndex === -1) {
    throw new Error('no line starting with "[" was found — expected wrangler\'s --json array output');
  }
  const jsonText = lines.slice(startIndex).join('\n');
  return JSON.parse(jsonText);
}

/** `wrangler d1 execute --json` shape: an array with one object holding `results`. */
function resultsOf(parsedArray) {
  const first = Array.isArray(parsedArray) ? parsedArray[0] : null;
  if (first === null || !Array.isArray(first.results)) {
    throw new Error('expected an array whose first element has a "results" array (wrangler d1 execute --json shape)');
  }
  return first.results;
}

function readQueryFile(fromDir, file) {
  const filePath = path.join(fromDir, `${file}.json`);
  if (!existsSync(filePath)) {
    die(`missing query output file: ${filePath} (run the query named "${file}" from --print-queries first)`);
  }
  const raw = readFileSync(filePath, 'utf8');
  try {
    return resultsOf(extractJsonArray(raw));
  } catch {
    // Never the parser's own message: it quotes the text, and the text of a
    // query result can be an address.
    return die(`${file}.json is not the output of "wrangler d1 execute --json" (an array whose first element has "results")`);
  }
}

/** Active identities per account type, from the grouped identity query. */
function activeCountsOf(rows) {
  const counts = { platform_admin: 0, tenant_admin: 0 };
  for (const row of rows) {
    if (row.status === 'active' && typeof row.account_type === 'string' && typeof row.n === 'number') {
      counts[row.account_type] = row.n;
    }
  }
  return counts;
}

function buildTargetState(fromDir) {
  const users = readQueryFile(fromDir, 'users');
  const emailToId = {};
  const identities = {};
  for (const row of users) {
    // Strict: a row this tool cannot read is never skipped and never guessed.
    // `null` means "this user has no identity row" and is reserved for the
    // LEFT JOIN's own pair of NULLs. A result of the earlier query (id and
    // email only) has neither column: read as null it would let an adoption
    // pass unchecked.
    if (typeof row?.id !== 'string' || typeof row.email !== 'string') {
      die('users.json holds a row without a text id and email');
    }
    if (!Object.hasOwn(row, 'account_type') || !Object.hasOwn(row, 'status')) {
      die('users.json has no account_type / status columns: it is the result of an earlier query. Run the users query of --print-queries target again');
    }
    const bothNull = row.account_type === null && row.status === null;
    const bothText = typeof row.account_type === 'string' && typeof row.status === 'string';
    if (!bothNull && !bothText) {
      die('users.json holds a row whose account_type and status are not both text or both NULL');
    }
    emailToId[row.email] = row.id;
    identities[row.id] = bothNull ? null : { accountType: row.account_type, status: row.status };
  }
  const activeCounts = activeCountsOf(readQueryFile(fromDir, 'identity_counts'));
  const activePlatformAdminCount = activeCounts.platform_admin;
  const tenantRows = readQueryFile(fromDir, 'tenants');
  const ids = tenantRows.map((r) => r.tenant_id).filter((id) => typeof id === 'string');
  const hostnameRows = readQueryFile(fromDir, 'hostnames');
  const hostnames = hostnameRows.map((r) => r.hostname).filter((h) => typeof h === 'string');
  const podProfileRows = readQueryFile(fromDir, 'pod_profiles');
  const podProfiles = {};
  for (const row of podProfileRows) {
    if (typeof row.profile_id === 'string') {
      podProfiles[row.profile_id] = {
        accepted_formats_json: row.accepted_formats_json,
        label: row.label,
        max_file_mb: row.max_file_mb,
        min_dpi: row.min_dpi,
        print_area_h_mm: row.print_area_h_mm,
        print_area_w_mm: row.print_area_w_mm,
      };
    }
  }
  return { hostnames, podProfiles, tenants: { ids }, users: { activeCounts, activePlatformAdminCount, emailToId, identities } };
}

/**
 * The state of the target AFTER the apply, as queried. It holds what the
 * database says and nothing else: what it is compared with comes from the
 * plan (plan.json `expected`), so a check can never compare a value with
 * itself.
 */
function buildActualState(fromDir) {
  const settings = readQueryFile(fromDir, 'platform_settings')[0] ?? {};
  const printDefaultsRows = readQueryFile(fromDir, 'print_defaults');
  const printerRows = readQueryFile(fromDir, 'printers');
  const tenantRows = readQueryFile(fromDir, 'tenants');
  const tenantFeaturesPodRows = readQueryFile(fromDir, 'tenant_features_pod');
  const connectFactsRows = readQueryFile(fromDir, 'connect_facts');

  const tenants = {};
  for (const row of tenantRows) {
    tenants[row.tenant_id] = { published: row.published === 1, status: row.status };
  }
  for (const row of connectFactsRows) {
    tenants[row.tenant_id] = {
      ...tenants[row.tenant_id],
      chargesEnabled: row.stripe_charges_enabled === 1,
      commissionBps: row.commission_bps ?? null,
      connectEnabled: row.connect_enabled === 1,
      payoutDelayDays: row.payout_delay_days ?? null,
      payoutsEnabled: row.stripe_payouts_enabled === 1,
      stripeAccountId: row.stripe_account_id ?? null,
      vatRateBp: row.vat_rate_bp ?? null,
    };
  }
  const tenantFeaturesPod = {};
  for (const row of tenantFeaturesPodRows) {
    tenantFeaturesPod[row.tenant_id] = row.enabled === 1;
  }

  const goLive = buildGoLiveSection(fromDir);
  return {
    ...(goLive === null ? {} : { goLive }),
    identityActive: activeCountsOf(readQueryFile(fromDir, 'identity_counts')),
    platformSettings: {
      defaultCommissionBps: settings.default_commission_bps,
      refundApplicationFee: settings.refund_application_fee === 1,
      reverseDisputeOnCreated: settings.reverse_dispute_on_created === 1,
      reviewFirstProducts: settings.review_first_products,
      screeningHardBlock: settings.screening_hard_block === 1,
    },
    podProfileIds: readQueryFile(fromDir, 'pod_profiles').map((r) => r.profile_id),
    printDefaults: { defaultPrinterId: printDefaultsRows[0]?.default_printer_id ?? null },
    printers: printerRows.map((r) => ({ id: r.id, status: r.status, type: r.type })),
    tenantFeaturesPod,
    tenants,
    terms: readQueryFile(fromDir, 'terms').map((r) => r.term),
  };
}

const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * CP7-T2: the go-live section of the actual state, or null when none of its
 * files is in the directory (a staging run, or production's earlier query
 * set). Some but not all of them refuses: a half-collected set would leave an
 * item without evidence. Counts and booleans only.
 */
function buildGoLiveSection(fromDir) {
  const expected = goLiveQueries().map((q) => q.file);
  const present = expected.filter((file) => existsSync(path.join(fromDir, `${file}.json`)));
  if (present.length === 0) return null;
  if (present.length !== expected.length) {
    die(`the go-live query files are incomplete: missing ${expected.filter((file) => !present.includes(file)).join(', ')} (run every query of --print-queries actual --env production)`);
  }
  const counts = readQueryFile(fromDir, 'go_live_counts')[0] ?? null;
  const countKeys = ['orders', 'payment_events', 'checkouts', 'outbox_events', 'pod_mappings', 'pod_mappings_unresolved', 'pod_artwork', 'pod_mapped_artwork_not_ready', 'pod_artwork_profile_unresolved', 'stored_objects', 'stored_objects_not_active_with_sha256'];
  if (counts === null || !countKeys.every((key) => isCount(counts[key]))) die('go_live_counts.json does not hold one row of counts (run the go_live_counts query again)');
  const legal = {};
  for (const row of readQueryFile(fromDir, 'go_live_legal')) {
    if (typeof row?.tenant_id !== 'string') die('go_live_legal.json holds a row without a tenant id');
    legal[row.tenant_id] = {
      currentTermsAccepted: row.current_terms_accepted === 1,
      legalPagesAccepted: row.legal_pages_accepted === 1,
      // The Worker's rule: a JavaScript trim, so a whitespace-only address is missing.
      returnAddress: typeof row.return_address === 'string' && row.return_address.trim().length > 0,
      vatAnswered: row.vat_registered === 0 || row.vat_registered === 1,
    };
  }
  const scanned = [];
  const hits = {};
  for (const file of expected.filter((name) => name.startsWith(STORAGE_TEXTS_FILE_PREFIX))) {
    const row = readQueryFile(fromDir, file)[0] ?? null;
    if (row === null || !Object.values(row).every(isCount)) die(`${file}.json does not hold one row of counts (run the ${file} query again)`);
    for (const [table, n] of Object.entries(row)) {
      scanned.push(table);
      if (n > 0) hits[table] = n;
    }
  }
  return { counts: Object.fromEntries(countKeys.map((key) => [key, counts[key]])), legal, storageTexts: { hits, scanned: scanned.sort() } };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.printQueries) {
    if (!args.env) die('--env is required with --print-queries');
    printQueries(args.printQueries, args.env);
    return;
  }

  if (!args.from || !args.kind || !args.out) {
    die('--from, --kind and --out are all required (or use --print-queries target|actual --env <env> alone)');
  }
  if (args.kind !== 'target' && args.kind !== 'actual') {
    die('--kind must be "target" or "actual"');
  }
  const resolvedOut = path.resolve(args.out);
  assertOutsideRepo(resolvedOut);
  const resolvedFrom = path.resolve(args.from);
  if (!existsSync(resolvedFrom)) die(`--from directory does not exist: ${resolvedFrom}`);

  const state = args.kind === 'target' ? buildTargetState(resolvedFrom) : buildActualState(resolvedFrom);

  ensureDir(path.dirname(resolvedOut));
  writeFileSecure(resolvedOut, Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf8'));
  console.log(`wrote: ${resolvedOut}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

export { parseArgs, assertOutsideRepo, extractJsonArray, resultsOf, buildTargetState, buildActualState, printQueries, preflightCommand, goLiveQueries, GO_LIVE_QUERIES, TARGET_QUERIES, ACTUAL_QUERIES, readPinned };
