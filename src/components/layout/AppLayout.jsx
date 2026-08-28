import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import MentionNotifications from '../../wagons/dining-wagon/components/MentionNotifications';
import LanguageSwitcher from '../LanguageSwitcher';
import DarkModeToggle from '../DarkModeToggle';
import { useTranslation } from '../../contexts/TranslationContext';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';
import { useShopFeatures } from '../../contexts/ShopFeaturesContext';
import { useShopId } from '../../contexts/ShopContext';
import { isUnresolvedShopId } from '../../config/tenancy';
import { setDeepLinkShopId, setLastPickedShopId } from '../../config/activeShop';
import ShopPicker from '../admin/ShopPicker';
import { WAGON_FEATURE_KEY } from '../../config/addons';
import ImpersonationBanner from '../auth/ImpersonationBanner';
import { getImpersonation } from '../../config/impersonation';

// 🚂 WAGON SYSTEM: Import wagon registry for menu items
import wagonRegistry from '../../wagons/WagonRegistry.js';

// Icons
import {
  ClipboardDocumentListIcon,
  Cog6ToothIcon,
  BanknotesIcon,
  UsersIcon,
  ArrowRightOnRectangleIcon,
  Bars3Icon,
  XMarkIcon,
  ChartBarIcon,
  CubeIcon,
  MegaphoneIcon,
  SparklesIcon,
  DocumentTextIcon,
  BuildingStorefrontIcon,
  TagIcon,
  StarIcon,
  RectangleStackIcon,
  ListBulletIcon
} from '@heroicons/react/24/outline';

