"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeProductionWithholding = exports.DEFAULT_PRODUCTION_VAT_RATE = void 0;
/** Moms the platform charges the shop on production (Swedish standard rate). */
exports.DEFAULT_PRODUCTION_VAT_RATE = 0.25;
const finiteNonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
/**
 * @param snapshot  the frozen production snapshot (null/undefined → nothing)
 * @param vatRate   moms applied on top of the ex-moms cost (default 0.25)
 */
function computeProductionWithholding(snapshot, vatRate = exports.DEFAULT_PRODUCTION_VAT_RATE) {
    const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
    const vatFactor = 1 + (finiteNonNeg(vatRate) ?? exports.DEFAULT_PRODUCTION_VAT_RATE);
    const itemsSekByPrinter = new Map();
    const shippingSekByPrinter = new Map();
    const unpricedRouted = [];
    const seenItems = new Set();
    for (const line of lines) {
        const uid = typeof line?.printerUid === 'string' && line.printerUid ? line.printerUid : null;
        if (!uid)
            continue; // unrouted → pre-routing behaviour, withholds nothing
        // Shipping: first line routed to this printer that carries a rate. The
        // stamp lands on the printer's first line; scanning for the first finite
        // value keeps us correct even if a reader reorders lines.
        if (!shippingSekByPrinter.has(uid)) {
            const ship = finiteNonNeg(line.printerShippingSek);
            if (ship !== null)
                shippingSekByPrinter.set(uid, ship);
        }
        if (!itemsSekByPrinter.has(uid))
            itemsSekByPrinter.set(uid, 0);
        // Item cost lives on the item's FIRST line (array order — the same order
        // stampRouting grouped them in); the item's later lines are skipped.
        const idx = line.itemIndex;
        if (seenItems.has(idx))
            continue;
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
    const perPrinter = {};
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
    };
}
exports.computeProductionWithholding = computeProductionWithholding;
//# sourceMappingURL=productionWithholding.js.map