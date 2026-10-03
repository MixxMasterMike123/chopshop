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
 * plain refund.
 */
export async function refundWholeOrder(orderId, _order) {
  await httpsCallable(functions, 'refundOrder')({ orderId });
}
