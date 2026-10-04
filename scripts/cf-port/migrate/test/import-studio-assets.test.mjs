import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { hostingFileOf, parseArgs, planStudioImport, runStudioImport, sameDocument, workerShape } from '../import-studio-assets.mjs';
import { RefusedError, REPO_ROOT } from '../lib/api-session.mjs';
import { sourceKeyOf } from '../lib/copy-manifest.mjs';
import { loadWorkerModule } from '../lib/copy-sources.mjs';
import { readStudioCopyManifest, STUDIO_COPY_MANIFEST_FILE } from '../lib/studio-copy-manifest.mjs';
import { garmentOf, transformModels, transformTemplates, withFileIds } from '../lib/transform-studio-assets.mjs';
import { startFakeSource, writeTestBundle } from './fake-staging-api.mjs';

/**
 * CP5-WH: import-studio-assets.mjs against a fake of the Worker's studio
 * routes (cloudflare/src/routes/pod-studio-assets.ts): the same guards
 * (platform session, no X-Shop-Id, same-origin on a write), the upload's
 * type from the bytes and one file per sha256, and a PUT that answers
 * `changed: false` for the document it already holds.
 */

const NAMES = [{ name: 'family-one', re: /forbiddenname/i }];

// ── a fake of the studio routes ─────────────────────────────────────────────

const STUDIO_TYPES = ['image/avif', 'image/jpeg', 'image/png', 'image/webp'];

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const nonEmpty = (value) => value !== null && typeof value === 'object' && Object.keys(value).length > 0;

/**
 * What the REAL Worker stores and answers for a PUT body
 * (cloudflare/src/pod/studio-assets.ts parse* → rows → templateFromRows /
 * modelFromRows), restated field by field here and NOT taken from the
 * importer: its defaults filled in at every level, its empty optional maps
 * dropped. The fake answers this, not the body it was sent.
 */
