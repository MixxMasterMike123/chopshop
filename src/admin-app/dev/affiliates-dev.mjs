// The dev API's rows for the shop's affiliate program (CP13 A2), wired into
// dev-api.mjs. INVENTED data only (affiliates-fixtures.json), in the Worker's
// shapes and with its main refusals (cloudflare/src/routes/affiliate-admin.ts,
// CP13_A1_REPORT.md §4.3):
//   [gated] the list, "Bjud in", the applications (+ approve, deny), the
//           analytics and the invite re-send: the opaque 404 while the shop's
//           `affiliate` feature is off (fixtures.json)
//   open    one affiliate (GET/PATCH), revoke, adjustments, ledger, orders,
//           payouts (list, record, paid, void)
// plus the `affiliate` member of two order details (affiliateOrderDetailRoute).
// Changes are held in memory per server and shop. The figures are the
// fixture's and are NOT recomputed the Worker's way: a dev change moves the
// balance by the amount it names, nothing more.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'affiliates-fixtures.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const CODE = /^[A-Z0-9-]{3,20}$/;

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = (reason) => json(400, { error: { code: 'invalid_request', message: 'Request is not valid', ...(reason ? { reason } : {}) } });
const refused = (code) => json(409, { error: { code, message: code } });
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
// The Worker's parseText: trimmed, bounded, and NO control character (a line break included) — a 400 otherwise.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const text = (v, max) => (typeof v === 'string' && v.trim() !== '' && v.trim().length <= max && !CONTROL.test(v.trim()) ? v.trim() : null);

// The Worker's query grammars (projections.ts parseAffiliateListQuery, applications.ts
// parseApplicationListQuery, payouts.ts parsePageQuery, parseAnalyticsSince): a
// malformed query is a 400, never a quiet default.
const CURSOR = /^[^~]{1,64}~[0-9a-f-]{36}$/;
function queryOk(url, allowed, statuses = null) {
  const p = url.searchParams;
  for (const key of p.keys()) if (!allowed.includes(key) || p.getAll(key).length !== 1) return false;
  const limit = p.get('limit');
  if (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) return false;
  if (p.get('cursor') !== null && !CURSOR.test(p.get('cursor'))) return false;
  return statuses === null || p.get('status') === null || statuses.includes(p.get('status'));
}
function sinceOf(url, now = Date.now()) {
  const p = url.searchParams;
  for (const key of p.keys()) if (key !== 'since' || p.getAll(key).length !== 1) return null;
  const raw = p.get('since');
  if (raw === null) return now - 30 * DAY_MS;
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)?$/.test(raw)) return null;
  const ms = Date.parse(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw);
  return Number.isFinite(ms) && ms <= now && ms >= now - 400 * DAY_MS ? ms : null;
}
const uuid = () => crypto.randomUUID();
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function heldFor(state, tenantId) {
  state.affiliateDev ??= new Map();
  if (!state.affiliateDev.has(tenantId)) {
    const seed = structuredClone(JSON.parse(readFileSync(FIXTURES, 'utf8'))[tenantId] ?? { affiliates: [], applications: [], orderOverlay: {} });
    state.affiliateDev.set(tenantId, seed);
  }
  return state.affiliateDev.get(tenantId);
}

const switchedOn = (shop) => shop.shop.features?.affiliate === true;
const balanceOf = (a) => a.balances.find((b) => b.currency === a.currency);

function clicksByDay(a, now = Date.now()) {
  return (a.clickOffsets ?? [])
    .map(([offset, count]) => ({ day: day(now - offset * DAY_MS), count }))
    .sort((x, y) => x.day.localeCompare(y.day));
}

function detailOf(a, shop) {
  const { clickOffsets: _c, orders: _o, ledger: _l, payouts: _p, ...rest } = a;
  return {
    ...rest,
    clicksByDay: clicksByDay(a),
    links: { portalUrl: 'http://localhost/affiliate', refLink: `https://shop.example.com/${shop.shop.tenantId}/?ref=${a.code}` },
    programOn: switchedOn(shop),
  };
}

function rowOf(a) {
  const b = balanceOf(a);
  return {
    affiliateId: a.affiliateId,
    clicks30d: clicksByDay(a).reduce((sum, c) => sum + c.count, 0),
    code: a.code,
    commissionBp: a.commissionBp,
    // Accruals of the last 30 days (the Worker counts ledger rows, not the all-time figure).
    conversions30d: a.ledger.filter((l) => l.kind === 'accrual' && Date.parse(l.createdAt) >= Date.now() - 30 * DAY_MS).length,
    createdAt: a.createdAt,
    currency: a.currency,
    discountBp: a.discountBp,
    earnedMinor: b?.earnedMinor ?? 0,
    name: a.name,
    payableMinor: b?.payableMinor ?? 0,
    status: a.status,
  };
}

