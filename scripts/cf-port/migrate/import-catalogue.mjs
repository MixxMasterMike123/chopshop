#!/usr/bin/env node
/**
 * scripts/cf-port/migrate/import-catalogue.mjs — CP4 S2: bundle + copy
 * manifest + target state → a SECOND, additive plan (CP4_BRIEFS.md §S2).
 *
 *   node scripts/cf-port/migrate/import-catalogue.mjs --env staging --bundle <dir>
 *        --copy-manifest <file> --target-state <file> --out <dir outside the repo>
 *        [--email-map <file>] [--scrub-unmapped]
 *   node scripts/cf-port/migrate/import-catalogue.mjs --print-queries --env staging
 *   node scripts/cf-port/migrate/import-catalogue.mjs --state-from <dir> --state-out <file>
 *
 * Writes plan.sql, plan.json (with `expected`, which verify-catalogue.mjs
 * checks the target against) and apply.md. NEVER talks to D1, R2, the Worker
 * or the source: it reads local files and writes local files.
 *
 * Rows: 51 products (variants, images, tags, publication, screening), 20
 * collections, 40 pages, and the branding images of row 56 (D76) — an UPDATE
 * of the store identity CP3 wrote. Deferred with a count: 43 podArtwork (the
 * brief: not imported in this step), 44 podMappings (D83), 33
 * infringementReports (none in the export). The translations are
 * build-locales.mjs's (D16).
 *
 * The plan is ADDITIVE on top of the applied CP3 import: it refuses a target
 * without CP3's completed run of this very bundle, and a target that already
 * holds one of its rows (a product, variant, collection or page id, a sku, a
 * handle, a slug). It passes every check CP3's plan passes
 * (lib/plan-checks.mjs) and is deterministic: the clock is the bundle's
 * exportedAt, every id is kept or derived (lib/ids.mjs).
 *
 * STAGING ONLY: 0033 lets production complete ONE import run, so a second
 * plan cannot land there; the production cutover imports everything in one
 * run (open question in docs/cf-port/CP4_S2_REPORT.md).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBundle, EXPECTED_SCHEMA_VERSION } from './lib/verify-bundle.mjs';
import { bundleSha, readAuthUsers, readCollection, readRootManifest } from './lib/bundle-reader.mjs';
import { buildPlanSql, sha256Hex } from './lib/plan.mjs';
import { planSafetyProblems } from './lib/plan-checks.mjs';
import { writeFileSecure, ensureDir } from './lib/bundle-writer.mjs';
import { isInsideRepo } from './lib/outside-repo.mjs';
import { canonicalStringify } from './lib/typed-json.mjs';
import { emailMapFor } from './lib/scrub.mjs';
import { ARCHIVED_SHOP_IDS } from './lib/transform-shops.mjs';
import { indexCopyManifest, objectKeyOf, readCopyManifest } from './lib/copy-manifest.mjs';
import { loadWorkerRules } from './lib/worker-rules.mjs';
import { extractJsonArray, resultsOf } from './state-from-queries.mjs';
import { makeTextScrubber, newReport, transformProducts } from './lib/transform-products.mjs';
import { transformCollections } from './lib/transform-collections.mjs';
import { transformPages } from './lib/transform-pages.mjs';
import { transformBranding } from './lib/transform-branding.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The order the sections are written in: every row after the rows it names. */
export const SECTION_ORDER = [
  'products',
  'product_variants',
  'product_tags',
  'product_images',
  'product_publications',
  'product_screening',
  'collections',
  'collection_products',
  'pages',
  'tenant_settings',
];

export const DEFERRED = [
  { reason: 'podArtwork: not imported in this step (CP4_BRIEFS.md §S); it serves the print mappings, tied again in the admin (D83)', row: 43 },
  { reason: 'podMappings: not imported (D83); the POD products are imported without a mapping and stay off the storefront until mapped', row: 44 },
  { reason: 'infringementReports: the export holds none (D72)', row: 33 },
];

const PLAN_HEADER_CP3 = '-- scripts/cf-port/migrate/import.mjs — generated import plan.';
const PLAN_HEADER = '-- scripts/cf-port/migrate/import-catalogue.mjs — generated catalogue plan (CP4 S2), additive to the CP3 import.';

