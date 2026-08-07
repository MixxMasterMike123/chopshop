import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../../contexts/CartContext';
import { SHIPPING_COSTS } from '../../contexts/CartContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import toast from 'react-hot-toast';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import SeoHreflang from '../../components/shop/SeoHreflang';
import { getCountryAwareUrl, getCartSeoTitle, getCartSeoDescription } from '../../utils/productUrls';
import SmartPrice from '../../components/shop/SmartPrice';
import { Helmet } from 'react-helmet-async';
import { STORE } from '../../config/store';

const ShoppingCart = () => {
  const { cart, updateQuantity, removeFromCart, updateShippingCountry, calculateTotals, applyDiscountCode, removeDiscount, getTotalItems, getShippingTierInfo } = useCart();
  const { t } = useTranslation();
  const { getContentValue } = useContentTranslation();
  const navigate = useNavigate();
  const [discountCodeInput, setDiscountCodeInput] = useState('');

  console.log('[ShoppingCart] Rendering with cart items:', cart.items);

  const { subtotal, vat, shipping, total, discountAmount, discountCode, discountPercentage, discountSource } = calculateTotals();
  
  // Pre-fill discount input if a code is applied to the cart from context
  useEffect(() => {
    if (discountCode) {
      setDiscountCodeInput(discountCode);
    } else {
      setDiscountCodeInput('');
    }
  }, [discountCode]);
  
  const getCountryName = (countryCode) => {
    switch(countryCode) {
        case 'SE': return t('country_sweden', 'Sverige');
        case 'NO': return t('country_norway', 'Norge');
        case 'DK': return t('country_denmark', 'Danmark');
        case 'FI': return t('country_finland', 'Finland');
        case 'IS': return t('country_iceland', 'Island');
        default: return t('country_other', 'Övriga länder');
    }
  }
  
  // Calculate total items in cart
  const totalItems = cart.items.reduce((sum, item) => sum + item.quantity, 0);

  const handleQuantityChange = (productId, newQuantity) => {
    if (newQuantity < 1) {
      removeFromCart(productId);
    } else {
      updateQuantity(productId, newQuantity);
    }
  };

  const handleRemove = (productId) => {
    removeFromCart(productId);
  };

  const handleCountryChange = (event) => {
    updateShippingCountry(event.target.value);
  };

  const handleApplyDiscount = async () => {
    if (!discountCodeInput.trim()) return;

    try {
      const result = await applyDiscountCode(discountCodeInput.trim());
      if (result?.success) {
        toast.success(t('discount_code_applied', 'Rabattkod applicerad!'));
        setDiscountCodeInput('');
      } else {
        toast.error(result?.message || t('invalid_discount_code', 'Ogiltig rabattkod'));
      }
    } catch (error) {
      console.error('Error applying discount code:', error);
      toast.error(t('invalid_discount_code', 'Ogiltig rabattkod'));
    }
  };

  const handleCheckout = () => {
    navigate(getCountryAwareUrl('checkout'));
  };

  return (
    <>
      <Helmet>
        <title>{getCartSeoTitle()}</title>
        <meta name="description" content={getCartSeoDescription()} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={getCartSeoTitle()} />
        <meta property="og:description" content={getCartSeoDescription()} />
        {STORE.logoUrl && <meta property="og:image" content={STORE.logoUrl.startsWith("http") ? STORE.logoUrl : `${window.location.origin}${STORE.logoUrl}`} />}
        <meta property="og:url" content={window.location.href} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={getCartSeoTitle()} />
        <meta name="twitter:description" content={getCartSeoDescription()} />
        {STORE.logoUrl && <meta name="twitter:image" content={STORE.logoUrl.startsWith("http") ? STORE.logoUrl : `${window.location.origin}${STORE.logoUrl}`} />}
      </Helmet>
      <SeoHreflang />
      <div className="min-h-screen bg-canvas font-body text-ink">
        <ShopNavigation breadcrumb={t('cart_breadcrumb', 'Varukorg')} />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8">
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-ink mb-6 sm:mb-8">{t('your_cart_title', 'Din Varukorg')}</h1>

          {cart.items.length === 0 ? (
            <div className="text-center py-8 sm:py-12">
              <h2 className="font-display text-xl sm:text-2xl font-bold text-ink mb-4">{t('cart_is_empty_heading', 'Din varukorg är tom')}</h2>
              <p className="text-ink-muted mb-6 sm:mb-8 px-4">{t('cart_empty_description', 'Utforska våra produkter och lägg till något i din varukorg.')}</p>
              <Link
                to={getCountryAwareUrl('')}
                className="inline-block bg-accent text-white px-6 sm:px-8 py-3 sm:py-4 rounded-full text-base sm:text-lg font-bold transition-[transform,box-shadow] duration-300 ease-nord shadow-tile hover:shadow-lift hover:-translate-y-0.5 active:translate-y-0"
              >
                {t('continue_shopping', 'Fortsätt handla')}
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-8">
              {/* Cart Items */}
              <div className="lg:col-span-2 space-y-4">
                {cart.items.map((item) => {
                  const itemName = getContentValue(item.name);
                  return (
                    <div
                      key={item.lineId}
                      className="bg-white rounded-tile p-4 sm:p-6 shadow-tile"
                    >
                      {/* Mobile: Stacked layout, Desktop: Horizontal layout */}
                      <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
                        {/* Product Image */}
                        <img
                          src={item.image}
                          alt={itemName}
                          className="w-20 h-20 sm:w-24 sm:h-24 object-cover rounded-el self-center sm:self-start bg-white"
                        />
                        
                        {/* Product Details */}
                        <div className="grow text-center sm:text-left">
                          <h3 className="font-display text-lg font-bold text-ink mb-2">{itemName}</h3>
                          
                          {/* Product Specs — variant label + SKU (v2). */}
                          <div className="space-y-1 text-sm text-ink-muted mb-3">
                            {item.label && (
                              <p className="inline-block bg-canvas px-2.5 py-1 rounded-full mr-2 mb-1 text-xs font-semibold">
                                {item.label}
                              </p>
                            )}
                            {item.sku && (
                              <p className="text-xs text-ink-faint block sm:hidden">
                                {item.sku}
                              </p>
                            )}
                          </div>
                          
                          {/* Price - Mobile: Large, Desktop: Normal */}
                          <div className="mb-4 sm:mb-2">
                            <SmartPrice 
                              sekPrice={item.price} 
                              variant="compact"
                              showOriginal={false}
                              className="font-display font-bold text-lg sm:text-base"
                            />
                          </div>
                        </div>

                        {/* Quantity and Remove - Mobile: Stacked, Desktop: Horizontal */}
                        <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-4">
                          {/* Quantity Selector - Mobile: Large touch targets */}
                          <div className="flex items-center rounded-full border border-ink/15 bg-white">
                            <button
                              onClick={() => handleQuantityChange(item.lineId, item.quantity - 1)}
                              className="w-12 h-12 sm:w-10 sm:h-10 flex items-center justify-center text-ink-muted hover:text-ink transition-colors rounded-l-full"
                            >
                              <span className="text-xl font-bold">−</span>
                            </button>
                            <span className="w-16 h-12 sm:w-12 sm:h-10 flex items-center justify-center text-lg font-bold tabular-nums border-x border-ink/10">
                              {item.quantity}
                            </span>
                            <button
                              onClick={() => handleQuantityChange(item.lineId, item.quantity + 1)}
                              className="w-12 h-12 sm:w-10 sm:h-10 flex items-center justify-center text-ink-muted hover:text-ink transition-colors rounded-r-full"
                            >
                              <span className="text-xl font-bold">+</span>
                            </button>
                          </div>
                          
                          {/* Remove Button - Mobile: Large touch target */}
                          <button
                            onClick={() => handleRemove(item.lineId)}
                            className="w-12 h-12 sm:w-8 sm:h-8 flex items-center justify-center text-ink-faint hover:text-red-600 hover:bg-red-50 rounded-full transition-colors"
                          >
                            <svg 
                              className="w-6 h-6 sm:w-5 sm:h-5" 
                              fill="none" 
                              stroke="currentColor" 
                              viewBox="0 0 24 24"
                            >
                              <path 
                                strokeLinecap="round" 
                                strokeLinejoin="round" 
                                strokeWidth="2" 
                                d="M6 18L18 6M6 6l12 12" 
                              />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Order Summary */}
              <div className="lg:col-span-1 space-y-4 sm:space-y-6">
                {/* Shipping Country Selection */}
                <div className="bg-white rounded-tile p-4 sm:p-6 shadow-tile">
                  <h3 className="font-display text-base sm:text-lg font-bold text-ink mb-3 sm:mb-4">{t('shipping_country', 'Leveransland')}</h3>
                  <select
                    value={cart.shippingCountry}
                    onChange={handleCountryChange}
                    className="w-full px-3 sm:px-4 py-3 border border-ink/15 bg-white rounded-el focus:outline-hidden focus:ring-4 focus:ring-accent/10 focus:border-accent text-sm sm:text-base transition-colors"
                  >
                    <optgroup label={t('nordic_countries', 'Norden')}>
                      {SHIPPING_COSTS.NORDIC.countries.map(country => (
                        <option key={country} value={country}>
                          {getCountryName(country)}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label={t('other_countries_group', 'Övriga')}>
                      <option value="OTHER">{t('country_other', 'Övriga länder')}</option>
                    </optgroup>
                  </select>
                </div>

                {/* Discount Code Section */}
                <div className="bg-white rounded-tile p-4 sm:p-6 shadow-tile">
                  <h3 className="font-display text-base sm:text-lg font-bold text-ink mb-3 sm:mb-4">{t('discount_code', 'Rabattkod')}</h3>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={discountCodeInput}
                      onChange={(e) => setDiscountCodeInput(e.target.value)}
                      placeholder={t('enter_your_code', 'Ange din kod')}
                      className="w-full px-3 sm:px-4 py-3 border border-ink/15 bg-white rounded-el focus:outline-hidden focus:ring-4 focus:ring-accent/10 focus:border-accent text-sm sm:text-base transition-colors"
                      disabled={!!discountCode}
                    />
                    <button
                      onClick={handleApplyDiscount}
                      disabled={!!discountCode}
                      className="px-4 sm:px-6 py-3 bg-ink text-white font-bold rounded-el hover:opacity-90 disabled:bg-ink-faint disabled:cursor-not-allowed transition-opacity text-sm sm:text-base whitespace-nowrap"
                    >
                      {t('apply_button', 'Applicera')}
                    </button>
                  </div>
                </div>

                {/* Order Summary */}
                <div className="bg-white rounded-tile p-4 sm:p-6 shadow-tile">
                  <h3 className="font-display text-base sm:text-lg font-bold text-ink mb-3 sm:mb-4">{t('order_summary', 'Ordersammanfattning')}</h3>
                  
                  <div className="space-y-2 sm:space-y-3">
                    <div className="flex justify-between text-ink-muted text-sm sm:text-base">
                      <span>{t('subtotal', 'Delsumma')}</span>
                      <SmartPrice 
                        sekPrice={subtotal} 
                        variant="compact"
                        showOriginal={false}
                      />
                    </div>

                    {discountAmount > 0 && (
                       <div className="flex justify-between items-center">
                         <span className="bg-accent/10 text-accent text-xs font-semibold px-2.5 py-1 rounded-full">
                           {discountSource === 'campaign'
                             ? (discountPercentage > 0
                                 ? t('discount_label_percent', 'Rabatt, {{percentage}}%', { percentage: discountPercentage })
                                 : t('discount_label', 'Rabatt'))
                             : t('affiliate_discount_label', 'Affiliate rabatt, {{percentage}}%', { percentage: discountPercentage })}
                         </span>
                         <span className="text-green-600 font-semibold text-sm sm:text-base">
                           - <SmartPrice 
                             sekPrice={discountAmount} 
                             variant="compact"
                             showOriginal={false}
                           />
                         </span>
                       </div>
                    )}

                    <div className="flex justify-between text-ink-muted text-sm sm:text-base">
                      <span>{t('shipping_cost_label', 'Frakt ({{country}})', { country: getCountryName(cart.shippingCountry) })}</span>
                      <SmartPrice 
                        sekPrice={shipping} 
                        variant="compact"
                        showOriginal={false}
                      />
                    </div>
                    
                    {/* Shipping tier explanation */}
                    {getTotalItems() > 3 && (
                      <div className="text-xs text-ink-faint mt-1">
                        {(() => {
                          const tierInfo = getShippingTierInfo(cart.shippingCountry);
                          return tierInfo.explanation;
                        })()}
                      </div>
                    )}
                  </div>

                  <div className="border-t border-ink/10 my-3 sm:my-4"></div>

                  <div className="space-y-1">
                    <div className="flex justify-between font-display font-bold text-ink text-lg sm:text-xl">
                      <span>{t('total', 'Totalt')}</span>
                      <SmartPrice 
                        sekPrice={total} 
                        variant="large"
                        showOriginal={false}
                        className="font-display font-bold text-lg sm:text-xl"
                      />
                    </div>
                    <div className="flex justify-end text-xs sm:text-sm text-ink-faint">
                      <span>
                        {t('vat_included_rate', 'Varav Moms ({{rate}}%) {{amount}} kr', {
                          rate: Math.round(STORE.vatRate * 100),
                          amount: vat.toFixed(2)
                        })}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Checkout Button */}
                <button
                  onClick={handleCheckout}
                  className="w-full bg-accent text-white px-6 sm:px-8 py-4 rounded-full text-base sm:text-lg font-bold transition-[transform,box-shadow] duration-300 ease-nord shadow-tile hover:shadow-lift hover:-translate-y-0.5 active:translate-y-0"
                >
                  {t('go_to_checkout', 'Gå till kassan')}
                </button>

                {/* Continue Shopping Link */}
                <Link
                  to={getCountryAwareUrl('')}
                  className="block text-center text-ink-muted hover:text-ink underline underline-offset-4 transition-colors"
                >
                  {t('or_continue_shopping', 'eller fortsätt handla')}
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <ShopFooter />
      </div>
    </>
  );
};

export default ShoppingCart; 