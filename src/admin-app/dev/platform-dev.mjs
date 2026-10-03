// The dev API's rows for the platform console's shop pages (unit FI), wired
// into dev-api.mjs. INVENTED data only (platform-fixtures.json over the
// shared fixtures' shops), in the Worker's shapes and refusals:
//   directory, detail, PATCH, publish/unpublish   platform/tenant-directory.ts, routes/platform-tenants.ts
//   activate/suspend                               routes/platform-users.ts (409 tenant_closed)
//   create a shop, grant an admin                  app.ts handlePlatformTenantRoute, platform/provision-tenants.ts
//   create a user                                  app.ts handlePlatformUserRoute, platform/provision-users.ts
//   Connect enable/disable                         routes/connect-platform.ts (the Connect state is the
//                                                  payments rows' connectOf, so the seller's page agrees)
// Changes are held in memory per server (state.fi), over the fixtures.
//
// The shops this module creates exist only here: the other units' rows (the
// add-ons, the users, acting-as) read the shared fixtures, so for a created
// shop this module also answers its add-ons and its new admin's invite, and
// hands every other shop or user to the row it replaces (`rest`).
//
// Scenarios, by the cookie `admin_dev_fi` (in the browser console:
// document.cookie = 'admin_dev_fi=error; path=/'; remove it with Max-Age=0):
//   empty      the directory is empty
//   error      the directory and the detail answer 500
//   noinvite   the invite of a created admin answers 503 email_unavailable

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'platform-fixtures.json');
const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });
const conflict = (code = 'conflict', message = 'Request conflicts with the current tenant state') =>
  json(409, { error: { code, message } });
const serverError = () => json(500, { error: { code: 'internal_error', message: 'Something went wrong' } });

const TENANT_ID = /^[a-z0-9][a-z0-9-]*$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const FEATURE_KEYS = ['abandonedCheckout', 'contentStudio', 'discountCodes', 'marketingMaterials', 'pod', 'productReviews'];
const OPT_IN = new Set(['contentStudio', 'marketingMaterials', 'pod']);
/** D45: the commission cap (MAX_DEFAULT_COMMISSION_BPS). */
const COMMISSION_CAP_BPS = 800;

