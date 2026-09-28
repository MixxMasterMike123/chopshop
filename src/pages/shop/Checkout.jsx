import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getProduct } from '../../api/products';
import { toCheckoutTotals } from '../../storefront/adapters/checkout';
import { useCart } from '../../contexts/CartContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import { getCountryAwareUrl, getCheckoutSeoTitle, getCheckoutSeoDescription } from '../../utils/productUrls';
import { translateColor } from '../../utils/colorTranslations';
import toast from 'react-hot-toast';
import ShopNavigation from '../../components/shop/ShopNavigation';
import SeoHreflang from '../../components/shop/SeoHreflang';
import SmartPrice from '../../components/shop/SmartPrice';
import { Helmet } from 'react-helmet-async';
import { 
  ChevronLeftIcon, 
  LockClosedIcon, 
  ShoppingBagIcon 
} from '@heroicons/react/24/outline';
import StripePaymentForm from '../../components/shop/StripePaymentForm';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';
import { formatPickupDayShort } from '../../utils/pickupDates';
import { requiresWithdrawalGate, resolveWithdrawalNotice } from '../../utils/withdrawal';

const Checkout = () => {
  const {
    cart, clearCart, updateShippingCountry, reconcileCart,
    deliveryMethod, pickupLocation, pickupDate, setPickupDate, selectHomeDelivery, selectPickup,
    cartAllowsHome, cartAllowsPickup, hasDeliveryConflict,
  } = useCart();
  const store = useStoreSettings();
  const pickupLocations = Array.isArray(store?.pickupLocations) ? store.pickupLocations : [];

  // The server's answer to the checkout (POST /v1/checkout, sent by the
  // payment form on the payment step): the priced order whose figures the
  // summary shows, or why the shop cannot take it. `waiverRequired`: the
  // server found a personalised line the cart did not flag.
  const [quote, setQuote] = useState(null);
  const [waiverRequired, setWaiverRequired] = useState(false);

  // Right-of-withdrawal (POD): if any cart item is personalized, the buyer must
  // accept the no-withdrawal notice before payment. The notice text + version
  // are the platform's (the server records that version as the proof; a
  // shop's own text is not carried). The server decides which lines are
  // personalised: when it asks for the waiver, the gate shows too.
  const needsWithdrawalGate = requiresWithdrawalGate(cart?.items) || waiverRequired;
  const withdrawalNotice = resolveWithdrawalNotice(store?.legal);
  const [withdrawalAccepted, setWithdrawalAccepted] = useState(false);
  // Has the async shop config resolved? Until then `pickupLocations` is the
  // static default ([]), so we must not conclude "no pickup" yet.
  const storeLoaded = store?.__loaded === true;
  // Delivery & Pickup v2: pickup is offered only when the products allow it AND
  // the shop has pickup locations. Home is offered when the products allow it.
  const shopHasPickup = pickupLocations.length > 0;
  const pickupAvailable = cartAllowsPickup && shopHasPickup;
  const homeAvailable = cartAllowsHome;
  // Both methods selectable → show the chooser. Exactly one → lock to it.
  const showDeliveryChooser = pickupAvailable && homeAvailable;
  const isPickup = deliveryMethod === 'pickup';
  // The cart can't be fulfilled by any available method: either a conflicting
  // mix (pickup-only + shipping-only items) or a pickup-only cart in a shop with
  // no pickup locations configured. Checkout blocks rather than charge wrongly.
  // Gate on storeLoaded so a pickup-only cart at a shop that DOES have locations
  // doesn't briefly flash the block before the config arrives.
  const cannotFulfill =
    storeLoaded && cart.items.length > 0 && !homeAvailable && !pickupAvailable;
  // Distinguish the two block causes for an accurate message:
  //  • a true mix conflict → split the order; vs.
  //  • a pickup-only cart but the shop offers no pickup location → can't be
  //    bought here at all; splitting won't help.
  const blockedByConflict = hasDeliveryConflict;

  // Flatten the shop's pickup config into one selectable OPTION per
  // (location, date) pair — each is a concrete pickup occasion shown as a card.
  // A location with no dates yields a single dateless option. Sorted by date so
  // the earliest occasion is first; a location's dates each become their own card
  // (so "Rökeriet, Onsdag 17/6" and "…Torsdag 18/6" are distinct, selectable).
  // `past` flags dates strictly before today (today's pickup is still valid) so
  // they render disabled rather than vanish — the customer sees the full schedule.
  const todayIso = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local
  const pickupOptions = [];
  for (const loc of pickupLocations) {
    const dates = Array.isArray(loc.dates) ? loc.dates.filter(Boolean) : [];
    if (dates.length === 0) {
      pickupOptions.push({ key: loc.id, loc, date: '', past: false });
    } else {
      for (const d of dates) {
        pickupOptions.push({ key: `${loc.id}::${d}`, loc, date: d, past: d < todayIso });
      }
    }
  }
  pickupOptions.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  // The currently-selected option key (location + chosen date).
  const selectedOptionKey = pickupLocation?.id
    ? (pickupDate ? `${pickupLocation.id}::${pickupDate}` : pickupLocation.id)
    : '';
  // UX: when pickup is the active method and there is exactly ONE selectable
  // pickup occasion, preselect it — the customer shouldn't have to click the
  // only card. With several occasions (e.g. one location, many dates) the
  // choice is real and stays unselected.
  const selectableOptions = pickupOptions.filter((o) => !o.past);
  const onlyOption = selectableOptions.length === 1 ? selectableOptions[0] : null;
  useEffect(() => {
    if (isPickup && !pickupLocation?.id && onlyOption) {
      selectPickup(onlyOption.loc);
      setPickupDate(onlyOption.date || '');
    }
  }, [isPickup, pickupLocation?.id, onlyOption?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Legal readiness: the SERVER is the gate. A shop that may not sell (its
  // platform terms, its legal pages, its payment account) answers the
  // checkout with a 404, and the page then shows the same "not accepting
  // orders" block it showed for the client gate. `null` = not answered yet:
  // treated as open, so the payment form doesn't flash a notice.
  const [legalReady, setLegalReady] = useState(null);
  const checkoutLegallyOpen = legalReady !== false;

  // What the payment form reports of the server's answer.
  const handleCheckoutAnswer = (answer) => {
    setQuote(answer?.status === 'ready' ? answer.checkout : null);
    if (answer?.status === 'closed') setLegalReady(false);
    if (answer?.status === 'waiver_required') setWaiverRequired(true);
  };

  const { t, currentLanguage } = useTranslation();
  // Who the buyer actually contracts with: the seller's registered legal entity,
  // falling back to the shop's trading name.
  // Last resort "butiken" so the sentence never reads "avtal med  och" — the
  // readiness gate flags a missing legalName in admin (`missing`).
  const sellerName = String(store?.legalName || '').trim() || String(store?.shopName || '').trim()
    || t('checkout_terms_seller_fallback', 'butiken');

  const { getContentValue } = useContentTranslation();
  const navigate = useNavigate();

  const [processingPayment, setProcessingPayment] = useState(false);
  const [step, setStep] = useState('contact'); // 'contact', 'shipping', 'payment'

  // Form data
  const [contactInfo, setContactInfo] = useState({
    email: '',
    marketing: false,
  });

  const [shippingInfo, setShippingInfo] = useState({
    firstName: '',
    lastName: '',
    address: '',
    apartment: '',
    postalCode: '',
    city: '',
    country: 'SE'
  });

  // The summary's figures are the SERVER's (the priced checkout of the payment
  // step); before it has priced the order there are none. Nothing here adds,
  // taxes or ships anything.
  const { subtotal, vat, shipping, total, vatRate, discountAmount, discountCode, discountPercentage, discountSource } =
    toCheckoutTotals(step === 'payment' ? quote : null, store.vatRate);
  // A quote belongs to the visit of the payment step that asked for it: the
  // buyer may change the delivery before coming back.
  useEffect(() => {
    if (step !== 'payment') setQuote(null);
  }, [step]);

  // Reconcile the persisted cart against LIVE products once per checkout
  // visit. localStorage carts outlive admin edits — a renamed size / deleted
  // variant / deactivated product would otherwise be refused at checkout
  // with no pointer to the cause. Dropped lines get a toast; surviving lines
  // refresh price/label so the lines shown match the public prices.
  useEffect(() => {
    const ids = [...new Set(cart.items.map((i) => i.productId || i.id).filter(Boolean))];
    if (ids.length === 0) return;
    (async () => {
      try {
        const entries = await Promise.all(
          ids.map(async (id) => {
            // GET /v1/products/:id answers only a product a visitor may see
            // (and buy); anything else is null → the line is removed.
            return [id, await getProduct(id)];
          })
        );
        const removed = reconcileCart(Object.fromEntries(entries));
        if (removed.length > 0) {
          toast.error(
            t(
              'checkout_cart_reconciled',
              'Följande finns inte längre och togs bort ur varukorgen: {{items}}',
              { items: removed.filter(Boolean).join(', ') }
            ),
            { duration: 8000 }
          );
        }
      } catch (e) {
        // Fail open — the server still validates every line at payment.
        console.warn('Cart reconciliation skipped:', e?.message);
      }
    })();
    // Once on mount: re-running on every cart change would loop via setCart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep cart shipping country in sync with the address chosen at checkout,
  // so shipping cost and totals reflect the actual destination
  useEffect(() => {
    if (shippingInfo.country && shippingInfo.country !== cart.shippingCountry) {
      updateShippingCountry(shippingInfo.country);
    }
  }, [shippingInfo.country, cart.shippingCountry, updateShippingCountry]);

  // Delivery & Pickup v2: CartContext auto-corrects between the two product-level
  // methods but can't see the SHOP-level pickup gate. Here we enforce it: if the
  // chosen method is 'pickup' but pickup isn't actually available (no shop
  // locations, or the cart no longer permits pickup), fall back to home delivery
  // whenever home IS available — so a stale pickup can't zero shipping. (When
  // home is also unavailable the cart can't be fulfilled; cannotFulfill blocks
  // the page, so we don't force an invalid method here.)
  useEffect(() => {
    if (deliveryMethod === 'pickup' && !pickupAvailable && homeAvailable) {
      selectHomeDelivery();
    }
  }, [deliveryMethod, pickupAvailable, homeAvailable, selectHomeDelivery]);

  const validateStep = (currentStep) => {
    switch (currentStep) {
      case 'contact':
        if (!contactInfo.email || !contactInfo.email.includes('@')) {
          toast.error(t('checkout_invalid_email', 'Vänligen ange en giltig e-postadress.'));
          return false;
        }
        return true;
      case 'shipping': {
        // Pickup (Click & Collect): only a name + a chosen location are needed —
        // no shipping address. Home delivery requires the full address.
        if (isPickup) {
          if (!pickupLocation?.id) {
            toast.error(t('checkout_pickup_select', 'Välj en upphämtningsplats.'));
            return false;
          }
          // A location that offers specific dates requires a chosen date. With
          // the card UI each card sets the date on click, so this only guards a
          // location whose dates exist but none was picked (defensive).
          const chosenLoc = pickupLocations.find((l) => l.id === pickupLocation.id);
          const chosenLocHasDates = Array.isArray(chosenLoc?.dates) && chosenLoc.dates.filter(Boolean).length > 0;
          if (chosenLocHasDates && !pickupDate) {
            toast.error(t('checkout_pickup_date_select', 'Välj ett upphämtningsdatum.'));
            return false;
          }
          const nameMissing = ['firstName', 'lastName'].filter(f => !shippingInfo[f].trim());
          if (nameMissing.length > 0) {
            toast.error(t('checkout_missing_name', 'Vänligen ange för- och efternamn.'));
            return false;
          }
          return true;
        }
        const required = ['firstName', 'lastName', 'address', 'postalCode', 'city'];
        const missing = required.filter(field => !shippingInfo[field].trim());
        if (missing.length > 0) {
          toast.error(t('checkout_missing_fields', 'Vänligen fyll i alla obligatoriska fält.'));
          return false;
        }
        return true;
      }
      default:
        return true;
    }
  };

  const handleNextStep = () => {
    if (!validateStep(step)) return;
    
    if (step === 'contact') setStep('shipping');
    else if (step === 'shipping') setStep('payment');
  };

  const handlePreviousStep = () => {
    if (step === 'shipping') setStep('contact');
    else if (step === 'payment') setStep('shipping');
  };

  // Handle successful Stripe payment.
  // The order itself is created SERVER-SIDE when the payment provider confirms
  // the payment, so the client never writes orders — it navigates to the
  // confirmation page by the payment's id; that page finds the checkout this
  // tab paid (session storage) and waits for its order (the receipt poll).
  const handlePaymentSuccess = async (paymentIntent) => {
    console.log('✅ Payment successful');

    // Set processing state to prevent empty cart page
    setProcessingPayment(true);

    navigate(getCountryAwareUrl(`order-confirmation/${paymentIntent.id}`));

    // Clear the cart after navigation
    setTimeout(() => {
      clearCart();
      setProcessingPayment(false);
    }, 100);
  };

  // Handle payment errors (the payment provider's own refusals at confirm;
  // the checkout's refusals are the payment form's and handleCheckoutAnswer's).
  const handlePaymentError = (error) => {
    console.error('❌ Payment failed:', error?.code || error?.type || 'error');
    toast.error(t('checkout_payment_failed_with_message', 'Betalning misslyckades: {{message}}', { message: error.message }));
  };


  if (cart.items.length === 0 && !processingPayment) {
    return (
      <div className="min-h-screen bg-canvas font-body text-ink">
        <ShopNavigation />
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <ShoppingBagIcon className="h-16 w-16 text-ink-faint mx-auto mb-4" />
          <h1 className="font-display text-2xl font-bold text-ink mb-4">
            {t('checkout_empty_cart_title', 'Din varukorg är tom')}
          </h1>
          <p className="text-ink-muted mb-8">
            {t('checkout_empty_cart_description', 'Lägg till produkter i din varukorg för att fortsätta till kassan.')}
          </p>
          <button
            onClick={() => navigate(getCountryAwareUrl(''))}
            className="bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity"
          >
            {t('checkout_continue_shopping', 'Fortsätt handla')}
          </button>
        </div>
      </div>
    );
  }

  // Delivery & Pickup v2: the cart can't be received by any available method
  // (a pickup-only + shipping-only mix, or a pickup-only cart with no pickup
  // location at this shop). Block checkout with a clear message instead of
  // charging an unfulfillable order.
  if (cannotFulfill && !processingPayment) {
    return (
      <div className="min-h-screen bg-canvas font-body text-ink">
        <ShopNavigation />
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <ShoppingBagIcon className="h-16 w-16 text-ink-faint mx-auto mb-4" />
          <h1 className="font-display text-2xl font-bold text-ink mb-4">
            {blockedByConflict
              ? t('checkout_delivery_conflict_title', 'Produkterna kan inte levereras tillsammans')
              : t('checkout_pickup_unavailable_title', 'Upphämtning är inte tillgänglig')}
          </h1>
          <p className="text-ink-muted mb-8">
            {blockedByConflict
              ? t('checkout_delivery_conflict_desc', 'Vissa produkter i din varukorg kan bara hämtas och andra bara skickas. Lägg dem i separata beställningar.')
              : t('checkout_pickup_unavailable_desc', 'Produkterna i din varukorg kan bara hämtas, men butiken har inga upphämtningsplatser just nu. Kontakta butiken eller försök igen senare.')}
          </p>
          <button
            onClick={() => navigate(getCountryAwareUrl('cart'))}
            className="bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity"
          >
            {t('checkout_back_to_cart', 'Tillbaka till varukorg')}
          </button>
        </div>
      </div>
    );
  }

  // Show processing spinner when payment is being processed
  if (processingPayment) {
    return (
      <div className="min-h-screen bg-canvas font-body text-ink">
        <ShopNavigation />
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-accent mx-auto mb-4"></div>
          <h1 className="font-display text-2xl font-bold text-ink mb-4">
            {t('checkout_processing_payment', 'Behandlar betalning...')}
          </h1>
          <p className="text-ink-muted mb-8">
            {t('checkout_processing_description', 'Vi behandlar din betalning och skapar din order. Vänta ett ögonblick...')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Helmet>
        <title>{getCheckoutSeoTitle()}</title>
        <meta name="description" content={getCheckoutSeoDescription()} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={getCheckoutSeoTitle()} />
        <meta property="og:description" content={getCheckoutSeoDescription()} />
        {store.logoUrl && <meta property="og:image" content={store.logoUrl} />}
        <meta property="og:url" content={window.location.href} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={getCheckoutSeoTitle()} />
        <meta name="twitter:description" content={getCheckoutSeoDescription()} />
        {store.logoUrl && <meta name="twitter:image" content={store.logoUrl} />}
      </Helmet>
      <SeoHreflang />
      <div className="min-h-screen bg-canvas font-body text-ink">
        <ShopNavigation breadcrumb={t('breadcrumb_checkout', 'Kassa')} />
        
        {/* Header */}
        <div className="bg-white/85 backdrop-blur-md border-b border-ink/10">
          <div className="max-w-7xl mx-auto px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <button
                  onClick={() => navigate(getCountryAwareUrl('cart'))}
                  className="flex items-center text-ink-muted hover:text-ink font-medium transition-colors"
                >
                  <ChevronLeftIcon className="h-5 w-5 mr-1" />
                  {t('checkout_back_to_cart', 'Tillbaka till varukorg')}
                </button>
              </div>
              <div className="font-display text-2xl font-bold text-ink tracking-tight">{store.shopName}</div>
              <div className="flex items-center text-ink-muted text-sm font-medium">
                <LockClosedIcon className="h-5 w-5 mr-2" />
                {t('checkout_secure_checkout', 'Säker kassa')}
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
            
            {/* Left Column - Forms */}
            <div className="space-y-8">

              {/* Escape hatch back to the storefront — visible on every step so
                  the customer is never trapped in checkout. The cart persists
                  (localStorage) so nothing is lost by leaving. Hidden while a
                  payment is being finalized (that state also replaces this whole
                  view with the processing screen — belt and braces). */}
              {!processingPayment && (
                <div>
                  <button
                    type="button"
                    onClick={() => navigate(getCountryAwareUrl(''))}
                    className="inline-flex items-center bg-white border border-ink/15 hover:border-ink/40 text-ink px-4 py-2 rounded-full text-sm font-semibold shadow-tile transition-colors"
                  >
                    <ChevronLeftIcon className="h-4 w-4 mr-1.5" />
                    {t('checkout_continue_shopping', 'Fortsätt handla')}
                  </button>
                </div>
              )}

              {/* Progress Steps */}
              <div className="flex items-center justify-between mb-6 sm:mb-8 px-2">
                <div className={`flex flex-col items-center space-y-1 transition-colors duration-300 ${step === 'contact' ? 'text-accent' : 'text-ink-faint'}`}>
                  <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-xs sm:text-sm font-semibold transition-colors duration-300 ${
                    step === 'contact' ? 'bg-accent text-white' : 'bg-white shadow-tile text-ink-muted'
                  }`}>1</div>
                  <span className="text-xs sm:text-sm font-medium text-center">{t('checkout_step_contact', 'Kontakt')}</span>
                </div>
                <div className="flex-1 h-px bg-ink/15 mx-2 sm:mx-4"></div>
                <div className={`flex flex-col items-center space-y-1 transition-colors duration-300 ${step === 'shipping' ? 'text-accent' : 'text-ink-faint'}`}>
                  <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-xs sm:text-sm font-semibold transition-colors duration-300 ${
                    step === 'shipping' ? 'bg-accent text-white' : 'bg-white shadow-tile text-ink-muted'
                  }`}>2</div>
                  <span className="text-xs sm:text-sm font-medium text-center">{t('checkout_step_shipping', 'Leverans')}</span>
                </div>
                <div className="flex-1 h-px bg-ink/15 mx-2 sm:mx-4"></div>
                <div className={`flex flex-col items-center space-y-1 transition-colors duration-300 ${step === 'payment' ? 'text-accent' : 'text-ink-faint'}`}>
                  <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-xs sm:text-sm font-semibold transition-colors duration-300 ${
                    step === 'payment' ? 'bg-accent text-white' : 'bg-white shadow-tile text-ink-muted'
                  }`}>3</div>
                  <span className="text-xs sm:text-sm font-medium text-center">{t('checkout_step_payment', 'Betalning')}</span>
                </div>
              </div>

              {/* Contact Information */}
              {step === 'contact' && (
                <div className="bg-white rounded-tile p-4 sm:p-6 shadow-tile animate-fade-up">
                  <h2 className="font-display text-lg sm:text-xl font-bold text-ink mb-4 sm:mb-6">
                    {t('checkout_contact_info', 'Kontaktinformation')}
                  </h2>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-semibold text-ink mb-2">
                        {t('checkout_email_label', 'E-postadress *')}
                      </label>
                      <input
                        type="email"
                        value={contactInfo.email}
                        onChange={(e) => setContactInfo({...contactInfo, email: e.target.value})}
                        className="w-full px-3 sm:px-4 py-3 border border-ink/15 bg-white rounded-el focus:outline-hidden focus:ring-4 focus:ring-accent/10 focus:border-accent text-base transition-colors"
                        placeholder={t('checkout_email_placeholder', 'din@epost.se')}
                        required
                      />
                    </div>

                    <div className="flex items-start space-x-3">
                      <input
                        type="checkbox"
                        id="marketing"
                        checked={contactInfo.marketing}
                        onChange={(e) => setContactInfo({...contactInfo, marketing: e.target.checked})}
                        className="h-4 w-4 text-accent accent-[var(--color-accent)] focus:ring-accent/30 border-ink/20 rounded-sm mt-0.5 shrink-0"
                      />
                      <label htmlFor="marketing" className="text-sm text-ink-muted leading-relaxed">
                        {t('checkout_marketing_opt_in', 'Skicka mig nyheter och erbjudanden via e-post')}
                      </label>
                    </div>
                  </div>
                  <button
                    onClick={handleNextStep}
                    className="mt-6 w-full bg-accent text-white px-4 sm:px-6 py-3.5 rounded-full font-bold hover:opacity-90 transition-opacity text-base"
                  >
                    {t('checkout_continue_shipping', 'Fortsätt till leveransadress')}
                  </button>
                </div>
              )}

              {/* Shipping Information */}
              {step === 'shipping' && (
                <div className="bg-white rounded-tile p-4 sm:p-6 shadow-tile animate-fade-up">
                  <div className="flex items-center justify-between mb-4 sm:mb-6">
                    <h2 className="font-display text-lg sm:text-xl font-bold text-ink">
                      {t('checkout_shipping_address', 'Leveransadress')}
                    </h2>
                    <button
                      onClick={handlePreviousStep}
                      className="text-ink-muted hover:text-ink font-medium text-sm sm:text-base underline underline-offset-4"
                    >
                      {t('checkout_change', 'Ändra')}
                    </button>
                  </div>
                  
                  <div className="mb-4 p-3 bg-canvas rounded-el">
                    <div className="text-sm text-ink-muted">{t('checkout_contact_label', 'Kontakt')}</div>
                    <div className="font-medium text-sm sm:text-base">{contactInfo.email}</div>
                  </div>

                  {/* Delivery method (Click & Collect). Shown whenever pickup is
                      an option for this cart (products allow it AND the shop has
                      locations). Per-product delivery modes can disable one side:
                      the chooser appears only when BOTH are available; otherwise
                      the single available method is locked in. Pickup zeroes
                      shipping (mirrored server-side for total-parity). */}
                  {pickupAvailable && (
                    <div className="mb-6">
                      <div className="text-sm font-semibold text-ink mb-2">
                        {t('checkout_delivery_method', 'Leveranssätt')}
                      </div>
                      {showDeliveryChooser ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <button
                            type="button"
                            onClick={() => selectHomeDelivery()}
                            className={`text-left p-3 rounded-el border transition-colors ${!isPickup ? 'border-accent ring-2 ring-accent/20 bg-accent/5' : 'border-ink/15 hover:border-ink/30'}`}
                          >
                            <div className="font-semibold text-sm text-ink">{t('checkout_home_delivery', 'Hemleverans')}</div>
                            <div className="text-xs text-ink-muted">{t('checkout_home_delivery_desc', 'Skickas till din adress')}</div>
                          </button>
                          <button
                            type="button"
                            onClick={() => selectPickup(pickupLocation || null)}
                            className={`text-left p-3 rounded-el border transition-colors ${isPickup ? 'border-accent ring-2 ring-accent/20 bg-accent/5' : 'border-ink/15 hover:border-ink/30'}`}
                          >
                            <div className="font-semibold text-sm text-ink">{t('checkout_pickup', 'Upphämtning')}</div>
                            <div className="text-xs text-ink-muted">{t('checkout_pickup_desc', 'Hämta i butik – ingen fraktkostnad')}</div>
                          </button>
                        </div>
                      ) : (
                        // Pickup-only cart (home delivery disabled for these
                        // products): the method is locked to pickup, shown as info.
                        <div className="p-3 rounded-el border border-accent ring-2 ring-accent/20 bg-accent/5">
                          <div className="font-semibold text-sm text-ink">{t('checkout_pickup', 'Upphämtning')}</div>
                          <div className="text-xs text-ink-muted">{t('checkout_pickup_only_notice', 'Dessa produkter kan endast hämtas – ingen fraktkostnad.')}</div>
                        </div>
                      )}

                      {isPickup && (
                        <div className="mt-3">
                          <label className="block text-sm font-semibold text-ink mb-2">
                            {t('checkout_pickup_location', 'Upphämtningsplats *')}
                          </label>
                          {/* One selectable card per pickup occasion (location +
                              date), all visible at once — same card style as the
                              delivery-method toggle above. Past dates render
                              disabled (shown for context, not selectable). */}
                          <div className="space-y-2">
                            {pickupOptions.map((opt) => {
                              const selected = selectedOptionKey === opt.key;
                              const place = [opt.loc.name, opt.loc.address].filter(Boolean).join(' – ');
                              const dayLine = [opt.date ? formatPickupDayShort(opt.date) : '', opt.loc.hours]
                                .filter(Boolean).join(' · ');
                              return (
                                <button
                                  key={opt.key}
                                  type="button"
                                  disabled={opt.past}
                                  onClick={() => {
                                    selectPickup(opt.loc);
                                    setPickupDate(opt.date || '');
                                  }}
                                  aria-pressed={selected}
                                  className={`w-full text-left p-3 rounded-el border transition-colors ${
                                    opt.past
                                      ? 'border-ink/10 bg-ink/[0.03] opacity-50 cursor-not-allowed'
                                      : selected
                                        ? 'border-accent ring-2 ring-accent/20 bg-accent/5'
                                        : 'border-ink/15 hover:border-ink/30'
                                  }`}
                                >
                                  <div className="font-semibold text-sm text-ink">{place || t('checkout_pickup', 'Upphämtning')}</div>
                                  {dayLine && (
                                    <div className="text-xs text-ink-muted">
                                      {dayLine}
                                      {opt.past && ` · ${t('checkout_pickup_date_passed', 'passerat')}`}
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-semibold text-ink mb-2">
                        {t('checkout_first_name', 'Förnamn *')}
                      </label>
                      <input
                        type="text"
                        value={shippingInfo.firstName}
                        onChange={(e) => setShippingInfo({...shippingInfo, firstName: e.target.value})}
                        className="w-full px-3 sm:px-4 py-3 border border-ink/15 bg-white rounded-el focus:outline-hidden focus:ring-4 focus:ring-accent/10 focus:border-accent text-base transition-colors"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-ink mb-2">
                        {t('checkout_last_name', 'Efternamn *')}
                      </label>
                      <input
                        type="text"
                        value={shippingInfo.lastName}
                        onChange={(e) => setShippingInfo({...shippingInfo, lastName: e.target.value})}
                        className="w-full px-3 sm:px-4 py-3 border border-ink/15 bg-white rounded-el focus:outline-hidden focus:ring-4 focus:ring-accent/10 focus:border-accent text-base transition-colors"
                        required
                      />
                    </div>
                  </div>

                  {/* Address fields — only for home delivery (pickup needs none). */}
                  {!isPickup && (
                  <>
                  <div className="mb-4">
                    <label className="block text-sm font-semibold text-ink mb-2">
                      {t('checkout_address', 'Adress *')}
                    </label>
                    <input
                      type="text"
                      value={shippingInfo.address}
                      onChange={(e) => setShippingInfo({...shippingInfo, address: e.target.value})}
                      className="w-full px-3 sm:px-4 py-3 border border-ink/15 bg-white rounded-el focus:outline-hidden focus:ring-4 focus:ring-accent/10 focus:border-accent text-base transition-colors"
                      placeholder={t('checkout_address_placeholder', 'Gatuadress')}
                      required
                    />
                  </div>

                  <div className="mb-4">
                    <label className="block text-sm font-semibold text-ink mb-2">
                      {t('checkout_apartment', 'Lägenhet, svit, etc. (valfritt)')}
                    </label>
                    <input
                      type="text"
                      value={shippingInfo.apartment}
                      onChange={(e) => setShippingInfo({...shippingInfo, apartment: e.target.value})}
                      className="w-full px-3 sm:px-4 py-3 border border-ink/15 bg-white rounded-el focus:outline-hidden focus:ring-4 focus:ring-accent/10 focus:border-accent text-base transition-colors"
                      placeholder={t('checkout_apartment_placeholder', 'Lägenhetsnummer, våning, etc.')}
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-semibold text-ink mb-2">
                        {t('checkout_postal_code', 'Postnummer *')}
                      </label>
                      <input
                        type="text"
                        value={shippingInfo.postalCode}
                        onChange={(e) => setShippingInfo({...shippingInfo, postalCode: e.target.value})}
                        className="w-full px-3 sm:px-4 py-3 border border-ink/15 bg-white rounded-el focus:outline-hidden focus:ring-4 focus:ring-accent/10 focus:border-accent text-base transition-colors"
                        placeholder={t('checkout_postal_code_placeholder', '123 45')}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-ink mb-2">
                        {t('checkout_city', 'Stad *')}
                      </label>
                      <input
                        type="text"
                        value={shippingInfo.city}
                        onChange={(e) => setShippingInfo({...shippingInfo, city: e.target.value})}
                        className="w-full px-3 sm:px-4 py-3 border border-ink/15 bg-white rounded-el focus:outline-hidden focus:ring-4 focus:ring-accent/10 focus:border-accent text-base transition-colors"
                        placeholder={t('checkout_city_placeholder', 'Stockholm')}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-ink mb-2">
                        {t('checkout_country', 'Land *')}
                      </label>
                      <select
                        value={shippingInfo.country}
                        onChange={(e) => setShippingInfo({...shippingInfo, country: e.target.value})}
                        className="w-full px-3 sm:px-4 py-3 border border-ink/15 bg-white rounded-el focus:outline-hidden focus:ring-4 focus:ring-accent/10 focus:border-accent text-base transition-colors"
                      >
                        <option value="SE">{t('checkout_country_sweden', 'Sverige')}</option>
                        <option value="NO">{t('checkout_country_norway', 'Norge')}</option>
                        <option value="DK">{t('checkout_country_denmark', 'Danmark')}</option>
                        <option value="FI">{t('checkout_country_finland', 'Finland')}</option>
                        <option value="DE">{t('checkout_country_germany', 'Tyskland')}</option>
                        <option value="US">{t('checkout_country_usa', 'USA')}</option>
                      </select>
                    </div>
                  </div>
                  </>
                  )}

                  <button
                    onClick={handleNextStep}
                    className="mt-6 w-full bg-accent text-white px-4 sm:px-6 py-3.5 rounded-full font-bold hover:opacity-90 transition-opacity text-base"
                  >
                    {t('checkout_continue_payment', 'Fortsätt till betalning')}
                  </button>
                </div>
              )}

              {/* Payment Information */}
              {step === 'payment' && (
                <div className="bg-white rounded-tile p-6 shadow-tile animate-fade-up">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="font-display text-xl font-bold text-ink">
                      {t('checkout_payment_title', 'Betalning')}
                    </h2>
                    <button
                      onClick={handlePreviousStep}
                      className="text-ink-muted hover:text-ink font-medium underline underline-offset-4"
                    >
                      {t('checkout_change', 'Ändra')}
                    </button>
                  </div>

                  <div className="mb-4 p-3 bg-canvas rounded-el">
                    <div className="text-sm text-ink-muted">{t('checkout_delivery_to', 'Levereras till')}</div>
                    <div className="font-medium">
                      {shippingInfo.firstName} {shippingInfo.lastName}
                    </div>
                    <div className="text-sm text-ink-muted">
                      {shippingInfo.address}
                      {shippingInfo.apartment && `, ${shippingInfo.apartment}`}
                    </div>
                    <div className="text-sm text-ink-muted">
                      {shippingInfo.postalCode} {shippingInfo.city}, {shippingInfo.country}
                    </div>
                  </div>

                  {/* Right-of-withdrawal gate — only for carts with a
                      personalized / made-to-order item. The buyer must accept
                      that the 14-day withdrawal right does not apply BEFORE
                      payment; the confirm button stays blocked until then. */}
                  {needsWithdrawalGate && (
                    <div className="mb-4 rounded-el border-l-4 border-amber-400 bg-amber-50 p-4">
                      <p className="text-sm text-ink mb-3">{withdrawalNotice.text}</p>
                      <label className="flex items-start gap-2 text-sm text-ink cursor-pointer">
                        <input
                          type="checkbox"
                          checked={withdrawalAccepted}
                          onChange={(e) => setWithdrawalAccepted(e.target.checked)}
                          className="mt-0.5"
                        />
                        <span>{t('checkout_withdrawal_accept', 'Jag har läst och godkänner att ångerrätten inte gäller för specialtillverkade produkter i denna beställning.')}</span>
                      </label>
                    </div>
                  )}

                  {/* Legal gate: the shop hasn't finished its köpvillkor, so the
                      server would refuse the PaymentIntent anyway. Show the
                      friendly front instead of the payment form — and never the
                      internal blocker names. */}
                  {!checkoutLegallyOpen ? (
                    <div className="bg-white rounded-tile border border-ink/10 p-6 text-center">
                      <h3 className="font-display text-lg font-bold text-ink mb-2">
                        {t('checkout_legal_not_ready_title', 'Butiken tar inte emot beställningar ännu')}
                      </h3>
                      <p className="text-sm text-ink-muted">
                        {t('checkout_legal_not_ready_body', 'Butiken håller på att färdigställa sina köpvillkor. Försök igen lite senare.')}
                      </p>
                    </div>
                  ) : (
                  <>
                  {/* Stripe Payment Form */}
                  <StripePaymentForm
                    withdrawalGate={{
                      required: needsWithdrawalGate,
                      accepted: needsWithdrawalGate ? withdrawalAccepted : null,
                      noticeVersion: withdrawalNotice.version,
                      noticeFingerprint: withdrawalNotice.fingerprint
                    }}
                    customerInfo={{
                      email: contactInfo.email,
                      name: `${shippingInfo.firstName} ${shippingInfo.lastName}`,
                      firstName: shippingInfo.firstName,
                      lastName: shippingInfo.lastName,
                      marketing: contactInfo.marketing,
                      preferredLang: currentLanguage
                    }}
                    shippingInfo={{
                      country: shippingInfo.country,
                      firstName: shippingInfo.firstName,
                      lastName: shippingInfo.lastName,
                      address: isPickup ? '' : shippingInfo.address,
                      apartment: isPickup ? '' : shippingInfo.apartment,
                      city: isPickup ? '' : shippingInfo.city,
                      postalCode: isPickup ? '' : shippingInfo.postalCode
                    }}
                    deliveryInfo={{
                      method: deliveryMethod,
                      pickupLocation: isPickup ? pickupLocation : null,
                      pickupDate: isPickup ? (pickupDate || '') : ''
                    }}
                    onCheckout={handleCheckoutAnswer}
                    onPaymentSuccess={handlePaymentSuccess}
                    onPaymentError={handlePaymentError}
                  />

                  {/* The SELLER is the buyer's counterparty, not the platform —
                      so name the shop's legal entity here, never "våra". */}
                  <p className="text-xs text-center text-ink-faint mt-4">
                    {t('checkout_terms_agreement_seller', 'Genom att slutföra beställningen ingår du avtal med {{seller}} och godkänner butikens', { seller: sellerName })}{' '}
                    <a href={getCountryAwareUrl('legal/kopvillkor')} className="text-accent hover:underline">{t('checkout_terms_link_kopvillkor', 'köpvillkor')}</a>{' '}
                    {t('checkout_terms_and', 'och')}{' '}
                    <a href={getCountryAwareUrl('legal/integritetspolicy')} className="text-accent hover:underline">{t('checkout_privacy_link', 'integritetspolicy')}</a>.
                  </p>
                  </>
                  )}
                </div>
              )}
            </div>

            {/* Right Column - Order Summary */}
            <div className="lg:sticky lg:top-8 lg:h-fit">
              <div className="bg-white rounded-tile p-4 sm:p-6 shadow-tile">
                <h2 className="font-display text-lg sm:text-xl font-bold text-ink mb-4 sm:mb-6">
                  {t('checkout_order_summary', 'Ordersammanfattning')}
                </h2>
                
                {/* Cart Items */}
                <div className="space-y-3 sm:space-y-4 mb-4 sm:mb-6">
                  {cart.items.map((item) => {
                    const itemName = getContentValue(item.name);
                    return (
                      <div key={item.lineId} className="flex items-center justify-between py-2">
                        <div className="flex items-center">
                          <div className="relative">
                            <img src={item.image} alt={itemName} className="w-12 h-12 sm:w-16 sm:h-16 object-cover rounded-el bg-canvas" />
                            <span className="absolute -top-1 -right-1 sm:-top-2 sm:-right-2 bg-ink text-white text-xs font-bold rounded-full h-5 w-5 sm:h-6 sm:w-6 flex items-center justify-center tabular-nums">
                              {item.quantity}
                            </span>
                          </div>
                          <div className="ml-3 sm:ml-4">
                            <p className="font-semibold text-sm sm:text-base text-ink">{itemName}</p>
                            {item.label && <p className="text-xs sm:text-sm text-ink-muted">{item.label}</p>}
                          </div>
                        </div>
                        <p className="font-semibold text-sm sm:text-base">
                          <SmartPrice 
                            sekPrice={item.price * item.quantity} 
                            variant="compact"
                            showOriginal={false}
                          />
                        </p>
                      </div>
                    );
                  })}
                </div>
                
                <div className="space-y-2">
                  <div className="flex justify-between text-xs sm:text-sm">
                    <span className="text-ink-muted">{t('checkout_subtotal', 'Delsumma')}</span>
                    <span className="font-medium">
                      <SmartPrice 
                        sekPrice={subtotal} 
                        variant="compact"
                        showOriginal={false}
                      />
                    </span>
                  </div>
                  {discountAmount > 0 && (
                    <div className="flex justify-between text-xs sm:text-sm">
                      <span className="text-accent text-xs bg-accent/10 px-2 py-1 rounded-full font-semibold">
                        {discountSource === 'campaign'
                          ? (discountPercentage > 0
                              ? t('checkout_discount_percent', 'Rabatt, {{discountPercentage}}%', { discountPercentage })
                              : t('checkout_discount', 'Rabatt'))
                          : t('checkout_affiliate_discount', 'Affiliate rabatt, {{discountPercentage}}%', { discountPercentage })}
                      </span>
                      <span className="font-medium text-green-600">
                        - <SmartPrice 
                          sekPrice={discountAmount} 
                          variant="compact"
                          showOriginal={false}
                        />
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between text-xs sm:text-sm">
                    <span className="text-ink-muted">{t('checkout_shipping', 'Frakt ({{shippingCountry}})', { shippingCountry: cart.shippingCountry })}</span>
                    <span className="font-medium">
                      <SmartPrice 
                        sekPrice={shipping} 
                        variant="compact"
                        showOriginal={false}
                      />
                    </span>
                  </div>
                  <div className="flex justify-between font-display font-bold text-base sm:text-lg text-ink pt-2 sm:pt-3 border-t border-ink/15">
                    <span>{t('checkout_total', 'Totalt')}</span>
                    <span>
                      <SmartPrice 
                        sekPrice={total} 
                        variant="compact"
                        showOriginal={false}
                      />
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-ink-faint -mt-1 sm:-mt-2">
                      <span>{t('checkout_vat_rate', 'Varav Moms ({{rate}}%)', { rate: Math.round(vatRate * 100) })}</span>
                      <span>
                        <SmartPrice 
                          sekPrice={vat} 
                          variant="compact"
                          showOriginal={false}
                        />
                      </span>
                  </div>
                </div>

                {/* Applied-discount confirmation. Source-aware: a campaign
                    ("Rabattkoder") code shows a generic "Rabatt aktiverad"
                    message (a fixed-amount code has no percentage); an affiliate
                    code keeps the affiliate wording. Driven by discountSource +
                    an applied code (calculateTotals now returns discountSource;
                    the old appliedAffiliate field was never populated). */}
                {discountAmount > 0 && discountCode && (
                  <div className="mt-3 sm:mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <div className="text-xs sm:text-sm text-green-800">
                      {discountSource === 'campaign' ? (
                        <>
                          <div className="font-medium">{t('checkout_discount_activated', '🎉 Rabatt aktiverad!')}</div>
                          <div className="text-xs mt-1">
                            {discountPercentage > 0
                              ? t('checkout_discount_code_percent', 'Kod: {{code}} • {{discountPercentage}}% rabatt', { code: discountCode, discountPercentage })
                              : t('checkout_discount_code', 'Kod: {{code}}', { code: discountCode })}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="font-medium">{t('checkout_affiliate_activated', '🎉 Affiliate-rabatt aktiverad!')}</div>
                          <div className="text-xs mt-1">
                            {t('checkout_affiliate_code', 'Kod: {{code}} • {{discountPercentage}}% rabatt', {
                              code: discountCode,
                              discountPercentage
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        {/* ShopFooter component was removed from imports, so it's removed from here */}
      </div>
    </>
  );
};

export default Checkout;