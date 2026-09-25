/**
 * quoteInput — validation for the quotePodCost callable's payload (A13).
 *
 * PURE (no firebase imports) so it is unit-tested in
 * rules-tests/one-number-pure.test.cjs without an emulator. The callable itself
 * (./quotePodCost.ts) only adds auth + the Firestore reads around it.
 */

/** The POD placement-slot vocabulary (printProjection.ts PlacementSlot). */
export const QUOTE_SLOTS = ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve', 'other'] as const;
export const MAX_QUOTE_SLOTS = 6;

export interface QuoteInput {
  shopId: string;
  garment: string;
  slots: string[];
}

/**
 * Normalise + validate `{ shopId, garment, slots }`. Returns the clean input,
 * or an error string (the callable maps it to invalid-argument).
 *
 *   shopId  — non-empty string (the tenant gate runs on it).
 *   garment — non-empty string ≤ 40 chars. An unknown garment is NOT an error:
 *             it simply routes to nobody and quotes null, as the studio shows.
 *   slots   — array of ≤ MAX_QUOTE_SLOTS known slot ids. Duplicates collapse
 *             (a slot is printed once); order is irrelevant to the price.
 */
export function parseQuoteInput(data: unknown): QuoteInput | string {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const shopId = typeof d.shopId === 'string' ? d.shopId.trim() : '';
  if (!shopId) return 'shopId saknas';
  const garment = typeof d.garment === 'string' ? d.garment.trim() : '';
  if (!garment || garment.length > 40) return 'garment saknas eller är ogiltigt';
  if (!Array.isArray(d.slots) || d.slots.length > MAX_QUOTE_SLOTS) {
    return `slots måste vara en lista med högst ${MAX_QUOTE_SLOTS} ytor`;
  }
  const known = new Set<string>(QUOTE_SLOTS);
  if (!d.slots.every((s) => typeof s === 'string' && known.has(s))) return 'okänd tryckyta i slots';
  return { shopId, garment, slots: [...new Set(d.slots as string[])] };
}
