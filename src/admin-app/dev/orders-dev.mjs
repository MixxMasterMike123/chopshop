// The admin dev API's order routes (CP5 unit FD), in the shapes of the
// Worker's (CP5_WB_REPORT.md; cloudflare/src/routes/{admin-orders,
// money-orders,dispatch-admin}.ts). INVENTED DATA ONLY: orders.fixtures.json.
//
//   GET  /v1/admin/orders                    list, filters, cursor, count, totalMinor
//   GET  /v1/admin/orders/:id                detail
//   POST /v1/admin/orders/:id/fulfilment     the transition table and its refusals
//   POST /v1/admin/orders/:id/refunds        a refund of at most the refundable
//   POST /v1/admin/orders/:id/cancel         the cancellation (return_case after shipping)
//
// The orders live in memory per dev server, started from the fixtures; a
// change shows until the server restarts. The cookie `admin_dev_orders=empty`
// shows a shop without orders (document.cookie = 'admin_dev_orders=empty;
// path=/'). Money here is the dev stand-in for the server's: VAT is a fifth
// of the gross, the payout is charged − refunded − fee.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'orders.fixtures.json');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ORDER_NUMBER_PREFIX = /^[0-9A-Za-z-]{1,40}$/;
const NAME_QUERY = /^[\p{L}\p{M}\p{N} '’.-]{1,100}$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const STATUSES = ['paid', 'processing', 'printed', 'shipped', 'ready_for_pickup', 'delivered', 'completed', 'partially_refunded', 'refunded', 'cancelled'];
const FULFILMENT = ['unfulfilled', 'processing', 'shipped', 'ready_for_pickup', 'delivered', 'completed'];
const TRANSITIONS = {
  unfulfilled: ['processing', 'shipped', 'ready_for_pickup'],
  processing: ['shipped', 'ready_for_pickup'],
  shipped: ['shipped', 'delivered', 'completed'],
  ready_for_pickup: ['delivered', 'completed'],
  delivered: ['completed'],
  completed: [],
};
const RETURN_CASE = new Set(['shipped', 'ready_for_pickup', 'delivered', 'completed']);

const json = (status, body, extra = {}) => ({ status, body, ...extra });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });
const keyRequired = () => json(400, { error: { code: 'idempotency_key_required', message: 'An Idempotency-Key header (a UUID) is required' } });

