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

import { computeApplicationFeeOre, resolveCommissionBps } from './connectFee';

export interface ConnectChargeBuild {
  // Spread into stripe.paymentIntents.create({ ... }). Empty for legacy shops.
  params: Record<string, any>;
  // Spread into the PaymentIntent metadata. Empty for legacy shops.
  meta: Record<string, string>;
  useConnect: boolean;
}

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
export function buildConnectChargeParams(
  pay: any,
  amountOre: number,
  platformDefaultBps: number
): ConnectChargeBuild {
  const useConnect = pay?.chargesEnabled === true && !!pay?.stripeAccountId;
  if (!useConnect) return { params: {}, meta: {}, useConnect: false };

  const bps = resolveCommissionBps(pay.commissionBps, platformDefaultBps);
  const feeOre = computeApplicationFeeOre(amountOre, bps);
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
export function buildRefundParams(
  order: any,
  amountSek?: number,
  refundApplicationFee: boolean = true
): Record<string, any> {
  const paymentIntentId = order?.payment?.paymentIntentId;
  const params: Record<string, any> = { payment_intent: paymentIntentId };
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

// ── Dispute / chargeback recovery (Slice A) ─────────────────────────────────
//
// On a DESTINATION charge the platform is the merchant of record, so when a
// chargeback is created Stripe debits the PLATFORM balance for the FULL charge
// (+ a dispute fee). The principal already left for the shop as the transfer.
// To recover, the platform reverses that transfer (clawing the money back from
// the connected account). SE/EU accounts do NOT auto-debit the seller's bank
// for a resulting negative balance — the caller must detect the shortfall and
// alert (handled in the webhook), not assume recovery succeeded.
//
// ⚠️ MONEY-CORRECTNESS (derived from balance mechanics, NOT prose):
// On a transfer REVERSAL, refund_application_fee=true credits the application
// fee to the CONNECTED ACCOUNT (it un-does the original fee deduction) — the
// OPPOSITE direction from a charge refund. So to make the PLATFORM whole on a
// dispute we use refund_application_fee=FALSE: reverse the full principal
// (gross − fee) the shop received, leaving the shop at net zero on the sale and
// the platform down only the unavoidable dispute fee.
//   Worked example (gross 12500, fee 625, transfer 11875, dispute fee 1500):
//     refund_application_fee=false → shop net 0, platform net −1500 (dispute fee). ✅
//     refund_application_fee=true  → shop net +625, platform net −2750.            ✗ (shop profits)
// This is INDEPENDENT of the consumer-refund policy flag (Slice C), which is a
// different flow (a refund's refund_application_fee returns the fee to the
// BUYER and is the platform's choice). A dispute reversal is platform↔shop only.

/** A reversal target: the order's recorded destination-charge transfer. */
export interface DisputeReversal {
  // stripe.transfers.createReversal(transferId, params)
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
export function buildDisputeReversalParams(order: any): DisputeReversal | null {
  const connect = order?.connect;
  if (!connect || connect.isDestinationCharge !== true) return null; // legacy → platform already bears it, nothing to claw
  if (connect.transferReversed === true) return null;                 // idempotent: already reversed (refund or prior dispute)
  const transferId = connect.transferId;
  if (!transferId || typeof transferId !== 'string') return null;     // no transfer recorded → cannot reverse, caller alerts
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

/** A re-transfer target: send previously-reversed funds back to the shop. */
export interface DisputeReTransfer {
  // stripe.transfers.create(params)
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
export function buildDisputeReTransferParams(order: any): DisputeReTransfer | null {
  const connect = order?.connect;
  if (!connect || connect.isDestinationCharge !== true) return null;
  if (connect.transferReversed !== true) return null;          // nothing was reversed → nothing to send back
  if (connect.disputeReTransferId) return null;                // idempotent: already re-transferred
  const destination = connect.connectedAccountId;
  const amountOre = connect.disputeReversedAmount;
  if (!destination || typeof destination !== 'string') return null;
  if (!Number.isInteger(amountOre) || amountOre <= 0) return null;
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

// ── Connected-account balance summary (Slice B) ─────────────────────────────
//
// Reduce a Stripe.Balance (available/pending/connect_reserved arrays, one entry
// per currency) to the figures the admin UI shows for ONE currency, plus a
// negative-balance flag. Pure so it's unit-testable without Stripe. A negative
// available balance on a connected account is the payout-risk signal: SE/EU
// accounts do NOT auto-debit the seller's bank, so it can sit negative until
// recovered — the platform must SEE it.

export interface ConnectBalanceSummary {
  currency: string;
  availableOre: number;
  pendingOre: number;
  reservedOre: number;
  negative: boolean;
}

function sumForCurrency(arr: any[] | undefined, currency: string): number {
  if (!Array.isArray(arr)) return 0;
  return arr
    .filter((e) => (e?.currency || '').toLowerCase() === currency)
    .reduce((acc, e) => acc + (Number.isFinite(e?.amount) ? e.amount : 0), 0);
}

/**
 * @param balance   a Stripe.Balance (or compatible) object
 * @param currency  ISO code to report (default 'sek')
 */
export function summarizeConnectBalance(balance: any, currency: string = 'sek'): ConnectBalanceSummary {
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

// ────────────────────────────────────────────────────────────────────────────
// Cumulative refund accounting (P1-08, 2026-08-15 audit) — pure, unit-tested.
//
// A PARTIAL refund must NOT mark the whole order refunded: doing so blocked
// any follow-up refund and fired a FULL affiliate-commission reversal for a
// 10 kr goodwill refund. These helpers make refunds cumulative:
//   • validateRefundRequest — the request may only refund what REMAINS.
//   • refundStateAfter      — the order's status after a successful refund:
//     'refunded' only when the cumulative total covers the charge, otherwise
//     'partially_refunded' (which keeps the refund button usable and does NOT
//     fire the commission-reversal trigger — POLICY: affiliate commission
//     reverses only on FULL refund/cancel, a partial goodwill refund keeps it).
// ────────────────────────────────────────────────────────────────────────────

export interface RefundValidation {
  ok: boolean;
  error?: string;
  remainingSek: number; // what may still be refunded
}

export function validateRefundRequest(
  chargedSek: number,
  refundedBeforeSek: number,
  requestedAmount?: number | null
): RefundValidation {
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

export interface RefundState {
  refundedTotalSek: number;
  isFull: boolean;
  status: 'refunded' | 'partially_refunded';
}

export function refundStateAfter(
  chargedSek: number,
  refundedBeforeSek: number,
  refundNowSek: number
): RefundState {
  const charged = Number(chargedSek) || 0;
  const refundedTotalSek = Math.round(((Number(refundedBeforeSek) || 0) + (Number(refundNowSek) || 0)) * 100) / 100;
  // A zero/unknown charge with a successful Stripe refund counts as full —
  // never strand an order in partially_refunded on missing legacy data.
  const isFull = charged <= 0 || refundedTotalSek >= charged - 0.005;
  return { refundedTotalSek, isFull, status: isFull ? 'refunded' : 'partially_refunded' };
}
