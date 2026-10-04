// The design studio's shapes (CP5 unit FN1): the API's answers → what the
// older studio reads (DesignStudio, PublishPanel), and a design → the writes
// the Worker needs. PURE: no I/O, no React, no browser API; tested under Node
// (studio.test.mjs).
//
// THE WORKER'S MODEL, against the older studio's:
//   older                                   here
//   a mockup template (Firestore settings)  GET /v1/admin/pod/mockup-templates
//                                           (the same document shape, images
//                                           from the public bucket)
//   platform routing garment → printer      the seller's printer AND model:
//   (settings/printRouting, printersPublic)   GET /v1/admin/pod/printers lists
//                                           each usable printer's models (a
//                                           garment, its print frames) and
//                                           ARTICLES (one physical blank: a
//                                           colour and a size)
//   a mapping row per (sku, slot) with a    a mapping per (product or variant,
//   placement text                          artwork, printer, ARTICLE, slots):
//                                           the server sizes each slot
//                                           (contain-fit at the DPI floor); no
//                                           placement and no pocket position
//                                           are stored
//   the studio's cost + client floor        the server's design quote for a
//   (podPricing.js)                         printer, an article and the slots:
//                                           { inkopMinor, priceFloorMinor }
//
// THE SELLER SEES ONE NUMBER (rule 15): the only figures here are the
// server's `inkopMinor` and `priceFloorMinor`, shown through podFigures (öre →
// kr, Inköp with the production VAT). Nothing here prices.

import { PRINT_SLOTS } from './pod.js';
import { podFigures } from './product.js';

export { PRINT_SLOTS, podFigures };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── mockup templates ───────────────────────────────────────────────────────

function rect(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of ['x', 'y', 'w', 'h']) {
    if (num(v[k]) === null) return null;
    out[k] = v[k];
  }
  return out;
}

function size(v) {
  return isObj(v) && num(v.w) !== null && num(v.h) !== null ? { w: v.w, h: v.h } : null;
}

function slotMap(v, read) {
  if (!isObj(v)) return null;
  const out = {};
  for (const slot of PRINT_SLOTS) {
    if (v[slot] === undefined) continue;
    const value = read(v[slot]);
    if (value !== null) out[slot] = value;
  }
  return out;
}

function urls(v) {
  if (!isObj(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, u]) => typeof u === 'string' && u !== ''));
}

function tuning(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of ['blend']) if (str(v[k])) out[k] = v[k];
  for (const k of ['alpha', 'displacementScale', 'displacementBlur', 'displacementContrast']) if (num(v[k]) !== null) out[k] = v[k];
  return out;
}

function photoOf(v) {
  if (!isObj(v) || num(v.w) === null || num(v.h) === null) return null;
  const photo = { w: v.w, h: v.h, urls: urls(v.urls) };
  const back = urls(v.backUrls);
  if (Object.keys(back).length > 0) photo.backUrls = back;
  const d = v.displacement;
  if (isObj(d) && num(d.w) !== null && num(d.h) !== null) {
    const displacement = { w: d.w, h: d.h, urls: urls(d.urls) };
    for (const k of ['scale', 'blur', 'contrast', 'alpha']) if (num(d[k]) !== null) displacement[k] = d[k];
    if (str(d.blend)) displacement.blend = d.blend;
    if (isObj(d.perColorway)) {
      displacement.perColorway = Object.fromEntries(
        Object.entries(d.perColorway).map(([id, t]) => [id, tuning(t)]).filter(([, t]) => t !== null),
      );
    }
    photo.displacement = displacement;
  }
  return photo;
}

/**
 * One template of GET /v1/admin/pod/mockup-templates → the document the
 * studio reads (TemplateBackground, placementMath, applyPrinterAreas,
 * mockupRender). The Worker's seller shape IS that document (CP5_WH_REPORT
 * "For unit FN"); this copies the keys the studio reads, field by field, and
 * drops a template it could not draw (no id, no colourway, no print area).
 */
