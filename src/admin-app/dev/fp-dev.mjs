// The dev API's rows of unit CP5-FP, wired into dev-api.mjs, and the one
// scenario cookie every new row of the unit reads. INVENTED data only
// (print-jobs-fixtures.json), in the Worker's shapes and with its refusals:
//   PATCH /v1/admin/settings                      routes/admin-settings.ts, platform/tenant-config.ts
//                                                 (fenced on updatedAt; each named identity key replaced)
//   GET   /v1/admin/payments/connect/balance      routes/connect-admin.ts
//   GET   /v1/platform/print-jobs                 routes/print-jobs-platform.ts, dispatch/print-job-list.ts
//   POST  /v1/platform/print-jobs/:jobId/status   dispatch/production-status.ts, commerce/fulfilment.ts
// In their own modules, reading the same cookie: the shop counts
// (platform-dev.mjs), the printer PATCH's dry run (printers-dev.mjs), the
// resend of an invite (members-dev.mjs).
//
// Scenarios, by the cookie `admin_dev_fp` (in the browser console:
// document.cookie = 'admin_dev_fp=lost; path=/'; remove it with Max-Age=0):
//   lost           a write is done, but answered 502 (its answer is lost)
//   drop           a write answers 502 and is NOT done
//   unclear        as drop, and the read-back (the settings GET, the print-job
//                  list) answers 500 too
//   conflict       settings: another admin changes the slogan just before
//                  (once per shop); a print-job status: 409 conflict
//   conflict-menu  settings: another admin changes the menu just before (once per shop)
//   limited        the balance answers 429 (Retry-After 60); the resend 429 (Retry-After 900)
//   stripe         the balance answers 502 connect_unavailable
//   dark           the resend answers the opaque 404 (no invite mail in this
//                  environment, as on staging today)
//   password       the resend: the person set a password just before (409 not_invited)
//   suspended      the resend: the identity is suspended by the platform (409 not_invitable)
//   nomail         the resend answers 503 email_unavailable
//   moved          printers: another operator edits the printer right after a dry run (once)
//   empty          the print-job list is empty
//   many           120 more accepted jobs in Test Shop A (for "Visa fler")

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FP_COOKIE = 'admin_dev_fp';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'print-jobs-fixtures.json');

const json = (status, body, extra = {}) => ({ status, body, ...extra });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });
const refused = (status, code, message, extra = {}) => json(status, { error: { code, message, ...extra } });
const serverError = () => json(500, { error: { code: 'internal_error', message: 'Dev scenario: the read failed' } });
const lostAnswer = () => json(502, { error: { code: 'bad_gateway', message: 'The answer was lost on the way (dev scenario)' } });

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function fpScenario(headers) {
  for (const part of (headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === FP_COOKIE) return rest.join('=');
  }
  return '';
}

function held(state) {
  if (!state.fp) {
    const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
    state.fp = { orders: structuredClone(fixtures.orders), conflictDone: new Set(), many: false };
  }
  return state.fp;
}

// ── PATCH /v1/admin/settings ────────────────────────────────────────────────

const PATCH_KEYS = ['expectedUpdatedAt', 'returnAddress', 'sellerType', 'storeIdentity', 'vatNumber', 'vatRegistered'];
const UPDATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A later instant than `previous`, always (every settings write moves updatedAt strictly forward). */
function nextUpdatedAt(previous) {
  const now = Date.now();
  const before = typeof previous === 'string' ? Date.parse(previous) : 0;
  return new Date(Math.max(now, before + 1)).toISOString();
}

function gateText(value, max) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || value.length > max) return { ok: false };
  const trimmed = value.trim();
  return { ok: true, value: trimmed === '' ? null : trimmed };
}

/**
 * The PATCH row, over unit FE's held settings: `read(state, shop, shopId)` →
 * a copy of the stored settings; `write(state, shopId, settings)` stores them.
 * `refusedKeys`: tenant-config.ts REFUSED_STORE_IDENTITY_KEYS.
 */
