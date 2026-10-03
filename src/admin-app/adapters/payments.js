// AdminPayments' shapes (CP5 brief FF). Pure: tested under Node
// (payments.test.mjs).
//
// The page reads the old `shops/{id}.payments` map: connectEnabled,
// connectStatus, stripeAccountId (only as "is there one"), chargesEnabled,
// requirementsDue. The API's SellerConnectView (CP3_F_REPORT "Routes") carries
// the same facts under other names, and nothing else: no account id, no fee,
// no commission, no payout delay. The adapter passes on exactly the five facts
// the page reads, so nothing the server might add later reaches the page.

const STATUSES = new Set(['none', 'onboarding', 'pending', 'restricted', 'active']);

/** The page's `payments` map from the seller's view. */
export function toPagePayments(view) {
  if (!view || typeof view !== 'object') return notEnabledPayments();
  const hasAccount = view.hasAccount === true;
  return {
    connectEnabled: view.enabled === true,
    connectStatus: STATUSES.has(view.status) ? view.status : 'none',
    // The page asks only whether there is an account; it never gets the id.
    stripeAccountId: hasAccount,
    chargesEnabled: view.chargesEnabled === true,
    requirementsDue: Array.isArray(view.requirementsDue)
      ? view.requirementsDue.filter((code) => typeof code === 'string')
      : [],
  };
}

/** What the page shows when the status route answers 404: payments not enabled, no account. */
export function notEnabledPayments() {
  return { connectEnabled: false, connectStatus: 'none', stripeAccountId: false, chargesEnabled: false, requirementsDue: [] };
}

/**
 * The payout delay the platform's editor shows: days, or 'minimum' (the API's
 * null = Stripe's default = the country's minimum).
 */
export function payoutDelayOf(platformView) {
  const days = platformView?.payoutDelayDays;
  return Number.isInteger(days) ? days : 'minimum';
}

/** Why the dashboard link is refused (the Worker answers 404 to an acting-as platform user). */
export const LOGIN_LINK_ACTING_AS_REASON =
  'Stripe-panelen kan bara öppnas av butikens egen admin, inte i plattformsläge.';

/**
 * '' when this user may ask for the dashboard link, else the reason. A
 * platform user reaches a shop's admin routes only through an acting-as grant
 * (request-authorization.ts), so a platform user here is always acting as.
 */
export function loginLinkRefusal({ isPlatform }) {
  return isPlatform === true ? LOGIN_LINK_ACTING_AS_REASON : '';
}

// The API's codes → the page's language. The API's own messages are English.
const MESSAGES = {
  connect_unavailable: 'Stripe kunde inte nås just nu. Försök igen om en stund.',
  connect_account_missing: 'Det finns inget Stripe-konto ännu. Börja med att aktivera utbetalningar.',
  connect_onboarding_incomplete: 'Stripe-kontot är inte aktivt ännu.',
  connect_account_refused: 'Stripe kunde inte skapa kontot. Försök igen, eller kontakta oss.',
  connect_account_conflict: 'Kontot kunde inte kopplas till butiken. Vi har fått en signal och hör av oss.',
  connect_payout_delay_refused: 'Stripe godtog inte fördröjningen.',
  invalid_request: 'Ange 0–365 dagar.',
  rate_limited: 'För många försök. Vänta en minut och försök igen.',
  not_found: 'Utbetalningar är inte aktiverade för din butik.',
};

/** A Swedish message for an error of the payments routes. */
export function connectErrorMessage(error) {
  const code = error && typeof error === 'object' ? error.code : null;
  if (typeof code === 'string' && MESSAGES[code]) return MESSAGES[code];
  return (error && error.message) || 'Något gick fel.';
}
