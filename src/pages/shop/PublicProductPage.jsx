import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { getProductImage } from '../../utils/productImages';
import {
  getSkuFromSlug,
  getProductSeoTitle,
  getProductSeoDescription,
  getCountryAwareUrl
} from '../../utils/productUrls';
// Toast notifications removed - using AddedToCartModal for user feedback
import { generateProductSchema } from '../../utils/productFeed';
import { useCart } from '../../contexts/CartContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { useShopId } from '../../contexts/ShopContext';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import ReviewsSection from '../../components/ReviewsSection';
import ProductReviews from '../../components/shop/ProductReviews';
import { getReviewStats } from '../../utils/trustpilotAPI';
import SeoHreflang from '../../components/shop/SeoHreflang';
import { Helmet } from 'react-helmet-async';
import SmartPrice from '../../components/shop/SmartPrice';
import { getCompareAtPrice } from '../../utils/productPricing';
import AddedToCartModal from '../../components/shop/AddedToCartModal';
import ProductSocialShare from '../../components/ProductSocialShare';
import DOMPurify from 'dompurify';

// Sanitize Firestore-authored HTML before rendering to prevent stored XSS
const sanitize = (html) => DOMPurify.sanitize(html || '');

// Helper function to determine button state based on launch date
const getButtonState = (product, t) => {
  // No launch date = normal product
  if (!product.launchDate) {
    return { 
      text: t('add_to_shopping_bag', 'Lägg i shoppingbagen'),
      disabled: false,
      isComingSoon: false
    };
  }
  
  // Has launch date - check if it's future or past
  const now = new Date();
  const launchDate = new Date(product.launchDate.toDate ? product.launchDate.toDate() : product.launchDate);
  
  if (launchDate > now) {
    // Still coming soon
    return {
      text: t('coming_soon_button', 'Kommer snart'),
      disabled: true,
      isComingSoon: true
    };
  } else {
    // Launch date has passed - now available
    return {
      text: t('add_to_shopping_bag', 'Lägg i shoppingbagen'),
      disabled: false,
      isComingSoon: false
    };
  }
};

