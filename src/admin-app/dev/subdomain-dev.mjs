// The dev API's rows for the shop's platform address (CP14), wired into
// dev-api.mjs. INVENTED data only, in the Worker's shapes and with its
// refusals (cloudflare/src/tenancy/subdomain.ts, routes/admin-settings.ts,
// routes/platform-tenants.ts):
//   GET   /v1/admin/settings                     FE/FP's answer + `subdomain`
//   PATCH /v1/admin/settings { subdomainLabel }  alone in the body; any other
//                                                PATCH goes to FP's fenced write
//   GET   /v1/platform/tenants/:id/subdomain
//   PUT   /v1/platform/tenants/:id/subdomain { label }
// The base domain is flippinstuff.se (Mikael 2026-10-23). test-shop-a starts
// with its id as label, test-shop-b with none. Held in memory per server.

const BASE = 'flippinstuff.se';
const GRACE_MS = 90 * 24 * 60 * 60 * 1000;
const PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const RESERVED = new Set(['admin', 'api', 'cdn', 'dev', 'docs', 'ftp', 'help', 'imap', 'img', 'mail', 'mta',
  'ns1', 'ns2', 'pop', 'smtp', 'stg', 'staging', 'static', 'status', 'support', 'test', 'www']);
const PLATFORM_PATH = /^\/v1\/platform\/tenants\/([a-z0-9][a-z0-9-]{0,63})\/subdomain$/;

const json = (status, body) => ({ status, body });
const error = (status, code) => json(status, { error: { code, message: code } });
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function held(state) {
  state.subdomains ??= { labels: new Map([['test-shop-a', 'test-shop-a']]), retired: new Map() };
  return state.subdomains;
}

function viewOf(state, shopId) {
  const { labels, retired } = held(state);
  const label = labels.get(shopId) ?? null;
  const now = Date.now();
  const previous = [...retired.entries()]
    .filter(([, entry]) => entry.shopId === shopId && entry.until > now)
    .map(([hostname, entry]) => ({ hostname, redirectUntil: new Date(entry.until).toISOString() }));
  return { baseDomain: BASE, hostname: label === null ? null : `${label}.${BASE}`, label, previous };
}

function setLabel(state, shopId, label) {
  if (typeof label !== 'string' || label.length < 1 || label.length > 63 || !PATTERN.test(label) || label.startsWith('xn--')) {
    return error(400, 'subdomain_invalid');
  }
  if (RESERVED.has(label)) return error(400, 'subdomain_reserved');
  const { labels, retired } = held(state);
  const hostname = `${label}.${BASE}`;
  const holder = [...labels.entries()].find(([id, l]) => l === label && id !== shopId);
  const grace = retired.get(hostname);
  if (holder || (grace && grace.shopId !== shopId && grace.until > Date.now())) return error(409, 'subdomain_taken');
  const previous = labels.get(shopId) ?? null;
  if (previous !== null && previous !== label) retired.set(`${previous}.${BASE}`, { shopId, until: Date.now() + GRACE_MS });
  retired.delete(hostname);
  labels.set(shopId, label);
  return null;
}

/** The admin rows, over FP's read and fenced write (they stay the answer for everything else). */
export function subdomainAdminRoutes(readSettings, patchSettings) {
  return [
    ['GET', '/v1/admin/settings', (state, ctx) => {
      const answer = readSettings(state, ctx);
      return answer.status === 200
        ? { ...answer, body: { ...answer.body, subdomain: viewOf(state, ctx.headers['x-shop-id']) } }
        : answer;
    }],
    ['PATCH', '/v1/admin/settings', (state, ctx) => {
      const { body, headers } = ctx;
      if (!isObject(body) || !Object.hasOwn(body, 'subdomainLabel')) return patchSettings(state, ctx);
      if (Object.keys(body).length !== 1 || typeof body.subdomainLabel !== 'string') return error(400, 'invalid_request');
      const shopId = headers['x-shop-id'];
      return setLabel(state, shopId, body.subdomainLabel) ?? json(200, { subdomain: viewOf(state, shopId) });
    }],
  ];
}

export const SUBDOMAIN_PLATFORM_ROUTES = [
  ['GET', PLATFORM_PATH, (state, { segments: [tenantId] }) => json(200, { subdomain: viewOf(state, tenantId), tenantId })],
  ['PUT', PLATFORM_PATH, (state, { segments: [tenantId], body }) => {
    if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.label !== 'string') return error(400, 'invalid_request');
    return setLabel(state, tenantId, body.label) ?? json(200, { subdomain: viewOf(state, tenantId), tenantId });
  }],
];
