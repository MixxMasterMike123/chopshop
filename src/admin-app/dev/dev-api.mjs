// The admin's DEV API (CP5 brief FA.6): a middleware of the admin's Vite dev
// server that answers the `/_api/…` routes of the shell from fixtures.json, in
// the API's shapes (CP5 brief §0.2; Better Auth's for /api/auth/…). It lets
// the sign-in pages and the shells be run and looked at before the admin
// Worker exists.
//
// INVENTED DATA ONLY: two shops ("Test Shop A" active, "Test Shop B"
// suspended), one tenant admin who is a member of both, one platform user.
// Sign in as admin@example.com / dev-password-1 or platform@example.com /
// dev-password-2. The reset link of the dev mail is
// /_api/api/auth/reset-password/devresettoken0000000001.
//
// NEVER part of the build: vite.admin.config.js imports this module only
// inside a plugin that applies to the dev server (`apply: 'serve'`), and only
// when no real API is proxied (ADMIN_API_ORIGIN unset). The marker below is
// in every answer; dev-api.test.mjs fails when a build holds it.
//
// Later units add their routes to ROUTES (a row: method, path pattern,
// handler), with their own fixtures. The guards are the API's: an admin route
// answers the opaque 404 without a session or without a shop the user may use
// (X-Shop-Id); a platform route answers 404 to anyone but a platform user and
// to any request that carries X-Shop-Id (D70); /v1/me answers 401 when signed
// out.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_API_MARKER = 'admin-dev-api-invented-data';
export const SESSION_COOKIE = 'admin_dev_session';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures.json');

export function loadFixtures(file = FIXTURES) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// ── answers ─────────────────────────────────────────────────────────────────

