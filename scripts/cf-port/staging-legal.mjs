#!/usr/bin/env node
/**
 * scripts/cf-port/staging-legal.mjs — CP4 S1: the legal data steps of STAGING,
 * so the design review can see the legal pages of the imported shops. Staging
 * only, always: production is refused whatever else is set. At the cutover
 * the seller adopts the pages himself; nothing here is run against production.
 *
 *   node scripts/cf-port/staging-legal.mjs --env staging --bundle <dir> --out <dir outside the repo>
 *        [--shop <id>] [--dry-run] [--publish-for-review]
 *   node scripts/cf-port/staging-legal.mjs --env staging --out <dir> --unpublish-after-review
 *
 * (a) The platform's terms: when the CURRENT version has no archived text and
 *     is the version of src/config/platformTerms.js, its text
 *     JSON.stringify({ version, terms, dpa }) (the format the storefront
 *     renders, src/storefront/adapters/legal.js toPagePlatformTerms; the hash
 *     0031 seeded) is archived: PUT /v1/platform/legal/terms-versions/:v/text.
 *     A text that does not hash to the version's sha256 is not sent.
 * (b) Per shop of the bundle, under an acting-as grant whose reason says this
 *     is the staging step for the design review:
 *       - GET /v1/admin/legal/status (the readiness booleans);
 *       - what the readiness needs and is missing: PUT /v1/admin/settings with
 *         a return address that says it is a staging placeholder and/or
 *         vatRegistered false;
 *       - the three legal pages, rendered from the source's templates
 *         (src/utils/legalPageRenderer.js, src/config/legalTemplates.js) with
 *         the shop's own imported identity and its POD flag, checked with the
 *         Worker's checkHtml (a refused text is reported, not adopted), then
 *         adopted through POST /v1/admin/legal/accept-pages. The Worker lets
 *         only the shop's OWN admin adopt (legal-admin.ts maySignForSeller: an
 *         acting-as platform user gets 404), so the adoption is signed by a
 *         staging review admin of that shop, `staging-review+<shop>@example.com`
 *         (POST /v1/platform/users, POST /v1/platform/tenants/:id/admins,
 *         sign-in), whose address says what it is. Its password:
 *         CHOPSHOP_REVIEW_ADMIN_PASSWORD, else CHOPSHOP_SLICE_ADMIN_PASSWORD
 *         (environment or ~/.config/chopshop/secrets.staging.env).
 * --publish-for-review: each shop that is unpublished in the source AND on
 *     staging is published (POST /v1/platform/tenants/:id/publish); the ids go
 *     into <out>/published-for-review.json.
 * --unpublish-after-review: reads that file and unpublishes exactly those
 *     shops (POST /v1/platform/tenants/:id/unpublish), then removes the file.
 *
 * Prints counts, shop ids, statuses and reasons only: never a text, an
 * address, a name, a password or a cookie.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readCollection } from './migrate/lib/bundle-reader.mjs';
import { loadWorkerModule } from './migrate/lib/copy-sources.mjs';
import {
  createApiSession,
  platformCredentials,
  preflight,
  RefusedError,
  REPO_ROOT,
  secretValue,
  stagingTarget,
} from './migrate/lib/api-session.mjs';
import { isInsideRepo } from './migrate/lib/outside-repo.mjs';

export const PUBLISHED_FILE = 'published-for-review.json';
// 0037: the legal pages (accept-pages) and the terms-text archive.
export const REQUIRED_MIGRATION = '0037';
export const ACTING_AS_REASON =
  'CP4 staging step for the design review (staging-legal.mjs): legal settings and pages of this imported shop; ' +
  'at the cutover the seller adopts the pages himself';
export const STAGING_RETURN_ADDRESS = 'Returadress ej angiven (platshållare på staging för designgranskningen)';
export const PAGE_KEYS = ['kopvillkor', 'angerratt', 'integritetspolicy'];

export function reviewAdminEmail(tenantId) {
  return `staging-review+${tenantId}@example.com`;
}

export function parseArgs(argv) {
  const out = { bundle: null, dryRun: false, env: null, out: null, publish: false, shop: null, unpublish: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new RefusedError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === '--env') out.env = value();
    else if (arg === '--bundle') out.bundle = value();
    else if (arg === '--out') out.out = value();
    else if (arg === '--shop') out.shop = value();
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--publish-for-review') out.publish = true;
    else if (arg === '--unpublish-after-review') out.unpublish = true;
    else throw new RefusedError(`unknown argument ${arg}`);
  }
  if (out.env === null) throw new RefusedError('--env is required (staging)');
  if (out.out === null) throw new RefusedError('--out is required (a directory outside the repository)');
  if (out.unpublish && (out.publish || out.bundle !== null || out.shop !== null)) {
    throw new RefusedError('--unpublish-after-review takes only --env, --out and --dry-run');
  }
  if (!out.unpublish && out.bundle === null) throw new RefusedError('--bundle is required');
  return out;
}

// ── the source's templates, under Node ──────────────────────────────────────

let renderer = null;

/**
 * The source's renderer imports DOMPurify, which needs a DOM that Node does
 * not have. For that one import (from legalPageRenderer.js only) a module
 * that hands the markup back unchanged is resolved instead: markdown-it runs
 * with `html: false`, so the markup is its own, and the Worker's checkHtml
 * decides here and again at the route what may be adopted.
 */
