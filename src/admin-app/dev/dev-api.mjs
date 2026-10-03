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

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_ROUTES } from './products-dev.mjs';
import { CONTENT_ROUTES } from './content-dev.mjs';
import { SHELL_PLATFORM_ROUTES, heldGrants, shellAdminRoutes } from './shells-dev.mjs';
import { ORDER_ROUTES } from './orders-dev.mjs';
import { PLATFORM_REST_ROUTES } from './platform-rest-dev.mjs';
import { MEMBER_ROUTES } from './members-dev.mjs';
import { PREVIEW_ADMIN_ROUTES, platformShopRoutes } from './platform-dev.mjs';
import { PRINTER_ROUTES } from './printers-dev.mjs';

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
    actingAs: [...(entry.actingAs ?? []), ...heldGrants(state, entry)]
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

// ── Stripe Connect (unit FF) ────────────────────────────────────────────────
// The shop's Connect state lives in memory, per shop, started from a scenario
// of fixtures.json `connectScenarios`. Pick one with the cookie
// `admin_dev_connect=<name>` (in the browser console:
// document.cookie = 'admin_dev_connect=restricted; path=/'), default `none`.
// `notfound` makes the status route answer the opaque 404. A changed cookie
// starts the shop over from that scenario. The links point back at this dev
// server (never at Stripe): onboarding returns with ?return=1.
// The walk as the Worker answers it (CP3_F_REPORT): create → onboarding;
// the first refresh → restricted (Stripe wants more); a refresh after a
// second visit to the onboarding link → active.

const CONNECT_COOKIE = 'admin_dev_connect';

function connectOf(state, shopId, headers) {
  const scenario = cookieOf(headers, CONNECT_COOKIE) || 'none';
  const presets = state.fixtures.connectScenarios ?? {};
  state.connect ??= new Map();
  const held = state.connect.get(shopId);
  if (!held || held.scenario !== scenario) {
    const preset = presets[scenario] ?? presets.none ?? {};
    state.connect.set(shopId, { scenario, visited: false, ...structuredClone(preset) });
  }
  return state.connect.get(shopId);
}

const sellerView = (c) => ({
  enabled: c.enabled === true,
  hasAccount: c.hasAccount === true,
  status: c.status ?? 'none',
  chargesEnabled: c.chargesEnabled === true,
  payoutsEnabled: c.chargesEnabled === true,
  detailsSubmitted: c.status === 'pending' || c.status === 'active',
  requirementsDue: c.requirementsDue ?? [],
  syncedAt: c.hasAccount ? '2026-10-03T09:00:00.000Z' : null,
});

const connectError = (status, code) => json(status, { error: { code, message: code } });

const CONNECT_ROUTES = [
  ['GET', '/v1/admin/payments/connect', (state, { shop, headers }) => {
    const c = connectOf(state, shop.shop.tenantId, headers);
    return c.notFound ? notFound() : json(200, { connect: sellerView(c) });
  }],
  ['POST', '/v1/admin/payments/connect/account', (state, { shop, headers }) => {
    const c = connectOf(state, shop.shop.tenantId, headers);
    if (c.notFound || !c.enabled) return notFound();
    if (c.hasAccount) return json(200, { connect: sellerView(c) });
    Object.assign(c, { hasAccount: true, status: 'onboarding', requirementsDue: [] });
    return json(201, { connect: sellerView(c) });
  }],
  ['POST', '/v1/admin/payments/connect/onboarding-link', (state, { shop, headers }) => {
    const c = connectOf(state, shop.shop.tenantId, headers);
    if (c.notFound || !c.enabled) return notFound();
    if (!c.hasAccount) return connectError(409, 'connect_account_missing');
    c.visited = true;
    return json(200, { onboarding: { url: '/admin/payments?return=1', expiresAt: '2026-10-03T09:05:00.000Z' } });
  }],
  ['POST', '/v1/admin/payments/connect/refresh', (state, { shop, headers }) => {
    const c = connectOf(state, shop.shop.tenantId, headers);
    if (c.notFound) return notFound();
    if (c.stripeDown) return connectError(502, 'connect_unavailable');
    if (c.status === 'onboarding') {
      Object.assign(c, { status: 'restricted', requirementsDue: ['external_account', 'individual.verification.document', 'tos_acceptance.date'] });
    } else if (c.status === 'restricted' && c.visited) {
      Object.assign(c, { status: 'active', chargesEnabled: true, requirementsDue: [] });
    }
    c.visited = false;
    return json(200, { connect: sellerView(c) });
  }],
  ['POST', '/v1/admin/payments/connect/login-link', (state, { shop, headers, entry }) => {
    const c = connectOf(state, shop.shop.tenantId, headers);
    // A platform user acting as the shop: the opaque 404, as the Worker.
    if (c.notFound || entry.platform === true) return notFound();
    if (!c.chargesEnabled) return connectError(409, 'connect_onboarding_incomplete');
    return json(200, { dashboard: { url: '/admin/payments#dev-stripe-dashboard' } });
  }],
];