function workerAnswer(kind, input) {
  if (kind === 'template') {
    const map = input.photo?.displacement ?? null;
    const out = {
      active: input.active ?? true,
      colorways: input.colorways.map((c) => ({
        backFileId: c.backFileId ?? null,
        frontFileId: c.frontFileId ?? null,
        hex: c.hex,
        id: c.id,
        label: c.label,
        ...(nonEmpty(c.tuning) ? { tuning: c.tuning } : {}),
      })),
      garment: input.garment,
      label: input.label,
      photo: input.photo
        ? {
            displacement: map ? { ...map, backFileId: map.backFileId ?? null, frontFileId: map.frontFileId ?? null } : null,
            h: input.photo.h,
            w: input.photo.w,
          }
        : null,
      printAreaMm: input.printAreaMm,
      printAreas: input.printAreas,
      profileId: input.profileId,
      provisional: input.provisional ?? false,
      sortOrder: input.sortOrder ?? 0,
    };
    for (const key of ['pocketPositions', 'printOffsetTopMm', 'slotLabels']) {
      if (nonEmpty(input[key])) out[key] = input[key];
    }
    return out;
  }
  const out = {
    active: input.active ?? true,
    label: input.label,
    output: input.output ?? null,
    perColorway: Object.fromEntries(Object.entries(input.perColorway ?? {}).filter(([, t]) => nonEmpty(t))),
    views: Object.fromEntries(
      Object.entries(input.views).map(([viewId, view]) => [
        viewId,
        {
          colorways: (view.colorways ?? []).map((c) => ({
            displacementFileId: c.displacementFileId,
            id: c.id,
            label: c.label,
            maskFileId: c.maskFileId ?? null,
            photoFileId: c.photoFileId,
            ...(typeof c.mapContrastSd === 'number' ? { mapContrastSd: c.mapContrastSd } : {}),
          })),
          h: view.h ?? null,
          originalDims: view.originalDims ?? null,
          printArea: view.printArea,
          printAreaMm: view.printAreaMm ?? null,
          w: view.w ?? null,
        },
      ]),
    ),
  };
  for (const key of ['alpha', 'blend', 'displacementBlur', 'displacementContrast', 'displacementScale']) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

async function startFakeStudioApi({ refuseTemplate = null } = {}) {
  const sniff = await loadWorkerModule('storage/image-sniff.ts');
  const state = {
    files: new Map(), // sha256 → file
    log: [], // { method, path }
    models: new Map(),
    sessions: new Set(),
    templates: new Map(),
    writes: 0,
  };
  const user = { email: 'platform@example.com', password: 'platform-password-1' };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://fake');
    const method = req.method;
    state.log.push({ method, path: url.pathname });
    const send = (status, json, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(json === undefined ? '' : JSON.stringify(json));
    };
    const notFound = () => send(404, { error: { code: 'not_found', message: 'Route not found' } });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const sameOrigin = req.headers.origin === origin;
    const cookie = req.headers.cookie ?? '';
    const signedIn = [...state.sessions].some((token) => cookie.includes(token));
    const platformOk = (write) => signedIn && req.headers['x-shop-id'] === undefined && (!write || sameOrigin);

    if (url.pathname === '/health') return send(200, { environment: 'staging' });
    if (url.pathname === '/ready') return send(200, { migration: '0049_pod_studio_assets.sql' });
    if (url.pathname === '/api/auth/sign-in/email' && method === 'POST') {
      const input = JSON.parse(body.toString('utf8'));
      if (input.email !== user.email || input.password !== user.password) return send(401, {});
      const token = `session=${randomUUID()}`;
      state.sessions.add(token);
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `${token}; Path=/` });
      return res.end(JSON.stringify({ user: { id: 'platform-user' } }));
    }
    if (url.pathname === '/v1/platform/pod/studio-files') {
      if (method !== 'POST' || !platformOk(true)) return notFound();
      const proven = sniff.sniffImageType(new Uint8Array(body));
      if (!STUDIO_TYPES.includes(proven)) return send(400, { error: { code: 'invalid_request', reason: 'not_an_allowed_image' } });
      if (req.headers['content-type'] !== proven) return send(400, { error: { code: 'invalid_request', reason: 'type_not_as_stated' } });
      const sha256 = createHash('sha256').update(body).digest('hex');
      const known = state.files.get(sha256);
      if (known) return send(200, { file: known });
      const file = { contentType: proven, fileId: randomUUID(), height: null, sha256, sizeBytes: body.length, url: 'https://pub.example/x', width: null };
      state.files.set(sha256, file);
      return send(201, { file });
    }
    const times = { createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z' };
    for (const [prefix, store, idKey, answerKey] of [
      ['/v1/platform/pod/mockup-templates', state.templates, 'templateId', 'template'],
      ['/v1/platform/pod/3d-models', state.models, 'modelId', 'model'],
    ]) {
      if (url.pathname === prefix) {
        if (method !== 'GET' || !platformOk(false)) return notFound();
        return send(200, {
          files: {},
          [`${answerKey}s`]: [...store.entries()].map(([id, doc]) => ({ ...doc, ...times, [idKey]: id })),
        });
      }
      if (url.pathname.startsWith(`${prefix}/`)) {
        if (method !== 'PUT' || !platformOk(true)) return notFound();
        const id = decodeURIComponent(url.pathname.slice(prefix.length + 1));
        if (refuseTemplate === id) return send(400, { error: { code: 'invalid_request', reason: 'aspect_mismatch' } });
        const input = workerAnswer(answerKey, JSON.parse(body.toString('utf8')));
        const ids = JSON.stringify(input).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
        const stored = new Set([...state.files.values()].map((f) => f.fileId));
        if (ids.some((fileId) => !stored.has(fileId))) return send(400, { error: { code: 'invalid_request', reason: 'file_not_found' } });
        const existing = store.get(id);
        if (existing && stableJson(existing) === stableJson(input)) return send(200, { changed: false, [answerKey]: { ...input, ...times, [idKey]: id } });
        store.set(id, input);
        state.writes += 1;
        return send(existing ? 200 : 201, { changed: true, [answerKey]: { ...input, ...times, [idKey]: id } });
      }
    }
    return notFound();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
    origin: `http://127.0.0.1:${server.address().port}`,
    state,
    user,
  };
}

