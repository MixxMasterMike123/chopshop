// orderPaymentHarness.jsx — DEV-ONLY harness for eyeballing the admin order
// page's "Betalning" card (OrderPaymentCard) with FIXTURE orders, WITHOUT
// Firebase/auth. Open /order-payment-harness.html (vite dev server).
//
// A1b ("seller sees ONE number"): a Connect destination charge shows exactly
// ONE fee line "Avgift (plattform & produktion)" + "Utbetalning till butiken";
// a non-Connect order shows neither. Rendered in light and dark (the admin's
// `.dark` class) because the fee rows reuse the admin tokens.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import OrderPaymentCard from '../components/admin/OrderPaymentCard';

// A POD order on a destination charge: 2 × 299 kr tees + 49 kr frakt. The fee
// (öre) is what createPaymentIntent charged: platform % + withheld production,
// baked into ONE applicationFeeAmount — exactly what the order doc carries.
const CONNECT_ORDER = {
  source: 'b2c', subtotal: 517.6, vat: 129.4, total: 647, shipping: 49,
  connect: {
    isDestinationCharge: true, connectedAccountId: 'acct_FIXTURE',
    applicationFeeAmount: 31042, applicationFeeId: 'fee_x', transferId: 'tr_x', transferReversed: false,
  },
};
// Same, with an affiliate discount — the fee line sits under Totalt either way.
const CONNECT_AFFILIATE_ORDER = {
  ...CONNECT_ORDER, discountAmount: 59.8, affiliateCode: 'KENT10', discountPercentage: 10,
  subtotal: 469.76, vat: 117.44, total: 587.2,
  connect: { ...CONNECT_ORDER.connect, applicationFeeAmount: 29870 },
};
// Refunds (F5): Stripe reverses the transfer in proportion to each refund, so
// the payout follows payment.refundedTotalSek — 299 of 647 refunded keeps
// (647 − 310.42) × 348/647 = 181.04 kr; a full refund pays out 0.
const CONNECT_PARTIAL_REFUND_ORDER = {
  ...CONNECT_ORDER, status: 'partially_refunded',
  payment: { amount: 647, refundedTotalSek: 299, refundIds: ['re_x'] },
};
const CONNECT_FULL_REFUND_ORDER = {
  ...CONNECT_ORDER, status: 'refunded',
  payment: { amount: 647, refundedTotalSek: 647, refundIds: ['re_x', 're_y'] },
  connect: { ...CONNECT_ORDER.connect, transferReversed: true },
};
// Legacy single-account / B2B invoice: no connect → no fee lines at all.
const PLAIN_ORDER = { source: 'b2c', subtotal: 239.2, vat: 59.8, total: 299, shipping: 0 };

const cardProps = (order) => ({
  order, subtotal: order.subtotal, vat: order.vat, total: order.total, paid: true,
  isB2C: order.source === 'b2c', affiliateCode: order.affiliateCode, affiliatePct: order.discountPercentage || 0,
});

// The project's dark mode is a `.dark` CLASS (hooks/useDarkMode.js), so each
// pane wrapper carries it for the admin tokens to swap.
const Pane = ({ label, dark, children }) => (
  <div className={`${dark ? 'dark' : ''} min-w-[380px] flex-1`}>
    <div className="bg-admin-surface-2 px-3 py-1 font-mono text-[11px] text-admin-text-faint">{label}</div>
    <div className="min-h-[300px] bg-admin-bg p-4">{children}</div>
  </div>
);

const Row = ({ order, name }) => (
  <div className="flex flex-wrap">
    <Pane label={`LIGHT — ${name}`}><OrderPaymentCard {...cardProps(order)} /></Pane>
    <Pane label={`DARK — ${name}`} dark><OrderPaymentCard {...cardProps(order)} /></Pane>
  </div>
);

createRoot(document.getElementById('root')).render(
  <div>
    <Row order={CONNECT_ORDER} name="Connect-order (avgift + utbetalning)" />
    <Row order={CONNECT_AFFILIATE_ORDER} name="Connect-order med affiliate-rabatt" />
    <Row order={CONNECT_PARTIAL_REFUND_ORDER} name="Connect-order, delvis återbetald (299 av 647)" />
    <Row order={CONNECT_FULL_REFUND_ORDER} name="Connect-order, helt återbetald (utbetalning 0)" />
    <Row order={PLAIN_ORDER} name="utan Connect (inga avgiftsrader)" />
  </div>
);