export function templateFromApi(t) {
  if (!isObj(t) || !str(t.id) || !str(t.garment)) return null;
  const colorways = list(t.colorways)
    .filter((c) => isObj(c) && str(c.id))
    .map((c) => ({ id: c.id, label: str(c.label) ?? c.id, hex: str(c.hex) ?? '#ffffff' }));
  const printAreas = slotMap(t.printAreas, rect);
  const printAreaMm = slotMap(t.printAreaMm, size);
  if (colorways.length === 0 || !printAreas || Object.keys(printAreas).length === 0 || !printAreaMm) return null;
  const out = {
    id: t.id,
    label: str(t.label) ?? t.id,
    garment: t.garment,
    profileId: str(t.profileId),
    provisional: t.provisional === true,
    colorways,
    printAreas,
    printAreaMm,
  };
  const offsets = slotMap(t.printOffsetTopMm, (v) => num(v));
  if (offsets && Object.keys(offsets).length > 0) out.printOffsetTopMm = offsets;
  const labels = slotMap(t.slotLabels, (v) => str(v));
  if (labels && Object.keys(labels).length > 0) out.slotLabels = labels;
  if (isObj(t.pocketPositions)) {
    const pp = {};
    for (const pos of ['left', 'center', 'right']) if (num(t.pocketPositions[pos]?.x) !== null) pp[pos] = { x: t.pocketPositions[pos].x };
    if (Object.keys(pp).length > 0) out.pocketPositions = pp;
  }
  const photo = photoOf(t.photo);
  if (photo) out.photo = photo;
  return out;
}

/** GET /v1/admin/pod/mockup-templates → { templates, meta } (meta as the older loader's getPodMockupTemplatesMeta). */
export function templatesFromApi(body) {
  const templates = list(body?.templates).map(templateFromApi).filter(Boolean);
  return { templates, meta: { version: 0, provisional: body?.provisional === true } };
}

// ── production: the printers' models as the studio's "routing" ─────────────

/** The studio's key of one (printer, model): what the older code calls a printer uid. */
export function productionKey(printerId, modelKey) {
  return `${encodeURIComponent(printerId)}/${encodeURIComponent(modelKey)}`;
}

function frames(areas) {
  const out = {};
  if (!isObj(areas)) return out;
  for (const slot of PRINT_SLOTS) {
    const a = areas[slot];
    if (!isObj(a) || !(num(a.w) > 0) || !(num(a.h) > 0)) continue;
    out[slot] = num(a.offsetTopMm) !== null ? { w: a.w, h: a.h, offsetTopMm: a.offsetTopMm } : { w: a.w, h: a.h };
  }
  return out;
}

/**
 * GET /v1/admin/pod/printers → what the older studio reads from its routing
 * loader, so its template filter and frame reshaping (templateOffered,
 * resolvePrinterUid, applyPrinterAreas) run unchanged:
 *   printersById  key → { id, printerId, name, modelKey, modelName, provisional, label,
 *                 active: true, garments: [garment], printAreasMm: { [garment]: frames },
 *                 articles: [{ sku, label }] }      one entry per (printer, model)
 *                 that offers at least one article
 *   routing       { byGarment: { garment → the first key with a frame }, defaultPrinterUid: null }
 *   options       { garment → [key…] }  (the seller's choice when there are several)
 * Only capabilities are read (no price exists on this answer).
 */
