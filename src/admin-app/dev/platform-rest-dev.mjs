// The dev API's rows for the platform console's add-ons, users, reports and
// screening queue (unit FJ), wired into dev-api.mjs. INVENTED data only
// (platform-rest-fixtures.json), the Worker's shapes and refusals:
//   features   cloudflare/src/routes/platform-tenants.ts, platform/tenant-config.ts
//   users      cloudflare/src/routes/platform-users.ts, platform/user-directory.ts
//   reports    cloudflare/src/routes/platform-reports.ts, catalog/infringement-reports.ts
//   screening  cloudflare/src/routes/pod-platform.ts, catalog/screening.ts
// Changes are held in memory per server (state.fj), over the fixtures.
//
// Scenarios, by the cookie `admin_dev_fj` (in the browser console:
// document.cookie = 'admin_dev_fj=empty; path=/'; remove it with Max-Age=0):
//   empty      every list is empty
//   error      every read answers 500
//   noinvite   the invite route answers 503 email_unavailable
// This module also answers GET /v1/platform/reports for the shell's badge
// (newCount), in place of the shells' stand-in.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'platform-rest-fixtures.json');
const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });
const refused = (status, code, message) => json(status, { error: { code, message } });

const FEATURE_KEYS = ['abandonedCheckout', 'contentStudio', 'discountCodes', 'marketingMaterials', 'pod', 'productReviews'];
const OPT_IN = new Set(['contentStudio', 'marketingMaterials', 'pod']);
const ACCOUNT_TYPES = ['ordinary', 'platform_admin', 'print_operator', 'tenant_admin'];
const REPORT_STATUSES = ['new', 'reviewing', 'rejected', 'taken_down'];
const SCREENING_STATUSES = ['advisory', 'approved', 'blocked', 'flagged', 'pending'];

