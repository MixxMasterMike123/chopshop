#!/usr/bin/env node
/**
 * scripts/cf-port/migrate/storage-copy.mjs — CP4 S1: copies every image file
 * a row of the catalogue import names (lib/copy-sources.mjs) from the source's
 * storage into the Cloudflare system THROUGH the Worker's own object routes,
 * and writes the copy manifest the row importer reads (lib/copy-manifest.mjs).
 *
 *   node scripts/cf-port/migrate/storage-copy.mjs --env staging --bundle <dir>
 *        --out <dir outside the repo> [--shop <id>] [--limit <n>] [--dry-run]
 *   node scripts/cf-port/migrate/storage-copy.mjs --env production --confirm production
 *        --bundle <dir> --out <another dir outside the repo> [--shop <id>] [--limit <n>] [--dry-run]
 *
 * Per distinct (shop, address), in a fixed order:
 *   1. GET the address from the source (read-only; 3 tries on a timeout, a
 *      network error, a 429 or a 5xx; a 404 is `missing`), at most 15 MB
 *      (an SVG 512 KB, the Worker's caps);
 *   2. the type from the bytes with the Worker's own image-sniff.ts
 *      (an SVG is stated as SVG and proven by the Worker's checkSvg);
 *   3. under an acting-as grant for that shop: POST /v1/admin/objects
 *      { contentType, kind, sha256, sizeBytes, fileName } → 201 { object:
 *      { objectId, objectKey } }, then PUT /v1/admin/objects/:id/content with
 *      the bytes → 200 { object: { status: "active", sha256, sizeBytes, … } }.
 *      The Worker proves the type, writes the row and the audit line.
 *
 * Resumable and idempotent: the manifest is rewritten atomically after every
 * file; a run skips every entry already `copied` and tries the others again.
 * A reserved object is recorded in <out>/copy-pending.json BEFORE its upload,
 * so a run that stopped between the upload and the manifest finds the object
 * again (GET /v1/admin/objects/:id) instead of uploading the file twice. Two
 * addresses of one shop with the same bytes and kind share one object.
 *
 * `refused` = the Worker (or the local size cap, or the sniff) refused the
 * file, with its reason; `missing` = the source answered 404; `failed` =
 * anything else. Exit 0 when nothing is `failed`, 1 otherwise, 2 on a refusal
 * to run. Prints counts, shop ids, object ids and reasons only.
 *
 * The target (lib/api-session.mjs apiTarget): staging, the pinned staging
 * origin. Production (CP7-T1) needs `--confirm production`, takes the API
 * origin of cloudflare/pinned.production.json (refused while it is null) and
 * the credentials of the environment or ~/.config/chopshop/secrets.production.env
 * only, and in addition:
 *   - /health must say production and /ready be on 0052 or later (the
 *     catalogue plan this copy feeds needs 0052 to land);
 *   - every shop the run copies for must already be a tenant on the API: the
 *     copy acts as each shop, so the platform import (import.mjs) comes first.
 *     A missing shop refuses the run before any file is fetched;
 *   - the shops that are archived (D21) are not imported, so their files are
 *     not copied;
 *   - the acting-as reason names the cutover, not the design review.
 * A manifest in --out written for another environment or API is refused, so
 * a production copy never continues a staging one.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COPY_MANIFEST_FILE,
  emptyCopyManifest,
  indexCopyManifest,
  kindOfUse,
  lookupEntry,
  objectKeyOf,
  readCopyManifest,
  upsertEntry,
  uploadFileName,
  USES,
  writeCopyManifest,
} from './lib/copy-manifest.mjs';
import { collectCopySources, fetchAddressOf, isFetchable, loadWorkerModule } from './lib/copy-sources.mjs';
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
import { ARCHIVED_SHOP_IDS } from './lib/transform-shops.mjs';

export const PENDING_FILE = 'copy-pending.json';
export const PUBLIC_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const SVG_MAX_BYTES = 512 * 1024;
const IMAGE_HEAD_BYTES = 64 * 1024;
const TRIES = 3;
const SOURCE_TIMEOUT_MS = 60_000;
// 0039: the public-object admission (reserve of product_media / shop_branding).
export const REQUIRED_MIGRATION = '0039';
// 0052: production imports its catalogue as a second run of its own kind.
export const PRODUCTION_REQUIRED_MIGRATION = '0052';
export const ACTING_AS_REASON =
  'CP4 staging import for the design review: storage-copy.mjs copies the source images of this shop';
export const PRODUCTION_ACTING_AS_REASON =
  'CP7 cutover: storage-copy.mjs copies the source images of this shop from the frozen export';

const STATUSES_IN_ORDER = ['copied', 'refused', 'missing', 'failed'];

export function parseArgs(argv) {
  const out = { bundle: null, dryRun: false, env: null, limit: null, out: null, shop: null };
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
    else if (arg === '--limit') {
      const raw = value();
      if (!/^[1-9]\d{0,6}$/.test(raw)) throw new RefusedError('--limit must be a positive integer');
      out.limit = Number(raw);
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

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
}

function readPending(filePath) {
  if (!existsSync(filePath)) return {};
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  return parsed !== null && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
    ? parsed.entries
    : {};
}

function writePending(filePath, entries) {
  if (Object.keys(entries).length === 0) {
    rmSync(filePath, { force: true });
    return;
  }
  writeJsonAtomic(filePath, { entries });
}

// ── the source ──────────────────────────────────────────────────────────────

/**
 * GET one file from the source, capped. Answers
 *   { status: 'ok', bytes, contentType }   (the source's stated type, lower case)
 *   { status: 'missing', reason: 'http_404' }
 *   { status: 'too_large' }
 *   { status: 'failed', reason, transient }
 */