export function productionFromPrinters(printers) {
  const printersById = {};
  const options = {};
  const byGarment = {};
  for (const p of list(printers)) {
    if (!isObj(p) || !str(p.printerId)) continue;
    const models = isObj(p.capabilities?.models) ? p.capabilities.models : {};
    const skus = isObj(p.capabilities?.skus) ? p.capabilities.skus : {};
    for (const [modelKey, model] of Object.entries(models)) {
      if (!isObj(model) || !str(model.garment)) continue;
      const articles = Object.entries(skus)
        .filter(([, entry]) => isObj(entry) && entry.model === modelKey)
        .map(([sku, entry]) => ({ sku, label: str(entry.label) }));
      if (articles.length === 0) continue;
      const key = productionKey(p.printerId, modelKey);
      const garment = model.garment;
      const f = frames(model.printAreasMm);
      const entry = {
        id: key,
        printerId: p.printerId,
        name: str(p.name) ?? p.printerId,
        modelKey,
        modelName: str(model.name) ?? modelKey,
        provisional: model.provisional === true,
        active: true,
        garments: [garment],
        printAreasMm: { [garment]: f },
        articles,
      };
      entry.label = productionLabel(entry);
      printersById[key] = entry;
      (options[garment] ??= []).push(key);
      if (byGarment[garment] === undefined && Object.keys(f).length > 0) byGarment[garment] = key;
    }
  }
  return { routing: { byGarment, defaultPrinterUid: null }, printersById, options };
}

/** "Testtryckeriet · Unisex t-shirt" — the select's text for one (printer, model). */
export function productionLabel(entry) {
  return entry ? `${entry.name} · ${entry.modelName}${entry.provisional ? ' (preliminära mått)' : ''}` : '';
}

// ── articles: which blank each sellable variant is printed on ──────────────

