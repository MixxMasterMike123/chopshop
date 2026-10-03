// AdminOrders' data layer — the ADMIN build's implementation (CP5 unit FD).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/admin/adminOrdersData.js (the older build's); both export the same
// names with the same meaning, so the page is the same file in both builds.
//
//   searchOrders   the route's `q`: an exact e-mail address or an order number
//                  prefix. Any other text (a name, a part of an address)
//                  matches nothing; the route cannot search it.
//   withExportDetails  the list's rows carry no lines, address or pickup
//                  date; the exports read them, so each order's detail is
//                  read first (a few at a time).
//   onOrdersStale  the list is read again when the window gets the focus
//                  back (no live listener, PLAN §2.9).
//   SHOW_SOURCE_TABS   false: every order is a web shop order (the trade
//                  channel is not ported), so the source filter leaves.

import { getOrder, listAllOrders, searchQueryOf } from '../../api/admin/orders.js';
import { orderFromDetail, orderFromListRow } from '../adapters/order.js';

export const SHOW_SOURCE_TABS = false;

/** Typing settles for this long before the server is asked. */
const SEARCH_DELAY_MS = 300;

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

export async function searchOrders(_orders, searchTerm, { signal } = {}) {
  const q = searchQueryOf(searchTerm);
  if (q === null) return [];
  await pause(SEARCH_DELAY_MS, signal);
  const { orders } = await listAllOrders({ q }, { signal });
  return orders.map(orderFromListRow);
}

/** Reads at most this many details at once. */
const DETAIL_CONCURRENCY = 4;

export async function withExportDetails(orders) {
  const result = new Array(orders.length);
  let next = 0;
  async function worker() {
    while (next < orders.length) {
      const index = next;
      next += 1;
      const detail = await getOrder(orders[index].id);
      // An order that is gone (404) keeps its row.
      result[index] = detail === null ? orders[index] : orderFromDetail(detail);
    }
  }
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, orders.length) }, worker));
  return result;
}

export function onOrdersStale(refresh) {
  if (typeof window === 'undefined') return () => {};
  const onFocus = () => refresh();
  window.addEventListener('focus', onFocus);
  return () => window.removeEventListener('focus', onFocus);
}
