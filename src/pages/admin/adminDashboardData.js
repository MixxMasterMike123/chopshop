// AdminDashboard's data layer — the OLDER build's implementation (Firestore).
//
// The page (AdminDashboard.jsx) reaches its data only through this module, so
// one page serves two builds: the older build (vite.config.js) uses this file
// as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/adminDashboardData.js (the API). Both
// files export the same names with the same meaning. A stat that a build does
// not have is null, and the page leaves its tile and link out.
//
// Everything here is the page's former inline code, moved and unchanged.

import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../../firebase/config';

/** The dashboard's numbers for the shop, and its five most recent orders. */
export async function loadDashboardStats(shopId) {
  // (B2B users stat removed 2026-06-15 — the trade-customer function retired; no
  // longer read the global `users` collection here.)

  // Fetch B2C customers stats (scoped to the active shop)
  const b2cCustomersRef = collection(db, 'b2cCustomers');
  const b2cCustomersSnap = await getDocs(
    query(b2cCustomersRef, where('shopId', '==', shopId))
  );

  // Fetch orders stats with detailed breakdown (scoped to the active shop).
  // The recent-orders query (shopId + orderBy createdAt desc) is backed by
  // the existing [shopId ASC, createdAt DESC] composite index (Phase 2).
  const ordersRef = collection(db, 'orders');
  const ordersSnap = await getDocs(
    query(ordersRef, where('shopId', '==', shopId))
  );
  const recentOrdersSnap = await getDocs(
    query(ordersRef, where('shopId', '==', shopId), orderBy('createdAt', 'desc'), limit(5))
  );

  // Calculate order statistics and revenue
  let totalRevenue = 0;
  let pendingOrders = 0;
  let processingOrders = 0;
  let completedOrders = 0;
  let affiliateRevenue = 0;

  ordersSnap.forEach(doc => {
    const order = doc.data();

    // Calculate revenue (handle both B2B and B2C order formats)
    const orderValue = order.total || order.totalAmount || order.prisInfo?.totalPris || 0;
    totalRevenue += orderValue;

    // Count orders by status
    if (order.status === 'pending') {
      pendingOrders++;
    } else if (order.status === 'processing') {
      processingOrders++;
    } else if (order.status === 'delivered' || order.status === 'shipped') {
      completedOrders++;
    }

    // Calculate affiliate revenue
    if (order.affiliateCommission) {
      affiliateRevenue += order.affiliateCommission;
    }
  });

  // Fetch affiliate stats (scoped to the active shop). Scope by shopId only
  // (single-field, index-free) and count active ones client-side — avoids a
  // [shopId, status] composite index that doesn't exist, consistent with the
  // client-side order tallying above.
  const affiliatesRef = collection(db, 'affiliates');
  const affiliatesSnap = await getDocs(
    query(affiliatesRef, where('shopId', '==', shopId))
  );
  const activeAffiliatesCount = affiliatesSnap.docs.filter(
    (d) => d.data().status === 'active'
  ).length;

  return {
    totalRevenue: Math.round(totalRevenue),
    b2cCustomers: b2cCustomersSnap.size,
    totalOrders: ordersSnap.size,
    pendingOrders,
    processingOrders,
    completedOrders,
    affiliateRevenue: Math.round(affiliateRevenue),
    activeAffiliates: activeAffiliatesCount,
    recentOrders: recentOrdersSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }))
  };
}