function die(message) {
  console.error(`IMPORT-CATALOGUE REFUSED: ${message}`);
  process.exit(1);
}

// ── the target state: read-only queries → one JSON file ──────────────────────

/** Rows per shop of every table the plan writes into (before and after the apply). */
export const COUNTS_SQL = [
  "SELECT 'products' AS t, tenant_id, COUNT(*) AS n FROM products GROUP BY tenant_id",
  "SELECT 'podProducts', tenant_id, COUNT(*) FROM products WHERE is_pod = 1 GROUP BY tenant_id",
  "SELECT 'variants', tenant_id, COUNT(*) FROM product_variants GROUP BY tenant_id",
  "SELECT 'tags', tenant_id, COUNT(*) FROM product_tags GROUP BY tenant_id",
  "SELECT 'images', tenant_id, COUNT(*) FROM product_images GROUP BY tenant_id",
  "SELECT 'publications', tenant_id, COUNT(*) FROM product_publications WHERE published = 1 GROUP BY tenant_id",
  "SELECT 'screening', tenant_id, COUNT(*) FROM product_screening GROUP BY tenant_id",
  "SELECT 'collections', tenant_id, COUNT(*) FROM collections GROUP BY tenant_id",
  "SELECT 'collectionMembers', tenant_id, COUNT(*) FROM collection_products GROUP BY tenant_id",
  "SELECT 'pages', tenant_id, COUNT(*) FROM pages GROUP BY tenant_id",
].join(' UNION ALL ') + ';';

/** The counts query's rows → { tenantId: { table: n } }. */
export function countsOf(rows) {
  const out = {};
  for (const r of rows) {
    if (typeof r.t !== 'string' || typeof r.tenant_id !== 'string' || typeof r.n !== 'number') throw new Error('counts.json holds a row of an unexpected shape');
    out[r.tenant_id] ??= {};
    out[r.tenant_id][r.t] = r.n;
  }
  return out;
}

/** The queries whose results make --target-state. Read-only. */
export function targetQueries(env) {
  return [
    { file: 'counts', sql: COUNTS_SQL },
    { file: 'import_runs', sql: 'SELECT run_id, env, bundle_sha, status FROM import_runs ORDER BY started_at, run_id;' },
    { file: 'tenants', sql: 'SELECT tenant_id, status, published, default_currency, catalog_version FROM tenants ORDER BY tenant_id;' },
    { file: 'tenant_settings', sql: 'SELECT tenant_id, store_identity_json, updated_at, updated_by FROM tenant_settings ORDER BY tenant_id;' },
    { file: 'users', sql: `SELECT legacy_id, new_id FROM legacy_id_map WHERE kind = 'user' AND env = '${env}' ORDER BY legacy_id;` },
    { file: 'products', sql: 'SELECT product_id, tenant_id, sku, handle FROM products ORDER BY tenant_id, product_id;' },
    { file: 'variants', sql: 'SELECT variant_id, tenant_id, sku FROM product_variants ORDER BY tenant_id, variant_id;' },
    { file: 'collections', sql: 'SELECT collection_id, tenant_id, handle, external_ref FROM collections ORDER BY tenant_id, collection_id;' },
    { file: 'pages', sql: 'SELECT page_id, tenant_id, slug FROM pages ORDER BY tenant_id, page_id;' },
    { file: 'objects', sql: "SELECT object_id, tenant_id, bucket, kind, status, object_key FROM stored_objects WHERE bucket = 'public' ORDER BY object_id;" },
  ];
}

export function readPinned(env) {
  const pinnedPath = path.join(REPO_ROOT, 'cloudflare', `pinned.${env}.json`);
  return existsSync(pinnedPath) ? JSON.parse(readFileSync(pinnedPath, 'utf8')) : null;
}

