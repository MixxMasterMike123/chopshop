#!/usr/bin/env node
/**
 * scripts/cf-port/migrate/import-studio-assets.mjs — CP5-WH: the design
 * studio's platform-owned assets (the mockup templates and the 3D models,
 * DECISIONS D101) from the export into the Cloudflare system, THROUGH the
 * Worker's platform routes under a platform session — never around them:
 *
 *   node scripts/cf-port/migrate/import-studio-assets.mjs --env staging
 *        --bundle <export dir> --out <dir outside the repo>
 *        [--hosting-dir <dir>] [--only templates|models] [--dry-run]
 *   node scripts/cf-port/migrate/import-studio-assets.mjs --env production --confirm production
 *        --bundle <export dir> --out <another dir outside the repo> [...the same options]
 *
 * Sources: the export's `settings/podMockupTemplates` (row 71) and
 * `pod3dModels` (row 42), read with lib/bundle-reader.mjs and shaped by
 * lib/transform-studio-assets.mjs. A file a document names is either an
 * address of the source's storage (fetched, read-only) or a path of the old
 * site's hosting (`/pod-garments/…`), read from `--hosting-dir` (the
 * directory those paths were served from: the old build's `public/`).
 *
 * The run, in order:
 *   1. /health says the environment of --env and /ready is on 0049 or later;
 *      sign in as the platform user (lib/api-session.mjs);
 *   2. every distinct file address, in a fixed order, unless the manifest
 *      already has it `copied`: read it (at most 15 MiB), prove its type
 *      from its bytes with the Worker's own image-sniff.ts (PNG, JPEG, WebP or
 *      AVIF only), POST /v1/platform/pod/studio-files with the bytes → 201 or
 *      200 { file: { fileId, sha256, … } } (the Worker stores identical bytes
 *      once, so a second run, or a file two documents share, uploads
 *      nothing new). The manifest is rewritten after every file;
 *   3. every template, then every model, whose files are all copied:
 *      PUT /v1/platform/pod/mockup-templates/:id and
 *      PUT /v1/platform/pod/3d-models/:id with the file ids in place → 201
 *      created, 200 updated, or 200 `changed: false` (the same document is
 *      already there: nothing written, no audit row). An item with a file
 *      that is not copied is NOT written (counted);
 *   4. verify: GET the platform lists and compare every written item with
 *      the body sent.
 *
 * Idempotent and resumable: a second run uploads nothing and writes nothing
 * (every PUT answers `changed: false`). Prints counts, ids and reasons only —
 * never an address, a cookie or a body. Exit 0 when everything was written
 * and verified, 1 otherwise, 2 on a refusal to run.
 *
 * The target is lib/api-session.mjs apiTarget: staging, or (CP7-T1)
 * production with `--confirm production`, the API origin of
 * cloudflare/pinned.production.json (refused while it is null), and the
 * credentials of the environment or ~/.config/chopshop/secrets.production.env
 * only. A manifest in --out written for another environment or API is refused.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { guardNamePatterns } from '../build-locales.mjs';
import { readCollection, readSettingsDocs } from './lib/bundle-reader.mjs';
import { sourceKeyOf } from './lib/copy-manifest.mjs';
import { fetchAddressOf, isFetchable, loadWorkerModule } from './lib/copy-sources.mjs';
import {
  apiTarget,
  confirmationProblem,
  createApiSession,
  credentialsFor,
  preflight,
  RefusedError,
  REPO_ROOT,
} from './lib/api-session.mjs';
import { isInsideRepo } from './lib/outside-repo.mjs';
import {
  emptyStudioCopyManifest,
  findStudioEntry,
  putStudioEntry,
  readStudioCopyManifest,
  STUDIO_COPY_MANIFEST_FILE,
  STUDIO_FILE_KIND,
  writeStudioCopyManifest,
} from './lib/studio-copy-manifest.mjs';
import { sourcesOf, transformModels, transformTemplates, withFileIds } from './lib/transform-studio-assets.mjs';

export const REQUIRED_MIGRATION = '0049';
export const STUDIO_FILE_MAX_BYTES = 15 * 1024 * 1024;
const STUDIO_TYPES = ['image/avif', 'image/jpeg', 'image/png', 'image/webp'];
const TRIES = 3;
const SOURCE_TIMEOUT_MS = 60_000;
const ONLY = ['templates', 'models'];

export function parseArgs(argv) {
  const out = { bundle: null, dryRun: false, env: null, hostingDir: null, only: null, out: null };
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
    else if (arg === '--hosting-dir') out.hostingDir = value();
    else if (arg === '--only') {
      const only = value();
      if (!ONLY.includes(only)) throw new RefusedError('--only must be templates or models');
      out.only = only;
    } else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--confirm') out.confirm = value();
    else throw new RefusedError(`unknown argument ${arg}`);
  }
  if (out.env === null) throw new RefusedError('--env is required (staging)');
  if (out.bundle === null) throw new RefusedError('--bundle is required');
  if (out.out === null) throw new RefusedError('--out is required (a directory outside the repository)');
  return out;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── the plan ────────────────────────────────────────────────────────────────

/** What the bundle holds, shaped for the Worker. Pure apart from reading the bundle. */
export function planStudioImport(bundleDir, { only = null, names = guardNamePatterns() } = {}) {
  const settings = readSettingsDocs(bundleDir);
  const templatePlan =
    only === 'models' ? { droppedColorways: {}, droppedKeys: {}, leftOut: [], templates: [] } : transformTemplates(settings.podMockupTemplates, names);
  const modelPlan =
    only === 'templates'
      ? { counts: { colorwaysIncomplete: 0, colorwaysLeftOut: {}, originalPathsNotCopied: 0, viewsLeftOut: 0 }, leftOut: [], models: [] }
      : transformModels(readCollection(bundleDir, 'pod3dModels'), names);
  const sources = [
    ...new Set([...templatePlan.templates, ...modelPlan.models].flatMap((item) => sourcesOf(item.body))),
  ].sort();
  return { modelPlan, sources, templatePlan };
}

