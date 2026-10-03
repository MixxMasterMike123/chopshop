// THE SWAP TABLE — one line per admin and platform page (CP5 brief FA.4).
//
// Every admin and platform page imports Firebase today, so each such line is a
// stand-in that shows the page's name. A unit swaps a page in by changing its
// ONE line, once the page reads from src/api/admin and the providers of
// src/admin-app:
//
//   export const AdminProducts = pending('AdminProducts');
// becomes
//   export { default as AdminProducts } from '../pages/admin/AdminProducts.jsx';
//
// then runs `node cloudflare/admin/check-admin-build.mjs` (no Firebase code
// in the build). The routers (AdminApp.jsx, PlatformApp.jsx) never change for
// a swap. A page that left the build (CP5_GAP_ANALYSIS.md §1b) has no line.

import { pending, pendingPlatform } from './Pending.jsx';

// ── sign-in (no Firebase code once the alias list applies) ──
export { default as LoginPage } from '../pages/LoginPage.jsx';
export { default as ForgotPasswordPage } from '../pages/ForgotPasswordPage.jsx';
export { default as ResetPasswordPage } from './ResetPasswordPage.jsx';

// ── the shop admin (AppLayout shell; FB …) ──
export { default as AdminDashboard } from '../pages/admin/AdminDashboard.jsx';
export { default as AdminProducts } from '../pages/admin/AdminProducts.jsx';
export { default as AdminOrders } from '../pages/admin/AdminOrders.jsx';
export { default as AdminOrderDetail } from '../pages/admin/AdminOrderDetail.jsx';
export const AdminCollections = pending('AdminCollections');
export const AdminCollectionEdit = pending('AdminCollectionEdit');
export const AdminMenu = pending('AdminMenu');
export const AdminPages = pending('AdminPages');
export const AdminPageEdit = pending('AdminPageEdit');
export const AdminStorefront = pending('AdminStorefront');
export { default as AdminSettings } from '../pages/admin/AdminSettings.jsx';
export const AdminPayments = pending('AdminPayments');
export const AdminUsers = pending('AdminUsers');
export { default as AdminPlatformTerms } from '../pages/admin/AdminPlatformTerms.jsx';
export const PodAdminPage = pending('PodAdminPage');

// ── the platform console (PlatformLayout shell, always dark) ──
export { default as PlatformShops } from './PendingPlatformShops.jsx'; // stand-in with "Öppna admin" (FB) until FI
export const PlatformShopDetail = pendingPlatform('PlatformShopDetail');
export const PlatformAddons = pendingPlatform('PlatformAddons');
export const PlatformUsers = pendingPlatform('PlatformUsers');
export const PlatformPrinters = pendingPlatform('PlatformPrinters');
export const PlatformReports = pendingPlatform('PlatformReports');
