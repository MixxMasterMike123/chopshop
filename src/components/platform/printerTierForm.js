// printerTierForm — the PURE form ↔ doc conversions behind PrinterRow's tier
// editor (Plattform → Tryckerier). Split out of PrinterRow.jsx so plain
// `node --test` / rules-tests can import them (JSX cannot be required from
// node); PrinterRow re-exports them, so its importers are unchanged.
//
// FORM ↔ DOC. Every number is typed as a string in the form and converted on
// save. An empty input means "not given": the key is OMITTED from the doc
// rather than stored as 0 — for prices (absent ≠ free) and for print frames
// (absent slot = the printer cannot print it; the studio hides the slot and
// checkout refuses it). ALL PRICES ARE EX MOMS.
//
// Imported BOTH by Vite and by plain `node` (the test) — relative imports need
// the explicit .js extension, and this file must stay firebase/React-free.
import { POD_GARMENTS } from '../../config/podGarments.js';
import { POD_SLOTS } from '../../config/podSlots.js';

// 'other' is excluded from both axes: it is the catch-all placement in
// podSlots.js, not a surface a printer quotes or frames.
export const PRICED_SLOTS = POD_SLOTS.filter((s) => s.id !== 'other');
export const AREA_SLOTS = PRICED_SLOTS;

const str = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const num = (v) => {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Firestore doc → form state (numbers → strings; missing → ''). */
export const docToForm = (p) => {
  const garments = Array.isArray(p?.garments) ? p.garments : [];
  const blank = p?.pricing?.blankCostSek || {};
  const print = p?.pricing?.printCostSek || {};
  const areas = p?.printAreasMm || {};
  return {
    garments: new Set(garments),
    blank: Object.fromEntries(POD_GARMENTS.map((g) => [g.id, str(blank[g.id])])),
    print: Object.fromEntries(PRICED_SLOTS.map((s) => [s.id, str(print[s.id])])),
    areas: Object.fromEntries(POD_GARMENTS.map((g) => [g.id, Object.fromEntries(AREA_SLOTS.map((s) => {
      const a = areas[g.id]?.[s.id] || {};
      return [s.id, { w: str(a.w), h: str(a.h), top: str(a.offsetTopMm) }];
    }))])),
    provisional: new Set(Array.isArray(p?.provisionalAreas) ? p.provisionalAreas : []),
  };
};

/**
 * Form state → the stored pricing maps. Empty/blank/invalid → key OMITTED
 * (absent ≠ 0). Blank prices are kept only for garments the printer actually
 * offers, so unchecking a garment drops its price too.
 */
export const formToPricing = (form) => {
  const pick = (entries) => Object.fromEntries(entries.filter(([, n]) => n !== null));
  return {
    blankCostSek: pick(POD_GARMENTS.filter((g) => form.garments.has(g.id)).map((g) => [g.id, num(form.blank[g.id])])),
    printCostSek: pick(PRICED_SLOTS.map((s) => [s.id, num(form.print[s.id])])),
  };
};

/**
 * Form state → printAreasMm { [garment]: { [slot]: { w, h, offsetTopMm? } } }.
 * A slot is stored only with BOTH w and h > 0. Every OFFERED garment gets an
 * entry — an EMPTY one when no slot has a frame. It must not be dropped: the
 * capability check (isSlotPrintableInAreas, both twins) reads an absent
 * garment as "no capability data → nothing gated" (pre-A3 tiers), so omitting
 * the key when the last frame is cleared would flip "front only" into "prints
 * anywhere" (CODEX audit 2026-09-26 F3). {} = printable nowhere; the studio
 * then hides the garment. An unchecked garment still gets no entry.
 */
export const formToPrintAreas = (form) => {
  const out = {};
  for (const g of POD_GARMENTS) {
    if (!form.garments.has(g.id)) continue;
    const slots = {};
    for (const s of AREA_SLOTS) {
      const cell = form.areas?.[g.id]?.[s.id] || {};
      const w = num(cell.w);
      const h = num(cell.h);
      if (!(w > 0) || !(h > 0)) continue;
      const top = num(cell.top);
      slots[s.id] = { w, h, ...(top !== null ? { offsetTopMm: top } : {}) };
    }
    out[g.id] = slots;
  }
  return out;
};

/** Garment×slot cells with only ONE of width/height filled — refused on save
 *  (a half-typed frame would silently mean "cannot print"). Labels for a toast. */
export const incompleteAreaCells = (form) => {
  const bad = [];
  for (const g of POD_GARMENTS) {
    if (!form.garments.has(g.id)) continue;
    for (const s of AREA_SLOTS) {
      const cell = form.areas?.[g.id]?.[s.id] || {};
      if ((num(cell.w) > 0) !== (num(cell.h) > 0)) bad.push(`${g.label} ${s.label.toLowerCase()}`);
    }
  }
  return bad;
};
