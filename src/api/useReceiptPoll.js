// The receipt poll as a React hook (PLAN §2.9): every 2 s, at most 90 s,
// cancelled on unmount, with an explicit timeout state and an error state.

import { useEffect, useState } from 'react';
import { pollReceipt, receiptPollTimeLeft, saveReceiptToken } from './orders.js';

/**
 * `useReceiptPoll(checkoutId)` → one of
 *   { status: 'idle' }                                   no checkout id
 *   { status: 'polling' }
 *   { status: 'ready', orderId, receiptToken }           the token is also saved for this tab
 *   { status: 'issued' }                                 the receipt was handed out before
 *   { status: 'timeout' }                                no order within 90 s
 *   { status: 'error', error }                           the API refused (ApiError)
 */
export function useReceiptPoll(checkoutId) {
  const [state, setState] = useState(() => ({ status: checkoutId ? 'polling' : 'idle' }));

  useEffect(() => {
    if (!checkoutId) {
      setState({ status: 'idle' });
      return undefined;
    }

    const controller = new AbortController();
    setState({ status: 'polling' });
    // The time left of THIS checkout: mounting the page again does not begin a new 90 s.
    const timeoutMs = receiptPollTimeLeft(checkoutId);
    pollReceipt(checkoutId, { signal: controller.signal, timeoutMs }).then(
      (receipt) => {
        if (controller.signal.aborted) return;
        if (receipt.status === 'ready') saveReceiptToken(receipt.orderId, receipt.receiptToken);
        setState(receipt);
      },
      (error) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', error });
      },
    );
    return () => controller.abort();
  }, [checkoutId]);

  return state;
}
