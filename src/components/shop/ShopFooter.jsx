import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getCountryAwareUrl } from '../../utils/productUrls';
import { useTranslation } from '../../contexts/TranslationContext';
import { useSimpleAuth } from '../../contexts/SimpleAuthContext';
import { db } from '../../firebase/config';
import { collection, query, where, getDocs } from 'firebase/firestore';
// 🇸🇪 SE-ONLY LAUNCH: hidden with its usage below. Re-enable for internationalization.
// import LanguageCurrencySelector from './LanguageCurrencySelector';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';
import { useShopId } from '../../contexts/ShopContext';
import { useShopFeatures } from '../../contexts/ShopFeaturesContext';
import DOMPurify from 'dompurify';
import { PLATFORM_TERMS_SLUG } from '../../config/legalTemplates';

// Generic platform icons (brand-neutral logos). A link renders only when the
// matching URL is set in store.social, so the set adapts per shop.
const SOCIAL_LINKS = [
  { key: 'facebook', title: 'Facebook', hover: 'hover:bg-blue-600', path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
  { key: 'instagram', title: 'Instagram', hover: 'hover:bg-pink-600', path: 'M12.017 0C8.396 0 7.989.013 7.041.048 6.094.082 5.52.204 5.015.388a6.5 6.5 0 0 0-2.346 1.527A6.5 6.5 0 0 0 1.142 4.26c-.184.505-.306 1.08-.34 2.027C.768 7.235.756 7.642.756 11.263c0 3.621.012 4.028.047 4.975.034.947.156 1.522.34 2.027a6.5 6.5 0 0 0 1.527 2.346 6.5 6.5 0 0 0 2.346 1.527c.505.184 1.08.306 2.027.34.947.035 1.354.047 4.975.047 3.621 0 4.028-.012 4.975-.047.947-.034 1.522-.156 2.027-.34a6.5 6.5 0 0 0 2.346-1.527 6.5 6.5 0 0 0 1.527-2.346c.184-.505.306-1.08.34-2.027.035-.947.047-1.354.047-4.975 0-3.621-.012-4.028-.047-4.975-.034-.947-.156-1.522-.34-2.027a6.5 6.5 0 0 0-1.527-2.346A6.5 6.5 0 0 0 16.982.388C16.477.204 15.902.082 14.955.048 14.009.013 13.602.001 9.981.001h2.036zm-.024 5.924a6.16 6.16 0 1 1 0 12.32 6.16 6.16 0 0 1 0-12.32zm0 10.163a4.002 4.002 0 1 0 0-8.005 4.002 4.002 0 0 0 0 8.005zm7.846-10.405a1.441 1.441 0 1 1-2.883 0 1.441 1.441 0 0 1 2.883 0z' },
  { key: 'youtube', title: 'YouTube', hover: 'hover:bg-red-600', path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
  { key: 'tiktok', title: 'TikTok', hover: 'hover:bg-black', path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
  { key: 'pinterest', title: 'Pinterest', hover: 'hover:bg-red-700', path: 'M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.174-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.097.118.112.221.085.342-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.402.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.357-.629-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24.009 12.017 24.009c6.624 0 11.99-5.367 11.99-11.988C24.007 5.367 18.641.001.017 0z' },
  { key: 'linkedin', title: 'LinkedIn', hover: 'hover:bg-blue-700', path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
  { key: 'website', title: 'Website', hover: 'hover:bg-gray-600', path: 'M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm6.93 6h-2.95a15.7 15.7 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.92 6zM12 2.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM2.26 14a7.96 7.96 0 0 1 0-4h3.38a16.6 16.6 0 0 0 0 4H2.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A8.03 8.03 0 0 1 3.08 16zm2.95-8H3.08a8.03 8.03 0 0 1 4.33-3.56A15.7 15.7 0 0 0 6.03 8zM12 21.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 16H9.66a14.6 14.6 0 0 1 0-4h4.68a14.6 14.6 0 0 1 0 4zm.25 3.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM18.36 14a16.6 16.6 0 0 0 0-4h3.38a7.96 7.96 0 0 1 0 4h-3.38z' },
];

const ShopFooter = () => {
  const { t } = useTranslation();
  const { currentUser } = useSimpleAuth();
  const store = useStoreSettings();
  const shopId = useShopId();
  const { isEnabled: isAddonEnabled } = useShopFeatures();
  const affiliateEnabled = isAddonEnabled('affiliate');
  const [isActiveAffiliate, setIsActiveAffiliate] = useState(false);
  const [affiliateCheckLoading, setAffiliateCheckLoading] = useState(false);
  const [cmsPages, setCmsPages] = useState([]);
  const currentYear = new Date().getFullYear();

  // Published CMS pages (Kontakta oss, FAQ, etc.) → footer links. Auto-listed:
  // publish a page in admin and it appears here. ponytail: no per-link curation —
  // control the footer by controlling what you publish.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'pages'),
          where('shopId', '==', shopId),
          where('status', '==', 'published')
        ));
        if (cancelled) return;
        const pageTitle = (tt) => (typeof tt === 'string' ? tt : (tt?.['sv-SE'] || Object.values(tt || {}).find((v) => typeof v === 'string') || ''));
        setCmsPages(
          snap.docs
            .map((d) => ({ slug: d.data().slug, title: pageTitle(d.data().title) }))
            .filter((p) => p.slug && p.title)
            .sort((a, b) => a.title.localeCompare(b.title, 'sv'))
        );
      } catch (e) {
        console.error('ShopFooter: could not load CMS pages:', e?.message);
        if (!cancelled) setCmsPages([]);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  // Check if current user is an active affiliate
  useEffect(() => {
    const checkAffiliateStatus = async () => {
      // Affiliate add-on off → skip the check (links hidden anyway).
      if (!affiliateEnabled || !currentUser?.email) {
        setIsActiveAffiliate(false);
        return;
      }

      try {
        setAffiliateCheckLoading(true);
        const affiliatesRef = collection(db, 'affiliates');
        const affiliateQuery = query(
          affiliatesRef,
          where('shopId', '==', shopId),
          where('email', '==', currentUser.email),
          where('status', '==', 'active')
        );
        const querySnapshot = await getDocs(affiliateQuery);
        setIsActiveAffiliate(!querySnapshot.empty);
      } catch (error) {
        console.error('Error checking affiliate status:', error);
        setIsActiveAffiliate(false);
      } finally {
        setAffiliateCheckLoading(false);
      }
    };

    checkAffiliateStatus();
  }, [currentUser, shopId, affiliateEnabled]);

  return (
    <footer className="bg-ink text-white font-body">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          
          {/* Company Info */}
          <div>
            <h3 className="font-display text-lg font-bold mb-4 tracking-tight">{store.shopName}</h3>
            {store.companyDescription && (
              <p className="text-white/70 text-sm mb-4 leading-relaxed">
                {store.companyDescription}
              </p>
            )}
            {store.address && (
              <div className="text-white/50 text-sm" dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(store.address || '')
              }} />
            )}
          </div>

          {/* Quick Links */}
          <div>
            <h3 className="font-display text-lg font-bold mb-4 tracking-tight">{t('footer_quick_links', 'Snabblänkar')}</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link to={getCountryAwareUrl('')} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_home', 'Hem')}
                </Link>
              </li>
              <li>
                <Link to={getCountryAwareUrl('produkter')} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_all_products', 'Alla produkter')}
                </Link>
              </li>
              <li>
                <Link to={getCountryAwareUrl('cart')} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_cart', 'Varukorg')}
                </Link>
              </li>
              <li>
                <Link to={getCountryAwareUrl('account')} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_my_account', 'Mitt konto')}
                </Link>
              </li>
              <li>
                <a href={`mailto:${store.supportEmail}`} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_contact', 'Kontakt')}
                </a>
              </li>
            </ul>
          </div>

          {/* Customer Service */}
          <div>
            <h3 className="font-display text-lg font-bold mb-4 tracking-tight">{t('footer_customer_service', 'Kundservice & Info')}</h3>
            <ul className="space-y-2 text-sm">
              {/* Published CMS pages (Kontakta oss, FAQ, …) — auto-listed. */}
              {cmsPages.map((p) => (
                <li key={p.slug}>
                  <Link to={getCountryAwareUrl(p.slug)} className="text-white/70 hover:text-white transition-colors">
                    {p.title}
                  </Link>
                </li>
              ))}
              {/* NOTE: no Leveransinformation link — there is no such route, and
                  the old ShippingInfo page was hardcoded to another company's
                  details. Delivery terms live in köpvillkor §5; a shop that wants
                  a dedicated page can create a CMS page and link it via nav. */}
              <li>
                <Link to={getCountryAwareUrl('legal/angerratt-och-returer')} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_returns', 'Returer & Ångerrätt')}
                </Link>
              </li>
              <li>
                {/* Ångerfunktionen — statutory label "ångra avtalet här" (DAL
                    2 kap. 10 a §); footer link = available on every page,
                    throughout the whole frist. */}
                <Link to={getCountryAwareUrl('angra')} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_withdraw_here', 'Ångra avtalet här')}
                </Link>
              </li>
              {affiliateEnabled && (
              <li>
                <Link to={getCountryAwareUrl('affiliate-registration')} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_become_affiliate', 'Bli en affiliate')}
                </Link>
              </li>
              )}
              {affiliateEnabled && (
              <li>
                <Link
                  to={getCountryAwareUrl(isActiveAffiliate ? 'affiliate-portal' : 'affiliate-login')}
                  className="text-white/70 hover:text-white transition-colors flex items-center"
                >
                  {affiliateCheckLoading ? (
                    <>
                      <span className="animate-spin rounded-full h-3 w-3 border border-white/40 border-t-transparent mr-2"></span>
                      {t('footer_affiliate_checking', 'Kontrollerar...')}
                    </>
                  ) : (
                    <>
                      {isActiveAffiliate ?
                        t('footer_affiliate_portal', 'Affiliate-portal') :
                        t('footer_affiliate_login', 'Affiliate-inloggning')
                      }
                      {isActiveAffiliate && (
                        <span className="ml-2 text-green-400 text-xs">●</span>
                      )}
                    </>
                  )}
                </Link>
              </li>
              )}
              <li>
                <a href={`mailto:${store.supportEmail}`} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_customer_support', 'Kundtjänst')}
                </a>
              </li>
              <li>
                <span className="text-white/50">
                  {t('footer_business_hours', 'Mån-Fre: 09:00-17:00')}
                </span>
              </li>
            </ul>
          </div>

          {/* Legal & Compliance — the three auto-generated per-shop legal pages
              (köpvillkor, ångerrätt & returer, integritetspolicy) + cookie-policy.
              Slugs MUST match src/config/legalTemplates.js LEGAL_SLUGS. */}
          <div>
            <h3 className="font-display text-lg font-bold mb-4 tracking-tight">{t('footer_legal', 'Juridiskt')}</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link to={getCountryAwareUrl('legal/kopvillkor')} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_terms_of_sale', 'Köpvillkor')}
                </Link>
              </li>
              <li>
                <Link to={getCountryAwareUrl('legal/angerratt-och-returer')} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_withdrawal_returns', 'Ångerrätt & returer')}
                </Link>
              </li>
              <li>
                <Link to={getCountryAwareUrl('legal/integritetspolicy')} className="text-white/70 hover:text-white transition-colors">
                  {t('footer_privacy', 'Integritetspolicy')}
                </Link>
              </li>
              {/* Cookie info lives in the privacy policy (§9) + the Cookiebot CMP;
                  no separate auto-page yet, so no standalone link (avoids a dead link). */}
            </ul>
          </div>
        </div>

        {/* Bottom Section */}
        {/* Social Media Follow Section — driven by store.social; only configured links show */}
        {SOCIAL_LINKS.some(s => store.social?.[s.key]) && (
          <div className="border-t border-white/10 mt-8 pt-8">
            <div className="flex flex-col items-center gap-6 mb-8">
              <h3 className="font-display text-lg font-bold text-white tracking-tight">
                {`${t('footer_follow_us_prefix', 'Följ')} ${store.shopName}`}
              </h3>
              <div className="flex items-center gap-4 flex-wrap justify-center">
                {SOCIAL_LINKS.filter(s => store.social?.[s.key]).map(s => (
                  <a
                    key={s.key}
                    href={store.social[s.key]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`w-10 h-10 flex items-center justify-center bg-white/10 ${s.hover} rounded-full transition-colors`}
                    title={s.title}
                  >
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d={s.path} />
                    </svg>
                  </a>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-white/10 pt-8">
          <div className="flex flex-col lg:flex-row justify-between items-center gap-4">
            <div className="text-white/50 text-sm">
              <p>{`© ${currentYear} ${store.legalName}. `}{t('footer_rights_reserved', 'Alla rättigheter förbehållna.')}</p>
              {/* Platform/seller split, visible to the buyer: the shop above is
                  the counterparty of the purchase; the platform only provides
                  the service it runs on. */}
              <p className="text-white/40 mt-1">
                {t('footer_powered_by', 'Drivs av ChopShop')}{' · '}
                <Link to={getCountryAwareUrl(PLATFORM_TERMS_SLUG)} className="text-white/40 hover:text-white/70 transition-colors underline">
                  {t('footer_platform_terms', 'Plattformsvillkor')}
                </Link>
              </p>
            </div>
            
            <div className="flex flex-col md:flex-row items-center gap-6">
              {/* 🇸🇪 SE-ONLY LAUNCH: Language/currency selector hidden (Swedish/SEK only).
                  Re-enable for internationalization. */}
              {/* <div className="flex items-center">
                <LanguageCurrencySelector />
              </div> */}

              {/* Trust Badges */}
              <div className="flex items-center gap-2 text-xs text-white/60">
                <span className="border border-white/20 text-white/80 px-2.5 py-1 rounded-full">
                  {t('footer_badge_ssl', '✓ SSL')}
                </span>
                <span className="border border-white/20 text-white/80 px-2.5 py-1 rounded-full">
                  {t('footer_badge_gdpr', '✓ GDPR')}
                </span>
                <span className="border border-white/20 text-white/80 px-2.5 py-1 rounded-full">
                  {t('footer_badge_returns', '✓ 14 dagar ångerrätt')}
                </span>
              </div>
            </div>
          </div>
          
          {/* Additional Legal Text — rendered directly from store settings */}
          {(store.orgNumber || store.businessInfo) && (
            <div className="mt-4 text-xs text-white/40 text-center md:text-left">
              <p>
                {[
                  store.orgNumber && `${t('footer_org_number', 'Organisationsnummer')}: ${store.orgNumber}`,
                  store.businessInfo,
                ].filter(Boolean).join(' | ')}
              </p>
            </div>
          )}
        </div>
      </div>
    </footer>
  );
};

export default ShopFooter; 