function cookieOf(headers, name) {
  for (const part of (headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
const scenario = (headers) => cookieOf(headers, 'admin_dev_fi') || '';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (body, keys) => isObject(body) && Object.keys(body).every((k) => keys.includes(k));

function held(state) {
  if (!state.fi) {
    const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
    state.fi = { platform: structuredClone(fixtures.shops), overrides: {}, created: {}, users: {} };
  }
  return state.fi;
}

/** Every shop this server knows: the shared fixtures' (with this module's changes) and the created ones. */
function shopsOf(state) {
  const fi = held(state);
  const out = {};
  for (const [id, { shop }] of Object.entries(state.fixtures.shops)) {
    const platform = fi.platform[id] ?? {};
    out[id] = {
      tenantId: id,
      shopName: shop.shopName ?? null,
      supportEmail: shop.supportEmail ?? null,
      status: shop.status,
      published: shop.published === true,
      vatRateBp: shop.vatRateBp ?? 2500,
      defaultLocale: shop.defaultLocale ?? 'sv-SE',
      defaultCurrency: shop.currency ?? 'SEK',
      commissionBps: platform.commissionBps ?? null,
      createdAt: platform.createdAt ?? '2026-01-01T09:00:00.000Z',
      domains: platform.domains ?? [],
      settings: platform.settings ?? { returnAddressSet: false, vatAnswered: false },
      legal: platform.legal ?? null,
      fixtureFeatures: shop.features ?? {},
      ...fi.overrides[id],
    };
  }
  for (const [id, created] of Object.entries(fi.created)) out[id] = created;
  return out;
}

function change(state, id, patch) {
  const fi = held(state);
  if (fi.created[id]) Object.assign(fi.created[id], patch);
  else fi.overrides[id] = { ...(fi.overrides[id] ?? {}), ...patch };
}

function featureViews(state, shop) {
  const explicit = held(state).created[shop.tenantId]
    ? shop.features ?? {}
    : { ...pick(shop.fixtureFeatures), ...(state.fj?.features?.[shop.tenantId] ?? {}) };
  return FEATURE_KEYS.map((key) => {
    const defaultEnabled = !OPT_IN.has(key);
    return { defaultEnabled, enabled: explicit[key] ?? defaultEnabled, key, source: explicit[key] === undefined ? 'default' : 'explicit' };
  });
}

function pick(features) {
  return Object.fromEntries(FEATURE_KEYS.filter((k) => typeof features?.[k] === 'boolean').map((k) => [k, features[k]]));
}

const TERMS_CURRENT = '2026-09-07';

/**
 * The detail's `legal` (platform/tenant-directory.ts, unit WJ): the checkout's own
 * gate (`checkoutOpen`), its readiness, the latest legal-pages adoption and the
 * platform terms with the latest acceptance. The platform sees the signer's person.
 */
function legalOf(shop) {
  const f = shop.legal ?? { terms: { acceptedCurrent: false, inGrace: false, latestAcceptance: null }, pagesAdoption: null };
  const readiness = {
    returnAddress: shop.settings.returnAddressSet === true,
    vatAnswered: shop.settings.vatAnswered === true,
    legalPagesAccepted: f.pagesAdoption !== null,
  };
  readiness.ready = readiness.returnAddress && readiness.vatAnswered && readiness.legalPagesAccepted;
  const gateOpen = f.terms.acceptedCurrent === true || f.terms.inGrace === true;
  return {
    checkoutOpen: gateOpen && readiness.ready,
    readiness,
    pagesAdoption: f.pagesAdoption ? structuredClone(f.pagesAdoption) : null,
    terms: {
      currentVersion: TERMS_CURRENT,
      acceptedCurrent: f.terms.acceptedCurrent === true,
      gateOpen,
      inGrace: f.terms.inGrace === true,
      graceDeadline: f.terms.inGrace === true ? '2026-12-15T00:00:00.000Z' : null,
      latestAcceptance: f.terms.latestAcceptance ? structuredClone(f.terms.latestAcceptance) : null,
    },
  };
}

function detailOf(state, shop, connectOf, headers) {
  const c = connectOf(state, shop.tenantId, headers);
  const now = new Date().toISOString();
  return {
    domains: shop.domains.map((d, i) => ({
      createdAt: shop.createdAt, domainId: `dev-domain-${shop.tenantId}-${i}`, hostname: d.hostname, kind: d.kind,
      status: d.status, updatedAt: shop.createdAt, verifiedAt: d.status === 'verified' ? shop.createdAt : null,
    })),
    domainsTruncated: false,
    features: featureViews(state, shop),
    legal: legalOf(shop),
    settings: { ...shop.settings },
    tenant: {
      catalogVersion: 1,
      commissionBps: shop.commissionBps,
      connect: {
        accountId: c.hasAccount ? 'acct_dev_invented' : null,
        chargesEnabled: c.chargesEnabled === true,
        detailsSubmitted: c.status === 'pending' || c.status === 'active',
        payoutsEnabled: c.chargesEnabled === true,
        syncedAt: c.hasAccount ? '2026-10-03T09:00:00.000Z' : null,
      },
      createdAt: shop.createdAt,
      defaultCurrency: shop.defaultCurrency,
      defaultLocale: shop.defaultLocale,
      published: shop.published,
      shopName: shop.shopName,
      status: shop.status,
      supportEmail: shop.supportEmail,
      tenantId: shop.tenantId,
      updatedAt: now,
      vatRateBp: shop.vatRateBp,
    },
  };
}

function listItem(shop) {
  return {
    domainCount: shop.domains.length,
    domains: shop.domains.slice(0, 20).map(({ hostname, kind, status }) => ({ hostname, kind, status })),
    published: shop.published,
    shopName: shop.shopName,
    status: shop.status,
    tenantId: shop.tenantId,
  };
}

/** The row of `rest` that answers `method` + the request's path, or null. */
function restHandler(rest, method, url) {
  const path = url.pathname.slice('/_api'.length);
  for (const [verb, pattern, handler] of rest) {
    if (verb !== method) continue;
    if (typeof pattern === 'string' ? pattern === path : pattern.test(path)) {
      const segments = typeof pattern === 'string' ? [] : pattern.exec(path).slice(1);
      return { handler, segments };
    }
  }
  return null;
}

function delegate(rest, method, state, ctx) {
  const hit = restHandler(rest, method, ctx.url);
  return hit ? hit.handler(state, { ...ctx, segments: hit.segments }) : notFound();
}

const TENANT = /^\/v1\/platform\/tenants\/([a-z0-9][a-z0-9-]{0,63})$/;
const TENANT_ACTION = /^\/v1\/platform\/tenants\/([a-z0-9][a-z0-9-]{0,63})\/(publish|unpublish|activate|suspend)$/;
const TENANT_CONNECT_ACTION = /^\/v1\/platform\/tenants\/([a-z0-9][a-z0-9-]{0,63})\/connect\/(enable|disable)$/;
const TENANT_FEATURES = /^\/v1\/platform\/tenants\/([a-z0-9][a-z0-9-]{0,63})\/features$/;
const TENANT_ADMINS = /^\/v1\/platform\/tenants\/([a-z0-9][a-z0-9-]{0,63})\/admins$/;
const USER_INVITE = /^\/v1\/platform\/users\/([A-Za-z0-9_-]{1,128})\/invite$/;

/**
 * The admin row this unit uses: the storefront preview grant (CP4-D2,
 * routes/admin-preview.ts). dev-api.mjs has already checked the shop (a
 * membership or an open acting-as grant, via X-Shop-Id).
 */
export const PREVIEW_ADMIN_ROUTES = [
  ['POST', '/v1/admin/preview', () => json(200, {
    preview: { grant: 'devpreviewgrant.invented', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
  })],
];

/**
 * The rows. `connectOf(state, tenantId, headers)` is the payments rows' Connect
 * state; `rest` the rows these replace for the shops and users not made here.
 */
export function platformShopRoutes({ connectOf, rest = [] }) {
  return [
    ['GET', '/v1/platform/tenants', (state, { url, headers }) => {
      if (scenario(headers) === 'error') return serverError();
      const params = url.searchParams;
      for (const key of params.keys()) if (!['cursor', 'limit', 'status'].includes(key)) return invalid();
      const limit = params.get('limit') === null ? 50 : Number(params.get('limit'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return invalid();
      const cursor = params.get('cursor');
      const status = params.get('status');
      let shops = scenario(headers) === 'empty' ? [] : Object.values(shopsOf(state));
      shops.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
      if (status) shops = shops.filter((s) => s.status === status);
      if (cursor) shops = shops.filter((s) => s.tenantId > cursor);
      const page = shops.slice(0, limit);
      return json(200, { tenants: page.map(listItem), nextCursor: shops.length > limit ? page.at(-1).tenantId : null });
    }],

    ['POST', '/v1/platform/tenants', (state, { body }) => {
      const keys = ['defaultCurrency', 'defaultLocale', 'hostname', 'shopName', 'tenantId'];
      if (!onlyKeys(body, keys)) return invalid();
      const { tenantId, shopName, hostname } = body;
      const host = typeof hostname === 'string' ? hostname.toLowerCase().replace(/\.$/, '') : '';
      if (typeof tenantId !== 'string' || tenantId.length > 64 || !TENANT_ID.test(tenantId)) return invalid();
      if (typeof shopName !== 'string' || shopName.length < 1 || shopName.length > 200) return invalid();
      if (!host || host.length > 253 || !host.split('.').every((l) => l.length <= 63 && HOST_LABEL.test(l))) return invalid();
      const shops = shopsOf(state);
      if (shops[tenantId] || Object.values(shops).some((s) => s.domains.some((d) => d.hostname === host))) return conflict();
      const now = new Date().toISOString();
      held(state).created[tenantId] = {
        tenantId, shopName, supportEmail: null, status: 'active', published: true, vatRateBp: 2500,
        defaultLocale: body.defaultLocale ?? 'sv-SE', defaultCurrency: body.defaultCurrency ?? 'SEK',
        commissionBps: null, createdAt: now, domains: [{ hostname: host, kind: 'storefront', status: 'verified' }],
        settings: { returnAddressSet: false, vatAnswered: false }, features: {}, fixtureFeatures: {},
      };
      return json(201, { tenant: { defaultCurrency: 'SEK', defaultLocale: 'sv-SE', shopName, status: 'active', tenantId } });
    }],

    ['GET', TENANT, (state, { segments, headers }) => {
      if (scenario(headers) === 'error') return serverError();
      const shop = shopsOf(state)[segments[0]];
      return shop ? json(200, detailOf(state, shop, connectOf, headers)) : notFound();
    }],

    ['PATCH', TENANT, (state, { segments, headers, body }) => {
      const shop = shopsOf(state)[segments[0]];
      if (!shop) return notFound();
      const keys = ['commissionBps', 'shopName', 'supportEmail', 'vatRateBp'];
      if (!onlyKeys(body, keys) || Object.keys(body).length === 0) return invalid();
      const patch = {};
      if (Object.hasOwn(body, 'commissionBps')) {
        const v = body.commissionBps;
        if (v !== null && !(Number.isSafeInteger(v) && v >= 0 && v <= COMMISSION_CAP_BPS)) return invalid();
        patch.commissionBps = v;
      }
      if (Object.hasOwn(body, 'shopName')) {
        const v = body.shopName;
        if (typeof v !== 'string' || v.length < 1 || v.length > 200 || v.trim() === '') return invalid();
        patch.shopName = v;
      }
      if (Object.hasOwn(body, 'supportEmail')) {
        const v = body.supportEmail;
        if (v !== null && (typeof v !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(v))) return invalid();
        patch.supportEmail = v === null ? null : v.toLowerCase();
      }
      if (Object.hasOwn(body, 'vatRateBp')) {
        const v = body.vatRateBp;
        if (!(Number.isSafeInteger(v) && v >= 0 && v <= 10000)) return invalid();
        patch.vatRateBp = v;
      }
      if (shop.status === 'closed') return conflict();
      change(state, shop.tenantId, patch);
      return json(200, detailOf(state, shopsOf(state)[shop.tenantId], connectOf, headers));
    }],

    ['POST', TENANT_ACTION, (state, { segments, headers }) => {
      const [id, action] = segments;
      const shop = shopsOf(state)[id];
      if (!shop) return notFound();
      if (shop.status === 'closed') {
        return action === 'activate' || action === 'suspend'
          ? conflict('tenant_closed', 'The tenant is closed')
          : conflict();
      }
      if (action === 'publish' || action === 'unpublish') {
        change(state, id, { published: action === 'publish' });
        return json(200, detailOf(state, shopsOf(state)[id], connectOf, headers));
      }
      const status = action === 'activate' ? 'active' : 'suspended';
      change(state, id, { status });
      const s = shopsOf(state)[id];
      return json(200, { tenant: { defaultCurrency: s.defaultCurrency, defaultLocale: s.defaultLocale, shopName: s.shopName, status, tenantId: id } });
    }],

    ['POST', TENANT_CONNECT_ACTION, (state, { segments, headers }) => {
      const [id, action] = segments;
      if (!shopsOf(state)[id]) return notFound();
      const c = connectOf(state, id, headers);
      c.enabled = action === 'enable';
      return json(200, { connect: { tenantId: id, enabled: c.enabled, chargesEnabled: c.chargesEnabled === true, accountId: c.hasAccount ? 'acct_dev_invented' : null } });
    }],

    ['GET', TENANT_FEATURES, (state, ctx) => {
      const shop = held(state).created[ctx.segments[0]];
      return shop ? json(200, { features: featureViews(state, shop), tenantId: shop.tenantId }) : delegate(rest, 'GET', state, ctx);
    }],
    ['PUT', TENANT_FEATURES, (state, ctx) => {
      const shop = held(state).created[ctx.segments[0]];
      if (!shop) return delegate(rest, 'PUT', state, ctx);
      const features = onlyKeys(ctx.body, ['features']) && isObject(ctx.body.features) ? ctx.body.features : null;
      const entries = features ? Object.entries(features) : [];
      if (entries.length === 0 || entries.some(([k, v]) => !FEATURE_KEYS.includes(k) || typeof v !== 'boolean')) return invalid();
      shop.features = { ...shop.features, ...features };
      return json(200, { features: featureViews(state, shop), tenantId: shop.tenantId });
    }],

    ['POST', '/v1/platform/users', (state, { body }) => {
      if (!onlyKeys(body, ['accountType', 'email', 'password'])) return invalid();
      const { accountType, email, password } = body;
      if (!['tenant_admin', 'print_operator'].includes(accountType)) return invalid();
      if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254) return invalid();
      // As the Worker (CP5-WJ4): no password = created password-less, for an invitable kind only.
      if (!('password' in body) ? accountType !== 'tenant_admin'
        : typeof password !== 'string' || password.length < 8 || password.length > 128) return invalid();
      const lower = email.toLowerCase();
      const fi = held(state);
      const taken = state.fixtures.users.some((u) => u.user.email === lower)
        || (state.fj?.users ?? []).some((u) => u.email === lower)
        || Object.values(fi.users).some((u) => u.email === lower);
      if (taken) return json(409, { error: { code: 'conflict', message: 'Request conflicts with an existing identity' } });
      const userId = `dev-user-${Object.keys(fi.users).length + 1}-${Date.now().toString(36)}`;
      fi.users[userId] = { userId, email: lower, accountType, memberships: [] };
      return json(201, { user: { accountType, email: lower, userId } });
    }],

    ['POST', TENANT_ADMINS, (state, { segments, body }) => {
      const shop = shopsOf(state)[segments[0]];
      if (!onlyKeys(body, ['userId']) || typeof body.userId !== 'string' || body.userId.length < 1) return invalid();
      const user = held(state).users[body.userId];
      if (!shop || shop.status !== 'active' || !user) return notFound();
      if (user.memberships.includes(shop.tenantId)) return conflict();
      user.memberships.push(shop.tenantId);
      return json(201, {
        membership: { membershipId: `dev-membership-${user.userId}-${shop.tenantId}`, role: 'admin', status: 'active', tenantId: shop.tenantId, userId: user.userId },
      });
    }],

    ['POST', USER_INVITE, (state, ctx) => {
      const user = held(state).users[ctx.segments[0]];
      if (!user) return delegate(rest, 'POST', state, ctx);
      if (scenario(ctx.headers) === 'noinvite') {
        return json(503, { error: { code: 'email_unavailable', message: 'The invite email could not be queued' } });
      }
      if (user.accountType !== 'tenant_admin') return conflict('not_invitable', 'The identity cannot be invited');
      const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString();
      return json(202, { invite: { userId: user.userId, surface: 'admin', expiresAt } });
    }],
  ];
}
