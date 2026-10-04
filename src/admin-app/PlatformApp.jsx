// The platform console's router (CP5 brief FA.4, D102): every address under
// /platform, mounted with `basename="/platform"`, so the pages' absolute links
// (`/shops/:id`, PlatformLayout's menu) need no edit. Routes and guards mirror
// src/App.jsx's platform branch for the launch-scope pages; the DAC7 and leads
// pages left the build (gap analysis §1b, D103). The 3D models page came back
// with unit CP5-FO (the Worker's platform 3D-model routes, CP5-WH).
//
// Signing in happens on the admin tree's /login: PlatformRoute's
// `<Navigate to="/login">` lands on /platform/login here, which loads /login.

import React, { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import ScrollToTop from '../components/ScrollToTop';
import PlatformRoute from '../components/auth/PlatformRoute';
import Providers from './Providers.jsx';
import * as Pages from './pages.jsx';

/** The platform tree's addresses, relative to /platform. */
export const PLATFORM_ROUTES = [
  { path: '/', page: 'PlatformShops' },
  { path: '/shops', page: 'PlatformShops' },
  { path: '/shops/:shopId', page: 'PlatformShopDetail' },
  { path: '/addons', page: 'PlatformAddons' },
  { path: '/printers', page: 'PlatformPrinters' },
  { path: '/models', page: 'PlatformModels' },
  { path: '/reports', page: 'PlatformReports' },
  { path: '/users', page: 'PlatformUsers' },
];

/** /platform/login → the one sign-in page, a full load out of this tree. */
function ToSignIn() {
  useEffect(() => {
    window.location.replace('/login');
  }, []);
  return null;
}

export default function PlatformApp() {
  return (
    <BrowserRouter basename="/platform">
      <ScrollToTop />
      <Providers tree="platform">
        <div className="min-h-screen bg-gray-50">
          <Toaster
            position="top-right"
            toastOptions={{ duration: 4000, style: { background: '#363636', color: '#fff' } }}
          />
          <Routes>
            <Route path="/login" element={<ToSignIn />} />
            {PLATFORM_ROUTES.map(({ path, page }) => {
              const Page = Pages[page];
              return (
                <Route
                  key={path}
                  path={path}
                  element={
                    <PlatformRoute>
                      <Page />
                    </PlatformRoute>
                  }
                />
              );
            })}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </Providers>
    </BrowserRouter>
  );
}
