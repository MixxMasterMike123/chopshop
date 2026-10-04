// The seller's orders: the API's shapes → the shape the order pages read
// (CP5 unit FD). Pure; tested under Node (order.test.mjs).
//
// The pages (AdminOrders, AdminOrderDetail, AdminDashboard, OrderPaymentCard)
// were written against a Firestore order document: kronor, a `status` the
// badge and the status menu read, `customerInfo`, `shippingInfo`,
// `pickupLocation`, `items[].price`, Timestamps with `.toDate()`. The bridge is
// here, never in the markup.
//
// ── THE BADGE (one `status` for two tracks) ──────────────────────────────────
// The Worker keeps the money (`status`: paid, partially_refunded, refunded;
// `cancelledAt` for a cancellation) apart from the seller's fulfilment
// (`fulfilment`: unfulfilled → processing → shipped / ready_for_pickup →
// delivered → completed). The pages show ONE status. Rule, first that holds:
//   1. refunded   (status 'refunded', or refunded to the charge) → 'refunded'
//   2. cancelled  (`cancelledAt` set, or status 'cancelled')   → 'cancelled'
//   3. fulfilment 'unfulfilled'                                 → 'confirmed'
//      (the word the pages already have for a paid order nobody has handled
//      yet: "Bekräftad")
//   4. otherwise the fulfilment step                            → e.g. 'shipped'
// A partial refund does not take the badge (the order is still being
// delivered); the payment card shows the refunded amount. Refunded comes
// before cancelled: a cancelled order still owes the buyer the money, and the
// detail page offers "Återbetala" until the badge reads refunded.
//
// THE SELLER SEES ONE NUMBER: the fee is the server's `money.feeMinor`, the
// payout the server's `payout.amountMinor`; nothing here adds or subtracts
// money.

import { toTimestamp } from '../../api/admin/time.js';
import { minorToKronor } from './money.js';

/** The fulfilment steps a seller may target, in the order the menu lists them. */
export const FULFILMENT_TARGETS = ['processing', 'ready_for_pickup', 'shipped', 'delivered', 'completed'];

/** The Worker's transition table (cloudflare/src/commerce/fulfilment.ts). */
export const FULFILMENT_TRANSITIONS = Object.freeze({
  unfulfilled: ['processing', 'shipped', 'ready_for_pickup'],
  processing: ['shipped', 'ready_for_pickup'],
  shipped: ['shipped', 'delivered', 'completed'],
  ready_for_pickup: ['delivered', 'completed'],
  delivered: ['completed'],
  completed: [],
});

/** Fulfilment steps after which a cancellation is a return case (the Worker refuses it). */
const RETURN_CASE = new Set(['shipped', 'ready_for_pickup', 'delivered', 'completed']);

const isPickup = (deliveryMethod) => deliveryMethod === 'pickup';

const isCancelled = (o) => (typeof o.cancelledAt === 'string' && o.cancelledAt !== '') || o.status === 'cancelled';

const isRefundedToCharge = (o) => {
  const charged = o.money?.chargedMinor;
  const refunded = o.money?.refundedMinor;
  return Number.isSafeInteger(charged) && charged > 0 && Number.isSafeInteger(refunded) && refunded >= charged;
};

/** Closed for fulfilment: cancelled, or refunded to the charge (the Worker's `order_closed`). */
export function isClosed(o) {
  return isCancelled(o) || o.status === 'refunded' || isRefundedToCharge(o);
}

/** The ONE status the pages show (the rule at the top of this file). */
export function badgeStatus(o) {
  if (o.status === 'refunded' || isRefundedToCharge(o)) return 'refunded';
  if (isCancelled(o)) return 'cancelled';
  if (!o.fulfilment || o.fulfilment === 'unfulfilled') return 'confirmed';
  return o.fulfilment;
}

/**
 * What the status menu offers for this order: the fulfilment steps the
 * transition table allows from the current step for this delivery method,
 * then 'cancelled' (the cancel route) while the order is open and nothing has
 * left the shop. A closed order offers nothing.
 */
