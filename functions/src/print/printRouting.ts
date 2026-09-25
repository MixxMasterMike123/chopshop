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
export const PLATFORM_CUT_SEK = 40;

export interface PrinterTier {
  active?: boolean; // mirrored from users/{uid}.active by the Tryckerier page

  name?: string;
  garments?: string[];
  pricing?: {
    blankCostSek?: Record<string, number>;
    printCostSek?: Record<string, number>;
  };
  // Flat per-ORDER shipping the printer charges for sending one parcel (SE),
  // EX moms. Absent = 0. Frozen onto the production snapshot at payment
  // (stampRouting → printerShippingSek) and withheld once per printer in the
  // Connect application fee (payment/productionWithholding.ts). Server-only:
  // the client twin (src/wagons/pod-wagon/printRouting.js) never prices
  // shipping, so it has nothing to mirror.
  shippingSek?: number;
  // Per-printer print FRAMES in mm, per garment × slot (SnapWear A3). An
  // ABSENT slot = the printer cannot print it (checkout refuses the line as
  // slot-not-printable — stampRouting); an absent GARMENT entry = no capability
  // data, nothing gated. offsetTopMm = frame top below the collar (A5 canvas).
  printAreasMm?: Record<string, Record<string, PrintArea>>;
  // Garments whose frames are stand-ins until the printer confirms (UI chip).
  provisionalAreas?: string[];
  // 'api' = no users/ login; orders go out over the printer's own API (A6).
  type?: string;
}