function newAffiliate(held, { name, email, code, commissionBp, discountBp, preferredLang, applicationId = null }) {
  const affiliate = {
    affiliateId: uuid(),
    applicationId,
    code,
    name,
    email,
    phone: null,
    address: { line1: null, line2: null, postalCode: null, city: null, country: 'SE' },
    status: 'active',
    commissionBp,
    discountBp,
    currency: 'SEK',
    preferredLang,
    promotionMethod: null,
    socials: {},
    createdAt: new Date().toISOString(),
    account: { invited: true, membership: 'active' },
    terms: { acceptedAt: null, acceptedVersion: null, currentVersion: '2026-10-22', outdated: true },
    clickOffsets: [],
    conversions: 0,
    reversedMinor: 0,
    balances: [],
    orders: [],
    ledger: [],
    payouts: [],
  };
  held.affiliates.unshift(affiliate);
  return affiliate;
}

/** The admission terms of a body (code optional, whole percent), or a 400. */
function termsOf(body, held) {
  let code = null;
  if (body.code !== undefined && body.code !== null && body.code !== '') {
    code = String(body.code).trim().toUpperCase();
    if (!CODE.test(code)) return { error: invalid('code_invalid') };
    if (['ADMIN', 'AFFILIATE', 'REF', 'TEST'].includes(code)) return { error: invalid('code_reserved') };
    if (held.affiliates.some((a) => a.code === code)) return { error: refused('code_taken') };
  }
  const percent = (v, fallback) => (v === undefined ? fallback : Number.isSafeInteger(v) && v >= 0 && v <= 100 ? v : null);
  const commission = percent(body.commissionPercent, 15);
  const discount = percent(body.discountPercent, 10);
  if (commission === null || discount === null) return { error: invalid() };
  return { code, commissionBp: commission * 100, discountBp: discount * 100 };
}

const codeFromName = (name) => `${name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X')}${uuid().slice(0, 6).toUpperCase()}`;
const admitted = (affiliate, shop, extra = {}) => json(201, { ...extra, affiliate: detailOf(affiliate, shop), invited: true, mailConfigured: false });

function find(held, id) {
  return held.affiliates.find((a) => a.affiliateId === decodeURIComponent(id)) ?? null;
}

// ── handlers ────────────────────────────────────────────────────────────────

function list(state, { shop, url }) {
  if (!switchedOn(shop)) return notFound();
  if (!queryOk(url, ['cursor', 'limit', 'status'], ['active', 'inactive', 'suspended'])) return invalid();
  return json(200, { affiliates: heldFor(state, shop.shop.tenantId).affiliates.map(rowOf), nextCursor: null });
}

function invite(state, { shop, body }) {
  if (!switchedOn(shop)) return notFound();
  if (!isObject(body)) return invalid();
  const held = heldFor(state, shop.shop.tenantId);
  const name = text(body.name, 100);
  const email = typeof body.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(body.email) ? body.email.toLowerCase() : null;
  if (!name || !email) return invalid();
  if (held.affiliates.some((a) => a.email === email)) return refused('already_affiliate');
  if (email.endsWith('@admin.example.com') || email === 'admin@example.com') return refused('not_addable');
  const terms = termsOf(body, held);
  if (terms.error) return terms.error;
  const affiliate = newAffiliate(held, { name, email, code: terms.code ?? codeFromName(name), ...terms, preferredLang: body.preferredLang === 'en' ? 'en' : 'sv' });
  return admitted(affiliate, shop);
}

function applications(state, { shop, url }) {
  if (!switchedOn(shop)) return notFound();
  if (!queryOk(url, ['cursor', 'limit', 'status'], ['pending', 'approved', 'denied'])) return invalid();
  const status = url.searchParams.get('status');
  const rows = heldFor(state, shop.shop.tenantId).applications
    .filter((a) => status === null || a.status === status)
    .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  return json(200, { applications: rows, nextCursor: null });
}

function application(state, { shop, segments: [id] }) {
  if (!switchedOn(shop)) return notFound();
  const row = heldFor(state, shop.shop.tenantId).applications.find((a) => a.applicationId === decodeURIComponent(id));
  return row ? json(200, { application: row }) : notFound();
}

