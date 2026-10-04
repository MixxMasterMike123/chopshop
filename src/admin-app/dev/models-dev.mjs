// The dev API's rows for the platform console's 3D models (unit CP5-FO), wired
// into dev-api.mjs. INVENTED data only (models-fixtures.json), in the Worker's
// shapes and with its refusals (cloudflare/src/routes/pod-studio-assets.ts,
// cloudflare/src/pod/studio-assets.ts, studio-files.ts; CP5_WH_REPORT.md):
//   GET   /v1/platform/pod/3d-models             → { models, files }
//   PUT   /v1/platform/pod/3d-models/:modelId    → 201 | 200 { changed, model }
//   PATCH /v1/platform/pod/3d-models/:modelId    { active } → 200 { changed, model }
//   POST  /v1/platform/pod/studio-files          raw bytes → 201 | 200 { file }
// The platform guard (a platform session, no X-Shop-Id) is dev-api.mjs's.
// A file's address here is a data: address of its own bytes (the Worker's is
// the public bucket's; this server reaches no other host). Changes are held in
// memory per server (state.fo), over the fixtures.
//
// Scenarios, by the cookie `admin_dev_fo` (in the browser console:
// document.cookie = 'admin_dev_fo=lost; path=/'; remove it with Max-Age=0):
//   empty            no models
//   error            the list answers 500
//   dark             the upload answers the opaque 404 (no public bucket)
//   reject-file      the upload answers 400 not_an_allowed_image
//   limit            a PUT that would create a model answers 409 limit_reached
//   refuse:<reason>  every PUT answers 400 invalid_request with that reason
//   lost             every write is done, but answered 502 (its answer is lost)
//   drop             every write answers 502 and is NOT done
//   unclear          as drop, and the list answers 500 too (the read-back fails)

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'models-fixtures.json');
export const MODELS_COOKIE = 'admin_dev_fo';

