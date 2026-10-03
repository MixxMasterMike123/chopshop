/**
 * scripts/cf-port/migrate/lib/api-session.mjs — the staging API as the CP4
 * scripts (storage-copy.mjs, staging-legal.mjs) call it: the flow of
 * scripts/cf-port/seed-staging-slice.mjs, in one place.
 *
 *   stagingTarget({ env })   refuses anything but `staging`; the API origin is
 *                            cloudflare/pinned.staging.json origins.api (an
 *                            explicit CHOPSHOP_API_URL must equal it)
 *   platformCredentials()    CHOPSHOP_PLATFORM_EMAIL + CHOPSHOP_PLATFORM_PASSWORD,
 *                            the password falling back to PLATFORM_ADMIN_PASSWORD
 *                            of ~/.config/chopshop/secrets.staging.env
 *   createApiSession()       sign-in (Better Auth, POST /api/auth/sign-in/email),
 *                            acting-as (POST /v1/platform/tenants/:id/acting-as,
 *                            renewed before it runs out), and ONE request helper:
 *                            every request carries `Origin: <api origin>` (the
 *                            Worker's same-origin check), the session cookie,
 *                            and `X-Shop-Id` only when it is made in a shop's
 *                            context (a platform route refuses that header, D70);
 *                            a 429 waits for Retry-After and tries again.
 *
 * Nothing here prints a cookie, a password or a body. Errors carry a status and
 * a route, never a credential.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const DEFAULT_SECRETS_FILE = path.join(homedir(), '.config', 'chopshop', 'secrets.staging.env');

const ACTING_AS_RENEW_MS = 10 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RATE_LIMIT_WAITS = 5;
const MAX_RETRY_AFTER_S = 300;

export class RefusedError extends Error {}

/**
 * The one target these scripts may write to. `env` must be `staging`;
 * production is refused whatever else is set.
 */
export function stagingTarget({ env, environment = process.env, repoRoot = REPO_ROOT } = {}) {
  if (env === 'production') throw new RefusedError('production is refused: this step is staging-only');
  if (env !== 'staging') throw new RefusedError(`--env must be staging (got ${env === undefined ? 'nothing' : 'another value'})`);
  const pinned = JSON.parse(readFileSync(path.join(repoRoot, 'cloudflare', 'pinned.staging.json'), 'utf8'));
  const pinnedOrigin = new URL(pinned.origins.api).origin;
  const explicit = environment.CHOPSHOP_API_URL?.trim();
  if (explicit) {
    let url;
    try {
      url = new URL(explicit);
    } catch {
      throw new RefusedError('CHOPSHOP_API_URL is not a URL');
    }
    if (url.origin !== pinnedOrigin) {
      throw new RefusedError('CHOPSHOP_API_URL is not the pinned staging API origin');
    }
  }
  return { apiOrigin: pinnedOrigin, pinned };
}

