// podMockupTemplateHelpers.js — the PURE helpers of the mockup templates
// (no firebase, no I/O), moved unchanged out of podMockupTemplates.js so a
// build that loads the templates elsewhere (the Cloudflare admin's, CP5 unit
// FN1) reads them from the same place. podMockupTemplates.js re-exports them,
// so its importers are unchanged.

/** Find a loaded template by its id (e.g. 'tee_flat'). Returns null if absent. */
export const getTemplateById = (templates, id) =>
  (Array.isArray(templates) ? templates : []).find((t) => t && t.id === id) || null;

// Canonical slot order for every slot enumeration (step-2 tryckytor cards,
// trycklista, preview tabs, mockup/publish loops): chest → back → pocket →
// sleeves. Needed because printAreas arrives as a FIRESTORE MAP, and Firestore
// gives map keys back in no guaranteed order — raw Object.keys shuffled the
// step-2 cards on every reload. Slots not listed here sort last, in map order.
const SLOT_ORDER = ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve'];
const slotRank = (slot) => {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? SLOT_ORDER.length : i;
};

/** The slots a template actually defines a print area for, in canonical order
 *  (e.g. ['front','back','pocket',…]). */
export const templateSlots = (template) =>
  (template && template.printAreas ? Object.keys(template.printAreas) : [])
    .sort((a, b) => slotRank(a) - slotRank(b));

// ── GARMENT TYPE (the print-routing key) ─────────────────────────────────────
// The garment a template depicts ('tee' | 'longsleeve' | 'hoodie' | 'sweatshirt'
// | 'bag' | 'cap' | 'beanie' | 'flatcap'). It is persisted on every podMappings
// row so the print pipeline can later route a production line to the printer
// that actually makes THAT garment (multi-printer routing).
//
// WHY A RESOLVER AND NOT PLAIN `template.garment`: only FLAT templates carry a
// `garment` field — there it names the SVG flat in studio/garments/index.js.
// The three PHOTO templates (tee_bc_e150, hoodie_hanging, longsleeve_hanging)
// render from photographs and were seeded WITHOUT one, so reading the field
// alone would persist null for the three most-used garments. The template id is
// the fallback: every id in seed-pod-mockup-templates.cjs is `<garment>_<...>`.
// An explicit `garment` always wins, so seeding one on a photo template (as the
// seed script now does) is a no-op for behaviour.
const GARMENT_ID_PREFIXES = ['longsleeve', 'sweatshirt', 'flatcap', 'hoodie', 'beanie', 'tee', 'bag', 'cap'];

/** The garment type a template depicts, or null when it can't be determined
 *  (null = "unknown garment" → the default printer). */
export const garmentOfTemplate = (template) => {
  const explicit = String(template?.garment || '').trim();
  if (explicit) return explicit;
  const id = String(template?.id || '').trim().toLowerCase();
  return GARMENT_ID_PREFIXES.find((g) => id === g || id.startsWith(`${g}_`)) || null;
};
