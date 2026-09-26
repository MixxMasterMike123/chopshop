// shopPayout.js — what the shop keeps of a Stripe Connect destination charge,
// AFTER refunds. Pure (no firebase, no React) so rules-tests can import it;
// OrderPaymentCard renders the number.
//
// At checkout the transfer to the shop is total − applicationFee (the ONE fee,
// A1b). Every refund (functions/src/payment/connectRefund.ts) is created with
// reverse_transfer, and Stripe reverses the transfer PROPORTIONALLY to the
// refunded share of the charge, so the shop's settlement is
//
//     (total − fee) × (charged − refunded) / charged
//
// whatever the platform decides about its own fee (refund_application_fee only
// moves money on the platform's side). A fully refunded order → 0. Before this
// (CODEX audit 2026-09-26 F5) the card showed total − fee regardless of
// payment.refundedTotalSek, so a refunded order still read as paid out.
//
// This is the settlement Stripe books for the order, not proof that a payout
// to the shop's bank has run — payouts are on the connected account's schedule.

/** Round to öre. */
const ore = (n) => Math.round(n * 100) / 100;

/**
 * shopPayoutSek({ total, feeSek, chargedSek, refundedSek }) → kr
 *
 *   total       the order total the card shows (kr)
 *   feeSek      connect.applicationFeeAmount in kr (connectFeeSekOf)
 *   chargedSek  payment.amount (kr) — the charge the refund share is taken
 *               against; falls back to `total` when absent (older orders)
 *   refundedSek payment.refundedTotalSek (kr, cumulative, absent = 0)
 */
export const shopPayoutSek = ({ total, feeSek, chargedSek, refundedSek }) => {
  const t = Number(total) || 0;
  const fee = Number(feeSek) || 0;
  const charged = Number(chargedSek) > 0 ? Number(chargedSek) : t;
  if (charged <= 0) return 0;
  const refunded = Math.min(Math.max(Number(refundedSek) || 0, 0), charged);
  return ore(Math.max(0, (t - fee) * (charged - refunded) / charged));
};
