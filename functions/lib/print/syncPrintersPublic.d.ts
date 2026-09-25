/**
 * Keeps printersPublic/{uid} in sync with printers/{uid} (A13 — contract and
 * field allowlist in ./projectPrinterPublic).
 *
 * Fires on EVERY printers write — the platform's Tryckerier editor (tier,
 * frames, Inaktivera), the seed scripts, any future Admin SDK writer — so the
 * seller-readable mirror follows without any writer knowing it exists.
 *
 * Same shape as catalog/syncProductsPublic.ts, for the same reasons: the event
 * is a SIGNAL only; the handler re-reads the source in a transaction and
 * projects THAT, so out-of-order / retried events all converge on the current
 * truth. set() WITHOUT merge so a field removed at the source disappears from
 * the mirror; delete() when the source is gone (a deleted tier must un-route
 * the printer in the studio too).
 */
export declare const syncPrintersPublicOnWrite: import("firebase-functions/core").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<import("firebase-functions/v2/firestore").DocumentSnapshot> | undefined, {
    uid: string;
}>>;
