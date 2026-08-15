import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import { useTranslation } from '../../contexts/TranslationContext';
import { useShopId } from '../../contexts/ShopContext';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import { toast } from 'react-hot-toast';
import { DocumentIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { formatFileSize, getFileTypeInfo } from '../../utils/fileUpload';
import { getLegalSeoTitle, getLegalSeoDescription } from '../../utils/productUrls';
import { Helmet } from 'react-helmet-async';
import DOMPurify from 'dompurify';
import { isLegalSlug, LEGAL_PAGES } from '../../config/legalTemplates';
import { renderLegalPage } from '../../utils/legalPageRenderer';
import { getLegalReadiness } from '../../utils/legalPageReadiness';
import { loadShopConfig } from '../../config/shopConfig';

const DynamicPage = ({ slug: propSlug, isCmsPage = false, children = null }) => {
  const { slug: paramSlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  
  // Helper function to determine page type from slug for SEO
  const getPageTypeFromSlug = (slug) => {
    if (!slug) return 'privacy';
    
    const slugLower = slug.toLowerCase();
    if (slugLower.includes('integritet') || slugLower.includes('privacy')) return 'privacy';
    if (slugLower.includes('anvandarvillkor') || slugLower.includes('terms')) return 'terms';
    if (slugLower.includes('retur') || slugLower.includes('return')) return 'returns';
    if (slugLower.includes('cookie')) return 'cookies';
    if (slugLower.includes('leverans') || slugLower.includes('shipping')) return 'shipping';
    
    return 'privacy'; // default
  };
  
  // Extract slug from URL path dynamically
  const getSlugFromPath = () => {
    if (propSlug) return propSlug;
    if (paramSlug) return paramSlug;
    
    // Extract from full pathname
    const pathname = location.pathname || '/';
    const pathParts = pathname.split('/').filter(Boolean);
    
    // Remove country code and get the rest as slug
    if (pathParts.length >= 2) {
      return pathParts.slice(1).join('/'); // Skip country code, join rest
    }
    
    return null;
  };
  
  const slug = getSlugFromPath();
  const { getContentValue } = useContentTranslation();
  const { t } = useTranslation();
  const shopId = useShopId();
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Auto-generated legal page state. When the slug is one of the three legal
  // pages, we render the generated HTML from shop data (always, even with no CMS
  // page). `legalReady` gates whether the page is treated as live. A CMS page on
  // the same slug, if any, is APPENDED below the locked legal block (seller can
  // add, not remove the mandatory text).
  const isLegal = isLegalSlug(slug);
  const [legal, setLegal] = useState(null); // { title, html, ready }

  useEffect(() => {
    if (!isLegal) { setLegal(null); return; }
    let cancelled = false;
    (async () => {
      let identity = {};
      try {
        identity = (await loadShopConfig(shopId)) || {};
      } catch (e) {
        console.warn('DynamicPage: could not load shop config for legal page:', e?.message);
      }
      if (cancelled) return;
      const rendered = renderLegalPage(slug, identity);
      const readiness = getLegalReadiness(identity);
      setLegal(rendered ? { ...rendered, ready: readiness.ready, blockers: readiness.blockers } : null);
    })();
    return () => { cancelled = true; };
  }, [isLegal, slug, shopId]);

  useEffect(() => {
    const fetchPage = async () => {
      if (!slug || !isCmsPage) {
        setLoading(false);
        return;
      }

      try {
        console.log('🔍 DynamicPage: Fetching page with slug:', slug);
        
        // Query for the page with the given slug and published status
        const pagesRef = collection(db, 'pages');
        const q = query(
          pagesRef,
          where('shopId', '==', shopId),
          where('slug', '==', slug),
          where('status', '==', 'published')
        );
        
        const querySnapshot = await getDocs(q);
        
        if (querySnapshot.empty) {
          console.log('🔍 DynamicPage: No published page found with slug:', slug);
          setError('Page not found');
          setLoading(false);
          return;
        }

        // Get the first (and should be only) matching page. Strip the admin
        // audit fields (createdBy/updatedBy = admin Firebase UIDs) from state.
        // Hygiene only, not a security boundary: published page docs remain
        // directly readable and rules cannot redact fields — keeping UIDs out
        // of pages entirely would need a projection like productsPublic.
        const pageDoc = querySnapshot.docs[0];
        const { createdBy, updatedBy, ...publicFields } = pageDoc.data();
        const pageData = {
          id: pageDoc.id,
          ...publicFields
        };

        console.log('🔍 DynamicPage: Found page:', pageData);
        setPage(pageData);
        setLoading(false);
      } catch (error) {
        console.error('Error fetching page:', error);
        setError('Error loading page');
        setLoading(false);
        toast.error(t('dynamic_page_loading_error', 'Fel vid laddning av sida'));
      }
    };

    fetchPage();
  }, [slug, isCmsPage, shopId]);

  // Update document title for SEO (must be before early returns)
  useEffect(() => {
    if (page && page.title) {
      const title = getContentValue(page.title) || 'Untitled Page';
      document.title = title;
    }
  }, [page, getContentValue]);

  // On legal slugs also wait for the generated content to be ready.
  if (loading || (isLegal && !legal)) {
    return (
      <div className="min-h-screen bg-linear-to-br from-blue-50 to-indigo-100">
        <ShopNavigation />
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
        <ShopFooter />
      </div>
    );
  }

  // If not a CMS page, render children (fallback to existing routes)
  if (!isCmsPage) {
    return children;
  }

  // AUTO-GENERATED LEGAL PAGE. Renders the mandatory legal block from shop data
  // ALWAYS (even with no CMS page). Any published CMS page on the same slug is
  // APPENDED below as the seller's extra content — it can ADD, never REMOVE the
  // mandatory legal text above. SEO/title come from the legal template.
  if (isLegal && legal) {
    // Optional seller-appended content (only if a published CMS page exists).
    const appended = page ? (getContentValue(page.content) || '') : '';
    const pageType = LEGAL_PAGES[slug]?.pageType || 'privacy';
    return (
      <>
        <Helmet>
          <title>{getLegalSeoTitle(pageType)}</title>
          <meta name="description" content={getLegalSeoDescription(pageType)} />
          <meta property="og:type" content="website" />
          <meta property="og:title" content={getLegalSeoTitle(pageType)} />
          <meta property="og:description" content={getLegalSeoDescription(pageType)} />
          <meta property="og:url" content={window.location.href} />
          {/* Until a shop completes the legal data, keep the auto-pages out of
              search indexes — they aren't truthful yet (return address / VAT). */}
          {!legal.ready && <meta name="robots" content="noindex" />}
        </Helmet>
        <div className="min-h-screen bg-canvas">
          <ShopNavigation />
          <div className="bg-white shadow-xs border-b border-ink/5">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
              <div className="max-w-4xl mx-auto">
                <h1 className="font-display text-4xl font-bold text-ink mb-2 tracking-tight">
                  {legal.title}
                </h1>
                <p className="text-sm text-ink/50">
                  {t('last_updated', 'Senast uppdaterad')}: {new Date().toLocaleDateString('sv-SE')}
                </p>
              </div>
            </div>
          </div>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <div className="max-w-4xl mx-auto space-y-6">
              {/* Mandatory legal block — generated, sanitized, NOT seller-editable. */}
              <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
                <div
                  className="prose prose-lg max-w-none prose-headings:font-display prose-headings:text-ink prose-headings:tracking-tight prose-p:text-ink/80 prose-a:text-accent prose-strong:text-ink prose-li:text-ink/80"
                  dangerouslySetInnerHTML={{ __html: legal.html }}
                />
              </div>
              {/* Seller's appended extra content, if any (added via CMS). */}
              {appended && appended.startsWith('<') && (
                <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
                  <div
                    className="prose prose-lg max-w-none prose-headings:font-display prose-headings:text-ink prose-p:text-ink/80 prose-a:text-accent"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(appended) }}
                  />
                </div>
              )}
            </div>
          </div>
          <ShopFooter />
        </div>
      </>
    );
  }

  if (error || !page) {
    // Special handling for affiliate payout page
    if (slug && slug.includes('begar-utbetalning')) {
      return (
        <div className="min-h-screen bg-linear-to-br from-blue-50 to-indigo-100">
          <ShopNavigation />
          <div className="flex items-center justify-center min-h-[60vh]">
            <div className="text-center max-w-2xl mx-auto px-4">
              <h1 className="text-3xl font-bold text-gray-900 mb-6">
                {t('payout_request_title', 'Begär utbetalning')}
              </h1>
              <div className="bg-white rounded-lg shadow-xs border p-8 mb-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">
                  {t('payout_affiliate_title', 'Affiliate Utbetalning')}
                </h2>
                <p className="text-gray-600 mb-4">
                  {t('payout_request_description', 'För att begära utbetalning av dina affiliate-intäkter, kontakta oss direkt:')}
                </p>
                <div className="space-y-3">
                  <div className="flex items-center justify-center space-x-2">
                    <span className="text-gray-600">{t('payout_contact_email_label', 'Email:')}</span>
                    <a href="mailto:info@jphinnovation.se" className="text-blue-600 hover:text-blue-800 font-medium">
  info@jphinnovation.se
                    </a>
                  </div>
                  <div className="flex items-center justify-center space-x-2">
                    <span className="text-gray-600">{t('payout_contact_phone_label', 'Telefon:')}</span>
                    <span className="font-medium">{t('payout_business_hours', 'Mån-Fre: 09:00-17:00')}</span>
                  </div>
                </div>
                <div className="mt-6 p-4 bg-blue-50 rounded-lg">
                  <p className="text-sm text-blue-800">
                    <strong>{t('payout_important_info_title', 'Viktig information:')}</strong> {t('payout_processing_info', 'Vi behandlar utbetalningsförfrågningar inom 3-5 arbetsdagar. Minimum utbetalningsbelopp är 100 kr.')}
                  </p>
                </div>
              </div>
              <button
                onClick={() => navigate(-1)}
                className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors"
              >
{t('go_back_to_affiliate_portal', 'Gå tillbaka till Affiliate Portal')}
              </button>
            </div>
          </div>
          <ShopFooter />
        </div>
      );
    }

    // Default error page for other missing pages
    return (
      <div className="min-h-screen bg-linear-to-br from-blue-50 to-indigo-100">
        <ShopNavigation />
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-900 mb-4">
              {t('page_not_found', 'Sidan kunde inte hittas')}
            </h1>
            <p className="text-gray-600 mb-6">
              {t('page_not_found_description', 'Sidan du letar efter finns inte eller är inte publicerad.')}
            </p>
            <button
              onClick={() => navigate(-1)}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
            >
              {t('go_back', 'Gå tillbaka')}
            </button>
          </div>
        </div>
        <ShopFooter />
      </div>
    );
  }

  // Get page content values (must be before early returns)
  const pageTitle = page ? (getContentValue(page.title) || 'Untitled Page') : '';
  const pageContent = page ? (getContentValue(page.content) || '') : '';
  const metaTitle = page ? (getContentValue(page.metaTitle) || pageTitle) : '';
  const metaDescription = page ? (getContentValue(page.metaDescription) || '') : '';

  // Debug: Log the HTML structure to see what Quill is generating
  if (pageContent && pageContent.startsWith('<')) {
    console.log('🔍 DynamicPage: HTML content structure:', pageContent.substring(0, 500));
  }

  return (
    <>
      <Helmet>
        <title>{metaTitle || getLegalSeoTitle(getPageTypeFromSlug(slug))}</title>
        <meta name="description" content={metaDescription || getLegalSeoDescription(getPageTypeFromSlug(slug))} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={metaTitle || getLegalSeoTitle(getPageTypeFromSlug(slug))} />
        <meta property="og:description" content={metaDescription || getLegalSeoDescription(getPageTypeFromSlug(slug))} />
        
        <meta property="og:url" content={window.location.href} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={metaTitle || getLegalSeoTitle(getPageTypeFromSlug(slug))} />
        <meta name="twitter:description" content={metaDescription || getLegalSeoDescription(getPageTypeFromSlug(slug))} />
        
      </Helmet>
      <div className="min-h-screen bg-linear-to-br from-blue-50 to-indigo-100">
        <ShopNavigation />
      
      {/* Page Header */}
      <div className="bg-white shadow-xs border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="max-w-4xl mx-auto">
            <h1 className="text-4xl font-bold text-gray-900 mb-4">
              {pageTitle}
            </h1>
            {page.updatedAt && (
              <p className="text-sm text-gray-500">
                {t('last_updated', 'Senast uppdaterad')}: {page.updatedAt.toDate().toLocaleDateString('sv-SE')}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Page Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-lg shadow-xs border p-8">
            {/* Render content - handle both plain text and HTML with full Quill format support */}
            {pageContent.startsWith('<') ? (
              <div 
                className="prose prose-lg max-w-none"
                style={{
                  // Enhanced Quill-specific styles with explicit element targeting
                  '--tw-prose-body': '#374151',
                  '--tw-prose-headings': '#111827',
                  '--tw-prose-links': '#2563eb',
                  '--tw-prose-bold': '#111827',
                  '--tw-prose-counters': '#6b7280',
                  '--tw-prose-bullets': '#d1d5db',
                  '--tw-prose-hr': '#e5e7eb',
                  '--tw-prose-quotes': '#6b7280',
                  '--tw-prose-quote-borders': '#e5e7eb',
                  '--tw-prose-captions': '#6b7280',
                  '--tw-prose-code': '#111827',
                  '--tw-prose-pre-code': '#e5e7eb',
                  '--tw-prose-pre-bg': '#1f2937',
                  '--tw-prose-th-borders': '#d1d5db',
                  '--tw-prose-td-borders': '#e5e7eb',
                }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(pageContent || '') }}
              />
            ) : (
              <div className="prose prose-lg max-w-none whitespace-pre-wrap prose-p:text-gray-700 prose-p:mb-4 prose-p:leading-relaxed">
                {pageContent}
              </div>
            )}
            
            {/* Custom CSS for Quill heading styles - force override */}
            <style dangerouslySetInnerHTML={{
              __html: `
                .prose h1 {
                  font-size: 1.875rem !important;
                  line-height: 2.25rem !important;
                  font-weight: 700 !important;
                  color: #111827 !important;
                  margin-bottom: 1.5rem !important;
                  margin-top: 0 !important;
                }
                .prose h2 {
                  font-size: 1.5rem !important;
                  line-height: 2rem !important;
                  font-weight: 700 !important;
                  color: #111827 !important;
                  margin-bottom: 1rem !important;
                  margin-top: 0 !important;
                }
                .prose h3 {
                  font-size: 1.25rem !important;
                  line-height: 1.75rem !important;
                  font-weight: 700 !important;
                  color: #111827 !important;
                  margin-bottom: 0.75rem !important;
                  margin-top: 0 !important;
                }
                .prose h4 {
                  font-size: 1.125rem !important;
                  line-height: 1.75rem !important;
                  font-weight: 700 !important;
                  color: #111827 !important;
                  margin-bottom: 0.5rem !important;
                  margin-top: 0 !important;
                }
                .prose p {
                  color: #374151 !important;
                  margin-bottom: 1rem !important;
                  line-height: 1.75 !important;
                }
                .prose strong {
                  font-weight: 600 !important;
                  color: #111827 !important;
                }
                .prose em {
                  font-style: italic !important;
                  color: #374151 !important;
                }
                .prose ul {
                  list-style-type: disc !important;
                  padding-left: 1.5rem !important;
                  margin-bottom: 1rem !important;
                }
                .prose ol {
                  list-style-type: decimal !important;
                  padding-left: 1.5rem !important;
                  margin-bottom: 1rem !important;
                }
                .prose li {
                  margin-bottom: 0.25rem !important;
                }
                .prose a {
                  color: #2563eb !important;
                  text-decoration: underline !important;
                }
                .prose a:hover {
                  color: #1d4ed8 !important;
                }
              `
            }} />
            
            {/* Attachments Section - Only show if files exist and are public */}
            {page.attachments && page.attachments.length > 0 && (
              <div className="mt-8 pt-8 border-t border-gray-200">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  {t('attachments', 'Bilagor')} ({page.attachments.filter(f => f.isPublic).length})
                </h3>
                <div className="space-y-3">
                  {page.attachments
                    .filter(file => file.isPublic) // Only show public files
                    .map((file) => {
                      const fileTypeInfo = getFileTypeInfo(file.type);
                      return (
                        <a
                          key={file.id}
                          href={file.url}
                          download={file.name}
                          className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200 hover:bg-gray-100 transition-colors group"
                        >
                          <div className="flex items-center space-x-3">
                            <DocumentIcon className={`h-5 w-5 ${fileTypeInfo.color}`} />
                            <div>
                              <p className="text-sm font-medium text-gray-900 group-hover:text-blue-600">
                                {file.displayName || file.name}
                              </p>
                              <p className="text-xs text-gray-500">
                                {formatFileSize(file.size)} • {fileTypeInfo.label}
                              </p>
                            </div>
                          </div>
                          <ArrowDownTrayIcon className="h-5 w-5 text-gray-400 group-hover:text-blue-600 transition-colors" />
                        </a>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <ShopFooter />
    </div>
    </>
  );
};

export default DynamicPage; 