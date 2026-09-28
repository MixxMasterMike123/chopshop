#!/usr/bin/env node
/**
 * scripts/cf-port/migrate/verify-catalogue.mjs — the catalogue plan's result →
 * PASS/FAIL, check by check (CP4_BRIEFS.md §S2 item 10), as verify.mjs does
 * for CP3.
 *
 *   node scripts/cf-port/migrate/verify-catalogue.mjs --print-queries --env staging
 *   node scripts/cf-port/migrate/verify-catalogue.mjs --state-from <dir> --state-out <file>
 *   node scripts/cf-port/migrate/verify-catalogue.mjs --env staging --bundle <dir>
 *        --plan <plan dir> --actual-state <file>
 *
 * NEVER talks to D1: the actual state is a file a person makes from read-only
 * queries after the apply. TWO SIDES, NEVER ONE: what the target holds comes
 * from --actual-state, what it must hold from plan.json `expected` (built from
 * the rows the plan wrote, and from the target state before the apply). The
 * public projection is counted with the Worker's own predicate
 * (src/catalog/eligibility.ts), imported, not copied.
 *
 * Checks:
 *   run          the plan's import run is completed
 *   counts       rows per shop and table = before the apply + the plan's
 *   ids          every product id of the plan is in its shop
 *   handle       no product of the plan's shops without its handle
 *   public       the public projection per shop, as it will be once the shop
 *                is live (the shop gate lifted), = the plan's published,
 *                non-POD products — for the four shops 199, the source's 205
 *                less its 6 POD products (D83); and the projection NOW equals
 *                it for every live shop and is empty for a shop not yet live
 *   objects      no image row, cover or page image without its object, or with
 *                an object that is not the shop's own active public product
 *                media; every image id of a store identity is the shop's own
 *                active public branding object and the one the plan wrote
 *   screening    no imported product is approved; the count still waiting
 *                for the re-screen route is printed
 *   storage      no text of a product or page names the source's storage
 *   version      catalog_version moved for every shop the plan wrote to
 *   bundle       the bundle the plan was built from verifies
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBundle } from './lib/verify-bundle.mjs';
import { bundleSha } from './lib/bundle-reader.mjs';
import { writeFileSecure, ensureDir } from './lib/bundle-writer.mjs';
import { isInsideRepo } from './lib/outside-repo.mjs';
import { SOURCE_STORAGE_MARKERS } from './lib/copy-sources.mjs';
import { loadWorkerRules } from './lib/worker-rules.mjs';
import { COUNTS_SQL, countsOf, printQueryCommands, readResultFile, REPO_ROOT } from './import-catalogue.mjs';

const COUNTED = ['products', 'podProducts', 'variants', 'tags', 'images', 'publications', 'screening', 'collections', 'collectionMembers', 'pages'];
const PLAN_KEY = { collectionMembers: 'collectionMembers', collections: 'collections', images: 'images', pages: 'pages', podProducts: 'podProducts', products: 'products', publications: 'publications', screening: 'screening', tags: 'tags', variants: 'variants' };

function die(message) {
  console.error(`VERIFY-CATALOGUE REFUSED: ${message}`);
  process.exit(1);
}

/** The shop gate of the Worker's FROM lifted: every tenant reads as active and published. */
export function liftedShopGate(eligibleFrom) {
  const join = 'INNER JOIN tenants AS tenant';
  if (eligibleFrom.split(join).length !== 2) throw new Error('eligibility.ts changed its FROM: the shop gate cannot be lifted; re-read it');
  return eligibleFrom.replace(join, "INNER JOIN (SELECT tenant_id, 'active' AS status, 1 AS published FROM tenants) AS tenant");
}