/** The commands a person runs (through the preflight script) to collect the results. */
export function printQueryCommands(queries, { env, kind, tool }) {
  const dbName = readPinned(env)?.d1?.name ?? '<DATABASE_NAME>';
  const lines = [
    `# Read-only ${kind} queries for env=${env}, database=${dbName}.`,
    '# Each result goes into a named file of ONE directory outside the repository',
    '# (the results hold shop texts and addresses).',
    `# mkdir -p /path/outside/repo/${kind}-queries`,
  ];
  for (const query of queries) {
    const sql = query.sql.replace(/\s+/g, ' ').trim();
    lines.push('', `# -> ${query.file}.json`);
    lines.push(`scripts/cf-preflight.sh ${env} -- d1 execute ${dbName} --remote --json --command="${sql.replace(/"/g, '\\"')}" > /path/outside/repo/${kind}-queries/${query.file}.json`);
  }
  lines.push('', `node scripts/cf-port/migrate/${tool} --state-from /path/outside/repo/${kind}-queries --state-out /path/outside/repo/${kind}-state.json`);
  return lines.join('\n');
}

/** The rows of one query's result file (wrangler d1 execute --json). */
export function readResultFile(dir, file) {
  const filePath = path.join(dir, `${file}.json`);
  if (!existsSync(filePath)) throw new Error(`missing query result ${file}.json (run the query of that name first)`);
  try {
    return resultsOf(extractJsonArray(readFileSync(filePath, 'utf8')));
  } catch {
    // Never the parser's message: it quotes the text, which can hold an address.
    throw new Error(`${file}.json is not the output of "wrangler d1 execute --json"`);
  }
}

function text(value) {
  return typeof value === 'string' ? value : null;
}

/** The query results → the --target-state object. Strict: an unreadable row refuses. */
export function buildTargetState(dir) {
  const rows = (file) => readResultFile(dir, file);
  const need = (condition, file) => {
    if (!condition) throw new Error(`${file}.json holds a row of an unexpected shape`);
  };
  const state = { collections: [], counts: countsOf(rows('counts')), importRuns: [], objects: {}, pages: [], products: [], settings: {}, tenants: {}, users: {}, variants: [] };
  for (const r of rows('import_runs')) {
    need(text(r.run_id) && text(r.env) && text(r.bundle_sha) && text(r.status), 'import_runs');
    state.importRuns.push({ bundleSha: r.bundle_sha, env: r.env, runId: r.run_id, status: r.status });
  }
  for (const r of rows('tenants')) {
    need(text(r.tenant_id) && text(r.status) && typeof r.published === 'number' && text(r.default_currency) && typeof r.catalog_version === 'number', 'tenants');
    state.tenants[r.tenant_id] = { catalogVersion: r.catalog_version, currency: r.default_currency, published: r.published === 1, status: r.status };
  }
  for (const r of rows('tenant_settings')) {
    need(text(r.tenant_id) && text(r.store_identity_json) && text(r.updated_at) && text(r.updated_by), 'tenant_settings');
    state.settings[r.tenant_id] = { storeIdentityJson: r.store_identity_json, updatedAt: r.updated_at, updatedBy: r.updated_by };
  }
  for (const r of rows('users')) {
    need(text(r.legacy_id) && text(r.new_id), 'users');
    state.users[r.legacy_id] = r.new_id;
  }
  for (const r of rows('products')) {
    need(text(r.product_id) && text(r.tenant_id) && text(r.sku), 'products');
    state.products.push({ handle: text(r.handle), productId: r.product_id, sku: r.sku, tenantId: r.tenant_id });
  }
  for (const r of rows('variants')) {
    need(text(r.variant_id) && text(r.tenant_id) && text(r.sku), 'variants');
    state.variants.push({ sku: r.sku, tenantId: r.tenant_id, variantId: r.variant_id });
  }
  for (const r of rows('collections')) {
    need(text(r.collection_id) && text(r.tenant_id) && text(r.handle), 'collections');
    state.collections.push({ collectionId: r.collection_id, externalRef: text(r.external_ref), handle: r.handle, tenantId: r.tenant_id });
  }
  for (const r of rows('pages')) {
    need(text(r.page_id) && text(r.tenant_id) && text(r.slug), 'pages');
    state.pages.push({ pageId: r.page_id, slug: r.slug, tenantId: r.tenant_id });
  }
  for (const r of rows('objects')) {
    need(text(r.object_id) && text(r.tenant_id) && text(r.bucket) && text(r.kind) && text(r.status) && text(r.object_key), 'objects');
    state.objects[r.object_id] = { bucket: r.bucket, kind: r.kind, objectKey: r.object_key, status: r.status, tenantId: r.tenant_id };
  }
  return state;
}

