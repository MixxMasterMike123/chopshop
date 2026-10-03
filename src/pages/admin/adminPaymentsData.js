// AdminPayments' data layer — the OLDER build's implementation (Firebase).
//
// The page (AdminPayments.jsx) reaches its data only through this module, so
// one page serves two builds: the older build (vite.config.js) uses this file
// as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/adminPaymentsData.js (the API). Both
// files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { doc, onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../../firebase/config';

/** The balance panel has a read here (getConnectBalance). */
export const BALANCE_READ = true;

/**
 * Live subscription to the shop's payments map (shops/{id}.payments).
 * Returns the unsubscribe function.
 */
export function subscribeConnect(shopId, onData, onError) {
  return onSnapshot(
    doc(db, 'shops', shopId),
    (snap) => onData((snap.data() || {}).payments || {}),
    onError,
  );
}

/** One of the connectOnboarding callables, for the shop. Resolves its data. */
export async function callConnect(shopId, name) {
  const fn = httpsCallable(functions, name);
  const res = await fn({ shopId });
  return res.data;
}

/** The status refresh after a return from Stripe's onboarding (?return / ?refresh). */
export function refreshOnReturn(shopId) {
  return callConnect(shopId, 'refreshConnectStatus');
}

/** Whether the shop may start and continue onboarding. A platform user always could here. */
export function connectEnabledFor(pay, isPlatform) {
  return pay?.connectEnabled === true || isPlatform;
}

/** Why the Stripe dashboard link is refused to this user, or '' (never refused here). */
export function useLoginLinkRefusal() {
  return '';
}

/** The connected account's balance + payout delay (getConnectBalance). */
export async function getConnectBalance(shopId) {
  const res = await httpsCallable(functions, 'getConnectBalance')({ shopId });
  return res.data;
}

/** The current payout delay alone (from the balance read). */
export async function getPayoutDelay(shopId) {
  const bal = await getConnectBalance(shopId);
  return bal?.payoutDelayDays;
}

/** Platform only: a number of days 0..365, or 'minimum'. */
export async function setPayoutDelay(shopId, delayDays) {
  await httpsCallable(functions, 'setConnectPayoutDelay')({ shopId, delayDays });
}
