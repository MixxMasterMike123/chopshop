// podGarments.js — the shared POD garment-TYPE registry (the routing/pricing axis).
//
// A garment id answers "what physical blank is this?" — it keys the per-printer
// price tier (printers/{uid}.pricing.blankCostSek) and, from Slice 3 on, the
// routing table (settings/printRouting.byGarment). It is NOT a mockup template:
// several templates can share one garment (a flat SVG and a photo shoot of the
// same tee), and the template only carries the LEGACY per-template cost.
//
// ⚠️ The ids here MUST match the `garment` field already written by the mockup
// templates (scripts/seed-pod-mockup-templates.cjs) and the SVG flat registry
// (src/wagons/pod-wagon/studio/garments/index.js) — they are the same vocabulary.
// Existing, in-use ids: tee, hoodie, sweatshirt, bag, cap, beanie, flatcap.
// 'longsleeve' is new here (the longsleeve_hanging photo template predates the
// `garment` field; Slice 1 stamps it).
//
// Naming notes (do not "fix" these — they follow the printer's price list):
//   beanie  = "Mössa"      (Systema-prislistan 2026-08-10: 50:-)
//   flatcap = "Flat mössa" (a separate blank, not a keps)
//   bag     = "Tygkasse"   (the tote — id is 'bag', NOT 'tote')
//
// Print SLOTS (front/back/pocket/sleeves) live in src/config/podSlots.js — that
// is the other pricing axis. Never duplicate the slot list here.

export const POD_GARMENTS = [
  { id: 'tee', label: 'T-shirt' },
  { id: 'longsleeve', label: 'Långärmad' },
  { id: 'hoodie', label: 'Hoodie' },
  { id: 'sweatshirt', label: 'Sweatshirt' },
  { id: 'cap', label: 'Keps' },
  { id: 'beanie', label: 'Mössa' },
  { id: 'flatcap', label: 'Flat mössa' },
  { id: 'bag', label: 'Tygkasse' },
];

const BY_ID = new Map(POD_GARMENTS.map((g) => [g.id, g]));

/** Is this a known garment id? */
export const isGarmentId = (id) => BY_ID.has(id);

/** Swedish label for a garment id (unknown/missing → the raw id, or '—'). */
export const garmentLabel = (id) => BY_ID.get(id)?.label || id || '—';
