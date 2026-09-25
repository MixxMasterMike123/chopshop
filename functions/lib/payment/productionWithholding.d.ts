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
export declare const DEFAULT_PRODUCTION_VAT_RATE = 0.25;
export interface PrinterWithholding {
    itemsOre: number;
    shippingOre: number;
}
export interface ProductionWithholding {
    withheldOre: number;
    perPrinter: Record<string, PrinterWithholding>;
    unpricedRouted: string[];
}
type SnapshotLike = {
    lines?: Array<Partial<ProductionSnapshotLine>> | null;
} | null | undefined;
/**
 * @param snapshot  the frozen production snapshot (null/undefined → nothing)
 * @param vatRate   moms applied on top of the ex-moms cost (default 0.25)
 */
export declare function computeProductionWithholding(snapshot: SnapshotLike, vatRate?: number): ProductionWithholding;
export {};
