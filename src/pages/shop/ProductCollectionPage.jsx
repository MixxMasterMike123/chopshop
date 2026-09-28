// ProductCollectionPage — the storefront COLLECTION browse listing.
// Route: /{shopId}/samling/:handle. Loads the collection doc (by shopId+handle),
// resolves its members (manual pick order OR smart tag-rule), and renders the
// NORD grid. Mirrors CollectionPage.jsx (the category page). Not published /
// not found → redirect to the storefront home.
import React, { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { getWholeCollection } from '../../api/collections.js';
import { toPageProducts } from '../../storefront/adapters/products.js';
import { toPageCollection } from '../../storefront/adapters/collections.js';
import { useTranslation } from '../../contexts/TranslationContext';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';
import { useShopId } from '../../contexts/ShopContext';
import { getProductUrl, getCountryAwareUrl } from '../../utils/productUrls';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import NordProductCard from '../../components/shop/NordProductCard';
import { getCardPrice } from '../../utils/productPricing';
import { getProductImage } from '../../utils/productImages';
import { resolveCollectionProducts } from '../../utils/collectionResolver';
import { Helmet } from 'react-helmet-async';

const ProductCollectionPage = () => {
  const { handle } = useParams();
  const { t, currentLanguage } = useTranslation();
  const store = useStoreSettings();
  const shopId = useShopId();
  const { getContentValue } = useContentTranslation();

  // status: 'loading' | 'ok' | 'missing'  (missing → redirect home)
  const [status, setStatus] = useState('loading');
  const [coll, setColl] = useState(null);
  const [products, setProducts] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus('loading');
      try {
        // GET /v1/collections/<handle>, every page of its products: the API
        // answers a published collection only, with its public products in
        // the collection's order (storefront adapters: a page collection
        // whose members are exactly those products).
        const whole = await getWholeCollection(handle);
        if (cancelled) return;
        // Unknown handle OR unpublished → the API answers 404 → missing.
        if (!whole) {
          setStatus('missing');
          return;
        }
        const members = toPageProducts(whole.products);
        setColl(toPageCollection(whole.collection, members));
        setProducts(members);
        setStatus('ok');
      } catch (err) {
        console.error('Error loading collection page:', err);
        // Fail open to "missing" (redirect home) rather than a broken shell.
        if (!cancelled) setStatus('missing');
      }
    })();
    return () => { cancelled = true; };
  }, [shopId, handle, currentLanguage]);

  const nameOf = (p) => {
    const n = getContentValue(p.name);
    return typeof n === 'string' && n ? n : 'Produkt';
  };
  const imageOf = (p) => p.b2cImageUrl || p.imageUrl || getProductImage(p) || '';

  if (status === 'missing') {
    // Send unknown/unpublished collections to the storefront home (never a broken page).
    return <Navigate to={getCountryAwareUrl('')} replace />;
  }

  const cards = coll ? resolveCollectionProducts(coll, products, nameOf, currentLanguage || 'sv') : [];
  const title = coll?.title || handle;

  return (
    <>
      <Helmet>
        <title>{title} | {store.shopName || 'Butik'}</title>
        {coll?.description && <meta name="description" content={coll.description} />}
      </Helmet>
      <div className="min-h-screen bg-canvas">
        <ShopNavigation breadcrumb={title} />

        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
          <div className="mb-8">
            <p className="text-sm text-ink-muted">{t('collection_label', 'Samling')}</p>
            <h1 className="font-display font-bold text-3xl lg:text-4xl tracking-tight text-ink mt-1">{title}</h1>
            {coll?.description && <p className="mt-3 max-w-2xl text-ink-muted">{coll.description}</p>}
          </div>

          {status === 'loading' ? (
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

export default ProductCollectionPage;
