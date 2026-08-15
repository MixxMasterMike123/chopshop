// TagPage — the storefront TAG browse listing.
// Route: /{shopId}/tagg/:tag. Lists every product whose tags[] includes the tag.
// The URL carries a SLUGIFIED tag; we match it back to the shop's real tags by
// comparing slugify(realTag) === routeSlug (tags are free-text, possibly with
// spaces/case), then filter products by exact tag membership. Mirrors CollectionPage.
import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { useTranslation } from '../../contexts/TranslationContext';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';
import { useShopId } from '../../contexts/ShopContext';
import { getProductUrl, slugify } from '../../utils/productUrls';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import NordProductCard from '../../components/shop/NordProductCard';
import { getCardPrice } from '../../utils/productPricing';
import { getProductImage } from '../../utils/productImages';
import { sortProductsForDisplay } from '../../utils/productSorting';
import { Helmet } from 'react-helmet-async';

const TagPage = () => {
  const { tag: slug } = useParams();
  const { t, currentLanguage } = useTranslation();
  const store = useStoreSettings();
  const shopId = useShopId();
  const { getContentValue } = useContentTranslation();

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const snap = await getDocs(query(
          collection(db, 'productsPublic'),
          where('shopId', '==', shopId),
          where('isActive', '==', true),
          where('availability.b2c', '==', true)
        ));
        if (cancelled) return;
        setProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      } catch (err) {
        console.error('Error loading tag page:', err);
        if (!cancelled) setProducts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId, slug, currentLanguage]);

  const nameOf = (p) => {
    const n = getContentValue(p.name);
    return typeof n === 'string' && n ? n : 'Produkt';
  };
  const imageOf = (p) => p.b2cImageUrl || p.imageUrl || getProductImage(p) || '';

  // Match the URL slug back to the real tag by slugifying each product tag.
  // A product belongs if ANY of its tags slugifies to the route slug.
  const tagMatches = (p) => Array.isArray(p.tags) && p.tags.some((tg) => slugify(tg) === slug);
  const cards = sortProductsForDisplay(products.filter(tagMatches), nameOf, currentLanguage || 'sv');

  // Human title = the first matching product's real tag value, else the slug.
  const title = (() => {
    for (const p of cards) {
      const real = Array.isArray(p.tags) ? p.tags.find((tg) => slugify(tg) === slug) : null;
      if (real) return real;
    }
    return slug;
  })();

  return (
    <>
      <Helmet>
        <title>{title} | {store.shopName || 'Butik'}</title>
      </Helmet>
      <div className="min-h-screen bg-canvas">
        <ShopNavigation breadcrumb={title} />

        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
          <div className="mb-8">
            <p className="text-sm text-ink-muted">{t('tag_label', 'Tagg')}</p>
            <h1 className="font-display font-bold text-3xl lg:text-4xl tracking-tight text-ink mt-1">{title}</h1>
          </div>

          {loading ? (
            <div className="flex justify-center items-center h-64">
              <div className="animate-spin rounded-full h-14 w-14 border-b-2 border-accent" />
            </div>
          ) : cards.length === 0 ? (
            <p className="text-ink-muted py-16 text-center">{t('collection_empty', 'Inga produkter i den här samlingen.')}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 nord-grid gap-4 items-stretch">
              {cards.map((p) => {
                const { price, isFrom, compareAt } = getCardPrice(p);
                return (
                  <NordProductCard
                    key={p.id}
                    to={getProductUrl(p)}
                    image={imageOf(p)}
                    imageAlt={nameOf(p)}
                    name={nameOf(p)}
                    description=""
                    priceSek={price}
                    compareSek={compareAt}
                    isFromPrice={isFrom}
                    product={p}
                    ctaLabel={t('product_choose_button', 'Välj')}
                  />
                );
              })}
            </div>
          )}
        </section>

        <ShopFooter />
      </div>
    </>
  );
};

export default TagPage;
