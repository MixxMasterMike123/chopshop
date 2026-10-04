// The dev API's rows for the platform console's printers (unit FK), wired into
// dev-api.mjs. INVENTED data only (printers-fixtures.json), in the Worker's
// shapes and with its refusals (cloudflare/src/routes/pod-platform.ts,
// cloudflare/src/pod/printers.ts, print-defaults.ts):
//   GET   /v1/platform/printers[?cursor&limit≤50]   → { printers, nextCursor, defaultPrinterId }
//   GET   /v1/platform/printers/:id                 → { printer }   (unit CP5-FP: the save's read-back)
//   PATCH /v1/platform/printers/:id                 → { printer, diff, suspendedMappings }
//   PATCH /v1/platform/printers/:id { …, dryRun: true } → { dryRun: true, diff, revision, suspendedMappings }
//                                                     (CP5-WK: nothing written; unit CP5-FP)
//   PUT   /v1/platform/printers/default             → { defaultPrinter }
// This dev environment plays staging: its dispatch target is `fake-printer`,
// so an `api` printer with another id is refused (printer_not_allowed), as
// staging refuses the imported, inactive supplier printer. The floor report
// is not computed here (always 0) unless the `floor` scenario is on. Changes
// are held in memory per server (state.fk), over the fixtures.
//
// Scenarios, by the cookie `admin_dev_fk` (in the browser console:
// document.cookie = 'admin_dev_fk=empty; path=/'; remove it with Max-Age=0):
//   empty   no printers
//   error   the list answers 500
//   dark    every printer route answers the opaque 404 (no dispatch target)
//   floor   a save reports two products under the price floor
// and, by the cookie `admin_dev_fp` (fp-dev.mjs): `moved`: another operator
// edits the printer right after a dry run (once: its revision moves); `lost`:
// a real save is made but its answer is lost (502).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fpScenario } from './fp-dev.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'printers-fixtures.json');
const TARGET = 'fake-printer';
const SLOTS = ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve'];
const PATCH_KEYS = ['capabilities', 'expectedRevision', 'name', 'shippingCostMinor', 'status', 'tiers'];
const MAX_COST_MINOR = 10_000_000;
const MAX_AREA_MM = 2_000;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY = /^[A-Za-z0-9._-]{1,64}$/;

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });
const refused = (status, code, message, problems) =>
  json(status, { error: problems ? { code, message, problems } : { code, message } });

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
const stable = (v) => JSON.stringify(v ?? null, (_k, x) => (isObject(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

function cookieOf(headers, name) {
  for (const part of (headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
const scenario = (headers) => cookieOf(headers, 'admin_dev_fk') || '';

function held(state) {
  if (!state.fk) {
    const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
    state.fk = {
      printers: new Map(fixtures.printers.map((p) => [p.printerId, structuredClone(p)])),
      defaultPrinterId: fixtures.defaultPrinterId ?? null,
      defaultUpdatedAt: '2026-10-01T08:00:00.000Z',
      mappings: structuredClone(fixtures.mappings).map((m) => ({ ...m, status: 'active' })),
    };
  }
  return state.fk;
}

// ── the capability document (printers.ts parsePrinterCapabilities) ─────────

function parseArea(v) {
  if (!isObject(v) || !onlyKeys(v, ['h', 'offsetTopMm', 'w'])) return null;
  if (!isInt(v.w, 1, MAX_AREA_MM) || !isInt(v.h, 1, MAX_AREA_MM)) return null;
  if (v.offsetTopMm === undefined) return { h: v.h, w: v.w };
  return isInt(v.offsetTopMm, 0, MAX_AREA_MM) ? { h: v.h, offsetTopMm: v.offsetTopMm, w: v.w } : null;
}

export function parseCapabilities(v) {
  if (!isObject(v) || !onlyKeys(v, ['models', 'skus']) || !isObject(v.models) || !isObject(v.skus)) return null;
  const models = {};
  for (const [key, m] of Object.entries(v.models)) {
    if (!KEY.test(key) || !isObject(m) || !onlyKeys(m, ['garment', 'name', 'printAreasMm', 'provisional'])) return null;
    if (m.garment !== null && (typeof m.garment !== 'string' || m.garment.length < 1 || m.garment.length > 40)) return null;
    if (m.name !== undefined && (typeof m.name !== 'string' || m.name.length < 1 || m.name.length > 200)) return null;
    if (!isObject(m.printAreasMm) || (m.provisional !== undefined && typeof m.provisional !== 'boolean')) return null;
    const areas = {};
    for (const [slot, raw] of Object.entries(m.printAreasMm)) {
      const area = parseArea(raw);
      if (!SLOTS.includes(slot) || area === null) return null;
      areas[slot] = area;
    }
    models[key] = {
      garment: m.garment,
      ...(m.name === undefined ? {} : { name: m.name }),
      printAreasMm: areas,
      ...(m.provisional === true ? { provisional: true } : {}),
    };
  }
  const skus = {};
  for (const [sku, entry] of Object.entries(v.skus)) {
    if (!KEY.test(sku) || !isObject(entry) || !onlyKeys(entry, ['label', 'model'])) return null;
    if (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label.length < 1)) return null;
    if (typeof entry.model !== 'string' || models[entry.model] === undefined) return null;
    skus[sku] = entry.label === undefined ? { model: entry.model } : { label: entry.label, model: entry.model };
  }
  return { models, skus };
}

function parseTier(raw) {
  if (!isObject(raw) || !onlyKeys(raw, ['blankCostMinor', 'printCostsMinor', 'sku'])) return null;
  if (typeof raw.sku !== 'string' || !KEY.test(raw.sku) || !isInt(raw.blankCostMinor, 0, MAX_COST_MINOR)) return null;
  if (!isObject(raw.printCostsMinor)) return null;
  for (const [slot, cost] of Object.entries(raw.printCostsMinor)) {
    if (!SLOTS.includes(slot) || !isInt(cost, 0, MAX_COST_MINOR)) return null;
  }
  return { sku: raw.sku, blankCostMinor: raw.blankCostMinor, printCostsMinor: { ...raw.printCostsMinor } };
}

/** printers.ts parsePrinterPatchInput: → { edit, expectedRevision? } or null. */
export function parsePatch(body) {
  if (!isObject(body) || !onlyKeys(body, PATCH_KEYS)) return null;
  const edit = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 200) return null;
    edit.name = body.name;
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'inactive') return null;
    edit.status = body.status;
  }
  if (body.shippingCostMinor !== undefined) {
    if (!isInt(body.shippingCostMinor, 0, MAX_COST_MINOR)) return null;
    edit.shippingCostMinor = body.shippingCostMinor;
  }
  if (body.capabilities !== undefined) {
    const caps = parseCapabilities(body.capabilities);
    if (caps === null) return null;
    edit.capabilities = caps;
  }
  if (body.tiers !== undefined) {
    const t = body.tiers;
    if (!isObject(t) || !onlyKeys(t, ['remove', 'upsert'])) return null;
    const remove = t.remove ?? [];
    const upsertRaw = t.upsert ?? [];
    if (!Array.isArray(remove) || !Array.isArray(upsertRaw)) return null;
    if (remove.some((s) => typeof s !== 'string' || !KEY.test(s)) || new Set(remove).size !== remove.length) return null;
    const upsert = upsertRaw.map(parseTier);
    if (upsert.some((x) => x === null) || new Set(upsert.map((x) => x.sku)).size !== upsert.length) return null;
    if (upsert.length === 0 && remove.length === 0) return null;
    edit.tiers = { remove, upsert };
  }
  if (Object.keys(edit).length === 0) return null;
  if (body.expectedRevision === undefined) return { edit };
  return isInt(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER) ? { edit, expectedRevision: body.expectedRevision } : null;
}

// ── the views ───────────────────────────────────────────────────────────────

function viewOf(fk, p) {
  return {
    ...structuredClone(p),
    capabilitiesValid: parseCapabilities(p.capabilities) !== null,
    isDefault: fk.defaultPrinterId === p.printerId,
    tiers: [...p.tiers].sort((a, b) => (a.sku < b.sku ? -1 : 1)).map((t) => ({
      ...structuredClone(t), createdAt: p.createdAt, updatedAt: p.updatedAt,
    })),
  };
}

function keyDiff(before, after) {
  const diff = { added: [], changed: [], removed: [] };
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) diff.added.push(k);
    else if (stable(before[k]) !== stable(v)) diff.changed.push(k);
  }
  for (const k of Object.keys(before)) if (!(k in after)) diff.removed.push(k);
  return diff;
}

