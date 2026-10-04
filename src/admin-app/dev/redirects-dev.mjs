// The dev API's rows for the shop's forwards (unit CP5-FL), wired into
// dev-api.mjs. INVENTED data only (redirects-fixtures.json), in the Worker's
// shapes and with its refusals (cloudflare/src/routes/admin-redirects.ts,
// cloudflare/src/storefront/redirects.ts):
//   GET    /v1/admin/redirects?cursor=&limit=   one page, by fromPath (byte order)
//   PUT    /v1/admin/redirects                  { redirects: [{ fromPath, toPath }] }
//   DELETE /v1/admin/redirects                  { fromPaths }
// The admin guard (a membership or an open acting-as grant of X-Shop-Id) is
// dev-api.mjs's. The path normal form is the Worker's, ported in
// adapters/redirects.js. Changes are held in memory per server and shop.
//
// Scenarios, by the cookie `admin_dev_fl` (shared with platform-settings-dev.mjs):
//   empty, error, lost, drop, unclear, conflict   as there
//   many       230 invented forwards more (the list pages)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStorefrontPath } from '../adapters/redirects.js';
import { scenario } from './platform-settings-dev.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'redirects-fixtures.json');
const PER_CALL_MAX = 500;
const UNFORWARDABLE = new Set(['_api', 'angra', 'assets', 'cart', 'checkout', 'images', 'order-confirmation',
  'order-return', 'rapportera-intrang', 'robots.txt', 'sitemap.xml']);

const json = (status, body) => ({ status, body });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });
const serverError = () => json(500, { error: { code: 'internal_error', message: 'Dev scenario: the read failed' } });
const lostAnswer = () => json(502, { error: { code: 'bad_gateway', message: 'The answer was lost on the way (dev scenario)' } });
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function heldFor(state, shopId, headers) {
  state.flRedirects ??= new Map();
  const many = scenario(headers) === 'many';
  const key = `${shopId}${many ? '#many' : ''}`;
  if (!state.flRedirects.has(key)) {
    const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
    const rows = structuredClone(fixtures[shopId] ?? []);
    if (many) {
      for (let i = 1; i <= 230; i += 1) {
        const n = String(i).padStart(3, '0');
        rows.push({ fromPath: `/products/exempel-${n}`, toPath: `/product/exempel-${n}`, createdAt: '2026-09-23T09:00:00.000Z', createdBy: 'user-tenant-admin' });
      }
    }
    state.flRedirects.set(key, new Map(rows.map((r) => [r.fromPath, r])));
  }
  return state.flRedirects.get(key);
}

function list(state, { shop, headers, url }) {
  const s = scenario(headers);
  if (s === 'error' || s === 'unclear') return serverError();
  const params = url.searchParams;
  if ([...params.keys()].some((k) => k !== 'cursor' && k !== 'limit')) return invalid();
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 100 : /^[1-9][0-9]{0,2}$/.test(rawLimit) ? Number(rawLimit) : 0;
  if (limit < 1 || limit > PER_CALL_MAX) return invalid();
  const rawCursor = params.get('cursor');
  let after = null;
  if (rawCursor !== null) {
    if (!/^[A-Za-z0-9_-]+$/.test(rawCursor)) return invalid();
    after = Buffer.from(rawCursor, 'base64url').toString('utf8');
    if (!after.startsWith('/')) return invalid();
  }
  const rows = s === 'empty' ? [] : [...heldFor(state, shop.shop.tenantId, headers).values()]
    .sort((a, b) => byBytes(a.fromPath, b.fromPath))
    .filter((r) => after === null || byBytes(r.fromPath, after) > 0);
  const page = rows.slice(0, limit);
  return json(200, {
    nextCursor: rows.length > limit ? Buffer.from(page.at(-1).fromPath, 'utf8').toString('base64url') : null,
    redirects: page.map((r) => ({ ...r })),
  });
}

function writeScenario(headers, apply) {
  const s = scenario(headers);
  if (s === 'conflict') return json(409, { error: { code: 'conflict', message: 'The forwards changed meanwhile; read them and try again' } });
  if (s === 'drop' || s === 'unclear') return lostAnswer();
  const answer = apply();
  return s === 'lost' && answer.status < 300 ? lostAnswer() : answer;
}

const refused = (problems) => json(400, { error: { code: 'refused_redirects', message: 'Some forwards cannot be written', problems } });

function put(state, { shop, headers, body, entry }) {
  if (!isObject(body) || Object.keys(body).length !== 1 || !Array.isArray(body.redirects)) return invalid();
  const list = body.redirects;
  if (list.length === 0 || list.length > PER_CALL_MAX) return invalid();
  const problems = [];
  const entries = [];
  list.forEach((raw, index) => {
    if (!isObject(raw) || Object.keys(raw).some((k) => k !== 'fromPath' && k !== 'toPath')) {
      problems.push({ index, reason: 'invalid_path' });
      return;
    }
    const from = typeof raw.fromPath === 'string' ? normalizeStorefrontPath(raw.fromPath) : null;
    const toOk = typeof raw.toPath === 'string' && raw.toPath.startsWith('/') && !raw.toPath.includes('?') && !raw.toPath.includes('#');
    const to = toOk ? normalizeStorefrontPath(raw.toPath) : null;
    if (from === null) return void problems.push({ index, reason: 'invalid_path' });
    if (from === '/' || UNFORWARDABLE.has((from.slice(1).split('/')[0] ?? '').toLowerCase())) return void problems.push({ index, reason: 'reserved_path' });
    if (to === null) return void problems.push({ index, reason: 'invalid_path' });
    if (from === to) return void problems.push({ index, reason: 'same_path' });
    entries.push({ fromPath: from, toPath: to });
  });
  if (problems.length === 0) {
    const froms = new Map();
    entries.forEach((e, index) => {
      if (froms.has(e.fromPath)) problems.push({ index, reason: 'duplicate' });
      froms.set(e.fromPath, index);
    });
    entries.forEach((e, index) => {
      if (froms.has(e.toPath)) problems.push({ index, reason: 'chain' });
    });
  }
  if (problems.length > 0) return refused(problems);
  const held = heldFor(state, shop.shop.tenantId, headers);
  const storedTargets = new Set([...held.values()].map((r) => r.toPath));
  entries.forEach((e, index) => {
    if (held.has(e.toPath) || storedTargets.has(e.fromPath)) problems.push({ index, reason: 'chain' });
  });
  if (problems.length > 0) return refused(problems);
  return writeScenario(headers, () => {
    const at = new Date().toISOString();
    const written = entries.map((e) => ({ ...e, createdAt: at, createdBy: entry.user.id }));
    for (const row of written) held.set(row.fromPath, row);
    return json(200, { redirects: written });
  });
}

function remove(state, { shop, headers, body }) {
  if (!isObject(body) || Object.keys(body).length !== 1 || !Array.isArray(body.fromPaths)) return invalid();
  if (body.fromPaths.length === 0 || body.fromPaths.length > PER_CALL_MAX) return invalid();
  const paths = body.fromPaths.map((p) => (typeof p === 'string' ? normalizeStorefrontPath(p) : null));
  if (paths.some((p) => p === null)) return invalid();
  return writeScenario(headers, () => {
    const held = heldFor(state, shop.shop.tenantId, headers);
    for (const p of paths) held.delete(p);
    return { status: 204 };
  });
}

export const REDIRECT_ROUTES = [
  ['GET', '/v1/admin/redirects', list],
  ['PUT', '/v1/admin/redirects', put],
  ['DELETE', '/v1/admin/redirects', remove],
];