const json = (status, body, extra = {}) => ({ status, body, ...extra });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const unauthenticated = () => json(401, { error: { code: 'unauthenticated', message: 'Not signed in' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });

// ── the session ─────────────────────────────────────────────────────────────

export function createState(fixtures = loadFixtures()) {
  return { fixtures, sessions: new Map() };
}

function cookieOf(headers, name) {
  const header = headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function userOf(state, headers) {
  const token = cookieOf(headers, SESSION_COOKIE);
  const userId = token ? state.sessions.get(token) : null;
  return userId ? state.fixtures.users.find((u) => u.user.id === userId) ?? null : null;
}

/** The `/v1/me` answer of a fixture user (CP5 brief §0.2). */
export function meOf(state, entry, now = Date.now()) {
  const shops = state.fixtures.shops;
  return {
    user: { ...entry.user },
    accountType: entry.accountType,
    platform: entry.platform === true,
    memberships: entry.memberships
      .filter((m) => shops[m.tenantId])
      .map((m) => {
        const { shop } = shops[m.tenantId];
        return { tenantId: m.tenantId, shopName: shop.shopName, status: shop.status, published: shop.published, role: m.role };
      }),
    actingAs: (entry.actingAs ?? [])
      .filter((g) => shops[g.tenantId] && Date.parse(g.expiresAt) > now)
      .map((g) => ({ tenantId: g.tenantId, shopName: shops[g.tenantId].shop.shopName, expiresAt: g.expiresAt })),
  };
}

/** The shop of an admin request: a live membership of an active shop, or an open grant. Else null. */
function adminShopOf(state, entry, headers) {
  const shopId = headers['x-shop-id'];
  const record = typeof shopId === 'string' ? state.fixtures.shops[shopId] : null;
  if (!entry || !record) return null;
  const me = meOf(state, entry);
  const member = me.memberships.some((m) => m.tenantId === shopId && m.status === 'active');
  const acting = me.platform && me.actingAs.some((g) => g.tenantId === shopId);
  return member || acting ? record : null;
}

// ── routes ──────────────────────────────────────────────────────────────────
// [method, path (exact, or a RegExp whose groups are the segments), handler]
// handler(state, ctx) where ctx = { entry, shop, headers, body, url, segments }

const AUTH_ROUTES = [
  ['POST', '/api/auth/sign-in/email', (state, { body }) => {
    const entry = state.fixtures.users.find((u) => u.user.email === body?.email);
    if (!entry || entry.password !== body?.password) {
      return json(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
    }
    const token = randomBytes(18).toString('hex');
    state.sessions.set(token, entry.user.id);
    return json(200, { redirect: false, token, user: { ...entry.user } }, {
      setCookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`,
    });
  }],
  ['POST', '/api/auth/sign-out', (state, { headers }) => {
    const token = cookieOf(headers, SESSION_COOKIE);
    if (token) state.sessions.delete(token);
    return json(200, { success: true }, { setCookie: `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` });
  }],
  ['GET', '/api/auth/get-session', (state, { entry }) =>
    json(200, entry ? { user: { ...entry.user }, session: { userId: entry.user.id } } : null)],
  ['POST', '/api/auth/request-password-reset', (_state, { body }) =>
    typeof body?.email === 'string'
      ? json(200, { status: true, message: 'If this email exists in our system, check your email for the reset link' })
      : json(400, { code: 'VALIDATION_ERROR', message: 'Invalid body' })],
  ['GET', /^\/api\/auth\/reset-password\/([A-Za-z0-9_-]{16,128})$/, (state, { segments }) => {
    const known = Boolean(state.fixtures.resetTokens[segments[0]]);
    const location = known ? `/reset-password?token=${segments[0]}` : '/reset-password?error=INVALID_TOKEN';
    return { status: 302, location };
  }],
  ['POST', '/api/auth/reset-password', (state, { body }) => {
    if (typeof body?.newPassword !== 'string') return json(400, { code: 'VALIDATION_ERROR', message: 'Invalid body' });
    if (!body.token || !state.fixtures.resetTokens[body.token]) return json(400, { code: 'INVALID_TOKEN', message: 'Invalid token' });
    if (body.newPassword.length < 8) return json(400, { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' });
    if (body.newPassword.length > 128) return json(400, { code: 'PASSWORD_TOO_LONG', message: 'Password too long' });
    return json(200, { status: true });
  }],
];

const ADMIN_ROUTES = [
  ['GET', '/v1/admin/shop', (_state, { shop }) => json(200, { shop: structuredClone(shop.shop) })],
  ['GET', '/v1/admin/settings', (_state, { shop }) => json(200, { settings: structuredClone(shop.settings) })],
];

// Unit FB adds the platform rows (tenants, acting-as) here.
const PLATFORM_ROUTES = [];

function match(pattern, path) {
  if (typeof pattern === 'string') return pattern === path ? [] : null;
  const m = pattern.exec(path);
  return m ? m.slice(1) : null;
}

function find(table, method, path) {
  for (const [verb, pattern, handler] of table) {
    const segments = match(pattern, path);
    if (segments !== null && verb === method) return { handler, segments };
  }
  return null;
}

/**
 * One request → `{ status, body?, setCookie?, location? }`. Pure apart from
 * the sessions of `state`. `headers`: lower-case names. `url`: a URL whose
 * pathname starts with /_api.
 */
export function route(state, method, url, headers = {}, body = null) {
  if (!url.pathname.startsWith('/_api/')) return notFound();
  const path = url.pathname.slice('/_api'.length);
  const entry = userOf(state, headers);

  if (path === '/v1/me') {
    if (method !== 'GET') return notFound();
    // X-Shop-Id is ignored here, as WA decides (CP5 brief WA.3).
    return entry ? json(200, meOf(state, entry)) : unauthenticated();
  }

  if (path.startsWith('/api/auth/')) {
    const hit = find(AUTH_ROUTES, method, path);
    return hit ? hit.handler(state, { entry, headers, body, url, segments: hit.segments }) : notFound();
  }

  if (path.startsWith('/v1/admin/')) {
    const shop = adminShopOf(state, entry, headers);
    const hit = find(ADMIN_ROUTES, method, path);
    if (!shop || !hit) return notFound();
    return hit.handler(state, { entry, shop, headers, body, url, segments: hit.segments });
  }

  if (path.startsWith('/v1/platform/')) {
    if (!entry || entry.platform !== true || headers['x-shop-id'] !== undefined) return notFound();
    const hit = find(PLATFORM_ROUTES, method, path);
    return hit ? hit.handler(state, { entry, headers, body, url, segments: hit.segments }) : notFound();
  }

  return notFound();
}

// ── the middleware ──────────────────────────────────────────────────────────

async function readJson(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A Connect middleware for Vite's dev server. One state (the sessions) per server. */
export function createDevApi({ fixtures = FIXTURES } = {}) {
  const state = createState(loadFixtures(fixtures));
  return async function devApi(req, res, next) {
    const url = new URL(req.url, 'http://dev.invalid');
    if (!url.pathname.startsWith('/_api/')) return next();
    // Fixtures are re-read on every request, so an edit shows on reload.
    state.fixtures = loadFixtures(fixtures);
    const body = await readJson(req);
    const answer = body === undefined ? invalid() : route(state, req.method, url, req.headers, body);
    res.statusCode = answer.status;
    res.setHeader('X-Admin-Dev', DEV_API_MARKER);
    res.setHeader('Cache-Control', 'no-store');
    if (answer.setCookie) res.setHeader('Set-Cookie', answer.setCookie);
    if (answer.location) {
      res.setHeader('Location', answer.location);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(answer.body));
  };
}
