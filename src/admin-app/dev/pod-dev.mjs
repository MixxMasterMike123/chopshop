// The dev API's POD rows (unit FM): the artwork library, the print profiles,
// the printers a shop may map to, the mappings and the two quotes, in the
// Worker's shapes (cloudflare/src/app.ts handleAdminPodRoute,
// src/routes/pod-artwork.ts, src/routes/pod-admin.ts; CP5_WG_REPORT.md).
// INVENTED DATA ONLY (pod-fixtures.json).
//
// State lives in memory per dev server (seeded once per shop from
// pod-fixtures.json). The products and the uploaded objects are unit FC's
// (products-dev.mjs, `state.fcCatalogue`): this module reads them, and keeps
// that catalogue's POD quotes in step with the mappings so the product form
// shows the same numbers. THE SELLER SEES ONE NUMBER: the fixtures' prices
// stay here; every answer carries `inkopMinor` and `priceFloorMinor` only.
//
// A render is simulated: a new artwork is `processing` for RENDER_MS, then
// its verdict follows from its name (the upload sends the file name):
//   …avvisa… / …reject…   → rejected (with a reason)
//   …misslyck… / …fail…   → the render FAILS (the row goes; the detail answers failed)
//   …långsam… / …slow…    → stays processing for ten minutes (the modal's "pending")
//   anything else          → ready (…jpg… / …ogenomskinlig… adds the opaque notice)
// The cookie `admin_dev_pod=dark` makes the profile and artwork routes the
// opaque 404 (a Worker whose POD surface is not configured);
// `admin_dev_pod=empty` starts the shop with no artwork and no mappings.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_ROUTES } from './products-dev.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'pod-fixtures.json');
export const POD_COOKIE = 'admin_dev_pod';
export const RENDER_MS = 3_000;
const SLOW_MS = 10 * 60_000;
const PRINT_SLOTS = ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve'];
const SKU_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MM_PER_INCH = 25.4;

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });
const conflict = (code, message = 'Request conflicts with the current mapping state') => json(409, { error: { code, message } });
const refused = (code, message = 'Mapping cannot be created') => json(422, { error: { code, message } });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const newId = (prefix) => `${prefix}-${randomBytes(6).toString('hex')}`;

let clock = () => Date.now();
/** Tests move the clock. */
export function setPodClock(fn) {
  clock = fn ?? (() => Date.now());
}

