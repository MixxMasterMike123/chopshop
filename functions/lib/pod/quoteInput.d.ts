/**
 * quoteInput — validation for the quotePodCost callable's payload (A13).
 *
 * PURE (no firebase imports) so it is unit-tested in
 * rules-tests/one-number-pure.test.cjs without an emulator. The callable itself
 * (./quotePodCost.ts) only adds auth + the Firestore reads around it.
 */
/** The POD placement-slot vocabulary (printProjection.ts PlacementSlot). */
export declare const QUOTE_SLOTS: readonly ["front", "back", "pocket", "left_sleeve", "right_sleeve", "other"];
export declare const MAX_QUOTE_SLOTS = 6;
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
export declare function parseQuoteInput(data: unknown): QuoteInput | string;
