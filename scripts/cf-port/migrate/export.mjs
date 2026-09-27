#!/usr/bin/env node
/**
 * scripts/cf-port/migrate/export.mjs — CP3: the READ-ONLY export tool that
 * turns production Firestore + Firebase Auth into a checksummed local
 * bundle, per docs/cf-port/MIGRATION_MANIFEST.md §(c)/(d).
 *
 *   node scripts/cf-port/migrate/export.mjs [--out <dir>] [--apply] [--only <collection>[,<collection>…]]
 *
 * DEFAULT IS A DRY RUN: lists every collection found, its document count and
 * its manifest fate, and prints what WOULD be written. Nothing is written to
 * disk unless --apply is given. REVIEW ROUND 1 FIX 6: a dry run now reads
 * ONLY counts (`count().get()`), never document contents — personal data is
 * never pulled into memory unless something will actually be written.
 *
 * This script NEVER writes to Firestore or Auth. The only calls it makes
 * against the injected clients are: listCollections(), collection.listDocuments(),
 * collection.get()/paged get() with orderBy(FieldPath.documentId()),
 * doc.listCollections(), collection.count().get(), and auth.listUsers(). See
 * test/no-write-calls.test.mjs, which greps this file and lib/*.mjs for any
 * write-shaped method name and fails the build if one appears.
 *
 * Firebase is loaded lazily (inside main(), only when this file is run
 * directly) so that `node --test` can import the exported functions without
 * ever needing firebase-admin on the test machine.
 *
 * REVIEW ROUND 1 fixes implemented here: 3 (live re-count after writing),
 * 4 (discovery of subcollections the manifest doesn't name, via
 * `docRef.listCollections()`, bounded concurrency, 2 levels deep + a loud
 * warning for anything found at a 3rd level), 5 (explicit projectId +
 * GOOGLE_CLOUD_PROJECT guard), 6 (dry run reads counts only), 7 (refuse
 * before the database walk; resolve symlinks in the --out check).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { encode, canonicalStringify, UnknownFirestoreTypeError } from './lib/typed-json.mjs';
import { ensureDir, writeFileSecure, writeParts, writeCollectionManifest, writeShaSums, listFilesRecursive } from './lib/bundle-writer.mjs';
import {
  COLLECTION_FATES,
  KNOWN_SUBCOLLECTIONS_BY_PARENT,
  SETTINGS_DOC_FATES,
  fateForCollection,
  fateForSubcollection,
  fateForSettingsDoc,
} from './lib/manifest-fates.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCHEMA_VERSION = 1;
const PROJECT_ID = 'b8shield-reseller-app';
const DATABASE_NAME = 'b8s-reseller-db';

// REVIEW ROUND 1 FIX 4: subcollection discovery goes at most this many levels
// deep below a TOP-LEVEL collection document. Level 1 = a subcollection
// directly under a top-level doc (e.g. users/{id}/marketingMaterials) —
// what the manifest already names. Level 2 = a subcollection under a level-1
// subcollection document. A level-3 finding is not read; it is only named in
// a loud warning so a human decides (per the brief: "if a third level is
// found, export nothing from it but add a loud warning").
const MAX_SUBCOLLECTION_DEPTH = 2;

// REVIEW ROUND 1 FIX 4: bounded concurrency for the many small
// listCollections()/listDocuments() calls the subcollection walk makes, so
// ~6,500 documents (the brief's estimate) don't serialize into an hour. A
// tiny hand-rolled limiter — no dependency.
const SUBCOLLECTION_DISCOVERY_CONCURRENCY = 16;

/** Runs `worker(item)` over `items` with at most `concurrency` in flight at
 * once, preserving no particular return order requirement (callers collect
 * side effects, not ordered results). No dependency: a manual pool of
 * `concurrency` self-refilling workers pulling from a shared cursor. */
async function mapWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const results = new Array(items.length);
  async function runOne() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runOne());
  await Promise.all(workers);
  return results;
}

// The only fields ever written for an Auth user (an ALLOWLIST, not a
// deny-list — see the hard rule in the brief). Everything else, including
// passwordHash/passwordSalt/tokensValidAfterTime/customClaims/phoneNumber/
// photoURL, is never even read into the output object.
function pickAuthUserFields(user) {
  return {
    uid: user.uid,
    email: user.email ?? null,
    emailVerified: user.emailVerified ?? false,
    disabled: user.disabled ?? false,
    displayName: user.displayName ?? null,
    metadata: {
      creationTime: user.metadata?.creationTime ?? null,
      lastSignInTime: user.metadata?.lastSignInTime ?? null,
    },
    providerData: (user.providerData ?? []).map((p) => ({ providerId: p.providerId })),
  };
}