function targetStateProblems(state) {
  const problems = [];
  for (const key of ['collections', 'importRuns', 'pages', 'products', 'variants']) {
    if (!Array.isArray(state?.[key])) problems.push(`--target-state has no ${key} list (build it with --state-from)`);
  }
  for (const key of ['counts', 'objects', 'settings', 'tenants', 'users']) {
    if (state?.[key] === null || typeof state?.[key] !== 'object' || Array.isArray(state[key])) problems.push(`--target-state has no ${key} map (build it with --state-from)`);
  }
  return problems;
}

// ── the target's own rows: refused when the plan would write one again ───────

function collisionProblems(sections, state) {
  const problems = [];
  const has = (list) => new Set(list);
  const productIds = has(state.products.map((p) => p.productId));
  const productSkus = has(state.products.map((p) => `${p.tenantId}\n${p.sku}`));
  const handles = has(state.products.filter((p) => p.handle !== null).map((p) => `${p.tenantId}\n${p.handle}`));
  const variantIds = has(state.variants.map((v) => v.variantId));
  const variantSkus = has(state.variants.map((v) => `${v.tenantId}\n${v.sku}`));
  const collectionNames = has(state.collections.flatMap((c) => [c.collectionId, `${c.tenantId}\n${c.handle}`, ...(c.externalRef ? [`${c.tenantId}\n${c.externalRef}`] : []), `${c.tenantId}\n${c.collectionId}`]));
  const pageIds = has(state.pages.map((p) => p.pageId));
  const slugs = has(state.pages.map((p) => `${p.tenantId}\n${p.slug}`));
  const tally = {};
  const hit = (what) => {
    tally[what] = (tally[what] ?? 0) + 1;
  };
  const values = (row) => row.values;
  for (const row of sections.products) {
    const v = values(row);
    if (productIds.has(v.product_id)) hit('product id');
    if (productSkus.has(`${v.tenant_id}\n${v.sku}`)) hit('product sku');
    if (handles.has(`${v.tenant_id}\n${v.handle}`)) hit('product handle');
  }
  for (const row of sections.product_variants) {
    const v = values(row);
    if (variantIds.has(v.variant_id)) hit('variant id');
    if (variantSkus.has(`${v.tenant_id}\n${v.sku}`)) hit('variant sku');
  }
  for (const row of sections.collections) {
    const v = values(row);
    if (collectionNames.has(v.collection_id) || collectionNames.has(`${v.tenant_id}\n${v.handle}`) || collectionNames.has(`${v.tenant_id}\n${v.collection_id}`)) hit('collection id or handle');
  }
  for (const row of sections.pages) {
    const v = values(row);
    if (pageIds.has(v.page_id) || slugs.has(`${v.tenant_id}\n${v.slug}`)) hit('page id or slug');
  }
  for (const [what, n] of Object.entries(tally)) problems.push(`REFUSED: the target already holds ${n} row(s) this plan writes (${what}): the catalogue was imported before, or the shop was written by hand`);
  return problems;
}

/** Every object the plan names must be the copied object in the target, active, public, of the kind, of the shop, under the key. */
function objectProblems(usedObjects, state) {
  const tally = {};
  for (const used of usedObjects) {
    const object = state.objects[used.objectId];
    let reason = null;
    if (object === undefined) reason = 'not in the target';
    else if (object.tenantId !== used.tenantId) reason = 'of another shop';
    else if (object.bucket !== 'public' || object.status !== 'active') reason = 'not an active public object';
    else if (object.kind !== used.kind) reason = 'of another kind';
    else if (object.objectKey !== objectKeyOf(used.entry)) reason = 'under another key than the copy recorded';
    if (reason !== null) tally[reason] = (tally[reason] ?? 0) + 1;
  }
  return Object.entries(tally).map(([reason, n]) => `REFUSED: ${n} object id(s) of the copy manifest are ${reason}: the manifest does not describe this target`);
}

// ── the run ─────────────────────────────────────────────────────────────────

