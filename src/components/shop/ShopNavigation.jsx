import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useCart } from '../../contexts/CartContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowRightOnRectangleIcon,
  ShoppingBagIcon,
  MagnifyingGlassIcon,
  UserIcon,
  ChevronDownIcon,
  Bars3Icon,
  XMarkIcon
} from '@heroicons/react/24/outline';
import { useSimpleAuth } from '../../contexts/SimpleAuthContext';
import { db } from '../../firebase/config';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { getCountryAwareUrl, getCategoryUrl, buildMenuHref, isExternalMenuItem } from '../../utils/productUrls';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';
import { useShopId } from '../../contexts/ShopContext';
import { useShopFeatures } from '../../contexts/ShopFeaturesContext';

// tags / activeTag / onSelectTag are optional — only the storefront home passes
// them, to render tag links that filter the product grid. Other pages omit them.
const ShopNavigation = ({ breadcrumb, breadcrumbCategory = null, tags = [], activeTag = null, onSelectTag }) => {
  const { cart } = useCart();
  const { t } = useTranslation();
  const store = useStoreSettings();
  const shopId = useShopId();
  const { isEnabled: isAddonEnabled } = useShopFeatures();
  const affiliateEnabled = isAddonEnabled('affiliate');
  const navigate = useNavigate();
  const location = useLocation();
  const { currentUser, logout } = useSimpleAuth();
  const [affiliateData, setAffiliateData] = useState(null);
  const [showLoginDropdown, setShowLoginDropdown] = useState(false);
  
  // Calculate total items in cart
  const cartItemCount = cart.items.reduce((total, item) => total + item.quantity, 0);

  // Curated top menu (admin-built via /admin/menu → storeIdentity.menu). When the
  // shop has configured one, it REPLACES the auto-category/tag nav on every page.
  // Guard on length > 0 (StoreSettingsContext keeps empty arrays), so shops with
  // no menu fall back to today's behavior — zero regression.
  const curatedMenu = Array.isArray(store.menu) ? store.menu.filter((m) => m && m.label) : [];
  const hasCuratedMenu = curatedMenu.length > 0;
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  // Unified list of {label, href, external} for the MOBILE dropdown. Curated menu
  // wins; otherwise fall back to the category links (from the `tags` prop the home
  // page passes). Always leads with Hem + Alla produkter so mobile users have a
  // baseline nav on every page even when no menu/categories exist.
  const mobileItems = hasCuratedMenu
    ? curatedMenu.map((item) => ({ label: item.label, href: buildMenuHref(item), external: isExternalMenuItem(item) }))
    : [
        { label: t('nav_home', 'Hem'), href: getCountryAwareUrl(''), external: false },
        { label: t('nav_all', 'Alla'), href: getCountryAwareUrl('produkter'), external: false },
        ...tags.map((tag) => ({ label: tag, href: getCategoryUrl(tag), external: false })),
      ];

  useEffect(() => {
    const fetchAffiliateData = async () => {
      // Affiliate add-on off → no affiliate portal display, skip the query.
      if (!affiliateEnabled || !currentUser?.email) {
        setAffiliateData(null);
        return;
      }
      try {
        const affiliatesRef = collection(db, 'affiliates');
            const affiliateQuery = query(affiliatesRef, where('shopId', '==', shopId), where('email', '==', currentUser.email), where('status', '==', 'active'));
    const querySnapshot = await getDocs(affiliateQuery);
        if (!querySnapshot.empty) {
          setAffiliateData(querySnapshot.docs[0].data());
        } else {
          setAffiliateData(null);
        }
      } catch {
        setAffiliateData(null);
      }
    };
    fetchAffiliateData();
  }, [currentUser, shopId, affiliateEnabled]);

  const handleAffiliateLogout = async () => {
    await logout();
    navigate(getCountryAwareUrl(''));
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!event.target.closest('.login-dropdown')) {
        setShowLoginDropdown(false);
      }
      if (!event.target.closest('.mobile-menu')) {
        setShowMobileMenu(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  // Close the mobile menu whenever the route changes — covers navigations that
  // don't go through a menu <Link> (back button, logo, cart, programmatic).
  useEffect(() => {
    setShowMobileMenu(false);
  }, [location.pathname]);

  return (
    <nav className="bg-canvas/85 backdrop-blur-md sticky top-0 z-50 font-body">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center gap-1">
            {/* Mobile hamburger — opens the nav dropdown (curated menu or
                categories). Hidden on desktop where the center nav shows. */}
            <button
              type="button"
              onClick={() => setShowMobileMenu((v) => !v)}
              className="md:hidden p-2 -ml-2 text-ink/70 hover:text-ink transition-colors mobile-menu"
              aria-label={t('nav_menu', 'Meny')}
              aria-expanded={showMobileMenu}
            >
              {showMobileMenu ? <XMarkIcon className="h-6 w-6" /> : <Bars3Icon className="h-6 w-6" />}
            </button>
            <Link to={getCountryAwareUrl('')} className="flex items-center">
              <img src={store.logoUrl} alt={store.shopName} className="h-8 w-auto" />
            </Link>
          </div>

          {/* Center: curated menu (admin-built) takes priority on EVERY page.
              Else tag links (storefront home) OR breadcrumb. */}
          {hasCuratedMenu ? (
            <div className="hidden md:flex items-center gap-1 text-sm overflow-x-auto">
              {curatedMenu.map((item, i) => {
                const href = buildMenuHref(item);
                return isExternalMenuItem(item) ? (
                  <a
                    key={i}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-full font-medium whitespace-nowrap text-ink-muted hover:text-ink transition-colors"
                  >
                    {item.label}
                  </a>
                ) : (
                  <Link
                    key={i}
                    to={href}
                    className="px-3 py-1.5 rounded-full font-medium whitespace-nowrap text-ink-muted hover:text-ink transition-colors"
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ) : tags.length > 0 && onSelectTag ? (
            <div className="hidden md:flex items-center gap-1 text-sm overflow-x-auto">
              <button
                onClick={() => onSelectTag(null)}
                className={`px-3 py-1.5 rounded-full font-medium whitespace-nowrap transition-colors ${!activeTag ? 'text-accent' : 'text-ink-muted hover:text-ink'}`}
              >
                {t('nav_all', 'Alla')}
              </button>
              {tags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => onSelectTag(tag)}
                  className={`px-3 py-1.5 rounded-full font-medium whitespace-nowrap transition-colors ${activeTag === tag ? 'text-accent' : 'text-ink-muted hover:text-ink'}`}
                >
                  {tag}
                </button>
              ))}
            </div>
          ) : (
            <div className="hidden md:flex items-center space-x-2 text-sm text-ink-muted">
              <Link to={getCountryAwareUrl('')} className="hover:text-ink transition-colors">
                {t('nav_home', 'Hem')}
              </Link>
              {/* Category segment — linked to its browse page. Shown when set. */}
              {breadcrumbCategory && (
                <>
                  <span>/</span>
                  <Link to={getCategoryUrl(breadcrumbCategory)} className="hover:text-ink transition-colors">
                    {breadcrumbCategory}
                  </Link>
                </>
              )}
              {breadcrumb && (
                <>
                  <span>/</span>
                  <span className="text-ink font-medium">{breadcrumb}</span>
                </>
              )}
            </div>
          )}
          
          {/* Right side icons */}
          <div className="flex items-center space-x-4">
            {/* Search Icon - Placeholder for future implementation */}
            <button 
              className="p-2 text-ink/70 hover:text-ink transition-colors"
              title={t('nav_search', 'Sök')}
              onClick={() => {
                // TODO: Implement search functionality
                toast.success(t('search_coming_soon', 'Sökfunktion kommer snart!'));
              }}
            >
              <MagnifyingGlassIcon className="h-6 w-6" />
            </button>

            {/* Smart User Profile Section */}
            {currentUser ? (
              <div className="flex items-center space-x-2">
                {/* User Account Link */}
                <Link 
                  to={affiliateData ? getCountryAwareUrl('affiliate-portal') : getCountryAwareUrl('account')}
                  className="p-2 text-ink/70 hover:text-ink transition-colors"
                  title={affiliateData ? t('nav_affiliate_portal', 'Affiliate Portal') : t('nav_my_account', 'Mitt konto')}
                >
                  <UserIcon className="h-6 w-6" />
                </Link>

                {/* User Name Display */}
                <div className="flex items-center space-x-2">
                  <span className="hidden sm:inline text-sm text-ink-muted max-w-[120px] truncate">
                    {affiliateData ? affiliateData.name : (currentUser.displayName || currentUser.email?.split('@')[0])}
                  </span>
                  <span className="sm:hidden text-xs text-ink-muted max-w-[60px] truncate">
                    {affiliateData ? affiliateData.name : (currentUser.displayName || currentUser.email?.split('@')[0])}
                  </span>
                  
                  {/* Status Indicators */}
                  {affiliateData && (
                    <span className="text-green-500 text-xs">●</span>
                  )}
                </div>

                {/* Logout Button */}
                <button
                  onClick={affiliateData ? handleAffiliateLogout : () => {
                    logout();
                    navigate(getCountryAwareUrl(''));
                  }}
                  className="p-1 text-gray-500 hover:text-red-600 transition-colors"
                  title={t('nav_logout', 'Logga ut')}
                >
                  <ArrowRightOnRectangleIcon className="h-5 w-5" />
                </button>
              </div>
            ) : (
              /* Smart Login Dropdown for Non-authenticated Users */
              <div className="relative login-dropdown">
                <button
                  onClick={() => setShowLoginDropdown(!showLoginDropdown)}
                  onMouseEnter={() => setShowLoginDropdown(true)}
                  className="flex items-center p-2 text-ink/70 hover:text-ink transition-colors"
                  title={t('nav_login', 'Logga in')}
                >
                  <UserIcon className="h-6 w-6" />
                  <ChevronDownIcon className="h-3 w-3 ml-1 hidden sm:block" />
                </button>

                {/* Login Dropdown Menu */}
                {showLoginDropdown && (
                  <div 
                    className="absolute right-0 mt-2 w-48 bg-white rounded-el shadow-lift z-50"
                    onMouseLeave={() => setShowLoginDropdown(false)}
                  >
                    <div className="py-2">
                      <Link
                        to="/login"
                        className="flex items-center px-4 py-2 text-sm text-ink hover:bg-canvas hover:text-accent transition-colors"
                        onClick={() => setShowLoginDropdown(false)}
                      >
                        <UserIcon className="h-4 w-4 mr-3" />
                        {t('nav_login_customer', 'Logga in som kund')}
                      </Link>
                      
                      {affiliateEnabled && (
                      <Link
                        to="/affiliate-login"
                        className="flex items-center px-4 py-2 text-sm text-ink hover:bg-canvas hover:text-accent transition-colors"
                        onClick={() => setShowLoginDropdown(false)}
                      >
                        <div className="h-4 w-4 mr-3 flex items-center justify-center">
                          <span className="text-green-500 text-xs">●</span>
                        </div>
                        {t('nav_login_affiliate', 'Logga in som affiliate')}
                      </Link>
                      )}
                    </div>
                    
                    {/* Footer with registration links */}
                    <div className="border-t border-gray-100 py-2">
                      <Link
                        to="/register"
                        className="block px-4 py-2 text-xs text-ink-muted hover:text-accent transition-colors"
                        onClick={() => setShowLoginDropdown(false)}
                      >
                        {t('nav_register_customer', 'Skapa kundkonto')}
                      </Link>
                      {affiliateEnabled && (
                      <Link
                        to={getCountryAwareUrl('affiliate-registration')}
                        className="block px-4 py-2 text-xs text-ink-muted hover:text-accent transition-colors"
                        onClick={() => setShowLoginDropdown(false)}
                      >
                        {t('nav_register_affiliate', 'Ansök som affiliate')}
                      </Link>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Shopping Cart Icon */}
            <Link 
              to={getCountryAwareUrl('cart')} 
              className="flex items-center gap-2 bg-ink text-white rounded-full py-2 pl-3.5 pr-3.5 hover:opacity-90 transition-opacity"
              title={t('nav_cart', 'Varukorg')}
            >
              <ShoppingBagIcon className="h-5 w-5" />
              {cartItemCount > 0 && (
                // key={count} remounts the badge on every change so the pop
                // keyframe replays — the nav-side confirmation of add-to-cart.
                <span
                  key={cartItemCount}
                  className="bg-accent text-white text-xs rounded-full h-5 min-w-5 px-1.5 -mr-1.5 flex items-center justify-center font-bold tabular-nums animate-badge-pop"
                >
                  {cartItemCount}
                </span>
              )}
            </Link>
          </div>
        </div>
      </div>

      {/* Mobile menu dropdown — the curated menu (or category fallback) as a
          vertical list. Only rendered on small screens (the button is md:hidden). */}
      {showMobileMenu && (
        <div className="md:hidden border-t border-ink/10 bg-canvas mobile-menu animate-fade-down">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2">
            {mobileItems.map((mi, i) =>
              mi.external ? (
                <a
                  key={i}
                  href={mi.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setShowMobileMenu(false)}
                  className="block py-2.5 text-sm font-medium text-ink-muted hover:text-ink transition-colors"
                >
                  {mi.label}
                </a>
              ) : (
                <Link
                  key={i}
                  to={mi.href}
                  onClick={() => setShowMobileMenu(false)}
                  className="block py-2.5 text-sm font-medium text-ink-muted hover:text-ink transition-colors"
                >
                  {mi.label}
                </Link>
              )
            )}
          </div>
        </div>
      )}
    </nav>
  );
};

export default ShopNavigation; 