function approve(state, { shop, body, segments: [id] }) {
  if (!switchedOn(shop)) return notFound();
  const held = heldFor(state, shop.shop.tenantId);
  const app = held.applications.find((a) => a.applicationId === decodeURIComponent(id));
  if (!app) return notFound();
  if (app.status !== 'pending') return refused('already_decided');
  const terms = termsOf(isObject(body) ? body : {}, held);
  if (terms.error) return terms.error;
  const affiliate = newAffiliate(held, {
    name: app.name, email: app.email, code: terms.code ?? codeFromName(app.name), ...terms, preferredLang: app.preferredLang, applicationId: app.applicationId,
  });
  Object.assign(affiliate, { phone: app.phone, socials: app.socials, promotionMethod: app.promotionMethod });
  Object.assign(app, { status: 'approved', decidedAt: new Date().toISOString(), affiliateId: affiliate.affiliateId });
  return admitted(affiliate, shop, { application: app });
}

function deny(state, { shop, body, segments: [id] }) {
  if (!switchedOn(shop)) return notFound();
  const app = heldFor(state, shop.shop.tenantId).applications.find((a) => a.applicationId === decodeURIComponent(id));
  if (!app) return notFound();
  // The Worker's parseMessage: line breaks are allowed in a denial, other control characters are not.
  const raw = isObject(body) && typeof body.reason === 'string' ? body.reason.trim() : '';
  const reason = raw !== '' && raw.length <= 500 && !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(raw) ? raw : null;
  if (!reason) return invalid();
  if (app.status !== 'pending') return refused('already_decided');
  Object.assign(app, { status: 'denied', decidedAt: new Date().toISOString(), decisionReason: reason });
  return json(200, { application: app });
}

function analytics(state, { shop, url }) {
  if (!switchedOn(shop)) return notFound();
  const since = sinceOf(url);
  if (since === null) return invalid();
  const sinceDay = day(since);
  const sinceIso = new Date(since).toISOString();
  const all = heldFor(state, shop.shop.tenantId).affiliates;
  const ranking = all.map((a) => ({
    affiliateId: a.affiliateId,
    code: a.code,
    name: a.name,
    clicks: clicksByDay(a).filter((c) => c.day >= sinceDay).reduce((sum, c) => sum + c.count, 0),
    conversions: a.ledger.filter((l) => l.kind === 'accrual' && l.createdAt >= sinceIso).length,
    commissionMinor: a.ledger.filter((l) => (l.kind === 'accrual' || l.kind === 'reversal') && l.createdAt >= sinceIso).reduce((sum, l) => sum + l.amountMinor, 0),
  }));
  return json(200, {
    analytics: {
      since: sinceIso,
      currency: 'SEK',
      activeAffiliates: all.filter((a) => a.status === 'active').length,
      clicks: ranking.reduce((sum, r) => sum + r.clicks, 0),
      conversions: ranking.reduce((sum, r) => sum + r.conversions, 0),
      commissionMinor: ranking.reduce((sum, r) => sum + r.commissionMinor, 0),
      unpaidMinor: all.reduce((sum, a) => sum + (balanceOf(a)?.balanceMinor ?? 0), 0),
      ranking,
    },
  });
}

function readOne(state, { shop, segments: [id] }) {
  const a = find(heldFor(state, shop.shop.tenantId), id);
  return a ? json(200, { affiliate: detailOf(a, shop) }) : notFound();
}

const PATCH_KEYS = ['addressLine1', 'addressLine2', 'city', 'code', 'commissionPercent', 'country', 'discountPercent', 'name', 'phone', 'postalCode', 'preferredLang', 'promotionMethod', 'socials', 'status'];

function patch(state, { shop, body, segments: [id] }) {
  const held = heldFor(state, shop.shop.tenantId);
  const a = find(held, id);
  if (!a) return notFound();
  if (!isObject(body) || Object.keys(body).length === 0 || Object.keys(body).some((k) => !PATCH_KEYS.includes(k))) return invalid();
  if ('code' in body) {
    const code = String(body.code).trim().toUpperCase();
    if (!CODE.test(code)) return invalid('code_invalid');
    if (held.affiliates.some((x) => x !== a && x.code === code)) return refused('code_taken');
    a.code = code;
  }
  if ('status' in body) {
    if (!['active', 'inactive', 'suspended'].includes(body.status)) return invalid();
    a.status = body.status;
    if (body.status === 'active' && a.account.membership === 'revoked') a.account.membership = 'active';
  }
  for (const [key, field] of [['commissionPercent', 'commissionBp'], ['discountPercent', 'discountBp']]) {
    if (key in body) {
      if (!Number.isSafeInteger(body[key]) || body[key] < 0 || body[key] > 100) return invalid();
      a[field] = body[key] * 100;
    }
  }
  if ('name' in body) a.name = text(body.name, 100) ?? a.name;
  if ('phone' in body) a.phone = body.phone;
  for (const [key, field] of [['addressLine1', 'line1'], ['addressLine2', 'line2'], ['postalCode', 'postalCode'], ['city', 'city'], ['country', 'country']]) {
    if (key in body) a.address[field] = body[key];
  }
  if ('socials' in body) a.socials = isObject(body.socials) ? body.socials : {};
  if ('promotionMethod' in body) a.promotionMethod = body.promotionMethod;
  if ('preferredLang' in body) a.preferredLang = body.preferredLang;
  return json(200, { affiliate: detailOf(a, shop) });
}