const PLATFORM_CONNECT = /^\/v1\/platform\/tenants\/([a-z0-9-]+)\/connect$/;
const PLATFORM_PAYOUT_DELAY = /^\/v1\/platform\/tenants\/([a-z0-9-]+)\/connect\/payout-delay$/;

const platformConnectView = (tenantId, c) => ({
  ...sellerView(c),
  tenantId,
  accountId: c.hasAccount ? 'acct_dev_invented' : null,
  disabledReason: null,
  resyncNeeded: false,
  payoutDelayDays: c.payoutDelayDays ?? null,
});

const PLATFORM_CONNECT_ROUTES = [
  ['GET', PLATFORM_CONNECT, (state, { segments, headers }) => {
    const tenantId = segments[0];
    if (!state.fixtures.shops[tenantId]) return notFound();
    return json(200, { connect: platformConnectView(tenantId, connectOf(state, tenantId, headers)), operations: [] });
  }],
  ['PUT', PLATFORM_PAYOUT_DELAY, (state, { segments, headers, body }) => {
    const tenantId = segments[0];
    if (!state.fixtures.shops[tenantId]) return notFound();
    const keys = body && typeof body === 'object' ? Object.keys(body) : [];
    const days = body?.delayDays;
    const valid = keys.length === 1 && keys[0] === 'delayDays' &&
      (days === 'minimum' || (Number.isInteger(days) && days >= 0 && days <= 365));
    if (!valid) return invalid();
    const c = connectOf(state, tenantId, headers);
    if (!c.hasAccount) return connectError(409, 'connect_account_missing');
    if (days !== 'minimum' && days < 2) return connectError(422, 'connect_payout_delay_refused');
    c.payoutDelayDays = days === 'minimum' ? null : days;
    return json(200, { connect: platformConnectView(tenantId, c) });
  }],
];

// ── unit FE: store settings and the legal pages ────────────────────────────
// A shop's settings written here and its adoptions are held in the state (the
// fixtures are re-read on every request): `legal.terms` of a shop's fixture is
// its platform-terms status, `legal.pages` its adoption before any made here.
// The refusals are the Worker's: refused identity keys (tenant-config.ts), the
// accept-pages body (legal-pages.ts, with a small stand-in for its HTML check),
// and the opaque 404 for an acting-as platform user on the adoption.