/** The read-only queries of the actual state. */
export function actualQueries(rules) {
  const storageLike = (column) => SOURCE_STORAGE_MARKERS.map((marker) => `${column} LIKE '%${marker}%'`).join(' OR ');
  const publicSelect = (from) => `SELECT product.tenant_id AS tenant_id, product.product_id AS product_id ${from} WHERE ${rules.PUBLIC_ELIGIBILITY_PREDICATE} ORDER BY product.tenant_id, product.product_id;`;
  return [
    { file: 'import_runs', sql: "SELECT run_id, status FROM import_runs WHERE run_id LIKE 'catalogue%' ORDER BY run_id;" },
    { file: 'tenants', sql: 'SELECT tenant_id, status, published, catalog_version FROM tenants ORDER BY tenant_id;' },
    { file: 'counts', sql: COUNTS_SQL },
    { file: 'products', sql: 'SELECT tenant_id, product_id, handle FROM products ORDER BY tenant_id, product_id;' },
    { file: 'public_now', sql: publicSelect(rules.ELIGIBLE_PRODUCTS_FROM) },
    { file: 'public_if_live', sql: publicSelect(liftedShopGate(rules.ELIGIBLE_PRODUCTS_FROM)) },
    {
      file: 'bad_objects',
      sql: [
        "SELECT 'image' AS what, image.tenant_id AS tenant_id, COUNT(*) AS n FROM product_images AS image LEFT JOIN stored_objects AS object ON object.object_id = image.object_id WHERE object.object_id IS NULL OR object.tenant_id <> image.tenant_id OR object.bucket <> 'public' OR object.kind <> 'product_media' OR object.status <> 'active' GROUP BY image.tenant_id",
        "SELECT 'cover', collection.tenant_id, COUNT(*) FROM collections AS collection LEFT JOIN stored_objects AS object ON object.object_id = collection.image_object_id WHERE collection.image_object_id IS NOT NULL AND (object.object_id IS NULL OR object.tenant_id <> collection.tenant_id OR object.bucket <> 'public' OR object.kind <> 'product_media' OR object.status <> 'active') GROUP BY collection.tenant_id",
        "SELECT 'page_image', page.tenant_id, COUNT(*) FROM pages AS page LEFT JOIN stored_objects AS object ON object.object_id = page.image_object_id WHERE page.image_object_id IS NOT NULL AND (object.object_id IS NULL OR object.tenant_id <> page.tenant_id OR object.bucket <> 'public' OR object.kind <> 'product_media' OR object.status <> 'active') GROUP BY page.tenant_id",
      ].join(' UNION ALL ') + ';',
    },
    { file: 'tenant_settings', sql: 'SELECT tenant_id, store_identity_json FROM tenant_settings ORDER BY tenant_id;' },
    { file: 'branding_objects', sql: "SELECT object_id, tenant_id, bucket, kind, status FROM stored_objects WHERE kind = 'shop_branding' ORDER BY object_id;" },
    { file: 'screening', sql: "SELECT tenant_id, status, decided_by, COUNT(*) AS n, SUM(CASE WHEN terms_version IS NULL THEN 1 ELSE 0 END) AS unscreened FROM product_screening GROUP BY tenant_id, status, decided_by ORDER BY tenant_id, status, decided_by;" },
    {
      file: 'storage_texts',
      sql: `SELECT 'product' AS what, tenant_id, COUNT(*) AS n FROM products WHERE ${storageLike('name')} OR ${storageLike('description')} OR ${storageLike('more_info')} OR ${storageLike('size_guide')} GROUP BY tenant_id UNION ALL SELECT 'page', tenant_id, COUNT(*) FROM pages WHERE ${storageLike('content_json')} OR ${storageLike('title_json')} GROUP BY tenant_id;`,
    },
  ];
}

const text = (value) => (typeof value === 'string' ? value : null);

