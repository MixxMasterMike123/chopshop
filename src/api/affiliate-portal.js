// The affiliate portal's API client (CP13, design §7.1, §7.3; the routes:
// cloudflare/src/routes/affiliate-portal.ts, CP13_A1_REPORT.md §4.2). The
// portal is a third tree of the ADMIN build (`/affiliate/*`); it calls its own
// origin and the admin Worker forwards `/_api/v1/affiliate/*` with the
// session cookie:
//
//   GET   /v1/affiliate/me                     → { affiliate: PortalMe }
//   GET   /v1/affiliate/orders?cursor&limit    → { orders, nextCursor }
//   GET   /v1/affiliate/ledger?cursor&limit    → { entries, nextCursor }
//   GET   /v1/affiliate/payouts?cursor&limit   → { payouts, nextCursor }
//   POST  /v1/affiliate/payouts { amountMinor?, invoiceObjectId?, invoiceNumber? } → 201 { payout }
//         409 payout_open | insufficient_balance | profile_incomplete | terms_required | invalid_invoice
//   GET   /v1/affiliate/payouts/:id/invoice    → the PDF (a download)
//   PATCH /v1/affiliate/profile { name?, phone?, addressLine1?, addressLine2?, postalCode?,
//                                 city?, country?, socials?, preferredLang? } → { affiliate: PortalMe }
//   GET   /v1/affiliate/terms                  → { terms: { version, publishedAt, sha256, text, accepted } }
//   POST  /v1/affiliate/terms/accept { version } → { terms } · 409 terms_changed
//   POST  /v1/affiliate/objects { contentType: 'application/pdf', sha256, sizeBytes ≤ 10 MB, fileName? }
//         → 201 { object: { objectId } } · 409 too_many_pending_invoices · 429
//   PUT   /v1/affiliate/objects/:id/content    the PDF's bytes → { object }
//
// EVERY request carries X-Shop-Id: the shop the affiliate works in now (the
// shell sets it from `/v1/me`'s memberships, setPortalShopId). The API answers
// the opaque 404 to everything it refuses; on a 404 the client asks `/v1/me`
// once, and a 401 there means the session is gone (the shell's handler sends
// the person to /login). Same-origin, `credentials: 'same-origin'`, as the
// admin client (src/api/admin/client.js, whose error class is reused).

import { AdminApiError, getMeRaw, segment, withQuery } from './admin/client.js';

const API_ROOT = '/_api';
const PORTAL_PREFIX = '/v1/affiliate/';

/** The invoice PDF's cap (the server's AFFILIATE_INVOICE_MAX_BYTES). */
export const INVOICE_MAX_BYTES = 10 * 1024 * 1024;
const FILE_NAME_MAX = 200;

// ── the shop and the lost session ───────────────────────────────────────────

let portalShopId = null;
let onLost = null;

/** The shop every portal request names (null: none chosen yet). */
export function setPortalShopId(shopId) {
  portalShopId = typeof shopId === 'string' && shopId !== '' ? shopId : null;
}

export function getPortalShopId() {
  return portalShopId;
}

/** Called once when a request finds the session gone. */
export function onPortalSessionLost(handler) {
  onLost = typeof handler === 'function' ? handler : null;
}

// ── the request ─────────────────────────────────────────────────────────────

function errorOf(status, data, headers) {
  const error = data && typeof data === 'object' && data.error && typeof data.error === 'object' ? data.error : null;
  const seconds = Number(headers.get('retry-after'));
  return new AdminApiError({
    status,
    code: typeof error?.code === 'string' && error.code !== '' ? error.code : 'http_error',
    message: typeof error?.message === 'string' ? error.message : `HTTP ${status}`,
    reason: typeof error?.reason === 'string' ? error.reason : null,
    details: error,
    retryAfterSeconds: headers.get('retry-after') !== null && Number.isFinite(seconds) ? seconds : null,
    body: data && typeof data === 'object' ? data : null,
  });
}

async function sessionGone() {
  try {
    return (await getMeRaw()) === null;
  } catch {
    return false;
  }
}

/**
 * One request to `/_api<path>` for the portal's shop. Resolves `{ status,
 * data, response }` for a 2xx (`data`: the parsed JSON, null for an empty or
 * non-JSON body when `raw`); rejects with an AdminApiError, or the AbortError
 * of `signal`. Refuses without sending when the path is not a portal path or
 * no shop is chosen.
 *
 * options: { json, body, contentType, signal, raw (keep the response, do not parse) }
 */
export async function portalRequest(method, path, { json, body, contentType, signal, raw = false, shopId } = {}) {
  if (typeof path !== 'string' || !path.startsWith(PORTAL_PREFIX)) {
    throw new AdminApiError({ status: 0, code: 'bad_request', message: 'Not a portal path' });
  }
  const shop = shopId ?? portalShopId;
  if (typeof shop !== 'string' || shop === '') {
    throw new AdminApiError({ status: 0, code: 'no_shop', message: 'Ingen butik är vald' });
  }
  const headers = { accept: raw ? '*/*' : 'application/json', 'x-shop-id': shop };
  const init = { method, credentials: 'same-origin', headers, signal };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    headers['content-type'] = 'application/json';
  } else if (body !== undefined) {
    init.body = body;
    if (contentType) headers['content-type'] = contentType;
  }

  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, init);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
    throw new AdminApiError({ status: 0, code: 'network_error', message: 'Servern kunde inte nås' });
  }

  if (response.ok && raw) return { status: response.status, data: null, response };

  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
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

  if (!response.ok) {
    if (response.status === 404 && (await sessionGone())) {
      onLost?.();
      throw new AdminApiError({ status: 401, code: 'unauthenticated', message: 'Sessionen har gått ut. Logga in igen.' });
    }
    throw errorOf(response.status, parsed ? data : null, response.headers);
  }
  if (!parsed) throw new AdminApiError({ status: response.status, code: 'bad_response', message: 'The answer was not JSON' });
  return { status: response.status, data, response };
}