/** printers.ts mappingSuspendReason, in short: SKU gone, no tier, or a slot without a frame. */
function suspendReason(caps, tiers, mapping) {
  const sku = caps.skus[mapping.sku];
  if (!sku) return 'sku_unavailable';
  if (!tiers.has(mapping.sku)) return 'unpriced';
  const areas = caps.models[sku.model]?.printAreasMm ?? {};
  const printable = (slot) => (slot === 'pocket' ? Boolean(areas.front || areas.pocket) : Boolean(areas[slot]));
  return mapping.slots.every(printable) ? null : 'slot_not_printable';
}

// ── the routes ──────────────────────────────────────────────────────────────

const PRINTER = /^\/v1\/platform\/printers\/([^/]+)$/;

function list(state, { url, headers }) {
  const fk = held(state);
  if (scenario(headers) === 'error') return refused(500, 'internal_error', 'Something went wrong');
  for (const key of url.searchParams.keys()) if (key !== 'cursor' && key !== 'limit') return invalid();
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && !ID.test(cursor)) return invalid();
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 20 : (/^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN);
  if (!(limit >= 1 && limit <= 50)) return invalid();
  const all = scenario(headers) === 'empty' ? [] : [...fk.printers.values()].sort((a, b) => (a.printerId < b.printerId ? -1 : 1));
  const rest = all.filter((p) => p.printerId > (cursor ?? ''));
  const page = rest.slice(0, limit);
  return json(200, {
    printers: page.map((p) => viewOf(fk, p)),
    nextCursor: rest.length > limit ? page.at(-1).printerId : null,
    defaultPrinterId: fk.defaultPrinterId,
  });
}

