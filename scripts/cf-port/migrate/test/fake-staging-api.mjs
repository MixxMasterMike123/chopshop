/**
 * scripts/cf-port/migrate/test/fake-staging-api.mjs — a fake of the staging
 * API on 127.0.0.1, for storage-copy.mjs and staging-legal.mjs. Each route
 * takes and answers what the Worker's code does (the file and function are
 * named on each route below), including the guards that decide whether a
 * request is seen at all:
 *
 *   - every state change must carry `Origin` = the API origin (same-origin,
 *     cloudflare/src/lib/same-origin.ts), else the opaque 404;
 *   - a PLATFORM route refuses a request that names a shop (`X-Shop-Id`, D70:
 *     request-authorization.ts, legal-platform.ts authorizePlatformLegal);
 *   - an ADMIN route needs `X-Shop-Id` and either an active admin membership
 *     or the platform user's live acting-as grant on that shop
 *     (authorizeTenantAdminRequest); the seller's own acceptances refuse an
 *     acting-as principal (legal-admin.ts maySignForSeller).
 *
 * Fault injection: `faults` is a list of { method, path (RegExp), status,
 * times, retryAfter?, afterEffect? } consumed in order; `afterEffect: true`
 * lets the route do its work and then answers the fault status (a lost answer).
 *
 * `environment` (default `staging`) is what /health answers: `production`
 * makes it the fake of a production API for the tools' production mode (CP7-T1).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadWorkerModule } from '../lib/copy-sources.mjs';

const PRODUCT_IMAGE_TYPES = ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'];
const PUBLIC_TYPES = {
  product_media: PRODUCT_IMAGE_TYPES,
  shop_branding: [...PRODUCT_IMAGE_TYPES, 'image/svg+xml', 'image/x-icon'],
};
const RESERVE_KEYS = ['contentType', 'fileName', 'kind', 'sha256', 'sizeBytes'];

function safeFileName(fileName) {
  if (fileName === undefined) return 'object';
  const cleaned = fileName.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 100);
  return cleaned.length > 0 ? cleaned : 'object';
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function startFakeStagingApi(options = {}) {
  const sniff = await loadWorkerModule('storage/image-sniff.ts');
  const htmlRefusal = await loadWorkerModule('content/html-refusal.ts');
  const state = {
    acceptances: [], // { tenantId, userId, texts, templateVersion, pod, custom }
    audit: [], // { action, tenantId, reason }
    faults: [...(options.faults ?? [])],
    grants: new Map(), // `${userId}\n${tenantId}` → expires (ms)
    log: [], // { method, path, shop, hasCookie, origin }
    memberships: new Set(), // `${userId}\n${tenantId}`
    migration: options.migration ?? '0042_fake',
    objects: new Map(), // objectId → { tenantId, kind, contentType, sha256, sizeBytes, status, objectKey, uploads }
    platformUser: { email: 'platform@example.com', id: 'platform-user', password: 'platform-password-1' },
    revokeGrantsAfterAdminRequests: options.revokeGrantsAfterAdminRequests ?? null,
    sessions: new Map(), // cookie value → userId
    tenants: new Map(), // id → { published, settings: { returnAddress, vatRegistered } }
    terms: options.terms ?? [], // { version, publishedAt, sha256, text }
    users: new Map(), // email → { id, password, accountType }
  };
  state.users.set(state.platformUser.email, { accountType: 'platform_admin', id: state.platformUser.id, password: state.platformUser.password });
  for (const [tenantId, tenant] of Object.entries(options.tenants ?? {})) {
    state.tenants.set(tenantId, {
      published: tenant.published ?? true,
      settings: { returnAddress: tenant.returnAddress ?? null, vatRegistered: tenant.vatRegistered ?? null },
    });
  }
  let adminRequests = 0;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://fake');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const method = req.method;
    const shop = req.headers['x-shop-id'] ?? null;
    const cookie = req.headers.cookie ?? null;
    const userId = cookie ? state.sessions.get(cookie) ?? null : null;
    state.log.push({ hasCookie: cookie !== null, method, origin: req.headers.origin ?? null, path: url.pathname, shop });

    const send = (status, json, headers = {}) => {
      const text = json === undefined ? '' : JSON.stringify(json);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(text);
    };
    const notFound = () => send(404, { error: { code: 'not_found', message: 'Route not found' } });
    const invalid = (reason) =>
      send(400, { error: { code: 'invalid_request', message: 'Request is not valid', ...(reason ? { reason } : {}) } });
    const sameOrigin = req.headers.origin === origin;
    const parseJson = () => {
      try {
        return JSON.parse(body.toString('utf8'));
      } catch {
        return undefined;
      }
    };

    const fault = state.faults.find((f) => f.method === method && f.path.test(url.pathname) && f.times > 0);
    let pendingFault = null;
    if (fault) {
      fault.times -= 1;
      if (fault.afterEffect) {
        pendingFault = fault;
      } else {
        send(fault.status, { error: { code: 'fault' } }, fault.retryAfter ? { 'retry-after': String(fault.retryAfter) } : {});
        return;
      }
    }
    const reply = (status, json) => (pendingFault ? send(pendingFault.status, { error: { code: 'fault' } }) : send(status, json));

    const isPlatform = userId === state.platformUser.id;
    const platformOk = (write) => isPlatform && shop === null && (!write || sameOrigin);
    const adminPrincipal = (write) => {
      if (userId === null || shop === null || !state.tenants.has(shop)) return null;
      if (write && !sameOrigin) return null;
      adminRequests += 1;
      if (state.revokeGrantsAfterAdminRequests !== null && adminRequests === state.revokeGrantsAfterAdminRequests) {
        state.grants.clear();
      }
      if (state.memberships.has(`${userId}\n${shop}`)) return { actingAs: false, tenantId: shop, userId };
      const expires = state.grants.get(`${userId}\n${shop}`);
      if (isPlatform && expires !== undefined && expires > Date.now()) return { actingAs: true, tenantId: shop, userId };
      return null;
    };

    // ── health (src/app.ts readinessResponse) ──
    if (url.pathname === '/health' && method === 'GET') return send(200, { environment: options.environment ?? 'staging', service: 'fake' });
    if (url.pathname === '/ready' && method === 'GET') return send(200, { database: 'ready', migration: state.migration, status: 'ok' });

    // ── Better Auth sign-in ──
    if (url.pathname === '/api/auth/sign-in/email' && method === 'POST') {
      const input = parseJson();
      const user = state.users.get(input?.email);
      if (!sameOrigin || !user || user.password !== input.password) return send(401, { message: 'invalid' });
      const token = `session=${randomUUID()}`;
      state.sessions.set(token, user.id);
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `${token}; Path=/; HttpOnly; Secure` });
      res.end(JSON.stringify({ user: { id: user.id } }));
      return;
    }

    // ── acting-as (src/routes/acting-as.ts) ──
    const actingAs = /^\/v1\/platform\/tenants\/([^/]+)\/acting-as$/.exec(url.pathname);
    if (actingAs) {
      if (!platformOk(true)) return notFound();
      const tenantId = decodeURIComponent(actingAs[1]);
      if (!state.tenants.has(tenantId)) return notFound();
      if (method === 'POST') {
        const input = body.length === 0 ? {} : parseJson();
        if (!input || Object.keys(input).some((key) => key !== 'reason')) return invalid();
        const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
        state.grants.set(`${userId}\n${tenantId}`, Date.parse(expiresAt));
        state.audit.push({ action: 'acting_as.granted', reason: input.reason ?? null, tenantId });
        return send(201, { expiresAt, tenantId });
      }
      if (method === 'DELETE') {
        const had = state.grants.delete(`${userId}\n${tenantId}`);
        return had ? send(204) : notFound();
      }
      return notFound();
    }

    // ── objects (src/app.ts handleAdminObjectRoute, src/storage/object-routes.ts) ──
    if (url.pathname === '/v1/admin/objects') {
      const principal = adminPrincipal(true);
      if (principal === null || method !== 'POST') return notFound();
      const input = parseJson();
      if (!input || Object.keys(input).some((key) => !RESERVE_KEYS.includes(key))) return invalid();
      const admitted = PUBLIC_TYPES[input.kind];
      if (
        !admitted ||
        !admitted.includes(input.contentType) ||
        !/^[0-9a-f]{64}$/.test(input.sha256 ?? '') ||
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes < 1 ||
        input.sizeBytes > (input.contentType === 'image/svg+xml' ? 512 * 1024 : 15 * 1024 * 1024)
      ) {
        return invalid();
      }
      const objectId = randomUUID();
      const objectKey = `shops/${principal.tenantId}/${input.kind}/${objectId}/v1/${safeFileName(input.fileName)}`;
      state.objects.set(objectId, {
        contentType: input.contentType,
        kind: input.kind,
        objectKey,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        status: 'pending',
        tenantId: principal.tenantId,
        uploads: 0,
      });
      state.audit.push({ action: 'object.reserve', reason: null, tenantId: principal.tenantId });
      return reply(201, { object: { objectId, objectKey } });
    }
    const objectRoute = /^\/v1\/admin\/objects\/([^/]+)(\/content)?$/.exec(url.pathname);
    if (objectRoute) {
      const write = method !== 'GET';
      const principal = adminPrincipal(write);
      if (principal === null) return notFound();
      const objectId = decodeURIComponent(objectRoute[1]);
      const object = state.objects.get(objectId);
      if (!object || object.tenantId !== principal.tenantId) return notFound();
      const view = () => ({
        contentType: object.contentType,
        height: null,
        immutable: false,
        kind: object.kind,
        objectId,
        sha256: object.sha256,
        sizeBytes: object.sizeBytes,
        status: object.status,
        url: object.status === 'active' ? `https://public.example.test/${object.objectKey}` : null,
        width: null,
      });
      if (!objectRoute[2]) {
        if (method !== 'GET') return notFound();
        return send(200, { object: view() });
      }
      if (method !== 'PUT') return notFound();
      if (object.status !== 'pending') return send(409, { error: { code: 'conflict' } });
      if (Number(req.headers['content-length']) !== object.sizeBytes) return invalid();
      if (object.contentType === 'image/svg+xml') {
        const checked = sniff.checkSvg(new Uint8Array(body));
        if (!checked.ok) return invalid(`svg_${checked.reason}`);
      } else if (sniff.sniffImageType(new Uint8Array(body.subarray(0, 65_536))) !== object.contentType) {
        return invalid('type_not_as_stated');
      }
      if (sha256Hex(body) !== object.sha256) return invalid('bytes_not_as_declared');
      object.status = 'active';
      object.uploads += 1;
      state.audit.push({ action: 'object.upload', reason: null, tenantId: principal.tenantId });
      return reply(200, { object: view() });
    }

    // ── platform terms (src/routes/legal-platform.ts) ──
    if (url.pathname === '/v1/platform/legal/terms-versions') {
      if (!platformOk(method !== 'GET') || method !== 'GET') return notFound();
      const now = new Date().toISOString();
      const published = state.terms.filter((t) => t.publishedAt <= now);
      const current = published.at(-1)?.version ?? null;
      return send(200, {
        versions: [...state.terms].reverse().map((t) => ({
          current: t.version === current,
          publishedAt: t.publishedAt,
          sha256: t.sha256,
          textArchived: t.text !== null,
          version: t.version,
        })),
      });
    }
    const termsText = /^\/v1\/platform\/legal\/terms-versions\/([^/]+)\/text$/.exec(url.pathname);
    if (termsText) {
      if (!platformOk(method === 'PUT') || method !== 'PUT') return notFound();
      const version = state.terms.find((t) => t.version === decodeURIComponent(termsText[1]));
      if (!version) return notFound();
      const input = parseJson();
      if (!input || Object.keys(input).join() !== 'text' || typeof input.text !== 'string') return invalid();
      const supplied = sha256Hex(Buffer.from(input.text, 'utf8'));
      if (supplied !== version.sha256) {
        return send(409, { error: { code: 'terms_text_hash_mismatch' }, expectedSha256: version.sha256, suppliedSha256: supplied });
      }
      const view = { publishedAt: version.publishedAt, sha256: version.sha256, textArchived: true, version: version.version };
      if (version.text !== null) return send(200, { version: view });
      version.text = input.text;
      state.audit.push({ action: 'legal.platform_terms.archive_text', reason: null, tenantId: null });
      return send(201, { version: view });
    }

    // ── platform users (src/app.ts handlePlatformUserRoute) ──
    if (url.pathname === '/v1/platform/users') {
      if (!isPlatform || !sameOrigin || method !== 'POST') return notFound();
      const input = parseJson();
      if (!input || input.accountType !== 'tenant_admin' || typeof input.password !== 'string' || input.password.length < 12) return invalid();
      if (state.users.has(input.email)) return send(409, { error: { code: 'conflict' } });
      const id = `user-${state.users.size}`;
      state.users.set(input.email, { accountType: 'tenant_admin', id, password: input.password });
      state.audit.push({ action: 'user.create', reason: null, tenantId: null });
      return send(201, { user: { id } });
    }

    // ── platform tenants (src/routes/platform-tenants.ts, src/app.ts admins) ──
    const tenantRoute = /^\/v1\/platform\/tenants\/([^/]+)(?:\/(publish|unpublish|admins))?$/.exec(url.pathname);
    if (tenantRoute) {
      const action = tenantRoute[2] ?? null;
      if (!platformOk(action !== null)) return notFound();
      const tenantId = decodeURIComponent(tenantRoute[1]);
      const tenant = state.tenants.get(tenantId);
      if (!tenant) return notFound();
      const detail = () => ({
        settings: { returnAddressSet: Boolean(tenant.settings.returnAddress), vatAnswered: tenant.settings.vatRegistered !== null },
        tenant: { published: tenant.published, status: 'active', tenantId },
      });
      if (action === null) return method === 'GET' ? send(200, detail()) : notFound();
      if (method !== 'POST') return notFound();
      if (action === 'admins') {
        const input = parseJson();
        const user = [...state.users.values()].find((u) => u.id === input?.userId);
        if (!user) return notFound();
        if (user.accountType !== 'tenant_admin') return send(409, { error: { code: 'conflict' } });
        state.memberships.add(`${user.id}\n${tenantId}`);
        state.audit.push({ action: 'tenant.admin.grant', reason: null, tenantId });
        return send(201, { membership: { role: 'admin', status: 'active', tenantId, userId: user.id } });
      }
      if (body.length > 0) return invalid();
      tenant.published = action === 'publish';
      state.audit.push({ action: `tenant.${action}`, reason: null, tenantId });
      return reply(200, detail());
    }

    // ── admin legal (src/routes/legal-admin.ts) and settings (src/routes/admin-settings.ts) ──
    if (url.pathname === '/v1/admin/legal/status') {
      const principal = adminPrincipal(false);
      if (principal === null || method !== 'GET') return notFound();
      const tenant = state.tenants.get(principal.tenantId);
      const returnAddress = (tenant.settings.returnAddress ?? '').trim().length > 0;
      const vatAnswered = tenant.settings.vatRegistered === true || tenant.settings.vatRegistered === false;
      const legalPagesAccepted = state.acceptances.some((a) => a.tenantId === principal.tenantId);
      return send(200, {
        accepted: false,
        acceptedAt: null,
        acceptedVersion: null,
        currentVersion: state.terms.at(-1)?.version ?? null,
        graceDeadline: null,
        inGrace: false,
        readiness: { legalPagesAccepted, ready: returnAddress && vatAnswered && legalPagesAccepted, returnAddress, vatAnswered },
      });
    }
    if (url.pathname === '/v1/admin/settings') {
      const principal = adminPrincipal(method === 'PUT');
      if (principal === null || (method !== 'PUT' && method !== 'GET')) return notFound();
      if (method === 'GET') return send(200, { settings: state.tenants.get(principal.tenantId).settings });
      const input = parseJson();
      const keys = input && typeof input === 'object' ? Object.keys(input) : [];
      if (keys.length === 0 || keys.some((key) => !['returnAddress', 'vatRegistered', 'vatNumber', 'sellerType', 'storeIdentity'].includes(key))) {
        return invalid();
      }
      const tenant = state.tenants.get(principal.tenantId);
      if ('returnAddress' in input) tenant.settings.returnAddress = input.returnAddress;
      if ('vatRegistered' in input) tenant.settings.vatRegistered = input.vatRegistered;
      state.audit.push({ action: 'settings.update', reason: principal.actingAs ? 'acting-as' : null, tenantId: principal.tenantId });
      return send(200, { settings: tenant.settings });
    }
    if (url.pathname === '/v1/admin/legal/accept-pages') {
      const principal = adminPrincipal(true);
      if (principal === null || principal.actingAs || method !== 'POST') return notFound();
      const input = parseJson();
      const keys = input && typeof input === 'object' ? Object.keys(input).sort().join(',') : '';
      if (keys !== 'custom,pod,templateVersion,texts') return invalid();
      const pages = input.texts ?? {};
      if (Object.keys(pages).sort().join(',') !== 'angerratt,integritetspolicy,kopvillkor') return invalid();
      if (!Object.values(pages).every((html) => typeof html === 'string' && html.length > 0 && htmlRefusal.checkHtml(html).ok)) {
        return invalid();
      }
      const acceptanceId = randomUUID();
      state.acceptances.push({ ...input, acceptanceId, tenantId: principal.tenantId, userId: principal.userId });
      state.audit.push({ action: 'legal.pages.accept', reason: null, tenantId: principal.tenantId });
      return send(201, {
        acceptance: {
          acceptanceId,
          acceptedAt: new Date().toISOString(),
          custom: false,
          customPages: null,
          pod: input.pod,
          templateVersion: input.templateVersion,
          textsSha256: 'f'.repeat(64),
        },
      });
    }

    return notFound();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
    origin,
    state,
  };
}

/** A fake source storage on 127.0.0.1: path → { status, body, type }. */
export async function startFakeSource(files) {
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
    const answer = typeof file === 'function' ? file(hits.get(key)) : file;
    res.writeHead(answer.status ?? 200, { 'content-type': answer.type ?? 'application/octet-stream' });
    res.end(answer.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }), hits, origin };
}

/**
 * A minimal export bundle: `collections` = { name: [{ id, data }] }, written
 * in the export's layout (a root manifest.json, per collection a manifest.json
 * and one part-00001.jsonl) — what lib/bundle-reader.mjs reads.
 */
export function writeTestBundle(dir, collections) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ collections: Object.keys(collections), schemaVersion: 1 }));
  for (const [name, docs] of Object.entries(collections)) {
    mkdirSync(path.join(dir, name), { recursive: true });
    const lines = docs.map((doc) => JSON.stringify({ createTime: null, data: doc.data, id: doc.id, path: `${name}/${doc.id}`, updateTime: null }));
    writeFileSync(path.join(dir, name, 'part-00001.jsonl'), lines.length > 0 ? `${lines.join('\n')}\n` : '');
    writeFileSync(path.join(dir, name, 'manifest.json'), JSON.stringify({ parts: [{ file: 'part-00001.jsonl' }] }));
  }
}
