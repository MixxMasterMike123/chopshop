"use strict";
/**
 * Stripe Connect — pure parameter builders (no I/O, no Stripe SDK).
 *
 * Extracted from createPaymentIntent.ts (destination-charge branch) and
 * connectRefund.ts (refund branch) so the money-path DECISION LOGIC is unit-
 * testable without hitting Stripe or Firestore. The handlers call these; the
 * tests assert the exact param shapes (the bugs that would actually hurt:
 * forgetting transfer_data, a wrong fee, or a Connect refund missing the
 * transfer reversal). Fee arithmetic lives in connectFee.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.refundStateAfter = exports.validateRefundRequest = exports.summarizeConnectBalance = exports.buildDisputeReTransferParams = exports.buildDisputeReversalParams = exports.buildRefundParams = exports.buildConnectChargeParams = void 0;
const connectFee_1 = require("./connectFee");
/**
 * Decide the destination-charge params for a checkout. A shop is "Connect-
 * enabled" ONLY when it has a usable connected account (chargesEnabled +
 * stripeAccountId); otherwise the result is empty and the PaymentIntent is the
 * legacy single-account charge. NO on_behalf_of → platform stays VAT MoR.
 *
 * @param pay              shops/{id}.payments map (may be undefined)
 * @param amountOre        gross charge amount in öre
 * @param platformDefaultBps  fallback commission (settings/platform → env)
 */
function buildConnectChargeParams(pay, amountOre, platformDefaultBps) {
    const useConnect = pay?.chargesEnabled === true && !!pay?.stripeAccountId;
    if (!useConnect)
        return { params: {}, meta: {}, useConnect: false };
    const bps = (0, connectFee_1.resolveCommissionBps)(pay.commissionBps, platformDefaultBps);
    const feeOre = (0, connectFee_1.computeApplicationFeeOre)(amountOre, bps);
    return {
        useConnect: true,
        params: {
            transfer_data: { destination: pay.stripeAccountId },
            application_fee_amount: feeOre,
        },
        meta: {
            connectedAccountId: pay.stripeAccountId,
            applicationFeeAmount: String(feeOre),
            commissionBps: String(bps),
        },
    };
}
exports.buildConnectChargeParams = buildConnectChargeParams;
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
function buildRefundParams(order, amountSek, refundApplicationFee = true) {
    const paymentIntentId = order?.payment?.paymentIntentId;
    const params = { payment_intent: paymentIntentId };
    if (typeof amountSek === 'number' && amountSek > 0) {
        params.amount = Math.round(amountSek * 100);
    }
    if (order?.connect?.isDestinationCharge === true) {
        // Always claw the principal back from the shop on a Connect refund —
        // otherwise the platform eats the refund while the shop keeps the transfer.
        params.reverse_transfer = true;
        // The platform fee is returned only when policy says so. We set the key
        // explicitly (true OR false) so the intent is unambiguous to Stripe and in
        // the persisted reconciliation — never silently omitted.
        params.refund_application_fee = refundApplicationFee === true;
    }
    return params;
}
exports.buildRefundParams = buildRefundParams;
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
function buildDisputeReversalParams(order) {
    const connect = order?.connect;
    if (!connect || connect.isDestinationCharge !== true)
        return null; // legacy → platform already bears it, nothing to claw
    if (connect.transferReversed === true)
        return null; // idempotent: already reversed (refund or prior dispute)
    const transferId = connect.transferId;
    if (!transferId || typeof transferId !== 'string')
        return null; // no transfer recorded → cannot reverse, caller alerts
    return {
        transferId,
        params: {
            // No `amount` → full reversal of the remaining transfer (gross − fee).
            // false → fee stays lost on the platform (already debited); shop nets 0.
            refund_application_fee: false,
            metadata: {
                reason: 'dispute_recovery',
                orderId: order?.payment?.paymentIntentId || '',
                disputeId: order?.disputeId || '',
            },
        },
    };
}
exports.buildDisputeReversalParams = buildDisputeReversalParams;
/**
 * Params to re-transfer the reversed amount back to the connected account when
 * a dispute is WON, or null when there is nothing/no-one to send to. Uses the
 * amount we actually reversed (persisted on the order at reversal time) so we
 * never over- or under-send. Currency mirrors the original charge.
 *
 * @param order  the order doc (needs connect.connectedAccountId +
 *               connect.disputeReversedAmount in öre)
 */
