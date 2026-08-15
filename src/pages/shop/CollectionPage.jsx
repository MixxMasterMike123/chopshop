// CollectionPage — the storefront CATEGORY browse listing.
// Route: /{shopId}/kategori/:category. Lists EVERY product in the category
// (matched by slugify(product.category) === route slug; legacy `group` is read
// as a fallback). Category is the primary taxonomy (product model v2); variants
// are embedded on each product, so there's no group/variant collapse here.
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

const CollectionPage = () => {
  // Category browse page: /{shopId}/kategori/:category. Lists every product in
  // the category (matched by slugify(product.category) === route slug).
  const { category: slug } = useParams();
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
        console.error('Error loading collection:', err);
        if (!cancelled) setProducts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId, slug, currentLanguage]);

  const categoryOf = (p) => (p.category || p.group || '').trim(); // legacy group fallback
  const nameOf = (p) => {
    const n = getContentValue(p.name);
    return typeof n === 'string' && n ? n : (categoryOf(p) || 'Produkt');
  };
  const imageOf = (p) => p.b2cImageUrl || p.imageUrl || getProductImage(p) || '';

  // Every product in this category (slug-matched). Lists ALL — no collapse.
  // Display order = the admin's drag order (sortOrder), then name.
  const cards = sortProductsForDisplay(
    products.filter((p) => slugify(categoryOf(p)) === slug),
    nameOf,
    currentLanguage || 'sv'
  );

  // Human title from the first match's real category value, else the slug.
  const title = cards.length ? (categoryOf(cards[0]) || slug) : slug;

  return (
    <>
      <Helmet>
        <title>{title} | {store.shopName || 'Butik'}</title>
      </Helmet>
      <div className="min-h-screen bg-canvas">
        <ShopNavigation breadcrumb={title} />

        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
          <div className="mb-8">
            <p className="text-sm text-ink-muted">{t('collection_category', 'Kategori')}</p>
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

export default CollectionPage;
