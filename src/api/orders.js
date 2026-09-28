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
    try {
      const receipt = await claimReceipt(checkoutId, { signal });
      if (receipt?.status === 'ready' || receipt?.status === 'issued') return receipt;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'rate_limited') {
        delay = Math.max(intervalMs, (error.retryAfterSeconds ?? 0) * 1_000);
      } else if (error.code !== 'network_error') {
        throw error;
      }
    }
    if (now() + delay > deadline) return { status: 'timeout' };
    await wait(delay, signal);
  }
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
