// The storefront's API client — the one way a storefront page reaches the API
// (CP4 brief E, D77). Plain fetch, no SDK.
//
// Addresses. The browser reaches the API through the web Worker at
//   <root-host>/_api/<shop>/v1/…   on the shared host (root = /<shop>)
//   <shop-domain>/_api/v1/…        on a shop's own domain (root = '')
// The web Worker writes `<meta name="storefront-root" content="…">` into every
// page it serves: a non-empty value means the shared host, an empty value a
// shop's own domain. Without the tag (the Vite dev server) the shared-host
// grammar applies. On the shared host the shop is re-read from the current
// path on every call, so a client-side move between shops never sends a
// request to the previous one.
//
// Requests carry no credentials (no cookie, no session: the storefront has
// none). Reads use the browser's HTTP cache: the API answers with an ETag and
// `Cache-Control: no-cache`, so the browser revalidates and a 304 comes back
// to this code as the cached 200. Errors arrive as one typed error.

import { NON_SHOP_FIRST_SEGMENTS } from '../config/tenancy.js';

const SHOP_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
// The web Worker's own top-level paths (cloudflare/web/src/shop-segment.ts).
const WORKER_RESERVED = new Set(['assets', 'images']);

/**
 * An answer of the API that is not a success, or no answer at all.
 * `status` is the HTTP status (0: the request did not complete), `code` the
 * API's error code (`not_found`, `invalid_request`, `rate_limited`, …) or one
 * of this client's own: `network_error`, `bad_response`, `no_shop`.
 */
export class ApiError extends Error {
  constructor({ status, code, message, retryAfterSeconds = null }) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The shop id when `segment` is one, else null. */
export function parseShopSegment(segment) {
  return typeof segment === 'string' &&
    SHOP_SEGMENT.test(segment) &&
    !NON_SHOP_FIRST_SEGMENTS.has(segment) &&
    !WORKER_RESERVED.has(segment)
    ? segment
    : null;
}

let ownDomain; // undefined until read once: the tag never changes in a page's life

function isOwnDomain() {
  if (ownDomain === undefined) {
    const tag = globalThis.document?.querySelector?.('meta[name="storefront-root"]');
    ownDomain = tag ? tag.getAttribute('content') === '' : false;
  }
  return ownDomain;
}

/**
 * The storefront's root for a path: '/<shop>' on the shared host, '' on a
 * shop's own domain, null when the path names no shop.
 */
export function storefrontRoot(pathname = globalThis.location?.pathname ?? '/') {
  if (isOwnDomain()) return '';
  const shop = parseShopSegment(pathname.split('/')[1]);
  return shop === null ? null : `/${shop}`;
}

function apiBase() {
  const root = storefrontRoot();
  if (root === null) {
    throw new ApiError({ status: 0, code: 'no_shop', message: 'This address names no shop' });
  }
  return `/_api${root}`;
}

/**
 * One path segment, percent-encoded so the web Worker's id rule takes it
 * (unreserved characters and escapes only: `!'()*` are escaped as well).
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

/**
 * An address the API returns inside a body is relative to the shop's root
 * (`/product/<handle>`); this puts the root in front. Null for anything that
 * is not such a path.
 */
export function shopHref(relative) {
  const root = storefrontRoot();
  if (root === null || typeof relative !== 'string' || !/^\/(?![/\\])/.test(relative)) return null;
  return `${root}${relative}`;
}

/**
 * A path the API names as its own (`/v1/storefront/pod-previews/…`, an image
 * the Worker serves), as the browser reaches it through `/_api`.
 */
export function apiUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/v1/')) return null;
  return `${apiBase()}${path}`;
}

function retryAfter(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Calls the API. Resolves `{ status, data }` for a 2xx answer (data = the
 * parsed JSON body, null when empty); rejects with an ApiError otherwise, or
 * with the AbortError of `signal`.
 */
export async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/v1/')) {
    throw new ApiError({ status: 0, code: 'bad_request', message: 'Not an API path' });
  }
  const init = {
    method,
    credentials: 'omit',
    headers: { accept: 'application/json', ...headers },
    signal,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }

  const url = `${apiBase()}${path}`;
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError({ status: 0, code: 'network_error', message: 'The shop could not be reached' });
  }

  const text = await response.text();
  let data = null;
  let parsed = true;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      parsed = false;
    }
  }

  if (!response.ok) {
    const error = parsed && data && typeof data === 'object' ? data.error : null;
    throw new ApiError({
      status: response.status,
      code: typeof error?.code === 'string' ? error.code : 'http_error',
      message: typeof error?.message === 'string' ? error.message : `HTTP ${response.status}`,
      retryAfterSeconds: retryAfter(response.headers.get('retry-after')),
    });
  }
  if (!parsed) {
    throw new ApiError({ status: response.status, code: 'bad_response', message: 'The answer was not JSON' });
  }
  return { status: response.status, data };
}

/** A read of one thing: its payload under `key`, or null when the API says 404. */
export async function readOne(path, key, options) {
  try {
    const { data } = await request(path, options);
    return data?.[key] ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
