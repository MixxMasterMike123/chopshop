// The design studio's FLAT prints (CP12 unit F3: "Nytt tryck", phase 1 framed
// posters): the tenant printer view's flat models → what the studio offers,
// the per-size resolution check, the placement geometry, and the mapping's
// frozen placement. PURE: no I/O, no React, no browser API; tested under Node
// (studioFlat.test.mjs).
//
// THE CONTRACT (CP12_BRIEFS.md "The contract both units build to"):
//   - a model with `kind: "flat"` has exactly one slot, `front`; the tenant
//     view gives its area in mm and its exact pixels: printAreasMm.front =
//     { w, h, px: { w, h } } (the PrinterModel's `front.px`);
//   - its SKU key reads `<prodigiSku>.<finish>.<sheet>` ("….white-frame.12x16"):
//     the "colour" part is the finish, the size part the sheet;
//   - the print is the model's `front.px` exactly, the motif placed by the
//     studio's `fit` ("cover" | "contain") and, for contain, a `background`
//     hex — frozen in the mapping.
// One SHEET SIZE is one MODEL (the posters catalogue: BFP-11X14 … BFP-18X24,
// one SKU each), so a flat PRODUCT is a family of models: one printer, one
// `garment` (poster, postcard, sticker), one finish, the sizes the seller ticks.
//
// THE SELLER SEES ONE NUMBER: nothing here prices; the "Inköp" per size is the
// server's design quote (adapters/studio.js quoteSummary/podFigures read it).

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const posNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** The families the studio knows, in the order the product step shows them (phases 2–3 greyed until built). */
export const FLAT_GARMENTS = Object.freeze([
  { garment: 'poster', label: 'Affisch (ramad)', note: 'Ramad affisch med motivet över hela arket.' },
  { garment: 'postcard', label: 'Vykort', note: 'Kommer senare' },
  { garment: 'sticker', label: 'Klistermärke', note: 'Kommer senare' },
]);

/** "Affisch (ramad)" for poster; an unknown family keeps its own name. */
export function flatGarmentLabel(garment) {
  return FLAT_GARMENTS.find((g) => g.garment === garment)?.label ?? String(garment ?? '');
}

/** The bleed the printer trims or the frame hides, and the inner margin text should keep clear of (mm from the sheet edge). */
export const BLEED_MM = 3;
export const SAFE_MM = 10;
/** The print's resolution floor (POD_PRINT_SPEC §2; Prodigi's own figure for these products, D5). */
export const FLAT_MIN_DPI = 300;

const FINISH_LABELS = Object.freeze({
  'white-frame': 'Vit ram',
  'black-frame': 'Svart ram',
  'natural-frame': 'Naturträram',
  'oak-frame': 'Ekram',
});

