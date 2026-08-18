export interface PrintShopContext {
    uid: string;
    printShopShops: string[];
}
/**
 * Assert the caller is an ACTIVE print_shop user; return their allowed shop list.
 * Throws (unauthenticated / permission-denied) otherwise. Reads the live doc.
 *
 * D6 (pod-shop-type-selector plan): a printer's assignment to a shop is not
 * enough — the shop must ALSO have the `pod` add-on enabled. Filtering HERE
 * (the one entry point every print callable calls first — getPrintQueue,
 * getPrintJob, getPrintQueueExport, getPrintArtworkLibrary,
 * getPrintArtworkDownload, setPrintJobStatus all start with this call) means
 * the pod-disabled shop simply never appears in printShopShops: the queue/
 * export/library loops skip it, and assertShopAllowed denies it for the
 * per-resource callables — one gate, six call sites, no per-file duplication.
 * Uses the SAME predicate as everywhere else (isShopFeatureEnabled), so this
 * stays default-ON until D3 flips pod to explicit opt-in.
 */
export declare function getPrintShopContext(authUid?: string): Promise<PrintShopContext>;
/** Assert an order's shop is one the caller may fulfil (per-resource scope check). */
export declare function assertShopAllowed(ctx: PrintShopContext, shopId: string): void;
