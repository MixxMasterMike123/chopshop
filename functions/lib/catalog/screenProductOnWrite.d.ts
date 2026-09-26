/**
 * screenProductOnWrite — server-side brand screening (SnapWear A11).
 *
 * A sibling of syncProductsPublicOnWrite on the same products/{id} write
 * signal. The client publish paths (Design Studio, ProductForm) run the same
 * matcher to SHOW the seller a notice, but they never write `screening`
 * themselves — firestore.rules forbids a shop admin from touching it — so this
 * trigger is the only writer and a client that skips the check changes nothing.
 *
 * Only LIVE products are screened (isActive === true && availability.b2c ===
 * true, the same predicate as the public projection): a draft harms nobody,
 * and a takedown (isActive=false) must not be re-stamped.
 *
 * What it stamps (pure decision: decideScreening in ./contentScreening):
 *   screening = { status, hits[], earlierHits?, at, source:'server' }
 *   status: 'flagged' (blocklist hit) · 'review' (a new shop's first
 *   reviewFirstProducts live products) · 'ok' · 'blocked' (hard-blocked term →
 *   also isActive=false). The platform's review queue (PlatformReports →
 *   Granskning) reads flagged/review/blocked and writes 'cleared'.
 *
 * Loop safety: the trigger's own update re-fires it. The decision is a no-op
 * when the hit set is unchanged, and it only ever writes screening/isActive,
 * so the second run converges to nothing. The source is re-read in a
 * transaction (same reasoning as syncProductsPublic: events are unordered).
 *
 * Settings: settings/contentScreening = { blocklist: [{ term, kind, note,
 * hardBlock? }], reviewFirstProducts: 2, hardBlock?: boolean }. A missing doc
 * means no terms — only the new-shop review rule applies.
 *
 * Artwork names (F4): a POD product's screened text includes the fileName/
 * label of the artwork its podMappings point at, but the mapping editor and
 * replaceArtworkFile write podMappings/podArtwork WITHOUT touching the product.
 * rescreenProductsOnMappingWrite / rescreenProductsOnArtworkWrite below close
 * that gap by running the same screenProductNow on every affected live product.
 */
type AnyDoc = Record<string, any>;
/**
 * Screen one product now: read it and, when LIVE, stamp the decision. The
 * products trigger passes its event payload as `known` (already checked live)
 * so its reads stay exactly as they were; the rescreen triggers below omit it
 * and the product is read fresh.
 */
export declare function screenProductNow(productId: string, known?: AnyDoc): Promise<void>;
export declare const screenProductOnWrite: import("firebase-functions/core").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<import("firebase-functions/v2/firestore").DocumentSnapshot> | undefined, {
    productId: string;
}>>;
/** podMappings write (setMapping / deleteMapping) → re-screen what the old AND new row fed. */
export declare const rescreenProductsOnMappingWrite: import("firebase-functions/core").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<import("firebase-functions/v2/firestore").DocumentSnapshot> | undefined, {
    mappingId: string;
}>>;
/** podArtwork fileName/label change (rename, replaceArtworkFile) → re-screen its products. */
export declare const rescreenProductsOnArtworkWrite: import("firebase-functions/core").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<import("firebase-functions/v2/firestore").DocumentSnapshot> | undefined, {
    artworkId: string;
}>>;
export {};