function cookieOf(headers, name) {
  for (const part of String(headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

const fixtures = () => JSON.parse(readFileSync(FIXTURES, 'utf8'));
const shopIdOf = (shop) => shop.shop.tenantId;

/** The shop's POD state, seeded once (again when the scenario cookie changes). */
function podOf(state, shop, headers) {
  const shopId = shopIdOf(shop);
  const scenario = cookieOf(headers, POD_COOKIE) || 'default';
  state.fmPod ??= new Map();
  const held = state.fmPod.get(shopId);
  if (held && held.scenario === scenario) return held;
  const seed = scenario === 'empty' ? {} : fixtures().shops?.[shopId] ?? {};
  const pod = {
    scenario,
    artworks: new Map((seed.artwork ?? []).map((a) => [a.artworkId, { ...structuredClone(a), updatedAt: a.createdAt, renderAt: null, fate: null }])),
    failed: new Map(),
    mappings: new Map((seed.mappings ?? []).map((m) => [m.mappingId, {
      ...structuredClone(m),
      variantId: m.variantId ?? null,
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    }])),
  };
  // The seeded originals join unit FC's uploaded objects, so the object
  // metadata route (content-dev.mjs) answers for them as for an upload.
  const objects = catalogueOf(state, shop).objects;
  for (const a of seed.artwork ?? []) {
    if (a.object && !objects.has(a.originalObjectId)) {
      objects.set(a.originalObjectId, { objectId: a.originalObjectId, status: 'active', kind: 'artwork_original', ...a.object });
    }
  }
  state.fmPod.set(shopId, pod);
  return pod;
}

/** Unit FC's catalogue of the shop (products, uploaded objects, POD quotes), seeded by its own route. */
function catalogueOf(state, shop) {
  const shopId = shopIdOf(shop);
  if (!state.fcCatalogue?.has(shopId)) {
    const [, , list] = PRODUCT_ROUTES.find(([m, p]) => m === 'GET' && p === '/v1/admin/products');
    list(state, { shop, url: new URL('http://dev.invalid/_api/v1/admin/products') });
  }
  return state.fcCatalogue.get(shopId);
}

const printers = () => fixtures().printers ?? [];
const printerOf = (printerId) => printers().find((p) => p.printerId === printerId && p.status === 'active') ?? null;

function frameOf(printer, sku, slot) {
  const entry = printer.capabilities.skus[sku];
  const model = entry ? printer.capabilities.models[entry.model] : null;
  if (!model) return null;
  if (model.printAreasMm[slot]) return model.printAreasMm[slot];
  if (slot === 'pocket' && model.printAreasMm.front) {
    return { w: Math.min(100, model.printAreasMm.front.w), h: Math.min(100, model.printAreasMm.front.h) };
  }
  return null;
}

/** The fixtures' prices → the seller's two numbers (never anything else). */
function sellerQuote(printer, sku, slots) {
  const row = printer.hiddenPrices?.[sku];
  if (!row || slots.some((s) => !Number.isSafeInteger(row.slots?.[s]))) return null;
  const inkopMinor = row.blank + slots.reduce((sum, s) => sum + row.slots[s], 0);
  const priceFloorMinor = Math.ceil((inkopMinor * 1.25 + 4_900) / 0.885 / 100) * 100;
  return { currency: printer.currency, inkopMinor, priceFloorMinor };
}

/** The Worker's sizeSlot (pod-mappings.ts): contain-fit, capped at the DPI floor; null under 1 mm. */
function sizeSlot(widthPx, heightPx, frame, minDpi = 300) {
  const aspect = widthPx / heightPx;
  const w = Math.min(Math.min(frame.w, frame.h * aspect), (widthPx / minDpi) * MM_PER_INCH);
  const widthMm = Math.floor(w);
  const heightMm = Math.floor(w / aspect);
  return widthMm >= 1 && heightMm >= 1 ? { widthMm, heightMm } : null;
}

// ── the render ──────────────────────────────────────────────────────────────

function fateOf(label) {
  const name = String(label ?? '');
  if (/avvisa|reject/i.test(name)) return 'rejected';
  if (/misslyck|fail/i.test(name)) return 'failed';
  if (/långsam|langsam|slow/i.test(name)) return 'slow';
  return 'ready';
}

/** Gives every render whose time has come its verdict. */
function settle(state, shop, pod) {
  const now = clock();
  for (const a of [...pod.artworks.values()]) {
    if (a.status !== 'processing' || a.renderAt === null || now < a.renderAt) continue;
    if (a.fate === 'failed') {
      pod.artworks.delete(a.artworkId);
      pod.failed.set(a.artworkId, { artworkId: a.artworkId });
      continue;
    }
    if (a.fate === 'rejected') {
      Object.assign(a, {
        status: 'rejected', widthPx: 640, heightPx: 480, effectiveDpi: 54, updatedAt: now,
        reasons: [{ code: 'resolution_too_low', message: 'Motivet håller bara 54 DPI i största tryckstorlek (minst 300 DPI krävs). Ladda upp originalfilen i full upplösning.' }],
      });
      continue;
    }
    const object = catalogueOf(state, shop).objects.get(a.originalObjectId);
    const opaque = /jpe?g|ogenomskinlig|opaque/i.test(String(a.label ?? '')) || /jpeg/.test(object?.contentType ?? '');
    Object.assign(a, {
      status: 'ready', widthPx: 3600, heightPx: 3600, effectiveDpi: 360, updatedAt: now,
      preview: typeof object?.url === 'string' ? object.url : null,
      notices: opaque ? [{ code: 'opaque', message: 'Bilden saknar transparent bakgrund — hela rektangeln trycks, inklusive eventuell vit bakgrund.' }] : [],
    });
  }
}

const summaryOf = (a, entry) => ({
  artworkId: a.artworkId,
  createdAt: a.createdAt,
  createdBySelf: a.createdBy !== null && a.createdBy === entry.user.id,
  effectiveDpi: a.effectiveDpi ?? null,
  heightPx: a.heightPx ?? null,
  label: a.label ?? null,
  originalObjectId: a.originalObjectId,
  profileId: a.profileId,
  rightsConfirmedAt: a.rightsConfirmedAt ?? null,
  status: a.status,
  widthPx: a.widthPx ?? null,
});

const detailOf = (a, entry) => ({
  ...summaryOf(a, entry),
  maxPrintMm: a.status === 'ready' ? { w: 250, h: 250 } : null,
  notices: structuredClone(a.notices ?? []),
  pipelineVersion: a.status === 'processing' ? null : 3,
  previewBytes: a.status === 'ready' ? 48_000 : null,
  previewSha256: null,
  printBytes: a.status === 'ready' ? 2_400_000 : null,
  printSha256: null,
  reasons: structuredClone(a.reasons ?? []),
  updatedAt: a.updatedAt ?? a.createdAt,
});

function parseLabel(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length >= 1 && t.length <= 120 && !CONTROL.test(t) ? t : undefined;
}

const ARTWORK_ITEM = /^\/v1\/admin\/pod\/artwork\/([^/]+)$/;
const MAPPING_ITEM = /^\/v1\/admin\/pod\/mappings\/([^/]+)$/;
const dark = (headers) => cookieOf(headers, POD_COOKIE) === 'dark';

// ── mappings ────────────────────────────────────────────────────────────────

const mappingView = (m) => ({
  artworkId: m.artworkId,
  createdAt: m.createdAt,
  mappingId: m.mappingId,
  printerId: m.printerId,
  productId: m.productId,
  sku: m.sku,
  slots: m.slots.map((slot) => ({ slot, widthMm: m.sizes?.[slot]?.widthMm ?? 240, heightMm: m.sizes?.[slot]?.heightMm ?? 240 })),
  status: m.status,
  suspendedReason: m.status === 'suspended' ? (m.suspendedReason === 'unpriced' ? 'sku_unavailable' : m.suspendedReason) : null,
  updatedAt: m.updatedAt,
  variantId: m.variantId ?? null,
});

const live = (record) => record.publication?.published === true && record.product.status === 'active';

/** The quote of one scope's active set (its one printer + article, the union of its slots), or null. */
function scopeQuote(pod, productId, variantId) {
  const set = [...pod.mappings.values()].filter((m) => m.status === 'active' && m.productId === productId && (m.variantId ?? null) === (variantId ?? null));
  if (set.length === 0) return null;
  const printer = printerOf(set[0].printerId);
  if (!printer) return null;
  const slots = PRINT_SLOTS.filter((s) => set.some((m) => m.slots.includes(s)));
  return sellerQuote(printer, set[0].sku, slots);
}

/** Keeps unit FC's quotes (the product form's Inköp and floor) in step with the mappings. */
function syncCatalogueQuote(cat, pod, productId) {
  const record = cat.products.get(productId);
  if (!record) return;
  const variants = {};
  for (const v of record.variants) {
    const q = scopeQuote(pod, productId, v.variantId);
    if (q) variants[v.variantId] = q;
  }
  const own = scopeQuote(pod, productId, null);
  const strictest = [own, ...Object.values(variants)].filter(Boolean).sort((a, b) => b.priceFloorMinor - a.priceFloorMinor)[0];
  if (!strictest) {
    delete cat.quotes[productId];
    return;
  }
  cat.quotes[productId] = { ...(own ?? strictest), variants };
}

// ── the routes ──────────────────────────────────────────────────────────────

export const POD_ROUTES = [
  ['GET', '/v1/admin/pod/profiles', (_state, { headers }) =>
    dark(headers) ? notFound() : json(200, { profiles: structuredClone((fixtures().profiles ?? []).filter((p) => p.active)) })],

  ['GET', '/v1/admin/pod/artwork', (state, { shop, headers, entry }) => {
    if (dark(headers)) return notFound();
    const pod = podOf(state, shop, headers);
    settle(state, shop, pod);
    const rows = [...pod.artworks.values()].sort((a, b) => b.createdAt - a.createdAt || a.artworkId.localeCompare(b.artworkId));
    return json(200, { artwork: rows.map((a) => summaryOf(a, entry)) });
  }],

  ['POST', '/v1/admin/pod/artwork', (state, { shop, headers, body, entry }) => {
    if (dark(headers)) return notFound();
    const pod = podOf(state, shop, headers);
    if (!isObj(body) || !Object.keys(body).every((k) => ['label', 'objectId', 'profileId', 'rightsConfirmed'].includes(k))) return invalid();
    if (body.rightsConfirmed !== true) return invalid();
    const label = parseLabel(body.label);
    if (label === undefined || typeof body.objectId !== 'string' || typeof body.profileId !== 'string') return invalid();
    const object = catalogueOf(state, shop).objects.get(body.objectId);
    const profile = (fixtures().profiles ?? []).find((p) => p.profileId === body.profileId && p.active);
    if (!object || object.status !== 'active' || object.kind !== 'artwork_original' || !profile) return notFound();
    if ([...pod.artworks.values()].some((a) => a.originalObjectId === body.objectId && a.profileId === body.profileId)) {
      return json(409, { error: { code: 'conflict', message: 'Artwork already exists for this original and profile' } });
    }
    const now = clock();
    const fate = fateOf(label);
    const artwork = {
      artworkId: newId('art'), label, profileId: body.profileId, status: 'processing',
      widthPx: null, heightPx: null, effectiveDpi: null, originalObjectId: body.objectId,
      createdAt: now, updatedAt: now, rightsConfirmedAt: now, createdBy: entry.user.id,
      notices: [], reasons: [], preview: null, fate, renderAt: now + (fate === 'slow' ? SLOW_MS : RENDER_MS),
    };
    pod.artworks.set(artwork.artworkId, artwork);
    return json(202, { artwork: detailOf(artwork, entry) });
  }],

  ['GET', ARTWORK_ITEM, (state, { shop, headers, segments, entry }) => {
    if (dark(headers)) return notFound();
    const pod = podOf(state, shop, headers);
    settle(state, shop, pod);
    const id = decodeURIComponent(segments[0]);
    const a = pod.artworks.get(id);
    if (!a) {
      return pod.failed.has(id)
        ? json(200, { artwork: { artworkId: id, status: 'failed', reason: 'render_failed' }, previewUrl: null })
        : notFound();
    }
    return json(200, { artwork: detailOf(a, entry), previewUrl: a.status === 'ready' ? a.preview ?? null : null });
  }],

  ['PATCH', ARTWORK_ITEM, (state, { shop, headers, segments, body, entry }) => {
    if (dark(headers)) return notFound();
    const pod = podOf(state, shop, headers);
    const a = pod.artworks.get(decodeURIComponent(segments[0]));
    if (!isObj(body) || Object.keys(body).join(',') !== 'label') return invalid();
    const label = parseLabel(body.label);
    if (label === undefined) return invalid();
    if (!a) return notFound();
    a.label = label;
    a.updatedAt = Math.max(a.updatedAt ?? 0, clock());
    return json(200, { artwork: summaryOf(a, entry) });
  }],

  ['DELETE', ARTWORK_ITEM, (state, { shop, headers, segments }) => {
    if (dark(headers)) return notFound();
    const pod = podOf(state, shop, headers);
    const id = decodeURIComponent(segments[0]);
    if (!pod.artworks.has(id)) return notFound();
    // Any mapping — active, suspended or removed — keeps its artwork (the print file orders may need).
    if ([...pod.mappings.values()].some((m) => m.artworkId === id)) {
      return json(409, { error: { code: 'conflict', message: 'Artwork is used by a POD mapping' } });
    }
    pod.artworks.delete(id);
    return { status: 204 };
  }],

  ['GET', '/v1/admin/pod/printers', () =>
    json(200, {
      printers: printers().filter((p) => p.status === 'active').map((p) => ({
        // Built field by field, as the Worker's tenantPrinterView: no price, no tier, no currency.
        capabilities: {
          models: Object.fromEntries(Object.entries(p.capabilities.models).map(([k, m]) => [k, {
            garment: m.garment ?? null, ...(m.name ? { name: m.name } : {}), printAreasMm: structuredClone(m.printAreasMm), ...(m.provisional ? { provisional: true } : {}),
          }])),
          skus: Object.fromEntries(Object.entries(p.capabilities.skus).map(([k, s]) => [k, s.label ? { label: s.label, model: s.model } : { model: s.model }])),
        },
        garments: [...new Set(Object.values(p.capabilities.skus).map((s) => p.capabilities.models[s.model]?.garment).filter(Boolean))].sort(),
        name: p.name,
        printerId: p.printerId,
        provisionalAreas: [...new Set(Object.values(p.capabilities.models).filter((m) => m.provisional).map((m) => m.garment))].sort(),
      })),
    })],

  ['GET', '/v1/admin/pod/mappings', (state, { shop, headers, url }) => {
    const pod = podOf(state, shop, headers);
    const productId = url.searchParams.get('productId');
    const rows = [...pod.mappings.values()].filter((m) => !productId || m.productId === productId);
    return json(200, { mappings: rows.map(mappingView) });
  }],

  ['POST', '/v1/admin/pod/mappings', (state, { shop, headers, body }) => {
    const pod = podOf(state, shop, headers);
    settle(state, shop, pod);
    const keys = ['artworkId', 'printerId', 'productId', 'sku', 'slots', 'variantId'];
    if (!isObj(body) || !Object.keys(body).every((k) => keys.includes(k))) return invalid();
    const { productId, artworkId, printerId, sku } = body;
    const variantId = body.variantId ?? null;
    if ([productId, artworkId, printerId].some((v) => typeof v !== 'string' || v.length < 1 || v.length > 128)) return invalid();
    if (typeof sku !== 'string' || !SKU_PATTERN.test(sku)) return invalid();
    if (!Array.isArray(body.slots) || body.slots.length === 0 || body.slots.length > 5) return invalid();
    if (body.slots.some((s, i) => !PRINT_SLOTS.includes(s) || body.slots.indexOf(s) !== i)) return invalid();

    const cat = catalogueOf(state, shop);
    const record = cat.products.get(productId);
    if (!record) return notFound();
    if (record.product.status === 'archived') return conflict('product_archived');
    if (variantId !== null && !record.variants.some((v) => v.variantId === variantId)) return notFound();
    const art = pod.artworks.get(artworkId);
    if (!art) return notFound();
    if (art.status !== 'ready') return refused('artwork_not_ready');
    const printer = printerOf(printerId);
    if (!printer) return refused('printer_unavailable');
    if (!printer.capabilities.skus[sku]) return refused('sku_unavailable');
    const sizes = {};
    for (const slot of body.slots) {
      const frame = frameOf(printer, sku, slot);
      if (!frame) return refused('slot_not_printable');
      const size = sizeSlot(art.widthPx, art.heightPx, frame);
      if (!size) return refused('resolution_too_low');
      sizes[slot] = size;
    }

    const tuple = [...pod.mappings.values()].find((m) => m.productId === productId && m.artworkId === artworkId && m.printerId === printerId && m.sku === sku);
    if (tuple && (tuple.variantId ?? null) !== variantId) return conflict('variant_mismatch');
    const others = [...pod.mappings.values()].filter((m) => m.status === 'active' && m !== tuple && m.productId === productId && (m.variantId ?? null) === variantId);
    for (const m of others) {
      if (m.printerId !== printerId || m.sku !== sku) return conflict('sku_mismatch');
      if (m.slots.some((s) => body.slots.includes(s))) return conflict('slot_taken');
    }
    const slots = PRINT_SLOTS.filter((s) => body.slots.includes(s) || others.some((m) => m.slots.includes(s)));
    const quote = sellerQuote(printer, sku, slots);
    if (!quote) return refused('sku_unavailable'); // the masked "unpriced"
    if (live(record)) {
      const units = variantId !== null
        ? record.variants.filter((v) => v.variantId === variantId)
        : [{ priceMinor: record.product.priceMinor }, ...record.variants.filter((v) => v.active !== false && !scopeQuote(pod, productId, v.variantId))];
      if (units.some((u) => (u.priceMinor ?? record.product.priceMinor) < quote.priceFloorMinor)) {
        return refused('price_below_floor', "The price is below this product's price floor. Raise it to at least the floor shown with the product's print quote.");
      }
    }

    const iso = new Date(clock()).toISOString();
    const mapping = tuple ?? { mappingId: newId('map'), productId, variantId, artworkId, printerId, sku, createdAt: iso };
    Object.assign(mapping, { slots: [...body.slots], sizes, status: 'active', suspendedReason: null, updatedAt: iso });
    pod.mappings.set(mapping.mappingId, mapping);
    record.product.isPod = true;
    syncCatalogueQuote(cat, pod, productId);
    return json(tuple ? 200 : 201, { currency: quote.currency, inkopMinor: quote.inkopMinor, mapping: mappingView(mapping), priceFloorMinor: quote.priceFloorMinor });
  }],

  ['DELETE', MAPPING_ITEM, (state, { shop, headers, segments }) => {
    const pod = podOf(state, shop, headers);
    const m = pod.mappings.get(decodeURIComponent(segments[0]));
    if (!m) return notFound();
    if (m.status !== 'inactive') {
      m.status = 'inactive';
      m.suspendedReason = null;
      m.updatedAt = new Date(clock()).toISOString();
      syncCatalogueQuote(catalogueOf(state, shop), pod, m.productId);
    }
    return { status: 204 };
  }],

  ['GET', '/v1/admin/pod/design-quote', (_state, { url }) => {
    const params = url.searchParams;
    const keys = [...new Set(params.keys())];
    if (keys.some((k) => !['printerId', 'sku', 'slots'].includes(k)) || ['printerId', 'sku', 'slots'].some((k) => params.getAll(k).length !== 1)) return invalid();
    const printerId = params.get('printerId');
    const sku = params.get('sku');
    const slots = params.get('slots').split(',');
    if (!printerId || !SKU_PATTERN.test(sku) || slots.length > 5 || slots.some((s, i) => !PRINT_SLOTS.includes(s) || slots.indexOf(s) !== i)) return invalid();
    const printer = printerOf(printerId);
    const cannot = (code) => json(422, { error: { code, message: 'This choice cannot be produced' } });
    if (!printer) return cannot('printer_unavailable');
    if (!printer.capabilities.skus[sku]) return cannot('sku_unavailable');
    if (slots.some((s) => !frameOf(printer, sku, s))) return cannot('slot_not_printable');
    const quote = sellerQuote(printer, sku, slots);
    return quote ? json(200, quote) : cannot('sku_unavailable');
  }],
];