function resend(state, { shop, segments: [id] }) {
  if (!switchedOn(shop)) return notFound();
  const a = find(heldFor(state, shop.shop.tenantId), id);
  if (!a) return notFound();
  return a.account.invited ? json(202, { mailConfigured: false }) : refused('not_invited');
}

function revoke(state, { shop, segments: [id] }) {
  const a = find(heldFor(state, shop.shop.tenantId), id);
  if (!a) return notFound();
  a.status = 'inactive';
  a.account.membership = 'revoked';
  return json(200, { affiliate: detailOf(a, shop) });
}

function ensureBalance(a) {
  if (!balanceOf(a)) a.balances.push({ currency: a.currency, balanceMinor: 0, earnedMinor: 0, heldMinor: 0, paidMinor: 0, payableMinor: 0, requestedMinor: 0 });
  return balanceOf(a);
}

function adjust(state, { shop, body, segments: [id] }) {
  const a = find(heldFor(state, shop.shop.tenantId), id);
  if (!a) return notFound();
  const reason = isObject(body) ? text(body.reason, 500) : null;
  if (!reason || !Number.isSafeInteger(body.amountMinor) || body.amountMinor === 0) return invalid();
  const entry = { entryId: uuid(), kind: 'adjustment', amountMinor: body.amountMinor, currency: a.currency, availableAt: null, orderNumber: null, reason, createdAt: new Date().toISOString() };
  a.ledger.unshift(entry);
  const b = ensureBalance(a);
  b.balanceMinor += body.amountMinor;
  b.payableMinor = Math.max(0, b.balanceMinor - b.heldMinor);
  return json(201, { entry });
}

const page = (key, rows) => ({ [key]: rows, nextCursor: null });

const pageOk = (url) => queryOk(url, ['cursor', 'limit']);

function ledger(state, { shop, url, segments: [id] }) {
  const a = find(heldFor(state, shop.shop.tenantId), id);
  if (a && !pageOk(url)) return invalid();
  return a ? json(200, page('entries', a.ledger)) : notFound();
}

function orders(state, { shop, url, segments: [id] }) {
  const a = find(heldFor(state, shop.shop.tenantId), id);
  if (a && !pageOk(url)) return invalid();
  return a ? json(200, page('orders', a.orders)) : notFound();
}

function payouts(state, { shop, url, segments: [id] }) {
  const a = find(heldFor(state, shop.shop.tenantId), id);
  if (a && !pageOk(url)) return invalid();
  return a ? json(200, { balances: a.balances, payouts: a.payouts, nextCursor: null }) : notFound();
}

function record(state, { shop, body, segments: [id] }) {
  const a = find(heldFor(state, shop.shop.tenantId), id);
  if (!a) return notFound();
  if (!isObject(body) || !Number.isSafeInteger(body.amountMinor) || body.amountMinor <= 0) return invalid();
  for (const [key, max] of [['invoiceNumber', 50], ['reference', 100], ['notes', 1000]]) {
    if (body[key] !== undefined && body[key] !== null && text(body[key], max) === null) return invalid();
  }
  if (a.payouts.some((p) => p.status === 'requested')) return refused('payout_open');
  const b = ensureBalance(a);
  if (body.amountMinor > b.payableMinor) return refused('insufficient_balance');
  const now = new Date().toISOString();
  const payout = {
    payoutId: uuid(), status: 'paid', amountMinor: body.amountMinor, currency: a.currency, requestedAt: now, paidAt: now,
    reference: body.reference ?? null, invoiceNumber: body.invoiceNumber ?? null, invoiceObjectId: body.invoiceObjectId ?? null,
    notes: body.notes ?? null, voidedAt: null, voidReason: null,
  };
  a.payouts.unshift(payout);
  a.ledger.unshift({ entryId: uuid(), kind: 'payout', amountMinor: -body.amountMinor, currency: a.currency, availableAt: null, orderNumber: null, reason: null, createdAt: now });
  b.balanceMinor -= body.amountMinor;
  b.paidMinor += body.amountMinor;
  b.payableMinor -= body.amountMinor;
  return json(201, { payout });
}

