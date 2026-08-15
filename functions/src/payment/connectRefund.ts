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
// CUMULATIVE (P1-08, 2026-08-15 audit): refunds accumulate on
// payment.refundedTotalSek. Only when the total covers the charge does the
// order move to 'refunded' (which fires reverseAffiliateCommissionOnCancel →
// the affiliate ledger reverses; POLICY: full refund only) and stamp
// connect.transferReversed. A partial sets 'partially_refunded' and leaves the
// remainder refundable. Requests are validated against the REMAINDER, and the
// Stripe call carries an idempotency key so retries can't double-refund.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import Stripe from 'stripe';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/database';
import { appUrls } from '../config/app-urls';
import { requireAdminOfShop } from '../email-orchestrator/functions/authGuard';
import { buildRefundParams, validateRefundRequest, refundStateAfter } from './connectParams';
import { readPlatformConfig } from './platformConfig';

interface RefundRequest { orderId: string; amount?: number } // amount in SEK (optional partial)

export const refundOrder = onCall<RefundRequest>(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: appUrls.CORS_ORIGINS,
    secrets: ['STRIPE_SECRET_KEY', 'RESEND_API_KEY'],
  },
  async (request) => {
    const orderId = (request.data?.orderId || '').trim();
    if (!orderId) throw new HttpsError('invalid-argument', 'orderId is required');

    const orderRef = db.collection('orders').doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
    const order = snap.data() as any;

    // Authority: derive the shop from the ORDER (trustworthy), not the request.
    await requireAdminOfShop(order.shopId, request.auth?.uid);

    // Full-refund guard. 'refunded' means the CUMULATIVE total covered the
    // charge (P1-08); a 'partially_refunded' order may keep refunding the rest.
    if (order.status === 'refunded' || order.connect?.transferReversed === true) {
      throw new HttpsError('failed-precondition', 'Order is already refunded');
    }
    const paymentIntentId = order.payment?.paymentIntentId;
    if (!paymentIntentId) throw new HttpsError('failed-precondition', 'Order has no payment to refund');

    // Cumulative partial-refund guard (P1-08, 2026-08-15 audit): validate the
    // request against what REMAINS (charged − already refunded), not the full
    // charge. Absent/undefined amount = refund the remainder (buildRefundParams
    // then omits `amount`, and Stripe refunds the un-refunded balance).
    const requestedAmount = request.data?.amount;
    const chargedSek = Number(order.payment?.amount) || 0;
    const refundedBeforeSek = Number(order.payment?.refundedTotalSek) || 0;
    const validation = validateRefundRequest(chargedSek, refundedBeforeSek, requestedAmount);
    if (!validation.ok) {
      throw new HttpsError('invalid-argument', validation.error || 'Invalid refund amount');
    }

    const key = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!key) throw new HttpsError('failed-precondition', 'Stripe is not configured');
    const stripe = new Stripe(key, { apiVersion: '2023-10-16' });

    const isConnect = order.connect?.isDestinationCharge === true;
    // Platform policy: should a refund ALSO return the platform fee to the buyer?
    // Default true (current behaviour); settings/platform.refundApplicationFee
    // can flip it to keep the fee as a non-refundable service fee.
    const { refundApplicationFee } = await readPlatformConfig();
    // Pure builder (connectParams.ts, unit-tested): a destination-charge order
    // gets reverse_transfer (+ refund_application_fee per policy); a legacy
    // order is plain.
    const params = buildRefundParams(
      order,
      request.data?.amount,
      refundApplicationFee
    ) as Stripe.RefundCreateParams;

    // Idempotency (P2-08 family): a retried/double-clicked identical request
    // must not create a second Stripe refund. The key includes the cumulative
    // position, so a SECOND deliberate refund of the same amount (after the
    // first completed and moved refundedTotalSek) gets a fresh key.
    const idempotencyKey =
      `refund:${orderId}:${paymentIntentId}:${refundedBeforeSek.toFixed(2)}:${requestedAmount ?? 'rest'}`;
    const refund = await stripe.refunds.create(params, { idempotencyKey });

    // Stamp the order CUMULATIVELY (P1-08). Only a refund that covers the full
    // charge sets status 'refunded' (which fires the affiliate commission-
    // reversal trigger — POLICY: commission reverses on FULL refund only) and
    // the Connect transferReversed flag; a partial sets 'partially_refunded'
    // and leaves further refunds possible. refundedTotalSek is written as an
    // ABSOLUTE value (before + this refund), so an idempotent Stripe replay
    // that runs this block twice converges instead of double-counting.
    const refundedNowSek = (refund.amount || 0) / 100;
    const state = refundStateAfter(chargedSek, refundedBeforeSek, refundedNowSek);
    const patch: Record<string, any> = {
      status: state.status,
      updatedAt: FieldValue.serverTimestamp(),
      'payment.refundId': refund.id, // latest refund (legacy field, kept)
      'payment.refundIds': FieldValue.arrayUnion(refund.id),
      'payment.refundedTotalSek': state.refundedTotalSek,
      'payment.refundedAt': FieldValue.serverTimestamp(),
    };
    if (isConnect) {
      // reverse_transfer is proportional per refund at Stripe; the order-level
      // "fully clawed back" flag is only true once the refund total is full.
      if (state.isFull) patch['connect.transferReversed'] = true;
      // Reconciliation: record whether the platform fee was returned on this
      // refund (policy at the time of the refund), so the ledger is auditable.
      patch['connect.refundApplicationFee'] = refundApplicationFee === true;
    }
    await orderRef.update(patch);

    // Buyer refund receipt (best-effort — a refund must NEVER fail on email).
    // refund.amount is in öre; the buyer-facing amount is SEK. A partial refund
    // is detected by comparing against the charged amount.
    try {
      const refundedSek = refundedNowSek;
      // "Full" for the buyer = the ORDER is now fully refunded (cumulative),
      // even when this particular refund only covered the remainder.
      const isFullRefund = state.isFull;
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
        shopId: order.shopId, // tenant identity: send as the SHOP
        additionalData: {
          orderNumber: order.orderNumber,
          refundAmountSek: refundedSek,
          currency: (order.currency || 'SEK'),
          isFullRefund,
          hasWithdrawal: !!order.withdrawalRequest,
        },
      });
    } catch (emailError) {
      console.error('❌ refundOrder: refund confirmation email failed (refund succeeded):', emailError);
    }

    return { refundId: refund.id, isConnect, amount: refund.amount, refundApplicationFee };
  }
);