const AppLayout = ({ children }) => {
  const { currentUser, userProfile, logout, isPlatform } = useAuth();
  const { t } = useTranslation();
  const store = useStoreSettings();
  const { isEnabled: isAddonEnabled } = useShopFeatures();
  // The shop this admin session is managing (impersonation > deep-link > own
  // shop > last picked). Surfaced in the top bar so "which shop am I editing?"
  // is always explicit — every admin shares the /admin URL, so the name alone
  // wasn't enough. When it resolves to the UNRESOLVED sentinel (a platform
  // operator who hasn't picked yet) we render the picker instead of a dashboard
  // — there is no default shop to fall into any more (2026-08-15).
  const shopId = useShopId();
  const needsShopPick = isUnresolvedShopId(shopId);
  const navigate = useNavigate();
  const location = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  
  // 🚂 WAGON SYSTEM: State for admin wagon menu items
  const [wagonMenuItems, setWagonMenuItems] = useState([]);

  const isAdmin = userProfile?.role === 'admin';

  // Add-on (wagon) admin menu items, gated PER SHOP by the platform-controlled
  // features map (shops/{id}.features). Previously gated per-user via
  // userWagonSettings; now a wagon shows iff its manifest is enabled (dev kill)
  // AND the active shop has its add-on feature on (default-ON → existing shops
  // keep everything until an operator disables it from the platform console).
  useEffect(() => {
    const loadWagonMenuItems = async () => {
      try {
        await wagonRegistry.ensureWagonsDiscovered();
        const allItems = wagonRegistry.getAdminMenuItemsSync();
        const gated = allItems.filter((item) => {
          const featureKey = WAGON_FEATURE_KEY[item.wagonId];
          // Unknown wagon id (no mapping) → show it (don't hide an add-on we
          // forgot to map); known id → gate on the per-shop feature flag.
          return featureKey ? isAddonEnabled(featureKey) : true;
        });
        setWagonMenuItems(gated);
      } catch (error) {
        console.error('Error loading add-on menu items:', error);
        setWagonMenuItems([]);
      }
    };

    // Small delay to ensure wagons are discovered first
    const timer = setTimeout(loadWagonMenuItems, 100);
    return () => clearTimeout(timer);
  }, [isAddonEnabled]);
  
  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login');
    } catch (error) {
      console.error('Failed to log out', error);
    }
  };
  
  const isActive = (path) => {
    return location.pathname === path;
  };

  // Top-bar store identity (Shopify shows the shop name + a rounded-square avatar
  // with initials). Falls back to the admin's company / email.
  const shopName = store?.shopName || store?.legalName || userProfile?.companyName || currentUser?.email || 'Butik';
  const shopInitials = shopName
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'B';

  const adminNavLinks = [
    {
      name: t('nav.admin_dashboard', 'Admin Dashboard'),
      path: '/admin',
      icon: ChartBarIcon,
      description: t('nav.admin_dashboard_desc', 'Översikt och statistik'),
    },
    {
      // B2B reseller function retired (2026-06-15) — this entry now manages
      // platform administrators only (the B2B-customer tab is hidden in
      // AdminUsers). B2C customers have their own entry below.
      name: t('nav.admin_admins', 'Administratörer'),
      path: '/admin/users',
      icon: UsersIcon,
      description: t('nav.admin_admins_desc', 'Hantera administratörer'),
    },
    {
      name: t('nav.admin_b2c_customers', 'B2C Kunder'),
      path: '/admin/b2c-customers',
      icon: UsersIcon,
      description: t('nav.admin_b2c_customers_desc', 'Hantera konsumentkunder'),
    },
    {
      name: t('nav.admin_orders', 'Ordrar'),
      path: '/admin/orders',
      icon: ClipboardDocumentListIcon,
      description: t('nav.admin_orders_desc', 'Hantera beställningar'),
    },
    {
      name: t('nav.admin_products', 'Produkter'),
      path: '/admin/products',
      icon: CubeIcon,
      description: t('nav.admin_products_desc', 'Hantera produkter'),
    },
    {
      name: t('nav.admin_collections', 'Samlingar'),
      path: '/admin/collections',
      icon: RectangleStackIcon,
      description: t('nav.admin_collections_desc', 'Gruppera produkter (t.ex. per artist) för meny och startsida'),
    },
    {
      name: t('nav.admin_menu', 'Meny'),
      path: '/admin/menu',
      icon: ListBulletIcon,
      description: t('nav.admin_menu_desc', 'Bygg butikens toppmeny (samlingar, kategorier, sidor…)'),
    },
    {
      name: t('nav.admin_storefront', 'Butik'),
      path: '/admin/storefront',
      icon: BuildingStorefrontIcon,
      description: t('nav.admin_storefront_desc', 'Utseende och innehåll för din webbutik'),
    },
    // NOTE: "Marknadsföring" (marketing-materials uploads) moved OUT of the main
    // menu 2026-08-28 — it's an opt-in add-on now, rendered below the divider
    // and gated on `marketingMaterials` (see marketingNavItem).
    // 🛒 Google Shopping admin removed — Google Merchant feature cut (POD shops don't need it).
    {
      name: t('nav.admin_pages', 'Sidor'),
      path: '/admin/pages',
      icon: DocumentTextIcon,
      description: t('nav.admin_pages_desc', 'Hantera webbsidor och innehåll'),
    },
    // 🇸🇪 SE-ONLY LAUNCH: Translations admin hidden — single-language (Swedish)
    // for now. The runtime i18n engine stays active (Swedish via fallbacks).
    // Re-enable this menu item (and the route in App.jsx + the footer
    // LanguageCurrencySelector) to offer internationalization later.
    // {
    //   name: t('nav.admin_translations', 'Översättningar'),
    //   path: '/admin/translations',
    //   icon: LanguageIcon,
    //   description: t('nav.admin_translations_desc', 'Hantera språk och översättningar'),
    // },
    // NOTE: Affiliates moved OUT of the main menu — it's now an add-on, rendered
    // below the divider and gated on the `affiliate` feature flag (see the
    // add-on section in the nav). Settings stays last in the main menu.
    {
      name: t('nav.admin_payments', 'Utbetalningar'),
      path: '/admin/payments',
      icon: BanknotesIcon,
      description: t('nav.admin_payments_desc', 'Ta emot betalningar och utbetalningar'),
    },
    {
      name: t('nav.admin_dac7', 'Mina skatteuppgifter'),
      path: '/admin/skatteuppgifter',
      icon: DocumentTextIcon,
      description: t('nav.admin_dac7_desc', 'Dina rapporterade uppgifter (DAC7)'),
    },
    {
      name: t('nav.admin_settings', 'Inställningar'),
      path: '/admin/settings',
      icon: Cog6ToothIcon,
      description: t('nav.admin_settings_desc', 'Systeminställningar'),
    }
  ];

  // The native "Marknadsföringsmaterial" add-on link. OPT-IN key (only a
  // literal true enables it) — no platform-user bypass, entitlement is a
  // property of the shop. Same render pattern as affiliate below.
  const marketingEnabled = isAddonEnabled('marketingMaterials');
  const marketingNavItem = {
    name: t('nav.admin_marketing', 'Marknadsföring'),
    path: '/admin/marketing',
    icon: MegaphoneIcon,
    description: t('nav.admin_marketing_desc', 'Hantera marknadsföringsmaterial'),
  };
  // The native (non-wagon) "Affiliate" add-on link. Gated on the affiliate
  // feature flag at render time (menu gating only — storefront/checkout/function
  // enforcement is deferred to P4.5b). Rendered in the add-on section below the
  // divider, alongside the wagon add-on items.
  const affiliateEnabled = isAddonEnabled('affiliate');
  const affiliateNavItem = {
    name: t('nav.admin_affiliates', 'Affiliate'),
    path: '/admin/affiliates',
    icon: UsersIcon,
    description: t('nav.admin_affiliates_desc', 'Hantera affiliate-partners'),
  };
  // The native "B2B Grossist" add-on link (wholesale customers). Gated on the
  // b2b feature flag, same pattern as affiliate.
  const b2bEnabled = isAddonEnabled('b2b');
  const b2bNavItem = {
    name: t('nav.admin_b2b_customers', 'B2B-kunder'),
    path: '/admin/b2b-customers',
    icon: UsersIcon,
    description: t('nav.admin_b2b_customers_desc', 'Hantera grossistkunder'),
  };
  // The native "Rabattkoder" add-on link (campaign discount codes). Gated on the
  // discountCodes feature flag, same pattern as affiliate/b2b.
  const discountCodesEnabled = isAddonEnabled('discountCodes');
  const discountCodesNavItem = {
    name: t('nav.admin_discount_codes', 'Rabattkoder'),
    path: '/admin/discount-codes',
    icon: TagIcon,
    description: t('nav.admin_discount_codes_desc', 'Hantera kampanjkoder'),
  };
  // The native "Recensioner" add-on link (product reviews). Gated on the
  // productReviews feature flag, same pattern as discountCodes.
  const reviewsEnabled = isAddonEnabled('productReviews');
  const reviewsNavItem = {
    name: t('nav.admin_reviews', 'Recensioner'),
    path: '/admin/reviews',
    icon: StarIcon,
    description: t('nav.admin_reviews_desc', 'Moderera produktomdömen'),
  };
  // The "Innehållsstudio" add-on link (AI social-media studio). EXPLICIT
  // OPT-IN — but `contentStudio` is an OPT_IN_KEY in config/addons.js, so
  // isAddonEnabled already resolves it as `=== true`; the same one gate as
  // every other add-on above.
  //
  // The old `|| isPlatform` bypass is GONE (2026-08-27): a platform operator
  // is an admin of whichever shop they manage/impersonate, so the bypass made
  // the link show in EVERY shop for them — including shops with the feature
  // unchecked. Entitlement is a property of the shop, never of the viewer.
  const contentStudioEnabled = isAddonEnabled('contentStudio');
  const contentStudioNavItem = {
    name: t('nav.admin_content_studio', 'Innehållsstudio'),
    path: '/admin/content-studio',
    icon: SparklesIcon,
    description: t('nav.admin_content_studio_desc', 'AI-inlägg och video för sociala medier'),
  };
  // Whether the add-on section (divider + items) has anything to show.
  const hasAddonItems = affiliateEnabled || b2bEnabled || discountCodesEnabled || reviewsEnabled || contentStudioEnabled || marketingEnabled || wagonMenuItems.length > 0;
  
  const navItemClass = (active) =>
    `group flex h-8 items-center gap-2 rounded-[var(--radius-admin-el)] pl-2 pr-1.5 text-[13px] transition-colors ${
      active
        ? 'bg-black/[0.08] font-semibold text-admin-text dark:bg-white/10'
        : 'font-medium text-admin-text hover:bg-black/[0.06] dark:hover:bg-white/5'
    }`;
  const navIconClass = (active) =>
    `h-[18px] w-[18px] shrink-0 ${active ? 'text-admin-text' : 'text-admin-text-muted group-hover:text-admin-text'}`;

  const handleShopSwitch = () => {
    // A ?shopId= deep link has higher precedence than the remembered picker
    // choice. Clear both sources so switching always returns to the picker.
    setDeepLinkShopId(null);
    setLastPickedShopId(null);
  };

  // No shop resolved → make them choose. Rendered INSTEAD of the admin chrome:
  // with no tenant there is nothing meaningful in the nav, and every shop-scoped
  // query would read the sentinel.
  if (needsShopPick) {
    // Only a PLATFORM operator gets the picker (its shops LIST query is
    // platform-only in the rules). A non-platform admin can only land here with
    // broken data — the rules invariant says every shop admin's users doc
    // carries a shopId — so fail LOUD rather than let them pick a tenant they
    // don't administer (the silent-wrong-shop class this change exists to kill).
    if (!isPlatform) {
      return (
        <div className="grid min-h-screen place-items-center bg-admin-bg px-4">
          <div className="max-w-md rounded-[var(--radius-admin)] bg-admin-surface p-6 text-center ring-1 ring-admin-border">
            <h1 className="text-[16px] font-semibold text-admin-text">Ditt konto saknar en butik</h1>
            <p className="mt-2 text-[13px] text-admin-text-muted">
              Kontot är administratör men är inte kopplat till någon butik. Kontakta plattformsansvarig.
            </p>
            <button
              onClick={handleLogout}
              className="mt-4 text-[13px] text-admin-text-muted underline underline-offset-2 hover:text-admin-text"
            >
              Logga ut
            </button>
          </div>
        </div>
      );
    }
    return <ShopPicker onLogout={handleLogout} />;
  }

  return (
    <div className="min-h-screen bg-admin-bg text-admin-text [font-size:13px] [line-height:20px]">
      {/* ── Dark top command bar (Shopify chrome). Fixed, full-width, 56px. ── */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 bg-[var(--color-admin-topbar)] px-3">
        {/* left: mobile menu toggle + logo */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(true)}
            className="grid h-8 w-8 place-items-center rounded-[var(--radius-admin-el)] text-white/80 hover:bg-white/10 md:hidden"
            aria-label={t('nav.open_sidebar', 'Öppna meny')}
          >
            <Bars3Icon className="h-5 w-5" />
          </button>
          <Link to="/admin" className="flex items-center pl-1 pr-2">
            {store?.logoUrl && store.logoUrl !== '/images/logo.svg' ? (
              <img src={store.logoUrl} alt={shopName} className="h-6 w-auto brightness-0 invert" />
            ) : (
              <span className="text-[15px] font-semibold tracking-tight text-white">{shopName}</span>
            )}
          </Link>
        </div>

        {/* center: search pill */}
        <div className="flex flex-1 justify-center">
          <div className="flex h-8 w-full max-w-[480px] items-center gap-2 rounded-[var(--radius-admin-el)] bg-white/10 px-3 text-[13px] text-white/55">
            <svg className="h-4 w-4 text-white/55" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
            </svg>
            <span className="flex-1 text-left">{t('nav.search', 'Sök')}</span>
          </div>
        </div>

        {/* right: tools + store/avatar + logout */}
        <div className="flex items-center gap-1">
          {isAdmin && isAddonEnabled('dining') && (
            <div className="hidden text-white/80 sm:block">
              <MentionNotifications />
            </div>
          )}
          <DarkModeToggle />
          <LanguageSwitcher />
          {/* Store identity. For a PLATFORM operator it doubles as the shop
              switcher — clearing the remembered pick drops them back to the
              picker (impersonation keeps its own banner + exit, so it is left
              alone here). For a normal shop admin it stays a plain label: they
              have exactly one shop and nothing to switch to. */}
          {isPlatform && !getImpersonation() ? (
            <button
              onClick={handleShopSwitch}
              className="ml-1 flex items-center gap-2 rounded-[var(--radius-admin-el)] py-1 pl-2 pr-1 hover:bg-white/10"
              title={`${shopName} (${shopId}) — byt butik`}
            >
              <span className="hidden max-w-[180px] flex-col items-end leading-tight lg:flex">
                <span className="max-w-[180px] truncate text-[13px] font-medium text-white/90">{shopName}</span>
                <span className="max-w-[180px] truncate font-mono text-[10px] text-white/55">Byt butik</span>
              </span>
              <span className="grid h-6 w-6 place-items-center rounded-[6px] bg-[var(--color-admin-success-dot)] text-[11px] font-semibold text-white">
                {shopInitials}
              </span>
            </button>
          ) : (
            <div
              className="ml-1 flex items-center gap-2 rounded-[var(--radius-admin-el)] py-1 pl-2 pr-1"
              title={`${shopName} (${shopId})`}
            >
              <span className="hidden max-w-[180px] flex-col items-end leading-tight lg:flex">
                <span className="max-w-[180px] truncate text-[13px] font-medium text-white/90">{shopName}</span>
                <span className="max-w-[180px] truncate font-mono text-[10px] text-white/55">{shopId}</span>
              </span>
              <span className="grid h-6 w-6 place-items-center rounded-[6px] bg-[var(--color-admin-success-dot)] text-[11px] font-semibold text-white">
                {shopInitials}
              </span>
            </div>
          )}
          <button
            onClick={handleLogout}
            title={t('nav.logout', 'Logga ut')}
            className="grid h-8 w-8 place-items-center rounded-[var(--radius-admin-el)] text-white/70 hover:bg-white/10 hover:text-white"
          >
            <span className="sr-only">{t('nav.logout', 'Logga ut')}</span>
            <ArrowRightOnRectangleIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Single spacer that clears the fixed 56px top command bar. The
          impersonation banner (rendered here, null when no session) flows
          directly below it; <main> below has NO additional top padding so
          content starts flush under the bar (avoids a double-56px gap). */}
      <div className="pt-14">
        <ImpersonationBanner />
      </div>

      {/* ── Left nav (Polaris): fixed, 232px, on the canvas, below the top bar.
          During an impersonation session the amber banner (h-10, in flow above)
          also overlays the canvas, so the nav starts 40px lower — otherwise the
          banner covers the first nav item. Session changes end in a full reload
          (see ImpersonationBanner.endSession), so a mount-time check is safe. ── */}
      <nav className={`fixed bottom-0 left-0 ${getImpersonation() ? 'top-24' : 'top-14'} z-30 hidden w-[232px] flex-col bg-admin-bg px-3 py-3 md:flex`}>
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {adminNavLinks.map((item) => {
            const active = isActive(item.path);
            return (
              <Link key={item.name} to={item.path} title={item.description} className={navItemClass(active)}>
                <item.icon className={navIconClass(active)} aria-hidden="true" />
                <span className="flex-1">{item.name}</span>
              </Link>
            );
          })}

          {hasAddonItems && (
            <>
              {/* Thin divider separating the add-on items from the main menu. */}
              <div className="my-2 border-t border-admin-border-soft" />
              {affiliateEnabled && (
                <Link
                  to={affiliateNavItem.path}
                  title={affiliateNavItem.description}
                  className={navItemClass(isActive(affiliateNavItem.path))}
                >
                  <affiliateNavItem.icon className={navIconClass(isActive(affiliateNavItem.path))} aria-hidden="true" />
                  <span className="flex-1">{affiliateNavItem.name}</span>
                </Link>
              )}
              {marketingEnabled && (
                <Link
                  to={marketingNavItem.path}
                  title={marketingNavItem.description}
                  className={navItemClass(isActive(marketingNavItem.path))}
                >
                  <marketingNavItem.icon className={navIconClass(isActive(marketingNavItem.path))} aria-hidden="true" />
                  <span className="flex-1">{marketingNavItem.name}</span>
                </Link>
              )}
              {b2bEnabled && (
                <Link
                  to={b2bNavItem.path}
                  title={b2bNavItem.description}
                  className={navItemClass(isActive(b2bNavItem.path))}
                >
                  <b2bNavItem.icon className={navIconClass(isActive(b2bNavItem.path))} aria-hidden="true" />
                  <span className="flex-1">{b2bNavItem.name}</span>
                </Link>
              )}
              {discountCodesEnabled && (
                <Link
                  to={discountCodesNavItem.path}
                  title={discountCodesNavItem.description}
                  className={navItemClass(isActive(discountCodesNavItem.path))}
                >
                  <discountCodesNavItem.icon className={navIconClass(isActive(discountCodesNavItem.path))} aria-hidden="true" />
                  <span className="flex-1">{discountCodesNavItem.name}</span>
                </Link>
              )}
              {reviewsEnabled && (
                <Link
                  to={reviewsNavItem.path}
                  title={reviewsNavItem.description}
                  className={navItemClass(isActive(reviewsNavItem.path))}
                >
                  <reviewsNavItem.icon className={navIconClass(isActive(reviewsNavItem.path))} aria-hidden="true" />
                  <span className="flex-1">{reviewsNavItem.name}</span>
                </Link>
              )}
              {contentStudioEnabled && (
                <Link
                  to={contentStudioNavItem.path}
                  title={contentStudioNavItem.description}
                  className={navItemClass(isActive(contentStudioNavItem.path))}
                >
                  <contentStudioNavItem.icon className={navIconClass(isActive(contentStudioNavItem.path))} aria-hidden="true" />
                  <span className="flex-1">{contentStudioNavItem.name}</span>
                </Link>
              )}
              {wagonMenuItems.map((item) => {
                const active = isActive(item.path);
                return (
                  <Link key={`wagon-${item.wagonId}`} to={item.path} title={item.description} className={navItemClass(active)}>
                    <SparklesIcon className={navIconClass(active)} aria-hidden="true" />
                    <span className="flex-1">{item.title}</span>
                  </Link>
                );
              })}
            </>
          )}
        </div>
      </nav>

      {/* ── Mobile slide-over menu ── */}
      {isMobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex text-[13px] md:hidden">
          <div className="fixed inset-0 bg-black/40" aria-hidden="true" onClick={() => setIsMobileMenuOpen(false)} />
          <div className="relative flex w-full max-w-xs flex-1 flex-col bg-admin-bg pb-4 pt-4">
            <div className="absolute right-0 top-0 -mr-12 pt-2">
              <button
                type="button"
                className="ml-1 flex h-10 w-10 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <span className="sr-only">{t('nav.close_sidebar', 'Stäng meny')}</span>
                <XMarkIcon className="h-6 w-6 text-white" aria-hidden="true" />
              </button>
            </div>
            <div className="flex shrink-0 items-center px-4 pb-2">
              <Link to="/admin" onClick={() => setIsMobileMenuOpen(false)}>
                {store?.logoUrl && store.logoUrl !== '/images/logo.svg' ? (
                  <img src={store.logoUrl} alt={shopName} className="h-7 w-auto" />
                ) : (
                  <span className="text-[15px] font-semibold tracking-tight text-admin-text">{shopName}</span>
                )}
              </Link>
            </div>
            <div className="mt-2 h-0 flex-1 overflow-y-auto px-3">
              <nav className="space-y-0.5">
                {adminNavLinks.map((item) => {
                  const active = isActive(item.path);
                  return (
                    <Link
                      key={item.name}
                      to={item.path}
                      onClick={() => setIsMobileMenuOpen(false)}
                      className={`group flex h-10 items-center gap-2 rounded-[var(--radius-admin-el)] pl-2 pr-1.5 text-[13px] ${
                        active ? 'bg-black/[0.08] font-semibold text-admin-text' : 'font-medium text-admin-text hover:bg-black/[0.06]'
                      }`}
                    >
                      <item.icon className={navIconClass(active)} aria-hidden="true" />
                      <span className="flex-1">{item.name}</span>
                    </Link>
                  );
                })}
                {hasAddonItems && (
                  <>
                    {/* Thin divider separating the add-on items from the main menu. */}
                    <div className="my-2 border-t border-admin-border-soft" />
                    {affiliateEnabled && (
                      <Link
                        to={affiliateNavItem.path}
                        onClick={() => setIsMobileMenuOpen(false)}
                        className={`group flex h-10 items-center gap-2 rounded-[var(--radius-admin-el)] pl-2 pr-1.5 text-[13px] ${
                          isActive(affiliateNavItem.path) ? 'bg-black/[0.08] font-semibold text-admin-text' : 'font-medium text-admin-text hover:bg-black/[0.06]'
                        }`}
                      >
                        <affiliateNavItem.icon className={navIconClass(isActive(affiliateNavItem.path))} aria-hidden="true" />
                        <span className="flex-1">{affiliateNavItem.name}</span>
                      </Link>
                    )}
                    {marketingEnabled && (
                      <Link
                        to={marketingNavItem.path}
                        onClick={() => setIsMobileMenuOpen(false)}
                        className={`group flex h-10 items-center gap-2 rounded-[var(--radius-admin-el)] pl-2 pr-1.5 text-[13px] ${
                          isActive(marketingNavItem.path) ? 'bg-black/[0.08] font-semibold text-admin-text' : 'font-medium text-admin-text hover:bg-black/[0.06]'
                        }`}
                      >
                        <marketingNavItem.icon className={navIconClass(isActive(marketingNavItem.path))} aria-hidden="true" />
                        <span className="flex-1">{marketingNavItem.name}</span>
                      </Link>
                    )}
                    {b2bEnabled && (
                      <Link
                        to={b2bNavItem.path}
                        onClick={() => setIsMobileMenuOpen(false)}
                        className={`group flex h-10 items-center gap-2 rounded-[var(--radius-admin-el)] pl-2 pr-1.5 text-[13px] ${
                          isActive(b2bNavItem.path) ? 'bg-black/[0.08] font-semibold text-admin-text' : 'font-medium text-admin-text hover:bg-black/[0.06]'
                        }`}
                      >
                        <b2bNavItem.icon className={navIconClass(isActive(b2bNavItem.path))} aria-hidden="true" />
                        <span className="flex-1">{b2bNavItem.name}</span>
                      </Link>
                    )}
                    {discountCodesEnabled && (
                      <Link
                        to={discountCodesNavItem.path}
                        onClick={() => setIsMobileMenuOpen(false)}
                        className={`group flex h-10 items-center gap-2 rounded-[var(--radius-admin-el)] pl-2 pr-1.5 text-[13px] ${
                          isActive(discountCodesNavItem.path) ? 'bg-black/[0.08] font-semibold text-admin-text' : 'font-medium text-admin-text hover:bg-black/[0.06]'
                        }`}
                      >
                        <discountCodesNavItem.icon className={navIconClass(isActive(discountCodesNavItem.path))} aria-hidden="true" />
                        <span className="flex-1">{discountCodesNavItem.name}</span>
                      </Link>
                    )}
                    {reviewsEnabled && (
                      <Link
                        to={reviewsNavItem.path}
                        onClick={() => setIsMobileMenuOpen(false)}
                        className={`group flex h-10 items-center gap-2 rounded-[var(--radius-admin-el)] pl-2 pr-1.5 text-[13px] ${
                          isActive(reviewsNavItem.path) ? 'bg-black/[0.08] font-semibold text-admin-text' : 'font-medium text-admin-text hover:bg-black/[0.06]'
                        }`}
                      >
                        <reviewsNavItem.icon className={navIconClass(isActive(reviewsNavItem.path))} aria-hidden="true" />
                        <span className="flex-1">{reviewsNavItem.name}</span>
                      </Link>
                    )}
                    {contentStudioEnabled && (
                      <Link
                        to={contentStudioNavItem.path}
                        onClick={() => setIsMobileMenuOpen(false)}
                        className={`group flex h-10 items-center gap-2 rounded-[var(--radius-admin-el)] pl-2 pr-1.5 text-[13px] ${
                          isActive(contentStudioNavItem.path) ? 'bg-black/[0.08] font-semibold text-admin-text' : 'font-medium text-admin-text hover:bg-black/[0.06]'
                        }`}
                      >
                        <contentStudioNavItem.icon className={navIconClass(isActive(contentStudioNavItem.path))} aria-hidden="true" />
                        <span className="flex-1">{contentStudioNavItem.name}</span>
                      </Link>
                    )}
                    {wagonMenuItems.map((item) => {
                      const active = isActive(item.path);
                      return (
                        <Link
                          key={`wagon-${item.wagonId}`}
                          to={item.path}
                          onClick={() => setIsMobileMenuOpen(false)}
                          className={`group flex h-10 items-center gap-2 rounded-[var(--radius-admin-el)] pl-2 pr-1.5 text-[13px] ${
                            active ? 'bg-black/[0.08] font-semibold text-admin-text' : 'font-medium text-admin-text hover:bg-black/[0.06]'
                          }`}
                        >
                          <SparklesIcon className={navIconClass(active)} aria-hidden="true" />
                          <span className="flex-1">{item.title}</span>
                        </Link>
                      );
                    })}
                  </>
                )}
              </nav>
            </div>
          </div>
          <div className="w-14 shrink-0" aria-hidden="true" />
        </div>
      )}

      {/* ── Main content: top clearance comes from the banner-wrapper spacer
          above (single pt-14); here we only offset for the fixed nav. ── */}
      <main className="md:pl-[232px]">
        <div className="mx-auto max-w-[1200px] px-4 py-4 sm:px-6">{children}</div>
      </main>
    </div>
  );
};

export default AppLayout;