/** The query results → the --actual-state object. Strict. */
export function buildActualState(dir) {
  const rows = (file) => readResultFile(dir, file);
  const need = (condition, file) => {
    if (!condition) throw new Error(`${file}.json holds a row of an unexpected shape`);
  };
  const byTenant = (file, key) => {
    const out = {};
    for (const r of rows(file)) {
      need(text(r.tenant_id) && text(r[key]), file);
      (out[r.tenant_id] ??= []).push(r[key]);
    }
    return out;
  };
  const state = { badObjects: {}, brandingObjects: {}, counts: countsOf(rows('counts')), handles: {}, importRuns: {}, products: {}, publicIfLive: byTenant('public_if_live', 'product_id'), publicNow: byTenant('public_now', 'product_id'), screening: [], settings: {}, storageTexts: {}, tenants: {} };
  for (const r of rows('import_runs')) {
    need(text(r.run_id) && text(r.status), 'import_runs');
    state.importRuns[r.run_id] = r.status;
  }
  for (const r of rows('tenants')) {
    need(text(r.tenant_id) && text(r.status) && typeof r.published === 'number' && typeof r.catalog_version === 'number', 'tenants');
    state.tenants[r.tenant_id] = { catalogVersion: r.catalog_version, published: r.published === 1, status: r.status };
  }
  for (const r of rows('products')) {
    need(text(r.tenant_id) && text(r.product_id), 'products');
    (state.products[r.tenant_id] ??= []).push(r.product_id);
    if (text(r.handle) === null || r.handle.length === 0) state.handles[r.tenant_id] = (state.handles[r.tenant_id] ?? 0) + 1;
  }
  for (const r of rows('bad_objects')) {
    need(text(r.what) && text(r.tenant_id) && typeof r.n === 'number', 'bad_objects');
    state.badObjects[r.tenant_id] = { ...(state.badObjects[r.tenant_id] ?? {}), [r.what]: r.n };
  }
  for (const r of rows('tenant_settings')) {
    need(text(r.tenant_id) && text(r.store_identity_json), 'tenant_settings');
    state.settings[r.tenant_id] = r.store_identity_json;
  }
  for (const r of rows('branding_objects')) {
    need(text(r.object_id) && text(r.tenant_id) && text(r.bucket) && text(r.kind) && text(r.status), 'branding_objects');
    state.brandingObjects[r.object_id] = { active: r.status === 'active' && r.bucket === 'public', kind: r.kind, tenantId: r.tenant_id };
  }
  for (const r of rows('screening')) {
    need(text(r.tenant_id) && text(r.status) && text(r.decided_by) && typeof r.n === 'number', 'screening');
    state.screening.push({ decidedBy: r.decided_by, n: r.n, status: r.status, tenantId: r.tenant_id, unscreened: Number(r.unscreened ?? 0) });
  }
  for (const r of rows('storage_texts')) {
    need(text(r.what) && text(r.tenant_id) && typeof r.n === 'number', 'storage_texts');
    state.storageTexts[r.tenant_id] = (state.storageTexts[r.tenant_id] ?? 0) + r.n;
  }
  return state;
}

function record(checks, name, ok, expected, actual, note = '') {
  checks.push({ actual, expected, name, note, ok: ok === true });
}