export interface PrintArea {
  w: number;
  h: number;
  offsetTopMm?: number;
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

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Which printer makes `garment`.
 *
 *   1. routing.byGarment[garment] — only if that printer still has a tier doc,
 *      is active, AND lists the garment (a stale route must not price off the
 *      wrong tier).
 *   2. routing.defaultPrinterUid — under the SAME rule, including "lists the
 *      garment" (SnapWear A4, 2026-09-25). It used to be an unconditional
 *      catch-all: a garment the default cannot make was "routed" there anyway,
 *      withheld nothing and was sent nowhere. Closed in BOTH twins.
 *   3. null → checkout refuses the line (409 no-printer-for-garment).
 *
 * A null/unknown garment is listed by no printer → null (fail closed).
 */
export const resolvePrinterUid = (
  garment: string | null | undefined,
  routing: PrintRouting | null | undefined,
  printersById: Record<string, PrinterTier> | null | undefined
): string | null => {
  const printers = printersById || {};
  const byGarment = routing?.byGarment || {};
  const g = typeof garment === 'string' && garment.trim() ? garment.trim() : null;

  // A DEACTIVATED printer (printers/{uid}.active mirrors users.active) is never
  // eligible: printGuard rejects it at login, so a line routed there would sit
  // unprintable. Absent flag = active (docs written before the mirror existed).
  const eligible = (uid: string | null | undefined): boolean =>
    !!uid && !!printers[uid] && printers[uid].active !== false;

  if (!g) return null;
  const makes = (uid: string | null | undefined): uid is string =>
    eligible(uid) && Array.isArray(printers[uid as string].garments) &&
    printers[uid as string].garments!.includes(g);

  const routedUid = byGarment[g];
  if (makes(routedUid)) return routedUid;
  const fallbackUid = routing?.defaultPrinterUid || null;
  return makes(fallbackUid) ? fallbackUid : null;
};

const isArea = (a: unknown): a is PrintArea => {
  const f = a as PrintArea | null | undefined;
  return !!f && typeof f === 'object' && isFiniteNumber(f.w) && f.w > 0 && isFiniteNumber(f.h) && f.h > 0;
};

/**
 * Can a printer whose frames for ONE garment are `areasForGarment` print
 * `slot`? Twin of isSlotPrintableInAreas in the client module:
 *   no frames for the garment → true (no capability data, nothing gated);
 *   'other' → true; its own frame → true; 'pocket' → true when `front` has a
 *   frame (the pocket is a position INSIDE the front canvas); otherwise false
 *   (an absent slot = the printer cannot print it — SnapWear: sleeves).
 */
export const isSlotPrintableInAreas = (
  areasForGarment: Record<string, PrintArea> | null | undefined,
  slot: string
): boolean => {
  if (!areasForGarment || typeof areasForGarment !== 'object') return true;
  if (slot === 'other') return true;
  if (isArea(areasForGarment[slot])) return true;
  return slot === 'pocket' && isArea(areasForGarment.front);
};

/** isSlotPrintableInAreas on a tier doc. */
export const isSlotPrintable = (
  tier: PrinterTier | null | undefined,
  garment: string | null | undefined,
  slot: string
): boolean => isSlotPrintableInAreas(garment ? tier?.printAreasMm?.[garment] : null, slot);

/**
 * blankCostSek[garment] + Σ printCostSek[slot], EX moms, WITHOUT the platform
 * cut (added once by podCostForSlotsRouted).
 *
 * null when the blank price for this garment is missing — an unquoted blank
 * cannot be guessed. A missing SLOT price counts as 0: the same lenience as the
 * legacy podCostForSlots, so an unquoted print surface does not silence the
 * whole floor.
 */
export const tierCostForSlots = (
  tier: PrinterTier | null | undefined,
  garment: string | null | undefined,
  slots: string[] | null | undefined
): number | null => {
  const blank = tier?.pricing?.blankCostSek || {};
  const base = garment ? blank[garment] : undefined;
  if (!isFiniteNumber(base)) return null;
  const print = tier?.pricing?.printCostSek || {};
  const prints = (Array.isArray(slots) ? slots : []).reduce(
    (sum, slot) => sum + (isFiniteNumber(print[slot]) ? print[slot] : 0),
    0
  );
  return base + prints;
};

/**
 * The LEGACY template-based cost, EX moms — a verbatim twin of podCostForSlots()
 * in src/wagons/pod-wagon/podPricing.js, including its own legacy fallback to
 * the deprecated flat `costSek` on stale cached template docs.
 */
export const podCostForSlots = (
  template: LegacyTemplateCost | null | undefined,
  slots: string[] | null | undefined
): number | null => {
  if (!isFiniteNumber(template?.blankCostSek)) {
    return isFiniteNumber(template?.costSek) ? template!.costSek! + PLATFORM_CUT_SEK : null;
  }
  const printCost = template?.printCostSek || {};
  const prints = (Array.isArray(slots) ? slots : []).reduce(
    (sum, slot) => sum + (isFiniteNumber(printCost[slot]) ? printCost[slot] : 0),
    0
  );
  return template!.blankCostSek! + prints + PLATFORM_CUT_SEK;
};

/**
 * The routed production cost (EX moms) + which basis produced it.
 *
 *   printer  → tierCostForSlots + PLATFORM_CUT_SEK, printerUid set.
 *   template → podCostForSlots(template, slots) (legacy prices, cut already in),
 *              printerUid null: no printer stands behind that number.
 *   null     → neither basis could price it; the caller shows "—".
 */
export const podCostForSlotsRouted = (args: {
  garment?: string | null;
  slots?: string[] | null;
  routing?: PrintRouting | null;
  printersById?: Record<string, PrinterTier> | null;
  template?: LegacyTemplateCost | null;
}): RoutedCost => {
  const { garment, slots, routing, printersById, template } = args || {};
  const uid = resolvePrinterUid(garment, routing, printersById);
  const tier = uid ? (printersById || {})[uid] : null;
  const tierCost = tier ? tierCostForSlots(tier, garment, slots) : null;
  if (tierCost != null) {
    return { cost: tierCost + PLATFORM_CUT_SEK, source: 'printer', printerUid: uid };
  }
  const legacy = podCostForSlots(template, slots);
  return legacy != null
    ? { cost: legacy, source: 'template', printerUid: null }
    : { cost: null, source: null, printerUid: null };
};