function putDefault(state, { body }) {
  const fk = held(state);
  if (!isObject(body) || Object.keys(body).join() !== 'printerId') return invalid();
  const id = body.printerId;
  if (id !== null && (typeof id !== 'string' || !ID.test(id) || id === 'default')) return invalid();
  if (id !== null) {
    const p = fk.printers.get(id);
    if (!p) return refused(422, 'printer_not_found', 'The default printer must exist and be active');
    if (p.tenantId !== null) return refused(422, 'tenant_printer', 'A tenant printer cannot be the platform default');
    if (p.status !== 'active') return refused(422, 'printer_inactive', 'The default printer must exist and be active');
  }
  fk.defaultPrinterId = id;
  fk.defaultUpdatedAt = new Date().toISOString();
  return json(200, {
    defaultPrinter: {
      printerId: id,
      printerActive: id === null ? null : fk.printers.get(id).status === 'active',
      updatedAt: fk.defaultUpdatedAt,
      updatedBy: 'dev-platform-user',
    },
  });
}

function getOne(state, { segments }) {
  const fk = held(state);
  const printerId = decodeURIComponent(segments[0]);
  const p = ID.test(printerId) && printerId !== 'default' ? fk.printers.get(printerId) : null;
  return p ? json(200, { printer: viewOf(fk, p) }) : notFound();
}