// ── reading one source ──────────────────────────────────────────────────────

/** A hosting path inside `hostingDir`, or null when it would leave it. */
export function hostingFileOf(hostingDir, address) {
  let decoded;
  try {
    decoded = decodeURIComponent(address.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  const root = path.resolve(hostingDir);
  const file = path.resolve(root, `.${decoded}`);
  const rel = path.relative(root, file);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? null : file;
}

async function fetchRemoteOnce(fetchImpl, address) {
  let response;
  try {
    response = await fetchImpl(fetchAddressOf(address), {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  } catch {
    return { reason: 'network_error', status: 'failed', transient: true };
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { reason: 'http_404', status: 'missing' };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return { reason: `http_${response.status}`, status: 'failed', transient: response.status === 429 || response.status >= 500 };
  }
  const chunks = [];
  let total = 0;
  // The body arrives after the headers: a connection that resets, or the
  // timeout firing, while it streams throws HERE, and is a transient failure
  // like one before the headers (readSource tries again; the manifest records it).
  try {
    for await (const chunk of response.body ?? []) {
      total += chunk.byteLength;
      if (total > STUDIO_FILE_MAX_BYTES) {
        await response.body.cancel().catch(() => undefined);
        return { reason: 'too_large', status: 'refused' };
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    return { reason: error?.name === 'TimeoutError' ? 'timeout' : 'network_error', status: 'failed', transient: true };
  }
  return { bytes: Buffer.concat(chunks), status: 'ok' };
}

/**
 * The bytes of one address: { status: 'ok', bytes } | { status, reason }.
 * A hosting path is read from `hostingDir`; an http(s) address is fetched.
 */
export async function readSource(address, { fetchImpl, hostingDir, sleep }) {
  if (address.startsWith('/') && !address.startsWith('//')) {
    if (hostingDir === null) return { reason: 'no_hosting_dir', status: 'refused' };
    const file = hostingFileOf(hostingDir, address);
    if (file === null) return { reason: 'outside_hosting_dir', status: 'refused' };
    if (!existsSync(file) || !statSync(file).isFile()) return { reason: 'not_in_hosting_dir', status: 'missing' };
    if (statSync(file).size > STUDIO_FILE_MAX_BYTES) return { reason: 'too_large', status: 'refused' };
    return { bytes: readFileSync(file), status: 'ok' };
  }
  if (!isFetchable(address)) return { reason: 'not_fetchable', status: 'refused' };
  let last = null;
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    last = await fetchRemoteOnce(fetchImpl, address);
    if (last.status !== 'failed' || !last.transient) return last;
    if (attempt < TRIES) await sleep(1_000 * attempt);
  }
  return last;
}

// ── the Worker ──────────────────────────────────────────────────────────────

function workerReason(result) {
  const reason = result.json?.error?.reason;
  return typeof reason === 'string' && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : `http_${result.status}`;
}

async function withTries(fn, sleep) {
  let last = { failure: 'unknown', status: 0 };
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    try {
      const result = await fn();
      // 409 on an upload = the same bytes are being uploaded right now: wait.
      if (result.status < 500 && result.status !== 409) return result;
      last = { failure: `http_${result.status}`, status: 0 };
    } catch (error) {
      last = { failure: error?.code === 'timeout' ? 'timeout' : 'network_error', status: 0 };
    }
    if (attempt < TRIES) await sleep(1_000 * attempt);
  }
  return last;
}

function entryOf(sourceKey, fields) {
  return {
    contentType: null,
    fileId: null,
    kind: STUDIO_FILE_KIND,
    reason: null,
    sha256: null,
    sizeBytes: 0,
    sourceKey,
    status: 'failed',
    ...fields,
  };
}

async function copyOne(address, context) {
  const { session, sleep, sniff } = context;
  const sourceKey = sourceKeyOf(address);
  const read = await readSource(address, context);
  if (read.status !== 'ok') return entryOf(sourceKey, { reason: read.reason, status: read.status });
  const bytes = read.bytes;
  const sha256 = sha256Hex(bytes);
  const known = { sha256, sizeBytes: bytes.byteLength };
  if (bytes.byteLength === 0) return entryOf(sourceKey, { ...known, reason: 'empty', status: 'refused' });
  const contentType = sniff.sniffImageType(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!STUDIO_TYPES.includes(contentType)) {
    return entryOf(sourceKey, { ...known, reason: 'not_an_allowed_image', status: 'refused' });
  }
  const uploaded = await withTries(
    () =>
      session.request('POST', '/v1/platform/pod/studio-files', {
        bytes,
        headers: { 'content-type': contentType },
      }),
    sleep,
  );
  if (uploaded.status === 0) return entryOf(sourceKey, { ...known, contentType, reason: uploaded.failure });
  if (uploaded.status === 400 || uploaded.status === 413) {
    return entryOf(sourceKey, { ...known, contentType, reason: workerReason(uploaded), status: 'refused' });
  }
  const file = uploaded.json?.file;
  if ((uploaded.status !== 200 && uploaded.status !== 201) || typeof file?.fileId !== 'string') {
    return entryOf(sourceKey, { ...known, contentType, reason: `http_${uploaded.status}` });
  }
  if (file.sha256 !== sha256 || file.sizeBytes !== bytes.byteLength || file.contentType !== contentType) {
    return entryOf(sourceKey, { ...known, contentType, reason: 'upload_unverified' });
  }
  context.stats[uploaded.status === 201 ? 'uploaded' : 'alreadyStored'] += 1;
  return entryOf(sourceKey, { ...known, contentType, fileId: file.fileId, status: 'copied' });
}

/** JSON with object keys sorted (the comparison of a body with what the Worker holds). */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A sent body as the Worker stores and answers it (cloudflare/src/pod/studio-assets.ts
 * parseMockupTemplateInput / parseModel3dInput and templateFromRows / modelFromRows),
 * nested levels included: the defaults it fills in (`active`, `provisional`,
 * `sortOrder`, `photo: null`, a colourway's `frontFileId`/`backFileId: null`,
 * `displacement: null`; a model's `output: null`, `perColorway: {}`, a view's
 * `colorways: []`, `w`/`h`/`originalDims`/`printAreaMm: null`, a colourway's
 * `maskFileId: null`) and the empty optional maps it drops.
 */
export function workerShape(kind, sent) {
  const body = structuredClone(sent);
  if (kind === 'template') {
    body.active ??= true;
    body.provisional ??= false;
    body.sortOrder ??= 0;
    body.photo ??= null;
    if (isObject(body.photo)) body.photo.displacement ??= null;
    for (const colorway of Array.isArray(body.colorways) ? body.colorways : []) {
      if (!isObject(colorway)) continue;
      colorway.frontFileId ??= null;
      colorway.backFileId ??= null;
      if (isObject(colorway.tuning) && Object.keys(colorway.tuning).length === 0) delete colorway.tuning;
    }
    for (const key of ['pocketPositions', 'printOffsetTopMm', 'slotLabels']) {
      if (isObject(body[key]) && Object.keys(body[key]).length === 0) delete body[key];
    }
  } else {
    body.active ??= true;
    body.output ??= null;
    body.perColorway ??= {};
    for (const [colorwayId, override] of Object.entries(isObject(body.perColorway) ? body.perColorway : {})) {
      if (isObject(override) && Object.keys(override).length === 0) delete body.perColorway[colorwayId];
    }
    for (const view of Object.values(isObject(body.views) ? body.views : {})) {
      if (!isObject(view)) continue;
      view.colorways ??= [];
      view.w ??= null;
      view.h ??= null;
      view.originalDims ??= null;
      view.printAreaMm ??= null;
      for (const colorway of Array.isArray(view.colorways) ? view.colorways : []) {
        if (isObject(colorway)) colorway.maskFileId ??= null;
      }
    }
  }
  return body;
}

/**
 * Is what the Worker answers (`stored`, a platform list entry) the body that
 * was sent? The sent body is first given the Worker's own defaults
 * (`workerShape`); then every one of its keys must read the same off
 * `stored` (the list adds the id and the times, which are not compared).
 */
export function sameDocument(kind, sent, stored) {
  if (stored === undefined) return false;
  const expected = workerShape(kind, sent);
  const picked = Object.fromEntries(Object.keys(expected).map((key) => [key, stored[key]]));
  return stableJson(expected) === stableJson(picked);
}

// ── the run ─────────────────────────────────────────────────────────────────

function printPlan(log, plan) {
  const { modelPlan, sources, templatePlan } = plan;
  log(`templates: ${templatePlan.templates.length} to write${templatePlan.templates.length ? ` (${templatePlan.templates.map((t) => t.id).join(', ')})` : ''}`);
  log(`models: ${modelPlan.models.length} to write${modelPlan.models.length ? ` (${modelPlan.models.map((m) => m.id).join(', ')})` : ''}`);
  const leftOut = [...templatePlan.leftOut, ...modelPlan.leftOut];
  log(`left out: ${leftOut.length === 0 ? 'none' : leftOut.map((item) => `${item.kind} ${item.id} (${item.reason})`).join(', ')}`);
  const dropped = Object.entries(templatePlan.droppedKeys).map(([key, n]) => `${key} ${n}`);
  log(`template keys not carried: ${dropped.length === 0 ? 'none' : dropped.join(', ')}`);
  const colorwaysOut = { ...templatePlan.droppedColorways };
  for (const [reason, n] of Object.entries(modelPlan.counts.colorwaysLeftOut)) colorwaysOut[reason] = (colorwaysOut[reason] ?? 0) + n;
  const colorwaysOutText = Object.entries(colorwaysOut).map(([reason, n]) => `${reason} ${n}`);
  log(`colourways left out: ${colorwaysOutText.length === 0 ? 'none' : colorwaysOutText.join(', ')}; 3D colourways without a photo and a map: ${modelPlan.counts.colorwaysIncomplete}; views other than front/back: ${modelPlan.counts.viewsLeftOut}`);
  log(`3D originals not copied (the studio renders the web derivatives): ${modelPlan.counts.originalPathsNotCopied} colourways`);
  const hosting = sources.filter((address) => address.startsWith('/') && !address.startsWith('//')).length;
  log(`files: ${sources.length} distinct (${hosting} from the hosting directory, ${sources.length - hosting} from the source's storage)`);
}

/**
 * The whole run, with its dependencies injectable for the tests:
 *   apiOrigin, credentials, fetchApiImpl, fetchSourceImpl, sleep, log, now, names
 * Answers { exitCode, result }.
 */
export async function runStudioImport(args, deps) {
  const confirmation = confirmationProblem(args.env, args.confirm);
  if (confirmation !== null) throw new RefusedError(confirmation);
  const log = deps.log ?? ((line) => console.log(line));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const outDir = path.resolve(args.out);
  if (isInsideRepo(outDir, deps.repoRoot ?? REPO_ROOT)) {
    throw new RefusedError('--out resolves inside the repository; the manifest must live outside it');
  }
  const bundleDir = path.resolve(args.bundle);
  const bundleManifest = path.join(bundleDir, 'manifest.json');
  if (!existsSync(bundleManifest)) throw new RefusedError('--bundle holds no manifest.json');
  const hostingDir = args.hostingDir === null ? null : path.resolve(args.hostingDir);
  if (hostingDir !== null && (!existsSync(hostingDir) || !statSync(hostingDir).isDirectory())) {
    throw new RefusedError('--hosting-dir is not a directory');
  }
  const bundleManifestSha256 = sha256Hex(readFileSync(bundleManifest));

  const plan = planStudioImport(bundleDir, { names: deps.names, only: args.only });
  printPlan(log, plan);

  const manifestPath = path.join(outDir, STUDIO_COPY_MANIFEST_FILE);
  let manifest = existsSync(manifestPath) ? readStudioCopyManifest(manifestPath) : null;
  if (manifest !== null) {
    if (manifest.env !== args.env || manifest.apiOrigin !== deps.apiOrigin) {
      throw new RefusedError('the manifest in --out was written for another environment or API');
    }
    if (manifest.bundleManifestSha256 !== bundleManifestSha256) {
      throw new RefusedError('the manifest in --out was written from another bundle');
    }
  }
  const copiedBefore = plan.sources.filter(
    (address) => manifest !== null && findStudioEntry(manifest, sourceKeyOf(address))?.status === 'copied',
  ).length;
  log(`files already copied (skipped): ${copiedBefore}; to try now: ${plan.sources.length - copiedBefore}`);

  if (args.dryRun) {
    const unreadable = plan.sources.filter(
      (address) => address.startsWith('/') && !address.startsWith('//') && (hostingDir === null || !existsSync(hostingFileOf(hostingDir, address) ?? '')),
    ).length;
    log(`hosting paths that --hosting-dir does not hold: ${unreadable}`);
    log('dry run: no request made, nothing written');
    return { exitCode: 0, result: null };
  }

  mkdirSync(outDir, { mode: 0o700, recursive: true });
  chmodSync(outDir, 0o700);
  if (manifest === null) {
    manifest = emptyStudioCopyManifest({ apiOrigin: deps.apiOrigin, bundleManifestSha256, env: args.env });
    writeStudioCopyManifest(manifestPath, manifest);
  }

  const session = createApiSession({ apiOrigin: deps.apiOrigin, fetchImpl: deps.fetchApiImpl, now: deps.now, sleep });
  await preflight(session, { environment: args.env, requiredMigration: REQUIRED_MIGRATION });
  await session.signIn(deps.credentials);
  log('signed in as the platform user');

  const sniff = await loadWorkerModule('storage/image-sniff.ts', { repoRoot: deps.repoRoot ?? REPO_ROOT });
  const stats = { alreadyStored: 0, uploaded: 0 };
  const context = {
    fetchImpl: deps.fetchSourceImpl ?? globalThis.fetch,
    hostingDir,
    session,
    sleep,
    sniff,
    stats,
  };
  const files = { copied: 0, failed: 0, missing: 0, refused: 0 };
  for (const address of plan.sources) {
    const known = findStudioEntry(manifest, sourceKeyOf(address));
    if (known?.status === 'copied') {
      files.copied += 1;
      continue;
    }
    const entry = await copyOne(address, context);
    putStudioEntry(manifest, entry);
    writeStudioCopyManifest(manifestPath, manifest);
    files[entry.status] += 1;
    if (entry.status !== 'copied') log(`  file ${entry.sourceKey.slice(0, 12)}: ${entry.status} (${entry.reason})`);
  }
  log(`files: copied ${files.copied} (uploaded now ${stats.uploaded}, already stored ${stats.alreadyStored}), refused ${files.refused}, missing ${files.missing}, failed ${files.failed}`);

  const fileIdOf = (address) => {
    const entry = findStudioEntry(manifest, sourceKeyOf(address));
    return entry?.status === 'copied' ? entry.fileId : null;
  };
  const rows = { created: 0, failed: 0, notWritten: 0, refused: 0, unchanged: 0, updated: 0 };
  const written = { models: [], templates: [] };
  const writeAll = async (items, route, kind) => {
    for (const item of items) {
      const body = withFileIds(item.body, fileIdOf);
      if (body === null) {
        rows.notWritten += 1;
        log(`  ${kind} ${item.id}: not written (a file is not copied)`);
        continue;
      }
      const result = await withTries(
        () => session.request('PUT', `${route}/${encodeURIComponent(item.id)}`, { json: body }),
        sleep,
      );
      if (result.status === 201) rows.created += 1;
      else if (result.status === 200 && result.json?.changed === false) rows.unchanged += 1;
      else if (result.status === 200) rows.updated += 1;
      else if (result.status === 400 || result.status === 409) {
        rows.refused += 1;
        log(`  ${kind} ${item.id}: refused (${workerReason(result)})`);
        continue;
      } else {
        rows.failed += 1;
        log(`  ${kind} ${item.id}: failed (${result.status === 0 ? result.failure : `http_${result.status}`})`);
        continue;
      }
      written[kind === 'template' ? 'templates' : 'models'].push({ body, id: item.id });
    }
  };
  await writeAll(plan.templatePlan.templates, '/v1/platform/pod/mockup-templates', 'template');
  await writeAll(plan.modelPlan.models, '/v1/platform/pod/3d-models', 'model');
  log(`rows: created ${rows.created}, updated ${rows.updated}, unchanged ${rows.unchanged}, refused ${rows.refused}, not written ${rows.notWritten}, failed ${rows.failed}`);

  // Verify against what the Worker now answers.
  let mismatches = 0;
  if (written.templates.length > 0) {
    const listed = await session.request('GET', '/v1/platform/pod/mockup-templates');
    const byId = Object.fromEntries((listed.json?.templates ?? []).map((t) => [t.templateId, t]));
    for (const item of written.templates) {
      if (!sameDocument('template', item.body, byId[item.id])) {
        mismatches += 1;
        log(`  verify: template ${item.id} does not match`);
      }
    }
  }
  if (written.models.length > 0) {
    const listed = await session.request('GET', '/v1/platform/pod/3d-models');
    const byId = Object.fromEntries((listed.json?.models ?? []).map((m) => [m.modelId, m]));
    for (const item of written.models) {
      if (!sameDocument('model', item.body, byId[item.id])) {
        mismatches += 1;
        log(`  verify: model ${item.id} does not match`);
      }
    }
  }
  log(`verify: ${written.templates.length} templates and ${written.models.length} models read back, ${mismatches} mismatches`);
  log(`API requests: ${session.stats.requests}; waits on 429: ${session.stats.rateLimitWaits}`);

  const clean =
    files.failed === 0 &&
    files.refused === 0 &&
    files.missing === 0 &&
    rows.refused === 0 &&
    rows.notWritten === 0 &&
    rows.failed === 0 &&
    mismatches === 0;
  return { exitCode: clean ? 0 : 1, result: { files, mismatches, rows, written } };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { apiOrigin } = apiTarget({ confirm: args.confirm, env: args.env });
    const credentials = args.dryRun ? null : credentialsFor(args.env);
    const { exitCode } = await runStudioImport(args, { apiOrigin, credentials });
    process.exitCode = exitCode;
  } catch (error) {
    if (error instanceof RefusedError) {
      console.error(`STUDIO IMPORT REFUSED: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`STUDIO IMPORT FAILED: ${error?.message ?? 'unknown error'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