// ── images ──────────────────────────────────────────────────────────────────

function png(seed) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`png-${seed}-`.repeat(10))]);
}
function webp(seed) {
  const data = Buffer.from(`webp-${seed}-`.repeat(10));
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), data]);
}

// ── the export ──────────────────────────────────────────────────────────────

function settingsDoc(at) {
  return {
    data: {
      provisional: true,
      templates: [
        {
          colorways: [
            { hex: '#f3f3f3', id: 'white', label: 'Vit' },
            { hex: '#363435', id: 'black', label: 'Svart' },
          ],
          garment: 'tee',
          id: 'tee_bc_e150',
          label: 'T-shirt',
          photo: {
            backUrls: { white: '/pod-garments/tee/white_back.webp' },
            displacement: {
              alpha: 0.8,
              blend: 'multiply',
              blur: 6,
              contrast: 2,
              h: 2186,
              perColorway: { black: { blend: 'normal' }, ghost: { blend: 'normal' } },
              scale: 30,
              urls: { back: '/pod-garments/tee/white_back_dm.webp', front: '/pod-garments/tee/white_front_dm.webp' },
              w: 1920,
            },
            h: 1093,
            urls: { black: '/pod-garments/tee/black_front.webp', white: '/pod-garments/tee/white_front.webp' },
            w: 960,
          },
          pocketPositions: { center: { x: 434 } },
          printAreaMm: { front: { h: 350, w: 300 }, pocket: { h: 100, w: 100 } },
          printAreas: { front: { h: 322, w: 276, x: 342, y: 411 }, pocket: { h: 92, w: 92, x: 535, y: 365 } },
          printOffsetTopMm: { front: 65 },
          profileId: 'apparel_dtg',
        },
        {
          blankCostSek: 60,
          colorways: [{ hex: '#ffffff', id: 'white', label: 'Vit' }],
          id: 'bag_flat',
          label: 'Tygkasse',
          printAreaMm: { front: { h: 250, w: 250 } },
          printAreas: { front: { h: 300, w: 300, x: 250, y: 330 } },
          profileId: 'bag_dtg',
          slotLabels: { front: 'Framsida' },
        },
        { colorways: [], id: 'forbiddenname_tee', label: 'x', printAreaMm: {}, printAreas: {}, profileId: 'p' },
        { colorways: [], id: 'mystery', label: 'Okänd', printAreaMm: {}, printAreas: {}, profileId: 'p' },
      ],
      version: 3,
    },
    id: 'podMockupTemplates',
  };
}

function modelDocs(at) {
  return [
    {
      data: {
        active: true,
        alpha: 0.8,
        blend: 'multiply',
        displacementBlur: 6,
        displacementScale: 30,
        label: 'T-shirt på modell',
        output: { h: 1936, w: 1600 },
        perColorway: { white: { alpha: 0.9 } },
        printAreaMm: { front: { h: 400, w: 300 } },
        scope: 'platform',
        views: {
          front: {
            colorways: {
              half: { label: 'Halv', photoUrl: at('half-photo') },
              white: {
                displacementUrl: at('white-map'),
                label: 'Vit',
                mapContrastSd: 41.5,
                originalPaths: { photo: 'pod-3d-models/x/front/white/originals/photo.png' },
                photoUrl: at('white-photo'),
              },
            },
            h: 1936,
            originalDims: { h: 3871, w: 3200 },
            printArea: { h: 700, w: 525, x: 548, y: 875 },
            w: 1600,
          },
        },
      },
      id: 'Mdl0123456789abcdefg',
    },
    { data: { active: false, label: 'Avstängd', views: { front: { colorways: {}, h: null, printArea: { h: 0, w: 0, x: 0, y: 0 }, w: null } } }, id: 'OffModel000000000000' },
  ];
}