function payoutById(state, shop, id) {
  for (const a of heldFor(state, shop.shop.tenantId).affiliates) {
    const p = a.payouts.find((x) => x.payoutId === decodeURIComponent(id));
    if (p) return { a, p };
  }
  return null;
}

function paid(state, { shop, body, segments: [id] }) {
  const hit = payoutById(state, shop, id);
  if (!hit) return notFound();
  for (const [key, max] of [['reference', 100], ['notes', 1000]]) {
    if (isObject(body) && body[key] !== undefined && body[key] !== null && text(body[key], max) === null) return invalid();
  }
  if (hit.p.status !== 'requested') return refused('payout_not_open');
  const b = ensureBalance(hit.a);
  Object.assign(hit.p, { status: 'paid', paidAt: new Date().toISOString(), reference: body?.reference ?? null, notes: body?.notes ?? hit.p.notes });
  b.requestedMinor -= hit.p.amountMinor;
  b.paidMinor += hit.p.amountMinor;
  return json(200, { payout: hit.p });
}

function voided(state, { shop, body, segments: [id] }) {
  const hit = payoutById(state, shop, id);
  if (!hit) return notFound();
  const reason = isObject(body) ? text(body.reason, 500) : null;
  if (!reason) return invalid();
  if (hit.p.status !== 'requested') return refused('payout_not_open');
  const now = new Date().toISOString();
  Object.assign(hit.p, { status: 'void', voidedAt: now, voidReason: reason });
  hit.a.ledger.unshift({ entryId: uuid(), kind: 'payout_void', amountMinor: hit.p.amountMinor, currency: hit.p.currency, availableAt: null, orderNumber: null, reason: null, createdAt: now });
  const b = ensureBalance(hit.a);
  b.requestedMinor -= hit.p.amountMinor;
  b.balanceMinor += hit.p.amountMinor;
  b.payableMinor += hit.p.amountMinor;
  return json(200, { payout: hit.p });
}

const ONE = /^\/v1\/admin\/affiliates\/([0-9a-f-]{36})$/;
const OF = (rest) => new RegExp(`^/v1/admin/affiliates/([0-9a-f-]{36})/${rest}$`);
const APP = (rest = '') => new RegExp(`^/v1/admin/affiliates/applications/([0-9a-f-]{36})${rest}$`);
const PAYOUT = (rest) => new RegExp(`^/v1/admin/affiliates/payouts/([0-9a-f-]{36})/${rest}$`);

export const AFFILIATE_ROUTES = [
  ['GET', '/v1/admin/affiliates', list],
  ['POST', '/v1/admin/affiliates', invite],
  ['GET', '/v1/admin/affiliates/applications', applications],
  ['GET', '/v1/admin/affiliates/analytics', analytics],
  ['GET', APP(), application],
  ['POST', APP('/approve'), approve],
  ['POST', APP('/deny'), deny],
  ['POST', PAYOUT('paid'), paid],
  ['POST', PAYOUT('void'), voided],
  ['GET', ONE, readOne],
  ['PATCH', ONE, patch],
  ['POST', OF('invite'), resend],
  ['POST', OF('revoke'), revoke],
  ['POST', OF('adjustments'), adjust],
  ['GET', OF('ledger'), ledger],
  ['GET', OF('orders'), orders],
  ['GET', OF('payouts'), payouts],
  ['POST', OF('payouts'), record],
];

/**
 * The order detail of the dev API with the `affiliate` member of the
 * contract (CP13_A1_REPORT.md §4.4) on the orders the fixture names: the
 * order route's own answer, with the member added. Placed before the order
 * routes in dev-api.mjs.
 */
export function affiliateOrderDetailRoute(orderRoutes) {
  const original = orderRoutes.find(([method, pattern]) => method === 'GET' && pattern instanceof RegExp && pattern.test('/v1/admin/orders/0a000000-0000-4000-8000-000000000001'));
  const pattern = original?.[1] ?? /^\/v1\/admin\/orders\/([^/]+)$/;
  return ['GET', pattern, (state, ctx) => {
    const answer = original ? original[2](state, ctx) : notFound();
    if (answer.status !== 200 || !answer.body?.order) return answer;
    const member = heldFor(state, ctx.shop.shop.tenantId).orderOverlay?.[answer.body.order.orderId] ?? null;
    return { ...answer, body: { ...answer.body, order: { ...answer.body.order, affiliate: member } } };
  }];
}
