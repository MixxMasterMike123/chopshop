// The dev API's rows for the platform console's settings pages (unit CP5-FL),
// wired into dev-api.mjs. INVENTED data only (platform-settings-fixtures.json),
// in the Worker's shapes and with its refusals
// (cloudflare/src/routes/platform-settings.ts, cloudflare/src/platform/platform-settings.ts,
// cloudflare/src/catalog/screening.ts, cloudflare/src/routes/legal-platform.ts,
// cloudflare/src/legal/platform-terms.ts):
//   GET/PATCH  /v1/platform/settings
//   GET/POST   /v1/platform/screening-terms
//   PATCH/DELETE /v1/platform/screening-terms/:termKey
//   POST       /v1/platform/screening-terms/rescreen
//   GET/POST   /v1/platform/legal/terms-versions
//   GET/PUT    /v1/platform/legal/terms-versions/:version/text
// The platform guard (a platform session, no X-Shop-Id) is dev-api.mjs's.
// Not the Worker's: the term normal form is a small stand-in for its matcher,
// and the re-screen counts are invented (no products are screened here).
// Changes are held in memory per server (state.fl), over the fixtures.
//
// The version `seed: true` of the fixtures stands for the 0031 seed: its hash
// is the one of the text the console's "Arkivera texten från koden" sends
// (src/config/platformTerms.js), and it starts with no archived text.
//
// Scenarios, by the cookie `admin_dev_fl` (also read by redirects-dev.mjs; in
// the browser console: document.cookie = 'admin_dev_fl=lost; path=/'; remove
// it with Max-Age=0):
//   empty      no terms, no versions
//   error      every read answers 500
//   lost       every write is done, but answered 502 (its answer is lost)
//   drop       every write answers 502 and is NOT done
//   unclear    as drop, and every read answers 500 too (the read-back fails)
//   conflict   every write answers 409 conflict
//   stale      another operator: every settings read moves the fee by 0,25 %
//   full       adding a term answers 409 term_limit
//   dark       the terms-text routes answer the opaque 404 (no private bucket)

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_DPA_TEMPLATE, PLATFORM_TERMS_TEMPLATE, PLATFORM_TERMS_VERSION } from '../../config/platformTerms.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'platform-settings-fixtures.json');
export const FL_COOKIE = 'admin_dev_fl';

const KINDS = ['band', 'brand', 'club', 'other'];
const VERSION = /^[0-9A-Za-z._-]{1,32}$/;
const TEXT_MAX_BYTES = 262_144;
const MAX_TERMS = 2000;

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = (field) => json(400, { error: field === undefined
  ? { code: 'invalid_request', message: 'Request is not valid' }
  : { code: 'invalid_request', field, message: 'Request is not valid' } });
