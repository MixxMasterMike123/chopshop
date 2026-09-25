// OrderPaymentCard — the "Betalning" card on the admin order detail page
// (Admin-Neutral surface). Extracted from AdminOrderDetail so the dev harness
// (/order-payment-harness.html) can render it with a fixture order — the page
// itself needs auth + OrderContext + AppLayout.
//
// A1b — ONE deduction (Mikael 2026-09-25, "seller sees ONE number"): on a
// Stripe Connect destination charge the card adds
//   Avgift (plattform & produktion)   - X kr
//   Utbetalning till butiken            Y kr
// X = connect.applicationFeeAmount (the platform's WHOLE take: its % AND any
// withheld production cost, baked together at checkout). No tooltip, no
// breakdown — and there is nothing to break it down WITH: the split is not on
// the order doc at all (it lives in the server-only orderProduction/{id}).
import React from 'react';
import { Card, StatusPill } from './ui';

/** "1 234,50 kr" — the order page's money format. */
export const formatSek = (n) =>
  (Number(n) || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';

/** One label/value line of an order summary card. */
export const SummaryRow = ({ label, value, strong, accent }) => (
  <div className="flex items-baseline justify-between gap-4 py-1 text-[13px]">
    <span className={accent ? 'text-admin-success-text' : 'text-admin-text-muted'}>{label}</span>
    <span className={`tabular-nums ${strong ? 'font-semibold text-admin-text' : accent ? 'text-admin-success-text' : 'text-admin-text'}`}>{value}</span>
  </div>
);

/**
 * The platform's ONE fee on a destination charge, in kr — null when the order
 * was not a destination charge (legacy single-account, B2B invoice).
 */
export const connectFeeSekOf = (order) =>
  order?.connect?.isDestinationCharge === true && Number.isFinite(order?.connect?.applicationFeeAmount)
    ? order.connect.applicationFeeAmount / 100
    : null;

const OrderPaymentCard = ({ order, subtotal, vat, total, paid, isB2C, affiliateCode, affiliatePct }) => {
  const feeSek = connectFeeSekOf(order);
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-admin-border px-4 py-3">
        <h3 className="text-[14px] font-semibold text-admin-text">Betalning</h3>
        {paid ? <StatusPill tone="success">Betald</StatusPill> : !isB2C ? <StatusPill tone="neutral">Faktura</StatusPill> : <StatusPill tone="warning">Väntar</StatusPill>}
      </div>
      <div className="px-4 py-3">
        <SummaryRow label="Delsumma" value={formatSek(subtotal)} />
        {isB2C && order.discountAmount > 0 && (
          <SummaryRow
            label={`Affiliate-rabatt (${affiliateCode || 'AFFILIATE'}), ${affiliatePct}%`}
            value={`- ${formatSek(order.discountAmount)}`}
            accent
          />
        )}
        {isB2C && order.shipping > 0 && <SummaryRow label="Frakt" value={formatSek(order.shipping)} />}
        <SummaryRow label="Moms (25%)" value={formatSek(vat)} />
        <div className="mt-1 border-t border-admin-border-soft pt-2">
          <SummaryRow label="Totalt" value={formatSek(total)} strong />
        </div>
        {feeSek != null && (
          <div className="mt-1 border-t border-admin-border-soft pt-2">
            <SummaryRow label="Avgift (plattform & produktion)" value={`- ${formatSek(feeSek)}`} />
            <SummaryRow label="Utbetalning till butiken" value={formatSek((Number(total) || 0) - feeSek)} strong />
          </div>
        )}
      </div>
    </Card>
  );
};

export default OrderPaymentCard;
