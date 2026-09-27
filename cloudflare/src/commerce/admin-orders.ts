import type { TenantAdminPrincipal } from "../auth/live-authorization";
import type { Payout, PayoutFacts } from "./payouts";
import { computePayout, disputeBlocksRefund, PAYOUT_FACT_COLUMNS } from "./payouts";
import type { RefundState } from "./refunds";

/**
 * `GET /v1/admin/orders/:orderId` — the money facts of one order, for the
 * shop's own admin.
 *
 * ── THE SELLER SEES ONE NUMBER (HARD RULE, memory seller-sees-one-number) ────
 * The response is built field by field from named columns, never by spreading
 * a row. The platform's deduction is ONE figure, `feeMinor`
 * ("Avgift (plattform & produktion)", LAUNCH_TODO A1b). Its split — the
 * commission, the withheld production cost, the per-line production costs,
 * the snapshot, the printer, the connected account, the transfer reversals —
 * is never read into this projection, so no later field addition can leak it
 * by accident. The admin-orders suite walks the response against a denylist and
 * checks that neither half of the fee appears anywhere in the body.
 */

export interface AdminOrderView {
  currency: string;
  money: {
    chargedMinor: number;
    dispute: { amountMinor: number; status: string } | null;
    feeMinor: number;
    refundableMinor: number;
    refundedMinor: number;
    refundPendingMinor: number;
  };
  orderId: string;
  orderNumber: string;
  paidAt: string;
  payout: Payout;
  refunds: Array<{
    amountMinor: number;
    createdAt: string;
    origin: "admin" | "stripe";
    reason: string | null;
    refundId: string;
    state: RefundState;
  }>;
  status: string;
  totals: {
    discountMinor: number;
    shippingMinor: number;
    subtotalMinor: number;
    totalMinor: number;
    vatMinor: number;
  };
}

interface AdminOrderRow extends PayoutFacts {
  currency: string;
  discount_minor: number;
  dispute_amount_minor: number;
  order_id: string;
  order_number: string;
  refund_reserved_minor: number;
  shipping_minor: number;
  status: string;
  stripe_payouts_enabled: number;
  subtotal_minor: number;
  total_minor: number;
  vat_minor: number;
}

/** Bounded: an order with more refund operations than this is not real. */
const MAX_REFUNDS_LISTED = 100;

export async function readAdminOrder(
  db: D1Database,
  principal: TenantAdminPrincipal,
  orderId: string,
  now: number,
): Promise<AdminOrderView | null> {
  const order = await db
    .prepare(
      `SELECT o.order_id, o.order_number, o.status, o.currency,
              o.subtotal_minor, o.shipping_minor, o.discount_minor,
              o.vat_minor, o.total_minor, o.refund_reserved_minor,
              o.dispute_amount_minor, ${PAYOUT_FACT_COLUMNS},
              t.stripe_payouts_enabled
       FROM orders AS o
       JOIN tenants AS t ON t.tenant_id = o.tenant_id
       WHERE o.order_id = ? AND o.tenant_id = ?
       LIMIT 1`,
    )
    .bind(orderId, principal.tenantId)
    .first<AdminOrderRow>();
  if (order === null) {
    return null;
  }

  const refunds = await db
    .prepare(
      `SELECT id, amount_minor, state, origin, reason, created_at
       FROM refund_operations
       WHERE tenant_id = ? AND order_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(principal.tenantId, orderId, MAX_REFUNDS_LISTED)
    .all<{
      amount_minor: number;
      created_at: string;
      id: string;
      origin: "admin" | "stripe";
      reason: string | null;
      state: RefundState;
    }>();

  const remaining =
    order.charged_minor -
    order.refund_succeeded_minor -
    order.refund_reserved_minor;

  return {
    currency: order.currency,
    money: {
      chargedMinor: order.charged_minor,
      dispute:
        order.dispute_status === null
          ? null
          : {
              amountMinor: order.dispute_amount_minor,
              status: order.dispute_status,
            },
      feeMinor: order.application_fee_minor,
      refundableMinor: disputeBlocksRefund(order.dispute_status)
        ? 0
        : Math.max(0, remaining),
      refundedMinor: order.refund_succeeded_minor,
      refundPendingMinor: order.refund_reserved_minor,
    },
    orderId: order.order_id,
    orderNumber: order.order_number,
    paidAt: new Date(order.paid_at).toISOString(),
    payout: computePayout(order, now, order.stripe_payouts_enabled === 1),
    refunds: refunds.results.map((refund) => ({
      amountMinor: refund.amount_minor,
      createdAt: refund.created_at,
      origin: refund.origin,
      reason: refund.reason,
      refundId: refund.id,
      state: refund.state,
    })),
    status: order.status,
    totals: {
      discountMinor: order.discount_minor,
      shippingMinor: order.shipping_minor,
      subtotalMinor: order.subtotal_minor,
      totalMinor: order.total_minor,
      vatMinor: order.vat_minor,
    },
  };
}