const MAX_MODELS = 100;
const MAX_COLORWAYS = 40;
const MAX_PER_COLORWAY = 100;
const FILE_MAX_BYTES = 15 * 1024 * 1024;
const PX_MAX = 20_000;
const MM_MAX = 2_000;
const ORIGINAL_PX_MAX = 100_000;
const BLENDS = ['add', 'multiply', 'normal', 'overlay', 'screen'];
const VIEWS = ['front', 'back'];
const MODEL_KEYS = ['active', 'alpha', 'blend', 'displacementBlur', 'displacementContrast', 'displacementScale', 'label', 'output', 'perColorway', 'views'];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COLORWAY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = (reason) => json(400, { error: reason ? { code: 'invalid_request', message: 'Request is not valid', reason } : { code: 'invalid_request', message: 'Request is not valid' } });
const lostAnswer = () => json(502, { error: { code: 'bad_gateway', message: 'The answer was lost on the way (dev scenario)' } });

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isLabel = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 80 && v === v.trim();
const stable = (v) => JSON.stringify(v ?? null, (_k, x) => (isObject(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

function cookieOf(headers, name) {
  for (const part of String(headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
const scenario = (headers) => cookieOf(headers, MODELS_COOKIE) || '';

// ── tiny PNGs (no dependency) ───────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** An RGB PNG of w × h whose pixel (x, y) is pixel(x, y) → [r, g, b]. */
export function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** A tee's outline in a w × h frame: body and two sleeves. */
function inGarment(x, y, w, h) {
  const body = x > w * 0.27 && x < w * 0.73 && y > h * 0.16 && y < h * 0.92;
  const sleeve = y > h * 0.16 && y < h * 0.36 && x > w * 0.12 && x < w * 0.88 && Math.abs(x - w / 2) > (y - h * 0.16) * 0.5;
  const neck = Math.hypot(x - w / 2, y - h * 0.16) < w * 0.07;
  return (body || sleeve) && !neck;
}
const DRAW = {
  photo: (w, h, fill) => {
    const garment = rgb(fill);
    return png(w, h, (x, y) => (inGarment(x, y, w, h) ? garment.map((c) => Math.max(0, c - Math.round(6 * Math.sin(x / 9)))) : [214, 216, 220]));
  },
  map: (w, h) => png(w, h, (x, y) => {
    const v = 128 + Math.round(52 * Math.sin(x / 11 + y / 37) * (inGarment(x, y, w, h) ? 1 : 0.15));
    return [v, v, v];
  }),
  mask: (w, h) => png(w, h, (x, y) => (inGarment(x, y, w, h) ? [255, 255, 255] : [0, 0, 0])),
};

// ── the bytes: type and size (image-sniff.ts, in short) ────────────────────

export function sniff(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(b.toString('ascii', 8, 12))) return 'image/avif';
  return null;
}

export function dimensions(type, b) {
  if (type === 'image/png' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (type === 'image/webp' && b.length >= 16) {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
  }
  if (type === 'image/jpeg') {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// ── the state ───────────────────────────────────────────────────────────────

function fileOf(fileId, bytes, contentType) {
  const size = dimensions(contentType, bytes);
  return {
    contentType,
    fileId,
    height: size?.height ?? null,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    url: `data:${contentType};base64,${bytes.toString('base64')}`,
    width: size?.width ?? null,
  };
}

function held(state) {
  if (!state.fo) {
    const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
    const files = new Map();
    for (const f of fixtures.files) {
      files.set(f.fileId, fileOf(f.fileId, DRAW[f.draw](f.width, f.height, f.fill), 'image/png'));
    }
    const models = new Map();
    for (const m of fixtures.models) {
      const { modelId, createdAt, updatedAt, ...body } = m;
      const parsed = parseModel(body);
      if (parsed.status !== 'ok') throw new Error(`models-fixtures.json: ${modelId} is not a valid model`);
      models.set(modelId, { input: parsed.input, createdAt, updatedAt });
    }
    state.fo = { files, models, uuid: 0 };
  }
  return state.fo;
}

const platformModel = (id, m) => ({ ...structuredClone(m.input), createdAt: m.createdAt, modelId: id, updatedAt: m.updatedAt });

function fileIdsOf(input) {
  const ids = [];
  for (const view of VIEWS) {
    for (const c of input.views[view]?.colorways ?? []) {
      ids.push(c.photoFileId, c.displacementFileId);
      if (c.maskFileId !== null) ids.push(c.maskFileId);
    }
  }
  return [...new Set(ids)];
}

// ── the body (studio-assets.ts parseModel3dInput) ───────────────────────────

function parseSize(v, min, max) {
  return isObject(v) && onlyKeys(v, ['h', 'w']) && isInt(v.w, min, max) && isInt(v.h, min, max) ? { h: v.h, w: v.w } : null;
}

function parseTuning(v) {
  if (!isObject(v) || !onlyKeys(v, ['alpha', 'blend', 'displacementBlur', 'displacementContrast', 'displacementScale'])) return undefined;
  const out = {};
  const ranges = { alpha: [0, 1], displacementBlur: [0, 100], displacementContrast: [0, 20], displacementScale: [0, 1000] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (v[key] === undefined) continue;
    if (!isNum(v[key], min, max)) return undefined;
    out[key] = v[key];
  }
  if (v.blend !== undefined) {
    if (!BLENDS.includes(v.blend)) return undefined;
    out.blend = v.blend;
  }
  return out;
}

function parseColorway(v) {
  if (!isObject(v) || !onlyKeys(v, ['displacementFileId', 'id', 'label', 'mapContrastSd', 'maskFileId', 'photoFileId'])) return null;
  if (!COLORWAY_ID.test(v.id ?? '') || !isLabel(v.label) || !FILE_ID.test(v.photoFileId ?? '') || !FILE_ID.test(v.displacementFileId ?? '')) return null;
  const mask = v.maskFileId === undefined ? null : v.maskFileId;
  if (mask !== null && !FILE_ID.test(mask)) return null;
  const out = { displacementFileId: v.displacementFileId, id: v.id, label: v.label, maskFileId: mask, photoFileId: v.photoFileId };
  if (v.mapContrastSd !== undefined && v.mapContrastSd !== null) {
    if (!isNum(v.mapContrastSd, 0, 256)) return null;
    out.mapContrastSd = v.mapContrastSd;
  }
  return out;
}

function parseView(v) {
  if (!isObject(v) || !onlyKeys(v, ['colorways', 'h', 'originalDims', 'printArea', 'printAreaMm', 'w'])) return null;
  const w = v.w ?? null;
  const h = v.h ?? null;
  if ((w === null) !== (h === null) || (w !== null && (!isInt(w, 1, PX_MAX) || !isInt(h, 1, PX_MAX)))) return null;
  const pa = v.printArea;
  if (!isObject(pa) || !onlyKeys(pa, ['h', 'w', 'x', 'y']) || !['x', 'y', 'w', 'h'].every((k) => isInt(pa[k], 0, PX_MAX))) return null;
  const printAreaMm = v.printAreaMm == null ? null : parseSize(v.printAreaMm, 0, MM_MAX);
  const originalDims = v.originalDims == null ? null : parseSize(v.originalDims, 1, ORIGINAL_PX_MAX);
  if ((v.printAreaMm != null && !printAreaMm) || (v.originalDims != null && !originalDims)) return null;
  const raw = v.colorways ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_COLORWAYS) return null;
  const colorways = [];
  for (const entry of raw) {
    const c = parseColorway(entry);
    if (!c) return null;
    if (colorways.some((o) => o.id === c.id)) return 'duplicate_colorway';
    colorways.push(c);
  }
  return { colorways, h, originalDims, printArea: { h: pa.h, w: pa.w, x: pa.x, y: pa.y }, printAreaMm, w };
}

/** → { status: 'ok', input } | { status: 'invalid', reason? } */
export function parseModel(body) {
  if (!isObject(body) || !onlyKeys(body, MODEL_KEYS) || !isLabel(body.label)) return { status: 'invalid' };
  const active = body.active ?? true;
  if (typeof active !== 'boolean') return { status: 'invalid' };
  const tuning = parseTuning(Object.fromEntries(['alpha', 'blend', 'displacementBlur', 'displacementContrast', 'displacementScale']
    .filter((k) => body[k] !== undefined).map((k) => [k, body[k]])));
  if (tuning === undefined) return { status: 'invalid' };
  const input = { active, label: body.label, output: null, perColorway: {}, views: {}, ...tuning };
  if (body.output != null) {
    input.output = parseSize(body.output, 1, PX_MAX);
    if (!input.output) return { status: 'invalid' };
  }
  if (body.perColorway !== undefined) {
    if (!isObject(body.perColorway) || Object.keys(body.perColorway).length > MAX_PER_COLORWAY) return { status: 'invalid' };
    for (const [id, entry] of Object.entries(body.perColorway)) {
      const override = COLORWAY_ID.test(id) ? parseTuning(entry) : undefined;
      if (override === undefined) return { status: 'invalid' };
      if (Object.keys(override).length > 0) input.perColorway[id] = override;
    }
  }
  if (!isObject(body.views) || Object.keys(body.views).length === 0) return { status: 'invalid' };
  for (const [viewId, entry] of Object.entries(body.views)) {
    if (!VIEWS.includes(viewId)) return { status: 'invalid' };
    const view = parseView(entry);
    if (view === null) return { status: 'invalid' };
    if (view === 'duplicate_colorway') return { status: 'invalid', reason: 'duplicate_colorway' };
    input.views[viewId] = view;
  }
  return { status: 'ok', input };
}

// ── the routes ──────────────────────────────────────────────────────────────

const MODEL = /^\/v1\/platform\/pod\/3d-models\/([^/]+)$/;

function list(state, { headers }) {
  const fo = held(state);
  const s = scenario(headers);
  if (s === 'error' || s === 'unclear') return json(500, { error: { code: 'internal_error', message: 'Something went wrong' } });
  const entries = s === 'empty' ? [] : [...fo.models.entries()]
    .sort(([ia, a], [ib, b]) => (a.input.label < b.input.label ? -1 : a.input.label > b.input.label ? 1 : ia < ib ? -1 : 1));
  const models = entries.map(([id, m]) => platformModel(id, m));
  const files = {};
  for (const model of models) {
    for (const id of fileIdsOf(model)) if (fo.files.has(id)) files[id] = structuredClone(fo.files.get(id));
  }
  return json(200, { models, files });
}

/** A write in the lost / drop / unclear scenarios: done or not, its answer is a 502. */
function writeScenario(headers, write) {
  const s = scenario(headers);
  if (s === 'drop' || s === 'unclear') return lostAnswer();
  const answer = write();
  return s === 'lost' && answer.status < 300 ? lostAnswer() : answer;
}

function put(state, { segments, body, headers }) {
  const fo = held(state);
  const modelId = decodeURIComponent(segments[0]);
  if (!MODEL_ID.test(modelId)) return notFound();
  const forced = scenario(headers).startsWith('refuse:') ? scenario(headers).slice('refuse:'.length) : null;
  if (forced) return invalid(forced);
  const parsed = parseModel(body);
  if (parsed.status !== 'ok') return invalid(parsed.reason);
  const { input } = parsed;
  const ids = fileIdsOf(input);
  if (ids.some((id) => !fo.files.has(id))) return invalid('file_not_found');
  for (const view of VIEWS) {
    for (const c of input.views[view]?.colorways ?? []) {
      const sizes = [c.photoFileId, c.displacementFileId, c.maskFileId].filter(Boolean).map((id) => fo.files.get(id))
        .filter((f) => f.width !== null && f.height !== null).map((f) => `${f.width}x${f.height}`);
      if (new Set(sizes).size > 1) return invalid('not_registered');
    }
  }
  const existing = fo.models.get(modelId);
  if (existing && stable(existing.input) === stable(input)) {
    return json(200, { changed: false, model: platformModel(modelId, existing) });
  }
  if (!existing && (scenario(headers) === 'limit' || fo.models.size >= MAX_MODELS)) {
    return json(409, { error: { code: 'limit_reached', message: 'The platform holds the most models it may' } });
  }
  return writeScenario(headers, () => {
    const at = new Date().toISOString();
    fo.models.set(modelId, { input, createdAt: existing?.createdAt ?? at, updatedAt: at });
    return json(existing ? 200 : 201, { changed: true, model: platformModel(modelId, fo.models.get(modelId)) });
  });
}

function patch(state, { segments, body, headers }) {
  const fo = held(state);
  const modelId = decodeURIComponent(segments[0]);
  if (!MODEL_ID.test(modelId)) return notFound();
  if (!isObject(body) || !onlyKeys(body, ['active']) || typeof body.active !== 'boolean') return invalid();
  const m = fo.models.get(modelId);
  if (!m) return notFound();
  if (m.input.active === body.active) return json(200, { changed: false, model: platformModel(modelId, m) });
  return writeScenario(headers, () => {
    m.input.active = body.active;
    m.updatedAt = new Date().toISOString();
    return json(200, { changed: true, model: platformModel(modelId, m) });
  });
}

function upload(state, { body, headers }) {
  const fo = held(state);
  const s = scenario(headers);
  if (s === 'dark') return notFound();
  const raw = headers['content-length'];
  if (raw === undefined || !/^[0-9]{1,15}$/.test(String(raw))) return invalid();
  if (Number(raw) > FILE_MAX_BYTES) return json(413, { error: { code: 'payload_too_large', message: 'The request exceeds the maximum allowed size' } });
  const bytes = body?.raw;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length !== Number(raw)) return invalid();
  if (s === 'reject-file') return invalid('not_an_allowed_image');
  const proven = sniff(bytes);
  if (!proven) return invalid('not_an_allowed_image');
  const stated = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
  if (stated !== proven) return invalid('type_not_as_stated');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const known = [...fo.files.values()].find((f) => f.sha256 === sha);
  if (known) return s === 'drop' || s === 'unclear' ? lostAnswer() : json(200, { file: structuredClone(known) });
  return writeScenario(headers, () => {
    fo.uuid += 1;
    const fileId = `0f3d0000-0000-4000-8000-${String(fo.uuid).padStart(12, '0')}`;
    fo.files.set(fileId, fileOf(fileId, bytes, proven));
    return json(201, { file: structuredClone(fo.files.get(fileId)) });
  });
}

export const MODEL_ROUTES = [
  ['GET', '/v1/platform/pod/3d-models', list],
  ['PUT', MODEL, put],
  ['PATCH', MODEL, patch],
  ['POST', '/v1/platform/pod/studio-files', upload],
];