function buildDisputeReTransferParams(order) {
    const connect = order?.connect;
    if (!connect || connect.isDestinationCharge !== true)
        return null;
    if (connect.transferReversed !== true)
        return null; // nothing was reversed → nothing to send back
    if (connect.disputeReTransferId)
        return null; // idempotent: already re-transferred
    const destination = connect.connectedAccountId;
    const amountOre = connect.disputeReversedAmount;
    if (!destination || typeof destination !== 'string')
        return null;
    if (!Number.isInteger(amountOre) || amountOre <= 0)
        return null;
    const currency = (order?.payment?.currency || 'sek').toLowerCase();
    return {
        params: {
            amount: amountOre,
            currency,
            destination,
            metadata: {
                reason: 'dispute_won_retransfer',
                orderId: order?.payment?.paymentIntentId || '',
                disputeId: order?.disputeId || '',
            },
        },
    };
}
exports.buildDisputeReTransferParams = buildDisputeReTransferParams;
function sumForCurrency(arr, currency) {
    if (!Array.isArray(arr))
        return 0;
    return arr
        .filter((e) => (e?.currency || '').toLowerCase() === currency)
        .reduce((acc, e) => acc + (Number.isFinite(e?.amount) ? e.amount : 0), 0);
}
/**
 * @param balance   a Stripe.Balance (or compatible) object
 * @param currency  ISO code to report (default 'sek')
 */
function summarizeConnectBalance(balance, currency = 'sek') {
    const cur = (currency || 'sek').toLowerCase();
    const availableOre = sumForCurrency(balance?.available, cur);
    const pendingOre = sumForCurrency(balance?.pending, cur);
    // connect_reserved holds funds withheld to cover negative balances on
    // connected accounts; it's another risk signal.
    const reservedOre = sumForCurrency(balance?.connect_reserved, cur);
    return {
        currency: cur,
        availableOre,
        pendingOre,
        reservedOre,
        // Negative when the spendable balance is below zero (the seller owes).
        negative: availableOre < 0,
    };
}
exports.summarizeConnectBalance = summarizeConnectBalance;
function validateRefundRequest(chargedSek, refundedBeforeSek, requestedAmount) {
    const charged = Number(chargedSek) || 0;
    const before = Number(refundedBeforeSek) || 0;
    const remainingSek = Math.round((charged - before) * 100) / 100;
    if (remainingSek <= 0.005) {
        return { ok: false, error: 'Order is already fully refunded', remainingSek: 0 };
    }
    if (requestedAmount === undefined || requestedAmount === null) {
        return { ok: true, remainingSek }; // absent amount = refund the remainder
    }
    const amt = Number(requestedAmount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > remainingSek + 0.005) {
        return { ok: false, error: `Refund amount must be between 0 and ${remainingSek} SEK`, remainingSek };
    }
    return { ok: true, remainingSek };
}
exports.validateRefundRequest = validateRefundRequest;
function refundStateAfter(chargedSek, refundedBeforeSek, refundNowSek) {
    const charged = Number(chargedSek) || 0;
    const refundedTotalSek = Math.round(((Number(refundedBeforeSek) || 0) + (Number(refundNowSek) || 0)) * 100) / 100;
    // A zero/unknown charge with a successful Stripe refund counts as full —
    // never strand an order in partially_refunded on missing legacy data.
    const isFull = charged <= 0 || refundedTotalSek >= charged - 0.005;
    return { refundedTotalSek, isFull, status: isFull ? 'refunded' : 'partially_refunded' };
}
exports.refundStateAfter = refundStateAfter;
//# sourceMappingURL=connectParams.js.map