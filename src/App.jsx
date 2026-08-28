import React, { useEffect, useState, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { SimpleAuthContextProvider } from './contexts/SimpleAuthContext';
import { OrderProvider } from './contexts/OrderContext';
import { CartProvider } from './contexts/CartContext';
import { TranslationProvider, useTranslation } from './contexts/TranslationContext';
import { LanguageCurrencyProvider } from './contexts/LanguageCurrencyContext';
import { StoreSettingsProvider } from './contexts/StoreSettingsContext';
import { ShopProvider, useShopId } from './contexts/ShopContext';
import { ShopFeaturesProvider } from './contexts/ShopFeaturesContext';
import AddonGate from './components/addons/AddonGate';
import { WAGON_FEATURE_KEY } from './config/addons';
import { functions } from './firebase/config';
import { httpsCallable } from 'firebase/functions';

// 🚂 WAGON SYSTEM: Single connection point
import wagonRegistry from './wagons/WagonRegistry.js';

// B2C Shop Components
import CookiebotCMP from './components/shop/CookiebotCMP';

// Admin console components.
// The B2B reseller portal was removed (B2B→B2C collapse, 2026-06-13;
// archived at git tag `b2b-portal-archive`). The non-shop hostname now
// serves ONLY the admin console: /login + /admin/* + admin wagon routes.
import PrivateRoute from './components/auth/PrivateRoute';
import AdminRoute from './components/auth/AdminRoute';
import PlatformRoute from './components/auth/PlatformRoute';
import PrintShopRoute from './components/auth/PrintShopRoute';
import PrintShopQueue from './pages/print/PrintShopQueue';
import PrintShopOrderDetail from './pages/print/PrintShopOrderDetail';
import PrintShopArtwork from './pages/print/PrintShopArtwork';
import ImpersonationIntake from './components/auth/ImpersonationIntake';
import AdminShopIdIntake from './components/auth/AdminShopIdIntake';
import PlatformShops from './pages/platform/PlatformShops';
import PlatformShopDetail from './pages/platform/PlatformShopDetail';
import PlatformAddons from './pages/platform/PlatformAddons';
import PlatformModels from './pages/platform/PlatformModels';
import PlatformDac7 from './pages/platform/PlatformDac7';
import PlatformPrinters from './pages/platform/PlatformPrinters';
import PlatformLeads from './pages/platform/PlatformLeads';
import PlatformUsers from './pages/platform/PlatformUsers';
import LoginPage from './pages/LoginPage';
import LandingPage from './pages/LandingPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminUsers from './pages/admin/AdminUsers';
import AdminUserCreate from './pages/admin/AdminUserCreate';
import AdminUserEdit from './pages/admin/AdminUserEdit';
import AdminB2CCustomers from './pages/admin/AdminB2CCustomers';
import AdminB2CCustomerEdit from './pages/admin/AdminB2CCustomerEdit';
import AdminB2BCustomers from './pages/admin/AdminB2BCustomers';
import AdminOrders from './pages/admin/AdminOrders';
import AdminOrderDetail from './pages/admin/AdminOrderDetail';
import AdminProducts from './pages/admin/AdminProducts';
import AdminStorefront from './pages/admin/AdminStorefront';
import AdminMarketingMaterials from './pages/admin/AdminMarketingMaterials';
import AdminMarketingMaterialEdit from './pages/admin/AdminMarketingMaterialEdit';
// Google Shopping admin removed — Google Merchant feature cut (POD shops don't need it).
// import AdminGoogleShopping from './pages/admin/AdminGoogleShopping';
import AdminCustomerMarketingMaterials from './pages/admin/AdminCustomerMarketingMaterials';
import AdminCustomerMarketingMaterialEdit from './pages/admin/AdminCustomerMarketingMaterialEdit';
import AdminPages from './pages/admin/AdminPages';
import AdminPageEdit from './pages/admin/AdminPageEdit';
import AdminCollections from './pages/admin/AdminCollections';
import AdminCollectionEdit from './pages/admin/AdminCollectionEdit';
import AdminMenu from './pages/admin/AdminMenu';
import AdminSettings from './pages/admin/AdminSettings';
import AdminPayments from './pages/admin/AdminPayments';
import AdminMyTaxData from './pages/admin/AdminMyTaxData';
// 🇸🇪 SE-ONLY LAUNCH: AdminTranslations hidden (single-language). Re-enable with its route below.
// import AdminTranslations from './pages/admin/AdminTranslations';

// B2C Shop Components (new)
import PublicStorefront from './pages/shop/PublicStorefront';
import PublicProductPage from './pages/shop/PublicProductPage';
import ShoppingCart from './pages/shop/ShoppingCart';
import Checkout from './pages/shop/Checkout';
import CustomerAccount from './pages/shop/CustomerAccount';
import CustomerLogin from './pages/shop/CustomerLogin';
import CustomerRegister from './pages/shop/CustomerRegister';
import B2BRegister from './pages/shop/B2BRegister';
import B2BDashboard from './pages/shop/B2BDashboard';
import B2BCatalog from './pages/shop/B2BCatalog';
import B2BProfile from './pages/shop/B2BProfile';
import B2BOrders from './pages/shop/B2BOrders';
import B2BOrderDetail from './pages/shop/B2BOrderDetail';
import B2BPortalLayout from './components/shop/B2BPortalLayout';
import { B2BCustomerProvider } from './contexts/B2BCustomerContext';
import ForgotPassword from './pages/shop/ForgotPassword';
import ResetPassword from './pages/shop/ResetPassword';
import VerifyEmailPage from './pages/shop/VerifyEmailPage';
import EmailVerificationHandler from './pages/shop/EmailVerificationHandler';
import ShopGate from './components/shop/ShopGate';
import CollectionPage from './pages/shop/CollectionPage';
import ProductCollectionPage from './pages/shop/ProductCollectionPage';
import TagPage from './pages/shop/TagPage';
import AllProductsPage from './pages/shop/AllProductsPage';
import DynamicRouteHandler from './components/shop/DynamicRouteHandler';
import { DEFAULT_SHOP_ID } from './config/tenancy';

// Legal & Compliance Pages (now handled by CMS)

// Dynamic CMS Pages
import DynamicPage from './pages/shop/DynamicPage';

// Affiliate Program Pages
import AffiliateRegistration from './pages/shop/AffiliateRegistration';
import AffiliateLogin from './pages/shop/AffiliateLogin';
import AffiliatePortal from './pages/shop/AffiliatePortal';
import AdminAffiliates from './pages/admin/AdminAffiliates';
import AdminAffiliateEdit from './pages/admin/AdminAffiliateEdit';
import AdminAffiliateCreate from './pages/admin/AdminAffiliateCreate';
import AdminAffiliateAnalytics from './pages/admin/AdminAffiliateAnalytics';
import AdminAffiliatePayout from './pages/admin/AdminAffiliatePayout';
import AdminDiscountCodes from './pages/admin/AdminDiscountCodes';
import AdminReviews from './pages/admin/AdminReviews';
import AdminContentStudio from './pages/admin/AdminContentStudio';
import AffiliateTracker from './components/AffiliateTracker';
import ScrollToTop from './components/ScrollToTop';

// 📱 Innehållsstudio mobile hand-off — a PUBLIC page (token-authed, no login).
// Opened on a phone via QR from the admin. Mounted on every surface so it
// resolves regardless of which host the admin's origin was.
import HandoffPage from './pages/HandoffPage';

// Order Confirmation
import OrderConfirmation from './pages/shop/OrderConfirmation';
import OrderReturn from './pages/shop/OrderReturn';
import WithdrawalPage from './pages/shop/WithdrawalPage';
import CheckoutRecoveryPage from './pages/shop/CheckoutRecoveryPage';
import CheckoutUnsubscribePage from './pages/shop/CheckoutUnsubscribePage';
import ReviewSubmitPage from './pages/shop/ReviewSubmitPage';
import ReviewUnsubscribePage from './pages/shop/ReviewUnsubscribePage';

import { Toaster } from 'react-hot-toast';

// Component to conditionally wrap with TranslationProvider + LanguageCurrencyProvider based on route
const ConditionalTranslationProvider = ({ children, appMode }) => {
  const location = useLocation();
  
  // B2C Shop uses both TranslationProvider and LanguageCurrencyProvider for geo + language + currency
  if (appMode === 'shop') {
    console.log(`🌍 CONDITIONAL: B2C Shop mode - using TranslationProvider + LanguageCurrencyProvider for geo/i18n`);
    return (
      <TranslationProvider>
        <LanguageCurrencyProvider>
          {children}
        </LanguageCurrencyProvider>
      </TranslationProvider>
    );
  }
  
  // Admin credential pages should NOT use TranslationProvider (they use credentialTranslations)
  const credentialRoutes = ['/login', '/forgot-password'];
  const isCredentialPage = credentialRoutes.includes(location.pathname);
  
  if (isCredentialPage) {
    console.log(`🌍 CONDITIONAL: Credential page detected (${location.pathname}) - using credentialTranslations`);
    return children; // No TranslationProvider wrapper
  } else {
    console.log(`🌍 CONDITIONAL: Authenticated page detected (${location.pathname}) - using TranslationProvider`);
    return <TranslationProvider>{children}</TranslationProvider>;
  }
};

// Root gate on the admin host: a logged-in user goes straight to the console;
// everyone else gets the public meteorpr landing page (the login gateway).
function LandingGate() {
  const { currentUser, loading } = useAuth();
  if (loading) return null;
  if (currentUser) return <Navigate to="/admin" replace />;
  return <LandingPage />;
}

// Fallback for an unknown slug UNDER a real shop (/{shopId}/badslug): bounce to
// THAT shop's home, keeping shop context — NOT to the bare root (which is now
// the platform LP, where the shop context would be lost).
function ShopHomeRedirect() {
  const shopId = useShopId();
  return <Navigate to={`/${shopId}`} replace />;
}

function App() {
  // 🚂 WAGON SYSTEM: State for wagon routes
  const [wagonRoutes, setWagonRoutes] = useState([]);

  // Detect subdomain to determine which app to show
  const hostname = window.location.hostname || '';
  const subdomain = (hostname && typeof hostname === 'string') ? hostname.split('.')[0] : '';
  
  // Determine app mode based on subdomain.
  // Accept a `shop-` prefix too, so Firebase hosting sites like
  // `shop-b8shield.web.app` trigger shop mode (the .web.app first segment is the
  // whole site ID, which can't be exactly "shop"). `shop.b8shield.com` still matches.
  const isShopSubdomain = subdomain === 'shop' || subdomain.startsWith('shop-');

  // Platform operator console — its own subdomain (platform.* / platform-*),
  // a separate, siloed surface from shop admin. (See docs/PLATFORM_ARCHITECTURE.md)
  const isPlatformSubdomain = subdomain === 'platform' || subdomain.startsWith('platform-');

  // Print-shop portal — its own subdomain (print.* / print-*). The POD add-on's
  // external-printer surface, siloed from shop/admin/platform. The role has NO
  // direct DB access; the pages call scoped print callables.
  const isPrintSubdomain = subdomain === 'print' || subdomain.startsWith('print-');

  // Four siloed surfaces: 'platform' (operator), 'print' (external printer),
  // 'shop' (storefront), 'admin' (shop admin — the default host).
  const appMode = isPlatformSubdomain
    ? 'platform'
    : isPrintSubdomain
    ? 'print'
    : (isShopSubdomain ? 'shop' : 'admin');

  // 🚂 WAGON SYSTEM: Auto-discover all wagons (ONLY CONNECTION POINT NEEDED!)
  useEffect(() => {
    const initializeWagons = async () => {
      console.log('Add-ons: discovering…');
      
      // Discover and connect all wagons
      await wagonRegistry.discoverWagons();
      
      // Get wagon routes for the current app mode (FIX: await the async function)
      const routes = await wagonRegistry.getRoutes();
      const filteredRoutes = routes.filter(route => {
        // Wagon routes are admin tooling — only mounted in admin mode
        return appMode === 'admin';
      });
      
      setWagonRoutes(filteredRoutes);
      
      console.log(`✅ B8Shield Train: ${filteredRoutes.length} wagon routes connected for ${appMode} mode`);
    };

    initializeWagons();
  }, [appMode]);

  // The affiliate link handling logic has been moved to the AffiliateTracker component.
  // This ensures it runs on every route change.
  
  console.log('App Mode:', appMode, 'Hostname:', hostname, 'Subdomain:', subdomain);

  const content = (
    <>
      <ScrollToTop />
      {appMode === 'shop' && <CookiebotCMP />}
      {/* P4.3: consume ?impersonate=&audit= on the admin host (platform-gated). */}
      {appMode === 'admin' && <ImpersonationIntake />}
      {/* Deep-link shop switching: consume ?shopId= on the admin host (email links). */}
      {appMode === 'admin' && <AdminShopIdIntake />}
      <AffiliateTracker />
      <ConditionalTranslationProvider appMode={appMode}>
        <div className="min-h-screen bg-gray-50">
          <Toaster 
            position="top-right"
            toastOptions={{
              duration: 4000,
              style: {
                background: '#363636',
                color: '#fff',
              },
            }}
          />
          
          <Routes>
          {/* 📱 Public mobile hand-off (Innehållsstudio QR). Declared BEFORE the
              appMode branches so it resolves on any host — the QR is minted from
              window.location.origin (the admin host), but keeping it host-agnostic
              is safe and future-proof. Token-authed; no login, no shop context. */}
          <Route path="/handoff/:postId" element={<HandoffPage />} />
          {appMode === 'platform' ? (
            // Platform operator console — its own siloed surface. Distinct
            // PlatformLayout (NOT the shop-admin shell). Gated to platform users.
            <>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/__/auth/action" element={<EmailVerificationHandler />} />
              <Route path="/" element={
                <PlatformRoute><PlatformShops /></PlatformRoute>
              } />
              <Route path="/shops" element={
                <PlatformRoute><PlatformShops /></PlatformRoute>
              } />
              <Route path="/shops/:shopId" element={
                <PlatformRoute><PlatformShopDetail /></PlatformRoute>
              } />
              <Route path="/addons" element={
                <PlatformRoute><PlatformAddons /></PlatformRoute>
              } />
              <Route path="/models" element={
                <PlatformRoute><PlatformModels /></PlatformRoute>
              } />
              <Route path="/dac7" element={
                <PlatformRoute><PlatformDac7 /></PlatformRoute>
              } />
              <Route path="/printers" element={
                <PlatformRoute><PlatformPrinters /></PlatformRoute>
              } />
              <Route path="/leads" element={
                <PlatformRoute><PlatformLeads /></PlatformRoute>
              } />
              <Route path="/users" element={
                <PlatformRoute><PlatformUsers /></PlatformRoute>
              } />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          ) : appMode === 'print' ? (
            // Print-shop portal — its own siloed surface (print.* subdomain). The
            // print_shop role; pages call scoped print callables (zero direct DB
            // access). Gated by PrintShopRoute (UI) + the callables (enforcement).
            <>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/__/auth/action" element={<EmailVerificationHandler />} />
              <Route path="/" element={
                <PrintShopRoute><PrintShopQueue /></PrintShopRoute>
              } />
              <Route path="/orders/:orderId" element={
                <PrintShopRoute><PrintShopOrderDetail /></PrintShopRoute>
              } />
              <Route path="/artwork" element={
                <PrintShopRoute><PrintShopArtwork /></PrintShopRoute>
              } />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          ) : appMode === 'shop' ? (
            // B2C Shop Routes — PATH-PREFIX multi-tenant grammar:
            // /{shopId}, /{shopId}/product/:slug, /{shopId}/cart, etc.
            // Bare / redirects to the default shop. Swedish-only (i18n deferred);
            // legacy /se/... links are redirected by LegacyCountryRedirect.
            <>
              {/* Bare root → the platform Landing Page. A naked URL (no
                  /{shopId}) must NEVER render a storefront — storefronts live
                  ONLY at /{shopId}. Do NOT auto-redirect to DEFAULT_SHOP_ID
                  (that leaked the b8shield store at the bare root). */}
              <Route path="/" element={<LandingPage />} />

              {/* Credential pages — shop-global, no shop prefix */}
              <Route path="/login" element={<CustomerLogin />} />
              <Route path="/register" element={<CustomerRegister />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/verify-email" element={<VerifyEmailPage />} />
              <Route path="/affiliate-login" element={<AffiliateLogin />} />
              <Route path="/__/auth/action" element={<EmailVerificationHandler />} />

              {/* Per-shop storefront (shopId = first path segment). ShopGate
                  validates the shop (redirects legacy /se & unknown shops,
                  shows "unavailable" for disabled shops) before rendering. */}
              <Route path="/:shopId" element={<ShopGate><PublicStorefront /></ShopGate>} />
              <Route path="/:shopId/product/:slug" element={<ShopGate><PublicProductPage /></ShopGate>} />
              <Route path="/:shopId/cart" element={<ShopGate><ShoppingCart /></ShopGate>} />
              <Route path="/:shopId/checkout" element={<ShopGate><Checkout /></ShopGate>} />
              <Route path="/:shopId/order-return" element={<ShopGate><OrderReturn /></ShopGate>} />
              <Route path="/:shopId/order-confirmation/:orderId" element={<ShopGate><OrderConfirmation /></ShopGate>} />
              <Route path="/:shopId/account" element={<ShopGate><CustomerAccount /></ShopGate>} />
              {/* Ångerfunktionen (DAL 2 kap. 10 a §) — public, guest-capable,
                  linked from the footer on every page (continuous availability). */}
              <Route path="/:shopId/angra" element={<ShopGate><WithdrawalPage /></ShopGate>} />
              {/* Abandoned-checkout recovery ("Övergiven kassa" add-on): guest
                  pages reached from the reminder email. NO AddonGate — the
                  recovery + unsubscribe links must work even if the add-on is
                  later disabled. Declared BEFORE the /:shopId/* CMS catch-all. */}
              <Route path="/:shopId/aterta/:token" element={<ShopGate><CheckoutRecoveryPage /></ShopGate>} />
              <Route path="/:shopId/avregistrera/:token" element={<ShopGate><CheckoutUnsubscribePage /></ShopGate>} />
              {/* Native product reviews ("Recensioner" add-on): the public pages
                  reached from the review-request email. NO AddonGate — the link
                  must resolve even if the add-on was later disabled. Declared
                  BEFORE the /:shopId/* CMS catch-all. */}
              <Route path="/:shopId/recensera/:token" element={<ShopGate><ReviewSubmitPage /></ShopGate>} />
              <Route path="/:shopId/avregistrera-recensioner/:token" element={<ShopGate><ReviewUnsubscribePage /></ShopGate>} />
              <Route path="/:shopId/affiliate-registration" element={<ShopGate><AddonGate feature="affiliate" redirectTo="shop-home"><AffiliateRegistration /></AddonGate></ShopGate>} />
              <Route path="/:shopId/affiliate-portal" element={<ShopGate><AddonGate feature="affiliate" redirectTo="shop-home"><AffiliatePortal /></AddonGate></ShopGate>} />
              {/* B2B Wholesale add-on: per-shop wholesale self-registration.
                  Gated on features.b2b; a non-B2B shop bounces to its home.
                  Declared BEFORE the /:shopId/* CMS catch-all so it isn't
                  swallowed. Portal pages (catalog/orders) land in Phase 3. */}
              <Route path="/:shopId/b2b/register" element={<ShopGate><AddonGate feature="b2b" redirectTo="shop-home"><B2BRegister /></AddonGate></ShopGate>} />
              {/* B2B portal (browse-only in this phase; ordering = Phase 4).
                  Each page: ShopGate → AddonGate(b2b) → B2BCustomerProvider →
                  B2BPortalLayout (resolves profile + gates active). Declared
                  BEFORE the /:shopId/* CMS catch-all.
                  WALLED GARDEN: redirectTo="/login" (NOT shop-home) so that if a
                  shop loses the b2b add-on mid-session, the customer lands on
                  login, never the consumer storefront. (The PUBLIC register page
                  below keeps shop-home — a prospect bouncing to the shop is fine.) */}
              <Route path="/:shopId/b2b" element={<ShopGate><AddonGate feature="b2b" redirectTo="/login"><B2BCustomerProvider><B2BPortalLayout><B2BDashboard /></B2BPortalLayout></B2BCustomerProvider></AddonGate></ShopGate>} />
              <Route path="/:shopId/b2b/products" element={<ShopGate><AddonGate feature="b2b" redirectTo="/login"><B2BCustomerProvider><B2BPortalLayout><B2BCatalog /></B2BPortalLayout></B2BCustomerProvider></AddonGate></ShopGate>} />
              <Route path="/:shopId/b2b/orders" element={<ShopGate><AddonGate feature="b2b" redirectTo="/login"><B2BCustomerProvider><B2BPortalLayout><B2BOrders /></B2BPortalLayout></B2BCustomerProvider></AddonGate></ShopGate>} />
              <Route path="/:shopId/b2b/orders/:orderId" element={<ShopGate><AddonGate feature="b2b" redirectTo="/login"><B2BCustomerProvider><B2BPortalLayout><B2BOrderDetail /></B2BPortalLayout></B2BCustomerProvider></AddonGate></ShopGate>} />
              <Route path="/:shopId/b2b/profile" element={<ShopGate><AddonGate feature="b2b" redirectTo="/login"><B2BCustomerProvider><B2BPortalLayout><B2BProfile /></B2BPortalLayout></B2BCustomerProvider></AddonGate></ShopGate>} />

              {/* Category browse pages (the primary taxonomy). Specific path so
                  it matches before the CMS catch-all below. */}
              <Route path="/:shopId/kategori/:category" element={<ShopGate><CollectionPage /></ShopGate>} />

              {/* Collection browse pages (curated groups: manual pick or smart
                  tag-rule). Specific path — matches before the CMS catch-all. */}
              <Route path="/:shopId/samling/:handle" element={<ShopGate><ProductCollectionPage /></ShopGate>} />

              {/* Tag browse pages (products with a given tag). Specific path —
                  matches before the CMS catch-all. */}
              <Route path="/:shopId/tagg/:tag" element={<ShopGate><TagPage /></ShopGate>} />

              {/* Full-catalog browse page (Shopify's /collections/all). Where
                  "Visa alla produkter" lands when the frontpage is curated. */}
              <Route path="/:shopId/produkter" element={<ShopGate><AllProductsPage /></ShopGate>} />

              {/* Per-shop CMS pages: /{shopId}/{slug} — DynamicRouteHandler reads
                  the slug after the shopId. Falls back to the shop home. */}
              <Route path="/:shopId/*" element={
                <ShopGate>
                  <DynamicRouteHandler>
                    <ShopHomeRedirect />
                  </DynamicRouteHandler>
                </ShopGate>
              } />

              {/* Catch-all → the Landing Page, NOT the default storefront. An
                  unmatched naked path must not dump the visitor into b8shield's
                  store. (Credential pages + /{shopId} routes are matched above.) */}
              <Route path="*" element={<LandingPage />} />
            </>
          ) : (
            // Admin console routes (B2B portal removed — see b2b-portal-archive tag)
            <>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />

              {/* Firebase Auth Action Handler - Email Verification */}
              <Route path="/__/auth/action" element={<EmailVerificationHandler />} />

              {/* Root: public meteorpr landing page (login gateway). Logged-in
                  users are bounced to the console; logged-out visitors get the LP. */}
              <Route path="/" element={<LandingGate />} />

              {/* Admin Routes - Grouped under /admin prefix */}
              <Route path="/admin" element={
                <AdminRoute>
                  <AdminDashboard />
                </AdminRoute>
              } />
              
              <Route path="/admin/users" element={
                <AdminRoute>
                  <AdminUsers />
                </AdminRoute>
              } />
              
              <Route path="/admin/users/create" element={
                <AdminRoute>
                  <AdminUserCreate />
                </AdminRoute>
              } />
              
              <Route path="/admin/users/:userId/edit" element={
                <AdminRoute>
                  <AdminUserEdit />
                </AdminRoute>
              } />
              
              <Route path="/admin/b2c-customers" element={
                <AdminRoute>
                  <AdminB2CCustomers />
                </AdminRoute>
              } />
              
              <Route path="/admin/b2c-customers/:customerId" element={
                <AdminRoute>
                  <AdminB2CCustomerEdit />
                </AdminRoute>
              } />

              {/* B2B Wholesale add-on: admin manages wholesale customers (list +
                  activate). Gated on features.b2b (route + AppLayout menu);
                  default-ON keeps existing shops working. */}
              <Route path="/admin/b2b-customers" element={
                <AddonGate feature="b2b"><AdminRoute>
                  <AdminB2BCustomers />
                </AdminRoute></AddonGate>
              } />
              
              <Route path="/admin/orders" element={
                <AdminRoute>
                  <AdminOrders />
                </AdminRoute>
              } />
              
              <Route path="/admin/orders/:orderId" element={
                <AdminRoute>
                  <AdminOrderDetail />
                </AdminRoute>
              } />
              
              <Route path="/admin/products" element={
                <AdminRoute>
                  <AdminProducts />
                </AdminRoute>
              } />

              <Route path="/admin/storefront" element={
                <AdminRoute>
                  <AdminStorefront />
                </AdminRoute>
              } />

              {/* Marknadsföringsmaterial — opt-in add-on (2026-08-28). AddonGate
                  blocks deep links when the shop isn't entitled; the menu item
                  is hidden by the same flag in AppLayout. */}
              <Route path="/admin/marketing" element={
                <AddonGate feature="marketingMaterials"><AdminRoute>
                  <AdminMarketingMaterials />
                </AdminRoute></AddonGate>
              } />

              <Route path="/admin/marketing/:materialId/edit" element={
                <AddonGate feature="marketingMaterials"><AdminRoute>
                  <AdminMarketingMaterialEdit />
                </AdminRoute></AddonGate>
              } />

              <Route path="/admin/customers/:customerId/marketing" element={
                <AdminRoute>
                  <AdminCustomerMarketingMaterials />
                </AdminRoute>
              } />

              <Route path="/admin/customers/:customerId/marketing/:materialId/edit" element={
                <AdminRoute>
                  <AdminCustomerMarketingMaterialEdit />
                </AdminRoute>
              } />

              <Route path="/admin/pages" element={
                <AdminRoute>
                  <AdminPages />
                </AdminRoute>
              } />

              <Route path="/admin/pages/:id" element={
                <AdminRoute>
                  <AdminPageEdit />
                </AdminRoute>
              } />

              <Route path="/admin/collections" element={
                <AdminRoute>
                  <AdminCollections />
                </AdminRoute>
              } />

              <Route path="/admin/collections/:id" element={
                <AdminRoute>
                  <AdminCollectionEdit />
                </AdminRoute>
              } />

              <Route path="/admin/menu" element={
                <AdminRoute>
                  <AdminMenu />
                </AdminRoute>
              } />

              {/* Affiliate is an add-on: its ADMIN routes are gated on the
                  `affiliate` feature flag (menu + route now). Storefront/checkout/
                  function enforcement is the P4.5b follow-up. Default-ON keeps
                  existing shops working. */}
              <Route path="/admin/affiliates" element={
                <AddonGate feature="affiliate"><AdminRoute>
                  <AdminAffiliates />
                </AdminRoute></AddonGate>
              } />
              <Route path="/admin/affiliates/create" element={
                <AddonGate feature="affiliate"><AdminRoute>
                  <AdminAffiliateCreate />
                </AdminRoute></AddonGate>
              } />

              <Route path="/admin/affiliates/analytics" element={
                <AddonGate feature="affiliate"><AdminRoute>
                  <AdminAffiliateAnalytics />
                </AdminRoute></AddonGate>
              } />

              <Route path="/admin/affiliates/application/:id" element={
                <AddonGate feature="affiliate"><AdminRoute>
                  <AdminAffiliateEdit />
                </AdminRoute></AddonGate>
              } />

              <Route path="/admin/affiliates/manage/:id" element={
                <AddonGate feature="affiliate"><AdminRoute>
                  <AdminAffiliateEdit />
                </AdminRoute></AddonGate>
              } />

              <Route path="/admin/affiliates/payout/:affiliateId" element={
                <AddonGate feature="affiliate"><AdminRoute>
                  <AdminAffiliatePayout />
                </AdminRoute></AddonGate>
              } />

              {/* Rabattkoder (campaign discount codes) is an add-on: its admin
                  route is gated on the `discountCodes` feature flag. Default-ON
                  keeps existing shops working (harmless — no codes exist until a
                  merchant creates one). */}
              <Route path="/admin/discount-codes" element={
                <AddonGate feature="discountCodes"><AdminRoute>
                  <AdminDiscountCodes />
                </AdminRoute></AddonGate>
              } />

              {/* Recensioner (native product reviews) is an add-on: its admin
                  route is gated on the `productReviews` feature flag. Default-ON
                  keeps existing shops working. */}
              <Route path="/admin/reviews" element={
                <AddonGate feature="productReviews"><AdminRoute>
                  <AdminReviews />
                </AdminRoute></AddonGate>
              } />

              {/* Innehållsstudio (AI social-media studio) is an EXPLICIT OPT-IN
                  add-on — the ONLY one that is off unless features.contentStudio
                  === true. No AddonGate here (it is default-ON); the page itself
                  checks the flag (platform users always pass) and shows a
                  friendly "not activated" card on deep links. */}
              <Route path="/admin/content-studio" element={
                <AdminRoute>
                  <AdminContentStudio />
                </AdminRoute>
              } />

              <Route path="/admin/settings" element={
                <AdminRoute>
                  <AdminSettings />
                </AdminRoute>
              } />

              <Route path="/admin/payments" element={
                <AdminRoute>
                  <AdminPayments />
                </AdminRoute>
              } />

              <Route path="/admin/skatteuppgifter" element={
                <AdminRoute>
                  <AdminMyTaxData />
                </AdminRoute>
              } />

              {/* 🇸🇪 SE-ONLY LAUNCH: Translations admin route hidden (single-language).
                  Runtime i18n engine stays active. Re-enable for internationalization. */}
              {/* <Route path="/admin/translations" element={
                <AdminRoute>
                  <AdminTranslations />
                </AdminRoute>
              } /> */}

              {/* 🚂 WAGON SYSTEM: Auto-generated wagon (add-on) routes.
                  Each is wrapped in <AddonGate> so a disabled add-on's route
                  redirects to /admin even via deep link (defense in depth on
                  top of the hidden menu item). Gated only when the wagon id maps
                  to a feature key; default-ON keeps existing shops working. */}
              {wagonRoutes.map(({ path, component: Component, adminOnly, private: isPrivate, wagonId }) => {
                const featureKey = WAGON_FEATURE_KEY[wagonId];
                const inner = (
                  <Suspense fallback={
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-500"></div>
                      <span className="ml-3 text-lg text-gray-600">Laddar tillägg...</span>
                    </div>
                  }>
                    {isPrivate ? (
                      adminOnly ? (
                        <AdminRoute><Component /></AdminRoute>
                      ) : (
                        <PrivateRoute><Component /></PrivateRoute>
                      )
                    ) : (
                      <Component />
                    )}
                  </Suspense>
                );
                return (
                  <Route
                    key={`${wagonId}-${path}`}
                    path={path}
                    element={featureKey ? <AddonGate feature={featureKey}>{inner}</AddonGate> : inner}
                  />
                );
              })}
              
              {/* Catch-all redirect */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
        </div>
      </ConditionalTranslationProvider>
    </>
  );

  return (
    <Router>
      {/* P4.3: only the admin surface honors an operator impersonation session
          (it overrides the path-resolved shopId so shop admin renders the
          target tenant). Storefront/platform never impersonate. */}
      <ShopProvider impersonationEnabled={appMode === 'admin'}>
        <StoreSettingsProvider>
          <ShopFeaturesProvider>
            <AuthProvider>
              <SimpleAuthContextProvider>
                <OrderProvider>
                  <CartProvider>
                    {content}
                  </CartProvider>
                </OrderProvider>
              </SimpleAuthContextProvider>
            </AuthProvider>
          </ShopFeaturesProvider>
        </StoreSettingsProvider>
      </ShopProvider>
    </Router>
  );
}

export default App; 