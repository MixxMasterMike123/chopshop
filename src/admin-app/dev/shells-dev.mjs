// The dev API's rows for the shells and acting-as (unit FB), wired into
// dev-api.mjs. INVENTED data only, as the rest of the dev API.
//
// Acting-as (POST/DELETE /v1/platform/tenants/:id/acting-as): the grants live
// in memory per server (state.grants), beside the fixtures' static ones, and
// `/v1/me` lists both. Their length is the API's 60 minutes, or
// ADMIN_DEV_ACTING_AS_TTL_MS (e.g. 90000) to watch one run out.
//
// The platform's terms (GET /v1/admin/legal/status, /terms, POST
// /accept-terms): the text is the bundled templates' (src/config/
// platformTerms.js) in the archived format { version, terms, dpa }. Each shop
// starts from its fixture (`legal.terms.accepted`) or from the scenario of the
// cookie `admin_dev_terms` (in the browser console:
// document.cookie = 'admin_dev_terms=unaccepted; path=/'):
//   unaccepted   the current version is not accepted (the gate shows)
//   stale        an older version was accepted (the gate shows, "uppdaterats")
//   notext       a newer version is current and no text is archived for it
// A changed cookie starts the shop over. An acting-as platform user may read
// the status but not accept (the opaque 404, as the Worker).

import { createHash } from 'node:crypto';
import {
  PLATFORM_DPA_TEMPLATE,
  PLATFORM_TERMS_TEMPLATE,
  PLATFORM_TERMS_VERSION,
} from '../../config/platformTerms.js';

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });

const TTL_MS = 60 * 60 * 1000;
const REASON_MAX = 500;
const TERMS_COOKIE = 'admin_dev_terms';
const OLDER_VERSION = '2026-01-01';
const NEWER_VERSION = '2026-12-01';