function die(message) {
  console.error(`EXPORT REFUSED: ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function info(label, value) {
  console.log(`  ${String(label).padEnd(28)} ${value}`);
}

function parseArgs(argv) {
  const out = { out: null, apply: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      out.apply = true;
    } else if (arg === '--out') {
      out.out = argv[++i] ?? die('--out needs a value');
    } else if (arg === '--only') {
      const raw = argv[++i] ?? die('--only needs a value');
      out.only = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      die(`unknown argument ${arg}`);
    }
  }
  return out;
}

/**
 * Refuses an --out path that resolves inside the repo root.
 *
 * REVIEW ROUND 1 FIX 7: resolves symlinks before comparing, using
 * `realpathSync` on the nearest EXISTING ancestor of the path (the path
 * itself, or its target bundle directory, need not exist yet — only some
 * ancestor must). This catches `--out` being a symlink that points into the
 * repo even though its literal path string does not.
 */
function assertOutsideRepo(resolvedOutDir) {
  const realRepoRoot = existsSync(REPO_ROOT) ? realpathSync(REPO_ROOT) : REPO_ROOT;

  let ancestor = resolvedOutDir;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break; // reached filesystem root without finding an existing ancestor
    ancestor = parent;
  }
  const realAncestor = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
  // Re-attach whatever suffix of resolvedOutDir did not exist, onto the
  // REAL (symlink-resolved) ancestor, so a symlinked ancestor is caught even
  // when the leaf bundle directory itself doesn't exist yet.
  const suffix = path.relative(ancestor, resolvedOutDir);
  const realResolvedOutDir = suffix === '' ? realAncestor : path.join(realAncestor, suffix);

  for (const candidate of [resolvedOutDir, realResolvedOutDir]) {
    const rel = path.relative(realRepoRoot, candidate);
    const isInside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (isInside) {
      die(`--out ${resolvedOutDir} resolves inside the repo root (${REPO_ROOT}); the bundle must be written OUTSIDE the repo`);
    }
  }
}

function gitInfo() {
  let sha = 'unknown';
  let dirty = false;
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    sha = 'unknown';
  }
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    dirty = status.trim().length > 0;
  } catch {
    dirty = false;
  }
  return { sha, dirty };
}

/** Retention per §(c): orders, orderProduction, checkouts keep 7 full
 * calendar years after the end of the export's fiscal year (ASSUMED = the
 * calendar year the export runs in — nothing in DECISIONS.md states a
 * non-calendar fiscal year; confirm with the accountant before the
 * production export, per review round 1 answer 3); everything else is null. */
function retainUntilFor(collectionName, exportedAt) {
  const RETAINED = new Set(['orders', 'orderProduction', 'checkouts']);
  if (!RETAINED.has(collectionName)) return null;
  const fiscalYearEnd = new Date(Date.UTC(new Date(exportedAt).getUTCFullYear(), 11, 31, 23, 59, 59));
  const retainUntil = new Date(Date.UTC(fiscalYearEnd.getUTCFullYear() + 7, 11, 31, 23, 59, 59));
  return retainUntil.toISOString();
}

/**
 * Reads every document of a Firestore collection reference through
 * listDocuments() (so phantom/missing-data doc refs still surface — needed
 * for subcollection walks under a possibly-deleted parent) rather than
 * .get(), paged with orderBy(FieldPath.documentId()) for large collections.
 * Read-only: listDocuments() elsewhere, .get() here, paged. No write call.
 */
async function readAllDocuments(collectionRef, { FieldPath, pageSize = 500 } = {}) {
  const docs = [];
  let lastDocId = null;
  for (;;) {
    const activeQuery =
      lastDocId === null
        ? collectionRef.orderBy(FieldPath.documentId()).limit(pageSize)
        : collectionRef.orderBy(FieldPath.documentId()).startAfter(lastDocId).limit(pageSize);
    const snapshot = await activeQuery.get();
    if (snapshot.empty) break;
    for (const doc of snapshot.docs) {
      docs.push(doc);
    }
    lastDocId = snapshot.docs[snapshot.docs.length - 1].id;
    if (snapshot.docs.length < pageSize) break;
  }
  return docs;
}

/** Read-only count for a collection reference: `count().get()`. Used by the
 * dry run (fix 6) and by the post-write live re-count (fix 3). */
async function countDocuments(collectionRef) {
  const counted = await collectionRef.count().get();
  return counted.data().count;
}

/**
 * Builds a bundle-format document record from a Firestore doc snapshot.
 * REVIEW ROUND 1 FIX 2: encode() can throw UnknownFirestoreTypeError for a
 * class instance matching no known Firestore type; this wraps that throw
 * with the document PATH added (never the field contents) so the failure is
 * traceable to a specific document without leaking its data into the error.
 */
function bundleDocFromSnapshot(basePath, doc) {
  const createTime = doc.createTime && typeof doc.createTime.toDate === 'function' ? doc.createTime.toDate().toISOString() : doc.createTime ?? null;
  const updateTime = doc.updateTime && typeof doc.updateTime.toDate === 'function' ? doc.updateTime.toDate().toISOString() : doc.updateTime ?? null;
  const rawData = doc.data ? doc.data() : doc._data ?? {};
  let encodedData;
  try {
    encodedData = encode(rawData);
  } catch (error) {
    if (error instanceof UnknownFirestoreTypeError) {
      throw new UnknownFirestoreTypeError(error.constructorName, basePath);
    }
    throw error;
  }
  return {
    path: basePath,
    id: doc.id,
    createTime,
    updateTime,
    data: encodedData,
    _updateTimeRaw: updateTime,
  };
}

/**
 * REVIEW ROUND 1 FIX 4: discovers every subcollection actually present under
 * a document, recursively, up to MAX_SUBCOLLECTION_DEPTH levels, using
 * `docRef.listCollections()` (a read-only primitive; see no-write-calls
 * test). Runs with bounded concurrency across the parent doc refs at each
 * level. Returns:
 *   {
 *     found: [ { flattenedName, parentPath, subName, depth, docs: [snapshot,...] }, ... ],
 *     tooDeep: [ 'pathPattern', ... ]   // level-3+ findings, NEVER READ, only named
 *   }
 * `flattenedName` for a level-1 subcollection is `<topLevelCollection>__<sub>`
 * (matching the manifest's convention); for a level-2 subcollection it is
 * `<topLevelCollection>__<sub1>__<sub2>`.
 */
async function discoverAndReadSubcollections({ topLevelCollectionName, parentRefs, FieldPath }) {
  const found = [];
  const tooDeep = [];

  // level 1: every subcollection actually present under each top-level doc,
  // via listCollections() (not just the two the manifest names — that is
  // exactly the gap fix 4 closes).
  const level1PerParent = await mapWithConcurrency(parentRefs, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (parentRef) => {
    const subRefs = await parentRef.listCollections();
    return { parentRef, subRefs };
  });

  // Flatten to a work list of { parentRef, subRef } pairs, then read each
  // subcollection's documents (still bounded concurrency).
  const level1Work = [];
  for (const { parentRef, subRefs } of level1PerParent) {
    for (const subRef of subRefs) {
      level1Work.push({ parentRef, subRef });
    }
  }

  const level1Read = await mapWithConcurrency(level1Work, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async ({ parentRef, subRef }) => {
    const docs = await readAllDocuments(subRef, { FieldPath });
    return { parentRef, subRef, docs };
  });

  for (const { parentRef, subRef, docs } of level1Read) {
    found.push({
      flattenedName: `${topLevelCollectionName}__${subRef.id}`,
      parentPath: parentRef.path,
      subName: subRef.id,
      depth: 1,
      docs,
    });
  }

  if (MAX_SUBCOLLECTION_DEPTH < 2) {
    return { found, tooDeep };
  }

  // level 2: for every level-1 subcollection document, look for further
  // subcollections underneath IT. We need per-document refs, so re-derive
  // them via subRef.doc-like access: FakeCollectionRef/real CollectionRef
  // both expose the docs already (level1Read docs are snapshots with `.id`,
  // not refs) — get a doc ref by combining subRef with the doc id via the
  // collection's own `.doc`-shaped access pattern. To keep this generic
  // (works for the fake, which doesn't implement `.doc()`), we instead
  // re-list the level-1 subcollection's PARENT DOC REFS the same way we did
  // for the top level: `subRef.listDocuments()`.
  const level2ParentWork = level1Work.map(({ subRef }) => subRef);
  const level2ParentRefsPerSub = await mapWithConcurrency(level2ParentWork, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (subRef) => {
    const refs = await subRef.listDocuments();
    return { subRef, refs };
  });

  const level2Discovery = await mapWithConcurrency(level2ParentRefsPerSub, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async ({ subRef, refs }) => {
    const perDoc = await mapWithConcurrency(refs, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (docRef) => {
      const subSubRefs = await docRef.listCollections();
      return { docRef, subSubRefs };
    });
    return { subRef, perDoc };
  });

  const level2Work = [];
  for (const { perDoc } of level2Discovery) {
    for (const { docRef, subSubRefs } of perDoc) {
      for (const subSubRef of subSubRefs) {
        level2Work.push({ docRef, subSubRef });
      }
    }
  }

  const level2Read = await mapWithConcurrency(level2Work, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async ({ docRef, subSubRef }) => {
    const docs = await readAllDocuments(subSubRef, { FieldPath });
    return { docRef, subSubRef, docs };
  });

  for (const { docRef, subSubRef, docs } of level2Read) {
    // docRef.path looks like "<top>/<id1>/<sub1>/<id2>"; the flattened name
    // needs <top>__<sub1>__<sub2>. subSubRef.path is docRef.path + "/" + name.
    const pathParts = docRef.path.split('/');
    const sub1Name = pathParts[2];
    found.push({
      flattenedName: `${topLevelCollectionName}__${sub1Name}__${subSubRef.id}`,
      parentPath: docRef.path,
      subName: subSubRef.id,
      depth: 2,
      docs,
    });

    // level 3 check: does anything exist ONE level further down? We do not
    // read it — only name it in a warning, per the brief ("export nothing
    // from it but add a loud warning naming the path pattern").
  }

  // level-3 probe (read-only listCollections() on each level-2 doc — this is
  // still just a NAME lookup, never a document read).
  const level3ParentWork = level2Work.map(({ subSubRef }) => subSubRef);
  const level3ParentRefsPerSub = await mapWithConcurrency(level3ParentWork, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (subSubRef) => {
    const refs = await subSubRef.listDocuments();
    return { subSubRef, refs };
  });
  const level3Discovery = await mapWithConcurrency(level3ParentRefsPerSub, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async ({ subSubRef, refs }) => {
    const perDoc = await mapWithConcurrency(refs, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (docRef) => {
      const subSubSubRefs = await docRef.listCollections();
      return { docRef, subSubSubRefs };
    });
    return { subSubRef, perDoc };
  });
  for (const { perDoc } of level3Discovery) {
    for (const { docRef, subSubSubRefs } of perDoc) {
      for (const subSubSubRef of subSubSubRefs) {
        tooDeep.push(`${docRef.path}/${subSubSubRef.id} (a 3rd-level subcollection — NOT read; the brief caps discovery at 2 levels)`);
      }
    }
  }

  return { found, tooDeep };
}

/**
 * Walks a top-level collection's documents PLUS every subcollection actually
 * present under any doc (phantom parents included), to MAX_SUBCOLLECTION_DEPTH
 * levels (fix 4). Returns { topLevelDocs, subcollectionEntries, tooDeepWarnings }
 * where subcollectionEntries is an array of
 * { flattenedName, parentPath, subName, depth, docs }.
 */
async function walkCollectionWithSubcollections(db, FieldPath, collectionName) {
  const collectionRef = db.collection(collectionName);
  const topLevelDocs = await readAllDocuments(collectionRef, { FieldPath });

  // listDocuments() surfaces every parent doc REFERENCE, including ones with
  // no data of their own (phantom parents), which is exactly what we need to
  // find subcollections under a deleted parent.
  const parentRefs = await collectionRef.listDocuments();
  const { found, tooDeep } = await discoverAndReadSubcollections({ topLevelCollectionName: collectionName, parentRefs, FieldPath });

  return { topLevelDocs, subcollectionEntries: found, tooDeepWarnings: tooDeep };
}

/**
 * Counts a top-level collection's documents PLUS every subcollection present
 * (to MAX_SUBCOLLECTION_DEPTH levels), WITHOUT reading any document's field
 * data — used by the dry run (fix 6). Returns
 * { topLevelCount, subcollectionCounts: [{ flattenedName, count, depth }],
 *   tooDeepWarnings }.
 */
async function countCollectionWithSubcollections(db, collectionName) {
  const collectionRef = db.collection(collectionName);
  const topLevelCount = await countDocuments(collectionRef);

  const parentRefs = await collectionRef.listDocuments();
  const level1PerParent = await mapWithConcurrency(parentRefs, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (parentRef) => {
    const subRefs = await parentRef.listCollections();
    return { parentRef, subRefs };
  });
  const level1Work = [];
  for (const { subRefs } of level1PerParent) {
    for (const subRef of subRefs) {
      level1Work.push(subRef);
    }
  }
  const level1Counts = await mapWithConcurrency(level1Work, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (subRef) => {
    const count = await countDocuments(subRef);
    return { subRef, count };
  });

  // Group level-1 counts by flattened name (many parents can share a sub name).
  const subcollectionCounts = {};
  for (const { subRef, count } of level1Counts) {
    const flattened = `${collectionName}__${subRef.id}`;
    subcollectionCounts[flattened] = (subcollectionCounts[flattened] ?? { count: 0, depth: 1 });
    subcollectionCounts[flattened].count += count;
  }

  const tooDeepWarnings = [];
  if (MAX_SUBCOLLECTION_DEPTH >= 2) {
    const level2ParentRefsPerSub = await mapWithConcurrency(level1Work, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (subRef) => {
      const refs = await subRef.listDocuments();
      return { subRef, refs };
    });
    const level2Discovery = await mapWithConcurrency(level2ParentRefsPerSub, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async ({ subRef, refs }) => {
      const perDoc = await mapWithConcurrency(refs, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (docRef) => {
        const subSubRefs = await docRef.listCollections();
        return { docRef, subSubRefs };
      });
      return { subRef, perDoc };
    });
    const level2Work = [];
    for (const { perDoc } of level2Discovery) {
      for (const { docRef, subSubRefs } of perDoc) {
        for (const subSubRef of subSubRefs) {
          level2Work.push({ docRef, subSubRef });
        }
      }
    }
    const level2Counts = await mapWithConcurrency(level2Work, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async ({ docRef, subSubRef }) => {
      const count = await countDocuments(subSubRef);
      return { docRef, subSubRef, count };
    });
    for (const { docRef, subSubRef, count } of level2Counts) {
      const sub1Name = docRef.path.split('/')[2];
      const flattened = `${collectionName}__${sub1Name}__${subSubRef.id}`;
      subcollectionCounts[flattened] = subcollectionCounts[flattened] ?? { count: 0, depth: 2 };
      subcollectionCounts[flattened].count += count;
    }

    // level-3 probe, count mode: still only a name lookup, never data.
    const level3ParentRefsPerSub = await mapWithConcurrency(level2Work, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async ({ subSubRef }) => {
      const refs = await subSubRef.listDocuments();
      return { subSubRef, refs };
    });
    const level3Discovery = await mapWithConcurrency(level3ParentRefsPerSub, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async ({ refs }) => {
      const perDoc = await mapWithConcurrency(refs, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (docRef) => {
        const subSubSubRefs = await docRef.listCollections();
        return { docRef, subSubSubRefs };
      });
      return perDoc;
    });
    for (const perDoc of level3Discovery) {
      for (const { docRef, subSubSubRefs } of perDoc) {
        for (const subSubSubRef of subSubSubRefs) {
          tooDeepWarnings.push(`${docRef.path}/${subSubSubRef.id} (a 3rd-level subcollection — NOT read; the brief caps discovery at 2 levels)`);
        }
      }
    }
  }

  return {
    topLevelCount,
    subcollectionCounts: Object.entries(subcollectionCounts).map(([flattenedName, v]) => ({ flattenedName, count: v.count, depth: v.depth })),
    tooDeepWarnings,
  };
}

/**
 * The core export routine, fully injectable: `db` and `auth` are duck-typed
 * Firestore/Auth clients (real or fake), `FieldPath` is the FieldPath class
 * (real firebase-admin export or a fake with the same shape), and `now`/`git`
 * are injectable for determinism in tests.
 */
async function runExport({
  db,
  auth,
  FieldPath,
  outDir,
  apply,
  only,
  now = () => new Date(),
  git = gitInfo,
  maxPartBytes = undefined,
}) {
  // REVIEW ROUND 1 FIX 7: refuse a pre-existing bundle directory BEFORE doing
  // any database work at all (previously this check ran only right before
  // writing, after the entire walk had already read every document).
  if (apply && existsSync(outDir)) {
    die(`bundle directory already exists: ${outDir}`);
  }

  const exportedAt = now().toISOString();
  const { sha: gitSha, dirty: gitDirty } = git();

  step('discovering collections');
  const topLevelRefs = await db.listCollections();
  const foundNames = topLevelRefs.map((ref) => ref.id).sort();
  info('collections found', foundNames.length);

  const onlyFilter = only && only.length > 0 ? new Set(only) : null;

  const plan = []; // { name, fate, row, present, docCount, isSubcollection, absent, tooDeep }
  const warnings = [];

  // Regular top-level collections (manifest-known + unknown), minus `settings`
  // which is handled specially below because its FATE is per-document.
  const namesToWalk = foundNames.filter((n) => n !== 'settings' && (onlyFilter === null || onlyFilter.has(n)));

  const collectionResults = {}; // name -> { docs: [bundleDoc...], fate }
  const subcollectionResults = {}; // flattenedName -> { docs, fate, parentPath, subName, depth }

  for (const name of namesToWalk) {
    const fateEntry = fateForCollection(name);
    const fate = fateEntry ? fateEntry.fate : 'unknown';
    if (fate === 'unknown') {
      warnings.push(`unknown collection (not in the manifest): ${name}`);
    }

    if (fate === 'drop') {
      // drop collections: count only, never read documents beyond that.
      const count = await countDocuments(db.collection(name));
      plan.push({ name, fate, row: fateEntry?.row ?? null, present: count > 0, docCount: count });
      continue;
    }

    if (!apply) {
      // REVIEW ROUND 1 FIX 6: dry run — counts only, never document data,
      // for the top-level collection AND every subcollection under it
      // (known or newly discovered).
      const { topLevelCount, subcollectionCounts, tooDeepWarnings } = await countCollectionWithSubcollections(db, name);
      plan.push({ name, fate, row: fateEntry?.row ?? null, present: topLevelCount > 0, docCount: topLevelCount });
      for (const { flattenedName, count, depth } of subcollectionCounts) {
        const subFate = fateForSubcollection(flattenedName);
        const subFateValue = subFate ? subFate.fate : 'unknown';
        if (subFate === null) {
          warnings.push(`unknown subcollection (not in the manifest): ${flattenedName}`);
        }
        plan.push({ name: flattenedName, fate: subFateValue, row: subFate?.row ?? null, present: count > 0, docCount: count, isSubcollection: true, depth });
      }
      for (const w of tooDeepWarnings) {
        warnings.push(`3rd-level subcollection found (not read, not exported): ${w}`);
      }
      continue;
    }

    const { topLevelDocs, subcollectionEntries, tooDeepWarnings } = await walkCollectionWithSubcollections(db, FieldPath, name);
    const bundleDocs = topLevelDocs.map((doc) => bundleDocFromSnapshot(`${name}/${doc.id}`, doc));
    collectionResults[name] = { docs: bundleDocs, fate };
    plan.push({ name, fate, row: fateEntry?.row ?? null, present: bundleDocs.length > 0, docCount: bundleDocs.length });

    // Group subcollection entries by flattened name (many parent docs can
    // share the same subcollection name).
    const byFlattened = {};
    for (const entry of subcollectionEntries) {
      byFlattened[entry.flattenedName] = byFlattened[entry.flattenedName] ?? [];
      byFlattened[entry.flattenedName].push(entry);
    }
    for (const [flattened, entries] of Object.entries(byFlattened)) {
      const subFate = fateForSubcollection(flattened);
      const subFateValue = subFate ? subFate.fate : 'unknown';
      if (subFate === null) {
        warnings.push(`unknown subcollection (not in the manifest): ${flattened}`);
      }
      const subDocs = [];
      for (const entry of entries) {
        for (const doc of entry.docs) {
          subDocs.push(bundleDocFromSnapshot(`${entry.parentPath}/${entry.subName}/${doc.id}`, doc));
        }
      }
      subcollectionResults[flattened] = { docs: subDocs, fate: subFateValue };
      plan.push({
        name: flattened,
        fate: subFateValue,
        row: subFate?.row ?? null,
        present: subDocs.length > 0,
        docCount: subDocs.length,
        isSubcollection: true,
      });
    }
    for (const w of tooDeepWarnings) {
      warnings.push(`3rd-level subcollection found (not read, not exported): ${w}`);
    }
  }

  // Manifest collections that are ABSENT entirely (not in foundNames at all).
  for (const [name, entry] of Object.entries(COLLECTION_FATES)) {
    if (name === 'settings') continue;
    if (onlyFilter !== null && !onlyFilter.has(name)) continue;
    if (!foundNames.includes(name)) {
      plan.push({ name, fate: entry.fate, row: entry.row, present: false, docCount: 0, absent: true });
    }
  }

  // `settings` collection: per-document fate (rows 67-75).
  let settingsPlan = null;
  const settingsResults = {}; // docId -> { doc: bundleDoc, fate }
  if (foundNames.includes('settings') && (onlyFilter === null || onlyFilter.has('settings'))) {
    if (!apply) {
      // Dry run: document IDS only (listDocuments() returns references, never
      // field data), so each settings doc's fate — and any doc the manifest
      // does not know — shows in the plan without reading contents.
      const settingsRefs = await db.collection('settings').listDocuments();
      settingsPlan = [];
      for (const ref of [...settingsRefs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const fateEntry = fateForSettingsDoc(ref.id);
        if (fateEntry === null) {
          warnings.push(`unknown settings doc (not in the manifest): settings/${ref.id}`);
        }
        settingsPlan.push({ docId: ref.id, fate: fateEntry ? fateEntry.fate : 'unknown', row: fateEntry?.row ?? null });
      }
    } else {
      const settingsDocs = await readAllDocuments(db.collection('settings'), { FieldPath });
      settingsPlan = [];
      for (const doc of settingsDocs) {
        const fateEntry = fateForSettingsDoc(doc.id);
        const fate = fateEntry ? fateEntry.fate : 'unknown';
        if (fateEntry === null) {
          warnings.push(`unknown settings doc (not in the manifest): settings/${doc.id}`);
        }
        settingsResults[doc.id] = { doc: bundleDocFromSnapshot(`settings/${doc.id}`, doc), fate };
        settingsPlan.push({ docId: doc.id, fate, row: fateEntry?.row ?? null });
      }
    }
  }

  // ── print the plan ────────────────────────────────────────────────────
  step('plan');
  const fateTotals = {};
  for (const item of plan) {
    fateTotals[item.fate] = (fateTotals[item.fate] ?? 0) + 1;
  }
  for (const item of plan) {
    const countLabel = item.absent ? '0 (absent)' : String(item.docCount);
    info(`${item.name} [${item.fate}]`, countLabel);
  }
  if (settingsPlan) {
    for (const item of settingsPlan) {
      info(`settings/${item.docId} [${item.fate}]`, '1');
    }
  }
  if (warnings.length > 0) {
    step('WARNINGS — collections/subcollections/docs not in the manifest');
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  if (!apply) {
    step('dry run — nothing written');
    info('would write to', outDir);
    return { exportedAt, plan, settingsPlan, warnings, wrote: false, outDir };
  }

  // ── every READ happens before the first WRITE (reviewer, round 2) ──────
  // The first real run wrote 40 collections and then failed on the Auth
  // listing, leaving a partial bundle on disk. Auth is now read before
  // anything is written, and the bundle is built in `<bundle>.partial` and
  // renamed only when complete, so a directory named like a bundle is always
  // a whole, checksummed bundle.
  step('reading Auth users');
  const authUsers = [];
  let pageToken = undefined;
  for (;;) {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      authUsers.push(pickAuthUserFields(user));
    }
    if (!page.pageToken) break;
    pageToken = page.pageToken;
  }
  authUsers.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  info('auth users read', authUsers.length);

  // ── write the bundle ──────────────────────────────────────────────────
  const workDir = `${outDir}.partial`;
  if (existsSync(workDir)) {
    die(`an unfinished bundle is in the way: ${workDir} (left by a failed run — inspect it and remove it)`);
  }
  step(`writing bundle to ${workDir}`);
  ensureDir(workDir);

  const rootCollectionsSummary = [];
  const consistencyWarnings = [];
  const notIncluded = {
    '_maps/user-id-map.json': 'generated by the IMPORTER, not this exporter (per §(a): new ids are generated once per environment and persisted there)',
    '_storage/storage-manifest.jsonl': 'out of scope for this script — a separate storage-copy tool handles Firebase Storage (per the brief)',
  };

  async function writeOneCollection(name, docs, fate) {
    if (fate === 'drop') return; // never written
    const dirForParts = fate === 'verify-only' ? path.join(workDir, '_verify') : path.join(workDir, name);
    ensureDir(dirForParts);

    const sortedDocs = [...docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    if (fate === 'verify-only') {
      // Transient oracle file: <collection>.jsonl directly under _verify/,
      // NOT the part-rotation scheme (it is not part of the archive proper).
      const lines = sortedDocs.map((doc) =>
        canonicalStringify({ path: doc.path, id: doc.id, createTime: doc.createTime, updateTime: doc.updateTime, data: doc.data }),
      );
      const content = lines.length > 0 ? lines.join('\n') + '\n' : '';
      writeFileSecure(path.join(workDir, '_verify', `${name}.jsonl`), Buffer.from(content, 'utf8'));
      rootCollectionsSummary.push({ name, fate, count: docs.length, row: fateForCollection(name)?.row ?? null });
      return;
    }

    const parts = writeParts(dirForParts, sortedDocs, maxPartBytes === undefined ? {} : { maxPartBytes });
    const maxUpdateTime = sortedDocs.reduce((max, d) => (d._updateTimeRaw && (max === null || d._updateTimeRaw > max) ? d._updateTimeRaw : max), null);

    const partDocSum = parts.reduce((sum, p) => sum + p.docs, 0);
    if (partDocSum !== docs.length) {
      consistencyWarnings.push(`${name}: wrote ${partDocSum} docs across parts but had ${docs.length} in memory`);
    }

    writeCollectionManifest(dirForParts, {
      collection: name,
      sourceProject: PROJECT_ID,
      sourceDatabase: DATABASE_NAME,
      exportedAt,
      exporterGitSha: gitSha,
      dirty: gitDirty,
      documentCount: docs.length,
      parts,
      fate,
      schemaVersion: SCHEMA_VERSION,
      retainUntil: retainUntilFor(name, exportedAt),
      maxUpdateTimeSeen: maxUpdateTime,
    });

    rootCollectionsSummary.push({ name, fate, count: docs.length, row: fateForCollection(name)?.row ?? fateForSubcollection(name)?.row ?? null });
  }

  for (const [name, result] of Object.entries(collectionResults)) {
    await writeOneCollection(name, result.docs, result.fate);
  }
  for (const [flattened, result] of Object.entries(subcollectionResults)) {
    await writeOneCollection(flattened, result.docs, result.fate);
  }

  // settings: one collection, per-document fate; export whole collection,
  // recording per-doc fate in the collection manifest.
  if (settingsPlan && settingsPlan.length > 0) {
    const settingsDir = path.join(workDir, 'settings');
    ensureDir(settingsDir);
    const allDocs = Object.values(settingsResults)
      .map((r) => r.doc)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const parts = writeParts(settingsDir, allDocs, maxPartBytes === undefined ? {} : { maxPartBytes });
    writeCollectionManifest(settingsDir, {
      collection: 'settings',
      sourceProject: PROJECT_ID,
      sourceDatabase: DATABASE_NAME,
      exportedAt,
      exporterGitSha: gitSha,
      dirty: gitDirty,
      documentCount: allDocs.length,
      parts,
      fate: 'mixed',
      perDocumentFate: Object.fromEntries(settingsPlan.map((s) => [s.docId, s.fate])),
      schemaVersion: SCHEMA_VERSION,
      retainUntil: null,
    });
    rootCollectionsSummary.push({ name: 'settings', fate: 'mixed', count: allDocs.length, row: null });
  }

  // Auth users (read above, before the first write).
  const authDir = path.join(workDir, '_auth');
  ensureDir(authDir);
  const authLines = authUsers.map((u) => canonicalStringify(u));
  writeFileSecure(path.join(authDir, 'users.jsonl'), Buffer.from(authLines.length > 0 ? authLines.join('\n') + '\n' : '', 'utf8'));
  info('auth users exported', authUsers.length);

  // ── REVIEW ROUND 1 FIX 3: live re-count against the database ───────────
  // Re-count every WRITTEN top-level collection and subcollection family
  // after the bundle is on disk, and compare with the number of lines
  // written. A mismatch means the database changed WHILE the export ran
  // (e.g. a staging write race) — recorded as a loud warning, never a crash
  // (the brief: "It is not a crash").
  step('live re-count against the database');
  const recounts = [];
  for (const [name, result] of Object.entries(collectionResults)) {
    if (result.fate === 'drop') continue;
    const recount = await countDocuments(db.collection(name));
    const written = result.docs.length;
    const match = recount === written;
    recounts.push({ name, written, recount, match });
    if (!match) {
      consistencyWarnings.push(`${name}: wrote ${written} docs but the live re-count now shows ${recount} (the database changed during the export)`);
    }
  }
  // Subcollection families: sum count() over the SAME parent refs used
  // during the walk (re-derived here by re-listing, since the parent refs
  // themselves are cheap to re-fetch and re-counting must reflect the
  // CURRENT state of each specific subcollection, not a stale ref).
  for (const [flattened, result] of Object.entries(subcollectionResults)) {
    if (result.fate === 'drop') continue;
    const written = result.docs.length;
    // Re-derive (parentCollection, subName) from the flattened name (only
    // 1-level manifest-known families are re-counted this way; a 2-level
    // discovered family's re-count is best-effort via the same discovery
    // pass, which is more expensive — for level-1 families, the common
    // case, we recompute directly).
    const parts = flattened.split('__');
    let recount = null;
    if (parts.length === 2) {
      const [parentCollectionName, subName] = parts;
      const parentRefs = await db.collection(parentCollectionName).listDocuments();
      const perParentCounts = await mapWithConcurrency(parentRefs, SUBCOLLECTION_DISCOVERY_CONCURRENCY, async (parentRef) => {
        return countDocuments(parentRef.collection(subName));
      });
      recount = perParentCounts.reduce((sum, c) => sum + c, 0);
    }
    const match = recount === null ? null : recount === written;
    recounts.push({ name: flattened, written, recount, match });
    if (match === false) {
      consistencyWarnings.push(`${flattened}: wrote ${written} docs but the live re-count now shows ${recount} (the database changed during the export)`);
    }
  }

  // Root manifest + SHA256SUMS.
  const rootManifest = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    source: { project: PROJECT_ID, database: DATABASE_NAME },
    exporterGitSha: gitSha,
    dirty: gitDirty,
    collections: rootCollectionsSummary,
    totalsByFate: fateTotals,
    warnings,
    consistencyWarnings,
    recounts,
    authUserCount: authUsers.length,
    notIncluded,
  };
  writeFileSecure(path.join(workDir, 'manifest.json'), Buffer.from(JSON.stringify(rootManifest, null, 2) + '\n', 'utf8'));

  const allFiles = listFilesRecursive(workDir);
  writeShaSums(workDir, allFiles);
  renameSync(workDir, outDir);

  step('done');
  info('bundle', outDir);
  info('collections written', rootCollectionsSummary.length);
  info('auth users', authUsers.length);
  if (consistencyWarnings.length > 0) {
    step('CONSISTENCY WARNINGS');
    for (const w of consistencyWarnings) console.log(`  ! ${w}`);
  }

  return { exportedAt, plan, settingsPlan, warnings, consistencyWarnings, recounts, wrote: true, outDir };
}

/**
 * Reads the Auth user list through the Identity Toolkit REST API
 * (`accounts:batchGet`, a GET) instead of firebase-admin's Auth client.
 * Reason (first real run, 2026-09-27): with personal Application Default
 * Credentials that API requires a quota project, and firebase-admin 11 has no
 * way to send one — every call answered 403. google-auth-library sends the
 * `x-goog-user-project` header; it is set explicitly to the pinned project.
 *
 * The returned object has the one method runExport() uses, `listUsers`, and
 * gives each user the firebase-admin field names. Only the fields the
 * allowlist keeps are copied out of the response: the password hash and salt
 * that the API returns are never assigned to anything.
 */
function createAuthReader(googleAuth) {
  const toIso = (millis) => (millis === undefined || millis === null ? null : new Date(Number(millis)).toISOString());
  return {
    async listUsers(maxResults, pageToken) {
      const client = await googleAuth.getClient();
      // The query is built in one expression, without mutating calls: the
      // write-call scan (test/no-write-calls.test.mjs) stays strict.
      const query = new URLSearchParams({
        maxResults: String(maxResults),
        ...(pageToken ? { nextPageToken: pageToken } : {}),
      });
      const response = await client.request({
        headers: { 'x-goog-user-project': PROJECT_ID },
        method: 'GET',
        url: `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:batchGet?${query}`,
      });
      const users = (response.data.users ?? []).map((raw) => ({
        uid: raw.localId,
        email: raw.email,
        emailVerified: raw.emailVerified,
        disabled: raw.disabled,
        displayName: raw.displayName,
        metadata: { creationTime: toIso(raw.createdAt), lastSignInTime: toIso(raw.lastLoginAt) },
        providerData: (raw.providerUserInfo ?? []).map((provider) => ({ providerId: provider.providerId })),
      }));
      // An empty page ends the listing even if the API still hands out a token.
      return { pageToken: users.length === 0 ? undefined : response.data.nextPageToken, users };
    },
  };
}

function defaultOutDir() {
  return path.join(homedir(), 'chopshop-export');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseOut = path.resolve(args.out ?? defaultOutDir());
  // REVIEW ROUND 1 FIX 7: refuse BEFORE any Firebase work, including before
  // the lazy firebase-admin import below.
  assertOutsideRepo(baseOut);

  const exportedAt = new Date().toISOString();
  const bundleDirName = `export-${exportedAt.replaceAll(':', '-')}`;
  const outDir = path.join(baseOut, bundleDirName);

  // REVIEW ROUND 1 FIX 7: an existing bundle directory is refused before any
  // database work (runExport() also checks this at its own entry for callers
  // that invoke it directly, but main()'s outDir is timestamp-generated so
  // this specific collision is astronomically unlikely — checked anyway for
  // defence in depth and because runExport() itself enforces it).
  if (args.apply && existsSync(outDir)) {
    die(`bundle directory already exists: ${outDir}`);
  }

  if (args.apply) {
    mkdirSync(baseOut, { recursive: true, mode: 0o700 });
  }

  // Lazy-load firebase-admin exactly like scripts/backfill-pod-mapping-garment.mjs:57-64,
  // resolved from functions/node_modules (never the repo root).
  const { createRequire } = await import('node:module');
  const functionsRequire = createRequire(path.join(REPO_ROOT, 'functions', 'package.json'));
  const admin = functionsRequire('firebase-admin');
  const { getFirestore, FieldPath } = functionsRequire('firebase-admin/firestore');
  const { GoogleAuth } = functionsRequire('google-auth-library');

  // REVIEW ROUND 1 FIX 5: name the project EXPLICITLY. admin.initializeApp()
  // with no options lets ADC decide the project, which can silently resolve
  // to the wrong one (or fail to resolve one at all for the Auth client)
  // under user credentials. Also refuse if GOOGLE_CLOUD_PROJECT is set to
  // something else — a stale/wrong env var must never silently override the
  // pinned project id.
  const envProject = process.env.GOOGLE_CLOUD_PROJECT;
  if (envProject !== undefined && envProject !== PROJECT_ID) {
    die(`GOOGLE_CLOUD_PROJECT is set to "${envProject}", which does not match the pinned project "${PROJECT_ID}". Unset it or fix it before running this tool.`);
  }
  console.log(`\n▸ project ${PROJECT_ID}, database ${DATABASE_NAME}`);
  admin.initializeApp({ projectId: PROJECT_ID }); // ADC, project pinned explicitly
  const db = getFirestore(DATABASE_NAME);
  const auth = createAuthReader(new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }));

  await runExport({
    db,
    auth,
    FieldPath,
    outDir,
    apply: args.apply,
    only: args.only,
    now: () => new Date(exportedAt),
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  createAuthReader,
  runExport,
  parseArgs,
  assertOutsideRepo,
  pickAuthUserFields,
  retainUntilFor,
  gitInfo,
  REPO_ROOT,
  PROJECT_ID,
  DATABASE_NAME,
  mapWithConcurrency,
  MAX_SUBCOLLECTION_DEPTH,
};
