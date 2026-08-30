/**
 * printRouting — SERVER LOGIC TWIN of src/wagons/pod-wagon/printRouting.js.
 *
 * ⚠️ TWIN, NOT AN IMPORT. functions/tsconfig.json sets `rootDir: "src"`, so the
 * Cloud Functions build cannot compile a file outside functions/src — and there
 * is no bundler/shared-package step in this repo (the only precedent,
 * migrationShared.ts, is a byte-identical extraction for the same reason). So
 * the routing rules live twice, and rules-tests/print-routing-parity.test.cjs
 * runs a fixture table through BOTH implementations and fails on any divergence.
 *
 * CHANGE ONE → CHANGE THE OTHER → RUN THAT TEST.
 *
 * WHY THE SERVER NEEDS IT: at payment time buildProductionSnapshot freezes
 * `printerUid` + `costSek` per production line (Slice 4). That decision must be
 * the same one the seller was shown in the studio when they priced the product,
 * so it has to come from the same rules — not a second, drifting interpretation.
 *
 * ALL AMOUNTS EX MOMS (the storage convention across the POD money path).
 */
/** The platform's flat cut per printed garment, EX moms.
 *  MUST equal PLATFORM_CUT_SEK in src/wagons/pod-wagon/podPricing.js (40 kr =
 *  50 inkl); the parity test asserts the routed costs agree, which pins it. */
export declare const PLATFORM_CUT_SEK = 40;
export interface PrinterTier {
    active?: boolean;
    name?: string;
    garments?: string[];
    pricing?: {
        blankCostSek?: Record<string, number>;
        printCostSek?: Record<string, number>;
    };
}
export interface PrintRouting {
    byGarment?: Record<string, string>;
    defaultPrinterUid?: string | null;
}
/** A mockup template's LEGACY cost fields (the pre-routing pricing basis). */
export interface LegacyTemplateCost {
    blankCostSek?: number;
    printCostSek?: Record<string, number>;
    costSek?: number;
}
export type CostSource = 'printer' | 'template' | null;
export interface RoutedCost {
    cost: number | null;
    source: CostSource;
    printerUid: string | null;
}
/**
 * Which printer makes `garment`.
 *
 *   1. routing.byGarment[garment] — only if that printer still has a tier doc
 *      AND lists the garment (a stale route must not price off the wrong tier).
 *   2. routing.defaultPrinterUid — the catch-all; NOT required to list the
 *      garment (its tier may simply not price that blank → null cost → the
 *      caller falls back to the template).
 *   3. null.
 *
 * A null/unknown garment goes straight to 2: there is no per-garment rule.
 */
export declare const resolvePrinterUid: (garment: string | null | undefined, routing: PrintRouting | null | undefined, printersById: Record<string, PrinterTier> | null | undefined) => string | null;
/**
 * blankCostSek[garment] + Σ printCostSek[slot], EX moms, WITHOUT the platform
 * cut (added once by podCostForSlotsRouted).
 *
 * null when the blank price for this garment is missing — an unquoted blank
 * cannot be guessed. A missing SLOT price counts as 0: the same lenience as the
 * legacy podCostForSlots, so an unquoted print surface does not silence the
 * whole floor.
 */
export declare const tierCostForSlots: (tier: PrinterTier | null | undefined, garment: string | null | undefined, slots: string[] | null | undefined) => number | null;
/**
 * The LEGACY template-based cost, EX moms — a verbatim twin of podCostForSlots()
 * in src/wagons/pod-wagon/podPricing.js, including its own legacy fallback to
 * the deprecated flat `costSek` on stale cached template docs.
 */
export declare const podCostForSlots: (template: LegacyTemplateCost | null | undefined, slots: string[] | null | undefined) => number | null;
/**
 * The routed production cost (EX moms) + which basis produced it.
 *
 *   printer  → tierCostForSlots + PLATFORM_CUT_SEK, printerUid set.
 *   template → podCostForSlots(template, slots) (legacy prices, cut already in),
 *              printerUid null: no printer stands behind that number.
 *   null     → neither basis could price it; the caller shows "—".
 */
export declare const podCostForSlotsRouted: (args: {
    garment?: string | null;
    slots?: string[] | null;
    routing?: PrintRouting | null;
    printersById?: Record<string, PrinterTier> | null;
    template?: LegacyTemplateCost | null;
}) => RoutedCost;