export function settingsPatchRoute({ read, write, refusedKeys }) {
  return ['PATCH', '/v1/admin/settings', (state, { shop, headers, body }) => {
    const shopId = headers['x-shop-id'];
    if (!isObject(body) || !Object.keys(body).every((k) => PATCH_KEYS.includes(k)) || !Object.hasOwn(body, 'expectedUpdatedAt')) return invalid();
    const expected = body.expectedUpdatedAt;
    if (expected !== null && (typeof expected !== 'string' || !UPDATED_AT.test(expected))) return invalid();
    const identity = body.storeIdentity;
    if (identity !== undefined && (!isObject(identity) || Object.keys(identity).length === 0)) return invalid();
    if (identity !== undefined) {
      const keys = refusedKeys.filter((k) => Object.hasOwn(identity, k));
      if (isObject(identity.legal) && Object.hasOwn(identity.legal, 'acceptance')) keys.push('legal.acceptance');
      if (keys.length > 0) return refused(400, 'refused_store_identity_keys', 'The store identity carries keys this route does not accept', { keys });
    }
    const gates = {};
    for (const [key, max] of [['returnAddress', 1000], ['vatNumber', 64]]) {
      if (!Object.hasOwn(body, key)) continue;
      const parsed = gateText(body[key], max);
      if (!parsed.ok) return invalid();
      gates[key] = parsed.value;
    }
    if (Object.hasOwn(body, 'vatRegistered')) {
      if (body.vatRegistered !== null && typeof body.vatRegistered !== 'boolean') return invalid();
      gates.vatRegistered = body.vatRegistered;
    }
    if (Object.hasOwn(body, 'sellerType')) {
      const v = body.sellerType;
      if (v !== null && v !== '' && v !== 'company' && v !== 'individual') return invalid();
      gates.sellerType = v === '' ? null : v;
    }
    if (identity === undefined && Object.keys(gates).length === 0) return invalid();

    const mode = fpScenario(headers);
    const fp = held(state);
    let current = read(state, shop, shopId);
    // Another admin's write lands first, once per shop and scenario.
    if ((mode === 'conflict' || mode === 'conflict-menu') && !fp.conflictDone.has(`${mode}:${shopId}`)) {
      fp.conflictDone.add(`${mode}:${shopId}`);
      const other = mode === 'conflict'
        ? { tagline: 'Ändrad av en annan administratör' }
        : { menu: [{ type: 'all-products', target: '', label: 'Allt (ändrat av en annan administratör)' }] };
      current = { ...current, storeIdentity: { ...current.storeIdentity, ...other }, updatedAt: nextUpdatedAt(current.updatedAt) };
      write(state, shopId, current);
    }
    if ((current.updatedAt ?? null) !== expected) {
      return json(409, {
        error: { code: 'conflict', message: 'The settings changed since they were read; read them again and retry' },
        settings: structuredClone(current),
      });
    }
    if (mode === 'drop' || mode === 'unclear') return lostAnswer();
    const next = {
      ...current,
      ...gates,
      storeIdentity: { ...current.storeIdentity, ...(identity ?? {}) },
      updatedAt: nextUpdatedAt(current.updatedAt),
    };
    if (Buffer.byteLength(JSON.stringify(next.storeIdentity)) > 65_536) return invalid();
    write(state, shopId, next);
    if (mode === 'lost') return lostAnswer();
    return json(200, { settings: structuredClone(next) });
  }];
}

/** The settings GET for the `unclear` scenario (500); otherwise unit FE's row answers. */
export function settingsReadRoute(feGet) {
  return ['GET', '/v1/admin/settings', (state, ctx) => (fpScenario(ctx.headers) === 'unclear' ? serverError() : feGet(state, ctx))];
}

// ── GET /v1/admin/payments/connect/balance ──────────────────────────────────
// Over the payments rows' Connect state (`connectOf`, cookie admin_dev_connect):
// a shop Connect is not enabled for answers the opaque 404, a shop without an
// account 409 connect_account_missing, as the Worker's guard order.

export function balanceRoute(connectOf) {
  return ['GET', '/v1/admin/payments/connect/balance', (state, { shop, headers }) => {
    const c = connectOf(state, shop.shop.tenantId, headers);
    if (c.notFound || !c.enabled) return notFound();
    if (!c.hasAccount) return refused(409, 'connect_account_missing', 'Create the payment account first');
    const mode = fpScenario(headers);
    if (mode === 'limited') return json(429, { error: { code: 'rate_limited', message: 'Too many requests' } }, { headers: { 'retry-after': '60' } });
    if (mode === 'stripe' || c.stripeDown) return refused(502, 'connect_unavailable', 'The payment provider could not be reached');
    return json(200, {
      balance: {
        available: [{ amountMinor: 1_284_050, currency: 'sek' }, ...(c.status === 'active' ? [{ amountMinor: 4_200, currency: 'eur' }] : [])],
        payoutSchedule: { delayDays: 7, interval: 'weekly', monthlyAnchor: null, weeklyAnchor: 'friday' },
        pending: [{ amountMinor: 356_900, currency: 'sek' }],
        retrievedAt: new Date().toISOString(),
      },
    });
  }];
}

