import type { PrintSlot } from "./printers";

/**
 * The POD money formulas, SERVER-ONLY (LAUNCH_TODO A1, A13; "seller sees ONE
 * number"). Every constant below is a port with its Firebase source cited;
 * all amounts are integer minor units (öre), EX VAT unless the name says so.
 *
 * Nothing in this module may be reachable from a tenant response except the
 * two finished numbers the quote route hands out: `inkopMinor` (=
 * productionCostMinor for one unit) and `priceFloorMinor`.
 */

/**
 * The platform's flat cut per printed ITEM, ex VAT.
 * functions/src/print/printRouting.ts L32: `PLATFORM_CUT_SEK = 40` (40 kr ex
 * moms = 50 inkl, Mikael 2026-08-30).
 */
export const PLATFORM_CUT_MINOR = 4_000;

/**
 * The VAT the platform charges the SHOP on production (it sells production to
 * the shop). functions/src/payment/productionWithholding.ts L34:
 * `DEFAULT_PRODUCTION_VAT_RATE = 0.25`. Deliberately NOT the tenant's own VAT
 * rate: this is the platform's sale.
 */
export const PRODUCTION_VAT_BP = 2_500;

/**
 * The seller's transaction fee (BAS tier) the price floor is computed against.
 * src/wagons/pod-wagon/podPricing.js L33–34: `FEE_RATE = 0.08`, `FEE_FIXED = 5`
 * (kr). When per-shop tiers (PLUS 5 %) get billing rails these become per-tenant
 * inputs — change them HERE, once.
 */
export const FEE_RATE_BP = 800;
export const FEE_FIXED_MINOR = 500;

export interface QuoteBreakdown {
  blankMinor: number;
  currency: string;
  platformCutMinor: number;
  printMinorBySlot: Partial<Record<PrintSlot, number>>;
  quantity: number;
  unitMinor: number;
}

export interface PodQuote {
  /** SERVER-ONLY. Never serialize this to a tenant or buyer response. */
  breakdown: QuoteBreakdown;
  productionCostMinor: number;
}

function isCost(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** One printer_sku_tiers row and its printer's currency, as read from D1. */
export interface TierFacts {
  blank_cost_minor: number;
  currency: string;
  print_costs_json: string;
}

/**
 * The quote arithmetic over an already-read tier — the pure half of
 * quotePodCost, so a caller that reads the tier inside a consistent D1 batch
 * (the checkout freeze) prices from exactly the facts it validated.
 */
export function quoteFromTier(
  tier: TierFacts,
  input: { quantity: number; slots: readonly PrintSlot[] },
): PodQuote | null {
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 1 ||
    input.slots.length === 0 ||
    !isCost(tier.blank_cost_minor)
  ) {
    return null;
  }

  let printCosts: Record<string, unknown>;
  try {
    printCosts = JSON.parse(tier.print_costs_json) as Record<string, unknown>;
  } catch {
    return null;
  }

  const printMinorBySlot: Partial<Record<PrintSlot, number>> = {};
  let prints = 0;
  for (const slot of new Set(input.slots)) {
    const cost = printCosts[slot];
    if (!isCost(cost)) {
      return null;
    }
    printMinorBySlot[slot] = cost;
    prints += cost;
  }

  const unitMinor = tier.blank_cost_minor + prints + PLATFORM_CUT_MINOR;
  return {
    breakdown: {
      blankMinor: tier.blank_cost_minor,
      currency: tier.currency,
      platformCutMinor: PLATFORM_CUT_MINOR,
      printMinorBySlot,
      quantity: input.quantity,
      unitMinor,
    },
    productionCostMinor: unitMinor * input.quantity,
  };
}