function cookieOf(headers, name) {
  for (const part of (headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

// ── the orders in memory ─────────────────────────────────────────────────────

function fullOrder(seed) {
  const items = seed.items.map((item, index) => ({
    lineNo: index + 1,
    sku: item.sku,
    name: item.name,
    variantLabel: item.variantLabel ?? null,
    quantity: item.quantity,
    unitPriceMinor: item.unitPriceMinor,
    lineTotalMinor: item.unitPriceMinor * item.quantity,
    podState: item.podState ?? 'none',
  }));
  const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  const totalMinor = subtotalMinor + (seed.shippingMinor ?? 0);
  const recipient = seed.recipient ?? null;
  return {
    orderId: seed.orderId,
    orderNumber: seed.orderNumber,
    createdAt: seed.createdAt,
    paidAt: seed.createdAt,
    status: seed.status,
    fulfilment: seed.fulfilment,
    cancelledAt: seed.cancelledAt ?? null,
    currency: 'SEK',
    customerEmail: seed.customerEmail,
    deliveryMethod: seed.deliveryMethod,
    shippingCountry: seed.deliveryMethod === 'pickup' ? null : recipient?.country ?? 'SE',
    items,
    totals: { subtotalMinor, shippingMinor: seed.shippingMinor ?? 0, discountMinor: 0, vatMinor: Math.round(totalMinor / 5), totalMinor },
    chargedMinor: totalMinor,
    feeMinor: seed.feeMinor ?? 0,
    refundedMinor: seed.refundedMinor ?? 0,
    refunds: seed.refunds ?? [],
    consent: seed.consent ?? null,
    recipient: recipient && {
      addressLine1: null, addressLine2: null, city: null, country: null, phone: null,
      pickupDate: null, pickupLocationAddress: null, pickupLocationId: null, pickupLocationName: null, postalCode: null,
      ...recipient,
      deliveryMethod: seed.deliveryMethod,
    },
    shipments: seed.shipments ?? [],
    statusHistory: seed.statusHistory ?? [
      { track: 'payment', from: null, to: 'paid', at: seed.createdAt, by: 'system', reason: null },
    ],
    withdrawalRequest: seed.withdrawalRequest ?? null,
    keys: new Map(),
  };
}

function ordersOf(state, tenantId, headers) {
  if (cookieOf(headers, 'admin_dev_orders') === 'empty') return [];
  state.orders ??= new Map();
  if (!state.orders.has(tenantId)) {
    const seeds = JSON.parse(readFileSync(FIXTURES, 'utf8'))[tenantId] ?? [];
    state.orders.set(tenantId, seeds.map(fullOrder));
  }
  return state.orders.get(tenantId);
}

const isClosed = (o) =>
  o.cancelledAt !== null || o.status === 'refunded' || o.status === 'cancelled' ||
  (o.chargedMinor > 0 && o.refundedMinor >= o.chargedMinor);

function listRow(o) {
  const pickup = o.deliveryMethod === 'pickup';
  return {
    orderId: o.orderId,
    orderNumber: o.orderNumber,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    status: o.status,
    fulfilment: o.fulfilment,
    cancelledAt: o.cancelledAt,
    deliveryMethod: o.deliveryMethod,
    totalMinor: o.totals.totalMinor,
    currency: o.currency,
    customerEmail: o.customerEmail,
    recipientName: o.recipient?.name ?? null,
    pickupPlace: pickup ? o.recipient?.pickupLocationName ?? null : null,
    itemCount: o.items.reduce((sum, item) => sum + item.quantity, 0),
    refundedMinor: o.refundedMinor,
  };
}

function detail(o) {
  const refundableMinor = o.status === 'refunded' ? 0 : Math.max(0, o.chargedMinor - o.refundedMinor);
  return {
    cancelledAt: o.cancelledAt,
    createdAt: o.createdAt,
    currency: o.currency,
    customerEmail: o.customerEmail,
    deliveryMethod: o.deliveryMethod,
    fulfilment: o.fulfilment,
    items: o.items,
    money: {
      chargedMinor: o.chargedMinor,
      dispute: null,
      feeMinor: o.feeMinor,
      refundableMinor,
      refundedMinor: o.refundedMinor,
      refundPendingMinor: 0,
    },
    orderId: o.orderId,
    orderNumber: o.orderNumber,
    paidAt: o.paidAt,
    payout: {
      amountMinor: o.chargedMinor - o.refundedMinor - o.feeMinor,
      eligibleAt: new Date(Date.parse(o.paidAt) + 14 * 86_400_000).toISOString(),
      state: 'pending',
    },
    refunds: o.refunds,
    shippingCountry: o.shippingCountry,
    status: o.status,
    totals: o.totals,
    consent: o.consent,
    recipient: o.recipient,
    shipments: o.shipments,
    statusHistory: o.statusHistory,
    withdrawal: { waived: (o.consent?.withdrawal?.personalizedItems ?? []).length > 0 && o.consent.withdrawal.waived === true },
    withdrawalRequest: o.withdrawalRequest,
  };
}

// ── the list ─────────────────────────────────────────────────────────────────

function parseList(url) {
  const p = url.searchParams;
  for (const key of p.keys()) {
    if (!['status', 'fulfilment', 'since', 'until', 'q', 'cursor', 'limit'].includes(key) || p.getAll(key).length > 1) return null;
  }
  const status = p.get('status');
  const fulfilment = p.get('fulfilment');
  if (status !== null && !STATUSES.includes(status)) return null;
  if (fulfilment !== null && !FULFILMENT.includes(fulfilment)) return null;
  const since = p.get('since');
  const until = p.get('until');
  if ((since !== null && !ISO.test(since)) || (until !== null && !ISO.test(until))) return null;
  const limitRaw = p.get('limit');
  const limit = limitRaw === null ? 50 : /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : 0;
  if (limit < 1 || limit > 100) return null;
  const cursorRaw = p.get('cursor');
  let cursor = null;
  if (cursorRaw !== null) {
    const m = /^(\d{1,16})~([0-9a-f-]{36})$/.exec(cursorRaw);
    if (!m) return null;
    cursor = { at: Number(m[1]), id: m[2] };
  }
  let email = null;
  let prefix = null;
  let name = null;
  const qRaw = p.get('q');
  if (qRaw !== null) {
    const q = qRaw.trim();
    if (q.includes('@')) {
      if (!EMAIL.test(q)) return null;
      email = q.toLowerCase();
    } else {
      // as the Worker: the order number prefix OR a part of the recipient's name
      if (!NAME_QUERY.test(q)) return null;
      name = q.toLowerCase();
      prefix = ORDER_NUMBER_PREFIX.test(q) ? q.toUpperCase() : null;
    }
  }
  return { status, fulfilment, since, until, limit, cursor, email, prefix, name };
}

function inWindow(o, f) {
  if (f.status === 'cancelled' && !(o.status === 'cancelled' || o.cancelledAt !== null)) return false;
  if (f.status !== null && f.status !== 'cancelled' && o.status !== f.status) return false;
  if (f.fulfilment !== null && o.fulfilment !== f.fulfilment) return false;
  const at = Date.parse(o.createdAt);
  if (f.since !== null && at < Date.parse(f.since)) return false;
  if (f.until !== null && at >= Date.parse(f.until)) return false;
  if (f.email !== null && o.customerEmail !== f.email) return false;
  if (f.name !== null || f.prefix !== null) {
    const byNumber = f.prefix !== null && o.orderNumber.startsWith(f.prefix);
    const byName = f.name !== null && (o.recipient?.name ?? '').toLowerCase().includes(f.name);
    if (!byNumber && !byName) return false;
  }
  return true;
}

const newestFirst = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (b.orderId < a.orderId ? -1 : 1);

function listOrders(state, { shop, headers, url }) {
  const f = parseList(url);
  if (f === null) return invalid();
  const window = ordersOf(state, shop.shop.tenantId, headers).filter((o) => inWindow(o, f)).sort(newestFirst);
  const after = f.cursor === null
    ? window
    : window.filter((o) => {
        const at = Date.parse(o.createdAt);
        return at < f.cursor.at || (at === f.cursor.at && o.orderId < f.cursor.id);
      });
  const page = after.slice(0, f.limit);
  const last = page.at(-1);
  return json(200, {
    orders: page.map(listRow),
    nextCursor: after.length > f.limit && last ? `${Date.parse(last.createdAt)}~${last.orderId}` : null,
    count: window.length,
    totalMinor: window.reduce((sum, o) => sum + o.totals.totalMinor, 0),
  });
}

// ── one order ────────────────────────────────────────────────────────────────

function orderOf(state, ctx) {
  const id = ctx.segments[0];
  if (!UUID.test(id)) return null;
  return ordersOf(state, ctx.shop.shop.tenantId, ctx.headers).find((o) => o.orderId === id) ?? null;
}

const actor = (entry) => (entry.platform === true ? 'platform' : 'admin');

function getOrder(state, ctx) {
  const o = orderOf(state, ctx);
  return o ? json(200, { order: detail(o) }) : notFound();
}

const refusal = (reason) =>
  json(409, { error: { code: 'fulfilment_not_allowed', reason, message: `Fulfilment refused: ${reason}` } });

function decide(o, to, trackingNumber) {
  if (isClosed(o)) return 'order_closed';
  if ((to === 'shipped' && o.deliveryMethod === 'pickup') || (to === 'ready_for_pickup' && o.deliveryMethod !== 'pickup')) return 'delivery_method';
  if (!TRANSITIONS[o.fulfilment].includes(to)) return 'transition';
  if (o.fulfilment === 'shipped' && to === 'shipped' && !trackingNumber) return 'tracking_required';
  if ((to === 'shipped' || to === 'ready_for_pickup') && o.items.some((i) => i.podState !== 'none' && i.podState !== 'sent' && i.podState !== 'cancelled')) {
    return 'printer_ships';
  }
  return null;
}

function changeFulfilment(state, ctx) {
  const o = orderOf(state, ctx);
  if (!o) return notFound();
  const key = (ctx.headers['idempotency-key'] || '').trim().toLowerCase();
  if (!UUID.test(key)) return keyRequired();
  const body = ctx.body;
  const keys = body && typeof body === 'object' ? Object.keys(body) : [];
  if (!keys.includes('to') || keys.some((k) => !['to', 'trackingNumber', 'carrier', 'note'].includes(k))) return invalid();
  if (!['processing', 'shipped', 'ready_for_pickup', 'delivered', 'completed'].includes(body.to)) return invalid();
  if ((body.trackingNumber !== undefined || body.carrier !== undefined) && body.to !== 'shipped') return invalid();
  const hash = JSON.stringify([o.orderId, body.to, body.trackingNumber ?? null, body.carrier ?? null, body.note ?? null]);
  const seen = o.keys.get(key);
  if (seen) {
    return seen.hash === hash
      ? json(200, { fulfilment: seen.answer }, { headers: { 'Idempotent-Replayed': 'true' } })
      : json(409, { error: { code: 'conflict', message: 'Idempotency key was already used for a different request' } });
  }
  const reason = decide(o, body.to, body.trackingNumber);
  if (reason) return refusal(reason);
  const at = new Date().toISOString();
  const shipment = body.to === 'shipped'
    ? { trackingNumber: body.trackingNumber ?? null, carrier: body.carrier ?? null, createdAt: at }
    : null;
  if (shipment) o.shipments.push(shipment);
  o.statusHistory.push({ track: 'fulfilment', from: o.fulfilment, to: body.to, at, by: actor(ctx.entry), reason: body.note ?? null });
  const answer = { orderId: o.orderId, from: o.fulfilment, to: body.to, at, shipment };
  o.fulfilment = body.to;
  o.keys.set(key, { hash, answer });
  return json(200, { fulfilment: answer });
}

function refund(state, ctx) {
  const o = orderOf(state, ctx);
  if (!o) return notFound();
  const key = (ctx.headers['idempotency-key'] || '').trim().toLowerCase();
  if (!UUID.test(key)) return keyRequired();
  const body = ctx.body;
  const keys = body && typeof body === 'object' ? Object.keys(body).sort().join(',') : '';
  if (keys !== 'amountMinor,reason' || !Number.isSafeInteger(body.amountMinor) || body.amountMinor <= 0 ||
      typeof body.reason !== 'string' || body.reason.trim() === '' || body.reason.length > 500) {
    return invalid();
  }
  const seen = o.keys.get(key);
  if (seen) return json(201, { refund: seen.answer }, { headers: { 'Idempotent-Replayed': 'true' } });
  const refundable = o.status === 'refunded' ? 0 : o.chargedMinor - o.refundedMinor;
  if (body.amountMinor > refundable) {
    return json(409, { error: { code: 'refund_not_allowed', message: 'The order cannot be refunded by this amount' } });
  }
  const at = new Date().toISOString();
  const refundId = crypto.randomUUID();
  const from = o.status;
  o.refundedMinor += body.amountMinor;
  o.status = o.refundedMinor >= o.chargedMinor ? 'refunded' : 'partially_refunded';
  o.refunds.push({ refundId, amountMinor: body.amountMinor, state: 'succeeded', origin: 'admin', reason: body.reason, createdAt: at });
  o.statusHistory.push({ track: 'payment', from, to: o.status, at, by: actor(ctx.entry), reason: body.reason });
  const answer = { refundId, amountMinor: body.amountMinor, state: 'succeeded' };
  o.keys.set(key, { answer });
  return json(201, { refund: answer });
}

function cancel(state, ctx) {
  const o = orderOf(state, ctx);
  if (!o) return notFound();
  const body = ctx.body;
  if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'reason' ||
      typeof body.reason !== 'string' || body.reason.trim() === '') {
    return invalid();
  }
  if (RETURN_CASE.has(o.fulfilment)) {
    return json(409, { error: { code: 'return_case', message: 'The order has been produced; handle it as a return' } });
  }
  o.cancelledAt ??= new Date().toISOString();
  return json(200, {
    cancellation: {
      orderId: o.orderId,
      cancelledAt: o.cancelledAt,
      reason: body.reason,
      lines: o.items.filter((i) => i.podState !== 'none').map((i) => ({ lineNo: i.lineNo, jobId: null, outcome: 'not_at_printer' })),
    },
  });
}

const ORDER = '([0-9A-Za-z-]+)';

/** The rows for ADMIN_ROUTES of dev-api.mjs. */
export const ORDER_ROUTES = [
  ['GET', '/v1/admin/orders', listOrders],
  ['GET', new RegExp(`^/v1/admin/orders/${ORDER}$`), getOrder],
  ['POST', new RegExp(`^/v1/admin/orders/${ORDER}/fulfilment$`), changeFulfilment],
  ['POST', new RegExp(`^/v1/admin/orders/${ORDER}/refunds$`), refund],
  ['POST', new RegExp(`^/v1/admin/orders/${ORDER}/cancel$`), cancel],
];