const sameList = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/** Pure: every input passed in. */
export function runChecks({ actualState: actual, bundleVerified, planJson, rules }) {
  const checks = [];
  const expected = planJson?.expected;
  if (!expected || !expected.shops) {
    record(checks, 'plan.json has an expected block', false, 'an expected block', null, 'rebuild the plan with import-catalogue.mjs');
    return checks;
  }

  record(checks, 'run: the plan\'s import run is completed', actual.importRuns[expected.runId] === 'completed', 'completed', actual.importRuns[expected.runId] ?? '(absent)');

  for (const [shop, want] of Object.entries(expected.shops)) {
    const differing = COUNTED.filter((table) => (actual.counts[shop]?.[table] ?? 0) !== (want.countsBefore?.[table] ?? 0) + (want[PLAN_KEY[table]] ?? 0));
    record(checks, `counts ${shop}: rows per table = before + plan`, differing.length === 0,
      Object.fromEntries(COUNTED.map((t) => [t, (want.countsBefore?.[t] ?? 0) + (want[PLAN_KEY[t]] ?? 0)])),
      Object.fromEntries(COUNTED.map((t) => [t, actual.counts[shop]?.[t] ?? 0])));
    const present = new Set(actual.products[shop] ?? []);
    const missing = want.productIds.filter((id) => !present.has(id)).length;
    record(checks, `ids ${shop}: every product id of the plan is present`, missing === 0, `${want.productIds.length} present`, `${missing} missing`);
    record(checks, `handle ${shop}: no product without its handle`, (actual.handles[shop] ?? 0) === 0, 0, actual.handles[shop] ?? 0);
    const ifLive = actual.publicIfLive[shop] ?? [];
    record(checks, `public ${shop}: the projection once the shop is live = the plan's published non-POD products`, sameList(ifLive, want.publicIfLive), want.publicIfLive.length, ifLive.length,
      `the source shows ${want.sourcePublic}; ${want.sourcePublic - want.publicIfLive.length} of them are POD products without a mapping (D83)`);
    const tenant = actual.tenants[shop];
    const live = tenant?.status === 'active' && tenant?.published === true;
    const now = actual.publicNow[shop] ?? [];
    record(checks, `public ${shop}: the projection now (${live ? 'the shop is live' : 'the shop is not live yet'})`, live ? sameList(now, want.publicIfLive) : now.length === 0, live ? want.publicIfLive.length : 0, now.length,
      live ? '' : 'published for the review by staging-legal.mjs --publish-for-review');
    const bad = actual.badObjects[shop] ?? {};
    record(checks, `objects ${shop}: no image, cover or page image without the shop's own active public object`, Object.values(bad).every((n) => n === 0), 0, bad);
    record(checks, `storage ${shop}: no product or page text names the source's storage`, (actual.storageTexts[shop] ?? 0) === 0, 0, actual.storageTexts[shop] ?? 0);
    const moved = (tenant?.catalogVersion ?? 0) > want.catalogVersionBefore;
    const wrote = want.products + want.collections + want.pages > 0 || expected.branding?.[shop] !== undefined;
    record(checks, `version ${shop}: catalog_version moved`, !wrote || moved, `> ${want.catalogVersionBefore}`, tenant?.catalogVersion ?? '(tenant missing)');
  }

  // The totals of the manifest's checklist 12 (205 in the source, 199 on Cloudflare).
  const actualIfLiveTotal = Object.keys(expected.shops).reduce((n, shop) => n + (actual.publicIfLive[shop]?.length ?? 0), 0);
  record(checks, 'public total: the projection once live = the source\'s less its POD products', actualIfLiveTotal === expected.publicIfLiveTotal && expected.sourcePublicTotal - expected.publicIfLiveTotal === expected.podPublishedTotal,
    `${expected.publicIfLiveTotal} (source ${expected.sourcePublicTotal} − POD ${expected.podPublishedTotal})`, actualIfLiveTotal);

  // The store identities.
  for (const [shop, want] of Object.entries(expected.branding ?? {})) {
    let identity = null;
    try {
      identity = JSON.parse(actual.settings[shop] ?? 'null');
    } catch {
      identity = null;
    }
    const refs = identity && typeof identity === 'object' ? rules.storeIdentityImageRefs(identity) : [];
    const got = Object.fromEntries(refs.map((ref) => [ref.path, ref.objectId]));
    const notOwn = refs.filter((ref) => {
      const object = actual.brandingObjects[ref.objectId];
      return object === undefined || object.tenantId !== shop || object.kind !== 'shop_branding' || !object.active;
    }).length;
    record(checks, `branding ${shop}: the identity names the plan's images, each the shop's own active branding object`, JSON.stringify(got) === JSON.stringify(want.images) && notOwn === 0,
      `${Object.keys(want.images).length} image id(s) as planned`, `${Object.keys(got).length} image id(s), ${notOwn} not the shop's own active branding object, ${JSON.stringify(got) === JSON.stringify(want.images) ? 'equal' : 'DIFFERENT'} to the plan`);
  }

  const approvedByImport = actual.screening.filter((row) => row.decidedBy === 'import' && row.status === 'approved').reduce((n, row) => n + row.n, 0);
  record(checks, 'screening: no product approved by the importer', approvedByImport === 0, 0, approvedByImport);
  const waiting = actual.screening.reduce((n, row) => n + row.unscreened, 0);
  record(checks, 'screening: products waiting for the re-screen route (informational)', true, 'POST /v1/platform/screening-terms/rescreen until pending = 0', waiting);

  record(checks, 'bundle: the bundle the plan was built from verifies', bundleVerified === true, true, bundleVerified);
  return checks;
}