const conflict = (code, message, extra = {}) => json(409, { ...extra, error: { code, message } });
const serverError = () => json(500, { error: { code: 'internal_error', message: 'Dev scenario: the read failed' } });
const lostAnswer = () => json(502, { error: { code: 'bad_gateway', message: 'The answer was lost on the way (dev scenario)' } });

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function cookieOf(headers, name) {
  for (const part of String(headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
export const scenario = (headers) => cookieOf(headers, FL_COOKIE) || '';

/** The text the 0031 seed's hash stands for (CP3_E_REPORT.md §2). */
export const SEED_TEXT = JSON.stringify({ version: PLATFORM_TERMS_VERSION, terms: PLATFORM_TERMS_TEMPLATE, dpa: PLATFORM_DPA_TEMPLATE });

export function termKeyOf(term) {
  return Buffer.from(term, 'utf8').toString('base64url');
}

/** A small stand-in for the Worker's normalizeScreeningTerm (screening-core.ts). */
export function normalizeTerm(input) {
  if (typeof input !== 'string' || /[\u0000-\u001f\u007f]/.test(input)) return null;
  const trimmed = input.normalize('NFC').trim();
  if (trimmed === '') return null;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return trimmed.length <= 200 ? trimmed : null;
  const folded = trimmed.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return folded !== '' && folded.length <= 200 ? folded : null;
}

function held(state) {
  if (!state.fl) {
    const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
    const versions = fixtures.versions.map((v) => {
      if (v.seed) return { version: v.version, publishedAt: v.publishedAt, sha256: sha256(SEED_TEXT), text: null };
      const text = JSON.stringify({ version: v.version, terms: v.text.terms, dpa: v.text.dpa });
      return { version: v.version, publishedAt: v.publishedAt, sha256: sha256(text), text };
    });
    state.fl = {
      settings: structuredClone(fixtures.settings),
      terms: new Map(fixtures.terms.map((t) => [t.term, structuredClone(t)])),
      backlog: structuredClone(fixtures.rescreen),
      versions,
    };
  }
  return state.fl;
}

const termView = (t) => ({ createdAt: t.createdAt, hardBlock: t.hardBlock, kind: t.kind, note: t.note ?? null, term: t.term, termKey: termKeyOf(t.term) });

function writeScenario(headers, apply) {
  const s = scenario(headers);
  if (s === 'conflict') return conflict('conflict', 'The screening settings changed meanwhile; try again');
  if (s === 'drop' || s === 'unclear') return lostAnswer();
  const answer = apply();
  return s === 'lost' && answer.status < 300 ? lostAnswer() : answer;
}
const readScenario = (headers) => ['error', 'unclear'].includes(scenario(headers));

/** The re-screen summary of a change (invented counts: nothing is screened here). */
function rescreenOf(fl, blockedNow) {
  return { blockedNow, pending: fl.backlog.pending, unverified: fl.backlog.unverified };
}

function bumpVersion(fl, by = 1) {
  fl.settings.screeningTermsVersion += by;
  fl.backlog.pending += 3;
}

// ── settings ────────────────────────────────────────────────────────────────

function getSettings(state, { headers }) {
  if (readScenario(headers)) return serverError();
  const fl = held(state);
  if (scenario(headers) === 'stale') {
    fl.settings.defaultCommissionBps = (fl.settings.defaultCommissionBps + 25) % 825;
    fl.settings.updatedAt = iso();
  }
  return json(200, { settings: structuredClone(fl.settings) });
}

function patchSettings(state, { headers, body, entry }) {
  const fl = held(state);
  if (!isObject(body)) return invalid(null);
  const keys = Object.keys(body);
  const pinned = ['refundApplicationFee', 'reverseDisputeOnCreated'].find((k) => keys.includes(k));
  if (pinned) return json(400, { error: { code: 'setting_not_editable', field: pinned, message: `${pinned} is fixed in code in this checkpoint and cannot be changed here` } });
  const editable = ['defaultCommissionBps', 'reviewFirstProducts', 'screeningHardBlock'];
  const unknown = keys.find((k) => !editable.includes(k));
  if (unknown !== undefined || keys.length === 0) return invalid(unknown ?? null);
  const isInt = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  if ('defaultCommissionBps' in body && !isInt(body.defaultCommissionBps, 800)) return invalid('defaultCommissionBps');
  if ('reviewFirstProducts' in body && !isInt(body.reviewFirstProducts, 100)) return invalid('reviewFirstProducts');
  if ('screeningHardBlock' in body && typeof body.screeningHardBlock !== 'boolean') return invalid('screeningHardBlock');
  return writeScenario(headers, () => {
    const screening = 'screeningHardBlock' in body;
    Object.assign(fl.settings, body, { updatedAt: iso(), updatedBy: entry.user.id });
    let blockedNow = 0;
    if (screening) {
      bumpVersion(fl);
      if (body.screeningHardBlock) blockedNow = [...fl.terms.values()].filter((t) => !t.hardBlock).length;
    }
    return json(200, { rescreen: screening ? rescreenOf(fl, blockedNow) : null, settings: structuredClone(fl.settings) });
  });
}

// ── the brand filter ────────────────────────────────────────────────────────

function listTerms(state, { headers, url }) {
  if (readScenario(headers)) return serverError();
  const fl = held(state);
  if ([...url.searchParams.keys()].some((k) => k !== 'cursor' && k !== 'limit')) return invalid();
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return invalid();
  const cursorRaw = url.searchParams.get('cursor');
  const after = cursorRaw === null ? null : Buffer.from(cursorRaw, 'base64url').toString('utf8');
  const sorted = scenario(headers) === 'empty' ? [] : [...fl.terms.values()]
    .sort((a, b) => Buffer.compare(Buffer.from(a.term), Buffer.from(b.term)))
    .filter((t) => after === null || Buffer.compare(Buffer.from(t.term), Buffer.from(after)) > 0);
  const page = sorted.slice(0, limit);
  return json(200, {
    nextCursor: sorted.length > limit ? termKeyOf(page.at(-1).term) : null,
    terms: page.map(termView),
    termsVersion: fl.settings.screeningTermsVersion,
  });
}

function parseNote(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || value.trim().length > 500) return { ok: false };
  return { ok: true, value: value.trim() === '' ? null : value.trim() };
}

function addTerm(state, { headers, body }) {
  const fl = held(state);
  if (!isObject(body) || !Object.keys(body).every((k) => ['hardBlock', 'kind', 'note', 'term'].includes(k))) return invalid();
  const term = normalizeTerm(body.term);
  const kind = body.kind === undefined ? 'other' : body.kind;
  const note = parseNote(body.note);
  const hardBlock = body.hardBlock === undefined ? false : body.hardBlock;
  if (term === null || !KINDS.includes(kind) || !note.ok || typeof hardBlock !== 'boolean') return invalid();
  if (scenario(headers) === 'full' || fl.terms.size >= MAX_TERMS) return conflict('term_limit', 'The blocklist is full');
  if (fl.terms.has(term)) return conflict('duplicate_term', 'The blocklist already has a term that matches the same text');
  return writeScenario(headers, () => {
    const row = { createdAt: iso(), hardBlock, kind, note: note.value ?? null, term };
    fl.terms.set(term, row);
    bumpVersion(fl);
    return json(201, { rescreen: rescreenOf(fl, hardBlock ? 2 : 0), term: termView(row) });
  });
}

const TERM = /^\/v1\/platform\/screening-terms\/([A-Za-z0-9_-]{1,1100})$/;

function termOf(fl, key) {
  const term = Buffer.from(key, 'base64url').toString('utf8');
  return termKeyOf(term) === key ? fl.terms.get(term) ?? null : null;
}

function patchTerm(state, { headers, body, segments }) {
  const fl = held(state);
  const row = termOf(fl, segments[0]);
  if (!row) return notFound();
  if (!isObject(body) || Object.keys(body).length === 0 || !Object.keys(body).every((k) => ['hardBlock', 'kind', 'note'].includes(k))) return invalid();
  if (body.kind !== undefined && !KINDS.includes(body.kind)) return invalid();
  if (body.hardBlock !== undefined && typeof body.hardBlock !== 'boolean') return invalid();
  const note = parseNote(body.note);
  if (!note.ok) return invalid();
  return writeScenario(headers, () => {
    const turnedOn = body.hardBlock === true && !row.hardBlock;
    if (body.kind !== undefined) row.kind = body.kind;
    if (note.value !== undefined) row.note = note.value;
    if (body.hardBlock !== undefined) {
      row.hardBlock = body.hardBlock;
      bumpVersion(fl);
    }
    return json(200, { rescreen: rescreenOf(fl, turnedOn ? 1 : 0), term: termView(row) });
  });
}

function deleteTerm(state, { headers, segments }) {
  const fl = held(state);
  const row = termOf(fl, segments[0]);
  if (!row) return notFound();
  return writeScenario(headers, () => {
    fl.terms.delete(row.term);
    bumpVersion(fl);
    return json(200, { deleted: true, rescreen: rescreenOf(fl, 0) });
  });
}

function rescreen(state, { headers }) {
  const fl = held(state);
  return writeScenario(headers, () => {
    const rescreened = Math.min(25, fl.backlog.pending);
    fl.backlog.pending -= rescreened;
    return json(200, { pending: fl.backlog.pending, rescreened, unverified: fl.backlog.unverified });
  });
}

// ── the terms versions ──────────────────────────────────────────────────────

function versionViews(fl, headers) {
  if (scenario(headers) === 'empty') return [];
  const now = iso();
  const sorted = [...fl.versions].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : a.version < b.version ? 1 : -1));
  const current = sorted.find((v) => v.publishedAt <= now)?.version ?? null;
  return sorted.map((v) => ({ current: v.version === current, publishedAt: v.publishedAt, sha256: v.sha256, textArchived: v.text !== null, version: v.version }));
}