export async function runImportCatalogue({ bundleDir, copyManifestPath, emailMapPath = null, env, now = null, scrubUnmapped = false, targetStatePath }) {
  try {
    return await runUnsafe({ bundleDir, copyManifestPath, emailMapPath, env, now, scrubUnmapped, targetStatePath });
  } catch (error) {
    return { ok: false, problems: [error?.message ?? String(error)] };
  }
}

async function runUnsafe({ bundleDir, copyManifestPath, emailMapPath, env, now, scrubUnmapped, targetStatePath }) {
  if (env !== 'staging') {
    return { ok: false, problems: ['REFUSED: --env must be staging. 0033 completes ONE production import run; the catalogue of production is imported in that one run (see the report)'] };
  }
  const verify = verifyBundle(bundleDir);
  if (!verify.ok) return { ok: false, problems: ['bundle verification failed', ...verify.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)] };
  const rootManifest = readRootManifest(bundleDir);
  if (rootManifest.schemaVersion !== EXPECTED_SCHEMA_VERSION) return { ok: false, problems: [`bundle schemaVersion ${rootManifest.schemaVersion} is not ${EXPECTED_SCHEMA_VERSION}`] };
  const nowDate = typeof now === 'function' ? now() : new Date(rootManifest.exportedAt);
  if (Number.isNaN(nowDate.getTime())) return { ok: false, problems: ['the bundle manifest has no usable exportedAt: the plan has no clock'] };
  const nowMillis = nowDate.getTime();
  const nowIso = nowDate.toISOString();
  const bSha = bundleSha(bundleDir);

  const problems = [];
  const reportLines = [];

  // The copy manifest: of this bundle and this environment.
  if (!copyManifestPath) return { ok: false, problems: ['--copy-manifest is required'] };
  const copyManifestText = readFileSync(copyManifestPath, 'utf8');
  const copyManifest = readCopyManifest(copyManifestPath);
  if (copyManifest.env !== env) problems.push(`REFUSED: the copy manifest is of ${copyManifest.env}, not ${env}`);
  if (copyManifest.bundleManifestSha256 !== sha256Hex(readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'))) {
    problems.push('REFUSED: the copy manifest was not made from this bundle (bundleManifestSha256 differs)');
  }

  // The target state: CP3's run of this bundle, and no run of our own.
  if (!targetStatePath) return { ok: false, problems: ['--target-state is required: the plan is additive to the applied CP3 import'] };
  const targetStateText = readFileSync(targetStatePath, 'utf8');
  const state = JSON.parse(targetStateText);
  const shapeProblems = targetStateProblems(state);
  if (shapeProblems.length > 0) return { ok: false, problems: shapeProblems };

  const emailMapRaw = emailMapPath === null ? {} : JSON.parse(readFileSync(emailMapPath, 'utf8'));
  const emailMap = emailMapFor(env, emailMapRaw);
  const optionsFingerprint = sha256Hex(
    canonicalStringify({ copyManifest: sha256Hex(copyManifestText), emailMap: emailMapRaw ?? {}, scrubUnmapped, targetState: sha256Hex(targetStateText) }),
  );
  const runId = `catalogue_${env}_${bSha.slice(0, 16)}_${optionsFingerprint.slice(0, 16)}`;

  const cp3 = state.importRuns.find((run) => run.env === env && run.bundleSha === bSha && run.status === 'completed' && !run.runId.startsWith('catalogue_'));
  if (cp3 === undefined) problems.push('REFUSED: the target holds no completed CP3 import run of this bundle: apply CP3 first (import.mjs)');
  if (state.importRuns.some((run) => run.runId === runId)) problems.push('REFUSED: the target already holds this plan\'s run id: it was applied before');
  if (state.importRuns.some((run) => run.env === env && run.status === 'running')) problems.push('REFUSED: an import run is still running on the target: close it first (apply.md of CP3, step 4)');
  if (state.importRuns.some((run) => run.env === env && run.status === 'completed' && run.bundleSha === bSha && run.runId.startsWith('catalogue_'))) {
    problems.push('REFUSED: the target already holds a completed catalogue run of this bundle');
  }

  // The shops: the bundle's, not archived (D21), that CP3 imported.
  const shopDocs = readCollection(bundleDir, 'shops');
  const tenantEntries = [];
  for (const doc of shopDocs) {
    if (ARCHIVED_SHOP_IDS.has(doc.id)) continue;
    const tenant = state.tenants[doc.id];
    if (tenant === undefined) {
      reportLines.push(`shops/${doc.id}: not in the target, its rows are not imported`);
      continue;
    }
    tenantEntries.push([doc.id, { currency: tenant.currency }]);
  }
  const tenants = new Map(tenantEntries.sort(([a], [b]) => (a < b ? -1 : 1)));

  const rules = await loadWorkerRules();
  const pinned = readPinned(env);
  const publicBase = rules.publicObjectBase({ PUBLIC_OBJECT_BASE_URL: pinned?.r2?.publicBaseUrl });
  const scrubber = makeTextScrubber({ emailMap, scrubUnmapped });
  const report = newReport();
  const ctx = {
    env,
    index: indexCopyManifest(copyManifest),
    nowMillis,
    problems,
    publicBase,
    report,
    rules,
    textScrub: scrubber.scrub,
    usedObjects: [],
    userIds: new Map(Object.entries(state.users)),
  };

  const productDocs = readCollection(bundleDir, 'products');
  const collectionDocs = readCollection(bundleDir, 'collections');
  const pageDocs = readCollection(bundleDir, 'pages');
  const products = transformProducts({ ctx, docs: productDocs, tenants });
  const expectedByShop = products.expected;
  const collections = transformCollections({ ctx, docs: collectionDocs, expected: expectedByShop, products: products.products, tenants });
  const pages = transformPages({ ctx, docs: pageDocs, expected: expectedByShop, tenants });
  const branding = transformBranding({ ctx, settings: new Map(Object.entries(state.settings)), shops: shopDocs, tenants });

  const bySection = { ...products.sections, ...collections.sections, ...pages.sections, ...branding.sections };
  problems.push(...collisionProblems(bySection, state));
  problems.push(...objectProblems(ctx.usedObjects, state));

  const sections = SECTION_ORDER.map((name) => ({ name, rows: bySection[name] ?? [] }));
  const build = (planSha) => {
    const built = buildPlanSql({ bundleSha: bSha, env, finishedAt: nowIso, planSha, runId, startedAt: nowIso }, sections, planSha);
    if (!built.text.startsWith(`${PLAN_HEADER_CP3}\n`)) throw new Error('INTERNAL: lib/plan.mjs changed its header; re-read it');
    return { counts: built.counts, text: `${PLAN_HEADER}\n${built.text.slice(PLAN_HEADER_CP3.length + 1)}` };
  };
  const draft = build('0'.repeat(64));
  const planSha = sha256Hex(draft.text);
  const final = build(planSha);

  const safety = planSafetyProblems({
    emailMap,
    env,
    planText: final.text,
    rows: sections.flatMap((section) => section.rows),
    // Every address of every document this plan reads: the catalogue texts,
    // the shops, and the people (a user's address inside a text is refused too).
    sourceDocs: {
      authUsers: readAuthUsers(bundleDir),
      shops: [...shopDocs, ...productDocs, ...collectionDocs, ...pageDocs],
      users: readCollection(bundleDir, 'users'),
    },
  });
  problems.push(...safety.problems);

  const statementLines = final.text.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('--'));
  const longestStatementBytes = Math.max(...statementLines.map((line) => Buffer.byteLength(line, 'utf8')));

  // Deferred rows, with their counts.
  const deferred = DEFERRED.map((d) => ({ ...d, count: readCollection(bundleDir, { 33: 'infringementReports', 43: 'podArtwork', 44: 'podMappings' }[d.row]).length }));
  for (const d of deferred) reportLines.push(`row ${d.row} deferred (${d.count} in the export): ${d.reason}`);
  if (scrubber.actions.mapped + scrubber.actions.scrubbed > 0) {
    reportLines.push(`e-mail addresses inside written texts: ${scrubber.actions.mapped} mapped, ${scrubber.actions.scrubbed} scrubbed (staging, D20)`);
  }

  // What the target must hold after the apply (verify-catalogue.mjs).
  const shops = {};
  for (const [tenantId] of tenants) {
    const e = expectedByShop[tenantId] ?? {};
    shops[tenantId] = {
      catalogVersionBefore: state.tenants[tenantId].catalogVersion,
      countsBefore: state.counts[tenantId] ?? {},
      collectionMembers: e.collectionMembers ?? 0,
      collections: e.collections ?? 0,
      images: e.images ?? 0,
      pages: e.pages ?? 0,
      podProducts: e.podProducts ?? 0,
      productIds: [],
      products: e.products ?? 0,
      publications: e.publications ?? 0,
      publicIfLive: e.publicIfLive ?? [],
      screening: e.screening ?? 0,
      sourcePublic: e.sourcePublic ?? 0,
      tags: e.tags ?? 0,
      variants: e.variants ?? 0,
    };
  }
  for (const [productId, facts] of Object.entries(products.products)) shops[facts.shopId].productIds.push(productId);
  for (const shop of Object.values(shops)) shop.productIds.sort();
  const expected = {
    branding: branding.expected,
    objects: [...new Set(ctx.usedObjects.map((u) => `${u.tenantId}\n${u.kind}\n${u.objectId}`))].sort().map((key) => {
      const [tenantId, kind, objectId] = key.split('\n');
      return { kind, objectId, tenantId };
    }),
    runId,
    shops,
    sourcePublicTotal: Object.values(shops).reduce((n, s) => n + s.sourcePublic, 0),
    podPublishedTotal: Object.values(shops).reduce((n, s) => n + (s.sourcePublic - s.publicIfLive.length), 0),
    publicIfLiveTotal: Object.values(shops).reduce((n, s) => n + s.publicIfLive.length, 0),
  };

  const planJson = {
    bundleSha: bSha,
    copyManifestSha: sha256Hex(copyManifestText),
    counts: final.counts,
    deferred,
    env,
    expected,
    longestStatementBytes,
    planSha,
    problems,
    report: report.byShop,
    reportLines,
    runId,
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    statementCount: statementLines.length,
  };
  return { ok: problems.length === 0, planJson, planSha, planText: final.text, problems, reportLines, runId };
}

