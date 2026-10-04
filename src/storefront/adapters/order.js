// The buyer's order as the confirmation page reads it (CP4 brief F2). Pure.
//
// The API's shape (cloudflare/src/commerce/receipts.ts, GET /v1/orders/:id
// with the receipt's token) is an ALLOWLIST: order id and number, status,
// time, the buyer's address masked (`b***@example.com`), the delivery method
// and country, the lines (name, quantity, unit price, line total), the totals
// in minor units, whether the right of withdrawal was waived, and the
// `recipient` (D98, cloudflare/src/commerce/recipient.ts RecipientView): the
// name and the postal address of a parcel, or the name and the pickup place
// (its name and address as they were at checkout) and date of a collected
// order; null for an order made before it existed. The totals name the
// campaign code (`totals.discountCode`, CP8-DC) or null. It carries no image, no
// variant label and no marketing choice: the page renders those parts as it
// renders them today for an order without them.

import { minorToKronor } from './checkout.js';

/**
 * The page's order from the API's buyer order, or null.
 *
 * `payment.status` is 'paid' for every order: an order exists only once its
 * payment succeeded (the payment provider's confirmation creates it on the
 * server). The page never decides this itself.
 */
export function toPageOrder(order) {
  if (!order || typeof order !== 'object') return null;

  const createdMs = Date.parse(order.createdAt);
  const totals = order.totals && typeof order.totals === 'object' ? order.totals : {};
  const pickup = order.delivery?.method === 'pickup';

  const recipient = order.recipient && typeof order.recipient === 'object' ? order.recipient : null;

  return {
    id: order.orderId,
    orderNumber: order.orderNumber,
    status: order.status,
    createdAt: Number.isFinite(createdMs) ? { seconds: Math.floor(createdMs / 1000) } : null,
    payment: { status: 'paid' },
    customerInfo: { email: order.email },
    deliveryMethod: pickup ? 'pickup' : 'home',
    ...deliveryFields(pickup, order.delivery?.country ?? '', recipient),
    items: (Array.isArray(order.items) ? order.items : []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      price: minorToKronor(item.unitPriceMinor) ?? 0,
    })),
    subtotal: minorToKronor(totals.subtotalMinor),
    shipping: minorToKronor(totals.shippingMinor),
    discountAmount: minorToKronor(totals.discountMinor) ?? 0,
    // CP8-DC: the campaign code by its current name, or null (F6: the page
    // names it instead of an affiliate's).
    discountCode: typeof totals.discountCode === 'string' && totals.discountCode !== '' ? totals.discountCode : null,
    vat: minorToKronor(totals.vatMinor),
    total: minorToKronor(totals.totalMinor),
    withdrawal: { waived: order.withdrawal?.waived === true },
  };
}

/**
 * The parts of the page's order that say who gets it and where, in the shape
 * OrderConfirmation.jsx reads: the name is printed as `{firstName} {lastName}`
 * (the API has one name, so it is the first name and the last is empty); a
 * parcel's lines from `shippingInfo`; a pickup's place from `pickupLocation`
 * ({ name, address, date }). No recipient → only the country, as before.
 */
function deliveryFields(pickup, country, recipient) {
  if (recipient === null) {
    return { shippingInfo: pickup ? {} : { country } };
  }
  const name = { firstName: recipient.name ?? '', lastName: '' };
  if (pickup) {
    return {
      shippingInfo: name,
      pickupLocation: {
        id: recipient.pickupLocationId ?? '',
        name: recipient.pickupLocationName ?? '',
        address: recipient.pickupLocationAddress ?? '',
        date: recipient.pickupDate ?? '',
      },
    };
  }
  return {
    shippingInfo: {
      ...name,
      address: recipient.addressLine1 ?? '',
      apartment: recipient.addressLine2 ?? '',
      postalCode: recipient.postalCode ?? '',
      city: recipient.city ?? '',
      country: recipient.country ?? country,
    },
  };
}

/**
 * What the confirmation page at `/order-confirmation/<ref>` reads:
 *   { kind: 'order', orderId, token }    this tab holds the order's receipt
 *                                        token: read the order
 *   { kind: 'checkout', checkoutId }     `ref` is the payment of a checkout
 *                                        this tab started: wait for its order
 *   { kind: 'none' }                     nothing this tab can read
 * The loaders are the client's session-storage reads (src/api/orders.js),
 * passed in so this stays pure.
 */
export function confirmationSource(ref, { loadReceiptToken, loadPendingCheckout }) {
  if (typeof ref !== 'string' || ref === '') return { kind: 'none' };
  const token = loadReceiptToken(ref);
  if (token) return { kind: 'order', orderId: ref, token };
  const checkoutId = loadPendingCheckout(ref);
  if (checkoutId) return { kind: 'checkout', checkoutId };
  return { kind: 'none' };
}