function listVersions(state, { headers }) {
  if (readScenario(headers)) return serverError();
  return json(200, { versions: versionViews(held(state), headers) });
}

const textOk = (text) => typeof text === 'string' && text.length > 0 && Buffer.byteLength(text, 'utf8') <= TEXT_MAX_BYTES;
const tooLarge = () => json(413, { error: { code: 'payload_too_large', message: 'The text exceeds the maximum allowed size' } });

function publishVersion(state, { headers, body }) {
  const fl = held(state);
  if (scenario(headers) === 'dark') return notFound();
  if (!isObject(body) || !Object.keys(body).every((k) => ['publishedAt', 'text', 'version'].includes(k))) return invalid();
  if (typeof body.version !== 'string' || !VERSION.test(body.version)) return invalid();
  if (typeof body.text === 'string' && Buffer.byteLength(body.text, 'utf8') > TEXT_MAX_BYTES) return tooLarge();
  if (!textOk(body.text)) return invalid();
  const publishedAt = body.publishedAt ?? iso();
  if (fl.versions.some((v) => v.version === body.version)) return conflict('terms_version_exists', 'A terms version with this label exists');
  const latest = fl.versions.map((v) => v.publishedAt).sort().at(-1) ?? null;
  if (latest !== null && latest >= publishedAt) {
    return conflict('terms_version_not_latest', 'A new terms version must be published after the latest existing version', { latestPublishedAt: latest });
  }
  return writeScenario(headers, () => {
    const row = { version: body.version, publishedAt, sha256: sha256(body.text), text: body.text };
    fl.versions.push(row);
    return json(201, { version: { current: publishedAt <= iso(), publishedAt, sha256: row.sha256, textArchived: true, version: row.version } });
  });
}

