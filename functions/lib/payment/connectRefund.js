"use strict";
// Stripe refund — Connect-aware (Slice 4).
//
// Refunds an order's payment. For a CONNECT (destination-charge) order the
// refund MUST also claw the money back from the connected account
// (reverse_transfer) and return the platform's cut (refund_application_fee),
// otherwise the platform eats the refund while the shop keeps the transfer.
// A LEGACY (single-account) order takes a plain refund.
//
// Auth: requireAdminOfShop(order.shopId, uid) — the target shop is read from
// the ORDER doc, never a request field (Admin SDK bypasses rules, so the shop
// boundary is enforced here). A shop admin may only refund their OWN shop's
// orders; platform may refund any.
//
// On success the order is moved to status 'refunded' (which fires the existing
// reverseAffiliateCommissionOnCancel trigger → the affiliate ledger reverses
// automatically; no affiliate code here) and order.connect.transferReversed is
// stamped. Double-refund guarded by the existing status / transferReversed.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.refundOrder = void 0;
const https_1 = require("firebase-functions/v2/https");
const stripe_1 = __importDefault(require("stripe"));
const firestore_1 = require("firebase-admin/firestore");
const database_1 = require("../config/database");
const app_urls_1 = require("../config/app-urls");
const authGuard_1 = require("../email-orchestrator/functions/authGuard");
const connectParams_1 = require("./connectParams");
const platformConfig_1 = require("./platformConfig");
exports.refundOrder = (0, https_1.onCall)({
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: app_urls_1.appUrls.CORS_ORIGINS,
    secrets: ['STRIPE_SECRET_KEY', 'RESEND_API_KEY'],
}, async (request) => {
    const orderId = (request.data?.orderId || '').trim();
    if (!orderId)
        throw new https_1.HttpsError('invalid-argument', 'orderId is required');
    const orderRef = database_1.db.collection('orders').doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists)
        throw new https_1.HttpsError('not-found', 'Order not found');
    const order = snap.data();
    // Authority: derive the shop from the ORDER (trustworthy), not the request.
    await (0, authGuard_1.requireAdminOfShop)(order.shopId, request.auth?.uid);
    // Double-refund guard. Only a FULLY refunded order is closed to further
    // refunds; a partially refunded one may still be refunded up to the
    // remaining balance (enforced by the amount guard below).
    if (order.status === 'refunded' || order.connect?.transferReversed === true) {
        throw new https_1.HttpsError('failed-precondition', 'Order is already refunded');
    }
    const paymentIntentId = order.payment?.paymentIntentId;
    if (!paymentIntentId)
        throw new https_1.HttpsError('failed-precondition', 'Order has no payment to refund');
    // Partial-refund guard (2026-07-01 audit): never send Stripe a refund
    // larger than what was charged — Stripe would reject it anyway, but failing
    // fast here gives the admin a clear message and keeps a bad amount from
    // reaching the money API at all. Absent/undefined amount = full refund.
    // The cap is the REMAINING balance, not the original charge — otherwise two
    // 800 kr refunds on a 1000 kr order would each pass the check individually
    // and over-refund the buyer by 600 kr.
    const requestedAmount = request.data?.amount;
    if (requestedAmount !== undefined && requestedAmount !== null) {
        const chargedSek = Number(order.payment?.amount) || 0;
        const alreadyRefundedSek = Number(order.payment?.refundedAmount) || 0;
        const remainingSek = chargedSek - alreadyRefundedSek;
        const amt = Number(requestedAmount);
        if (!Number.isFinite(amt) || amt <= 0 || amt > remainingSek + 0.005) {
            throw new https_1.HttpsError('invalid-argument', `Refund amount must be between 0 and ${remainingSek} SEK`);
        }
    }
    const key = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!key)
        throw new https_1.HttpsError('failed-precondition', 'Stripe is not configured');
    const stripe = new stripe_1.default(key, { apiVersion: '2023-10-16' });
    const isConnect = order.connect?.isDestinationCharge === true;
    // Platform policy: should a refund ALSO return the platform fee to the buyer?
    // Default true (current behaviour); settings/platform.refundApplicationFee
    // can flip it to keep the fee as a non-refundable service fee.
    const { refundApplicationFee } = await (0, platformConfig_1.readPlatformConfig)();
    // Pure builder (connectParams.ts, unit-tested): a destination-charge order
    // gets reverse_transfer (+ refund_application_fee per policy); a legacy
    // order is plain.
    const params = (0, connectParams_1.buildRefundParams)(order, request.data?.amount, refundApplicationFee);
    const refund = await stripe.refunds.create(params);
    // Is this refund FULL or PARTIAL? Cumulative: a 300 kr refund on a 1000 kr
    // order that already had 700 kr returned is the one that closes it out.
    // refund.amount is in öre; order.payment.amount is SEK.
    const chargedSek = Number(order.payment?.amount) || 0;
    const previouslyRefundedSek = Number(order.payment?.refundedAmount) || 0;
    const thisRefundSek = (refund.amount || 0) / 100;
    const totalRefundedSek = previouslyRefundedSek + thisRefundSek;
    // No charge amount on record → treat as full (legacy orders); otherwise the
    // order is fully refunded once the cumulative total reaches the charge.
    const isFullRefund = !(chargedSek > 0) || totalRefundedSek >= chargedSek - 0.005;
    // Stamp the order. Setting status 'refunded' fires the affiliate-reversal
    // trigger (commissionReversal.ts) — the affiliate ledger reverses on its own.
    // A PARTIAL refund must NOT set it: that would reverse the whole commission
    // rather than a proportional share, block the remaining refund on the
    // double-refund guard above, disarm dispute clawback (buildDisputeReversalParams
    // returns null once transferReversed is true), and drop the entire order from
    // the DAC7 aggregate instead of just the refunded part.
    const patch = {
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
        'payment.refundId': refund.id,
        'payment.refundedAt': firestore_1.FieldValue.serverTimestamp(),
        'payment.refundedAmount': totalRefundedSek,
    };
    if (isFullRefund) {
        patch.status = 'refunded';
        if (isConnect) {
            patch['connect.transferReversed'] = true;
            // Reconciliation: record whether the platform fee was returned on this
            // refund (policy at the time of the refund), so the ledger is auditable.
            patch['connect.refundApplicationFee'] = refundApplicationFee === true;
        }
    }
    else {
        patch.status = 'partially_refunded';
    }
    await orderRef.update(patch);
    // Buyer refund receipt (best-effort — a refund must NEVER fail on email).
    // Reuses the cumulative isFullRefund computed above: the receipt must call
    // a refund "full" on the same basis the order status does, otherwise the
    // buyer is told the order was fully refunded when part of it still stands.
    // refundedSek is THIS refund's amount (what the buyer just got back).
    try {
        const refundedSek = thisRefundSek;
        const { EmailOrchestrator } = require('../email-orchestrator/core/EmailOrchestrator');
        const orchestrator = new EmailOrchestrator();
        await orchestrator.sendEmail({
            emailType: 'REFUND_CONFIRMATION',
            customerInfo: order.customerInfo,
            userId: order.userId,
            b2cCustomerId: order.b2cCustomerId,
            orderId,
            source: order.source,
            language: order.customerInfo?.preferredLang || 'sv-SE',
            orderData: order,
            shopId: order.shopId,
            additionalData: {
                orderNumber: order.orderNumber,
                refundAmountSek: refundedSek,
                currency: (order.currency || 'SEK'),
                isFullRefund,
                hasWithdrawal: !!order.withdrawalRequest,
            },
        });
    }
    catch (emailError) {
        console.error('❌ refundOrder: refund confirmation email failed (refund succeeded):', emailError);
    }
    return { refundId: refund.id, isConnect, amount: refund.amount, refundApplicationFee };
});
//# sourceMappingURL=connectRefund.js.map