/** "Vit ram" for white-frame; an unknown finish reads as its slug, spaced and capitalised. */
export function finishLabel(slug) {
  const s = String(slug ?? '');
  if (FINISH_LABELS[s]) return FINISH_LABELS[s];
  const words = s.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/** The frame colour the drawn preview uses for a finish (display only). */
export function finishFrameHex(slug) {
  const s = String(slug ?? '');
  if (s.startsWith('black')) return '#1d1d1f';
  if (s.startsWith('natural') || s.startsWith('oak') || s.startsWith('wood')) return '#c9a77c';
  return '#f4f3ef';
}

const cm = (mm) => {
  const v = Math.round(mm) / 10;
  return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
};

/** "30 × 40 cm", as the studio shows a sheet. */
export function sheetSizeLabel(mm) {
  const v = sheetVariantLabel(mm);
  return v ? `${v} cm` : '';
}

/**
 * "30 × 40" — the sheet as the product's variant SIZE. Without the unit: the
 * variant rail upper-cases sizes (utils/variantDerivation.js: "S", "XL"), and
 * "30 × 40" reads the same either way; its SKU part becomes "30-40".
 */
export function sheetVariantLabel(mm) {
  return mm && posNum(mm.w) && posNum(mm.h) ? `${cm(mm.w)} × ${cm(mm.h)}` : '';
}

/** "12 × 16 tum" from the key's sheet part ("12x16"), or '' when it is not inches. */
export function sheetInchLabel(sheet) {
  const m = /^(\d+(?:_\d+)?)x(\d+(?:_\d+)?)$/i.exec(String(sheet ?? ''));
  return m ? `${m[1].replace('_', ',')} × ${m[2].replace('_', ',')} tum` : '';
}

/** `<prodigiSku>.<finish>.<sheet>` → { finish, sheet }, or null when the key has no such parts. */
export function flatKeyParts(sku) {
  const parts = String(sku ?? '').split('.');
  if (parts.length < 3) return null;
  const sheet = parts[parts.length - 1];
  const finish = parts[parts.length - 2];
  return finish && sheet ? { finish, sheet } : null;
}

/** The flat model's one area: { mm: { w, h }, px: { w, h } }, or null when it has no exact pixels. */
export function flatArea(model) {
  const a = model?.printAreasMm?.front;
  if (!isObj(a) || !posNum(a.w) || !posNum(a.h) || !isObj(a.px)) return null;
  const w = posInt(a.px.w);
  const h = posInt(a.px.h);
  return w && h ? { mm: { w: a.w, h: a.h }, px: { w, h } } : null;
}

/** Whether a tenant-view model is a flat print (absent kind = garment). */
export const isFlatModel = (model) => isObj(model) && model.kind === 'flat';

/**
 * GET /v1/admin/pod/printers → the flat families the studio offers:
 *   [{ key, printerId, printerName, garment, label,
 *      finishes: [{ id, label, hex }],
 *      sizes: [{ sku, modelKey, finish, sheet, label, variantLabel, inchLabel, mm, px }] }]
 * One family per (printer, garment) with at least one usable size, in
 * FLAT_GARMENTS order then by name; its sizes from the smallest sheet. A flat
 * model without exact pixels, or a SKU without the finish/sheet parts, is
 * left out (it could not be printed right). Only capabilities are read.
 */
export function flatProductsFromPrinters(printers) {
  const families = [];
  for (const p of list(printers)) {
    if (!isObj(p) || !str(p.printerId)) continue;
    const models = isObj(p.capabilities?.models) ? p.capabilities.models : {};
    const skus = isObj(p.capabilities?.skus) ? p.capabilities.skus : {};
    const byGarment = new Map();
    for (const [sku, entry] of Object.entries(skus)) {
      if (!isObj(entry) || !str(entry.model)) continue;
      const model = models[entry.model];
      if (!isFlatModel(model) || !str(model.garment)) continue;
      const area = flatArea(model);
      const parts = flatKeyParts(sku);
      if (!area || !parts) continue;
      if (!byGarment.has(model.garment)) byGarment.set(model.garment, []);
      byGarment.get(model.garment).push({
        sku,
        modelKey: entry.model,
        finish: parts.finish,
        sheet: parts.sheet,
        label: sheetSizeLabel(area.mm),
        variantLabel: sheetVariantLabel(area.mm),
        inchLabel: sheetInchLabel(parts.sheet),
        mm: area.mm,
        px: area.px,
      });
    }
    for (const [garment, sizes] of byGarment) {
      sizes.sort((a, b) => a.mm.w * a.mm.h - b.mm.w * b.mm.h || a.sku.localeCompare(b.sku));
      const finishes = [...new Set(sizes.map((s) => s.finish))]
        .map((id) => ({ id, label: finishLabel(id), hex: finishFrameHex(id) }));
      families.push({
        key: `${encodeURIComponent(p.printerId)}/${encodeURIComponent(garment)}`,
        printerId: p.printerId,
        printerName: str(p.name) ?? p.printerId,
        garment,
        label: flatGarmentLabel(garment),
        finishes,
        sizes,
      });
    }
  }
  const order = (g) => {
    const i = FLAT_GARMENTS.findIndex((f) => f.garment === g);
    return i < 0 ? FLAT_GARMENTS.length : i;
  };
  return families.sort((a, b) => order(a.garment) - order(b.garment) || a.printerName.localeCompare(b.printerName, 'sv'));
}

/** The family's sizes in one finish. */
export function sizesInFinish(family, finishId) {
  return list(family?.sizes).filter((s) => s.finish === finishId);
}

// ── resolution per size (POD_PRINT_SPEC §2, per sheet: contain at 300 dpi) ──

/**
 * Whether an artwork reaches a sheet's exact pixels under a fit — the
 * Worker's rule (cloudflare/src/pod/printers.ts flatReachesPx): the print
 * master is never enlarged, so CONTAIN needs the binding axis (the motif
 * whole on the sheet) and COVER needs both (the sheet filled). → { ok, minW,
 * minH } where minW × minH is the least the artwork needs at its own aspect
 * ("minst 3543×4724 px"). null when the artwork's size is unknown.
 */
export function flatQualifies(artwork, px, fit = 'contain') {
  const aw = posInt(artwork?.sourceWidthPx);
  const ah = posInt(artwork?.sourceHeightPx);
  if (!aw || !ah || !posInt(px?.w) || !posInt(px?.h)) return null;
  const aspect = aw / ah;
  const wider = aspect >= px.w / px.h;
  if (fit === 'cover') {
    const ok = aw >= px.w && ah >= px.h;
    return wider
      ? { ok, minW: Math.ceil(px.h * aspect), minH: px.h }
      : { ok, minW: px.w, minH: Math.ceil(px.w / aspect) };
  }
  // Wider than the sheet: the width binds (else the height).
  return wider
    ? { ok: aw >= px.w, minW: px.w, minH: Math.ceil(px.w / aspect) }
    : { ok: ah >= px.h, minW: Math.ceil(px.h * aspect), minH: px.h };
}

/** "För låg upplösning (minst 3543×4724 px)" or null when it qualifies (or cannot be judged). */
export function flatResolutionText(check) {
  if (!check || check.ok) return null;
  return `För låg upplösning (minst ${check.minW}×${check.minH} px)`;
}

// ── placement (cover / contain), in the sheet's own units ───────────────────

export const FITS = Object.freeze(['cover', 'contain']);

/**
 * The motif's rectangle on a sheet of `sheet` = { w, h } (any unit), centred:
 * cover fills the sheet (cropped at the edges), contain shows it whole.
 * → { x, y, w, h, scale } (scale = sheet units per artwork pixel), or null.
 */
export function fitRect(artwork, sheet, fit) {
  const aw = posNum(artwork?.w);
  const ah = posNum(artwork?.h);
  if (!aw || !ah || !posNum(sheet?.w) || !posNum(sheet?.h)) return null;
  const sx = sheet.w / aw;
  const sy = sheet.h / ah;
  const scale = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const w = aw * scale;
  const h = ah * scale;
  return { x: (sheet.w - w) / 2, y: (sheet.h - h) / 2, w, h, scale };
}

/**
 * The print's effective resolution at a fit: the artwork's pixels over the
 * printed inches of the motif (contain: the whole motif; cover: enlarged to
 * fill). null when unknown.
 */
export function flatEffectiveDpi(artwork, size, fit) {
  const r = fitRect({ w: artwork?.sourceWidthPx, h: artwork?.sourceHeightPx }, size?.mm, fit);
  return r ? Math.floor(artwork.sourceWidthPx / (r.w / 25.4)) : null;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** A seller's colour as the mapping freezes it: "#rrggbb" lower case, or null. */
export function normalizeHex(value) {
  const s = String(value ?? '').trim();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const long = /^#?([0-9a-f]{6})$/i.exec(s);
  return long ? `#${long[1]}`.toLowerCase() : null;
}

export const DEFAULT_BACKGROUND = '#ffffff';
/** The fit a flat print starts with (the Worker's DEFAULT_FLAT_FIT). */
export const DEFAULT_FIT = 'contain';

/**
 * The placement the mapping freezes: { fit, background: '#rrggbb' }. The
 * Worker stores a background under both fits (under cover it is the colour
 * beneath a transparent motif); the studio picks one only for contain, so
 * cover freezes white — what the studio draws. Throws on an unknown fit.
 */
export function flatPlacement(fit, background) {
  if (!FITS.includes(fit)) throw new Error(`Unknown fit ${fit}`);
  return { fit, background: fit === 'contain' ? normalizeHex(background) ?? DEFAULT_BACKGROUND : DEFAULT_BACKGROUND };
}

/**
 * A mapping write's `slots` (POST /v1/admin/pod/mappings): a flat print's
 * slot as an object carrying its placement — `{ slot, fit }`, plus
 * `background` for contain (the Worker's parseCreateMappingInput); a garment's
 * (no placement) the slot names, as today.
 */
export function mappingSlotsBody(slots, placement) {
  if (!placement) return [...slots];
  const p = flatPlacement(placement.fit, placement.background);
  return slots.map((slot) => ({ slot, fit: p.fit, background: p.background }));
}

/**
 * A server mapping's frozen placement ({ fit, background? }) — its `front`
 * slot's (where the Worker stores it), else the mapping's own — or null (a
 * garment mapping).
 */
export function mappingPlacement(mapping) {
  if (!isObj(mapping)) return null;
  const slot = list(mapping.slots).find((s) => isObj(s) && s.slot === 'front');
  const source = FITS.includes(slot?.fit) ? slot : FITS.includes(mapping.fit) ? mapping : null;
  if (!source) return null;
  return { fit: source.fit, background: normalizeHex(source.background) ?? DEFAULT_BACKGROUND };
}

/**
 * Whether two placements print the same (null = none): fit AND background
 * (an absent background is the Worker's default, white). A mapping that
 * differs in either is written again — the write is what freezes them.
 */
export function samePlacement(a, b) {
  if (!a || !b) return !a && !b;
  const bg = (p) => normalizeHex(p.background) ?? DEFAULT_BACKGROUND;
  return a.fit === b.fit && bg(a) === bg(b);
}

// ── the publish panel's shapes ──────────────────────────────────────────────

/**
 * What the existing publish panel reads for a flat product: its "template"
 * (one colourway = the finish), the size columns (the ticked sizes, smallest
 * first) and the "production" (the printer and, as articles, the ticked
 * sizes' SKUs labelled "<finish> / <size>" so the panel preselects each cell).
 */
export function flatPublishShape(family, finishId, tickedSkus) {
  const finish = list(family?.finishes).find((f) => f.id === finishId) ?? null;
  const ticked = new Set(list(tickedSkus));
  const sizes = sizesInFinish(family, finishId).filter((s) => ticked.has(s.sku));
  if (!finish || sizes.length === 0) return null;
  return {
    template: { id: `flat:${family.key}`, garment: family.garment, colorways: [{ id: finish.id, label: finish.label, hex: finish.hex }] },
    sizeLabels: sizes.map((s) => s.variantLabel),
    production: {
      id: `flat:${family.key}:${finish.id}`,
      printerId: family.printerId,
      name: family.printerName,
      modelName: family.label,
      articles: sizes.map((s) => ({ sku: s.sku, label: `${finish.label} / ${s.variantLabel}` })),
    },
  };
}
