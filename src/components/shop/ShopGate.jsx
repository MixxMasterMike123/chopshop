import React, { useEffect, useState } from 'react';
import { useParams, useLocation, Navigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { COUNTRY_PREFIXES } from '../../config/tenancy';
import LandingPage from '../../pages/LandingPage';

/**
 * ShopGate — single entry guard for every per-shop storefront route
 * (/{shopId}/...). It consolidates all "which shop, is it valid" logic so the
 * router doesn't need fragile precedence between legacy redirects, shopIds and
 * CMS slugs:
 *
 *  1. Legacy country code as the shop segment (/se/..., old links) → the
 *     platform Landing Page (there is no default shop to redirect into).
 *  2. Unknown shopId (no shops/{id} doc) → the platform Landing Page.
 *  3. Disabled shop (status === 'disabled') → render the kill-switch
 *     "unavailable" state instead of the storefront.
 *  4. Valid shop → render children (the storefront page). ShopContext already
 *     resolved shopId from the path for data scoping. If the shop is NOT
 *     published (published === false), the store still renders fully but we add a
 *     noindex,nofollow robots meta so search engines don't index it (indexing
 *     gate, not a holding page). Only an EXPLICIT false hides it; missing/true =
 *     indexable (existing shops predate the field).
 */
const ShopGate = ({ children }) => {
  const { shopId } = useParams();
  const location = useLocation();
  const [state, setState] = useState({ status: 'checking', shop: null });

  const isLegacyCountry = COUNTRY_PREFIXES.includes((shopId || '').toLowerCase());

  useEffect(() => {
    let cancelled = false;
    if (isLegacyCountry) {
      setState({ status: 'legacy', shop: null });
      return;
    }
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'shops', shopId));
        if (cancelled) return;
        if (!snap.exists()) {
          // No shops/{id} doc → unknown shop, always. (Until 2026-08-15 the
          // default shop was special-cased as "always valid" so a missing seed
          // doc couldn't infinite-loop; there is no default shop any more, and
          // 'unknown' renders the Landing Page rather than redirecting, so
          // there is no loop to guard against.)
          setState({ status: 'unknown', shop: null });
        } else {
          setState({ status: 'ok', shop: { id: snap.id, ...snap.data() } });
        }
      } catch (e) {
        // On a read error, fail open to render (rules allow public shop read);
        // don't hard-block the storefront on a transient hiccup.
        console.warn('ShopGate: shop lookup failed, rendering anyway:', e?.message);
        if (!cancelled) setState({ status: 'ok', shop: null });
      }
    })();
    return () => { cancelled = true; };
  }, [shopId, isLegacyCountry]);

  // 1. Legacy country code (/se/...) → the platform Landing Page. Storefronts
  //    live ONLY at an explicit /{shopId}; a legacy country prefix is NOT a shop,
  //    so it must not resolve to any storefront. (Strict rule,
  //    decided 2026-06-25: any non-/{shopId} path shows the LP, not a store.)
  if (isLegacyCountry) {
    return <LandingPage />;
  }

  if (state.status === 'checking') {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  // 2. Unknown shop (no shops/{id} doc) → the platform Landing Page. A typo'd
  //    or nonexistent shop must never leak into some other tenant's store.
  if (state.status === 'unknown') {
    return <LandingPage />;
  }

  // 3. Disabled shop → kill-switch "unavailable" page.
  if (state.shop && state.shop.status === 'disabled') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F3F1EC] px-6">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-[#1A1C1E] mb-2">Butiken är inte tillgänglig</h1>
          <p className="text-[#71757C]">
            Den här butiken är för närvarande stängd. Försök igen senare.
          </p>
        </div>
      </div>
    );
  }

  // 4. Valid shop → render the storefront normally.
  //
  //    Indexing gate: a NOT-published shop (published === false, EXPLICIT) is
  //    fully open + shoppable to anyone with the link, but hidden from search
  //    engines — we inject a noindex,nofollow robots meta so Google/Bing don't
  //    index it. GO LIVE (published:true) removes it. This is NOT a holding page:
  //    the store works either way; only indexability changes.
  //
  //    undefined/true = indexable (existing shops have no published field, so they
  //    stay indexable — no regression). state.shop === null (default shop with no
  //    doc, or a read-error fail-open) never matches === false, so it stays
  //    indexable too. A child page that sets its own robots meta (token/legal
  //    pages) renders deeper and wins per react-helmet-async's last-wins rule —
  //    harmless here since those are also noindex.
  const hideFromRobots = state.shop && state.shop.published === false;

  return (
    <>
      {hideFromRobots && (
        <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
      )}
      {children}
    </>
  );
};

export default ShopGate;
