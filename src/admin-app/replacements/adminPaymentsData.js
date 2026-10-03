// AdminPayments' data layer — the ADMIN build's implementation (CP5 brief FF).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/admin/adminPaymentsData.js (the older build's, Firebase); both
// export the same names with the same meaning, so the page is the same file in
// both builds.
//
// The realtime listener becomes reads (PLAN §2.9, gap analysis §4):
//   - on mount;
//   - on window focus (the seller comes back from Stripe's tab);
//   - on arrival with ?return=1 or ?refresh=1: POST /refresh first, then read;
//   - after every action that answers a view (create, refresh), that view.
// No polling loop. A read never overwrites a newer answer: a read counts from
// when it was SENT, an action's answer from when it ARRIVED, and only a
// higher count is shown.
//
// Seller-facing money surface: the page gets the five facts of
// toPagePayments() and the links the server gives. No fee, no commission, no
// platform figure; nothing is computed.

import { useAuth } from '../providers/Session.jsx';
import { AdminApiError } from '../../api/admin/client.js';
import {
  createConnectAccount,
  createLoginLink,
  createOnboardingLink,
  getConnect,
  getPlatformConnect,
  refreshConnect,
  setPlatformPayoutDelay,
} from '../../api/admin/payments.js';
import {
  connectErrorMessage,
  loginLinkRefusal,
  notEnabledPayments,
  payoutDelayOf,
  toPagePayments,
} from '../adapters/payments.js';

/** No balance route exists (CP3_F_REPORT "No balance read"): the balance block leaves. */
export const BALANCE_READ = false;

/** How often a pending account creation (202) is asked again before giving up. */
const PENDING_ROUNDS = 3;
const PENDING_WAIT_CAP_SECONDS = 10;

// ── the shop's latest view, pushed to the page ──────────────────────────────

const listeners = new Map(); // shopId → Set<onData>
const shown = new Map(); // shopId → count of the answer last shown
let count = 0;

function deliver(shopId, ticket, payments) {
  if ((shown.get(shopId) ?? 0) >= ticket) return false;
  shown.set(shopId, ticket);
  for (const onData of listeners.get(shopId) ?? []) {
    try {
      onData(payments);
    } catch {
      /* a listener's failure is its own */
    }
  }
  return true;
}

/** An action's answer: newer than every read sent before it arrived. */
function deliverAnswer(shopId, view) {
  const payments = toPagePayments(view);
  deliver(shopId, ++count, payments);
  return payments;
}

/** An API error → an Error in the page's language (the page shows `.message`). Others pass. */
function asPageError(error) {
  if (!(error instanceof AdminApiError)) return error;
  const wrapped = new Error(connectErrorMessage(error));
  wrapped.code = error.code;
  return wrapped;
}

async function readInto(shopId) {
  const ticket = ++count;
  const view = await getConnect({ shopId });
  deliver(shopId, ticket, view ? toPagePayments(view) : notEnabledPayments());
}

// One refresh in flight per shop: a second click, or the return effect while
// the arrival's refresh runs, shares it.
const refreshing = new Map();

function refresh(shopId) {
  if (!refreshing.has(shopId)) {
    const running = refreshConnect({ shopId })
      .then((view) => deliverAnswer(shopId, view))
      .finally(() => refreshing.delete(shopId));
    refreshing.set(shopId, running);
  }
  return refreshing.get(shopId);
}

// The refresh of the arrival from Stripe (?return=1 / ?refresh=1), once per
// shop per page load. The page's own return effect reuses it.
const arrivals = new Map();

function arrivalRefresh(shopId) {
  if (arrivals.has(shopId)) return arrivals.get(shopId);
  let q;
  try {
    q = new URLSearchParams(globalThis.location?.search ?? '');
  } catch {
    return null;
  }
  const back = q.get('return') === '1' || q.get('refresh') === '1';
  const named = q.get('shopId');
  // Only for the shop the return address names (the active shop resolves to
  // it when the user may use it; another shop is not refreshed for it).
  if (!back || (named && named !== shopId)) return null;
  const running = refresh(shopId);
  arrivals.set(shopId, running);
  return running;
}