const PublicProductPage = () => {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const shopId = useShopId();
  const { getContentValue } = useContentTranslation();
  const store = useStoreSettings();
  
  const [product, setProduct] = useState(null);
  // Product model v2: variants are EMBEDDED on the product ({sku,label,price,image}).
  // Selecting a variant is in-page state — no navigation between docs, no
  // same-group query. `selectedVariant` is null for a product with no variants.
  const [variants, setVariants] = useState([]);
  const [selectedVariant, setSelectedVariant] = useState(null);
  // Model v2.1 (Shopify-style): `options` are the product's axes (Färg/Storlek/
  // Vikt…) and each variant carries `optionValues` parallel to them. When a
  // product has options, one selector group renders PER option and the chosen
  // combination resolves to a variant; legacy products (no options) keep the
  // old flat single-list picker. `selections` mirrors selectedVariant.optionValues.
  const [options, setOptions] = useState([]);
  const [selections, setSelections] = useState([]);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  // Desktop thumbnail rail: how many show before the "+N" tile (Kent, 2026-08-28 —
  // a many-colourway product produced one endless column). Expanding is per
  // page visit; the rail also auto-expands when the active image is past the limit.
  const THUMB_LIMIT = 4;
  const [showAllThumbs, setShowAllThumbs] = useState(false);
  const [reviewCount, setReviewCount] = useState(16);
  
  // Nike mobile UX: Fixed button visibility state
  const [showFixedButton, setShowFixedButton] = useState(true);
  const regularButtonRef = useRef(null);
  const mobileImageScrollerRef = useRef(null);
  
  const { 
    addToCart,
    isAddedToCartModalVisible, 
    hideAddedToCartModal, 
    lastAddedItem,
    getTotalItems
  } = useCart();

  // Helper function - declared early to avoid temporal dead zone
  // Gallery rule: a variant WITH its own images REPLACES the base set —
  // showing the original's photos under a RED selection misleads. Variants
  // without images (and simple products) show the product's base images.
  // Photos that apply to every colorway are attached to each variant via
  // the admin's "välj från produktens bilder" picker.
  const getProductImages = (p, activeVariant = null) => {
    if (!p) return [];
    const vImages = (Array.isArray(activeVariant?.images) && activeVariant.images.length > 0
      ? activeVariant.images
      : (activeVariant?.image ? [activeVariant.image] : [])).filter(Boolean);
    if (vImages.length > 0) return [...new Set(vImages)];
    const images = [];
    if (p.b2cImageUrl) images.push(p.b2cImageUrl);
    if (p.b2cImageGallery?.length) images.push(...p.b2cImageGallery);
    if (images.length === 0) images.push(getProductImage(p));
    return images;
  };

  // Calculate productImages early to avoid temporal dead zone issues
  const productImages = getProductImages(product, selectedVariant);
  // Share/crawler image: the product's canonical image, NOT the selected
  // variant's (og:image must not depend on which variant auto-selected).
  const shareImage = getProductImages(product, null)[0];
  
  // Calculate button state based on launch date
  const buttonState = product ? getButtonState(product, t) : { text: '', disabled: true, isComingSoon: false };

  useEffect(() => {
    if (slug) {
      loadProductAndVariants();
    }
  }, [slug, shopId]);

  // Nike mobile UX: show the fixed bottom bar when the inline add-to-cart
  // button scrolls out of view. IntersectionObserver instead of a scroll
  // listener — no per-scroll React renders. Re-runs when `product` lands
  // because the observed button only exists after loading.
  useEffect(() => {
    const el = regularButtonRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setShowFixedButton(!entry.isIntersecting)
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [product]);

  // Nike mobile UX: Track image scroll position
  useEffect(() => {
    const handleImageScroll = () => {
      const container = mobileImageScrollerRef.current;
      if (container) {
        const scrollLeft = container.scrollLeft;
        const containerWidth = container.offsetWidth;
        const newIndex = Math.round(scrollLeft / containerWidth);
        setActiveImageIndex(Math.max(0, Math.min(newIndex, productImages.length - 1)));
      }
    };

    const container = mobileImageScrollerRef.current;
    if (container) {
      container.addEventListener('scroll', handleImageScroll);
      return () => container.removeEventListener('scroll', handleImageScroll);
    }
  }, [productImages.length, product]);

  const loadProductAndVariants = async () => {
    try {
      setLoading(true);
      
      const sku = getSkuFromSlug(slug);
      if (!sku) {
        console.error('Product not found: invalid slug', slug);
        navigate(getCountryAwareUrl(''));
        return;
      }
      
      const productsRef = collection(db, 'productsPublic');
      const productQuery = query(productsRef, where('shopId', '==', shopId), where('sku', '==', sku), where('isActive', '==', true), where('availability.b2c', '==', true));
      const querySnapshot = await getDocs(productQuery);

      if (querySnapshot.empty) {
        console.error('Product not found: no matching documents', sku);
        navigate(getCountryAwareUrl(''));
        return;
      }

      const mainProduct = { id: querySnapshot.docs[0].id, ...querySnapshot.docs[0].data() };
      setProduct(mainProduct);

      // Variants are embedded on the product. Presence is derived from the
      // ROWS (not the hasVariants bool) — the server sells whatever rows
      // exist, so a hand-edited doc must render the same way it charges.
      const embedded = Array.isArray(mainProduct.variants)
        ? mainProduct.variants.filter((v) => v && (v.sku || '').trim())
        : [];
      setVariants(embedded);
      setSelectedVariant(embedded.length > 0 ? embedded[0] : null);

      // Options (model v2.1): only trusted when every variant carries a full
      // optionValues combo — otherwise fall back to the legacy flat picker.
      const normalizedOptions = (Array.isArray(mainProduct.options) ? mainProduct.options : [])
        .filter((o) => o && Array.isArray(o.values))
        .map((o) => ({
          name: o.name || '',
          values: o.values
            .map((v) => (typeof v === 'string' ? { value: v, image: '' } : { value: v?.value || '', image: v?.image || '' }))
            .filter((v) => v.value),
        }))
        .filter((o) => o.values.length > 0);
      const matrixOk =
        normalizedOptions.length > 0 &&
        embedded.length > 0 &&
        embedded.every((v) => Array.isArray(v.optionValues) && v.optionValues.length === normalizedOptions.length);
      setOptions(matrixOk ? normalizedOptions : []);
      setSelections(matrixOk ? embedded[0].optionValues : []);

      // Deep-link: ?v=<variantSku> preselects a variant (shared links keep
      // "the red one", refresh keeps the choice). Ignored if the sku is gone.
      const requestedSku = new URLSearchParams(window.location.search).get('v');
      if (requestedSku) {
        const requested = embedded.find((v) => v.sku === requestedSku);
        if (requested) {
          setSelectedVariant(requested);
          if (matrixOk && Array.isArray(requested.optionValues)) setSelections(requested.optionValues);
        }
      }

    } catch (error) {
      console.error('Error loading product:', error);
      // Navigation error - handled by redirecting to home
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const fetchReviewCount = async () => {
      try {
        const stats = await getReviewStats();
        setReviewCount(stats.totalReviews);
      } catch (error) {
        console.error('Error loading review count:', error);
      }
    };
    fetchReviewCount();
  }, []);

  // Pick a value for one option. Prefer the exact combination with the other
  // current selections; if that combo doesn't exist (removed in admin), jump
  // to the first variant that has this value — same behavior as Shopify.
  const selectOptionValue = (oi, value) => {
    const desired = selections.map((s, i) => (i === oi ? value : s));
    let match = variants.find((v) => v.optionValues.every((x, i) => x === desired[i]));
    if (!match) match = variants.find((v) => v.optionValues[oi] === value);
    if (!match) return;
    setSelections(match.optionValues);
    setSelectedVariant(match);
  };

  // When the variant changes: show its image (desktop swaps the main image,
  // mobile scrolls to it). A variant without an image resets to the first
  // image — also keeps the index in range now that the gallery is per-variant.
  useEffect(() => {
    if (!selectedVariant) return;
    const imgs = getProductImages(product, selectedVariant);
    const found = selectedVariant.image ? imgs.indexOf(selectedVariant.image) : -1;
    const idx = found >= 0 ? found : 0;
    setActiveImageIndex(idx);
    const container = mobileImageScrollerRef.current;
    if (container) container.scrollTo({ left: idx * container.offsetWidth, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVariant]);

  // Mirror the selection into ?v= so the URL is always shareable. replaceState
  // (not navigate) — no re-render, no history spam, other params preserved.
  useEffect(() => {
    if (!product || !selectedVariant?.sku) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('v') === selectedVariant.sku) return;
    url.searchParams.set('v', selectedVariant.sku);
    window.history.replaceState({}, '', url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVariant]);

  const handleAddToCart = () => {
    if (!product) return;
    // Pass the chosen variant (or null). CartContext stamps the variant's sku/
    // label/price onto the line item; the server reprices from the parent doc.
    addToCart(product, quantity, selectedVariant);
    // Success feedback now handled by AddedToCartModal
  };

  // SEO and rendering helpers
  const getB2cDescription = (p) => getContentValue(p?.descriptions?.b2c) || '';

  // The price to display/charge: the selected variant's, else the product's.
  const currentPrice = selectedVariant?.price ?? (product?.b2cPrice || product?.basePrice);
  // Product-level REA: the was-price when it's genuinely above what's paid now.
  const compareAtPrice = getCompareAtPrice(product, currentPrice);

  // Delivery & Pickup v2: what delivery the customer can actually use for THIS
  // product, cross-checked against the shop's configuration.
  //  • product.delivery flags (default-ON: a product without the field is both).
  //  • shopOffersPickup: the shop must actually have pickup locations, else a
  //    "pickup available" hint would be a lie (admin↔shop cross-check).
  // The same product flags drive the checkout method restriction (Slice 4) and
  // the server enforcement, so this hint matches the real options at checkout.
  const productAllowsShipping = product?.delivery?.shipping !== false;
  const productAllowsPickup = product?.delivery?.pickup !== false;
  const shopOffersPickup = Array.isArray(store?.pickupLocations) && store.pickupLocations.length > 0;
  const canShip = productAllowsShipping;
  const canPickup = productAllowsPickup && shopOffersPickup;

  // A single truthful delivery line, reused by both layouts. Renders nothing
  // when neither mode is available (defensive — Slice 4 blocks such carts).
  const DeliveryInfo = () => {
    if (canShip && canPickup) {
      return (
        <p className="text-sm text-ink-muted">
          {t('product_delivery_both', 'Hemleverans eller upphämtning (Click & Collect) i kassan.')}
        </p>
      );
    }
    if (canPickup && !canShip) {
      return (
        <p className="text-sm text-ink-muted">
          {t('product_delivery_pickup_only', 'Endast upphämtning (Click & Collect) i kassan.')}
        </p>
      );
    }
    if (canShip && !canPickup) {
      return (
        <p className="text-sm text-ink-muted">
          {t('product_delivery_shipping_only', 'Endast hemleverans.')}
        </p>
      );
    }
    return null;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas font-body flex items-center justify-center">
        <div className="relative">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-accent"></div>
          <div className="absolute inset-0 animate-ping rounded-full h-16 w-16 border-b-2 border-accent opacity-20"></div>
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="min-h-screen bg-canvas font-body flex items-center justify-center">
        <div className="text-center">
          <h1 className="font-display text-2xl font-bold text-ink mb-4">{t('product_not_found_page_title', 'Produkten hittades inte')}</h1>
          <Link to={getCountryAwareUrl('')} className="bg-accent text-white px-6 py-3 rounded-full hover:opacity-90 transition-opacity">
            {t('back_to_shop', 'Tillbaka till butiken')}
          </Link>
        </div>
      </div>
    );
  }

  // Show the variant picker only when the product actually has variants. A
  // simple product (no variants) shows no picker — model-level fix for the old
  // "8× Standard" bug.
  const showVariantPicker = variants.length > 0;

  // Model v2.2 (variant rail): rows carry `group` (the variant's name, e.g.
  // "Svart") and `size` (nullable). Purely derived — selection state lives in
  // selectedVariant alone. Only trusted when EVERY row is grouped; otherwise
  // the v2.1 options path or the legacy flat picker takes over below.
  const grouped = variants.length > 0 && variants.every((v) => typeof v.group === 'string' && v.group);
  const groupLabels = grouped ? [...new Set(variants.map((v) => v.group))] : [];
  const groupImage = (label) => variants.find((v) => v.group === label)?.image || product?.b2cImageUrl || '';
  const groupSizes = (label) => variants.filter((v) => v.group === label && v.size).map((v) => v.size);
  const currentSizes = grouped && selectedVariant ? groupSizes(selectedVariant.group) : [];

  // Switch variant, keeping the current size when the new variant has it
  // (sizes can differ per variant — fall back to its first row).
  const selectGroup = (label) => {
    const rows = variants.filter((v) => v.group === label);
    if (rows.length === 0) return;
    const sameSize = rows.find((v) => v.size === selectedVariant?.size);
    setSelectedVariant(sameSize || rows[0]);
  };
  const selectSize = (size) => {
    const row = variants.find((v) => v.group === selectedVariant?.group && v.size === size);
    if (row) setSelectedVariant(row);
  };

  // The variant picker, shared by the mobile and desktop layouts (they differ
  // only in grid/padding classes). Three render paths, newest first:
  //  1. grouped (v2.2 rail): variant buttons WITH thumbnails + a size row
  //  2. options (v2.1 matrix): one button group per option axis
  //  3. legacy flat list
  const renderVariantPicker = (headingCls, gridCls, btnPadCls) =>
    grouped ? (
      /* Compact swatch chips — the thumbnail is just a small color cue; the
         full image shows in the viewer when the variant is selected. */
      <div className="space-y-5">
        <div>
          <h3 className={headingCls}>{t('select_variant', 'Välj')}</h3>
          <div className="flex flex-wrap gap-2">
            {groupLabels.map((label) => {
              const isSelected = selectedVariant?.group === label;
              const thumb = groupImage(label);
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => selectGroup(label)}
                  className={`flex items-center gap-2 rounded-el border px-3 py-1.5 transition-all ${
                    isSelected ? 'border-ink bg-ink text-white' : 'border-ink/15 bg-white hover:border-ink/40'
                  }`}
                >
                  {thumb && (
                    <img src={thumb} alt="" className="h-7 w-7 rounded-[6px] object-cover" />
                  )}
                  <span className="text-sm font-medium">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
        {currentSizes.length > 0 && (
          <div>
            <h3 className={headingCls}>{t('select_size', 'Storlek')}</h3>
            <div className="flex flex-wrap gap-2">
              {currentSizes.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => selectSize(size)}
                  className={`min-w-[3rem] rounded-el border px-3 py-1.5 text-center text-sm font-medium uppercase transition-all ${
                    selectedVariant?.size === size ? 'border-ink bg-ink text-white' : 'border-ink/15 bg-white hover:border-ink/40'
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    ) : options.length > 0 ? (
      <div className="space-y-6">
        {options.map((opt, oi) => (
          <div key={opt.name || oi}>
            <h3 className={headingCls}>{opt.name || t('select_variant', 'Välj')}</h3>
            <div className={gridCls}>
              {opt.values.map((val) => {
                const isSelected = selections[oi] === val.value;
                // A value no variant carries (its combos were all removed in
                // admin) renders disabled instead of silently doing nothing.
                const available = variants.some((v) => v.optionValues[oi] === val.value);
                return (
                  <button
                    key={val.value}
                    type="button"
                    disabled={!available}
                    onClick={() => selectOptionValue(oi, val.value)}
                    className={`${btnPadCls} text-center border rounded-el transition-all ${
                      isSelected
                        ? 'border-ink bg-ink text-white'
                        : available
                          ? 'border-ink/15 bg-white hover:border-ink/40'
                          : 'border-ink/10 bg-white text-ink/30 line-through cursor-not-allowed'
                    }`}
                  >
                    <div className="text-sm font-medium">{val.value}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    ) : (
      <div>
        <h3 className={headingCls}>{t('select_variant', 'Välj')}</h3>
        <div className={gridCls}>
          {variants.map((variant) => (
            <button
              key={variant.sku}
              type="button"
              onClick={() => setSelectedVariant(variant)}
              className={`${btnPadCls} text-center border rounded-el transition-all ${
                selectedVariant?.sku === variant.sku
                  ? 'border-ink bg-ink text-white'
                  : 'border-ink/15 bg-white hover:border-ink/40'
              }`}
            >
              <div className="text-sm font-medium">{variant.label || variant.sku}</div>
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <>
      <Helmet>
        <title>{getProductSeoTitle(product)}</title>
        <meta name="description" content={getProductSeoDescription(product)} />
        <meta property="og:type" content="product" />
        <meta property="og:title" content={getProductSeoTitle(product)} />
        <meta property="og:description" content={getProductSeoDescription(product)} />
        {shareImage && <meta property="og:image" content={shareImage} />}
        <meta property="og:url" content={window.location.href} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={getProductSeoTitle(product)} />
        <meta name="twitter:description" content={getProductSeoDescription(product)} />
        {shareImage && <meta name="twitter:image" content={shareImage} />}
        <script type="application/ld+json">{JSON.stringify(generateProductSchema(product))}</script>
      </Helmet>
      <SeoHreflang />
      
      <div className="min-h-screen bg-canvas font-body text-ink">
        <ShopNavigation breadcrumb={getContentValue(product?.name)} breadcrumbCategory={product?.category || null} />
        
        {/* Nike Mobile Layout: Product info ABOVE images */}
        <div className="lg:hidden">
          <div className="px-4 py-6">
            {/* Nike Mobile: Product info first */}
            <div className="mb-6">
              <h1 className="font-display text-2xl font-bold tracking-tight text-ink mb-2">
                {getContentValue(product.name)}
              </h1>
              {/* Short description — only when set; no name fallback (would dupe the title). */}
              {getB2cDescription(product) && (
                <p className="text-base text-ink-muted mb-4">
                  {getB2cDescription(product)}
                </p>
              )}
              {/* More information (admin "Mer information") — above the price. */}
              {product?.descriptions?.b2cMoreInfo && (
                <div
                  className="prose prose-sm max-w-none text-ink-muted mb-4"
                  dangerouslySetInnerHTML={{ __html: sanitize(getContentValue(product.descriptions.b2cMoreInfo)) }}
                />
              )}
              <div className="font-display">
                <SmartPrice
                  sekPrice={currentPrice}
                  size="large"
                  showOriginal={false}
                />
              </div>
            </div>
          </div>

          {/* Nike Mobile: Touch scrollable images */}
          <div className="w-full">
            <div ref={mobileImageScrollerRef} className="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide">
              {productImages.map((image, index) => (
                <div key={index} className="w-full shrink-0 snap-center">
                  <div className="aspect-square bg-white">
                    <img
                      src={image}
                      alt={`${getContentValue(product.name)} ${index + 1}`}
                      className="w-full h-full object-cover"
                    />
                  </div>
                </div>
              ))}
            </div>
            
            {/* Nike Mobile: Image indicators */}
            {productImages.length > 1 && (
              <div className="flex justify-center mt-4 space-x-2">
                {productImages.map((_, index) => (
                  <button
                    key={index}
                    onClick={() => {
                      const container = mobileImageScrollerRef.current;
                      if (container) container.scrollTo({ left: index * container.offsetWidth, behavior: 'smooth' });
                    }}
                    className={`w-2 h-2 rounded-full transition-colors ${
                      index === activeImageIndex ? 'bg-ink' : 'bg-ink/20'
                    }`}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Nike Mobile: Product details below images */}
          <div className="px-4 py-6 space-y-4">
            {/* Variant Selection — only when the product has variants */}
            {showVariantPicker &&
              renderVariantPicker('text-base font-semibold text-ink mb-2', 'grid grid-cols-2 gap-2', 'py-2 px-3')}

            {/* Nike Mobile: Quantity Selector */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-ink">
                  {t('quantity_label', 'Antal')}
                </label>
                <div className="flex items-center border border-ink/15 bg-white rounded-full">
                  <button
                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    className="px-3 py-2 text-ink-muted hover:text-ink transition-colors"
                    disabled={quantity <= 1}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                    </svg>
                  </button>
                  <span key={quantity} className="px-4 py-2 text-sm font-bold text-ink min-w-12 text-center tabular-nums animate-badge-pop">
                    {quantity}
                  </span>
                  <button
                    onClick={() => setQuantity(quantity + 1)}
                    className="px-3 py-2 text-ink-muted hover:text-ink transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* Nike Mobile: Regular Add to Cart button (tracked for visibility) */}
            <div className="space-y-3" ref={regularButtonRef}>
              <button
                onClick={buttonState.disabled ? undefined : handleAddToCart}
                disabled={buttonState.disabled}
                className={`w-full py-3 px-6 rounded-full text-base font-bold transition-[opacity,transform] duration-150 ease-nord active:scale-[0.98] ${
                  buttonState.isComingSoon 
                    ? 'bg-ink-faint text-white cursor-not-allowed' 
                    : 'bg-accent text-white hover:opacity-90'
                }`}
              >
                {buttonState.text}
              </button>
            </div>

            {/* Additional product info — Klarna + product-aware delivery line */}
            <div className="border-t pt-6 space-y-2">
              <p className="text-sm text-ink-muted">
                <span className="font-medium">Klarna.</span> {t('klarna_available_at_checkout', 'är tillgängligt i kassan.')}
              </p>
              <DeliveryInfo />
            </div>
          </div>
        </div>

        {/* Desktop Layout: Keep original design */}
        <div className="hidden lg:block">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="flex flex-col lg:flex-row gap-16">
              {/* Desktop Product Images */}
              <div className="lg:w-1/2">
                <div className="flex gap-4 sticky top-24">
                  {/* Thumbnail Images - Left Side.
                      A product with every colourway (tee × 10 colours × front/back)
                      used to render one thumbnail per image in a single column that
                      ran far below the fold. Now: the first THUMB_LIMIT show, the
                      slot after them is a "+N" tile that expands the rail, and the
                      expanded rail is capped to the main image's height and scrolls.
                      Selecting a variant whose image sits past the limit expands
                      automatically so the active thumbnail is never hidden. */}
                  {productImages.length > 1 && (() => {
                    const expanded = showAllThumbs || activeImageIndex >= THUMB_LIMIT;
                    const visible = expanded ? productImages : productImages.slice(0, THUMB_LIMIT);
                    const hidden = productImages.length - visible.length;
                    return (
                      <div className={`flex flex-col gap-2 w-20 shrink-0 ${expanded ? 'max-h-[32rem] overflow-y-auto overscroll-contain pr-1' : ''}`}>
                        {visible.map((image, index) => (
                          <button
                            key={index}
                            onMouseEnter={() => setActiveImageIndex(index)}
                            className={`aspect-square shrink-0 bg-white rounded-el overflow-hidden border-2 transition-all ${
                              activeImageIndex === index
                                ? 'border-ink'
                                : 'border-transparent hover:border-ink/30'
                            }`}
                          >
                            <img
                              src={image}
                              alt={`${getContentValue(product.name)} ${index + 1}`}
                              className="w-full h-full object-cover"
                            />
                          </button>
                        ))}
                        {hidden > 0 && (
                          <button
                            type="button"
                            onClick={() => setShowAllThumbs(true)}
                            aria-label={t('product_show_all_images', 'Visa alla bilder')}
                            className="aspect-square shrink-0 bg-white rounded-el border-2 border-transparent hover:border-ink/30 transition-all flex items-center justify-center text-sm font-semibold text-ink"
                          >
                            +{hidden}
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  
                  {/* Main Image */}
                  <div className="flex-1">
                    <div className="aspect-square bg-white rounded-tile shadow-tile overflow-hidden">
                      <img
                        src={productImages[Math.min(activeImageIndex, productImages.length - 1)]}
                        alt={getContentValue(product.name)}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Desktop Product Details */}
              <div className="lg:w-1/2 space-y-8">
                {/* Product Title */}
                <div>
                  <h1 className="font-display text-4xl font-bold tracking-tight text-ink mb-2">
                    {getContentValue(product.name)}
                  </h1>
                  {/* Short description — only when set; no name fallback (would dupe the title). */}
                  {getB2cDescription(product) && (
                    <p className="text-lg text-ink-muted mb-4">
                      {getB2cDescription(product)}
                    </p>
                  )}

                {/* More information (admin "Mer information" / b2cMoreInfo) —
                    shown above the price per the storefront content order. */}
                  {product?.descriptions?.b2cMoreInfo && (
                    <div
                      className="prose prose-sm max-w-none text-ink-muted mb-6"
                      dangerouslySetInnerHTML={{ __html: sanitize(getContentValue(product.descriptions.b2cMoreInfo)) }}
                    />
                  )}

                {/* Size guide (admin "Storleksguide" / sizeGuide) — plain text. */}
                  {product?.sizeGuide && getContentValue(product.sizeGuide) && (
                    <details className="mb-6 rounded-el border border-line">
                      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink">
                        {t('product_size_guide', 'Storleksguide')}
                      </summary>
                      <div className="whitespace-pre-line px-4 pb-4 text-sm text-ink-muted">
                        {getContentValue(product.sizeGuide)}
                      </div>
                    </details>
                  )}

                {/* Made-to-order / no-withdrawal notice for personalized products. */}
                  {product?.isPersonalized === true && (
                    <p className="mb-6 rounded-el border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm text-ink-muted">
                      {t('product_made_to_order', 'Specialtillverkad produkt — tillverkas på beställning. Ingen ångerrätt (14-dagars ångerrätt gäller ej för specialtillverkade varor). Du godkänner detta i kassan.')}
                    </p>
                  )}

                {/* Price */}
                  <div className="font-display mb-6">
                    {compareAtPrice && (
                      <div className="flex items-center gap-3 mb-1">
                        <span className="text-base text-ink-muted line-through">
                          <SmartPrice sekPrice={compareAtPrice} showOriginal={false} />
                        </span>
                        <span className="text-xs font-bold uppercase tracking-wide bg-accent text-white px-2.5 py-1 rounded-full">
                          Rea
                        </span>
                      </div>
                    )}
                    <SmartPrice
                      sekPrice={currentPrice}
                      size="large"
                      showOriginal={false}
                      className={'font-display ' + (compareAtPrice ? 'text-accent' : '')}
                    />
                  </div>
                </div>

                {/* Variant Selection — only when the product has variants */}
                {showVariantPicker &&
                  renderVariantPicker('text-base font-semibold text-ink mb-4', 'grid grid-cols-3 gap-2', 'py-4 px-4')}

                {/* Quantity Selector */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-semibold text-ink">
                      {t('quantity_label', 'Antal')}
                    </label>
                    <div className="flex items-center border border-ink/15 bg-white rounded-full">
                      <button
                        onClick={() => setQuantity(Math.max(1, quantity - 1))}
                        className="px-3 py-2 text-ink-muted hover:text-ink transition-colors"
                        disabled={quantity <= 1}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                        </svg>
                      </button>
                      <span key={quantity} className="px-4 py-2 text-sm font-bold text-ink min-w-12 text-center tabular-nums animate-badge-pop">
                        {quantity}
                      </span>
                      <button
                        onClick={() => setQuantity(quantity + 1)}
                        className="px-3 py-2 text-ink-muted hover:text-ink transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Add to Cart */}
                <div className="space-y-4">
                  <button
                    onClick={buttonState.disabled ? undefined : handleAddToCart}
                    disabled={buttonState.disabled}
                    className={`w-full py-4 px-8 rounded-full text-base font-bold transition-[opacity,transform] duration-150 ease-nord active:scale-[0.98] ${
                      buttonState.isComingSoon 
                        ? 'bg-ink-faint text-white cursor-not-allowed' 
                        : 'bg-accent text-white hover:opacity-90'
                    }`}
                  >
                    {buttonState.text}
                  </button>
                </div>

                {/* Share row — native share sheet (mobile) + share-intent links. */}
                <ProductSocialShare product={product} />

                {/* Payment + delivery options. The delivery line is product-aware
                    (per-product delivery modes + whether the shop offers pickup),
                    replacing the old unconditional "Click & Collect" claim. */}
                <div className="border-t pt-6 space-y-2">
                  <p className="text-sm text-ink-muted">
                    <span className="font-medium">Klarna.</span> {t('klarna_available_at_checkout', 'är tillgängligt i kassan.')}
                  </p>
                  <DeliveryInfo />
                </div>

                {/* Product Description */}
                <div className="border-t pt-6">
                  <h2 className="font-display text-lg font-bold text-ink mb-4">
                    {t('show_product_information', 'Visa produktinformation')}
                  </h2>
                  <div className="prose prose-sm max-w-none text-ink-muted">
                    <p>{getB2cDescription(product) || getContentValue(product.name)}</p>
                    <ul className="mt-4 space-y-2">
                      {selectedVariant?.label && <li>• {t('product_variant_spec', 'Variant: {{label}}', { label: selectedVariant.label })}</li>}
                      <li>• {t('product_style_spec', 'Art.nr: {{sku}}', { sku: selectedVariant?.sku || product.sku || '' })}</li>
                    </ul>
                  </div>
                </div>

                {/* Reviews Section — native product reviews take precedence once
                    this product has any approved review; otherwise fall back to
                    the legacy Trustpilot section (only when a domain is set); else
                    render nothing (no brand leak / no empty placeholder). */}
                {(product.reviewCount > 0) ? (
                  <div className="border-t pt-6">
                    <ProductReviews shopId={shopId} productId={product.id} product={product} />
                  </div>
                ) : store?.trustpilot?.domain ? (
                  <div className="border-t pt-6">
                    <ReviewsSection
                      productId={product.id}
                      productName={getContentValue(product.name)}
                      reviewCount={reviewCount}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* Nike Mobile: Fixed bottom "Add to cart" button */}
        <div className={`
          lg:hidden fixed bottom-0 left-0 right-0 z-40
          transition-all duration-300 ease-out
          ${showFixedButton ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'}
        `}>
          <div className="bg-white/95 backdrop-blur-md border-t border-ink/10 px-4 py-4 safe-area-inset-bottom">
            <button
              onClick={buttonState.disabled ? undefined : handleAddToCart}
              disabled={buttonState.disabled}
              className={`w-full py-4 px-8 rounded-full text-base font-bold transition-[opacity,transform] duration-150 ease-nord active:scale-[0.98] ${
                buttonState.isComingSoon 
                  ? 'bg-ink-faint text-white cursor-not-allowed' 
                  : 'bg-accent text-white hover:opacity-90'
              }`}
            >
              {buttonState.text}
            </button>
          </div>
        </div>

        {/* Added to Cart Modal */}
        <AddedToCartModal 
          isVisible={isAddedToCartModalVisible}
          onClose={hideAddedToCartModal}
          addedItem={lastAddedItem}
          cartCount={getTotalItems()}
        />
      </div>
      
      <ShopFooter />
    </>
  );
};

export default PublicProductPage;
