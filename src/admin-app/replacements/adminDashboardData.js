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
// The "Kom igång" checklist (CP9-OB item 3): loadOnboarding reads the facts
// the admin already has (the legal status, the shop, the Connect view, the
// first page of products) and answers the steps (adapters/onboarding.js), or
// null when every step is done or a read failed (the dashboard then shows what
// it showed before: a checklist on a guess would mislead).
//
// Read for the page's `shopId` only (readForShop): with no shop chosen nothing
// is asked, and numbers that arrive after the tab moved to another shop are
// dropped, never shown under it (CP5-FX, finding 1).

import { adminRequest } from '../../api/admin/client.js';
import { getLegalPagesStatus } from '../../api/admin/legal.js';
import { listAllOrders } from '../../api/admin/orders.js';
import { getConnect } from '../../api/admin/payments.js';
import { listProducts } from '../../api/admin/products.js';
import { onboardingComplete, onboardingSteps } from '../adapters/onboarding.js';
import { notEnabledPayments, toPagePayments } from '../adapters/payments.js';
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

export function loadOnboarding(shopId) {
  return readForShop(shopId, async (id) => {
    const option = { shopId: id };
    const [status, shop, connect, products] = await Promise.all([
      getLegalPagesStatus(option),
      adminRequest('GET', '/v1/admin/shop', option).then(({ data }) => data?.shop ?? null),
      getConnect(option),
      listProducts({ ...option, limit: 100 }).then((page) => page.products),
    ]);
    if (!status || !shop) return null;
    const steps = onboardingSteps({
      status,
      shop,
      payments: connect ? toPagePayments(connect) : notEnabledPayments(),
      products,
      pod: shop.features?.pod === true,
    });
    return onboardingComplete(steps) ? null : { steps };
  });
}
