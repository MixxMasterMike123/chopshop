// AdminOrders' data layer — the OLDER build's implementation (Firestore orders
// already in memory).
//
// The page (AdminOrders.jsx) reaches these functions only through this module,
// so one page serves two builds: the older build (vite.config.js) uses this
// file as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/adminOrdersData.js (the API). Both
// files export the same names with the same meaning.
//
// Everything here is the page's former behaviour: the search is the page's
// former in-memory filter, moved unchanged.

/** The source tabs (Alla källor / Återförsäljare / Kunder) are shown. */
export const SHOW_SOURCE_TABS = true;

/**
 * The orders of `orders` that match the search text. Resolves (the admin
 * build asks the server).
 */
export async function searchOrders(orders, searchTerm) {
  const term = searchTerm.toLowerCase();
  return orders.filter(order =>
    (order.orderNumber && order.orderNumber.toLowerCase().includes(term)) ||
    (order.userId && order.userId.toLowerCase().includes(term)) ||
    (order.customerInfo?.email && order.customerInfo.email.toLowerCase().includes(term)) ||
    (order.customerInfo?.firstName && order.customerInfo.firstName.toLowerCase().includes(term)) ||
    (order.customerInfo?.lastName && order.customerInfo.lastName.toLowerCase().includes(term)) ||
    (order.companyName && order.companyName.toLowerCase().includes(term))
  );
}

/** The orders as the exports (labels, CSV, pick list, verification) read them: already complete here. */
export async function withExportDetails(orders) {
  return orders;
}

/** Calls `refresh` when the list may be stale. Nothing here (the page reads once). Returns the unsubscribe function. */
export function onOrdersStale(_refresh) {
  return () => {};
}