export async function loadLegalSources({ repoRoot = REPO_ROOT } = {}) {
  if (renderer === null) {
    const rendererUrl = pathToFileURL(path.join(repoRoot, 'src/utils/legalPageRenderer.js')).href;
    const hooks = [
      "const SHIM = 'data:text/javascript,' + encodeURIComponent('export default { sanitize: (html) => String(html) };');",
      `const PARENT = ${JSON.stringify(rendererUrl)};`,
      'export async function resolve(specifier, context, next) {',
      "  if (specifier === 'dompurify' && context.parentURL === PARENT) return { shortCircuit: true, url: SHIM };",
      '  return next(specifier, context);',
      '}',
    ].join('\n');
    register(`data:text/javascript,${encodeURIComponent(hooks)}`);
    const [render, templates, terms, html] = await Promise.all([
      import(rendererUrl),
      import(pathToFileURL(path.join(repoRoot, 'src/config/legalTemplates.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'src/config/platformTerms.js')).href),
      loadWorkerModule('content/html-refusal.ts', { repoRoot }),
    ]);
    renderer = { checkHtml: html.checkHtml, render, templates, terms };
  }
  return renderer;
}

/** The archived-text format of a terms version (0031, CP3_E_REPORT.md §3). */
export function platformTermsText(terms) {
  // Key order is part of the hash: version, terms, dpa (0031's comment).
  return JSON.stringify({
    version: terms.PLATFORM_TERMS_VERSION,
    terms: terms.PLATFORM_TERMS_TEMPLATE,
    dpa: terms.PLATFORM_DPA_TEMPLATE,
  });
}

/** The sha256 0031 seeded for `version`, read from the migration itself. */
export function seededTermsSha256(version, { repoRoot = REPO_ROOT } = {}) {
  const dir = path.join(repoRoot, 'cloudflare', 'migrations');
  const file = readdirSync(dir).find((name) => name.startsWith('0031'));
  if (!file) return null;
  const sql = readFileSync(path.join(dir, file), 'utf8');
  const match = new RegExp(`'${version.replace(/[.]/g, '\\.')}',\\s*'[^']*',\\s*'([0-9a-f]{64})'`).exec(sql);
  return match ? match[1] : null;
}

/**
 * The three pages as the source's admin adopts them (src/utils/legalAcceptance.js):
 * { kopvillkor, angerratt, integritetspolicy } of renderLegalPage(slug, identity, { pod }).html.
 */
export function renderShopPages(sources, identity, pod) {
  const pages = {};
  for (const key of PAGE_KEYS) {
    const slug = sources.templates.LEGAL_SLUG_BY_KEY[key];
    pages[key] = sources.render.renderLegalPage(slug, identity, { pod })?.html ?? '';
  }
  return pages;
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
}

// ── the plan of one shop, from the bundle ───────────────────────────────────

function bundleShops(bundleDir, shop) {
  return readCollection(bundleDir, 'shops')
    .filter((doc) => shop === null || doc.id === shop)
    .map((doc) => {
      const identity = doc.data?.storeIdentity && typeof doc.data.storeIdentity === 'object' ? doc.data.storeIdentity : {};
      return {
        identity,
        pod: doc.data?.features?.pod === true,
        publishedInSource: doc.data?.published !== false,
        tenantId: doc.id,
      };
    })
    .sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1));
}

/** The identity the pages are rendered from, with what this step sets. */
export function identityForPages(identity, { setReturnAddress, setVat }) {
  const out = { ...identity };
  if (setReturnAddress) out.returnAddress = STAGING_RETURN_ADDRESS;
  if (setVat) out.vatRegistered = false;
  return out;
}

export function checkPages(sources, pages) {
  const refusals = [];
  for (const key of PAGE_KEYS) {
    if (pages[key].length === 0) refusals.push(`${key}:empty`);
    else {
      const checked = sources.checkHtml(pages[key]);
      if (!checked.ok) refusals.push(`${key}:${checked.reason}`);
    }
  }
  return refusals;
}

// ── the run ─────────────────────────────────────────────────────────────────

export async function runStagingLegal(args, deps) {
  const log = deps.log ?? ((line) => console.log(line));
  const outDir = path.resolve(args.out);
  if (isInsideRepo(outDir, deps.repoRoot ?? REPO_ROOT)) {
    throw new RefusedError('--out resolves inside the repository; it must live outside it');
  }
  const publishedFile = path.join(outDir, PUBLISHED_FILE);
  const problems = [];

  if (args.unpublish) return unpublishAfterReview(args, deps, { log, publishedFile });

  const sources = await loadLegalSources({ repoRoot: deps.repoRoot ?? REPO_ROOT });
  const shops = bundleShops(path.resolve(args.bundle), args.shop);
  if (args.shop !== null && shops.length === 0) throw new RefusedError(`--shop ${args.shop} is not a shop of the bundle`);

  const termsVersion = sources.terms.PLATFORM_TERMS_VERSION;
  const termsText = platformTermsText(sources.terms);
  const termsSha = sha256Hex(termsText);
  const seeded = seededTermsSha256(termsVersion, { repoRoot: deps.repoRoot ?? REPO_ROOT });
  log(`platform terms ${termsVersion}: text sha256 ${termsSha.slice(0, 12)}…, ${seeded === termsSha ? 'equal to' : 'NOT equal to'} the hash 0031 seeded`);

  if (args.dryRun) {
    for (const shop of shops) {
      const setReturnAddress = String(shop.identity.returnAddress ?? '').trim().length === 0;
      const setVat = typeof shop.identity.vatRegistered !== 'boolean';
      const pages = renderShopPages(sources, identityForPages(shop.identity, { setReturnAddress, setVat }), shop.pod);
      const refusals = checkPages(sources, pages);
      const sizes = PAGE_KEYS.map((key) => `${key} ${Buffer.byteLength(pages[key])} B`).join(', ');
      log(
        `  ${shop.tenantId.padEnd(20)} pod ${shop.pod}; the source lacks: ${[setReturnAddress && 'returnAddress', setVat && 'vatRegistered'].filter(Boolean).join(' + ') || 'nothing'}` +
          ` (set where staging lacks it too); pages ${sizes}; checkHtml ${refusals.length === 0 ? 'ok' : refusals.join(', ')}` +
          (args.publish && !shop.publishedInSource ? '; would publish for review' : ''),
      );
      if (refusals.length > 0) problems.push(`${shop.tenantId}: html`);
    }
    log('dry run: no request made, nothing written');
    return { exitCode: problems.length === 0 ? 0 : 1, problems };
  }

  const session = createApiSession({ apiOrigin: deps.apiOrigin, fetchImpl: deps.fetchApiImpl, now: deps.now, sleep: deps.sleep });
  await preflight(session, { requiredMigration: REQUIRED_MIGRATION });
  await session.signIn(deps.credentials);
  log('signed in as the platform user');

  // (a) the platform's terms text
  const versions = await session.request('GET', '/v1/platform/legal/terms-versions');
  const current = versions.status === 200 ? (versions.json?.versions ?? []).find((v) => v.current === true) ?? null : null;
  if (versions.status !== 200) {
    problems.push(`terms: list HTTP ${versions.status}`);
  } else if (current === null) {
    problems.push('terms: no current version');
  } else if (current.textArchived === true) {
    log(`terms ${current.version}: text already archived`);
  } else if (current.version !== termsVersion) {
    problems.push(`terms: current version ${current.version} is not the template version ${termsVersion}; not archived`);
  } else if (current.sha256 !== termsSha) {
    problems.push(`terms: the template text does not hash to version ${current.version}'s sha256; not archived`);
  } else {
    const put = await session.request('PUT', `/v1/platform/legal/terms-versions/${encodeURIComponent(current.version)}/text`, {
      json: { text: termsText },
    });
    if (put.status === 201 || put.status === 200) log(`terms ${current.version}: text archived (HTTP ${put.status})`);
    else problems.push(`terms: archive HTTP ${put.status}${put.json?.error?.code ? ` ${put.json.error.code}` : ''}`);
  }

  // (b) per shop
  const reviewPassword = secretValue(['CHOPSHOP_REVIEW_ADMIN_PASSWORD', 'CHOPSHOP_SLICE_ADMIN_PASSWORD'], {
    environment: deps.environment ?? process.env,
    secretsFile: deps.secretsFile,
  });
  for (const shop of shops) {
    const result = await legalStepsForShop(session, sources, shop, { log, reviewPassword });
    if (result.problem) problems.push(`${shop.tenantId}: ${result.problem}`);
  }

  if (args.publish) {
    const problem = await publishForReview(session, shops, { log, outDir, publishedFile });
    if (problem) problems.push(problem);
  }

  log(problems.length === 0 ? 'done: no problem' : `done with ${problems.length} problem(s):`);
  for (const problem of problems) log(`  - ${problem}`);
  return { exitCode: problems.length === 0 ? 0 : 1, problems };
}

async function legalStepsForShop(session, sources, shop, { log, reviewPassword }) {
  const tenantId = shop.tenantId;
  try {
    await session.ensureActingAs(tenantId, ACTING_AS_REASON);
  } catch (error) {
    if (!(error instanceof RefusedError)) throw error;
    log(`  ${tenantId.padEnd(20)} skipped: ${error.message.includes('404') ? 'not a shop on staging' : 'acting-as refused'}`);
    return { problem: 'acting-as refused' };
  }
  try {
    const status = await session.request('GET', '/v1/admin/legal/status', { shop: tenantId });
    if (status.status !== 200 || !status.json?.readiness) return { problem: `status HTTP ${status.status}` };
    const readiness = status.json.readiness;
    const setReturnAddress = readiness.returnAddress !== true;
    const setVat = readiness.vatAnswered !== true;
    const done = [];

    if (setReturnAddress || setVat) {
      const patch = {};
      if (setReturnAddress) patch.returnAddress = STAGING_RETURN_ADDRESS;
      if (setVat) patch.vatRegistered = false;
      const put = await session.request('PUT', '/v1/admin/settings', { json: patch, shop: tenantId });
      if (put.status !== 200) return { problem: `settings HTTP ${put.status}` };
      done.push(`set ${Object.keys(patch).join(' + ')}`);
    }

    if (readiness.legalPagesAccepted !== true) {
      const identity = identityForPages(shop.identity, { setReturnAddress, setVat });
      const pages = renderShopPages(sources, identity, shop.pod);
      const refusals = checkPages(sources, pages);
      if (refusals.length > 0) {
        log(`  ${tenantId.padEnd(20)} ${done.join(', ') || 'settings complete'}; pages NOT adopted: checkHtml ${refusals.join(', ')}`);
        return { problem: `pages refused by checkHtml (${refusals.join(', ')})` };
      }
      if (reviewPassword === null || reviewPassword.length < 12) {
        return { problem: 'no review admin password (CHOPSHOP_REVIEW_ADMIN_PASSWORD, >= 12 characters)' };
      }
      const seller = await reviewAdminFor(session, tenantId, reviewPassword);
      if (seller.problem) return { problem: seller.problem };
      const adopted = await session.request('POST', '/v1/admin/legal/accept-pages', {
        cookie: seller.cookie,
        json: { custom: false, pod: shop.pod, templateVersion: sources.templates.LEGAL_TEMPLATE_VERSION, texts: pages },
        shop: tenantId,
      });
      if (adopted.status !== 201) return { problem: `accept-pages HTTP ${adopted.status}` };
      done.push(`pages adopted (${adopted.json?.acceptance?.acceptanceId ?? 'no id'})`);
    }

    const after = await session.request('GET', '/v1/admin/legal/status', { shop: tenantId });
    const ready = after.status === 200 && after.json?.readiness?.ready === true;
    log(`  ${tenantId.padEnd(20)} ${done.join(', ') || 'nothing missing'}; legal readiness ${ready ? 'ready' : 'NOT ready'}`);
    return ready ? {} : { problem: 'not ready afterwards' };
  } finally {
    try {
      await session.endActingAs(tenantId);
    } catch {
      // The grant runs out by itself within the hour.
    }
  }
}

/** The staging review admin of one shop: created when absent, granted, signed in. */
async function reviewAdminFor(session, tenantId, password) {
  const email = reviewAdminEmail(tenantId);
  const created = await session.request('POST', '/v1/platform/users', {
    json: { accountType: 'tenant_admin', email, password },
  });
  if (created.status !== 201 && created.status !== 409) return { problem: `review admin create HTTP ${created.status}` };
  let signedIn;
  try {
    signedIn = await session.signInAs({ email, password });
  } catch {
    return { problem: 'review admin sign-in failed (an existing review admin with another password?)' };
  }
  if (typeof signedIn.userId !== 'string') return { problem: 'review admin sign-in answered no user id' };
  const granted = await session.request('POST', `/v1/platform/tenants/${encodeURIComponent(tenantId)}/admins`, {
    json: { userId: signedIn.userId },
  });
  if (granted.status !== 201 && granted.status !== 200) return { problem: `review admin grant HTTP ${granted.status}` };
  return { cookie: signedIn.cookie };
}

async function publishForReview(session, shops, { log, outDir, publishedFile }) {
  mkdirSync(outDir, { mode: 0o700, recursive: true });
  chmodSync(outDir, 0o700);
  const earlier = existsSync(publishedFile) ? JSON.parse(readFileSync(publishedFile, 'utf8')) : null;
  const tenants = new Set(Array.isArray(earlier?.tenants) ? earlier.tenants : []);
  let problem = null;
  for (const shop of shops) {
    if (shop.publishedInSource) continue;
    const detail = await session.request('GET', `/v1/platform/tenants/${encodeURIComponent(shop.tenantId)}`);
    if (detail.status !== 200) {
      problem = `publish: ${shop.tenantId} detail HTTP ${detail.status}`;
      continue;
    }
    if (detail.json?.tenant?.published === true) {
      log(`  ${shop.tenantId.padEnd(20)} already published on staging: left as it is${tenants.has(shop.tenantId) ? ' (published by an earlier run)' : ''}`);
      continue;
    }
    const published = await session.request('POST', `/v1/platform/tenants/${encodeURIComponent(shop.tenantId)}/publish`);
    if (published.status !== 200 || published.json?.tenant?.published !== true) {
      problem = `publish: ${shop.tenantId} HTTP ${published.status}`;
      continue;
    }
    tenants.add(shop.tenantId);
    writeJsonAtomic(publishedFile, { createdAt: earlier?.createdAt ?? new Date().toISOString(), env: 'staging', tenants: [...tenants].sort() });
    log(`  ${shop.tenantId.padEnd(20)} published for the review`);
  }
  log(`published for review: ${tenants.size} shop(s), listed in ${PUBLISHED_FILE} in --out`);
  return problem;
}

async function unpublishAfterReview(args, deps, { log, publishedFile }) {
  if (!existsSync(publishedFile)) throw new RefusedError(`no ${PUBLISHED_FILE} in --out: nothing was published for review`);
  const listed = JSON.parse(readFileSync(publishedFile, 'utf8'));
  const tenants = Array.isArray(listed?.tenants) ? listed.tenants.filter((id) => typeof id === 'string') : [];
  log(`to unpublish: ${tenants.length} shop(s): ${tenants.join(', ') || 'none'}`);
  if (args.dryRun) {
    log('dry run: no request made, nothing written');
    return { exitCode: 0, problems: [] };
  }
  const session = createApiSession({ apiOrigin: deps.apiOrigin, fetchImpl: deps.fetchApiImpl, now: deps.now, sleep: deps.sleep });
  await preflight(session, { requiredMigration: REQUIRED_MIGRATION });
  await session.signIn(deps.credentials);
  const left = [];
  const problems = [];
  for (const tenantId of tenants) {
    const result = await session.request('POST', `/v1/platform/tenants/${encodeURIComponent(tenantId)}/unpublish`);
    if (result.status === 200 && result.json?.tenant?.published === false) {
      log(`  ${tenantId.padEnd(20)} unpublished`);
    } else {
      left.push(tenantId);
      problems.push(`${tenantId}: unpublish HTTP ${result.status}`);
    }
  }
  if (left.length === 0) rmSync(publishedFile, { force: true });
  else writeJsonAtomic(publishedFile, { ...listed, tenants: left });
  for (const problem of problems) log(`  - ${problem}`);
  return { exitCode: problems.length === 0 ? 0 : 1, problems };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { apiOrigin } = stagingTarget({ env: args.env });
    const credentials = args.dryRun ? null : platformCredentials();
    const { exitCode } = await runStagingLegal(args, { apiOrigin, credentials });
    process.exitCode = exitCode;
  } catch (error) {
    if (error instanceof RefusedError) {
      console.error(`STAGING LEGAL REFUSED: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`STAGING LEGAL FAILED: ${error?.message ?? 'unknown error'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