const FE_REFUSED_IDENTITY_KEYS = [
  'commissionBps', 'currency', 'defaultCurrency', 'defaultLocale', 'features', 'payments',
  'platformTerms', 'published', 'returnAddress', 'sellerType', 'shopId', 'shopName', 'status',
  'stripeAccountId', 'supportEmail', 'tenantId', 'vatNumber', 'vatRate', 'vatRateBp', 'vatRegistered',
];
const FE_LEGAL_KEYS = ['angerratt', 'integritetspolicy', 'kopvillkor'];
// Not the Worker's check (content/html-refusal.ts): enough of it to show a refusal.
const FE_REFUSED_HTML = /<\s*(script|iframe|object|embed|form|style|svg)\b|\son[a-z]+\s*=|javascript:|(src|href)\s*=\s*["']?\s*data:/i;

const feShopId = (headers) => headers['x-shop-id'];

function feHeld(state, shopId) {
  state.fe ??= new Map();
  if (!state.fe.has(shopId)) state.fe.set(shopId, { settings: null, adoption: undefined });
  return state.fe.get(shopId);
}

function feSettings(state, shop, shopId) {
  return structuredClone(feHeld(state, shopId).settings ?? shop.settings);
}

function feAdoption(state, shop, shopId) {
  const held = feHeld(state, shopId).adoption;
  return held !== undefined ? held : (shop.legal?.pages ?? null);
}

function feText(value, max) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || value.length > max) return { ok: false };
  const trimmed = value.trim();
  return { ok: true, value: trimmed === '' ? null : trimmed };
}

const SETTINGS_LEGAL_ROUTES = [
  ['GET', '/v1/admin/settings', (state, { shop, headers }) => json(200, { settings: feSettings(state, shop, feShopId(headers)) })],
  ['PUT', '/v1/admin/settings', (state, { shop, headers, body }) => {
    const allowed = ['returnAddress', 'sellerType', 'storeIdentity', 'vatNumber', 'vatRegistered'];
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((k) => !allowed.includes(k))) return invalid();
    const next = feSettings(state, shop, feShopId(headers));
    if (Object.hasOwn(body, 'storeIdentity')) {
      const identity = body.storeIdentity;
      if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return invalid();
      const refused = FE_REFUSED_IDENTITY_KEYS.filter((k) => Object.hasOwn(identity, k));
      if (identity.legal && typeof identity.legal === 'object' && Object.hasOwn(identity.legal, 'acceptance')) refused.push('legal.acceptance');
      if (refused.length > 0) {
        return json(400, { error: { code: 'refused_store_identity_keys', keys: refused, message: 'The store identity carries keys this route does not accept' } });
      }
      if (Buffer.byteLength(JSON.stringify(identity)) > 65_536) return invalid();
      next.storeIdentity = identity;
    }
    for (const [key, max] of [['returnAddress', 1000], ['vatNumber', 64]]) {
      if (!Object.hasOwn(body, key)) continue;
      const parsed = feText(body[key], max);
      if (!parsed.ok) return invalid();
      next[key] = parsed.value;
    }
    if (Object.hasOwn(body, 'vatRegistered')) {
      if (body.vatRegistered !== null && typeof body.vatRegistered !== 'boolean') return invalid();
      next.vatRegistered = body.vatRegistered;
    }
    if (Object.hasOwn(body, 'sellerType')) {
      const v = body.sellerType;
      if (v !== null && v !== '' && v !== 'company' && v !== 'individual') return invalid();
      next.sellerType = v === '' ? null : v;
    }
    next.updatedAt = new Date().toISOString();
    feHeld(state, feShopId(headers)).settings = next;
    return json(200, { settings: structuredClone(next) });
  }],
  ['GET', '/v1/admin/legal/status', (state, { shop, headers }) => {
    const shopId = feShopId(headers);
    const settings = feSettings(state, shop, shopId);
    const terms = shop.legal?.terms ?? {};
    const returnAddress = String(settings.returnAddress ?? '').trim().length > 0;
    const vatAnswered = typeof settings.vatRegistered === 'boolean';
    const legalPagesAccepted = feAdoption(state, shop, shopId) !== null;
    return json(200, {
      accepted: terms.accepted === true,
      acceptedAt: terms.accepted === true ? '2026-10-01T09:00:00.000Z' : null,
      acceptedVersion: terms.accepted === true ? (terms.currentVersion ?? null) : null,
      currentVersion: terms.currentVersion ?? null,
      graceDeadline: null,
      inGrace: terms.inGrace === true,
      readiness: { legalPagesAccepted, ready: returnAddress && vatAnswered && legalPagesAccepted, returnAddress, vatAnswered },
    });
  }],
  ['GET', '/v1/admin/legal/pages', (state, { shop, headers }) =>
    json(200, { acceptance: structuredClone(feAdoption(state, shop, feShopId(headers))) })],
  ['POST', '/v1/admin/legal/accept-pages', (state, { shop, headers, body, entry }) => {
    // Only the shop's own admin adopts: an acting-as platform user gets the opaque 404.
    if (entry.platform === true) return notFound();
    if (!body || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'custom,pod,templateVersion,texts') return invalid();
    const { custom, pod, templateVersion, texts } = body;
    if (typeof pod !== 'boolean' || typeof templateVersion !== 'string' || !/^[0-9A-Za-z._-]{1,32}$/.test(templateVersion)) return invalid();
    const customMap = custom && typeof custom === 'object' ? custom : null;
    if (typeof custom !== 'boolean' && !(customMap && Object.keys(customMap).sort().join(',') === FE_LEGAL_KEYS.join(',')
      && FE_LEGAL_KEYS.every((k) => typeof customMap[k] === 'boolean'))) return invalid();
    if (!texts || typeof texts !== 'object' || Object.keys(texts).sort().join(',') !== FE_LEGAL_KEYS.join(',')) return invalid();
    if (!FE_LEGAL_KEYS.every((k) => typeof texts[k] === 'string' && texts[k].length > 0 && !FE_REFUSED_HTML.test(texts[k]))) return invalid();
    const pageSha256 = Object.fromEntries(FE_LEGAL_KEYS.map((k) => [k, createHash('sha256').update(texts[k], 'utf8').digest('hex')]));
    const acceptance = {
      acceptanceId: randomBytes(8).toString('hex'),
      acceptedAt: new Date().toISOString(),
      custom: customMap ? FE_LEGAL_KEYS.some((k) => customMap[k]) : custom,
      customPages: customMap,
      pageSha256,
      pod,
      source: 'worker',
      templateVersion,
      textsSha256: createHash('sha256').update(JSON.stringify(texts), 'utf8').digest('hex'),
      version: null,
    };
    feHeld(state, feShopId(headers)).adoption = acceptance;
    const { pageSha256: _p, source: _s, version: _v, ...answer } = acceptance;
    return json(201, { acceptance: answer });
  }],
];

