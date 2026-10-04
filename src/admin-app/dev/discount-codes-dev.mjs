// The dev API's rows for the shop's discount codes (CP8-DC), wired into
// dev-api.mjs. INVENTED data only (discount-codes-fixtures.json), in the
// Worker's shapes and with its refusals (cloudflare/src/app.ts
// handleAdminDiscountCodeRoute, cloudflare/src/commerce/admin-discount-codes.ts):
//   GET   /v1/admin/discount-codes       { discountCodes, truncated }, newest first
//   POST  /v1/admin/discount-codes       201 { discountCode } · 400 · 409 conflict
//   GET   /v1/admin/discount-codes/:id   { discountCode } · 404
//   PATCH /v1/admin/discount-codes/:id   { discountCode } · 400 · 404 · 409 conflict | discount_code_in_use
// No DELETE. Every route is the opaque 404 while the shop's `discountCodes`
// feature is off (fixtures.json), as the Worker's are (DC14). The admin guard
// (a membership or an open acting-as grant of X-Shop-Id) is dev-api.mjs's.
// Changes are held in memory per server and shop.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'discount-codes-fixtures.json');
const KEYS = ['active', 'code', 'endsAt', 'maxUses', 'minSpendMinor', 'percentBp', 'productIds', 'scope', 'startsAt', 'type', 'valueMinor'];
const CODE_SHAPE = /^[^\s\u0000-\u001f\u007f-\u009f]{1,50}$/;

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });
const conflict = () => json(409, { error: { code: 'conflict', message: 'Request conflicts with the current discount code state' } });
const inUse = () => json(409, { error: { code: 'discount_code_in_use', message: 'The discount code has been used and keeps its name' } });
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function heldFor(state, shopId) {
  state.dcCodes ??= new Map();
  if (!state.dcCodes.has(shopId)) {
    const rows = structuredClone(JSON.parse(readFileSync(FIXTURES, 'utf8'))[shopId] ?? []);
    state.dcCodes.set(shopId, new Map(rows.map((row) => [row.discountCodeId, row])));
  }
  return state.dcCodes.get(shopId);
}

const publicShape = ({ createdAt: _createdAt, ...code }) => ({ ...code });
const switchedOn = (shop) => shop.shop.features?.discountCodes === true;

/** The Worker's merge and coherence rules, in short; null = 400. */
function merged(current, body) {
  if (!isObject(body) || Object.keys(body).length === 0 || Object.keys(body).some((k) => !KEYS.includes(k))) return null;
  const next = { ...current, ...body };
  if (typeof next.code !== 'string') return null;
  next.code = next.code.trim().toUpperCase();
  if (!CODE_SHAPE.test(next.code)) return null;
  if (next.type === 'fixed') {
    next.percentBp = null;
    if (!Number.isSafeInteger(next.valueMinor) || next.valueMinor < 1) return null;
  } else if (next.type === 'percent') {
    next.valueMinor = null;
    if (!Number.isSafeInteger(next.percentBp) || next.percentBp < 1 || next.percentBp > 10_000) return null;
  } else {
    return null;
  }
  if (next.scope === 'all') next.productIds = null;
  else if (next.scope !== 'products' || !Array.isArray(next.productIds) || next.productIds.length === 0) return null;
  if (next.startsAt != null && next.endsAt != null && next.endsAt < next.startsAt) return null;
  next.active = next.active !== false;
  return next;
}

function list(state, { shop }) {
  if (!switchedOn(shop)) return notFound();
  const rows = [...heldFor(state, shop.shop.tenantId).values()].sort((a, b) => b.createdAt - a.createdAt);
  return json(200, { discountCodes: rows.slice(0, 200).map(publicShape), truncated: rows.length > 200 });
}

function create(state, { shop, body }) {
  if (!switchedOn(shop)) return notFound();
  const next = merged({ active: true, endsAt: null, maxUses: null, minSpendMinor: null, productIds: null, startsAt: null }, body);
  if (next === null || !isObject(body) || typeof body.type !== 'string' || typeof body.scope !== 'string') return invalid();
  const held = heldFor(state, shop.shop.tenantId);
  if ([...held.values()].some((row) => row.code === next.code)) return conflict();
  const row = { ...next, createdAt: Date.now(), discountCodeId: `dc-dev-${Date.now().toString(36)}`, heldCount: 0, usedCount: 0 };
  held.set(row.discountCodeId, row);
  return json(201, { discountCode: publicShape(row) });
}

function readOne(state, { shop, segments: [id] }) {
  if (!switchedOn(shop)) return notFound();
  const row = heldFor(state, shop.shop.tenantId).get(decodeURIComponent(id));
  return row ? json(200, { discountCode: publicShape(row) }) : notFound();
}

function patch(state, { shop, body, segments: [id] }) {
  if (!switchedOn(shop)) return notFound();
  const held = heldFor(state, shop.shop.tenantId);
  const current = held.get(decodeURIComponent(id));
  if (!current) return notFound();
  const next = merged(current, body);
  if (next === null) return invalid();
  if (next.code !== current.code && (current.usedCount > 0 || current.heldCount > 0)) return inUse();
  if ([...held.values()].some((row) => row.discountCodeId !== current.discountCodeId && row.code === next.code)) return conflict();
  held.set(current.discountCodeId, next);
  return json(200, { discountCode: publicShape(next) });
}

const ONE = /^\/v1\/admin\/discount-codes\/([^/]+)$/;

export const DISCOUNT_CODE_ROUTES = [
  ['GET', '/v1/admin/discount-codes', list],
  ['POST', '/v1/admin/discount-codes', create],
  ['GET', ONE, readOne],
  ['PATCH', ONE, patch],
];
