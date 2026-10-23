// AdminOrderDetail's data layer — the OLDER build's implementation (Firebase).
//
// The page (AdminOrderDetail.jsx) reaches these calls only through this
// module, so one page serves two builds: the older build (vite.config.js) uses
// this file as it is; the admin build (vite.admin.config.js) swaps it, by its
// alias list, for src/admin-app/replacements/adminOrderDetailData.js (the
// API). Both files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../../firebase/config';

/** The `users/{userId}` document of the order's buyer, or null. */
export async function fetchOrderUser(userId) {
  const userDocRef = doc(db, 'users', userId);
  const userDocSnap = await getDoc(userDocRef);
  if (userDocSnap.exists()) {
    console.log('User found in database');
    return userDocSnap.data();
  }
  console.log('User not found in database');
  return null;
}

/**
 * Refunds the whole order. Server is Connect-aware: a destination-charge order
 * is refunded with transfer reversal + fee refund; a legacy order takes a
 * plain refund. Resolves the outcome the page announces: the callable answers
 * only when the refund is done, so it is never pending here (the admin
 * build's module can answer `{ pending: true, message }`).
 */
export async function refundWholeOrder(orderId, _order) {
  await httpsCallable(functions, 'refundOrder')({ orderId });
  return { pending: false };
}

/**
 * CP13 A2: the order's affiliate in the page's one shape (the admin build's
 * module gives the API's), or null. Firestore keeps the code, the discount
 * percent and the commission in kronor; it has no ledger state and no
 * self-referral verdict.
 */
export function orderAffiliateOf(order) {
  const code = order?.affiliateCode || order?.affiliate?.code;
  if (!code) return null;
  const commission = Number(order.affiliateCommission);
  return {
    code,
    attribution: null,
    affiliateCommissionMinor: Number.isFinite(commission) && order.affiliateCommission != null ? Math.round(commission * 100) : null,
    ledgerState: null,
    selfReferral: false,
    discountPercent:
      order.discountPercentage || order.affiliate?.discountPercentage || order.affiliateDiscount?.percentage || null,
    detailPath: order.affiliateId ? `/admin/affiliates/manage/${order.affiliateId}` : null,
  };
}
