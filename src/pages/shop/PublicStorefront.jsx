import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { getProductImage } from '../../utils/productImages';
import { getProductUrl, getCategoryUrl, getAllProductsUrl, getCollectionUrl, getShopSeoTitle, getShopSeoDescription, generateShopStructuredData } from '../../utils/productUrls';
import { useNavigate } from 'react-router-dom';
import { translateColor } from '../../utils/colorTranslations';
// Toast notifications removed - using AddedToCartModal for user feedback
import { useCart } from '../../contexts/CartContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import ReviewsSection from '../../components/ReviewsSection';
import { getAllReviews } from '../../utils/trustpilotAPI';
import SeoHreflang from '../../components/shop/SeoHreflang';
import SmartPrice from '../../components/shop/SmartPrice';
import AddedToCartModal from '../../components/shop/AddedToCartModal';
import NordProductCard from '../../components/shop/NordProductCard';
import { getCardPrice } from '../../utils/productPricing';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';
import { resolveTheme } from '../../config/nordTokens';
import { getTemplate } from '../../config/templates';
import { useShopId } from '../../contexts/ShopContext';
import { isProductFeatured, sortProductsForDisplay, FRONTPAGE_FEATURED } from '../../utils/productSorting';
import { resolveCollectionProducts } from '../../utils/collectionResolver';
import { Helmet } from 'react-helmet-async';

