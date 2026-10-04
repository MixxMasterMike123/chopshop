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

// ── the connected account's balance (unit CP5-FP) ───────────────────────────
// GET /v1/admin/payments/connect/balance → { balance: { available, pending,
// payoutSchedule, retrievedAt } }: what Stripe holds for the shop, per
// currency, read now. The seller's own money (no fee, no platform figure);
// shown as the server gave it, nothing computed.

const CURRENCY = /^[a-z]{3}$/;

/**
 * Minor units of a currency → the page's money text: SEK exactly as the
 * page's own formatter writes öre ("12 840,50 kr"), any other currency in its
 * own minor unit ("42,00 €"); '' when not an amount.
 */
export function moneyText(amountMinor, currency) {
  if (!Number.isSafeInteger(amountMinor) || typeof currency !== 'string' || !CURRENCY.test(currency.toLowerCase())) return '';
  if (currency.toLowerCase() === 'sek') {
    return `${(amountMinor / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;
  }
  let format;
  try {
    format = new Intl.NumberFormat('sv-SE', { style: 'currency', currency: currency.toUpperCase() });
  } catch {
    return '';
  }
  const digits = format.resolvedOptions().maximumFractionDigits;
  return format.format(amountMinor / 10 ** digits);
}

const WEEKDAYS = {
  monday: 'måndagar', tuesday: 'tisdagar', wednesday: 'onsdagar', thursday: 'torsdagar',
  friday: 'fredagar', saturday: 'lördagar', sunday: 'söndagar',
};

/** The payout schedule (`payoutSchedule`) in one plain sentence or two. */
export function payoutScheduleText(schedule) {
  if (!schedule || typeof schedule !== 'object' || typeof schedule.interval !== 'string') {
    return 'Stripe angav inget utbetalningsschema.';
  }
  const { interval, delayDays, weeklyAnchor, monthlyAnchor } = schedule;
  let when;
  if (interval === 'manual') when = 'Utbetalningarna är manuella: Stripe betalar inte ut automatiskt.';
  else if (interval === 'daily') when = 'Stripe betalar ut till ditt bankkonto varje dag.';
  else if (interval === 'weekly') {
    when = WEEKDAYS[weeklyAnchor]
      ? `Stripe betalar ut till ditt bankkonto varje vecka, på ${WEEKDAYS[weeklyAnchor]}.`
      : 'Stripe betalar ut till ditt bankkonto en gång i veckan.';
  } else if (interval === 'monthly') {
    when = Number.isInteger(monthlyAnchor)
      ? `Stripe betalar ut till ditt bankkonto den ${monthlyAnchor} varje månad.`
      : 'Stripe betalar ut till ditt bankkonto en gång i månaden.';
  } else when = `Stripe betalar ut enligt schemat "${interval}".`;
  if (interval === 'manual' || !Number.isInteger(delayDays)) return when;
  return `${when} Pengar från en betalning hålls i ${delayDays} ${delayDays === 1 ? 'dag' : 'dagar'} innan de kan betalas ut.`;
}

/** "4 okt. 2026 14:03": when the balance was read at Stripe. */
function readAtText(iso) {
  const at = typeof iso === 'string' ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  return at.toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The panel's view of a balance: `available` and `pending` as money texts per
 * currency (in the order of the currencies, SEK first), `negative` when any
 * available amount is below zero (the existing warning), the schedule's
 * sentence and the read's time. null when the answer is not a balance.
 */
export function balanceView(balance) {
  if (!balance || typeof balance !== 'object' || !Array.isArray(balance.available) || !Array.isArray(balance.pending)) return null;
  const amounts = (list) => list.filter((a) => a && Number.isSafeInteger(a.amountMinor) && typeof a.currency === 'string');
  const available = amounts(balance.available);
  const pending = amounts(balance.pending);
  const currencies = [...new Set([...available, ...pending].map((a) => a.currency.toLowerCase()))]
    .sort((a, b) => (a === 'sek' ? -1 : b === 'sek' ? 1 : a.localeCompare(b)));
  const sum = (list, currency) => list.filter((a) => a.currency.toLowerCase() === currency).reduce((n, a) => n + a.amountMinor, 0);
  const rows = currencies.map((currency) => {
    const availableMinor = sum(available, currency);
    return {
      currency,
      available: moneyText(availableMinor, currency),
      pending: moneyText(sum(pending, currency), currency),
      negative: availableMinor < 0,
    };
  });
  return {
    rows,
    negative: rows.some((row) => row.negative),
    schedule: payoutScheduleText(balance.payoutSchedule),
    readAt: readAtText(balance.retrievedAt),
  };
}

/**
 * What a failed balance read means for the panel:
 *   'none'         no panel (409 connect_account_missing; the opaque 404:
 *                  Connect is not enabled for the shop)
 *   'limited'      429: the Stripe limiter the page's buttons share is spent
 *   'unavailable'  502: Stripe refused or could not be reached
 *   'error'        anything else
 * with the sentence to show (never a block on the page's other controls).
 */
export function balanceFailure(error) {
  if (error?.status === 404 || error?.code === 'connect_account_missing') return { state: 'none', message: '' };
  if (error?.status === 429 || error?.code === 'rate_limited') {
    const seconds = error?.retryAfterSeconds;
    const when = Number.isFinite(seconds) && seconds > 0
      ? ` Försök igen om ${seconds < 90 ? `${Math.ceil(seconds)} sekunder` : `${Math.ceil(seconds / 60)} minuter`}.`
      : ' Försök igen om en stund.';
    return { state: 'limited', message: `Saldot kan inte uppdateras just nu: för många anrop till Stripe på kort tid.${when}` };
  }
  if (error?.status === 502 || error?.code === 'connect_unavailable') {
    return { state: 'unavailable', message: 'Saldot kunde inte hämtas från Stripe just nu. Försök igen om en stund.' };
  }
  if (error?.code === 'network_error') return { state: 'error', message: 'Saldot kunde inte hämtas: servern kunde inte nås.' };
  if (error?.code === 'unauthenticated') return { state: 'error', message: error.message };
  return { state: 'error', message: `Saldot kunde inte hämtas: servern svarade med ett fel (HTTP ${error?.status ?? '?'}).` };
}
