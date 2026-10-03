// AdminDashboard's data layer — the ADMIN build's implementation (CP5 unit
// FD). The alias list of vite.admin.config.js puts this module in place of
// src/pages/admin/adminDashboardData.js (the older build's, Firestore); both
// export the same names with the same meaning.
//
// From the order list (GET /v1/admin/orders), walked once:
//   totalRevenue      the route's `totalMinor` for every order of the shop:
//                     the sum of the order totals as charged, refunds NOT
//                     deducted (the older page summed the same way)
//   totalOrders       the route's `count`
//   pendingOrders     open orders nobody has handled yet (badge 'confirmed':
//                     paid, fulfilment 'unfulfilled', not cancelled or refunded)
//   processingOrders  fulfilment 'processing' (and open)
//   completedOrders   'shipped', 'delivered' or 'completed' (and open)
//   recentOrders      the five newest rows
// Not ported (null: the page leaves the tile and its link out): the customer
// count (no customer accounts, D81), the affiliate revenue and the active
// affiliates (PORT-LATER).
//
// Read for the page's `shopId` only (readForShop): with no shop chosen nothing
// is asked, and numbers that arrive after the tab moved to another shop are
// dropped, never shown under it (CP5-FX, finding 1).

import { listAllOrders } from '../../api/admin/orders.js';
import { orderFromListRow } from '../adapters/order.js';
import { minorToKronor } from '../adapters/money.js';
import { readForShop } from '../providers/ordersForShop.js';

const DONE = new Set(['shipped', 'delivered', 'completed']);

export function loadDashboardStats(shopId) {
  return readForShop(shopId, async (id) => statsOf(await listAllOrders({}, { shopId: id })));
}

function statsOf({ orders, count, totalMinor }) {
  const rows = orders.map(orderFromListRow);
  let pendingOrders = 0;
  let processingOrders = 0;
  let completedOrders = 0;
  for (const order of rows) {
    if (order.status === 'confirmed') pendingOrders += 1;
    else if (order.status === 'processing') processingOrders += 1;
    else if (DONE.has(order.status)) completedOrders += 1;
  }
  return {
    totalRevenue: Math.round(minorToKronor(totalMinor) ?? 0),
    b2cCustomers: null,
    totalOrders: count,
    pendingOrders,
    processingOrders,
    completedOrders,
    affiliateRevenue: null,
    activeAffiliates: null,
    recentOrders: rows.slice(0, 5),
  };
}
