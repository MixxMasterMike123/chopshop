/**
 * Stripe Connect — pure parameter builders (no I/O, no Stripe SDK).
 *
 * Extracted from createPaymentIntent.ts (destination-charge branch) and
 * connectRefund.ts (refund branch) so the money-path DECISION LOGIC is unit-
 * testable without hitting Stripe or Firestore. The handlers call these; the
 * tests assert the exact param shapes (the bugs that would actually hurt:
 * forgetting transfer_data, a wrong fee, or a Connect refund missing the
 * transfer reversal). Fee arithmetic lives in connectFee.ts.
 *
 * POD PRODUCTION WITHHOLDING (SnapWear A1): on a POD order the application fee
 * is the platform % cut PLUS the frozen production cost incl. moms
 * (productionWithholding.ts) — the platform pays the printer, so it must hold
 * that money back from the transfer. REFUNDS: no separate handling. The
 * withheld production is simply PART of the application fee, so the existing
 * `refundApplicationFee` policy (settings/platform, see buildRefundParams)
 * decides whether it goes back to the buyer on a refund. Once an item is
 * printed its production is sunk cost for the platform → the recommended
 * policy is settings/platform.refundApplicationFee = false (Mikael's call; the
 * default in code is still true = pre-A1 behaviour).
 */
export interface ConnectChargeBuild {
    params: Record<string, any>;
    meta: Record<string, string>;
    useConnect: boolean;
    feeExceedsGross: boolean;
}
/**
 * Decide the destination-charge params for a checkout. A shop is "Connect-
 * enabled" ONLY when it has a usable connected account (chargesEnabled +
 * stripeAccountId); otherwise the result is empty and the PaymentIntent is the
 * legacy single-account charge. NO on_behalf_of → platform stays VAT MoR.
 *
 * The application fee = the % commission + `withheldOre` (the POD production
 * cost incl. moms, from computeProductionWithholding). With withheldOre = 0
 * (non-POD cart, or pre-routing lines) params AND metadata are byte-identical
 * to the pre-withholding build: the two production* metadata keys are only
 * added when something is actually withheld.
 *
 * @param pay              shops/{id}.payments map (may be undefined)
 * @param amountOre        gross charge amount in öre
 * @param platformDefaultBps  fallback commission (settings/platform → env)
 * @param withheldOre      production cost to hold back, integer öre (default 0)
 * @param productionVatRate  the moms rate withheldOre was computed with —
 *                         recorded in metadata for reconciliation only
 */
export declare function buildConnectChargeParams(pay: any, amountOre: number, platformDefaultBps: number, withheldOre?: number, productionVatRate?: number): ConnectChargeBuild;
/**
 * Decide the refund params for an order. A destination-charge order must claw
 * the principal back from the connected account (reverse_transfer); whether it
 * ALSO returns the platform fee to the buyer is a platform policy
 * (refundApplicationFee). A legacy order takes a plain refund.
 *
 * @param order               the order doc
 * @param amountSek           optional partial refund amount in SEK
 * @param refundApplicationFee  platform policy: also return the platform fee?
 *                            Default true (current behaviour). false keeps the
 *                            fee as a non-refundable service fee.
 */
export declare function buildRefundParams(order: any, amountSek?: number, refundApplicationFee?: boolean): Record<string, any>;
/** A reversal target: the order's recorded destination-charge transfer. */
export interface DisputeReversal {
    transferId: string;
    params: Record<string, any>;
}
/**
 * Params to reverse the transfer for a disputed order, or null when there is
 * nothing to reverse (legacy order, no transferId, or already reversed). The
 * reversal is FULL (no amount → Stripe reverses the entire remaining transfer)
 * because a chargeback claws the whole charge. refund_application_fee is FALSE
 * (see the money-correctness note above): the platform keeps the fee it already
 * lost in the dispute debit and recovers the full principal from the shop.
 *
 * @param order  the order doc (needs order.connect.transferId)
 */
export declare function buildDisputeReversalParams(order: any): DisputeReversal | null;
/** A re-transfer target: send previously-reversed funds back to the shop. */
export interface DisputeReTransfer {
    params: Record<string, any>;
}
/**
 * Params to re-transfer the reversed amount back to the connected account when
 * a dispute is WON, or null when there is nothing/no-one to send to. Uses the
 * amount we actually reversed (persisted on the order at reversal time) so we
 * never over- or under-send. Currency mirrors the original charge.
 *
 * @param order  the order doc (needs connect.connectedAccountId +
 *               connect.disputeReversedAmount in öre)
 */
export declare function buildDisputeReTransferParams(order: any): DisputeReTransfer | null;
export interface ConnectBalanceSummary {
    currency: string;
    availableOre: number;
    pendingOre: number;
    reservedOre: number;
    negative: boolean;
}
/**
 * @param balance   a Stripe.Balance (or compatible) object
 * @param currency  ISO code to report (default 'sek')
 */
export declare function summarizeConnectBalance(balance: any, currency?: string): ConnectBalanceSummary;
export interface RefundValidation {
    ok: boolean;
    error?: string;
    remainingSek: number;
}
export declare function validateRefundRequest(chargedSek: number, refundedBeforeSek: number, requestedAmount?: number | null): RefundValidation;
export interface RefundState {
    refundedTotalSek: number;
    isFull: boolean;
    status: 'refunded' | 'partially_refunded';
}
export declare function refundStateAfter(chargedSek: number, refundedBeforeSek: number, refundNowSek: number): RefundState;
