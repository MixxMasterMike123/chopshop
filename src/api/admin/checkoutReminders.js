// The seller's switch for Övergiven kassa (CP9-AC; the Worker:
// cloudflare/src/routes/admin-checkout-reminders.ts).
//
//   GET /v1/admin/checkout-reminders
//     { checkoutReminders: { enabled, delayHours, enabledAt, updatedAt,
//                            queuedLast30Days, mailConfigured } }
//     enabledAt / updatedAt: ISO-8601 or null (never turned on / never saved)
//   PUT /v1/admin/checkout-reminders   { enabled, delayHours } → the same shape
//     400 invalid_request: any other body, a delay outside 1–24
//
// Both answer the opaque 404 while the platform's add-on is off for the shop.
// No buyer data ever: one count of queued reminders is all the seller sees.
// Every request carries X-Shop-Id (adminRequest).

import { adminRequest } from './client.js';

export const CHECKOUT_REMINDERS_PATH = '/v1/admin/checkout-reminders';

/** The switch as stored (`checkoutReminders` of the answer). */
export async function getCheckoutReminders({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', CHECKOUT_REMINDERS_PATH, { shopId, signal });
  return data?.checkoutReminders ?? null;
}

/** Writes the switch and the delay; resolves the switch as stored. */
export async function putCheckoutReminders({ enabled, delayHours }, { shopId } = {}) {
  const { data } = await adminRequest('PUT', CHECKOUT_REMINDERS_PATH, {
    json: { delayHours, enabled },
    shopId,
  });
  return data?.checkoutReminders ?? null;
}