function cookieOf(headers, name) {
  for (const part of (headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function ttl() {
  const n = Number(process.env.ADMIN_DEV_ACTING_AS_TTL_MS);
  return Number.isInteger(n) && n >= 10_000 && n <= TTL_MS ? n : TTL_MS;
}

// ── acting-as ───────────────────────────────────────────────────────────────

/** The grants this server opened for `entry` (live or not; meOf filters). */
export function heldGrants(state, entry) {
  return state.grants?.get(entry.user.id) ?? [];
}

const ACTING_AS = /^\/v1\/platform\/tenants\/([a-z0-9-]{1,63})\/acting-as$/;

export const SHELL_PLATFORM_ROUTES = [
  ['POST', ACTING_AS, (state, { entry, segments, body }) => {
    const record = state.fixtures.shops[segments[0]];
    if (!record || record.shop.status !== 'active') return notFound();
    if (body !== null) {
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
      if (!keys || keys.some((k) => k !== 'reason')) return invalid();
      if (body.reason !== undefined) {
        const r = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (r.length < 1 || r.length > REASON_MAX) return invalid();
      }
    }
    state.grants ??= new Map();
    const now = Date.now();
    const expiresAt = new Date(now + ttl()).toISOString();
    const live = heldGrants(state, entry).filter((g) => Date.parse(g.expiresAt) > now);
    state.grants.set(entry.user.id, [...live, { tenantId: segments[0], expiresAt }]);
    return json(201, { expiresAt, tenantId: segments[0] });
  }],
  ['DELETE', ACTING_AS, (state, { entry, segments }) => {
    const now = Date.now();
    const held = heldGrants(state, entry);
    const ended = held.filter((g) => g.tenantId === segments[0] && Date.parse(g.expiresAt) > now);
    if (ended.length === 0) return notFound();
    state.grants.set(entry.user.id, held.filter((g) => !ended.includes(g)));
    return { status: 204, body: null };
  }],
  ['GET', '/v1/platform/tenants', (state) => json(200, {
    tenants: Object.values(state.fixtures.shops)
      .map(({ shop }) => ({
        tenantId: shop.tenantId,
        shopName: shop.shopName ?? null,
        status: shop.status,
        published: shop.published === true,
        domainCount: 0,
        domains: [],
      }))
      .sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
    nextCursor: null,
  })],
  ['GET', '/v1/platform/reports', (state) => json(200, {
    reports: [],
    nextCursor: null,
    newCount: Number.isInteger(state.fixtures.reportsNewCount) ? state.fixtures.reportsNewCount : 2,
  })],
];

// ── the platform's terms ────────────────────────────────────────────────────

const ARCHIVED_TEXT = JSON.stringify({
  version: PLATFORM_TERMS_VERSION,
  terms: PLATFORM_TERMS_TEMPLATE,
  dpa: PLATFORM_DPA_TEMPLATE,
});
const ARCHIVED_SHA = createHash('sha256').update(ARCHIVED_TEXT, 'utf8').digest('hex');

/** The shop's terms state in this server: { scenario, current, acceptances: [{version, acceptedAt}] }. */
function termsOf(state, shop, headers) {
  const tenantId = shop.shop.tenantId;
  const scenario = cookieOf(headers, TERMS_COOKIE) || 'fixture';
  state.terms ??= new Map();
  const held = state.terms.get(tenantId);
  if (held && held.scenario === scenario) return held;
  const fixtureAccepted = shop.legal?.terms?.accepted === true;
  const next = { scenario, current: PLATFORM_TERMS_VERSION, acceptances: [] };
  if (scenario === 'stale') next.acceptances.push({ version: OLDER_VERSION, acceptedAt: '2026-02-01T09:00:00.000Z' });
  else if (scenario === 'notext') {
    next.current = NEWER_VERSION;
    next.acceptances.push({ version: PLATFORM_TERMS_VERSION, acceptedAt: '2026-10-01T09:00:00.000Z' });
  } else if (scenario !== 'unaccepted' && fixtureAccepted) {
    next.acceptances.push({ version: PLATFORM_TERMS_VERSION, acceptedAt: '2026-10-01T09:00:00.000Z' });
  }
  state.terms.set(tenantId, next);
  return next;
}

function termsStatus(t) {
  const current = t.acceptances.find((a) => a.version === t.current) ?? null;
  const latest = t.acceptances.at(-1) ?? null;
  return {
    accepted: current !== null,
    acceptedAt: current?.acceptedAt ?? null,
    acceptedVersion: latest?.version ?? null,
    currentVersion: t.current,
    graceDeadline: current === null && latest ? '2026-12-15T00:00:00.000Z' : null,
    inGrace: current === null && latest !== null,
  };
}

/**
 * The admin rows. `readinessStatus` is the legal-pages unit's own status
 * handler: its `readiness` is kept, the terms keys are this state's.
 */
export function shellAdminRoutes(readinessStatus) {
  return [
    ['GET', '/v1/admin/legal/status', (state, ctx) => {
      const base = readinessStatus ? readinessStatus(state, ctx) : null;
      return json(200, { ...(base?.body ?? {}), ...termsStatus(termsOf(state, ctx.shop, ctx.headers)) });
    }],
    ['GET', '/v1/admin/legal/terms', (state, { shop, headers }) => {
      const t = termsOf(state, shop, headers);
      const archived = t.current === PLATFORM_TERMS_VERSION;
      return json(200, {
        version: t.current,
        sha256: archived ? ARCHIVED_SHA : '0'.repeat(64),
        publishedAt: archived ? '2026-09-07T00:00:00.000Z' : '2026-12-01T00:00:00.000Z',
        textArchived: archived,
        text: archived ? ARCHIVED_TEXT : null,
      });
    }],
    ['POST', '/v1/admin/legal/accept-terms', (state, { shop, headers, body, entry }) => {
      // The seller signs: an acting-as platform user gets the opaque 404.
      if (entry.platform === true) return notFound();
      if (!body || typeof body !== 'object' || Object.keys(body).join(',') !== 'termsVersion' || typeof body.termsVersion !== 'string') {
        return invalid();
      }
      const t = termsOf(state, shop, headers);
      if (body.termsVersion !== t.current) {
        return json(409, { error: { code: 'terms_version_not_current', message: 'Not the current version' }, currentVersion: t.current });
      }
      const already = t.acceptances.find((a) => a.version === t.current);
      if (already) return json(200, { acceptance: { termsVersion: already.version, acceptedAt: already.acceptedAt } });
      const acceptance = { version: t.current, acceptedAt: new Date().toISOString() };
      t.acceptances.push(acceptance);
      return json(201, { acceptance: { termsVersion: acceptance.version, acceptedAt: acceptance.acceptedAt } });
    }],
  ];
}