// ── the print jobs ──────────────────────────────────────────────────────────

const PRODUCTION_STATES = ['in_production', 'produced', 'shipped'];
const RANK = { in_production: 1, produced: 2, shipped: 3 };
const DISPATCH_STATES = ['accepted', 'cancelled', 'failed', 'pending', 'submitting', 'unknown'];
const QUERY_KEYS = ['cursor', 'dispatchState', 'limit', 'printerId', 'state', 'tenantId'];
const JOB_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([1-9][0-9]{0,3})$/;
const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRINTER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const STATUS_PATH = /^\/v1\/platform\/print-jobs\/([^/]+)\/status$/;

function ordersOf(state, headers) {
  const fp = held(state);
  if (fpScenario(headers) === 'many' && !fp.many) {
    fp.many = true;
    for (let i = 0; i < 120; i += 1) {
      const n = String(i).padStart(3, '0');
      fp.orders.push({
        orderId: `f0000000-0000-4000-8000-000000000${n}`, tenantId: 'test-shop-a', orderNumber: String(3000 + i),
        status: 'paid', delivery: 'parcel', fulfilment: 'unfulfilled', printerId: 'fake-printer',
        createdAt: '2026-10-01T06:00:00.000Z',
        lines: [{ name: 'T-shirt med eget tryck', sku: 'POD-TEE-BLK-M', variantLabel: 'Svart · M', quantity: 1, printer: true, dispatchState: 'accepted', printerJobRef: `fp-job-${3000 + i}`, dispatchedAt: '2026-10-01T06:05:00.000Z', state: i % 4 === 0 ? 'shipped' : null }],
      });
    }
  }
  return fp.orders;
}

const shopNameOf = (state, tenantId) => state.fixtures.shops[tenantId]?.shop.shopName ?? null;

/** Every printer line, in the list's order (order id, then line). */
function jobsOf(state, headers) {
  const rows = [];
  for (const order of ordersOf(state, headers)) {
    order.lines.forEach((line, index) => {
      if (line.printer !== true) return;
      rows.push({ order, line, lineNo: index + 1 });
    });
  }
  return rows.sort((a, b) => (a.order.orderId < b.order.orderId ? -1 : a.order.orderId > b.order.orderId ? 1 : a.lineNo - b.lineNo));
}

function viewOf(state, { order, line, lineNo }) {
  return {
    carrier: line.carrier ?? null,
    createdAt: order.createdAt,
    dispatchedAt: line.dispatchedAt ?? null,
    dispatchState: line.dispatchState ?? null,
    jobId: `${order.orderId}-${lineNo}`,
    lineNo,
    name: line.name,
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    printerId: order.printerId,
    printerJobRef: line.printerJobRef ?? null,
    quantity: line.quantity,
    shopName: shopNameOf(state, order.tenantId),
    sku: line.sku,
    state: line.state ?? null,
    tenantId: order.tenantId,
    trackingNumber: line.trackingNumber ?? null,
    trackingUrl: line.trackingUrl ?? null,
    updatedAt: line.updatedAt ?? order.createdAt,
    variantLabel: line.variantLabel ?? null,
  };
}

function listJobs(state, { url, headers }) {
  const mode = fpScenario(headers);
  if (mode === 'unclear') return serverError();
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!QUERY_KEYS.includes(key) || params.getAll(key).length > 1) return invalid();
  }
  const state_ = params.get('state');
  const dispatch = params.get('dispatchState');
  const tenantId = params.get('tenantId');
  const printerId = params.get('printerId');
  const cursor = params.get('cursor');
  const rawLimit = params.get('limit');
  if (state_ !== null && state_ !== 'none' && !PRODUCTION_STATES.includes(state_)) return invalid();
  if (dispatch !== null && dispatch !== 'none' && !DISPATCH_STATES.includes(dispatch)) return invalid();
  if (tenantId !== null && !TENANT_ID.test(tenantId)) return invalid();
  if (printerId !== null && (!PRINTER_ID.test(printerId) || printerId === 'default')) return invalid();
  const at = cursor === null ? null : JOB_ID.exec(cursor);
  if (cursor !== null && !at) return invalid();
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if ((rawLimit !== null && !/^\d{1,3}$/.test(rawLimit)) || limit < 1 || limit > 100) return invalid();

  const matches = mode === 'empty' ? [] : jobsOf(state, headers).filter(({ order, line, lineNo }) => {
    if (tenantId !== null && order.tenantId !== tenantId) return false;
    if (printerId !== null && order.printerId !== printerId) return false;
    if (state_ !== null && (line.state ?? null) !== (state_ === 'none' ? null : state_)) return false;
    if (dispatch !== null && (line.dispatchState ?? null) !== (dispatch === 'none' ? null : dispatch)) return false;
    if (at) {
      const [, orderId, n] = at;
      if (order.orderId < orderId || (order.orderId === orderId && lineNo <= Number(n))) return false;
    }
    return true;
  });
  const page = matches.slice(0, limit);
  return json(200, {
    jobs: page.map((row) => viewOf(state, row)),
    nextCursor: matches.length > limit ? `${page.at(-1).order.orderId}-${page.at(-1).lineNo}` : null,
  });
}

