// The seller's orders (CP5 unit FD), on the routes of units CP2-A, CP4 and
// CP5-WB:
//   GET  /v1/admin/orders?status&fulfilment&since&until&q&cursor&limit   the list
//   GET  /v1/admin/orders/:orderId                                      the detail
//   POST /v1/admin/orders/:orderId/fulfilment {to, trackingNumber?, carrier?, note?}
//   POST /v1/admin/orders/:orderId/refunds    {amountMinor, reason}
//   POST /v1/admin/orders/:orderId/cancel     {reason}
// Every request carries X-Shop-Id (adminRequest). The fulfilment and refund
// POSTs carry an Idempotency-Key: ONE key per user action, the SAME key on
// every retry of that action (withIdempotencyKey), so a lost answer never
// becomes a second change or a second refund.
//
// THE SELLER SEES ONE NUMBER: these calls hand the server's answer on as it
// is; nothing here computes a fee, a payout or a price.

import { AdminApiError, adminRequest, getRequestShopId, segment, withQuery } from './client.js';

/** The list's page size the walk asks for (the route's maximum). */
export const LIST_PAGE_SIZE = 100;
/** The walk stops after this many pages (100 × 50 = 5 000 orders). */
export const MAX_LIST_PAGES = 50;

// The Worker's grammar of a `q` without "@" (admin-order-list.ts NAME_QUERY_PATTERN):
// an order number prefix and a part of the recipient's name are the same text.
const NAME_QUERY = /^[\p{L}\p{M}\p{N} '’.-]{1,100}$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/**
 * What the route's `q` can search for a text a person typed: an exact e-mail
 * address (it holds `@`), else an order number prefix OR a part of the
 * recipient's name (1–100 letters, digits, spaces, `'`, `’`, `.`, `-`).
 * Returns the trimmed text, or null when the route would refuse it (`%`, `_`,
 * `\`, `<`, empty, too long): such a text matches nothing and is not sent.
 */
export function searchQueryOf(text) {
  if (typeof text !== 'string') return null;
  const q = text.trim();
  if (q === '') return null;
  if (q.includes('@')) return EMAIL.test(q) ? q.toLowerCase() : null;
  return NAME_QUERY.test(q) ? q : null;
}

/**
 * One page of the list: `{ orders, nextCursor, count, totalMinor }`.
 * `shopId`: the shop asked (default: the active shop, as every admin call).
 */
export async function listOrders(filters = {}, { signal, shopId } = {}) {
  const { status, fulfilment, since, until, q, cursor, limit } = filters;
  const path = withQuery('/v1/admin/orders', { status, fulfilment, since, until, q, cursor, limit });
  const { data } = await adminRequest('GET', path, { signal, shopId });
  return {
    orders: Array.isArray(data?.orders) ? data.orders : [],
    nextCursor: typeof data?.nextCursor === 'string' ? data.nextCursor : null,
    count: Number.isSafeInteger(data?.count) ? data.count : 0,
    totalMinor: Number.isSafeInteger(data?.totalMinor) ? data.totalMinor : 0,
  };
}

/**
 * Every page of the list for `filters`, walked by the cursor, newest first.
 * `count` and `totalMinor` are the route's (the whole window); `truncated` is
 * true when the walk stopped at `maxPages` with orders left. Every page goes
 * to ONE shop: `shopId`, else the shop active when the walk began (a cursor
 * of one shop is never sent to another).
 */
export async function listAllOrders(filters = {}, { signal, maxPages = MAX_LIST_PAGES, shopId = getRequestShopId() } = {}) {
  const orders = [];
  let cursor = null;
  let first = null;
  for (let page = 0; page < maxPages; page += 1) {
    const answer = await listOrders({ ...filters, cursor, limit: LIST_PAGE_SIZE }, { signal, shopId });
    first ??= answer;
    orders.push(...answer.orders);
    cursor = answer.nextCursor;
    if (cursor === null) break;
  }
  return { orders, count: first.count, totalMinor: first.totalMinor, truncated: cursor !== null };
}

/** The detail (`order` of the route), or null when the route answers 404. */
export async function getOrder(orderId, { signal, shopId } = {}) {
  try {
    const { data } = await adminRequest('GET', `/v1/admin/orders/${segment(orderId)}`, { signal, shopId });
    return data?.order ?? null;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return null;
    throw error;
  }
}

/** A fresh Idempotency-Key (a UUID v4). */
export function newIdempotencyKey() {
  return globalThis.crypto.randomUUID();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure where the request may not have arrived, or the server failed: worth the same request again. */
export function isRetriable(error) {
  return error instanceof AdminApiError && (error.code === 'network_error' || error.status >= 500);
}

/**
 * Runs `send(key)` for ONE user action: one fresh key, reused on each retry
 * after a network failure or a 5xx (at most `attempts` tries). A refusal (4xx)
 * is the answer and is not retried.
 */
export async function withIdempotencyKey(send, { attempts = 3, key = newIdempotencyKey(), pauseMs = 400 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send(key);
    } catch (error) {
      if (attempt >= attempts || !isRetriable(error)) throw error;
      await sleep(pauseMs * attempt);
    }
  }
}

/**
 * Moves the order's fulfilment one step. `change`: { to, trackingNumber?,
 * carrier?, note? }. Resolves `{ orderId, from, to, at, shipment }`.
 * `options`: { shopId } and the retry's ({ attempts, key, pauseMs }).
 */
export async function changeFulfilment(orderId, change, { shopId, ...retry } = {}) {
  const body = { to: change.to };
  for (const key of ['trackingNumber', 'carrier', 'note']) {
    const value = typeof change[key] === 'string' ? change[key].trim() : '';
    if (value !== '') body[key] = value;
  }
  return withIdempotencyKey(async (idempotencyKey) => {
    const { data } = await adminRequest('POST', `/v1/admin/orders/${segment(orderId)}/fulfilment`, {
      json: body,
      idempotencyKey,
      shopId,
    });
    return data?.fulfilment ?? null;
  }, retry);
}

/**
 * Refunds `amountMinor` of the order. Resolves `{ refundId, amountMinor,
 * state, accepted }`: state is the route's (`submitted`, `succeeded`,
 * `failed`, or `reserved` on a 202 while Stripe's outcome is unknown).
 */
export async function refundOrder(orderId, { amountMinor, reason }, options = {}) {
  return withIdempotencyKey(async (idempotencyKey) => {
    const { status, data } = await adminRequest('POST', `/v1/admin/orders/${segment(orderId)}/refunds`, {
      json: { amountMinor, reason },
      idempotencyKey,
    });
    return { ...(data?.refund ?? {}), accepted: status === 202 };
  }, options);
}

/** Cancels the order's production (no money moves). Resolves the route's `cancellation`. */
export async function cancelOrder(orderId, { reason }, { shopId } = {}) {
  const { data } = await adminRequest('POST', `/v1/admin/orders/${segment(orderId)}/cancel`, {
    json: { reason },
    shopId,
  });
  return data?.cancellation ?? null;
}