export function statusOptionsOf(o) {
  if (isClosed(o)) return [];
  const from = o.fulfilment || 'unfulfilled';
  const allowed = new Set(FULFILMENT_TRANSITIONS[from] ?? []);
  allowed.delete(isPickup(o.deliveryMethod) ? 'shipped' : 'ready_for_pickup');
  const options = FULFILMENT_TARGETS.filter((step) => allowed.has(step));
  if (!RETURN_CASE.has(from)) options.push('cancelled');
  return options;
}

const kr = (minor) => minorToKronor(minor) ?? 0;

const text = (value) => (typeof value === 'string' && value !== '' ? value : null);

/** One row of `GET /v1/admin/orders` → a row of the order list and the dashboard. */
export function orderFromListRow(row) {
  const name = text(row.recipientName);
  return {
    id: row.orderId,
    orderNumber: row.orderNumber,
    createdAt: toTimestamp(row.createdAt),
    paidAt: toTimestamp(row.paidAt),
    status: badgeStatus(row),
    moneyStatus: row.status,
    fulfilment: row.fulfilment,
    cancelledAt: row.cancelledAt ?? null,
    statusOptions: statusOptionsOf(row),
    source: 'b2c',
    deliveryMethod: row.deliveryMethod,
    total: kr(row.totalMinor),
    currency: row.currency,
    refundedTotal: kr(row.refundedMinor),
    itemCount: Number.isSafeInteger(row.itemCount) ? row.itemCount : 0,
    customerInfo: { email: row.customerEmail ?? '', name },
    pickupLocation: text(row.pickupPlace) ? { name: row.pickupPlace } : null,
    // Every order of this API was paid when it was created (the webhook).
    payment: { status: 'succeeded' },
  };
}

// The status history: the Worker's two tracks in one list, in the words the
// page already prints. A payment row's first `from` is null (the order was
// created paid): before that the order waited for its payment.
const historyStep = (track, value) => {
  if (value === null || value === undefined) return 'pending';
  if (track === 'fulfilment' && value === 'unfulfilled') return 'confirmed';
  return value;
};

const ACTOR = { system: 'System', admin: 'Butiken', platform: 'Plattformen' };

function historyEntry(entry) {
  return {
    track: entry.track,
    from: historyStep(entry.track, entry.from),
    to: historyStep(entry.track, entry.to),
    changedAt: toTimestamp(entry.at),
    displayName: ACTOR[entry.by] ?? null,
    reason: entry.reason ?? null,
  };
}

function itemOf(item) {
  return {
    lineNo: item.lineNo,
    name: item.name,
    label: text(item.variantLabel),
    sku: item.sku,
    quantity: item.quantity,
    price: kr(item.unitPriceMinor),
    lineTotal: kr(item.lineTotalMinor),
    podState: item.podState,
  };
}

function shippingInfoOf(recipient) {
  if (!recipient || isPickup(recipient.deliveryMethod)) return null;
  return {
    address: recipient.addressLine1 ?? '',
    apartment: recipient.addressLine2 ?? '',
    postalCode: recipient.postalCode ?? '',
    city: recipient.city ?? '',
    country: recipient.country ?? '',
  };
}

function pickupLocationOf(recipient) {
  if (!recipient || !isPickup(recipient.deliveryMethod)) return null;
  return {
    id: recipient.pickupLocationId ?? null,
    name: recipient.pickupLocationName ?? '',
    address: recipient.pickupLocationAddress ?? '',
    date: recipient.pickupDate ?? null,
  };
}

// The buyer's consent to the exception from the right of withdrawal
// (personalised goods), in the fields the page's card reads.
function withdrawalOf(order) {
  const consent = order.consent;
  const personalised = consent?.withdrawal?.personalizedItems ?? [];
  if (!consent || personalised.length === 0) return null;
  return {
    required: true,
    consent: consent.withdrawal.waived === true,
    noticeVersion: consent.withdrawal.disclosureVersion ?? null,
    consentAt: consent.recordedAt ?? null,
  };
}

function withdrawalRequestOf(request) {
  if (!request) return null;
  return {
    status: 'received',
    submittedAtIso: request.receivedAt,
    name: request.consumerName,
    contactEmail: request.contactEmail,
    orderAgeDaysAtSubmission: request.orderAgeDays,
    statementContent: request.statement,
  };
}

