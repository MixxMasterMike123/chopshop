/**
 * takedownProduct — PLATFORM-only: switch a reported/flagged product off the
 * storefront (SnapWear A10 notice & takedown, also the "Avpublicera" action in
 * the A11 screening queue).
 *
 * One transaction:
 *   products/{productId}      isActive=false + takedown { reportId, at, by, note }
 *                             (+ screening.status='taken_down' when screened, so
 *                             it leaves the Granskning queue)
 *   infringementReports/{id}  status='taken_down', note, handledAt, handledBy
 *                             (only when reportId is given)
 *   auditLogs/{auto}          append-only record, same shape as the existing
 *                             customer-admin entries (shopId-stamped).
 *
 * Hiding needs nothing else: projectPublicProduct drops any product whose
 * isActive !== true, so syncProductsPublicOnWrite deletes the public mirror
 * and the storefront stops listing/selling it.
 *
 * firestore.rules forbid a shop admin from writing `takedown`, and from
 * flipping isActive while `takedown` is set — the seller can't quietly switch
 * it back on. Reinstating is a platform act (set the report to 'rejected' and
 * re-activate in the product form, which clears the stamp for platform users).
 *
 * NOT built: payout hold. Destination charges have no per-item hold primitive;
 * if an order for the product is still inside the payout window the platform
 * can reverse that transfer manually in the Stripe dashboard.
 * TODO(payout-hold): revisit if takedowns become frequent.
 */
interface TakedownProductRequest {
    productId?: string;
    reportId?: string | null;
    note?: string;
}
export declare const takedownProduct: import("firebase-functions/v2/https").CallableFunction<TakedownProductRequest, any, unknown>;
export {};