export function buildApplyMd({ env, planSha, runId }) {
  const dbName = readPinned(env)?.d1?.name ?? `<DATABASE_NAME from cloudflare/pinned.${env}.json>`;
  return `# Apply the catalogue plan (CP4 S2)

**Environment:** ${env}
**Plan sha256:** ${planSha}
**Run id:** ${runId}
**Database:** ${dbName}

This plan is ADDITIVE: it runs after CP3's applied import and after the file
copy (storage-copy.mjs), whose manifest it names objects from.

## 1. Record a Time Travel bookmark first

\`\`\`
scripts/cf-preflight.sh ${env} -- d1 time-travel info ${dbName}
\`\`\`

## 2. Apply

\`\`\`
scripts/cf-preflight.sh ${env} -- d1 execute ${dbName} --remote --file=plan.sql
\`\`\`

The first statement opens the run (\`import_runs\`, a plain INSERT: re-applying
this exact file refuses on its first line). The last closes it \`completed\`.
If the apply stops halfway: confirm the run is still \`running\`, then apply the
file again WITHOUT its first statement (every row is INSERT OR IGNORE with its
row hash; the UPDATE of a store identity is guarded on the text it replaces).
To abandon it: \`UPDATE import_runs SET status = 'failed', finished_at =
strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id = '${runId}' AND status = 'running';\`

## 3. Screen the imported products (never approved by the importer)

Every published product was imported with a screening row whose term version
is EMPTY (D72). Screen them with the platform's route, under a platform
session, until \`pending\` answers 0:

\`\`\`
POST /v1/platform/screening-terms/rescreen      (repeat until "pending": 0)
\`\`\`

A product the sweep finds a hard-blocked term on becomes \`blocked\` (off the
storefront); a hit becomes \`flagged\` (public, in the review queue).

## 4. Verify

\`\`\`
node scripts/cf-port/migrate/verify-catalogue.mjs --print-queries --env ${env}
\`\`\`
prints the read-only queries; run them into a directory outside the repository, then
\`\`\`
node scripts/cf-port/migrate/verify-catalogue.mjs --state-from <that directory> --state-out <actual-state file>
node scripts/cf-port/migrate/verify-catalogue.mjs --env ${env} --bundle <bundle dir> --plan <this plan dir> --actual-state <actual-state file>
\`\`\`
`;
}

