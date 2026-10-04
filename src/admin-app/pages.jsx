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

// ── sign-in (no Firebase code once the alias list applies) ──
export { default as LoginPage } from '../pages/LoginPage.jsx';
export { default as ForgotPasswordPage } from '../pages/ForgotPasswordPage.jsx';
export { default as ResetPasswordPage } from './ResetPasswordPage.jsx';

// ── the shop admin (AppLayout shell; FB …) ──
export { default as AdminDashboard } from '../pages/admin/AdminDashboard.jsx';
export { default as AdminProducts } from '../pages/admin/AdminProducts.jsx';
export { default as AdminOrders } from '../pages/admin/AdminOrders.jsx';
export { default as AdminOrderDetail } from '../pages/admin/AdminOrderDetail.jsx';
export { default as AdminCollections } from '../pages/admin/AdminCollections.jsx';
export { default as AdminCollectionEdit } from '../pages/admin/AdminCollectionEdit.jsx';
export { default as AdminMenu } from '../pages/admin/AdminMenu.jsx';
export { default as AdminPages } from '../pages/admin/AdminPages.jsx';
export { default as AdminPageEdit } from '../pages/admin/AdminPageEdit.jsx';
export { default as AdminStorefront } from '../pages/admin/AdminStorefront.jsx';
export { default as AdminSettings } from '../pages/admin/AdminSettings.jsx';
export { default as AdminPayments } from '../pages/admin/AdminPayments.jsx';
export { default as AdminUsers } from '../pages/admin/AdminUsers.jsx';
export { default as AdminPlatformTerms } from '../pages/admin/AdminPlatformTerms.jsx';
export { default as AdminDiscountCodes } from '../pages/admin/AdminDiscountCodes.jsx'; // CP8-DC
export { default as PodAdminPage } from '../wagons/pod-wagon/components/PodAdminPage.jsx';
export { default as AdminRedirects } from './pages/new/AdminRedirects.jsx'; // CP5-FL: new, admin build only

// ── the platform console (PlatformLayout shell, always dark) ──
export { default as PlatformShops } from '../pages/platform/PlatformShops.jsx';
export { default as PlatformShopDetail } from '../pages/platform/PlatformShopDetail.jsx';
export { default as PlatformAddons } from '../pages/platform/PlatformAddons.jsx';
export { default as PlatformUsers } from '../pages/platform/PlatformUsers.jsx';
export { default as PlatformPrinters } from '../pages/platform/PlatformPrinters.jsx';
export { default as PlatformModels } from '../pages/platform/PlatformModels.jsx';
export { default as PlatformReports } from '../pages/platform/PlatformReports.jsx';
export { default as PlatformSettings } from './pages/new/PlatformSettings.jsx'; // CP5-FL: new, admin build only
export { default as PlatformScreening } from './pages/new/PlatformScreening.jsx'; // CP5-FL
export { default as PlatformTermsVersions } from './pages/new/PlatformTermsVersions.jsx'; // CP5-FL
export { default as PlatformPrintJobs } from './pages/new/PlatformPrintJobs.jsx'; // CP5-FP: new, admin build only
