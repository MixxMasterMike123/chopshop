/**
 * POD production-cost withholding — pure (no I/O, no Stripe SDK, no firebase).
 *
 * WHY: on a destination charge the shop receives (gross − application fee).
 * Before this module the fee was ONLY the platform's % cut, so the production
 * cost of a POD item (blank + prints + platform cut, frozen per item as
 * `itemCostSek`) left for the shop with the transfer — while the platform pays
 * the printer (SnapWear is paid by the platform's card per order). Every POD
 * order was fronted by the platform with no recovery. This computes the amount
 * the platform must HOLD from the customer's payment so it can pay the printer.
 *
 * The frozen production snapshot (checkouts/{piId}.productionSnapshot → later
 * order.productionSnapshot) is the ONE source of cost: the same object that
 * the print portal fulfils decides the fee. No second cost computation, no
 * re-read of printers/{uid} (shipping is frozen onto the snapshot as
 * printerShippingSek by stampRouting).
 *
 * Money model (plan: ~/.claude/plans/snapwear-production-withholding.md):
 *   • per item    itemCostSek × quantity   (EX moms; stamped on the item's
 *                 FIRST line only, null on its other lines → never double-count)
 *   • per printer printerShippingSek, ONCE per distinct printerUid (one parcel)
 *   • × (1 + vatRate): the platform sells production to the shop WITH moms, and
 *     the fee is taken off the VAT-inclusive gross — same convention as the %
 *     fee in connectFee.ts.
 *   • Rounded to integer öre ONCE, at the END (per-line rounding would drift a
 *     multi-line order by up to ½ öre per line).
 *   • Unrouted lines (printerUid null — pre-routing behaviour) withhold nothing.
 */

import type { ProductionSnapshotLine } from '../print/printProjection';

/** Moms the platform charges the shop on production (Swedish standard rate). */
export const DEFAULT_PRODUCTION_VAT_RATE = 0.25;

export interface PrinterWithholding {
  // Informational per-printer split, each rounded on its own. The authoritative
  // total is ProductionWithholding.withheldOre (rounded once over the sum), so
  // Σ perPrinter may differ from it by rounding — never charge off these.
  itemsOre: number;
  shippingOre: number;
}

export interface ProductionWithholding {
  // Integer öre to add to application_fee_amount. 0 = nothing to withhold.
  withheldOre: number;
  perPrinter: Record<string, PrinterWithholding>;
  // SKUs of items that ARE routed to a printer but carry no price
  // (itemCostSek null on the item's first line). The caller must BLOCK these
  // (409 routed-line-unpriced): selling one would front the cost unrecovered.
  unpricedRouted: string[];
  // SKUs of items routed to NO printer (printerUid null; one entry per item).
  // Withholding treats them as 0 (pre-routing behaviour), but a POD checkout
  // must BLOCK them (409 no-printer-for-garment, SnapWear A4): such a line
  // would be sent nowhere and recover nothing. Reported here so the caller
  // decides from the same single pass over the frozen snapshot.
  unrouted: string[];
}

type SnapshotLike = { lines?: Array<Partial<ProductionSnapshotLine>> | null } | null | undefined;

const finiteNonNeg = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * @param snapshot  the frozen production snapshot (null/undefined → nothing)
 * @param vatRate   moms applied on top of the ex-moms cost (default 0.25)
 */
export function computeProductionWithholding(
  snapshot: SnapshotLike,
  vatRate: number = DEFAULT_PRODUCTION_VAT_RATE
): ProductionWithholding {
  const lines = Array.isArray(snapshot?.lines) ? snapshot!.lines! : [];
  const vatFactor = 1 + (finiteNonNeg(vatRate) ?? DEFAULT_PRODUCTION_VAT_RATE);

  const itemsSekByPrinter = new Map<string, number>();
  const shippingSekByPrinter = new Map<string, number>();
  const unpricedRouted: string[] = [];
  const unrouted: string[] = [];
  const seenItems = new Set<number>();
  const seenUnrouted = new Set<number>();

  for (const line of lines) {
    const uid = typeof line?.printerUid === 'string' && line.printerUid ? line.printerUid : null;
    if (!uid) {
      // unrouted → withholds nothing; reported once per item for the caller.
      const idx = line?.itemIndex as number;
      if (!seenUnrouted.has(idx)) {
        seenUnrouted.add(idx);
        unrouted.push(String(line?.sku || `item#${idx}`));
      }
      continue;
    }

    // Shipping: first line routed to this printer that carries a rate. The
    // stamp lands on the printer's first line; scanning for the first finite
    // value keeps us correct even if a reader reorders lines.
    if (!shippingSekByPrinter.has(uid)) {
      const ship = finiteNonNeg(line.printerShippingSek);
      if (ship !== null) shippingSekByPrinter.set(uid, ship);
    }
    if (!itemsSekByPrinter.has(uid)) itemsSekByPrinter.set(uid, 0);

    // Item cost lives on the item's FIRST line (array order — the same order
    // stampRouting grouped them in); the item's later lines are skipped.
    const idx = line.itemIndex as number;
    if (seenItems.has(idx)) continue;
    seenItems.add(idx);

    const cost = finiteNonNeg(line.itemCostSek);
    if (cost === null) {
      unpricedRouted.push(String(line.sku || `item#${idx}`));
      continue;
    }
    // quantity is server-validated upstream; a malformed one withholds nothing
    // for that item rather than NaN-poisoning the whole fee.
    const qty = typeof line.quantity === 'number' && Number.isFinite(line.quantity) && line.quantity > 0
      ? Math.floor(line.quantity)
      : 0;
    itemsSekByPrinter.set(uid, (itemsSekByPrinter.get(uid) || 0) + cost * qty);
  }

  let totalSek = 0;
  const perPrinter: Record<string, PrinterWithholding> = {};
  for (const [uid, itemsSek] of itemsSekByPrinter) {
    const shippingSek = shippingSekByPrinter.get(uid) || 0;
    totalSek += itemsSek + shippingSek;
    perPrinter[uid] = {
      itemsOre: Math.round(itemsSek * vatFactor * 100),
      shippingOre: Math.round(shippingSek * vatFactor * 100),
    };
  }

  return {
    withheldOre: Math.round(totalSek * vatFactor * 100),
    perPrinter,
    unpricedRouted,
    unrouted,
  };
}
