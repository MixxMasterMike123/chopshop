/**
 * Keeps productsPublic/{id} in sync with products/{id} (P1-11 projection —
 * contract and field allowlist in ./projectProduct).
 *
 * Fires on EVERY products write, client or Admin SDK — so admin edits,
 * Design Studio publishes, the Shopify/Woo migrators, and the review
 * aggregate writers (submitReview/moderateReview bump reviewCount/ratingSum
 * on the product doc) all propagate without knowing the mirror exists.
 *
 * Same doc id as the source: Checkout + CheckoutRecoveryPage do get-by-id
 * against the mirror, so a differing id scheme would silently break them.
 *
 * set() WITHOUT merge: a field removed (or de-allowlisted) at the source must
 * disappear from the mirror, not linger from the previous projection.
 * delete() on a missing doc is a Firestore no-op, so unpublish/delete paths
 * need no existence pre-check.
 *
 * The event is treated as a SIGNAL only — the handler re-reads the source doc
 * in a transaction and projects THAT, never the event's after-image. v2
 * events are neither ordered nor exactly-once: projecting after-images means
 * a delayed/retried older event can overwrite a newer mirror state — worst
 * case resurrecting a product the admin just unpublished — until the next
 * write. Re-reading makes every event (in any order, any retry count)
 * converge the mirror to the source's current truth, and the transaction's
 * optimistic lock on the source read retries if the product changes mid-run.
 */
export declare const syncProductsPublicOnWrite: import("firebase-functions/core").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<import("firebase-functions/v2/firestore").DocumentSnapshot> | undefined, {
    productId: string;
}>>;