function parseArgs(argv) {
  const out = { actualState: null, bundle: null, env: null, plan: null, printQueries: false, stateFrom: null, stateOut: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env') out.env = argv[++i] ?? die('--env needs a value');
    else if (arg === '--bundle') out.bundle = argv[++i] ?? die('--bundle needs a value');
    else if (arg === '--plan') out.plan = argv[++i] ?? die('--plan needs a value');
    else if (arg === '--actual-state') out.actualState = argv[++i] ?? die('--actual-state needs a value');
    else if (arg === '--print-queries') out.printQueries = true;
    else if (arg === '--state-from') out.stateFrom = argv[++i] ?? die('--state-from needs a value');
    else if (arg === '--state-out') out.stateOut = argv[++i] ?? die('--state-out needs a value');
    else die(`unknown argument ${arg}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rules = await loadWorkerRules();
  if (args.printQueries) {
    if (args.env !== 'staging') die('--print-queries needs --env staging');
    console.log(printQueryCommands(actualQueries(rules), { env: args.env, kind: 'catalogue-actual', tool: 'verify-catalogue.mjs' }));
    return;
  }
  if (args.stateFrom !== null) {
    if (args.stateOut === null) die('--state-from needs --state-out');
    const out = path.resolve(args.stateOut);
    if (isInsideRepo(out, REPO_ROOT)) die(`--state-out resolves inside the repository (${REPO_ROOT})`);
    let state;
    try {
      state = buildActualState(path.resolve(args.stateFrom));
    } catch (error) {
      die(error.message);
    }
    ensureDir(path.dirname(out));
    writeFileSecure(out, Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8'));
    console.log(`wrote: ${out}`);
    return;
  }
  if (args.env !== 'staging') die('--env must be staging');
  if (!args.bundle || !args.plan || !args.actualState) die('--bundle, --plan and --actual-state are required (or --print-queries / --state-from)');
  const planJsonPath = path.join(path.resolve(args.plan), 'plan.json');
  if (!existsSync(planJsonPath)) die(`no plan.json in ${path.resolve(args.plan)}`);
  const planJson = JSON.parse(readFileSync(planJsonPath, 'utf8'));
  if (planJson.env !== args.env) die(`the plan was built for ${planJson.env}, not ${args.env}`);
  if (planJson.bundleSha !== bundleSha(path.resolve(args.bundle))) die('the plan was not built from this bundle (bundle sha differs)');
  const actualState = JSON.parse(readFileSync(path.resolve(args.actualState), 'utf8'));
  const checks = runChecks({ actualState, bundleVerified: verifyBundle(path.resolve(args.bundle)).ok === true, planJson, rules });
  for (const check of checks) {
    console.log(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.name} — expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}${check.note ? ` (${check.note})` : ''}`);
  }
  const ok = checks.every((check) => check.ok);
  console.log(ok ? `\nPASS: ${checks.length} checks, nothing failed` : `\nFAIL: ${checks.filter((c) => !c.ok).length} of ${checks.length} checks failed`);
  process.exitCode = ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}

export { parseArgs };
