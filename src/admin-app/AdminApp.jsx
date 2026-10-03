// The shop admin's router (CP5 brief FA.4): every address of the admin tree.
// The routes and guards mirror src/App.jsx's admin branch for the launch-scope
// pages (CP5_GAP_ANALYSIS.md §1a); a page that left the build (§1b: affiliate,
// customers, marketing material, discount codes, reviews, content studio, tax
// data, the wagons, the user editor, the landing page) has no route, and its
// address goes back to the root as any unknown address did.
//
// `/` → /login when signed out, the dashboard when signed in (D103). A
// platform user reaches the admin tree only to work AS a shop: without an
// open acting-as grant the admin addresses send them to the platform console.
// POD is a static route (no wagon discovery), gated by `features.pod`.

import React, { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import ScrollToTop from '../components/ScrollToTop';
import AdminRoute from '../components/auth/AdminRoute';
import AddonGate from '../components/addons/AddonGate';
// ?shopId= and the console's ?impersonate= (the alias list hands this build
// its own intake: replacements/AdminShopIdIntake.jsx, unit FB).
import AdminShopIdIntake from '../components/auth/AdminShopIdIntake';
import { isUnresolvedShopId } from '../config/tenancy';
import Providers from './Providers.jsx';
import NotFound from './NotFound.jsx';
import { useAuth } from './providers/Session.jsx';
import { useShopId } from './providers/ActiveShop.jsx';
import * as Pages from './pages.jsx';

/** The admin tree's addresses. `guard: 'admin'` = AdminRoute; `feature` = AddonGate. */
export const ADMIN_ROUTES = [
  { path: '/login', page: 'LoginPage' },
  { path: '/forgot-password', page: 'ForgotPasswordPage' },
  { path: '/reset-password', page: 'ResetPasswordPage' },
  { path: '/admin', page: 'AdminDashboard', guard: 'admin' },
  { path: '/admin/users', page: 'AdminUsers', guard: 'admin' },
  { path: '/admin/orders', page: 'AdminOrders', guard: 'admin' },
  { path: '/admin/orders/:orderId', page: 'AdminOrderDetail', guard: 'admin' },
  { path: '/admin/products', page: 'AdminProducts', guard: 'admin' },
  { path: '/admin/storefront', page: 'AdminStorefront', guard: 'admin' },
  { path: '/admin/pages', page: 'AdminPages', guard: 'admin' },
  { path: '/admin/pages/:id', page: 'AdminPageEdit', guard: 'admin' },
  { path: '/admin/collections', page: 'AdminCollections', guard: 'admin' },
  { path: '/admin/collections/:id', page: 'AdminCollectionEdit', guard: 'admin' },
  { path: '/admin/menu', page: 'AdminMenu', guard: 'admin' },
  { path: '/admin/settings', page: 'AdminSettings', guard: 'admin' },
  { path: '/admin/plattformsvillkor', page: 'AdminPlatformTerms', guard: 'admin' },
  { path: '/admin/payments', page: 'AdminPayments', guard: 'admin' },
  { path: '/admin/pod', page: 'PodAdminPage', guard: 'admin', feature: 'pod' },
];

/** `/`: the login for a visitor, the dashboard for a signed-in user (D103). */
function RootRedirect() {
  const { currentUser, loading } = useAuth();
  if (loading) return null;
  return <Navigate to={currentUser ? '/admin' : '/login'} replace />;
}

/** A platform user with no shop to act as belongs in the platform console. */
function ShopRequired({ children }) {
  const { isPlatform } = useAuth();
  const shopId = useShopId();
  const leave = isPlatform && isUnresolvedShopId(shopId);
  useEffect(() => {
    if (leave) window.location.replace('/platform/');
  }, [leave]);
  return leave ? null : children;
}

function routeElement({ page, guard, feature }) {
  const Page = Pages[page];
  if (guard !== 'admin') return <Page />;
  const guarded = (
    <AdminRoute>
      <ShopRequired>
        <Page />
      </ShopRequired>
    </AdminRoute>
  );
  return feature ? <AddonGate feature={feature}>{guarded}</AddonGate> : guarded;
}

export default function AdminApp() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Providers tree="admin">
        <AdminShopIdIntake />
        <div className="min-h-screen bg-gray-50">
          <Toaster
            position="top-right"
            toastOptions={{ duration: 4000, style: { background: '#363636', color: '#fff' } }}
          />
          <Routes>
            <Route path="/" element={<RootRedirect />} />
            {ADMIN_ROUTES.map((route) => (
              <Route key={route.path} path={route.path} element={routeElement(route)} />
            ))}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </Providers>
    </BrowserRouter>
  );
}