/** `order` of `GET /v1/admin/orders/:orderId` → the detail page's order. */
export function orderFromDetail(order) {
  const recipient = order.recipient ?? null;
  const name = text(recipient?.name);
  const money = order.money ?? {};
  const totals = order.totals ?? {};
  const shipments = Array.isArray(order.shipments) ? order.shipments : [];
  const lastShipment = shipments.at(-1) ?? null;
  return {
    id: order.orderId,
    orderNumber: order.orderNumber,
    createdAt: toTimestamp(order.createdAt),
    paidAt: toTimestamp(order.paidAt),
    status: badgeStatus(order),
    moneyStatus: order.status,
    fulfilment: order.fulfilment,
    cancelledAt: order.cancelledAt ?? null,
    statusOptions: statusOptionsOf(order),
    source: 'b2c',
    deliveryMethod: order.deliveryMethod,
    currency: order.currency,
    customerInfo: {
      email: order.customerEmail ?? '',
      name,
      firstName: name ?? '',
      lastName: '',
      phone: text(recipient?.phone),
    },
    shippingInfo: shippingInfoOf(recipient),
    pickupLocation: pickupLocationOf(recipient),
    items: (order.items ?? []).map(itemOf),
    itemCount: (order.items ?? []).reduce((sum, item) => sum + (item.quantity || 0), 0),
    subtotal: kr(totals.subtotalMinor),
    shipping: kr(totals.shippingMinor),
    discountAmount: kr(totals.discountMinor),
    // CP8-DC: the campaign code by its current name, or null (F6: the card
    // names it instead of an affiliate's).
    discountCode: typeof totals.discountCode === 'string' && totals.discountCode !== '' ? totals.discountCode : null,
    vat: kr(totals.vatMinor),
    total: kr(totals.totalMinor),
    payment: {
      status: 'succeeded',
      amount: kr(money.chargedMinor),
      refundedTotalSek: kr(money.refundedMinor),
    },
    // The ONE fee, in the field the payment card reads it from; the server's
    // payout beside it (the card prints it as it is).
    connect: { isDestinationCharge: true, applicationFeeAmount: money.feeMinor ?? 0 },
    serverPayoutSek: Number.isSafeInteger(order.payout?.amountMinor) ? order.payout.amountMinor / 100 : null,
    refundableMinor: Number.isSafeInteger(money.refundableMinor) ? money.refundableMinor : 0,
    refundPending: kr(money.refundPendingMinor),
    refunds: order.refunds ?? [],
    disputeStatus: money.dispute?.status ?? null,
    shipments,
    trackingNumber: lastShipment?.trackingNumber ?? null,
    statusHistory: (order.statusHistory ?? []).map(historyEntry),
    withdrawal: withdrawalOf(order),
    withdrawalRequest: withdrawalRequestOf(order.withdrawalRequest),
  };
}

// ── refusals, in Swedish, for the page's existing error toast ────────────────

const REFUSALS = {
  order_closed: 'Ordern är avbruten eller helt återbetald och kan inte längre ändras.',
  delivery_method: 'Steget passar inte orderns leveranssätt: en upphämtning skickas inte, och en hemleverans blir inte redo att hämtas.',
  transition: 'Ordern kan inte gå till det steget från sin nuvarande status. Ladda om sidan och försök igen.',
  tracking_required: 'Ange ett spårningsnummer för att registrera ytterligare ett paket.',
  printer_ships: 'Tryckta produkter skickas av tryckeriet. Ordern kan markeras som skickad eller redo att hämtas när tryckeriet har skickat dem.',
  return_case: 'Ordern har redan skickats eller lämnats ut och kan inte avbrytas. Hantera den som en retur.',
  refund_not_allowed: 'Ordern kan inte återbetalas med det beloppet: den är redan återbetald, en återbetalning pågår eller en tvist är öppen.',
  refund_failed: 'Stripe nekade återbetalningen. Inget belopp har återbetalats.',
  conflict: 'Åtgärden krockade med en tidigare begäran. Ladda om sidan och försök igen.',
  rate_limited: 'För många försök på kort tid. Vänta en stund och försök igen.',
  network_error: 'Servern kunde inte nås. Kontrollera anslutningen och försök igen.',
};

/** A Swedish sentence for an API refusal (by its reason, else its code), or null. */
export function refusalMessage(error) {
  if (!error || typeof error !== 'object') return null;
  return REFUSALS[error.reason] ?? REFUSALS[error.code] ?? null;
}
