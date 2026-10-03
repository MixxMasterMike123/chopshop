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
//
// The preview of an unpublished shop (D57). The shop's admin opens the
// storefront at `<root>/#preview=<grant>`: the grant rides in the address's
// FRAGMENT, which the browser never sends to a server nor puts in a Referer.
// The client takes it out of the address bar, keeps it for this tab
// (sessionStorage; in memory when storage is refused) together with the root
// it was opened under, and sends it as `X-Storefront-Preview` on every READ
// of that shop, bypassing the HTTP cache (`cache: 'no-store'`), until it
// expires. Writes never carry it: a preview never sells.

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

// ── the preview grant ───────────────────────────────────────────────────────

/** The header the API reads the grant from (cloudflare/src/storefront/preview.ts). */
export const PREVIEW_HEADER = 'X-Storefront-Preview';
const PREVIEW_STORAGE_KEY = 'storefront-preview';
// v1.<expiry, 13-digit milliseconds>.<signature, 43 base64url characters>
const PREVIEW_GRANT = /^v1\.([1-9][0-9]{12})\.[A-Za-z0-9_-]{43}$/;
const READ_METHODS = new Set(['GET', 'HEAD']);

let previewMemory = null; // when sessionStorage throws (private mode, blocked storage)

function storePreview(value) {
  previewMemory = value;
  try {
    if (value === null) globalThis.sessionStorage?.removeItem(PREVIEW_STORAGE_KEY);
    else globalThis.sessionStorage?.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // The memory copy stands in for this page's life.
  }
}

function storedPreview() {
  try {
    const text = globalThis.sessionStorage?.getItem(PREVIEW_STORAGE_KEY);
    if (typeof text === 'string') return JSON.parse(text);
  } catch {
    // Unreadable or malformed: the memory copy, if any.
  }
  return previewMemory;
}

/**
 * Takes `#preview=<grant>` out of the address, if it is there, and keeps it
 * for this tab under the current root. Other fragment parameters stay. A
 * malformed value is dropped from the address and not kept.
 */
export function capturePreviewGrant() {
  const location = globalThis.location;
  const hash = typeof location?.hash === 'string' ? location.hash : '';
  if (!hash.startsWith('#')) return;
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has('preview')) return;
  const grant = params.get('preview');
  params.delete('preview');
  const rest = params.toString();
  try {
    globalThis.history?.replaceState(
      globalThis.history.state,
      '',
      `${location.pathname}${location.search ?? ''}${rest ? `#${rest}` : ''}`,
    );
  } catch {
    // An address that cannot be rewritten keeps its fragment; the grant still works.
  }
  const root = storefrontRoot();
  if (root !== null && typeof grant === 'string' && PREVIEW_GRANT.test(grant)) {
    storePreview({ grant, root });
  }
}

/**
 * The grant this tab holds for the current shop, or null: none, another
 * shop's, or expired (an expired one is forgotten).
 */
export function previewGrant(now = Date.now()) {
  capturePreviewGrant();
  const held = storedPreview();
  if (!held || typeof held.grant !== 'string') return null;
  const match = PREVIEW_GRANT.exec(held.grant);
  if (!match || Number(match[1]) <= now) {
    storePreview(null);
    return null;
  }
  return held.root === storefrontRoot() ? held.grant : null;
}

/** Ends the preview in this tab. */
export function clearPreviewGrant() {
  storePreview(null);
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
  const grant = READ_METHODS.has(method) ? previewGrant() : null;
  if (grant !== null) {
    init.headers[PREVIEW_HEADER] = grant;
    // A preview's answer is never cached, and never answered from the cache.
    init.cache = 'no-store';
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }

  const url = `${apiBase()}${path}`;
  // The body is read inside the same handler: a connection that fails after
  // the headers arrived is a network error like any other.
  let response;
  let text;
  try {
    response = await fetch(url, init);
    text = await response.text();
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
    throw new ApiError({ status: 0, code: 'network_error', message: 'The shop could not be reached' });
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