const PublicStorefront = () => {
  const { t, currentLanguage } = useTranslation();
  const store = useStoreSettings();
  const shopId = useShopId();
  const { getContentValue } = useContentTranslation();
  const { 
    addToCart: addToCartContext, 
    isAddedToCartModalVisible, 
    hideAddedToCartModal, 
    lastAddedItem,
    getTotalItems 
  } = useCart();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // ?alla=1 → bypass the frontpage showcase filter and show the full assortment
  // (the "Visa alla produkter" link sets it). Lets the frontpage double as the
  // all-products view without a separate route.
  const showAll = searchParams.get('alla') === '1';
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [heroReview, setHeroReview] = useState(null);
  // Featured collections for the homepage "Populära samlingar" cards. Empty for
  // shops that have none → the section renders nothing (backward-compat).
  const [featuredCollections, setFeaturedCollections] = useState([]);

  useEffect(() => {
    loadProducts();
    loadHeroReview();
    loadFeaturedCollections();
  }, [currentLanguage, shopId]); // Reload when language or shop changes

  const loadHeroReview = async () => {
    try {
      const allReviews = await getAllReviews();
      // Exclude Paul W. to avoid duplicate testimonial
      const filteredReviews = allReviews.filter(r => r.author !== 'Paul W.');
      
      if (filteredReviews.length > 0) {
        const randomIndex = Math.floor(Math.random() * filteredReviews.length);
        const selectedReview = filteredReviews[randomIndex];
        setHeroReview(selectedReview);
      }
    } catch (err) {
      console.error('Error loading hero review:', err);
    }
  };

  const loadProducts = async () => {
    try {
      setLoading(true);
      const productsQuery = query(
        collection(db, 'products'),
        where('shopId', '==', shopId),
        where('isActive', '==', true),
        where('availability.b2c', '==', true) // Only show B2C available products
      );
      const querySnapshot = await getDocs(productsQuery);
      
      const productList = [];
      querySnapshot.forEach((doc) => {
        productList.push({
          id: doc.id,
          ...doc.data()
        });
      });
      
      // Storefront display order: the admin's drag order (sortOrder) first,
      // then alphabetically by translated name (the pre-sortOrder behavior).
      const nameOf = (p) => {
        try {
          const n = getContentValue(p.name, currentLanguage) || getContentValue(p.name) || '';
          return typeof n === 'string' ? n : String(n || '');
        } catch {
          return String(p.name || '');
        }
      };
      setProducts(sortProductsForDisplay(productList, nameOf, currentLanguage || 'en'));

    } catch (error) {
      console.error('Error loading products:', error);
      // Product loading error - handled by showing empty state
    } finally {
      setLoading(false);
    }
  };

  // Featured collections for the homepage "Populära samlingar" strip. Load all of
  // the shop's collections, then client-filter to published + featured and order
  // by sortOrder (mirrors how products derive featured/sort — no extra index).
  const loadFeaturedCollections = async () => {
    try {
      const snap = await getDocs(query(collection(db, 'collections'), where('shopId', '==', shopId)));
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const feat = all
        .filter((c) => c.published === true && c.featured === true)
        .sort((a, b) => {
          const ao = Number.isFinite(a.sortOrder) ? a.sortOrder : Number.POSITIVE_INFINITY;
          const bo = Number.isFinite(b.sortOrder) ? b.sortOrder : Number.POSITIVE_INFINITY;
          if (ao !== bo) return ao - bo;
          return (a.title || '').localeCompare(b.title || '', 'sv');
        });
      setFeaturedCollections(feat);
    } catch (err) {
      console.error('Error loading featured collections:', err);
      setFeaturedCollections([]);
    }
  };

  const addToCart = (product) => {
    addToCartContext(product);
    // Success feedback now handled by AddedToCartModal
  };

  // Get the best available image for B2C display
  const getB2cProductImage = (product) => {
    // Priority: B2C main image > B2C gallery first image > generated image
    // NOTE: Do NOT fall back to B2B images in the consumer shop!
    if (product.b2cImageUrl) return product.b2cImageUrl;
    if (product.b2cImageGallery && product.b2cImageGallery.length > 0) return product.b2cImageGallery[0];
    
    // Generate consumer-focused image if no B2C images available
    return getProductImage(product); // Pass the product object to use color field
  };

  // Get product description - prefer B2C description
  const getB2cProductDescription = (product) => {
    // 🚨 CRITICAL: Always use getContentValue() for multilingual content to prevent React Error #31
    if (product.descriptions?.b2c) return getContentValue(product.descriptions.b2c);
    if (product.description) return getContentValue(product.description);
    return ''; // neutral — no shared-translation fallback (would leak brand copy)
  };

  // MULTI-TENANT: shop-specific COPY comes from THIS shop's config, with a
  // NEUTRAL hardcoded default — NOT the shared t() translation layer. The
  // global translations are per-platform, so reading hero/section copy from
  // t() would leak one shop's saved copy (e.g. b8shield's) onto every other
  // shop. So: store.<field> || neutral. (Global UI labels — buttons, nav —
  // still use t().)
  const heroHeadline = store.heroHeadline || store.shopName || 'Välkommen';
  const heroSubtitle = store.heroSubtitle || store.tagline || '';

  const bestseller = products[0] || null;

  // Optional intro/about block (admin-editable). Hidden unless the shop sets it.
  const introTitle = (store.introTitle || '').trim();
  const introBody = (store.introBody || '').trim();
  const showIntro = !!(introTitle || introBody);

  // Hero CTA labels: shop config wins, translation fallback keeps current copy.
  const heroCtaLabel = store.heroCtaLabel || t('hero_shop_now_button', 'Handla nu');
  const heroSecondaryLabel = store.heroSecondaryLabel || t('hero_see_products', 'Se sortimentet ↓');

  // Hero layout variant from the active template (see nordTokens.resolveTheme).
  // Default NORD (and any template that doesn't set it) → 'bento', the current
  // signature hero. 'editorial' → the Sport template's variant below. Resolved
  // from the same template+inline+accent layering the context applies, so the
  // component and the CSS vars never disagree.
  const heroStyle = resolveTheme({
    ...getTemplate(store.templateId).tokens,
    ...(store.theme || {}),
  }).heroStyle;
  // Graphic mark for the editorial hero (a big faint glyph behind the headline,
  // shown when there's no hero image). A shop can set `heroMark` explicitly
  // (a short string — club initials, a number, a monogram); otherwise we derive
  // it from the shop name's initial(s) so the hero has its backdrop out of the
  // box. Sport-neutral: no sport-specific default.
  const heroMark = (() => {
    const explicit = (store.heroMark || '').trim();
    if (explicit) return explicit.slice(0, 3);
    const name = (store.shopName || '').trim();
    if (!name) return '';
    // Up to two initials from the first two words (e.g. "Klubb Shop" → "KS",
    // "Klubbshop" → "K"), so single-word names stay a clean single letter.
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w.charAt(0))
      .join('')
      .toUpperCase();
  })();

  // Homepage block visibility (config-driven; default visible so unconfigured
  // shops render all blocks by default). Every toggle the
  // admin Butik page exposes MUST be honored here.
  const blocks = store.blocks || {};
  const showGallery = blocks.gallery !== false;
  const showStory = blocks.story !== false;
  const showBestseller = blocks.bestseller !== false;
  const showTrust = blocks.trust !== false;
  // "Populära samlingar" block: shown when the shop has featured collections AND
  // the block isn't turned off. Heading is admin-editable (collectionsTitle).
  const showCollections = blocks.collections !== false;
  const collectionsTitle = (store.collectionsTitle || '').trim() || t('collections_popular', 'Populära samlingar');
  // Only show a featured-collection card if it actually resolves to ≥1 live
  // product — a card linking to an empty collection page is a dead end. Uses the
  // same resolver the collection page uses (manual pick / smart tag-rule).
  const visibleCollections = featuredCollections.filter(
    (c) => resolveCollectionProducts(c, products, (p) => (typeof p.name === 'string' ? p.name : ''), currentLanguage || 'sv').length > 0
  );
  // Right ("supporting") hero column only renders if it has any content;
  // otherwise the hero tile spans full width (no empty grid cell).
  const showSupporting = showBestseller || showTrust;

  // Config-driven story steps; fall back to the generic default band when
  // a shop hasn't set its own story.
  const storySteps = Array.isArray(store.story) && store.story.length > 0
    ? store.story.slice(0, 3).map((s, i) => ({
        n: String(i + 1).padStart(2, '0'),
        title: s.title || '',
        text: s.text || '',
      }))
    : null;

  // Config-driven gallery items; the band is hidden until a shop adds images.
  const galleryItems = Array.isArray(store.gallery) && store.gallery.length > 0
    ? store.gallery.slice(0, 4).filter((g) => g && g.imageUrl)
    : null;

  const scrollToProducts = () => document.getElementById('products')?.scrollIntoView({ behavior: 'smooth' });

  // ===== Category/featured derivation (all client-side; products are
  // already fully loaded into state). =====

  // Product model v2: CATEGORIES drive the top-nav browse links (the primary
  // taxonomy → /kategori/{slug} pages). The category field replaced `group`;
  // read with a legacy `group` fallback for any old test product.
  const allCategories = Array.from(
    new Set(products.map((p) => (p.category || p.group || '').trim()).filter(Boolean))
  ).sort();

  // Featured grid: products the admin starred (featured boolean; legacy
  // `featured` tag still counts while the boolean is unset). Products are
  // already in display order (sortOrder → name), so filtering preserves the
  // admin's drag order. Cap is shop-configurable (default 4).
  const featuredLimit = Math.min(12, Math.max(1, parseInt(store.featuredLimit, 10) || 4));
  const featuredProducts = products.filter(isProductFeatured).slice(0, featuredLimit);

  // v2: one product = one card (variants are embedded, no group-collapse). Every
  // card links to its own product page.
  // Frontpage mode (storeIdentity.frontpageCategory): '' = all products
  // (default), a category name = showcase that category, or the
  // FRONTPAGE_FEATURED sentinel = only starred products. Curated modes get a
  // "Visa alla produkter" link to /produkter. ?alla=1 bypasses curation (legacy
  // links). Featured mode falls back to ALL products while nothing is starred,
  // so a misconfigured shop never renders an empty frontpage.
  const frontpageSetting = showAll ? '' : (store.frontpageCategory || '').trim();
  const starredProducts = products.filter(isProductFeatured);
  const featuredOnlyMode = frontpageSetting === FRONTPAGE_FEATURED && starredProducts.length > 0;
  const showcaseCategory = frontpageSetting && frontpageSetting !== FRONTPAGE_FEATURED ? frontpageSetting : '';
  const displayCards = featuredOnlyMode
    ? starredProducts
    : showcaseCategory
      ? products.filter((p) => (p.category || p.group || '').trim() === showcaseCategory)
      : products;
  const curatedFrontpage = featuredOnlyMode || !!showcaseCategory;

  return (
    <>
      <Helmet>
        <title>{getShopSeoTitle(currentLanguage, store)}</title>
        <meta name="description" content={getShopSeoDescription(currentLanguage, store)} />
        <meta name="google-site-verification" content="VdZaHTh4JwiHjxpsc_h3u8TMRxLZ1Tg2jU62SN-5fLo" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={getShopSeoTitle(currentLanguage, store)} />
        <meta property="og:description" content={getShopSeoDescription(currentLanguage, store)} />
        {(store.heroImageUrl || store.logoUrl) && <meta property="og:image" content={store.heroImageUrl || store.logoUrl} />}
        <meta property="og:url" content={window.location.href} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={getShopSeoTitle(currentLanguage, store)} />
        <meta name="twitter:description" content={getShopSeoDescription(currentLanguage, store)} />
        {(store.heroImageUrl || store.logoUrl) && <meta name="twitter:image" content={store.heroImageUrl || store.logoUrl} />}
        <script type="application/ld+json">{JSON.stringify(generateShopStructuredData(currentLanguage, store))}</script>
      </Helmet>
      <SeoHreflang />
      <div className="min-h-screen bg-canvas font-body text-ink">
        <ShopNavigation
          tags={allCategories}
          onSelectTag={(cat) => navigate(cat ? getCategoryUrl(cat) : getAllProductsUrl())}
        />

        {/* ===== Bento hero (NORD, DESIGN.md §4) ===== */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <div className={`grid gap-4 ${showSupporting ? 'lg:grid-cols-[1.55fr_1fr]' : 'lg:grid-cols-1'}`}>
            {/* Hero tile — the one dominant element on the screen.
                heroStyle 'editorial' (Sport template): a light surface card with
                a giant faint graphic mark, an accent-underlined headline word and
                a stat row. Any other value → the NORD bento hero (unchanged). */}
            {heroStyle === 'editorial' ? (
            <div className="relative min-h-[440px] lg:min-h-[560px] rounded-tile overflow-hidden bg-surface border border-line shadow-tile grid lg:grid-cols-[1.1fr_0.9fr] animate-rise">
              {/* When there's no hero image, a big faint auto-derived mark fills
                  the right side as a designed backdrop (behind everything). */}
              {!store.heroImageUrl && heroMark && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none select-none absolute top-1/2 -translate-y-1/2 right-0 font-display leading-[0.72] tracking-tight text-accent/[0.08] hidden sm:block"
                  style={{ fontSize: 'clamp(180px, 26vw, 360px)' }}
                >
                  {heroMark}
                </div>
              )}
              {/* Text column (left) */}
              <div className="relative z-[1] flex flex-col justify-center max-w-2xl p-7 lg:p-14">
                {store.tagline && (
                  <div className="inline-flex items-center gap-2.5 text-[13px] font-bold text-ink-muted mb-5">
                    <span className="w-2 h-2 rounded-[2px] bg-accent" />
                    {store.tagline}
                  </div>
                )}
                <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl leading-[0.94] tracking-tight uppercase text-ink text-balance">
                  {heroHeadline}
                </h1>
                <p className="mt-4 text-base lg:text-lg text-ink-muted max-w-[46ch] leading-relaxed">
                  {heroSubtitle}
                </p>
                <div className="mt-7 flex flex-wrap items-center gap-3">
                  <button
                    onClick={scrollToProducts}
                    className="bg-accent text-white font-bold text-base px-6 py-3.5 rounded-el transition-transform duration-150 ease-nord hover:-translate-y-0.5 active:translate-y-px"
                  >
                    {heroCtaLabel}
                  </button>
                  <button
                    onClick={scrollToProducts}
                    className="text-ink font-semibold text-sm px-4 py-3.5 rounded-el border border-line hover:border-ink transition-colors"
                  >
                    {heroSecondaryLabel}
                  </button>
                </div>
              </div>
              {/* Photo panel (right) — the shop's uploaded Butik hero banner.
                  On mobile it stacks below the text as a shorter band; on desktop
                  it fills the right column. Only rendered when a banner exists;
                  otherwise the faint mark backdrop above carries the right side. */}
              {store.heroImageUrl && (
                <div className="relative order-first lg:order-none h-56 lg:h-auto lg:min-h-full overflow-hidden">
                  <img
                    src={store.heroImageUrl}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                </div>
              )}
            </div>
            ) : (
            <div className="relative min-h-[440px] lg:min-h-[560px] rounded-tile overflow-hidden bg-ink shadow-tile flex items-end animate-rise">
              <div className="absolute inset-0">
                {store.heroImageUrl ? (
                  <img
                    src={store.heroImageUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  /* No-photo fallback: accent color field, looks intentional */
                  <div
                    className="w-full h-full"
                    style={{
                      background:
                        'radial-gradient(900px 480px at 85% -10%, color-mix(in srgb, var(--color-accent) 70%, #1A1C1E), transparent 65%), ' +
                        'radial-gradient(700px 500px at -10% 110%, color-mix(in srgb, var(--color-accent) 35%, #1A1C1E), #1A1C1E 70%)',
                    }}
                  />
                )}
                <div className="absolute inset-0 bg-linear-to-b from-ink/0 via-ink/30 to-ink/75" />
              </div>

              <div className="relative w-full p-7 lg:p-11 text-white">
                {store.tagline && (
                  <div className="inline-flex items-center gap-2.5 bg-white/20 backdrop-blur-md text-[13px] font-semibold px-4 py-2 rounded-full mb-5">
                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    {store.tagline}
                  </div>
                )}
                <h1 className="font-display font-bold text-4xl sm:text-5xl lg:text-6xl leading-[1.05] tracking-tight max-w-2xl">
                  {heroHeadline}
                </h1>
                <p className="mt-3 text-base lg:text-lg text-white/85 max-w-xl leading-relaxed">
                  {heroSubtitle}
                </p>
                <div className="mt-7 flex items-center gap-6">
                  <button
                    onClick={scrollToProducts}
                    className="bg-white text-ink font-bold text-base lg:text-lg px-8 py-4 rounded-full transition-all duration-300 ease-nord hover:-translate-y-0.5 hover:shadow-lift"
                  >
                    {heroCtaLabel}
                  </button>
                  <button
                    onClick={scrollToProducts}
                    className="text-white/90 font-semibold text-sm border-b-2 border-white/40 pb-0.5 hover:border-white transition-colors"
                  >
                    {heroSecondaryLabel}
                  </button>
                </div>
              </div>
            </div>
            )}

            {/* Supporting tiles — only when bestseller and/or trust is on */}
            {showSupporting && (
            <div className="flex flex-col gap-4">
              {/* Bestseller tile (toggle: blocks.bestseller) */}
              {showBestseller && (bestseller ? (
                <Link
                  to={getProductUrl(bestseller)}
                  className="group block bg-white rounded-tile shadow-tile overflow-hidden transition-all duration-300 ease-nord hover:-translate-y-1 hover:shadow-lift animate-rise"
                  style={{ animationDelay: '0.1s' }}
                >
                  <div className="relative aspect-[16/9] overflow-hidden bg-[#F7F5F2]">
                    <img
                      src={getB2cProductImage(bestseller)}
                      alt={getContentValue(bestseller.name)}
                      className="w-full h-full object-cover transition-transform duration-700 ease-nord group-hover:scale-105"
                    />
                  </div>
                  <div className="p-5 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.13em] text-ink-muted">
                        {t('hero_bestseller_label', 'Mest älskad')}
                      </div>
                      <div className="font-display font-bold text-lg text-ink mt-0.5 truncate">
                        {getContentValue(bestseller.name)}
                      </div>
                    </div>
                    {(() => {
                      const { price, isFrom, compareAt } = getCardPrice(bestseller);
                      return (
                        <div className="flex items-baseline gap-1.5 shrink-0">
                          {isFrom && <span className="text-xs text-ink-muted">från</span>}
                          {compareAt && (
                            <span className="text-sm text-ink-muted line-through">
                              <SmartPrice sekPrice={compareAt} showOriginal={false} />
                            </span>
                          )}
                          <SmartPrice sekPrice={price} className={compareAt ? 'text-accent' : ''} showOriginal={false} />
                        </div>
                      );
                    })()}
                  </div>
                </Link>
              ) : (
                <div className="bg-white rounded-tile shadow-tile overflow-hidden animate-rise" style={{ animationDelay: '0.1s' }}>
                  <div className="aspect-[16/9] bg-[#F7F5F2] animate-pulse" />
                  <div className="p-5">
                    <div className="h-3 w-24 bg-canvas rounded-full animate-pulse" />
                    <div className="h-5 w-40 bg-canvas rounded-full animate-pulse mt-3" />
                  </div>
                </div>
              ))}

              {/* Duo minis: social proof (only if a REAL review exists) + payment trust (toggle: blocks.trust) */}
              {showTrust && (
              <div className={`grid gap-4 flex-1 ${heroReview ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {heroReview && (
                <div className="bg-white rounded-tile shadow-tile p-5 flex flex-col animate-rise" style={{ animationDelay: '0.18s' }}>
                  <div className="text-accent text-base tracking-[2px]" aria-label={`${heroReview.rating || 5}/5`}>
                    ★★★★★
                  </div>
                  <p className="text-sm text-ink mt-2.5 leading-snug line-clamp-4 flex-1">
                    “{heroReview.text}”
                  </p>
                  <div className="text-xs text-ink-muted mt-2.5">
                    — {heroReview.author}
                  </div>
                </div>
                )}

                <div className="bg-white rounded-tile shadow-tile p-5 flex flex-col animate-rise" style={{ animationDelay: '0.26s' }}>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.13em] text-ink-muted">
                    {t('payments_tile_label', 'Betala tryggt')}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {['Klarna', 'Kort', 'Apple Pay', 'Google Pay'].map((method) => (
                      <span key={method} className="bg-canvas text-ink-muted text-xs font-semibold px-3 py-1.5 rounded-full">
                        {method}
                      </span>
                    ))}
                  </div>
                  <div className="text-xs text-ink-muted mt-auto pt-3">
                    🔒 {t('payments_tile_note', 'Säker betalning')}
                  </div>
                </div>
              </div>
              )}
            </div>
            )}
          </div>
        </section>

        {/* ===== Gallery band (config-driven; hidden until a shop adds images) ===== */}
        {showGallery && galleryItems && (() => {
          // Map the shop's configured gallery to one tile shape: { key, src, label, to }.
          const items = galleryItems.map((g, index) => ({
            key: `cfg-${index}`,
            src: g.imageUrl,
            label: g.label || '',
            // Optional SKU link; if absent the tile is non-navigating.
            to: g.linkSku ? getProductUrl({ name: { 'sv-SE': g.label || '' }, sku: g.linkSku }) : null,
          }));

          const Tile = ({ item, extraClass }) => {
            const inner = (
              <>
                <img
                  src={item.src}
                  alt={item.label}
                  className="w-full h-full object-cover transition-transform duration-700 ease-nord group-hover:scale-105"
                />
                {item.label && (
                  <div className="absolute bottom-4 left-4">
                    <span className="bg-white/90 backdrop-blur-sm text-ink text-sm font-semibold px-3.5 py-1.5 rounded-full">
                      {item.label}
                    </span>
                  </div>
                )}
              </>
            );
            const cls = `relative rounded-tile shadow-tile overflow-hidden group block ${extraClass}`;
            return item.to
              ? <Link to={item.to} className={cls}>{inner}</Link>
              : <div className={cls}>{inner}</div>;
          };

          return (
            <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
              {/* Desktop: 4-up grid */}
              <div className="hidden md:grid md:grid-cols-4 gap-4">
                {items.map((item) => (
                  <Tile key={item.key} item={item} extraClass="aspect-square" />
                ))}
              </div>
              {/* Mobile: horizontal snap scroll */}
              <div className="md:hidden">
                <div className="flex overflow-x-auto gap-4 pb-2 snap-x snap-mandatory scrollbar-hide">
                  {items.map((item) => (
                    <Tile key={item.key} item={item} extraClass="shrink-0 w-4/5 aspect-square snap-start" />
                  ))}
                </div>
              </div>
            </section>
          );
        })()}

        {/* ===== Intro / about block (admin-editable; hidden when empty) ===== */}
        {showIntro && (
          <section className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 lg:pt-20 text-center">
            {introTitle && (
              <h2 className="font-display font-bold text-3xl lg:text-4xl tracking-tight text-ink">
                {introTitle}
              </h2>
            )}
            {introBody && (
              <p className="text-ink-muted text-lg leading-relaxed mt-4 whitespace-pre-line">
                {introBody}
              </p>
            )}
          </section>
        )}

        {/* ===== Populära samlingar (featured collections; hidden when the shop
            has none — backward-compat for shops without collections) ===== */}
        {showCollections && visibleCollections.length > 0 && (
          <section id="collections" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 lg:pt-20">
            <h2 className="font-display font-bold text-2xl lg:text-3xl tracking-tight text-ink mb-6">
              {collectionsTitle}
            </h2>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
              {visibleCollections.map((c) => (
                <Link
                  key={c.id}
                  to={getCollectionUrl(c.handle)}
                  className="group relative block overflow-hidden rounded-tile bg-ink shadow-tile aspect-[4/5]"
                >
                  {c.imageUrl ? (
                    <img
                      src={c.imageUrl}
                      alt={c.title || ''}
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-nord group-hover:scale-105"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-br from-ink to-ink-muted" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />
                  <div className="absolute inset-x-0 bottom-0 p-5">
                    <span className="font-display font-bold text-lg lg:text-xl text-white">
                      {c.title} <span aria-hidden="true" className="inline-block transition-transform duration-300 ease-nord group-hover:translate-x-1">→</span>
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* ===== Featured (hidden in featured-only mode — the main grid IS the
            starred selection there, a strip above it would duplicate) ===== */}
        {!loading && !featuredOnlyMode && featuredProducts.length > 0 && (
          <section id="featured" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 lg:pt-20">
            <h2 className="font-display font-bold text-2xl lg:text-3xl tracking-tight text-ink mb-6">
              {store.featuredTitle || 'Utvalt'}
            </h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 items-stretch">
              {featuredProducts.map((product) => {
                const pn = getContentValue(product.name);
                const name = typeof pn === 'string' && pn ? pn : (product.category || 'Produkt');
                const descRaw = getB2cProductDescription(product);
                const { price, isFrom, compareAt } = getCardPrice(product);
                return (
                  <NordProductCard
                    key={`featured-${product.id}`}
                    to={getProductUrl(product)}
                    image={getB2cProductImage(product)}
                    imageAlt={name}
                    name={name}
                    description={typeof descRaw === 'string' ? descRaw : ''}
                    priceSek={price}
                    compareSek={compareAt}
                    isFromPrice={isFrom}
                    product={product}
                    ctaLabel={t('product_choose_button', 'Välj')}
                  />
                );
              })}
            </div>
          </section>
        )}

        {/* ===== Products ===== */}
        <section id="products" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-20">
          <div className="mb-6 flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h2 className="font-display font-bold text-3xl lg:text-4xl tracking-tight text-ink">
                {featuredOnlyMode
                  ? (store.featuredTitle || 'Utvalt')
                  : (showcaseCategory || store.productsTitle || 'Våra produkter')}
              </h2>
              {store.productsSubtitle && (
                <p className="text-ink-muted mt-2 max-w-2xl">
                  {store.productsSubtitle}
                </p>
              )}
            </div>
            {/* Curated frontpage (showcase category or featured-only) → link to
                the full catalog page. */}
            {curatedFrontpage && (
              <Link
                to={getAllProductsUrl()}
                className="text-sm font-semibold text-accent hover:opacity-80 transition-opacity shrink-0"
              >
                {t('view_all_products', 'Visa alla produkter')} →
              </Link>
            )}
          </div>

          {/* Category links live in the top nav. On small screens, surface them
              here too since the nav links are md-only. */}
          {!loading && allCategories.length > 0 && (
            <div className="flex md:hidden flex-wrap gap-2 mb-8">
              <Link
                to={getAllProductsUrl()}
                className="px-3 py-1.5 rounded-full text-sm font-medium bg-white text-ink-muted shadow-tile hover:text-ink transition-colors"
              >
                {t('nav_all', 'Alla')}
              </Link>
              {allCategories.map((cat) => (
                <Link
                  key={cat}
                  to={getCategoryUrl(cat)}
                  className="px-3 py-1.5 rounded-full text-sm font-medium bg-white text-ink-muted shadow-tile hover:text-ink transition-colors"
                >
                  {cat}
                </Link>
              ))}
            </div>
          )}

          {loading ? (
            <div className="flex justify-center items-center h-64">
              <div className="animate-spin rounded-full h-14 w-14 border-b-2 border-accent" />
            </div>
          ) : (
            <>
              {/* One product = one card (v2: variants are embedded on the
                  product; selection happens on the product page). */}
              <div className="grid grid-cols-1 sm:grid-cols-2 nord-grid gap-4 items-stretch">
                {displayCards.map((product) => {
                  // 🚨 CRITICAL: never render an object — prevent React Error #31
                  const productName = getContentValue(product.name);
                  const name = typeof productName === 'string' && productName
                    ? productName
                    : (product.category || 'Produkt'); // neutral fallback, no shared t()

                  const descRaw = getB2cProductDescription(product);
                  const description = typeof descRaw === 'string' ? descRaw : '';
                  const { price, isFrom, compareAt } = getCardPrice(product);

                  return (
                    <NordProductCard
                      key={product.id}
                      to={getProductUrl(product)}
                      image={getB2cProductImage(product)}
                      imageAlt={name}
                      name={name}
                      description={description}
                      priceSek={price}
                      compareSek={compareAt}
                      isFromPrice={isFrom}
                      product={product}
                      ctaLabel={t('product_choose_button', 'Välj')}
                    />
                  );
                })}
              </div>

              {products.length === 0 && (
                <div className="text-center py-16">
                  <div className="w-16 h-16 bg-white rounded-full shadow-tile flex items-center justify-center mx-auto mb-4">
                    <svg className="w-8 h-8 text-ink-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                    </svg>
                  </div>
                  <p className="text-ink-muted text-lg">{t('no_products_available', 'Inga produkter tillgängliga för tillfället.')}</p>
                </div>
              )}
            </>
          )}
        </section>

        {/* ===== Story band (config-driven, falls back to generic steps) ===== */}
        {showStory && (() => {
          // Config steps win; otherwise the generic default band.
          const fallbackSteps = [
            { n: '01', title: t('feature_step1_title', 'Kvalitet'), text: t('feature_step1_text', 'Noggrant utvalda produkter du kan lita på.') },
            { n: '02', title: t('feature_step2_title', 'Snabb leverans'), text: t('feature_step2_text', 'Skickas snabbt så du får din beställning i tid.') },
            { n: '03', title: t('feature_step3_title', 'Trygg betalning'), text: t('feature_step3_text', 'Betala säkert med dina favoritbetalsätt.') },
          ];
          const steps = storySteps || fallbackSteps;
          // Shop-specific heading from config; neutral default (no shared t()).
          const title = store.storyTitle || '';

          return (
            <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16 lg:pb-20">
              <div className="bg-white rounded-tile shadow-tile overflow-hidden">
                <div className="h-1.5 bg-accent" />
                <div className="p-8 lg:p-12">
                  {title && (
                    <h2 className="font-display font-bold text-2xl lg:text-3xl tracking-tight text-ink mb-8 lg:mb-10">
                      {title}
                    </h2>
                  )}
                  <div className="grid md:grid-cols-3 gap-8 lg:gap-10">
                    {steps.map((step) => (
                      <div key={step.n}>
                        <div className="font-display font-bold text-sm text-accent">{step.n}</div>
                        <h3 className="font-display font-bold text-xl text-ink mt-2 tracking-tight">
                          {step.title}
                        </h3>
                        <p className="text-ink-muted text-[15px] leading-relaxed mt-1.5">
                          {step.text}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          );
        })()}

        {/* ===== Reviews ===== */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
          <div className="text-center mb-12">
            <h2 className="font-display font-bold text-3xl lg:text-4xl tracking-tight text-ink mb-3">
              {store.reviewsTitle || 'Vad våra kunder säger'}
            </h2>
            {store.reviewsSubtitle && (
              <p className="text-lg text-ink-muted">
                {store.reviewsSubtitle}
              </p>
            )}
          </div>

          <ReviewsSection
            businessId="" // Will be set when Trustpilot profile is ready
            domain="" // Set per-shop when a live Trustpilot profile is configured (was shop.b8shield.com)
            showTrustpilot={false} // Start with manual reviews, enable when Trustpilot is set up
            showManualReviews={true}
            className="w-full"
          />
        </section>

        {/* Footer */}
        <ShopFooter />

        {isAddedToCartModalVisible && lastAddedItem && (
          <AddedToCartModal 
            isVisible={isAddedToCartModalVisible}
            onClose={hideAddedToCartModal}
            addedItem={lastAddedItem}
            cartCount={getTotalItems()}
          />
        )}
      </div>
    </>
  );
};

export default PublicStorefront;
