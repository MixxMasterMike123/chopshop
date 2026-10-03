// The admin's API client — the one way an admin or platform page reaches the
// API (CP5 brief FA). Plain fetch, no SDK.
//
// Addresses (CP5 brief §0.2). The admin SPA calls its OWN origin; the admin
// Worker forwards to the API with the session cookie:
//   /_api/v1/admin/…      adminRequest()     always with X-Shop-Id
//   /_api/v1/platform/…   platformRequest()  never with X-Shop-Id (D70)
//   /_api/v1/me           getMeRaw()         the one route that answers 401
//   /_api/api/auth/…      authRequest()      Better Auth's sign-in, sign-out, reset
// Every request is `credentials: 'same-origin'`: the cookie is host-only on
// the admin host and never leaves it.
//
// The API answers 404 for everything it refuses on the admin surface (an
// expired session, a foreign shop and an unknown id look the same, gap
// analysis 0.6). So on a 404 from an admin or platform route the client reads
// `/v1/me` once: a 401 there means the session is gone, the listeners of
// onSessionLost() are told (the Session provider sends the user to /login),
// and the request fails with `unauthenticated`; otherwise the 404 stands.

const API_ROOT = '/_api';
const ADMIN_PREFIX = '/v1/admin/';
const PLATFORM_PREFIX = '/v1/platform/';
const AUTH_PREFIX = '/api/auth/';
const ME_PATH = '/v1/me';

/**
 * An answer of the API that is not a success, or no answer at all.
 * `status`: the HTTP status (0 when the request did not complete or was
 * refused before it was sent). `code`: the API's error code (`not_found`,
 * `invalid_request`, `rate_limited`, Better Auth's `INVALID_EMAIL_OR_PASSWORD`,
 * …) or one of this client's own: `network_error`, `bad_response`, `no_shop`,
 * `bad_request`, `unauthenticated`, `not_available`. `reason`: the API's
 * finer reason when it gives one (`error.reason`). `details`: the whole error
 * object of the body (e.g. `keys` of a refused identity).
 */
export class AdminApiError extends Error {
  constructor({ status, code, message, reason = null, details = null, retryAfterSeconds = null }) {
    super(message || code);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A function a page calls that has no route in this build (listed in the CP5-FA report). */
export function notAvailable(what) {
  return new AdminApiError({
    status: 0,
    code: 'not_available',
    message: `${what} finns inte i den här versionen av admin.`,
  });
}

// ── the active shop ─────────────────────────────────────────────────────────
// Set by the ActiveShop provider (src/admin-app/providers/ActiveShop.jsx)
// whenever the resolved shop changes. A page may also pass `shopId` itself.

let requestShopId = null;

/** The shop admin requests go to when the caller names none (null: none). */
export function getRequestShopId() {
  return requestShopId;
}

/** Called by the ActiveShop provider; `null` when no shop is active. */
export function setRequestShopId(shopId) {
  requestShopId = typeof shopId === 'string' && shopId !== '' ? shopId : null;
}

// ── the lost session ────────────────────────────────────────────────────────

const sessionLostListeners = new Set();

/** Subscribe to "the session is gone"; returns the unsubscribe function. */
export function onSessionLost(listener) {
  sessionLostListeners.add(listener);
  return () => sessionLostListeners.delete(listener);
}

function announceSessionLost() {
  for (const listener of sessionLostListeners) {
    try {
      listener();
    } catch (error) {
      console.warn('Session listener failed:', error?.message);
    }
  }
}

// ── the request ─────────────────────────────────────────────────────────────

function retryAfter(value) {
  const seconds = Number(value);
  return value !== null && value !== '' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * One path segment, percent-encoded (unreserved characters and escapes only:
 * `!'()*` are escaped as well).
 */
export function segment(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `path` plus the query of the defined, non-empty values in `params`. */
export function withQuery(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

function errorFromBody(status, parsed, data, headers) {
  // The API: { error: { code, message, reason?, … } }. Better Auth: { code, message }.
  const body = parsed && data && typeof data === 'object' ? data : null;
  const error = body && body.error && typeof body.error === 'object' ? body.error : body;
  return new AdminApiError({
    status,
    code: typeof error?.code === 'string' && error.code !== '' ? error.code : 'http_error',
    message: typeof error?.message === 'string' ? error.message : `HTTP ${status}`,
    reason: typeof error?.reason === 'string' ? error.reason : null,
    details: error && typeof error === 'object' ? error : null,
    retryAfterSeconds: retryAfter(headers.get('retry-after')),
  });
}

/**
 * Sends one request to `/_api<path>` and reads the answer. Resolves
 * `{ status, data, headers }` for a 2xx (data = the parsed JSON body, null when
 * empty); rejects with an AdminApiError, or with the AbortError of `signal`.
 *
 * `json`: a value sent as the JSON body. `body`: a raw body (a Blob or File for
 * an upload) with `contentType`. Not both.
 */
async function send(path, { method = 'GET', json, body, contentType, headers = {}, signal } = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...headers },
    signal,
  };
  if (json !== undefined && body !== undefined) {
    throw new AdminApiError({ status: 0, code: 'bad_request', message: 'Either json or body, not both' });
  }
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['content-type'] = 'application/json';
  } else if (body !== undefined) {
    init.body = body;
    if (contentType) init.headers['content-type'] = contentType;
  }

  let response;
  let text;
  try {
    response = await fetch(`${API_ROOT}${path}`, init);
    text = await response.text();
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
    throw new AdminApiError({ status: 0, code: 'network_error', message: 'Servern kunde inte nås' });
  }

  let data = null;
  let parsed = true;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      parsed = false;
    }
  }

