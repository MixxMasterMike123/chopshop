import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { useShopId } from '../../contexts/ShopContext';
import DynamicPage from '../../pages/shop/DynamicPage';
import { isLegalSlug, PLATFORM_TERMS_SLUG } from '../../config/legalTemplates';

/**
 * Handles dynamic routing for B2C shop
 * Checks if the path matches a CMS page slug, otherwise renders children
 */
const DynamicRouteHandler = ({ children }) => {
  const location = useLocation();
  const shopId = useShopId();
  const [isCmsPage, setIsCmsPage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cmsSlug, setCmsSlug] = useState(null);

  useEffect(() => {
    const checkForCmsPage = async () => {
      // Path-prefix grammar: /{shopId}/{slug...} — the CMS slug is everything
      // AFTER the shopId (first) segment.
      const pathSegments = (location.pathname || '/').split('/').filter(Boolean);
      if (pathSegments.length < 2) {
        setLoading(false);
        return;
      }

      const slugPath = pathSegments.slice(1).join('/');

      // Auto-generated legal pages (köpvillkor, ångerrätt & returer,
      // integritetspolicy) ALWAYS render — even with no CMS page in Firestore —
      // because their default content is generated from shop data. A CMS page on
      // the same slug only ADDS appended content (handled in DynamicPage). So we
      // flag these as CMS pages here regardless of the Firestore lookup below.
      // The platform's own terms page rides the same route: build-time content,
      // no Firestore lookup, so it must never fall through to the 404 branch.
      if (isLegalSlug(slugPath) || slugPath === PLATFORM_TERMS_SLUG) {
        setIsCmsPage(true);
        setCmsSlug(slugPath);
        setLoading(false);
        return;
      }

      // Skip if it's a known (non-CMS) route
      const knownRoutes = [
        'product', 'cart', 'checkout', 'order-confirmation', 'order-return', 'account',
        'privacy', 'terms', 'returns', 'cookies', 'shipping',
        'affiliate-registration', 'affiliate-login', 'affiliate-portal',
        'login', 'register', 'forgot-password', 'reset-password'
      ];

      if (knownRoutes.some(route => slugPath.startsWith(route))) {
        setLoading(false);
        return;
      }

      // Check if this path matches a CMS page slug
      try {
        console.log('🔍 DynamicRouteHandler: Checking for CMS page with slug:', slugPath);

        // Tenant isolation: scope the slug existence-check to the CURRENT shop
        // (mirrors DynamicPage's fetch). Without this, a slug that exists only
        // in another shop would flip isCmsPage=true, and DynamicPage's
        // shop-scoped re-query would then find nothing and render a "page not
        // found" error instead of the normal storefront route — plus it leaks
        // cross-tenant slug existence. See TENANT_ISOLATION_AUDIT_2026-06-18 (H29).
        const pagesRef = collection(db, 'pages');
        const q = query(
          pagesRef,
          where('shopId', '==', shopId),
          where('slug', '==', slugPath),
          where('status', '==', 'published')
        );
        
        const querySnapshot = await getDocs(q);
        
        if (!querySnapshot.empty) {
          console.log('🔍 DynamicRouteHandler: Found CMS page with slug:', slugPath);
          setIsCmsPage(true);
          setCmsSlug(slugPath);
        } else {
          console.log('🔍 DynamicRouteHandler: No CMS page found, rendering children');
        }
      } catch (error) {
        console.error('Error checking for CMS page:', error);
      }
      
      setLoading(false);
    };

    checkForCmsPage();
  }, [location.pathname, shopId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <DynamicPage 
      slug={cmsSlug} 
      isCmsPage={isCmsPage}
      children={children}
    />
  );
};

export default DynamicRouteHandler; 