async function fetchSourceOnce(fetchImpl, address, capBytes) {
  let response;
  try {
    response = await fetchImpl(fetchAddressOf(address), {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  } catch (error) {
    return { reason: error?.name === 'TimeoutError' ? 'timeout' : 'network_error', status: 'failed', transient: true };
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { reason: 'http_404', status: 'missing' };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return {
      reason: `http_${response.status}`,
      status: 'failed',
      transient: response.status === 429 || response.status >= 500,
    };
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > capBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { status: 'too_large' };
  }
  const chunks = [];
  let total = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > capBytes) {
          await response.body.cancel().catch(() => undefined);
          return { status: 'too_large' };
        }
        chunks.push(chunk);
      }
    }
  } catch (error) {
    return { reason: error?.name === 'TimeoutError' ? 'timeout' : 'network_error', status: 'failed', transient: true };
  }
  return {
    bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    contentType: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(),
    status: 'ok',
  };
}

async function fetchSource(fetchImpl, address, sleep) {
  let last = null;
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    last = await fetchSourceOnce(fetchImpl, address, PUBLIC_IMAGE_MAX_BYTES);
    if (last.status !== 'failed' || !last.transient) return last;
    if (attempt < TRIES) await sleep(1_000 * attempt);
  }
  return last;
}

/** The SVG's first markup, after a BOM, whitespace, an XML declaration or comments. */
function looksLikeSvg(bytes, sourceType) {
  if (sourceType === 'image/svg+xml') return true;
  const text = bytes.subarray(0, 4_096).toString('utf8').replace(/^﻿/, '').trimStart();
  return text.startsWith('<') && /<svg[\s>]/i.test(text);
}

/**
 * The type to state at reserve: the raster type the Worker's sniff proves, or
 * SVG (proven by the Worker's checkSvg at upload), or null (not an image).
 */
export function statedTypeOf(sniff, bytes, sourceType) {
  const raster = sniff.sniffImageType(new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, IMAGE_HEAD_BYTES)));
  if (raster !== null) return raster;
  return looksLikeSvg(bytes, sourceType) ? 'image/svg+xml' : null;
}

// ── the Worker ──────────────────────────────────────────────────────────────

function workerReason(result) {
  const reason = result.json?.error?.reason;
  return typeof reason === 'string' && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : `http_${result.status}`;
}

async function withTries(fn, sleep) {
  let lastError = null;
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    try {
      const result = await fn();
      if (result.status < 500) return result;
      lastError = { reason: `http_${result.status}` };
    } catch (error) {
      lastError = { reason: error?.code === 'timeout' ? 'timeout' : 'network_error' };
    }
    if (attempt < TRIES) await sleep(1_000 * attempt);
  }
  return { failure: lastError.reason, status: 0 };
}

/**
 * An admin request in `shopId`'s context under the platform user's acting-as
 * grant. A 404 can mean the grant ran out or was revoked: the grant is minted
 * again and the request made once more.
 */