/**
 * The page's subscription: the first read (after the arrival's refresh, when
 * the address says the user is back from Stripe), then a read on every window
 * focus. `onError` hears only a failure of the first read: a later read that
 * fails leaves the last view on the page. Returns the unsubscribe function.
 */
export function subscribeConnect(shopId, onData, onError) {
  let live = true;
  let delivered = false;
  const own = (payments) => {
    delivered = true;
    if (live) onData(payments);
  };
  if (!listeners.has(shopId)) listeners.set(shopId, new Set());
  listeners.get(shopId).add(own);

  const read = () =>
    readInto(shopId).catch((error) => {
      if (live && !delivered) onError(asPageError(error));
    });

  const arrival = arrivalRefresh(shopId);
  if (arrival) arrival.catch(() => {}).finally(read);
  else read();

  const onFocus = () => {
    if (live) read();
  };
  globalThis.addEventListener?.('focus', onFocus);

  return () => {
    live = false;
    globalThis.removeEventListener?.('focus', onFocus);
    listeners.get(shopId)?.delete(own);
  };
}

const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function createAccount(shopId) {
  for (let round = 1; ; round += 1) {
    const answer = await createConnectAccount({ shopId });
    if (answer.connect) deliverAnswer(shopId, answer.connect);
    if (!answer.pending) return;
    if (round >= PENDING_ROUNDS) {
      throw new Error('Stripe skapar fortfarande kontot. Försök igen om en stund.');
    }
    await wait(Math.min(answer.retryAfterSeconds ?? 5, PENDING_WAIT_CAP_SECONDS));
  }
}

/**
 * The page's actions, by the old callable's name. Resolves what the page
 * reads: `{ url }` to send the browser to Stripe, or the view (chargesEnabled).
 * Rejects with an Error whose message is the page's language.
 */
export async function callConnect(shopId, name) {
  try {
    switch (name) {
      case 'createConnectAccount': {
        // The callable made the account AND the link; here they are two routes.
        await createAccount(shopId);
        return await createOnboardingLink({ shopId });
      }
      case 'createConnectAccountLink':
        return await createOnboardingLink({ shopId });
      case 'refreshConnectStatus':
        return await refresh(shopId);
      case 'createConnectLoginLink':
        return await createLoginLink({ shopId });
      default:
        throw new Error('Okänd åtgärd.');
    }
  } catch (error) {
    throw asPageError(error);
  }
}

/** The status refresh after a return from Stripe: the arrival's, when it ran. */
export function refreshOnReturn(shopId) {
  return (arrivals.get(shopId) ?? refresh(shopId)).catch((error) => {
    throw asPageError(error);
  });
}

/** The server decides: a platform user acting as the shop has no bypass of the opt-in (CP3_F deviation 2). */
export function connectEnabledFor(pay) {
  return pay?.connectEnabled === true;
}

/** Why the Stripe dashboard link is refused to this user, or ''. */
export function useLoginLinkRefusal() {
  const { isPlatform } = useAuth();
  return loginLinkRefusal({ isPlatform });
}

/** No balance route: never called in this build (BALANCE_READ is false). */
export async function getConnectBalance() {
  throw new Error('Saldot finns inte i den här versionen av admin.');
}

/** Platform only: the current payout delay (days or 'minimum'), from the platform's view. */
export async function getPayoutDelay(shopId) {
  try {
    return payoutDelayOf(await getPlatformConnect(shopId));
  } catch (error) {
    throw asPageError(error);
  }
}

/** Platform only: days 0..365 or 'minimum'. Sent without X-Shop-Id (platformRequest). */
export async function setPayoutDelay(shopId, delayDays) {
  try {
    return payoutDelayOf(await setPlatformPayoutDelay(shopId, delayDays));
  } catch (error) {
    throw asPageError(error);
  }
}