function parseArgs(argv) {
  const out = { bundle: null, copyManifest: null, emailMap: null, env: null, out: null, printQueries: false, scrubUnmapped: false, stateFrom: null, stateOut: null, targetState: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env') out.env = argv[++i] ?? die('--env needs a value');
    else if (arg === '--bundle') out.bundle = argv[++i] ?? die('--bundle needs a value');
    else if (arg === '--copy-manifest') out.copyManifest = argv[++i] ?? die('--copy-manifest needs a value');
    else if (arg === '--target-state') out.targetState = argv[++i] ?? die('--target-state needs a value');
    else if (arg === '--out') out.out = argv[++i] ?? die('--out needs a value');
    else if (arg === '--email-map') out.emailMap = argv[++i] ?? die('--email-map needs a value');
    else if (arg === '--scrub-unmapped') out.scrubUnmapped = true;
    else if (arg === '--print-queries') out.printQueries = true;
    else if (arg === '--state-from') out.stateFrom = argv[++i] ?? die('--state-from needs a value');
    else if (arg === '--state-out') out.stateOut = argv[++i] ?? die('--state-out needs a value');
    else die(`unknown argument ${arg}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.printQueries) {
    if (args.env !== 'staging') die('--print-queries needs --env staging');
    console.log(printQueryCommands(targetQueries(args.env), { env: args.env, kind: 'catalogue-target', tool: 'import-catalogue.mjs' }));
    return;
  }
  if (args.stateFrom !== null) {
    if (args.stateOut === null) die('--state-from needs --state-out');
    const out = path.resolve(args.stateOut);
    if (isInsideRepo(out, REPO_ROOT)) die(`--state-out resolves inside the repository (${REPO_ROOT}): the state holds shop texts`);
    let state;
    try {
      state = buildTargetState(path.resolve(args.stateFrom));
    } catch (error) {
      die(error.message);
    }
    ensureDir(path.dirname(out));
    writeFileSecure(out, Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8'));
    console.log(`wrote: ${out}`);
    return;
  }
  if (!args.bundle || !args.out || !args.copyManifest || !args.targetState) die('--env, --bundle, --copy-manifest, --target-state and --out are required');
  const out = path.resolve(args.out);
  if (isInsideRepo(out, REPO_ROOT)) die(`--out ${out} resolves inside the repository (${REPO_ROOT}); the plan must be written OUTSIDE it`);
  const result = await runImportCatalogue({
    bundleDir: path.resolve(args.bundle),
    copyManifestPath: path.resolve(args.copyManifest),
    emailMapPath: args.emailMap ? path.resolve(args.emailMap) : null,
    env: args.env,
    scrubUnmapped: args.scrubUnmapped,
    targetStatePath: path.resolve(args.targetState),
  });
  if (!result.ok) {
    console.log('\n▸ REFUSED — problems found');
    for (const problem of result.problems) console.log(`  ! ${problem}`);
    process.exit(1);
  }
  console.log('\n▸ plan built');
  for (const [name, n] of Object.entries(result.planJson.counts)) console.log(`  ${name.padEnd(24)} ${n}`);
  console.log(`  statements ${result.planJson.statementCount}, longest ${result.planJson.longestStatementBytes} bytes`);
  console.log('\n▸ per shop (counts only)');
  for (const [shop, counts] of Object.entries(result.planJson.report)) {
    console.log(`  ${shop}`);
    for (const [key, n] of Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))) console.log(`    ${key.padEnd(58)} ${n}`);
  }
  for (const line of result.reportLines) console.log(`  - ${line}`);
  ensureDir(out);
  writeFileSecure(path.join(out, 'plan.sql'), Buffer.from(result.planText, 'utf8'));
  writeFileSecure(path.join(out, 'plan.json'), Buffer.from(`${JSON.stringify(result.planJson, null, 2)}\n`, 'utf8'));
  writeFileSecure(path.join(out, 'apply.md'), Buffer.from(buildApplyMd({ env: args.env, planSha: result.planSha, runId: result.runId }), 'utf8'));
  console.log(`\n▸ done\n  plan sha256: ${result.planSha}\n  wrote: ${out}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}

export { parseArgs };