async function adminRequest(session, shopId, method, route, options, sleep, reason) {
  const attempt = () => session.request(method, route, { ...options, shop: shopId });
  let result = await withTries(attempt, sleep);
  if (result.status === 404) {
    session.dropActingAs(shopId);
    await session.ensureActingAs(shopId, reason);
    result = await withTries(attempt, sleep);
  }
  return result;
}

async function readObject(session, shopId, objectId, sleep, reason) {
  const result = await adminRequest(session, shopId, 'GET', `/v1/admin/objects/${encodeURIComponent(objectId)}`, {}, sleep, reason);
  return result.status === 200 && result.json?.object ? result.json.object : null;
}

function activeWith(object, sha256, sizeBytes) {
  return object !== null && object.status === 'active' && object.sha256 === sha256 && object.sizeBytes === sizeBytes;
}

// ── one file ────────────────────────────────────────────────────────────────

// A product-media source keeps the key the journal has always had; a branding
// source of the same address is another object and has its own.
function pendingKeyOf(source) {
  const kind = kindOfUse(source.use);
  return `${source.shopId}\n${source.sourceKey}${kind === 'product_media' ? '' : `\n${kind}`}`;
}

function entryOf(source, fields) {
  return {
    contentType: null,
    objectId: null,
    reason: null,
    sha256: null,
    shopId: source.shopId,
    sizeBytes: 0,
    sourceKey: source.sourceKey,
    status: 'failed',
    use: source.use,
    ...fields,
  };
}

/**
 * Copies one source and answers its manifest entry. `context` holds the
 * session, the sniff module, the pending journal and the per-shop object
 * index by (kind, sha256).
 */
async function copyOne(source, context) {
  const { fetchSourceImpl, pending, pendingFile, reason, session, sleep, sniff, sameBytes } = context;
  const pendingKey = pendingKeyOf(source);
  if (!isFetchable(source.address)) return entryOf(source, { reason: 'not_fetchable' });

  const fetched = await fetchSource(fetchSourceImpl, source.address, sleep);
  if (fetched.status === 'missing') return entryOf(source, { reason: fetched.reason, status: 'missing' });
  if (fetched.status === 'too_large') return entryOf(source, { reason: 'too_large', status: 'refused' });
  if (fetched.status !== 'ok') return entryOf(source, { reason: fetched.reason });

  const bytes = fetched.bytes;
  const sha256 = sha256Hex(bytes);
  const sizeBytes = bytes.byteLength;
  const known = { sha256, sizeBytes };
  if (sizeBytes === 0) return entryOf(source, { ...known, reason: 'empty', status: 'refused' });

  const contentType = statedTypeOf(sniff, bytes, fetched.contentType);
  if (contentType === null) return entryOf(source, { ...known, reason: 'not_an_image', status: 'refused' });
  if (contentType === 'image/svg+xml' && sizeBytes > SVG_MAX_BYTES) {
    return entryOf(source, { ...known, contentType, reason: 'too_large', status: 'refused' });
  }
  const kind = kindOfUse(source.use);
  const copied = (objectId) => entryOf(source, { ...known, contentType, objectId, status: 'copied' });

  // One file, one object: the same bytes of the same kind in this shop.
  const shared = sameBytes[`${source.shopId}\n${kind}\n${sha256}`];
  if (shared !== undefined && shared.contentType === contentType) {
    context.stats.sharedObjects += 1;
    return copied(shared.objectId);
  }

  await session.ensureActingAs(source.shopId, reason);

  // A reservation of an earlier run that stopped before its manifest entry.
  let objectId = null;
  const earlier = pending[pendingKey];
  if (earlier && earlier.sha256 === sha256 && earlier.sizeBytes === sizeBytes && earlier.contentType === contentType) {
    const object = await readObject(session, source.shopId, earlier.objectId, sleep, reason);
    if (activeWith(object, sha256, sizeBytes)) {
      context.stats.resumedObjects += 1;
      return copied(earlier.objectId);
    }
    if (object !== null && object.status === 'pending') objectId = earlier.objectId;
  }

  if (objectId === null) {
    const fileName = uploadFileName(contentType);
    const reserved = await adminRequest(
      session,
      source.shopId,
      'POST',
      '/v1/admin/objects',
      { json: { contentType, fileName, kind, sha256, sizeBytes } },
      sleep,
      reason,
    );
    if (reserved.status === 0) return entryOf(source, { ...known, contentType, reason: reserved.failure });
    if (reserved.status === 400) {
      return entryOf(source, { ...known, contentType, reason: workerReason(reserved), status: 'refused' });
    }
    if (reserved.status !== 201 || typeof reserved.json?.object?.objectId !== 'string') {
      return entryOf(source, { ...known, contentType, reason: `http_${reserved.status}` });
    }
    objectId = reserved.json.object.objectId;
    const expectedKey = objectKeyOf(copied(objectId));
    if (reserved.json.object.objectKey !== expectedKey) {
      return entryOf(source, { ...known, contentType, reason: 'key_mismatch' });
    }
    pending[pendingKey] = { contentType, objectId, sha256, sizeBytes };
    writePending(pendingFile, pending);
  }

  const uploaded = await adminRequest(
    session,
    source.shopId,
    'PUT',
    `/v1/admin/objects/${encodeURIComponent(objectId)}/content`,
    { bytes, headers: { 'content-type': contentType } },
    sleep,
    reason,
  );
  if (uploaded.status === 200 && activeWith(uploaded.json?.object ?? null, sha256, sizeBytes)) return copied(objectId);
  if (uploaded.status === 400 || uploaded.status === 413) {
    return entryOf(source, { ...known, contentType, reason: workerReason(uploaded), status: 'refused' });
  }
  // A lost answer, a conflict or an unverified success: what the Worker holds decides.
  const object = await readObject(session, source.shopId, objectId, sleep, reason);
  if (activeWith(object, sha256, sizeBytes)) return copied(objectId);
  return entryOf(source, {
    ...known,
    contentType,
    reason: uploaded.status === 0 ? uploaded.failure : uploaded.status === 200 ? 'upload_unverified' : `http_${uploaded.status}`,
  });
}