/**
 * quotePodCost — the production cost of `quantity` items of printer SKU `sku`
 * printed on `slots` by `printerId`, ex VAT.
 *
 * Port of functions/src/print/printRouting.ts quoteRoutedCost (L190–203) over
 * tierCostForSlots (L158–172), with the routing step replaced by the mapping's
 * explicit printer + SKU:
 *
 *   unit = blank + Σ print[slot] + PLATFORM_CUT     (per ITEM: a front+back tee
 *          is one blank with two prints; the cut is counted once)
 *   productionCostMinor = unit × quantity
 *
 * null (not quotable) when the printer is not active, the SKU has no tier, or —
 * a deliberate FAIL-CLOSED divergence from tierCostForSlots, which counted an
 * unpriced slot as 0 — any requested slot has no print price. A 0 there would
 * under-withhold the production cost on every such sale (A1).
 *
 * Shipping is NOT in the per-item quote (Firebase quoted items only too); it is
 * a per-ORDER, per-printer amount added once in the checkout snapshot totals.
 */
export async function quotePodCost(
  db: D1Database,
  input: {
    printerId: string;
    quantity: number;
    sku: string;
    slots: readonly PrintSlot[];
  },
): Promise<PodQuote | null> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.slots.length === 0) {
    return null;
  }

  const tier = await db
    .prepare(
      `SELECT tier.blank_cost_minor, tier.print_costs_json, printer.currency
       FROM printer_sku_tiers AS tier
       INNER JOIN printers AS printer ON printer.id = tier.printer_id
       WHERE tier.printer_id = ?
         AND tier.sku = ?
         AND printer.status = 'active'
       LIMIT 1`,
    )
    .bind(input.printerId, input.sku)
    .first<TierFacts>();
  return tier === null ? null : quoteFromTier(tier, input);
}

/**
 * PRISGOLV — the break-even price floor, INCL. VAT, in minor units.
 *
 * src/wagons/pod-wagon/podPricing.js L69–73:
 *
 *   priceFloor(costSek, vatRate = 0.25) =
 *     Math.ceil((costSek · (1 + vatRate) + FEE_FIXED) / (1 − FEE_RATE))   [kr]
 *
 * — the price at which the seller earns exactly 0 after the production cost
 * (inkl. VAT) and the transaction fee; rounded UP to whole kronor. Ported in
 * exact integer arithmetic (the JS original is float; the two agree except
 * where float error pushes an exact integer quotient over the next ceiling,
 * where this one is the mathematically correct value):
 *
 *   floorKr = ceil( (cost·(10000 + vatBp) + FEE_FIXED_MINOR·10000)
 *                   / (100 · (10000 − FEE_RATE_BP)) )
 *   floorMinor = floorKr · 100
 *
 * `vatRateBp` is the TENANT's VAT rate (PublishPanel passes the shop's
 * vatRate), since the floor is compared against the tenant's VAT-inclusive
 * shelf price. Worked example (the podPricing.test.js fixture): cost 140 kr ex
 * → 14 000 öre → floor 196 kr → 19 600.
 */
export function priceFloorMinor(costMinor: number, vatRateBp: number): number | null {
  if (
    !Number.isSafeInteger(costMinor) ||
    costMinor < 0 ||
    !Number.isSafeInteger(vatRateBp) ||
    vatRateBp < 0
  ) {
    return null;
  }
  const numerator = costMinor * (10_000 + vatRateBp) + FEE_FIXED_MINOR * 10_000;
  const denominator = 100 * (10_000 - FEE_RATE_BP);
  const floorKr = Math.floor((numerator + denominator - 1) / denominator);
  return floorKr * 100;
}

/**
 * The amount withheld for production, INCL. the platform's production VAT,
 * rounded half-up to whole öre ONCE (productionWithholding.ts L123–135:
 * `Math.round(totalSek · vatFactor · 100)` over the SUM, never per line).
 */
export function withholdMinorFor(productionCostMinor: number): number {
  return Math.floor(
    (productionCostMinor * (10_000 + PRODUCTION_VAT_BP) + 5_000) / 10_000,
  );
}
