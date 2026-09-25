/**
 * orderMoney — splits an order's money breakdown away from the client-readable
 * order doc (A13, "seller sees ONE number", Mikael 2026-09-25).
 *
 * WHY: orders/{id} has `allow get: if true` (the guest confirmation page reads
 * it by its unguessable id) and the shop admin lists it. Rules cannot hide
 * fields (memory: document-rules-cant-field-scope), so anything ON the order is
 * readable by the seller AND the buyer. Before A13 that included the frozen
 * per-line production costs (itemCostSek / printCostSek / printerShippingSek)
 * and the Connect fee breakdown (commissionBps next to productionWithheldOre) —
 * i.e. the printer's prices and the platform's cut, by subtraction.
 *
 * NOW:
 *   orders/{id}              — the STRIPPED snapshot (routing only: printerUid
 *                              stays, it is who prints, not what it costs) and
 *                              the on-order connect fields; applicationFeeAmount
 *                              is the ONE deduction the seller sees ("Avgift").
 *   orderProduction/{id}     — the money SSOT, server-only (rules: read/write
 *                              false): the FULL snapshot + the private connect
 *                              breakdown. The 3-way split / monthly production
 *                              statement read it from here.
 *
 * PURE (no firebase imports): unit-tested in rules-tests/one-number-pure.test.cjs
 * and required from the compiled lib by scripts/migrate-order-money-to-private.cjs
 * so the webhook, the B2B freeze and the migration strip identically.
 */
/**
 * Money keys that must never appear on a client-readable doc (orders,
 * printersPublic, settings/*). Tests walk docs at ANY depth against this list.
 */
export declare const ORDER_MONEY_DENYLIST: readonly ["itemCostSek", "printCostSek", "printerShippingSek", "commissionBps", "productionWithheldOre", "productionVatRate", "blankCostSek", "shippingSek", "pricing", "pricingBasis", "catalog"];
/** The connect fields that stay on the order (Stripe reconciliation + the one fee). */
export declare const CONNECT_ON_ORDER: readonly ["isDestinationCharge", "connectedAccountId", "applicationFeeAmount", "applicationFeeId", "transferId", "transferReversed"];
/** The connect fields that move to orderProduction (the fee's breakdown). */
export declare const CONNECT_PRIVATE: readonly ["commissionBps", "productionWithheldOre", "productionVatRate"];
/**
 * The snapshot with every line's money fields REMOVED (not nulled — an absent
 * key is what "never on the order" means, and every reader treats absent as
 * null/0). Everything else — printerUid, garment, artwork refs, unresolved
 * reasons, version, createdAt — is kept as-is: the print portal and the
 * production gates run on it. Returns a new object; the input is not mutated
 * (the webhook writes the FULL input to orderProduction in the same batch).
 */
export declare function stripSnapshotMoney<T extends {
    lines?: unknown;
}>(snapshot: T): T;
export interface SplitConnect {
    onOrder: Record<string, unknown>;
    private: Record<string, unknown>;
}
/**
 * order.connect → the part that stays on the order + the private breakdown.
 *
 * ALLOWLIST on both sides (the projectProduct stance): a key the webhook adds
 * to connect later defaults to NOT reaching the order until it is listed here.
 * Only keys actually present are copied (a pre-A1 connect has no production*
 * fields; Firestore must never receive undefined).
 *
 * This is for BUILDING connect at order creation. Fields patched onto
 * order.connect afterwards (dispute recovery, refund markers) never pass
 * through here, and the migration strips an existing connect with per-field
 * deletes instead of rewriting it — so those fields are never dropped.
 */
export declare function splitConnect(connect: Record<string, unknown> | null | undefined): SplitConnect;
/**
 * Does this order doc still carry money that belongs in orderProduction?
 * (the migration's selector — any line money key, or a private connect key).
 */
export declare function orderCarriesMoney(order: any): boolean;
/**
 * Every path in `value` whose KEY is on the denylist, at any depth — the
 * shared walker for the tests and the migration's post-strip assertion.
 */
export declare function findMoneyKeys(value: unknown, denylist?: readonly string[], path?: string): string[];