const page = (path, { cursor, limit } = {}) => withQuery(path, { cursor, limit });

// ── the calls ───────────────────────────────────────────────────────────────

/** The affiliate's own view of itself in the chosen shop (PortalMe). */
export async function getPortalMe({ signal } = {}) {
  const { data } = await portalRequest('GET', '/v1/affiliate/me', { signal });
  return data?.affiliate ?? null;
}

/** One page of the attributed orders: `{ orders, nextCursor }`. */
export async function listPortalOrders(query, { signal } = {}) {
  const { data } = await portalRequest('GET', page('/v1/affiliate/orders', query), { signal });
  return { orders: Array.isArray(data?.orders) ? data.orders : [], nextCursor: data?.nextCursor ?? null };
}

/** One page of the ledger: `{ entries, nextCursor }`. */
export async function listPortalLedger(query, { signal } = {}) {
  const { data } = await portalRequest('GET', page('/v1/affiliate/ledger', query), { signal });
  return { entries: Array.isArray(data?.entries) ? data.entries : [], nextCursor: data?.nextCursor ?? null };
}

/** One page of the payouts: `{ payouts, nextCursor }`. */
export async function listPortalPayouts(query, { signal } = {}) {
  const { data } = await portalRequest('GET', page('/v1/affiliate/payouts', query), { signal });
  return { payouts: Array.isArray(data?.payouts) ? data.payouts : [], nextCursor: data?.nextCursor ?? null };
}

/**
 * Asks for a payout. `amountMinor` (öre; absent: the whole payable),
 * `invoiceNumber`, `invoiceObjectId` (an uploaded invoice): each sent only
 * when given. Resolves the payout.
 */
export async function requestPortalPayout({ amountMinor, invoiceNumber, invoiceObjectId } = {}, { signal } = {}) {
  const json = {};
  if (Number.isSafeInteger(amountMinor)) json.amountMinor = amountMinor;
  if (typeof invoiceNumber === 'string' && invoiceNumber.trim() !== '') json.invoiceNumber = invoiceNumber.trim();
  if (typeof invoiceObjectId === 'string' && invoiceObjectId !== '') json.invoiceObjectId = invoiceObjectId;
  const { data } = await portalRequest('POST', '/v1/affiliate/payouts', { json, signal });
  return data?.payout ?? null;
}

/** The invoice PDF of one of the affiliate's payouts, as a Blob. */
export async function getPayoutInvoice(payoutId, { signal } = {}) {
  const { response } = await portalRequest('GET', `/v1/affiliate/payouts/${segment(payoutId)}/invoice`, { raw: true, signal });
  return response.blob();
}

/** Saves the affiliate's own fields; resolves the new PortalMe. */
export async function updatePortalProfile(patch, { signal } = {}) {
  const { data } = await portalRequest('PATCH', '/v1/affiliate/profile', { json: patch, signal });
  return data?.affiliate ?? null;
}

/** The current terms for this affiliate: `{ version, publishedAt, sha256, text, accepted }`. */
export async function getPortalTerms({ signal } = {}) {
  const { data } = await portalRequest('GET', '/v1/affiliate/terms', { signal });
  return data?.terms ?? null;
}

/** Accepts the version shown; a newer one answers 409 `terms_changed`. */
export async function acceptPortalTerms(version, { signal } = {}) {
  const { data } = await portalRequest('POST', '/v1/affiliate/terms/accept', { json: { version }, signal });
  return data?.terms ?? null;
}

/** The hex sha256 of a Blob, File or ArrayBuffer. */
export async function sha256Hex(data) {
  const bytes = typeof data?.arrayBuffer === 'function' ? await data.arrayBuffer() : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Why a file cannot be the invoice, before anything is sent: 'not_pdf' | 'too_large' | 'empty' | null. */
export function invoiceFileProblem(file) {
  if (!file || typeof file.size !== 'number') return 'empty';
  if (file.size < 1) return 'empty';
  if (file.size > INVOICE_MAX_BYTES) return 'too_large';
  const named = typeof file.name === 'string' && /\.pdf$/i.test(file.name);
  if (file.type !== 'application/pdf' && !(file.type === '' && named)) return 'not_pdf';
  return null;
}

/**
 * Uploads the invoice PDF: reserve (POST /v1/affiliate/objects), then the
 * bytes (PUT …/content, which activates it). Resolves the object id to name
 * in the payout request. The shop is fixed when the upload starts.
 */
export async function uploadPortalInvoice(file, { signal } = {}) {
  const problem = invoiceFileProblem(file);
  if (problem) {
    throw new AdminApiError({ status: 0, code: problem === 'too_large' ? 'payload_too_large' : 'invalid_file', message: problem });
  }
  const shopId = portalShopId;
  const reserve = { contentType: 'application/pdf', sha256: await sha256Hex(file), sizeBytes: file.size };
  if (typeof file.name === 'string' && file.name !== '') reserve.fileName = file.name.slice(0, FILE_NAME_MAX);
  const { data } = await portalRequest('POST', '/v1/affiliate/objects', { json: reserve, shopId, signal });
  const objectId = data?.object?.objectId;
  if (typeof objectId !== 'string' || objectId === '') {
    throw new AdminApiError({ status: 0, code: 'bad_response', message: 'The reservation named no object' });
  }
  await portalRequest('PUT', `/v1/affiliate/objects/${segment(objectId)}/content`, {
    body: file,
    contentType: 'application/pdf',
    shopId,
    signal,
  });
  return objectId;
}
