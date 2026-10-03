import type { TenantAdminPrincipal } from "../auth/live-authorization";
import type { Payout, PayoutFacts } from "./payouts";
import { computePayout, disputeBlocksRefund, netFeeMinor, PAYOUT_FACT_COLUMNS } from "./payouts";
import type { RefundState } from "./refunds";
import type { FulfilmentState } from "./fulfilment";

/**
 * `GET /v1/admin/orders/:orderId` — the money facts of one order, for the
 * shop's own admin.
 *
 * ── THE SELLER SEES ONE NUMBER (HARD RULE, memory seller-sees-one-number) ────
 * The response is built field by field from named columns, never by spreading
 * a row. The platform's deduction is ONE figure, `feeMinor`
 * ("Avgift (plattform & produktion)", LAUNCH_TODO A1b) — net of a released
 * production withholding (D36), so payout = charged − refunded − fee holds for
 * the numbers the seller sees. Its split — the
 * commission, the withheld production cost, the per-line production costs,
 * the snapshot, the printer, the connected account, the transfer reversals —
 * is never read into this projection, so no later field addition can leak it
 * by accident. The admin-orders suite walks the response against a denylist and
 * checks that neither half of the fee appears anywhere in the body.
 *
 * CP5-WB adds what the shop needs to deliver: the buyer's address of contact,
 * the delivery method and country, the fulfilment state (0046), the
 * cancellation time, and the lines. A line says what was bought at what price
 * and, for a print-on-demand line, ONE seller-safe word of where the print is
 * (`podState`, see POD_STATE_SQL) — never the line's production snapshot, the
 * printer, its job reference, its cost or its error text.
 */

/**
 * The seller's word for a line's print (CP5-WB). Not named `production`: the
 * one-number denylist refuses every key that names production.
 *   none           not a print-on-demand line (no production snapshot)
 *   sent           the printer has sent it
 *   in_production  the printer has it (accepted), or it is being made
 *   failed         the printer refused it; the platform is on it
 *   cancelled      it was cancelled before it reached the printer
 *   queued         not yet at the printer (or its answer is being checked)
 */
export type PodState = "cancelled" | "failed" | "in_production" | "none" | "queued" | "sent";

const POD_STATE_SQL = `CASE
    WHEN i.production_json IS NULL THEN 'none'
    WHEN i.production_state = 'shipped' THEN 'sent'
    WHEN i.production_state IN ('in_production', 'produced') THEN 'in_production'
    WHEN i.dispatch_state = 'cancelled' THEN 'cancelled'
    WHEN i.dispatch_state = 'failed' THEN 'failed'
    WHEN i.dispatch_state = 'accepted' THEN 'in_production'
    ELSE 'queued'
  END`;

export interface AdminOrderItem {
  lineNo: number;
  lineTotalMinor: number;
  name: string;
  podState: PodState;
  quantity: number;
  sku: string;
  unitPriceMinor: number;
  /** The variant's label as the catalogue holds it NOW (not frozen); null without a variant. */
  variantLabel: string | null;
}

export interface AdminOrderView {
  cancelledAt: string | null;
  createdAt: string;
  currency: string;
  customerEmail: string;
  deliveryMethod: string;
  fulfilment: FulfilmentState;
  items: AdminOrderItem[];
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
  shippingCountry: string | null;
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
  cancelled_at: string | null;
  created_at: number;
  currency: string;
  customer_email: string;
  delivery_method: string;
  fulfilment_status: FulfilmentState;
  shipping_country: string | null;
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
/** Bounded: an order's lines are capped well below this at checkout. */
const MAX_ITEMS_LISTED = 200;

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
              o.dispute_amount_minor, o.created_at, o.customer_email,
              o.delivery_method, o.shipping_country, o.fulfilment_status,
              o.cancelled_at, ${PAYOUT_FACT_COLUMNS},
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

  // Named columns only; the production snapshot is read as "is there one".
  const items = await db
    .prepare(
      `SELECT i.item_index, i.sku, i.name, i.quantity, i.unit_price_minor,
              i.line_total_minor, v.label AS variant_label,
              ${POD_STATE_SQL} AS pod_state
       FROM order_items AS i
       LEFT JOIN product_variants AS v
         ON v.variant_id = i.variant_id AND v.tenant_id = i.tenant_id
       WHERE i.tenant_id = ? AND i.order_id = ?
       ORDER BY i.item_index
       LIMIT ?`,
    )
    .bind(principal.tenantId, orderId, MAX_ITEMS_LISTED)
    .all<{
      item_index: number;
      line_total_minor: number;
      name: string;
      pod_state: PodState;
      quantity: number;
      sku: string;
      unit_price_minor: number;
      variant_label: string | null;
    }>();

  const remaining =
    order.charged_minor -
    order.refund_succeeded_minor -
    order.refund_reserved_minor;

  return {
    cancelledAt: order.cancelled_at,
    createdAt: new Date(order.created_at).toISOString(),
    currency: order.currency,
    customerEmail: order.customer_email,
    deliveryMethod: order.delivery_method,
    fulfilment: order.fulfilment_status,
    items: items.results.map((item) => ({
      lineNo: item.item_index + 1,
      lineTotalMinor: item.line_total_minor,
      name: item.name,
      podState: item.pod_state,
      quantity: item.quantity,
      sku: item.sku,
      unitPriceMinor: item.unit_price_minor,
      variantLabel: item.variant_label,
    })),
    money: {
      chargedMinor: order.charged_minor,
      dispute:
        order.dispute_status === null
          ? null
          : {
              amountMinor: order.dispute_amount_minor,
              status: order.dispute_status,
            },
      // ONE figure: the platform's net deduction. A released production
      // withholding (D36) lowers it; nothing ever names the split.
      feeMinor: netFeeMinor(order),
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
    shippingCountry: order.shipping_country,
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
