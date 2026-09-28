// The order after payment (PLAN §2.1 guest receipts, §2.9 realtime → polling).
//
// After Stripe confirms, the order is made by the webhook, not by the browser.
// The storefront asks for it with the checkout id it already holds:
//   POST /v1/checkout/:checkoutId/receipt
//     { receipt: { status: 'pending' } }                       not yet
//     { receipt: { status: 'ready', orderId, receiptToken } }  ONCE
//     { receipt: { status: 'issued' } }                        handed out before
// and then reads the order with the token:
//   GET /v1/orders/:orderId   Authorization: Bearer <receiptToken>
// The token is a credential: it is kept in this tab's sessionStorage only.

import { ApiError, readOne, request, segment } from './client.js';

export const RECEIPT_POLL_INTERVAL_MS = 2_000;
export const RECEIPT_POLL_TIMEOUT_MS = 90_000;

/** One claim: `{ status: 'pending' }`, `{ status: 'ready', orderId, receiptToken }` or `{ status: 'issued' }`. */
export async function claimReceipt(checkoutId, { signal } = {}) {
  const { data } = await request(`/v1/checkout/${segment(checkoutId)}/receipt`, {
    method: 'POST',
    signal,
  });
  return data.receipt;
}

/** The buyer's order (the allowlisted buyer schema), or null. */
export function getOrder(orderId, receiptToken, { signal } = {}) {
  return readOne(`/v1/orders/${segment(orderId)}`, 'order', {
    headers: { authorization: `Bearer ${receiptToken}` },
    signal,
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Polls the claim every `intervalMs` (2 s) for at most `timeoutMs` (90 s).
 * Resolves the first `ready` or `issued` receipt, or `{ status: 'timeout' }`.
 * A network error or a 429 is waited out (the next tick, or the Retry-After
 * when it is longer); any other refusal rejects (a 404 means the checkout is
 * not this shop's or no longer exists). `signal` cancels: the promise rejects
 * with its AbortError and no further request is made.
 */
export async function pollReceipt(
  checkoutId,
  {
    signal,
    intervalMs = RECEIPT_POLL_INTERVAL_MS,
    timeoutMs = RECEIPT_POLL_TIMEOUT_MS,
    now = () => Date.now(),
    wait = sleep,
  } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let delay = intervalMs;
    // A request that stalls must not outlive the deadline: it is aborted when
    // the time is up, and the poll answers its timeout.
    const remaining = deadline - now();
    if (remaining <= 0) return { status: 'timeout' };
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), remaining);
    const onAbort = () => timer.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const receipt = await claimReceipt(checkoutId, { signal: timer.signal });
      if (receipt?.status === 'ready' || receipt?.status === 'issued') return receipt;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (timer.signal.aborted) return { status: 'timeout' };
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'rate_limited') {
        delay = Math.max(intervalMs, (error.retryAfterSeconds ?? 0) * 1_000);
      } else if (error.code !== 'network_error') {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
    if (now() + delay > deadline) return { status: 'timeout' };
    await wait(delay, signal);
  }
}

// When this tab began to poll a checkout. The 90 s are the checkout's, not the
// page's: a page that is mounted again (its parent rendered it from nothing, a
// development reload) continues the same poll and does not begin a new 90 s.
// Kept in memory only: a reload by the buyer asks again.
const pollStartedAt = new Map();

/**
 * What is left of a checkout's 90 s, for `pollReceipt`'s `timeoutMs`. Never
 * less than one interval: a page mounted after the time is up still asks once.
 */
export function receiptPollTimeLeft(checkoutId, now = Date.now()) {
  if (!pollStartedAt.has(checkoutId)) pollStartedAt.set(checkoutId, now);
  const left = RECEIPT_POLL_TIMEOUT_MS - (now - pollStartedAt.get(checkoutId));
  return Math.max(RECEIPT_POLL_INTERVAL_MS, left);
}

const TOKEN_KEY = (orderId) => `receipt-token:${orderId}`;

/** Keeps a receipt token for this tab (sessionStorage), so a reload can still read the order. */
export function saveReceiptToken(orderId, receiptToken) {
  try {
    globalThis.sessionStorage?.setItem(TOKEN_KEY(orderId), receiptToken);
  } catch {
    // Storage refused (private mode, quota): the order is shown this once.
  }
}

export function loadReceiptToken(orderId) {
  try {
    return globalThis.sessionStorage?.getItem(TOKEN_KEY(orderId)) ?? null;
  } catch {
    return null;
  }
}

// Added by CP4-F2. The checkout a payment belongs to, kept for this tab only
// (sessionStorage), by the payment's id. The payment form stores it when the
// payment is created; the confirmation page is reached by the payment's id
// (after a card payment, and back from a payment method's own page, which
// returns to this tab) and polls that checkout for its order. The checkout id
// is a capability for the receipt: it never goes into an address.
const PENDING_CHECKOUT_KEY = (paymentIntentId) => `pending-checkout:${paymentIntentId}`;

export function savePendingCheckout(paymentIntentId, checkoutId) {
  try {
    globalThis.sessionStorage?.setItem(PENDING_CHECKOUT_KEY(paymentIntentId), checkoutId);
  } catch {
    // Storage refused: the confirmation page then shows its "not found" state
    // and the order confirmation arrives by mail.
  }
}

export function loadPendingCheckout(paymentIntentId) {
  try {
    return globalThis.sessionStorage?.getItem(PENDING_CHECKOUT_KEY(paymentIntentId)) ?? null;
  } catch {
    return null;
  }
}