// ── the run ─────────────────────────────────────────────────────────────────

function countsOf(entries, sources) {
  const inRun = new Set(sources.map((source) => `${source.shopId}\n${source.sourceKey}\n${kindOfUse(source.use)}`));
  const counts = {};
  for (const entry of entries) {
    if (!inRun.has(`${entry.shopId}\n${entry.sourceKey}\n${kindOfUse(entry.use)}`)) continue;
    counts[entry.shopId] ??= {};
    counts[entry.shopId][entry.use] ??= {};
    counts[entry.shopId][entry.use][entry.status] = (counts[entry.shopId][entry.use][entry.status] ?? 0) + 1;
  }
  return counts;
}

function printCounts(log, title, counts) {
  log(title);
  for (const shopId of Object.keys(counts).sort()) {
    for (const use of USES) {
      const row = counts[shopId][use];
      if (!row) continue;
      const cells = STATUSES_IN_ORDER.filter((status) => row[status]).map((status) => `${status} ${row[status]}`);
      log(`  ${shopId.padEnd(20)} ${use.padEnd(17)} ${cells.join(', ')}`);
    }
  }
}

function sourceCountsByShopUse(sources) {
  const counts = {};
  for (const source of sources) {
    counts[source.shopId] ??= {};
    counts[source.shopId][source.use] ??= { files: 0, references: 0 };
    counts[source.shopId][source.use].files += 1;
    counts[source.shopId][source.use].references += source.references;
  }
  return counts;
}

/**
 * Production: every shop of the run must already be a tenant on the API (the
 * platform import comes first; the copy acts as each shop). Refuses the run,
 * naming the missing shops, before any file is fetched.
 */
async function requireTenants(session, sources) {
  const missing = [];
  for (const shopId of [...new Set(sources.map((source) => source.shopId))].sort()) {
    const result = await session.request('GET', `/v1/platform/tenants/${encodeURIComponent(shopId)}`);
    if (result.status === 404) missing.push(shopId);
    else if (result.status !== 200) throw new RefusedError(`tenant ${shopId} could not be read: HTTP ${result.status}`);
  }
  if (missing.length > 0) {
    throw new RefusedError(
      `the platform import is not applied: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not a tenant on the API (apply import.mjs's plan first; the copy acts as each shop)`,
    );
  }
}

/**
 * The whole run, with its dependencies injectable for the tests:
 *   apiOrigin        the API (the CLI takes the pinned staging origin)
 *   credentials      { email, password } (the CLI reads them from env / file)
 *   fetchApiImpl     fetch for the API; fetchSourceImpl fetch for the source
 *   sleep, log, now
 * Answers { exitCode, counts, manifestPath }.
 */