/**
 * A source that answers 200 with the full Content-Length, sends half the
 * body and drops the connection — the first `breaks[path]` times a path is
 * asked for; after that it answers whole.
 */
async function startBreakingSource(files, breaks) {
  const hits = new Map();
  const server = createServer((req, res) => {
    const key = new URL(req.url, 'http://fake').pathname;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const file = files[key];
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    if ((breaks[key] ?? 0) >= hits.get(key)) {
      res.writeHead(200, { 'content-length': String(file.body.length), 'content-type': file.type });
      res.write(file.body.subarray(0, Math.floor(file.body.length / 2)));
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.writeHead(200, { 'content-type': file.type });
    res.end(file.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
    hits,
    origin: `http://127.0.0.1:${server.address().port}`,
  };
}

async function world({ breaks = null, refuseTemplate = null, withHosting = true, sourceFiles = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-import-'));
  const api = await startFakeStudioApi({ refuseTemplate });
  const sourcePath = (name) => `/v0/b/test-bucket.firebasestorage.app/o/${name}`;
  const files = sourceFiles ?? {
    [sourcePath('white-map')]: { body: png('map'), type: 'image/png' },
    [sourcePath('white-photo')]: { body: png('photo'), type: 'image/png' },
  };
  const source = breaks === null ? await startFakeSource(files) : await startBreakingSource(files, breaks);
  const at = (name) => `${source.origin}${sourcePath(name)}?alt=media&token=t`;
  const hosting = path.join(dir, 'public');
  if (withHosting) {
    mkdirSync(path.join(hosting, 'pod-garments', 'tee'), { recursive: true });
    for (const name of ['white_front', 'white_back', 'black_front', 'white_front_dm', 'white_back_dm']) {
      writeFileSync(path.join(hosting, 'pod-garments', 'tee', `${name}.webp`), webp(name));
    }
  }
  const bundle = path.join(dir, 'bundle');
  writeTestBundle(bundle, { pod3dModels: modelDocs(at), settings: [settingsDoc(at)] });
  const lines = [];
  const deps = {
    apiOrigin: api.origin,
    credentials: { email: api.user.email, password: api.user.password },
    log: (line) => lines.push(line),
    names: NAMES,
    sleep: async () => {},
  };
  const args = { bundle, dryRun: false, env: 'staging', hostingDir: hosting, only: null, out: path.join(dir, 'out') };
  return {
    api,
    args,
    close: async () => {
      await api.close();
      await source.close();
      rmSync(dir, { force: true, recursive: true });
    },
    deps,
    lines,
    source,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

test('parseArgs: required options, --only values, unknown arguments', () => {
  assert.throws(() => parseArgs(['--bundle', 'b', '--out', 'o']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--out', 'o']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--bundle', 'b']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--bundle', 'b', '--out', 'o', '--only', 'all']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--bundle', 'b', '--out', 'o', '--force']), RefusedError);
  assert.deepEqual(parseArgs(['--env', 'staging', '--bundle', 'b', '--out', 'o', '--hosting-dir', 'h', '--only', 'models', '--dry-run']), {
    bundle: 'b',
    dryRun: true,
    env: 'staging',
    hostingDir: 'h',
    only: 'models',
    out: 'o',
  });
});

test('the transform: the Worker body shape, placeholders, what is left out and why', () => {
  const at = (name) => `https://firebasestorage.googleapis.com/v0/b/x/o/${name}`;
  const templates = transformTemplates(settingsDoc(at), NAMES);
  assert.deepEqual(templates.templates.map((t) => t.id), ['tee_bc_e150', 'bag_flat']);
  assert.deepEqual(templates.leftOut, [
    { id: '#2', kind: 'template', reason: 'guard_family_1' },
    { id: 'mystery', kind: 'template', reason: 'no_garment' },
  ]);
  assert.deepEqual(templates.droppedKeys, { blankCostSek: 1 });
  const tee = templates.templates[0].body;
  assert.deepEqual(tee.colorways, [
    { backFileId: { $source: '/pod-garments/tee/white_back.webp' }, frontFileId: { $source: '/pod-garments/tee/white_front.webp' }, hex: '#f3f3f3', id: 'white', label: 'Vit' },
    { backFileId: null, frontFileId: { $source: '/pod-garments/tee/black_front.webp' }, hex: '#363435', id: 'black', label: 'Svart', tuning: { blend: 'normal' } },
  ]);
  assert.deepEqual(tee.photo.displacement, {
    alpha: 0.8,
    backFileId: { $source: '/pod-garments/tee/white_back_dm.webp' },
    blend: 'multiply',
    blur: 6,
    contrast: 2,
    frontFileId: { $source: '/pod-garments/tee/white_front_dm.webp' },
    h: 2186,
    scale: 30,
    w: 1920,
  });
  assert.equal(tee.provisional, true);
  assert.equal(tee.active, true);
  const bag = templates.templates[1].body;
  assert.equal(bag.garment, 'bag', 'the garment comes from the id prefix when the document has none');
  assert.equal(bag.photo, undefined);
  assert.equal('blankCostSek' in bag, false);
  assert.equal(bag.sortOrder, 10);

  const models = transformModels(modelDocs(at), NAMES);
  assert.equal(models.counts.colorwaysIncomplete, 1);
  assert.equal(models.counts.originalPathsNotCopied, 1);
  const model = models.models[0].body;
  assert.deepEqual(model.views.front.colorways, [
    {
      displacementFileId: { $source: at('white-map') },
      id: 'white',
      label: 'Vit',
      mapContrastSd: 41.5,
      maskFileId: null,
      photoFileId: { $source: at('white-photo') },
    },
  ]);
  assert.deepEqual(model.views.front.printAreaMm, { h: 400, w: 300 });
  assert.equal('scope' in model, false);
  assert.equal(models.models[1].body.active, false);

  assert.equal(withFileIds(tee, () => null), null, 'an item with an uncopied file is not written');
  assert.equal(garmentOf({ id: 'longsleeve_hanging' }), 'longsleeve');
});

test('a hosting path never leaves --hosting-dir', () => {
  assert.equal(hostingFileOf('/srv/public', '/pod-garments/a.webp'), path.resolve('/srv/public/pod-garments/a.webp'));
  assert.equal(hostingFileOf('/srv/public', '/../secret'), null);
  assert.equal(hostingFileOf('/srv/public', '/%2e%2e/secret'), null);
});

test('refuses an output directory inside the repository, and production', async () => {
  const w = await world();
  try {
    await assert.rejects(runStudioImport({ ...w.args, out: path.join(REPO_ROOT, 'tmp-studio-out') }, w.deps), RefusedError);
    assert.equal(w.api.state.log.length, 0);
  } finally {
    await w.close();
  }
});

test('--dry-run makes no request and writes nothing', async () => {
  const w = await world();
  try {
    const result = await runStudioImport({ ...w.args, dryRun: true }, w.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(w.api.state.log.length, 0);
    assert.equal(w.source.hits.size, 0);
    assert.equal(existsSync(w.args.out), false);
    assert.ok(w.lines.includes('templates: 2 to write (tee_bc_e150, bag_flat)'));
    assert.ok(w.lines.some((line) => line.startsWith('files: 7 distinct (5 from the hosting directory, 2 ')));
    assert.ok(w.lines.includes('hosting paths that --hosting-dir does not hold: 0'));
  } finally {
    await w.close();
  }
});

test('copies every file through the platform route, writes every item, verifies, and is idempotent', async () => {
  const w = await world();
  try {
    const first = await runStudioImport(w.args, w.deps);
    assert.equal(first.exitCode, 0, w.lines.join('\n'));
    assert.deepEqual(first.result.rows, { created: 4, failed: 0, notWritten: 0, refused: 0, unchanged: 0, updated: 0 });
    assert.equal(first.result.mismatches, 0);
    assert.equal(w.api.state.files.size, 7);
    const manifest = readStudioCopyManifest(path.join(w.args.out, STUDIO_COPY_MANIFEST_FILE));
    assert.equal(manifest.entries.length, 7);
    assert.ok(manifest.entries.every((entry) => entry.status === 'copied'));
    assert.ok(!JSON.stringify(manifest).includes('pod-garments'), 'the manifest holds no address');
    const stored = w.api.state.templates.get('tee_bc_e150');
    const whiteFront = manifest.entries.find((e) => e.sourceKey === sourceKeyOf('/pod-garments/tee/white_front.webp'));
    assert.equal(stored.colorways[0].frontFileId, whiteFront.fileId);
    assert.equal(w.api.state.models.get('OffModel000000000000').active, false);

    // Every request carried the platform session and no shop.
    const uploads = w.api.state.log.filter((entry) => entry.path === '/v1/platform/pod/studio-files').length;
    assert.equal(uploads, 7);

    // The second run: nothing uploaded, nothing written.
    const writes = w.api.state.writes;
    const logBefore = w.api.state.log.length;
    const lines = w.lines.length;
    const second = await runStudioImport(w.args, w.deps);
    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.result.rows, { created: 0, failed: 0, notWritten: 0, refused: 0, unchanged: 4, updated: 0 });
    assert.equal(w.api.state.writes, writes);
    assert.equal(w.api.state.log.slice(logBefore).filter((entry) => entry.path === '/v1/platform/pod/studio-files').length, 0);
    assert.ok(w.lines.slice(lines).includes('files already copied (skipped): 7; to try now: 0'));
  } finally {
    await w.close();
  }
});

test('a lost manifest: the Worker stores identical bytes once, so a re-run still writes nothing new', async () => {
  const w = await world();
  try {
    assert.equal((await runStudioImport(w.args, w.deps)).exitCode, 0);
    rmSync(path.join(w.args.out, STUDIO_COPY_MANIFEST_FILE));
    const files = w.api.state.files.size;
    const writes = w.api.state.writes;
    const again = await runStudioImport(w.args, w.deps);
    assert.equal(again.exitCode, 0);
    assert.equal(w.api.state.files.size, files);
    assert.equal(w.api.state.writes, writes);
    assert.ok(w.lines.some((line) => line.includes('uploaded now 0, already stored 7')));
  } finally {
    await w.close();
  }
});

test('a missing source file: the item that needs it is not written, the others are, exit 1', async () => {
  const w = await world({ sourceFiles: { '/v0/b/test-bucket.firebasestorage.app/o/white-map': { body: png('map'), type: 'image/png' } } });
  try {
    const result = await runStudioImport(w.args, w.deps);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.result.files, { copied: 6, failed: 0, missing: 1, refused: 0 });
    assert.equal(result.result.rows.notWritten, 1);
    assert.equal(w.api.state.models.has('Mdl0123456789abcdefg'), false);
    assert.equal(w.api.state.templates.size, 2);
    assert.ok(w.lines.includes('  model Mdl0123456789abcdefg: not written (a file is not copied)'));
  } finally {
    await w.close();
  }
});

test('a file that is not a studio image is refused locally by its bytes; a refused document is reported', async () => {
  const w = await world({
    refuseTemplate: 'bag_flat',
    sourceFiles: {
      '/v0/b/test-bucket.firebasestorage.app/o/white-map': { body: '<svg xmlns="http://www.w3.org/2000/svg"/>', type: 'image/svg+xml' },
      '/v0/b/test-bucket.firebasestorage.app/o/white-photo': { body: png('photo'), type: 'image/png' },
    },
  });
  try {
    const result = await runStudioImport(w.args, w.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.result.files.refused, 1);
    assert.equal(
      w.api.state.log.filter((entry) => entry.path === '/v1/platform/pod/studio-files').length,
      6,
      'the SVG never reached the Worker',
    );
    assert.equal(result.result.rows.refused, 1);
    assert.ok(w.lines.includes('  template bag_flat: refused (aspect_mismatch)'));
    const manifest = readStudioCopyManifest(path.join(w.args.out, STUDIO_COPY_MANIFEST_FILE));
    const refused = manifest.entries.find((entry) => entry.status === 'refused');
    assert.equal(refused.reason, 'not_an_allowed_image');
    assert.equal(refused.fileId, null);
  } finally {
    await w.close();
  }
});

test('without --hosting-dir the hosting files are refused, not guessed', async () => {
  const w = await world();
  try {
    const result = await runStudioImport({ ...w.args, hostingDir: null }, w.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.result.files.refused, 5);
    assert.equal(w.api.state.templates.has('tee_bc_e150'), false);
    assert.equal(w.api.state.templates.has('bag_flat'), true, 'a flat template needs no file');
  } finally {
    await w.close();
  }
});

test('--only models plans no template', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-plan-'));
  try {
    writeTestBundle(dir, { pod3dModels: modelDocs((n) => `https://firebasestorage.googleapis.com/${n}`), settings: [settingsDoc(() => '')] });
    const plan = planStudioImport(dir, { names: NAMES, only: 'models' });
    assert.equal(plan.templatePlan.templates.length, 0);
    assert.equal(plan.modelPlan.models.length, 2);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ── Codex round 1 ───────────────────────────────────────────────────────────

test('verify compares with the Worker\'s defaults filled in, nested levels too', () => {
  const flat = {
    colorways: [{ hex: '#ffffff', id: 'white', label: 'Vit' }],
    garment: 'bag',
    label: 'Tygkasse',
    printAreaMm: { front: { h: 250, w: 250 } },
    printAreas: { front: { h: 300, w: 300, x: 250, y: 330 } },
    profileId: 'bag_dtg',
  };
  const stored = { ...workerAnswer('template', flat), createdAt: 'x', templateId: 'bag_flat', updatedAt: 'y' };
  assert.equal(stored.colorways[0].frontFileId, null, 'the Worker answers the null file ids');
  assert.equal(sameDocument('template', flat, stored), true);
  assert.deepEqual(workerShape('template', flat).colorways[0], { backFileId: null, frontFileId: null, hex: '#ffffff', id: 'white', label: 'Vit' });
  // A real difference still shows, nested too.
  const other = structuredClone(stored);
  other.colorways[0].frontFileId = randomUUID();
  assert.equal(sameDocument('template', flat, other), false);

  const model = { label: 'M', views: { front: { colorways: [{ displacementFileId: 'd', id: 'white', label: 'Vit', photoFileId: 'p' }], printArea: { h: 0, w: 0, x: 0, y: 0 } } } };
  assert.equal(sameDocument('model', model, { ...workerAnswer('model', model), modelId: 'M1' }), true);
});

test('a source body that breaks midway is a transient failure: retried, and the run goes on', async () => {
  const photo = '/v0/b/test-bucket.firebasestorage.app/o/white-photo';
  const w = await world({ breaks: { [photo]: 1 } });
  try {
    const result = await runStudioImport(w.args, w.deps);
    assert.equal(result.exitCode, 0, w.lines.join('\n'));
    assert.equal(w.source.hits.get(photo), 2, 'the second try read it whole');
    assert.equal(result.result.files.copied, 7);
  } finally {
    await w.close();
  }
});

test('a source body that always breaks midway is recorded as failed; the other files and items are still done', async () => {
  const photo = '/v0/b/test-bucket.firebasestorage.app/o/white-photo';
  const w = await world({ breaks: { [photo]: 99 } });
  try {
    const result = await runStudioImport(w.args, w.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(w.source.hits.get(photo), 3, 'three tries');
    assert.deepEqual(result.result.files, { copied: 6, failed: 1, missing: 0, refused: 0 });
    const manifest = readStudioCopyManifest(path.join(w.args.out, STUDIO_COPY_MANIFEST_FILE));
    const failed = manifest.entries.find((entry) => entry.status === 'failed');
    assert.equal(failed.reason, 'network_error');
    assert.equal(w.api.state.templates.size, 2);
    assert.equal(w.api.state.models.has('Mdl0123456789abcdefg'), false);
  } finally {
    await w.close();
  }
});