function cookieOf(headers, name) {
  for (const part of (headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
const scenario = (headers) => cookieOf(headers, 'admin_dev_fj') || '';

function held(state) {
  if (!state.fj) {
    const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
    state.fj = {
      features: structuredClone(fixtures.features),
      users: structuredClone(fixtures.users),
      reports: structuredClone(fixtures.reports),
      screening: structuredClone(fixtures.screening),
    };
  }
  return state.fj;
}

const serverError = () => refused(500, 'internal_error', 'Something went wrong');

// ── add-ons ─────────────────────────────────────────────────────────────────

const featureViews = (fj, tenantId) =>
  FEATURE_KEYS.map((key) => {
    const explicit = fj.features[tenantId]?.[key];
    const defaultEnabled = !OPT_IN.has(key);
    return { defaultEnabled, enabled: explicit ?? defaultEnabled, key, source: explicit === undefined ? 'default' : 'explicit' };
  });

const FEATURES = /^\/v1\/platform\/tenants\/([a-z0-9][a-z0-9-]{0,63})\/features$/;

const FEATURE_ROUTES = [
  ['GET', FEATURES, (state, { segments, headers }) => {
    if (scenario(headers) === 'error') return serverError();
    if (!state.fixtures.shops[segments[0]]) return notFound();
    return json(200, { features: featureViews(held(state), segments[0]), tenantId: segments[0] });
  }],
  ['PUT', FEATURES, (state, { segments, body }) => {
    const shop = state.fixtures.shops[segments[0]];
    if (!shop) return notFound();
    const features = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).join() === 'features' ? body.features : null;
    const entries = features && typeof features === 'object' && !Array.isArray(features) ? Object.entries(features) : [];
    // At least one key, every key one the Worker allows, every value a boolean (D62).
    if (entries.length === 0 || entries.some(([k, v]) => !FEATURE_KEYS.includes(k) || typeof v !== 'boolean')) return invalid();
    if (shop.shop.status === 'closed') return refused(409, 'conflict', 'Request conflicts with the current tenant state');
    const fj = held(state);
    fj.features[segments[0]] = { ...(fj.features[segments[0]] ?? {}), ...Object.fromEntries(entries) };
    return json(200, { features: featureViews(fj, segments[0]), tenantId: segments[0] });
  }],
];

// ── users ───────────────────────────────────────────────────────────────────

const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const activeAdmins = (fj) => fj.users.filter((u) => u.accountType === 'platform_admin' && u.status === 'active');

const USER = /^\/v1\/platform\/users\/([A-Za-z0-9_-]{1,128})$/;
const USER_ACTION = /^\/v1\/platform\/users\/([A-Za-z0-9_-]{1,128})\/(deactivate|reactivate|invite)$/;

function usersAction(state, { segments, headers, entry }) {
  const [userId, action] = segments;
  const user = held(state).users.find((u) => u.userId === userId);
  if (!user) return notFound();
  const fj = held(state);
  if (action === 'invite') {
    if (scenario(headers) === 'noinvite') return refused(503, 'email_unavailable', 'The invite email could not be queued');
    if (user.status !== 'active' || !['platform_admin', 'tenant_admin'].includes(user.accountType)) {
      return refused(409, 'not_invitable', 'The identity cannot be invited');
    }
    const now = Date.now();
    user.invite = { createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 72 * 3600_000).toISOString(), status: 'issued' };
    return json(202, { invite: { userId, surface: user.accountType === 'platform_admin' ? 'platform' : 'admin', expiresAt: user.invite.expiresAt } });
  }
  if (action === 'deactivate') {
    if (userId === entry.user.id) return refused(409, 'cannot_deactivate_self', 'An operator cannot deactivate their own identity');
    if (user.status !== 'active') return refused(409, 'not_active', 'The identity is not active');
    if (user.accountType === 'platform_admin' && activeAdmins(fj).length <= 1) {
      return refused(409, 'last_platform_admin', 'At least one active platform admin must remain');
    }
    user.status = 'suspended';
    return json(200, { user: structuredClone(user) });
  }
  if (user.accountType === 'platform_admin') {
    return refused(409, 'platform_admin_reactivation', 'A platform admin cannot be reactivated over HTTP');
  }
  if (user.status !== 'suspended') return refused(409, 'not_suspended', 'The identity is not suspended');
  user.status = 'active';
  return json(200, { user: structuredClone(user) });
}

function usersList(state, { url, headers }) {
  if (scenario(headers) === 'error') return serverError();
  const params = url.searchParams;
  for (const key of params.keys()) if (!['accountType', 'cursor', 'limit', 'tenantId'].includes(key)) return invalid();
  const accountType = params.get('accountType');
  if (accountType !== null && !ACCOUNT_TYPES.includes(accountType)) return invalid();
  const limitRaw = params.get('limit');
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return invalid();
  const cursor = params.get('cursor');
  if (cursor !== null && !USER_ID.test(cursor)) return invalid();
  const tenantId = params.get('tenantId');
  let users = scenario(headers) === 'empty' ? [] : [...held(state).users].sort((a, b) => a.userId.localeCompare(b.userId));
  if (accountType) users = users.filter((u) => u.accountType === accountType);
  if (tenantId) users = users.filter((u) => u.memberships.some((m) => m.tenantId === tenantId));
  if (cursor) users = users.filter((u) => u.userId > cursor);
  const page = users.slice(0, limit);
  return json(200, { users: structuredClone(page), nextCursor: users.length > limit ? page.at(-1).userId : null });
}

const USER_ROUTES = [
  ['GET', '/v1/platform/users', usersList],
  ['GET', USER, (state, { segments }) => {
    const user = held(state).users.find((u) => u.userId === segments[0]);
    return user ? json(200, { user: structuredClone(user) }) : notFound();
  }],
  ['POST', USER_ACTION, usersAction],
];

// ── reports ─────────────────────────────────────────────────────────────────

const REPORT = /^\/v1\/platform\/reports\/([A-Za-z0-9_-]{1,128})$/;
const REPORT_ACTION = /^\/v1\/platform\/reports\/([A-Za-z0-9_-]{1,128})\/(handle|takedown)$/;
const NOTE_MAX = 1000;

const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.reportId.localeCompare(a.reportId);
const cursorOf = (r) => `${r.createdAt}~${r.reportId}`;

function reportsList(state, { url, headers }) {
  if (scenario(headers) === 'error') return serverError();
  const params = url.searchParams;
  for (const key of params.keys()) if (!['cursor', 'limit', 'status', 'tenantId'].includes(key)) return invalid();
  const status = params.get('status');
  if (status !== null && !REPORT_STATUSES.includes(status)) return invalid();
  const limitRaw = params.get('limit');
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!/^\d{1,3}$/.test(limitRaw ?? '50') || limit < 1 || limit > 100) return invalid();
  const all = scenario(headers) === 'empty' ? [] : held(state).reports;
  const newCount = all.filter((r) => r.status === 'new').length;
  let rows = [...all].sort(newestFirst);
  if (status) rows = rows.filter((r) => r.status === status);
  if (params.get('tenantId')) rows = rows.filter((r) => r.tenantId === params.get('tenantId'));
  const cursor = params.get('cursor');
  if (cursor) rows = rows.filter((r) => cursorOf(r) < cursor);
  const page = rows.slice(0, limit);
  return json(200, { reports: structuredClone(page), nextCursor: rows.length > limit ? cursorOf(page.at(-1)) : null, newCount });
}