const ADMIN_ROUTES = [
  // Unit FB: the terms rows first; its status keeps the legal-pages readiness of the row below.
  ...shellAdminRoutes(SETTINGS_LEGAL_ROUTES.find(([m, p]) => m === 'GET' && p === '/v1/admin/legal/status')?.[2]),
  ...SETTINGS_LEGAL_ROUTES,
  ['GET', '/v1/admin/shop', (_state, { shop }) => json(200, { shop: structuredClone(shop.shop) })],
  ['GET', '/v1/admin/settings', (_state, { shop }) => json(200, { settings: structuredClone(shop.settings) })],
  ...CONNECT_ROUTES,
  ...ORDER_ROUTES,
  ...PRODUCT_ROUTES,
  ...CONTENT_ROUTES,
  ...MEMBER_ROUTES, // unit FH
  ...PREVIEW_ADMIN_ROUTES, // unit FI
];

// Unit FB adds the platform rows (tenants, acting-as) here.
const PLATFORM_ROUTES = [
  ...platformShopRoutes({ connectOf, rest: [...PLATFORM_REST_ROUTES, ...SHELL_PLATFORM_ROUTES] }), // unit FI: the shops, first
  ...PLATFORM_REST_ROUTES, // unit FJ: before the shells' stand-in for the reports badge
  ...SHELL_PLATFORM_ROUTES,
  ...PLATFORM_CONNECT_ROUTES,
  ...PRINTER_ROUTES, // unit FK
];

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
    // X-Shop-Id is refused with 400 before the session is read, as the API (CP5_WA_REPORT.md).
    if (headers['x-shop-id'] !== undefined) return invalid();
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
  const bytes = Buffer.concat(chunks);
  // An upload's bytes (PUT /v1/admin/objects/:id/content, unit FC) are not JSON.
  if (bytes.length > 0 && !/json/i.test(req.headers['content-type'] || '')) return { raw: bytes };
  const text = bytes.toString('utf8');
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