  if (!response.ok) throw errorFromBody(response.status, parsed, data, response.headers);
  if (!parsed) {
    throw new AdminApiError({ status: response.status, code: 'bad_response', message: 'The answer was not JSON' });
  }
  return { status: response.status, data, headers: response.headers };
}

function refuse(message) {
  return new AdminApiError({ status: 0, code: 'bad_request', message });
}

// Concurrent 404s share one re-read of /v1/me.
let meCheck = null;

/** True when `/v1/me` says the session is gone (401). A failure to ask is not "gone". */
async function sessionIsGone() {
  if (meCheck === null) {
    meCheck = send(ME_PATH)
      .then(() => false)
      .catch((error) => error instanceof AdminApiError && error.status === 401)
      .finally(() => {
        meCheck = null;
      });
  }
  return meCheck;
}

async function withSessionCheck(path, init) {
  try {
    return await send(path, init);
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404 && (await sessionIsGone())) {
      announceSessionLost();
      throw new AdminApiError({
        status: 401,
        code: 'unauthenticated',
        message: 'Sessionen har gått ut. Logga in igen.',
      });
    }
    throw error;
  }
}

function requestInit(method, { json, body, contentType, idempotencyKey, signal }, headers = {}) {
  if (idempotencyKey !== undefined) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey === '') throw refuse('Idempotency-Key must be a non-empty string');
    headers['idempotency-key'] = idempotencyKey;
  }
  return { method, json, body, contentType, headers, signal };
}

/**
 * A request to `/v1/admin/…` for the active shop (or `options.shopId`).
 * Refuses, without sending anything, when no shop is known.
 *
 * options: { json, body, contentType, shopId, idempotencyKey, signal }
 */
export async function adminRequest(method, path, options = {}) {
  if (typeof path !== 'string' || !path.startsWith(ADMIN_PREFIX)) throw refuse('Not an admin path');
  const shopId = options.shopId ?? requestShopId;
  if (typeof shopId !== 'string' || shopId === '') {
    throw new AdminApiError({ status: 0, code: 'no_shop', message: 'Ingen butik är vald' });
  }
  return withSessionCheck(path, requestInit(method, options, { 'x-shop-id': shopId }));
}

/**
 * A request to `/v1/platform/…`. Never carries X-Shop-Id (D70: the Worker
 * refuses it there); naming a shop is a programming error.
 *
 * options: { json, body, contentType, idempotencyKey, signal }
 */
export async function platformRequest(method, path, options = {}) {
  if (typeof path !== 'string' || !path.startsWith(PLATFORM_PREFIX)) throw refuse('Not a platform path');
  if (options.shopId !== undefined) throw refuse('A platform request names no shop');
  return withSessionCheck(path, requestInit(method, options));
}

/** A request to Better Auth (`/api/auth/…`). No session check: a 4xx here is the answer. */
export async function authRequest(method, path, options = {}) {
  if (typeof path !== 'string' || !path.startsWith(AUTH_PREFIX)) throw refuse('Not an auth path');
  if (options.shopId !== undefined) throw refuse('An auth request names no shop');
  return send(path, requestInit(method, options));
}

/**
 * `GET /v1/me`: the signed-in user, or null when the answer is 401 (signed
 * out, deactivated, or an account the admin does not serve). Any other
 * failure rejects.
 */
export async function getMeRaw({ signal } = {}) {
  try {
    const { data } = await send(ME_PATH, { signal });
    return data && typeof data === 'object' ? data : null;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 401) return null;
    throw error;
  }
}