const noteOf = (body) => {
  if (!Object.hasOwn(body, 'note')) return { ok: true, has: false };
  if (body.note === null) return { ok: true, has: true, value: null };
  if (typeof body.note !== 'string' || body.note.length > NOTE_MAX) return { ok: false };
  return { ok: true, has: true, value: body.note.trim() === '' ? null : body.note.trim() };
};

function stamp(report, entry) {
  report.handledAt = new Date().toISOString();
  report.handledBy = entry.user.id;
  report.version += 1;
}

function reportsAction(state, { segments, body, entry }) {
  const [reportId, action] = segments;
  const fj = held(state);
  const report = fj.reports.find((r) => r.reportId === reportId);
  if (!report) return notFound();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
  const note = noteOf(body);
  if (!note.ok) return invalid();
  const allowed = action === 'handle' ? ['status', 'note'] : ['note', 'productId'];
  if (!Object.keys(body).every((k) => allowed.includes(k))) return invalid();

  if (action === 'handle') {
    if (body.status !== 'reviewing' && body.status !== 'rejected') return invalid();
    const ok = (report.status === 'new' && ['reviewing', 'rejected'].includes(body.status))
      || (report.status === 'reviewing' && body.status === 'rejected')
      || (report.status === 'rejected' && body.status === 'reviewing');
    if (!ok) return refused(409, 'transition_refused', 'The report cannot move to that status');
    report.status = body.status;
    if (note.has) report.note = note.value;
    stamp(report, entry);
    return json(200, { report: structuredClone(report) });
  }

  if (!['new', 'reviewing'].includes(report.status)) return refused(409, 'report_closed', 'The report is already closed');
  if (Object.hasOwn(body, 'productId') && (typeof body.productId !== 'string' || body.productId === '')) return invalid();
  if (body.productId !== undefined && body.productId !== report.productId) {
    return refused(409, 'product_mismatch', 'The report is about another product');
  }
  report.status = 'taken_down';
  report.productTakenDown = true;
  if (note.has) report.note = note.value;
  stamp(report, entry);
  const screening = takeDown(fj, report);
  return json(200, { report: structuredClone(report), screening: structuredClone(screening) });
}

function takeDown(fj, report) {
  let row = fj.screening.find((s) => s.productId === report.productId);
  if (!row) {
    row = { productId: report.productId, tenantId: report.tenantId, productName: report.productName ?? '', hits: [], version: 0 };
    fj.screening.push(row);
  }
  Object.assign(row, { status: 'blocked', reason: 'takedown', takenDown: true, decidedAt: new Date().toISOString(), decidedBy: 'user-platform', version: row.version + 1 });
  return row;
}

const REPORT_ROUTES = [
  ['GET', '/v1/platform/reports', reportsList],
  ['GET', REPORT, (state, { segments }) => {
    const report = held(state).reports.find((r) => r.reportId === segments[0]);
    return report ? json(200, { report: structuredClone(report) }) : notFound();
  }],
  ['POST', REPORT_ACTION, reportsAction],
];

// ── the screening queue ─────────────────────────────────────────────────────

const SCREENING_ONE = /^\/v1\/platform\/screening\/([^/]{1,128})$/;

const SCREENING_ROUTES = [
  ['GET', '/v1/platform/screening', (state, { url, headers }) => {
    if (scenario(headers) === 'error') return serverError();
    const status = url.searchParams.get('status');
    if (status !== null && !SCREENING_STATUSES.includes(status)) return invalid();
    const wanted = status === null ? ['pending', 'flagged', 'blocked'] : [status];
    const rows = scenario(headers) === 'empty' ? [] : held(state).screening
      .filter((s) => wanted.includes(s.status))
      .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.productId.localeCompare(b.productId));
    return json(200, { screening: structuredClone(rows.slice(0, 100)) });
  }],
  ['POST', SCREENING_ONE, (state, { segments, body, entry }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'decision'
      || !['approved', 'blocked'].includes(body.decision)) return invalid();
    const row = held(state).screening.find((s) => s.productId === decodeURIComponent(segments[0]));
    if (!row) return notFound();
    Object.assign(row, {
      status: body.decision,
      reason: body.decision === 'approved' ? 'platform_approved' : 'takedown',
      takenDown: body.decision === 'blocked',
      decidedAt: new Date().toISOString(),
      decidedBy: entry.user.id,
      version: row.version + 1,
    });
    return json(200, { screening: structuredClone(row) });
  }],
];

/** The rows, in front of the shells' stand-in for GET /v1/platform/reports. */
export const PLATFORM_REST_ROUTES = [
  ...FEATURE_ROUTES,
  ...USER_ROUTES,
  ...REPORT_ROUTES,
  ...SCREENING_ROUTES,
];