export async function runStorageCopy(args, deps) {
  const confirmation = confirmationProblem(args.env, args.confirm);
  if (confirmation !== null) throw new RefusedError(confirmation);
  const production = args.env === 'production';
  const log = deps.log ?? ((line) => console.log(line));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const outDir = path.resolve(args.out);
  if (isInsideRepo(outDir, deps.repoRoot ?? REPO_ROOT)) {
    throw new RefusedError('--out resolves inside the repository; the manifest must live outside it');
  }
  const bundleDir = path.resolve(args.bundle);
  const bundleManifest = path.join(bundleDir, 'manifest.json');
  if (!existsSync(bundleManifest)) throw new RefusedError('--bundle holds no manifest.json');
  const bundleManifestSha256 = sha256Hex(readFileSync(bundleManifest));

  const collected = collectCopySources(bundleDir, { shop: args.shop });
  const referenceCounts = collected.counts;
  // Production imports no archived shop (D21): its files have no row to name them.
  const archivedLeftOut = production ? collected.sources.filter((source) => ARCHIVED_SHOP_IDS.has(source.shopId)) : [];
  const allSources = production ? collected.sources.filter((source) => !ARCHIVED_SHOP_IDS.has(source.shopId)) : collected.sources;
  const manifestPath = path.join(outDir, COPY_MANIFEST_FILE);
  const pendingFile = path.join(outDir, PENDING_FILE);

  let manifest = existsSync(manifestPath) ? readCopyManifest(manifestPath) : null;
  if (manifest !== null) {
    if (manifest.env !== args.env || manifest.apiOrigin !== deps.apiOrigin) {
      throw new RefusedError('the manifest in --out was written for another environment or API');
    }
    if (manifest.bundleManifestSha256 !== bundleManifestSha256) {
      throw new RefusedError('the manifest in --out was written from another bundle');
    }
  }
  const index = manifest === null ? new Map() : indexCopyManifest(manifest);
  const todo = allSources.filter((source) => lookupEntry(index, source.shopId, source.sourceKey, kindOfUse(source.use))?.status !== 'copied');
  const alreadyCopied = allSources.length - todo.length;
  const selected = args.limit === null ? todo : todo.slice(0, args.limit);

  const bySource = sourceCountsByShopUse(allSources);
  log(`sources: ${allSources.length} distinct files (shop, address)${args.shop ? ` in shop ${args.shop}` : ''}`);
  for (const shopId of Object.keys(bySource).sort()) {
    for (const use of USES) {
      const row = bySource[shopId][use];
      if (row) log(`  ${shopId.padEnd(20)} ${use.padEnd(17)} files ${row.files}, references ${row.references}`);
    }
  }
  const notSource = Object.entries(referenceCounts.notSourceStorage).flatMap(([shopId, uses]) =>
    Object.entries(uses).map(([use, n]) => `${shopId}/${use} ${n}`),
  );
  log(`not of the source's storage (never copied): ${notSource.length === 0 ? 'none' : notSource.join(', ')}`);
  const notFetchable = Object.entries(referenceCounts.notFetchable).flatMap(([shopId, uses]) =>
    Object.entries(uses).map(([use, n]) => `${shopId}/${use} ${n}`),
  );
  if (notFetchable.length > 0) log(`source addresses that cannot be fetched: ${notFetchable.join(', ')}`);
  log(`page attachments in the bundle (not copied, not imported): ${referenceCounts.pageAttachments}`);
  if (production) {
    const byShop = {};
    for (const source of archivedLeftOut) byShop[source.shopId] = (byShop[source.shopId] ?? 0) + 1;
    const cells = Object.entries(byShop).map(([shopId, n]) => `${shopId} ${n}`);
    log(`archived shops (D21, not imported), files not copied: ${cells.length === 0 ? 'none' : cells.join(', ')}`);
  }
  log(`already copied (skipped): ${alreadyCopied}; to try now: ${selected.length}${args.limit !== null ? ` (--limit ${args.limit} of ${todo.length})` : ''}`);

  if (args.dryRun) {
    log('dry run: no request made, nothing written');
    return { counts: sourceCountsByShopUse(selected), exitCode: 0, manifestPath: null };
  }
  if (selected.length === 0) {
    log('nothing to copy');
    return { counts: countsOf(manifest?.entries ?? [], allSources), exitCode: 0, manifestPath };
  }

  mkdirSync(outDir, { mode: 0o700, recursive: true });
  chmodSync(outDir, 0o700);
  if (manifest === null) {
    manifest = emptyCopyManifest({ apiOrigin: deps.apiOrigin, bundleManifestSha256, env: args.env });
    writeCopyManifest(manifestPath, manifest);
  }

  const session = createApiSession({ apiOrigin: deps.apiOrigin, fetchImpl: deps.fetchApiImpl, now: deps.now, sleep });
  await preflight(session, {
    environment: args.env,
    requiredMigration: production ? PRODUCTION_REQUIRED_MIGRATION : REQUIRED_MIGRATION,
  });
  await session.signIn(deps.credentials);
  log('signed in as the platform user');
  if (production) {
    await requireTenants(session, selected);
    log('every shop of the run is a tenant on the API');
  }

  const sniff = await loadWorkerModule('storage/image-sniff.ts', { repoRoot: deps.repoRoot ?? REPO_ROOT });
  const pending = readPending(pendingFile);
  // Plain objects, not Map/Set: test/no-write-calls.test.mjs forbids write-shaped
  // method calls (set, add) in this directory.
  const sameBytes = Object.create(null);
  for (const entry of manifest.entries) {
    if (entry.status === 'copied') {
      sameBytes[`${entry.shopId}\n${kindOfUse(entry.use)}\n${entry.sha256}`] = entry;
    }
  }
  const stats = { resumedObjects: 0, sharedObjects: 0 };
  const context = {
    fetchSourceImpl: deps.fetchSourceImpl ?? globalThis.fetch,
    pending,
    pendingFile,
    reason: production ? PRODUCTION_ACTING_AS_REASON : ACTING_AS_REASON,
    sameBytes,
    session,
    sleep,
    sniff,
    stats,
  };

  const shopsDone = Object.create(null);
  let done = 0;
  for (const source of selected) {
    let entry;
    try {
      entry = await copyOne(source, context);
    } catch (error) {
      if (!(error instanceof RefusedError)) throw error;
      // The shop cannot be opened (acting-as refused): every file of it fails.
      const match = /HTTP (\d{3})/.exec(error.message);
      entry = entryOf(source, { reason: match ? `acting_as_http_${match[1]}` : 'acting_as_refused' });
    }
    upsertEntry(manifest, entry);
    writeCopyManifest(manifestPath, manifest);
    if (entry.status === 'copied') {
      sameBytes[`${entry.shopId}\n${kindOfUse(entry.use)}\n${entry.sha256}`] = entry;
    }
    const pendingKey = pendingKeyOf(source);
    if (pending[pendingKey] && (entry.status === 'copied' || entry.status === 'refused')) {
      delete pending[pendingKey];
      writePending(pendingFile, pending);
    }
    shopsDone[source.shopId] = true;
    done += 1;
    if (done % 25 === 0 || done === selected.length) log(`  ${done}/${selected.length}`);
  }

  for (const shopId of Object.keys(shopsDone).sort()) {
    try {
      await session.endActingAs(shopId);
    } catch {
      // The grant runs out by itself within the hour.
    }
  }

  const counts = countsOf(manifest.entries, allSources);
  printCounts(log, 'result (per shop and use):', counts);
  log(`objects shared by identical files: ${stats.sharedObjects}; found again from an earlier run: ${stats.resumedObjects}`);
  log(`API requests: ${session.stats.requests}; waits on 429: ${session.stats.rateLimitWaits}`);
  const failed = manifest.entries.filter((entry) => entry.status === 'failed').length;
  log(`manifest: ${COPY_MANIFEST_FILE} in --out (${manifest.entries.length} entries, ${failed} failed)`);
  return { counts, exitCode: failed === 0 ? 0 : 1, manifestPath };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { apiOrigin } = apiTarget({ confirm: args.confirm, env: args.env });
    const credentials = args.dryRun ? null : credentialsFor(args.env);
    const { exitCode } = await runStorageCopy(args, { apiOrigin, credentials });
    process.exitCode = exitCode;
  } catch (error) {
    if (error instanceof RefusedError) {
      console.error(`STORAGE COPY REFUSED: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`STORAGE COPY FAILED: ${error?.message ?? 'unknown error'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