const TEXT = /^\/v1\/platform\/legal\/terms-versions\/([^/]+)\/text$/;

function versionOf(fl, segment) {
  let label;
  try {
    label = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return VERSION.test(label) ? fl.versions.find((v) => v.version === label) ?? null : null;
}

function getText(state, { headers, segments }) {
  if (readScenario(headers)) return serverError();
  if (scenario(headers) === 'dark') return notFound();
  const v = versionOf(held(state), segments[0]);
  if (!v) return notFound();
  return json(200, { publishedAt: v.publishedAt, sha256: v.sha256, text: v.text, textArchived: v.text !== null, version: v.version });
}

function putText(state, { headers, body, segments }) {
  if (scenario(headers) === 'dark') return notFound();
  const v = versionOf(held(state), segments[0]);
  if (!v) return notFound();
  if (!isObject(body) || Object.keys(body).length !== 1 || !('text' in body)) return invalid();
  if (typeof body.text === 'string' && Buffer.byteLength(body.text, 'utf8') > TEXT_MAX_BYTES) return tooLarge();
  if (!textOk(body.text)) return invalid();
  const supplied = sha256(body.text);
  if (supplied !== v.sha256) {
    return conflict('terms_text_hash_mismatch', "The text does not hash to this version's stored SHA-256", { expectedSha256: v.sha256, suppliedSha256: supplied });
  }
  const view = () => ({ publishedAt: v.publishedAt, sha256: v.sha256, textArchived: true, version: v.version });
  if (v.text !== null) return json(200, { version: view() });
  return writeScenario(headers, () => {
    v.text = body.text;
    return json(201, { version: view() });
  });
}

export const FL_PLATFORM_ROUTES = [
  ['GET', '/v1/platform/settings', getSettings],
  ['PATCH', '/v1/platform/settings', patchSettings],
  ['GET', '/v1/platform/screening-terms', listTerms],
  ['POST', '/v1/platform/screening-terms', addTerm],
  ['POST', '/v1/platform/screening-terms/rescreen', rescreen],
  ['PATCH', TERM, patchTerm],
  ['DELETE', TERM, deleteTerm],
  ['GET', '/v1/platform/legal/terms-versions', listVersions],
  ['POST', '/v1/platform/legal/terms-versions', publishVersion],
  ['GET', TEXT, getText],
  ['PUT', TEXT, putText],
];
