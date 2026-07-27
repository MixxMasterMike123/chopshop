// podSlots.js — the placement-slot vocabulary for POD multi-placement.
//
// A single product can carry SEVERAL artworks, one per physical print position
// (front/back/sleeve). A podMapping's `placementSlot` picks the position; the
// upsert key is (shopId, sku, placementSlot). MISSING placementSlot on a doc =
// 'front' everywhere (backward compat — the one pre-slot live mapping keeps
// working with zero migration). This mirrors the SLOT_LABELS/slotOf logic in
// functions/src/print/printProjection.ts — keep the two in sync.
export const DEFAULT_SLOT = 'front';

export const POD_SLOTS = [
  { id: 'front', label: 'Bröst' },
  { id: 'back', label: 'Rygg' },
  // 'pocket' is a POSITION NAME, not a sewn pocket (printer confirmed
  // 2026-07-27): the classic left-chest logo spot, 100×100 mm, at a discrete
  // position (left/right/center) — see POCKET_POSITIONS.
  { id: 'pocket', label: 'Ficka' },
  { id: 'left_sleeve', label: 'Vänster ärm' },
  { id: 'right_sleeve', label: 'Höger ärm' },
  { id: 'other', label: 'Övrig' },
];

// Discrete pocket positions, WEARER's perspective (print-industry convention:
// "left chest" = wearer's left = viewer's right on the mockup). Default 'left'
// = the classic placement in the printer's reference image.
export const DEFAULT_POCKET_POSITION = 'left';
export const POCKET_POSITIONS = [
  { id: 'left', label: 'Vänster' }, // the classic left-chest placement
  { id: 'center', label: 'Mitten' },
  { id: 'right', label: 'Höger' },
];

/** Normalise a pocket position id (missing/unknown → 'left'). */
export const pocketPositionOf = (p) =>
  POCKET_POSITIONS.some((x) => x.id === p) ? p : DEFAULT_POCKET_POSITION;

/** Swedish label for a pocket position. */
export const pocketPositionLabel = (p) =>
  (POCKET_POSITIONS.find((x) => x.id === pocketPositionOf(p)) || POCKET_POSITIONS[0]).label;

const VALID = new Set(POD_SLOTS.map((s) => s.id));

/** Normalise a mapping's placementSlot to a valid slot id (missing/unknown → 'front'). */
export const slotOf = (mappingOrSlot) => {
  const s = typeof mappingOrSlot === 'string' ? mappingOrSlot : mappingOrSlot?.placementSlot;
  return VALID.has(s) ? s : DEFAULT_SLOT;
};

/** Swedish label for a slot id (missing/unknown → the 'front' label). */
export const slotLabel = (slot) => {
  const id = slotOf(slot);
  return (POD_SLOTS.find((s) => s.id === id) || POD_SLOTS[0]).label;
};