function patch(state, { segments, body, headers }) {
  const fk = held(state);
  const printerId = decodeURIComponent(segments[0]);
  if (!ID.test(printerId) || printerId === 'default') return notFound();
  const p = fk.printers.get(printerId);
  // pod-platform.ts dryRunFlag: a boolean, default false; anything else is a 400.
  if (isObject(body) && Object.hasOwn(body, 'dryRun') && typeof body.dryRun !== 'boolean') return invalid();
  const dryRun = isObject(body) && body.dryRun === true;
  const input = parsePatch(isObject(body) ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'dryRun')) : body);
  if (input === null) return invalid();
  if (!p) return notFound();
  if (p.tenantId !== null) return refused(409, 'tenant_printer', 'Tenant printers are not edited here');
  if (input.expectedRevision !== undefined && input.expectedRevision !== p.revision) {
    return refused(409, 'revision_mismatch', 'The printer is no longer at the expected revision');
  }
  const current = parseCapabilities(p.capabilities);
  const caps = input.edit.capabilities ?? current;
  if (caps === null) {
    return refused(400, 'invalid_capabilities', 'The edit cannot be applied', ['the stored capability document is not valid; send a complete `capabilities`']);
  }
  const before = new Map(p.tiers.map((t) => [t.sku, t]));
  const next = new Map(before);
  const problems = [];
  for (const sku of input.edit.tiers?.remove ?? []) {
    if (!before.has(sku)) problems.push(`tiers.remove: ${sku} has no tier`);
    next.delete(sku);
  }
  const removing = new Set(input.edit.tiers?.remove ?? []);
  for (const tier of input.edit.tiers?.upsert ?? []) {
    if (removing.has(tier.sku)) problems.push(`tiers: ${tier.sku} is both upserted and removed`);
    if (!caps.skus[tier.sku]) problems.push(`tier ${tier.sku}: the printer does not list that SKU`);
    next.set(tier.sku, tier);
  }
  for (const sku of [...next.keys()]) if (!caps.skus[sku]) next.delete(sku);
  if (problems.length) return refused(400, 'invalid_tiers', 'The edit cannot be applied', problems);

  const ok = p.type === 'manual' ? !['fake-printer', 'snapwear'].includes(p.printerId) : p.printerId === TARGET;
  if (!ok) {
    return refused(400, 'printer_not_allowed', 'The edit cannot be applied', [
      p.type === 'api'
        ? `an api printer must be this environment's dispatch target (${TARGET}) and list only SnapWear SKUs`
        : "a manual printer may not use a dispatch target's id",
    ]);
  }

  const suspensions = [];
  for (const m of fk.mappings) {
    if (m.printerId !== printerId || m.status !== 'active') continue;
    const reason = suspendReason(caps, next, m);
    if (reason === null) continue;
    suspensions.push({ mappingId: m.mappingId, productId: m.productId, reason, sku: m.sku, tenantId: m.tenantId });
  }

  const fields = [];
  const status = input.edit.status ?? p.status;
  if (input.edit.name !== undefined && input.edit.name !== p.name) fields.push('name');
  if (status !== p.status) fields.push('status');
  if (input.edit.shippingCostMinor !== undefined && input.edit.shippingCostMinor !== p.shippingCostMinor) fields.push('shippingCostMinor');
  if (stable(caps) !== stable(current)) fields.push('capabilities');
  const diff = {
    belowFloor: scenario(headers) === 'floor' && status === 'active'
      ? { count: 2, products: [
        { live: true, newFloorMinor: 27900, priceMinor: 24900, productId: 'prod-dev-1', tenantId: 'test-shop-a', variantId: null },
        { live: false, newFloorMinor: 52900, priceMinor: 49900, productId: 'prod-dev-2', tenantId: 'test-shop-a', variantId: 'var-dev-2-m' },
      ] }
      : { count: 0, products: [] },
    fields,
    models: keyDiff(current?.models ?? {}, caps.models),
    skus: keyDiff(current?.skus ?? {}, caps.skus),
    suspensions,
    tiers: keyDiff(Object.fromEntries(before), Object.fromEntries(next)),
    unpricedSkus: Object.keys(caps.skus).filter((sku) => !next.has(sku)).sort(),
  };

  if (dryRun) {
    const answer = json(200, { diff, dryRun: true, revision: p.revision, suspendedMappings: suspensions.length });
    // Another operator saves the printer right after this preview (once).
    if (fpScenario(headers) === 'moved' && !fk.movedDone) {
      fk.movedDone = true;
      Object.assign(p, { revision: p.revision + 1, updatedAt: new Date().toISOString() });
    }
    return answer;
  }
  for (const s of suspensions) fk.mappings.find((m) => m.mappingId === s.mappingId).status = 'suspended';
  Object.assign(p, {
    capabilities: caps,
    name: input.edit.name ?? p.name,
    revision: p.revision + 1,
    shippingCostMinor: input.edit.shippingCostMinor ?? p.shippingCostMinor,
    status,
    tiers: [...next.values()],
    updatedAt: new Date().toISOString(),
  });
  if (fpScenario(headers) === 'lost') return json(502, { error: { code: 'bad_gateway', message: 'The answer was lost on the way (dev scenario)' } });
  return json(200, { diff, printer: viewOf(fk, p), suspendedMappings: suspensions.length });
}

/** The dark scenario: every printer route is the opaque 404 (an environment without a dispatch target). */
const lit = (handler) => (state, ctx) => (scenario(ctx.headers) === 'dark' ? notFound() : handler(state, ctx));

export const PRINTER_ROUTES = [
  ['GET', '/v1/platform/printers', lit(list)],
  ['PUT', '/v1/platform/printers/default', lit(putDefault)],
  ['GET', PRINTER, lit(getOne)],
  ['PATCH', PRINTER, lit(patch)],
];