function optionalText(value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length === 0 || text.length > max || CONTROL.test(text) ? undefined : text;
}

function optionalUrl(value) {
  const text = optionalText(value, 500);
  if (text === null || text === undefined) return text;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && !text.includes(' ') && text.startsWith('https://') ? text : undefined;
  } catch {
    return undefined;
  }
}

/** production-status.ts parseProductionStatusInput. */
function statusInput(body) {
  if (!isObject(body) || Object.keys(body).some((k) => !['carrier', 'state', 'trackingNumber', 'trackingUrl'].includes(k))) return null;
  if (!PRODUCTION_STATES.includes(body.state)) return null;
  const trackingNumber = optionalText(body.trackingNumber, 100);
  const carrier = optionalText(body.carrier, 60);
  const trackingUrl = optionalUrl(body.trackingUrl);
  if (trackingNumber === undefined || carrier === undefined || trackingUrl === undefined) return null;
  if (body.state !== 'shipped' && (trackingNumber !== null || carrier !== null || trackingUrl !== null)) return null;
  return { state: body.state, trackingNumber, trackingUrl, carrier };
}

function setStatus(state, { segments, headers, body }) {
  const id = JOB_ID.exec(decodeURIComponent(segments[0]));
  if (!id) return notFound();
  const input = statusInput(body);
  if (input === null) return invalid();
  const row = jobsOf(state, headers).find(({ order, lineNo }) => order.orderId === id[1] && lineNo === Number(id[2]));
  if (!row) return notFound();
  const { order, line } = row;
  const mode = fpScenario(headers);
  if (mode === 'conflict') return refused(409, 'conflict', 'The print job changed meanwhile; try again');
  const job = () => ({
    carrier: line.carrier ?? null, jobId: `${order.orderId}-${row.lineNo}`, lineNo: row.lineNo, orderId: order.orderId,
    state: line.state ?? null, tenantId: order.tenantId, trackingNumber: line.trackingNumber ?? null, trackingUrl: line.trackingUrl ?? null,
  });
  // decideProductionStatus
  if ((line.state ?? null) === input.state) {
    const same = (line.trackingNumber ?? null) === input.trackingNumber && (line.carrier ?? null) === input.carrier && (line.trackingUrl ?? null) === input.trackingUrl;
    return same ? json(200, { changed: false, job: job(), orderShipped: false }) : notAllowed('tracking_differs');
  }
  if (order.status === 'cancelled' || line.dispatchState === 'cancelled') return notAllowed('cancelled');
  if (order.status === 'refunded') return notAllowed('refunded');
  if (line.dispatchState !== 'accepted') return notAllowed('not_accepted');
  if (line.state && RANK[input.state] < RANK[line.state]) return notAllowed('backwards');
  if (mode === 'drop' || mode === 'unclear') return lostAnswer();

  Object.assign(line, { state: input.state, updatedAt: new Date().toISOString() });
  if (input.state === 'shipped') Object.assign(line, { trackingNumber: input.trackingNumber, trackingUrl: input.trackingUrl, carrier: input.carrier });
  // printerShippedOrderStatements: a parcel order whose every line is a printer
  // line, none unsent, open and not yet shipped, is shipped (one buyer mail).
  let orderShipped = false;
  if (input.state === 'shipped' && order.delivery === 'parcel' && ['unfulfilled', 'processing'].includes(order.fulfilment)
    && order.lines.every((l) => l.printer === true && (l.state === 'shipped' || l.dispatchState === 'cancelled'))) {
    order.fulfilment = 'shipped';
    orderShipped = true;
  }
  if (mode === 'lost') return lostAnswer();
  return json(200, { changed: true, job: job(), orderShipped });
}

function notAllowed(reason) {
  return refused(409, 'print_job_status_not_allowed', 'The print job cannot take this status', { reason });
}

export const PRINT_JOB_ROUTES = [
  ['GET', '/v1/platform/print-jobs', listJobs],
  ['POST', STATUS_PATH, setStatus],
];