/** A label compared the way a seller reads it: case, spaces and the separator ( / · | ) do not matter. */
export function normalizeLabel(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s*[/·|]\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueMatch(articles, targets) {
  const wanted = new Set(targets.map(normalizeLabel).filter(Boolean));
  const hits = list(articles).filter((a) => a.label && wanted.has(normalizeLabel(a.label)));
  return hits.length === 1 ? hits[0].sku : '';
}

/**
 * The article preselected for a colour (and size): the ONE article whose
 * label reads "<colour> / <size>" (or "<colour>" for a one-size garment),
 * the colour by its label or its id. '' when none or several match: the
 * seller chooses. Nothing fuzzy beyond case and spacing.
 */
export function matchArticle(articles, colorway, sizeLabel = null) {
  const names = [colorway?.label, colorway?.id].filter((n) => typeof n === 'string' && n.trim() !== '');
  const targets = names.map((n) => (sizeLabel ? `${n} / ${sizeLabel}` : n));
  return uniqueMatch(articles, targets);
}

/** The article preselected for an existing product's variant (its label, e.g. "Vit · S"), or ''. */
export function matchVariantArticle(articles, variantLabel) {
  return uniqueMatch(articles, [variantLabel]);
}

/** "Svart / S" (or the article number when the printer gave no label). */
export function articleOptionText(article) {
  return article?.label ? article.label : article?.sku ?? '';
}

/** The articles chosen more than once (one blank cannot be two different variants). */
export function duplicateArticles(skus) {
  const seen = new Set();
  const dup = new Set();
  for (const sku of skus) {
    if (!sku) continue;
    if (seen.has(sku)) dup.add(sku);
    seen.add(sku);
  }
  return [...dup];
}

// ── the design's mappings ───────────────────────────────────────────────────

/**
 * The prints of one sellable unit → its mappings' artworks and slots: the
 * slots that print the same artwork share one mapping (a Worker mapping
 * prints one artwork on several slots). `artworkFor(slot)` → artworkId.
 * Ordered by the first slot, slots in PRINT_SLOTS order. Throws when a slot
 * has no artwork (a caller bug: the studio refuses that design earlier).
 */
export function mappingGroups(slots, artworkFor) {
  const byArtwork = new Map();
  for (const slot of PRINT_SLOTS.filter((s) => slots.includes(s))) {
    const artworkId = artworkFor(slot);
    if (typeof artworkId !== 'string' || artworkId === '') throw new Error(`No artwork for ${slot}`);
    if (!byArtwork.has(artworkId)) byArtwork.set(artworkId, []);
    byArtwork.get(artworkId).push(slot);
  }
  return [...byArtwork.entries()].map(([artworkId, s]) => ({ artworkId, slots: s }));
}

const slotIds = (m) => list(m.slots).map((s) => (typeof s === 'string' ? s : s?.slot)).filter((s) => typeof s === 'string');
const sameSlots = (a, b) => a.length === b.length && a.every((s) => b.includes(s));

/**
 * One scope's mapping writes (the product's own scope: variantId null, or one
 * variant's): what makes the server's ACTIVE set exactly `desired`
 * ([{ artworkId, printerId, sku, slots }]) while writing only what differs.
 *   keep    existing active mappings that already are a desired one
 *   deletes mappingIds to remove first: every other active or suspended one
 *           (a changed artwork, article, printer or set of slots; a suspended
 *           row is removed and, if still wanted, posted again)
 *   posts   the desired mappings not kept (a removed row with the same
 *           artwork, printer and article is re-activated by its POST)
 * Deletes run before posts: a slot is held by one mapping of a scope at a
 * time, and the scope prints on one article.
 */
export function planScopeMappings(existing, desired) {
  const live = list(existing).filter((m) => isObj(m) && (m.status === 'active' || m.status === 'suspended'));
  const keep = [];
  const satisfied = new Set();
  for (const m of live) {
    if (m.status !== 'active') continue;
    const i = desired.findIndex((d, j) => !satisfied.has(j)
      && d.artworkId === m.artworkId && d.printerId === m.printerId && d.sku === m.sku && sameSlots(d.slots, slotIds(m)));
    if (i >= 0) {
      satisfied.add(i);
      keep.push(m.mappingId);
    }
  }
  return {
    keep,
    deletes: live.filter((m) => !keep.includes(m.mappingId)).map((m) => m.mappingId),
    posts: desired.filter((_, i) => !satisfied.has(i)),
  };
}

/** The mappings of a product in one scope (variantId null = the product's own). */
export function mappingsInScope(mappings, variantId) {
  return list(mappings).filter((m) => isObj(m) && (m.variantId ?? null) === (variantId ?? null));
}

// ── the server's numbers, per row of the publish panel ──────────────────────

/**
 * The quote state of a set of articles (one colour row, or the whole
 * design): `quotes` = { sku → { state: 'loading' | 'ok' | 'refused' | 'failed', quote?, message? } }.
 *   { state: 'empty' }                  no article chosen
 *   { state: 'pending' }                a quote is still being asked
 *   { state: 'failed', message }        a quote could not be had (never "0 kr")
 *   { state: 'ok', floorKr, inkopMinKr, inkopMaxKr }
 *                                       the strictest floor (the one every
 *                                       price of the set must clear) and the
 *                                       range of Inköp, both the server's
 */
export function quoteSummary(skus, quotes) {
  const chosen = [...new Set(list(skus).filter(Boolean))];
  if (chosen.length === 0) return { state: 'empty' };
  const states = chosen.map((sku) => quotes?.[sku] ?? { state: 'loading' });
  const failed = states.find((s) => s.state === 'refused' || s.state === 'failed');
  if (failed) return { state: 'failed', message: failed.message ?? null };
  if (states.some((s) => s.state !== 'ok')) return { state: 'pending' };
  const figures = states.map((s) => podFigures(s.quote));
  if (figures.some((f) => f === null)) return { state: 'failed', message: null };
  return {
    state: 'ok',
    floorKr: Math.max(...figures.map((f) => f.floorKr)),
    inkopMinKr: Math.min(...figures.map((f) => f.inkopKr)),
    inkopMaxKr: Math.max(...figures.map((f) => f.inkopKr)),
  };
}

const krText = (value) =>
  `${Number(value).toLocaleString('sv-SE', { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(value) ? 0 : 2 })} kr`;

/** "175 kr" or "175–190 kr" (Inköp incl. VAT, as the server quotes it), or '—'. */
export function inkopText(summary) {
  if (summary?.state !== 'ok') return '—';
  return summary.inkopMinKr === summary.inkopMaxKr
    ? krText(summary.inkopMinKr)
    : `${summary.inkopMinKr.toLocaleString('sv-SE')}–${krText(summary.inkopMaxKr)}`;
}

/** "253 kr", or '—'. */
export function floorText(summary) {
  return summary?.state === 'ok' ? krText(summary.floorKr) : '—';
}

export { krText };