/** KEY=VALUE lines (an optional `export `, optional quotes); comments and blanks ignored. */
export function parseEnvFile(text) {
  const values = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function readSecretsFile(secretsFile) {
  return existsSync(secretsFile) ? parseEnvFile(readFileSync(secretsFile, 'utf8')) : {};
}

/** A secret from the environment, else from the secrets file, else null. Never printed. */
export function secretValue(names, { environment = process.env, secretsFile = DEFAULT_SECRETS_FILE } = {}) {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  const file = readSecretsFile(environment.CHOPSHOP_SECRETS_FILE?.trim() || secretsFile);
  for (const name of names) {
    const value = file[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function platformCredentials({ environment = process.env, secretsFile = DEFAULT_SECRETS_FILE } = {}) {
  const email = secretValue(['CHOPSHOP_PLATFORM_EMAIL'], { environment, secretsFile });
  const password = secretValue(['CHOPSHOP_PLATFORM_PASSWORD', 'PLATFORM_ADMIN_PASSWORD'], { environment, secretsFile });
  if (email === null) throw new RefusedError('CHOPSHOP_PLATFORM_EMAIL is not set');
  if (password === null) {
    throw new RefusedError('no platform password: set CHOPSHOP_PLATFORM_PASSWORD or PLATFORM_ADMIN_PASSWORD in the secrets file');
  }
  return { email, password };
}

function cookiesOf(response) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  return list.map((cookie) => cookie.split(';', 1)[0]).filter((pair) => pair.includes('='));
}

function retryAfterSeconds(response) {
  const raw = response.headers.get('retry-after');
  const seconds = raw !== null && /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : 1;
  return Math.min(Math.max(seconds, 1), MAX_RETRY_AFTER_S);
}

/**
 * One session against the API. `fetchImpl` and `sleep` are injectable for the
 * tests (a fake API on 127.0.0.1).
 */
export function createApiSession({
  apiOrigin,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let cookie = null;
  // tenantId → expiresAt (ms). A plain object: test/no-write-calls.test.mjs
  // forbids write-shaped method calls (set, delete) in lib/.
  const grants = Object.create(null);
  const stats = { rateLimitWaits: 0, requests: 0 };

  /**
   * method, route (a path starting with /), options:
   *   json      a body sent as JSON
   *   bytes     a Buffer/Uint8Array body (fetch sends its Content-Length)
   *   shop      a tenant id: sent as X-Shop-Id (a request in that shop's context)
   *   cookie    another session's cookie instead of this one's
   *   anonymous true: no cookie at all
   *   headers   extra headers
   *   timeoutMs per request
   * → { status, json, text, headers }. A timeout throws an Error with
   *   `code === 'timeout'`; a network failure throws with `code === 'network'`.
   */
  async function request(method, route, options = {}) {
    if (typeof route !== 'string' || !route.startsWith('/')) throw new TypeError('route must start with /');
    const headers = { origin: apiOrigin, ...(options.headers ?? {}) };
    const sessionCookie = options.cookie ?? cookie;
    if (options.anonymous !== true && sessionCookie) headers.cookie = sessionCookie;
    if (options.shop !== undefined) headers['x-shop-id'] = options.shop;
    let body;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.bytes !== undefined) {
      body = options.bytes;
    }

    for (let wait = 0; ; wait += 1) {
      stats.requests += 1;
      let response;
      try {
        response = await fetchImpl(`${apiOrigin}${route}`, {
          body,
          headers,
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? timeoutMs),
        });
      } catch (error) {
        const failure = new Error(`${method} ${route.split('?')[0]}: ${error?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
        failure.code = error?.name === 'TimeoutError' ? 'timeout' : 'network';
        throw failure;
      }
      if (response.status === 429 && wait < MAX_RATE_LIMIT_WAITS) {
        stats.rateLimitWaits += 1;
        await response.arrayBuffer().catch(() => undefined);
        await sleep(retryAfterSeconds(response) * 1_000);
        continue;
      }
      const text = await response.text();
      let json = null;
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { headers: response.headers, json, status: response.status, text };
    }
  }

  /** Better Auth sign-in; answers the user id. The cookie stays in this session. */
  async function signIn({ email, password }) {
    const result = await signInAs({ email, password });
    cookie = result.cookie;
    return { userId: result.userId };
  }

  /** A sign-in whose cookie is handed back instead of kept (a second identity). */
  async function signInAs({ email, password }) {
    let response;
    // The sign-in has a rate limit of its own: a 429 waits, as `request` does.
    for (let wait = 0; ; wait += 1) {
      stats.requests += 1;
      try {
        response = await fetchImpl(`${apiOrigin}/api/auth/sign-in/email`, {
          body: JSON.stringify({ email, password }),
          headers: { 'content-type': 'application/json', origin: apiOrigin },
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new RefusedError(`sign-in: ${error?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
      }
      if (response.status !== 429 || wait >= MAX_RATE_LIMIT_WAITS) break;
      stats.rateLimitWaits += 1;
      await response.arrayBuffer().catch(() => undefined);
      await sleep(retryAfterSeconds(response) * 1_000);
    }
    if (response.status !== 200) {
      await response.arrayBuffer().catch(() => undefined);
      throw new RefusedError(`sign-in failed: HTTP ${response.status}`);
    }
    const pairs = cookiesOf(response);
    let userId = null;
    try {
      userId = (await response.json())?.user?.id ?? null;
    } catch {
      userId = null;
    }
    if (pairs.length === 0) throw new RefusedError('sign-in set no session cookie');
    return { cookie: pairs.join('; '), userId };
  }

  /**
   * Opens `tenantId` for the platform user (1 h, fixed by the Worker), or keeps
   * the open grant while more than 10 minutes of it are left. The reason is
   * written on the grant and its audit row. No X-Shop-Id: this is a platform
   * request.
   */
  async function ensureActingAs(tenantId, reason) {
    const expiresAt = grants[tenantId];
    if (expiresAt !== undefined && expiresAt - now() > ACTING_AS_RENEW_MS) return { renewed: false };
    const granted = await request('POST', `/v1/platform/tenants/${encodeURIComponent(tenantId)}/acting-as`, {
      json: { reason },
    });
    if (granted.status !== 201) {
      throw new RefusedError(`acting-as ${tenantId}: HTTP ${granted.status}`);
    }
    const parsed = Date.parse(granted.json?.expiresAt ?? '');
    grants[tenantId] = Number.isNaN(parsed) ? now() + ACTING_AS_RENEW_MS : parsed;
    return { renewed: true };
  }

  /** Forgets the grant so the next ensureActingAs mints a new one. */
  function dropActingAs(tenantId) {
    delete grants[tenantId];
  }

  /** Ends the platform user's grants in `tenantId` (204, or 404 when none was live). */
  async function endActingAs(tenantId) {
    delete grants[tenantId];
    const ended = await request('DELETE', `/v1/platform/tenants/${encodeURIComponent(tenantId)}/acting-as`);
    return ended.status;
  }

  return { dropActingAs, endActingAs, ensureActingAs, request, signIn, signInAs, stats };
}

/**
 * /health must say staging and /ready must be on `requiredMigration` or later
 * (a 4-digit prefix). Throws RefusedError otherwise.
 */
export async function preflight(session, { requiredMigration }) {
  const health = await session.request('GET', '/health', { anonymous: true });
  if (health.status !== 200 || health.json?.environment !== 'staging') {
    throw new RefusedError(`/health does not say staging (HTTP ${health.status})`);
  }
  const ready = await session.request('GET', '/ready', { anonymous: true });
  const migration = ready.status === 200 ? String(ready.json?.migration ?? '') : '';
  if (!/^\d{4}_/.test(migration) || migration.slice(0, 4) < requiredMigration) {
    throw new RefusedError(`/ready is not on migration ${requiredMigration} or later (HTTP ${ready.status})`);
  }
  return { migration };
}
