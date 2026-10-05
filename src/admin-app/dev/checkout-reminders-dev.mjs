// The dev API's rows for the seller's switch of Övergiven kassa (CP9-AC),
// wired into dev-api.mjs. INVENTED data only, in the Worker's shapes and with
// its refusals (cloudflare/src/routes/admin-checkout-reminders.ts):
//   GET /v1/admin/checkout-reminders   { checkoutReminders: { enabled, delayHours,
//                                        enabledAt, updatedAt, queuedLast30Days,
//                                        mailConfigured } }
//   PUT /v1/admin/checkout-reminders   { enabled, delayHours } → the same · 400
// Both are the opaque 404 while the shop's `abandonedCheckout` feature is off
// (fixtures.json). `mailConfigured` false with the cookie admin_dev_mail=off
// (CP9-OB's switch). The switch starts off; changes are held in memory per
// server and shop. The count is invented (3 for a shop with the feature on).

import { devMailConfigured } from './fp-dev.mjs';

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const invalid = () => json(400, { error: { code: 'invalid_request', message: 'Request is not valid' } });

const switchedOn = (shop) => shop.shop.features?.abandonedCheckout === true;

function heldFor(state, shopId) {
  state.acSwitch ??= new Map();
  if (!state.acSwitch.has(shopId)) {
    state.acSwitch.set(shopId, { delayHours: 1, enabled: false, enabledAt: null, updatedAt: null });
  }
  return state.acSwitch.get(shopId);
}

const view = (held, headers) => ({
  checkoutReminders: { ...held, mailConfigured: devMailConfigured(headers), queuedLast30Days: 3 },
});

function read(state, { shop, headers }) {
  if (!switchedOn(shop)) return notFound();
  return json(200, view(heldFor(state, shop.shop.tenantId), headers));
}

function write(state, { shop, headers, body }) {
  if (!switchedOn(shop)) return notFound();
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
  if (
    keys.join(',') !== 'delayHours,enabled' ||
    typeof body.enabled !== 'boolean' ||
    !Number.isSafeInteger(body.delayHours) ||
    body.delayHours < 1 ||
    body.delayHours > 24
  ) {
    return invalid();
  }
  const held = heldFor(state, shop.shop.tenantId);
  const now = new Date().toISOString();
  const enabledAt = body.enabled && !held.enabled ? now : held.enabledAt;
  state.acSwitch.set(shop.shop.tenantId, { delayHours: body.delayHours, enabled: body.enabled, enabledAt, updatedAt: now });
  return json(200, view(state.acSwitch.get(shop.shop.tenantId), headers));
}

export const CHECKOUT_REMINDER_ROUTES = [
  ['GET', '/v1/admin/checkout-reminders', read],
  ['PUT', '/v1/admin/checkout-reminders', write],
];
