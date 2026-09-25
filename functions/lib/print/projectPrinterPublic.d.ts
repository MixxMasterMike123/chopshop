/**
 * projectPrinterPublic — the SELLER-READABLE projection of printers/{uid}
 * (A13, "seller sees ONE number", Mikael 2026-09-25).
 *
 * printers/{uid} carries the printer's price tier (blankCostSek / printCostSek
 * per garment and slot, shippingSek). Firestore rules cannot hide fields
 * (memory: document-rules-cant-field-scope), so the tier doc is PLATFORM-only
 * and the Design Studio reads THIS mirror instead: what the printer can make
 * (garments), where it can print (printAreasMm frames) and whether it is
 * routable (active) — never what it costs. The one number a seller sees comes
 * from the quotePodCost callable.
 *
 * ALLOWLIST, not blocklist (same stance as catalog/projectProduct.ts): a price
 * field added to the tier later defaults to NOT leaking. A new capability field
 * the studio needs must be added here explicitly — that failure is visible (the
 * studio misses it), the blocklist failure is silent (a price leaks).
 *
 * PURE (no firebase imports): unit-tested in rules-tests/one-number-pure.test.cjs
 * and required from the compiled lib by scripts/seed-snapwear-printer.cjs, so
 * the trigger and the seed write byte-identical projections (ONE implementation).
 */
export interface PrinterPublic {
    name: string | null;
    type: string | null;
    active: boolean;
    garments: string[];
    printAreasMm: Record<string, Record<string, {
        w: number;
        h: number;
        offsetTopMm?: number;
    }>>;
    provisionalAreas: string[];
    updatedAt: unknown;
}
/**
 * printers/{uid} data → printersPublic/{uid} data, or null when the source doc
 * is gone (the trigger then deletes the mirror, which un-routes the printer in
 * the studio exactly as deleting the tier un-routes it at checkout).
 *
 * `active` normalises to a boolean with the resolver's rule: absent = active
 * (tier docs written before the users.active mirror existed).
 */
export declare function projectPrinterPublic(src: Record<string, any> | null | undefined): PrinterPublic | null;
