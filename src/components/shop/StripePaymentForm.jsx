/**
 * Stripe Payment Form Component
 * Integrates Stripe Elements with the storefront checkout flow
 */

import React, { useState, useEffect, useRef } from 'react';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { getStripe, STRIPE_CONFIG } from '../../utils/stripeClient';
import { useCart } from '../../contexts/CartContext';
import { useShopId } from '../../contexts/ShopContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { getCountryAwareUrl } from '../../utils/productUrls';
import { createCheckout, createPayment, newIdempotencyKey } from '../../api/checkout';
import { savePendingCheckout } from '../../api/orders';
import { buildCheckoutRequest, checkoutRefusal } from '../../storefront/adapters/checkout';
import toast from 'react-hot-toast';

const PaymentForm = ({ customerInfo, shippingInfo, onPaymentSuccess, onPaymentError, clientSecret, payableTotal, gateBlocked, onResetPaymentMethods }) => {
  const stripe = useStripe();
  const elements = useElements();
  const { clearCart } = useCart();
  const { t } = useTranslation();
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [isElementReady, setIsElementReady] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();

    // Right-of-withdrawal gate (defense in depth — the button is also disabled).
    if (gateBlocked) {
      toast.error(t('checkout_withdrawal_required', 'Du måste godkänna villkoren för specialtillverkade produkter innan du betalar.'));
      return;
    }

    if (!stripe || !elements) {
      console.error('❌ Stripe not loaded');
      toast.error(t('stripe_payment_system_not_ready', 'Betalningssystem inte redo. Vänta och försök igen.'));
      return;
    }

    if (!isElementReady) {
      console.error('❌ Payment Element not ready');
      toast.error(t('stripe_payment_form_not_ready', 'Betalningsformulär inte redo. Vänta och försök igen.'));
      return;
    }

    setIsProcessing(true);
    setPaymentError(null);

    try {
      console.log('💳 Processing payment...');

      // Confirm payment with Stripe
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}${getCountryAwareUrl('order-return')}`,
          receipt_email: customerInfo.email,
        },
        redirect: 'if_required'
      });

      if (error) {
        console.error('❌ Payment failed:', error.code || error.type);
        setPaymentError(error.message);
        onPaymentError?.(error);
        toast.error(`Betalning misslyckades: ${error.message}`);
      } else if (paymentIntent) {
        console.log('💳 Payment Intent status:', paymentIntent.status);
        
        if (paymentIntent.status === 'succeeded') {
          // Payment completed immediately (cards)
          console.log('✅ Payment succeeded immediately!');
          
          // Clear cart after successful payment
          clearCart();
          
          // Call success callback
          onPaymentSuccess?.(paymentIntent);
          
          toast.success(t('stripe_payment_completed', 'Betalning genomförd!'));
          
        } else if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'requires_source_action') {
          // Payment requires additional action (Klarna, 3D Secure, etc.)
          console.log('🔄 Payment requires action, redirecting...', paymentIntent.status);
          // react-hot-toast has no toast.info — plain toast() (was a TypeError
          // that would have crashed this redirect path).
          toast(t('stripe_redirecting_to_provider', 'Omdirigerar till betalningsleverantör...'));
          
          // User will be redirected to complete payment, then return to return_url
          // The order creation will happen on the return page
          
        } else if (paymentIntent.status === 'processing') {
          // Payment is being processed (some payment methods)
          console.log('⏳ Payment processing...');
          toast(t('stripe_payment_processing', 'Betalning behandlas...'));
          
        } else {
          // Other statuses
          console.log('❓ Unexpected payment status:', paymentIntent.status);
          toast(t('stripe_unexpected_payment_status', 'Oväntat betalningsstatus. Kontakta support om problemet kvarstår.'));
        }
      }

    } catch (error) {
      console.error('❌ Payment processing error:', error?.code || error?.name);
      setPaymentError(error.message);
      onPaymentError?.(error);
      toast.error('Ett fel uppstod vid betalning');
    } finally {
      setIsProcessing(false);
    }
  };

  // Don't render the form if we don't have a valid client secret
  if (!clientSecret || !clientSecret.startsWith('pi_')) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
        <p className="text-gray-600">Initierar betalning...</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Payment Element */}
      <div className="bg-white p-6 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            {t('payment_method', 'Betalningsmetod')}
          </h3>
          {/* Always-available escape hatch: remounts the Payment Element with a
              fresh key so the full method list (tabs) returns even if Stripe
              Link's saved-card UI has taken over the element. */}
          {onResetPaymentMethods && (
            <button
              type="button"
              onClick={onResetPaymentMethods}
              disabled={isProcessing}
              className="text-sm font-medium text-gray-600 hover:text-gray-900 underline underline-offset-4 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('checkout_switch_payment_method', 'Byt betalningssätt')}
            </button>
          )}
        </div>

        <PaymentElement
          options={{
            // Tabs: every available method (kort, Klarna, wallets…) stays
            // visible and switchable at all times — no collapsed accordion.
            layout: { type: 'tabs' },
            defaultValues: {
              billingDetails: {
                // Deliberately NO email here: a prefilled email makes the
                // Payment Element look up the address with Stripe Link and, for
                // returning Link users, auto-render their saved card — hiding
                // the other payment methods. stripe-js 4.7.0 has no client
                // option to disable Link outright (wallets covers only
                // applePay/googlePay), so we avoid the trigger instead. The
                // email still reaches Stripe via receipt_email at confirm.
                name: customerInfo.name,
              }
            }
          }}
          onReady={() => {
            console.log('✅ Payment Element ready');
            setIsElementReady(true);
          }}
          onFocus={() => {
            console.log('🎯 Payment Element focused');
          }}
          onBlur={() => {
            console.log('👋 Payment Element blurred');
          }}
          onChange={(event) => {
            console.log('🔄 Payment Element changed:', event.complete ? 'Complete' : 'Incomplete');
            if (event.error) {
              console.error('❌ Payment Element error:', event.error);
              setPaymentError(event.error.message);
            } else {
              setPaymentError(null);
            }
          }}
        />
      </div>

      {/* Error Display */}
      {paymentError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex">
            <div className="shrink-0">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {t('payment_error', 'Betalningsfel')}
              </h3>
              <div className="mt-2 text-sm text-red-700">
                {paymentError}
              </div>
              <p className="mt-2 text-sm text-red-700">
                {t('checkout_payment_retry_hint', 'Inga pengar har dragits. Försök igen eller välj ett annat betalningssätt.')}
              </p>
              {onResetPaymentMethods && (
                <button
                  type="button"
                  onClick={onResetPaymentMethods}
                  disabled={isProcessing}
                  className="mt-2 text-sm font-semibold text-red-800 hover:text-red-900 underline underline-offset-4 disabled:opacity-50"
                >
                  {t('checkout_switch_payment_method', 'Byt betalningssätt')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Submit Button */}
      <button
        type="submit"
        disabled={!stripe || !elements || !isElementReady || isProcessing || gateBlocked}
        className={`w-full py-3 px-4 rounded-lg font-semibold text-white transition-colors ${
          isProcessing || !stripe || !elements || !isElementReady || gateBlocked
            ? 'bg-gray-400 cursor-not-allowed'
            : 'bg-blue-600 hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2'
        }`}
      >
        {isProcessing ? (
          <div className="flex items-center justify-center">
            <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {t('processing_payment', 'Bearbetar betalning...')}
          </div>
        ) : !isElementReady ? (
          t('loading_payment', 'Laddar betalning...')
        ) : (
          `${t('pay_now', 'Betala nu')} - ${payableTotal.toFixed(2)} kr`
        )}
      </button>

      {/* Test Card Info (only in development) */}
      {import.meta.env.DEV && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm">
          <h4 className="font-semibold text-yellow-800 mb-2">Testkort (endast utveckling):</h4>
          <div className="text-yellow-700 space-y-1">
            <div><strong>Visa:</strong> 4242 4242 4242 4242</div>
            <div><strong>Mastercard:</strong> 5555 5555 5555 4444</div>
            <div><strong>Datum:</strong> Vilket som helst framtida datum</div>
            <div><strong>CVC:</strong> Vilka tre siffror som helst</div>
          </div>
        </div>
      )}
    </form>
  );
};

const StripePaymentForm = ({ customerInfo, shippingInfo, deliveryInfo, withdrawalGate, onCheckout, onPaymentSuccess, onPaymentError }) => {
  const { t } = useTranslation();
  const { cart, checkoutItems } = useCart();
  const shopId = useShopId();
  // Block confirm until the no-withdrawal notice is accepted (when required).
  const gateBlocked = withdrawalGate?.required === true && withdrawalGate?.accepted !== true;
  const [clientSecret, setClientSecret] = useState('');
  // The amount of the payment: the SERVER's total of the priced checkout.
  const [payableTotal, setPayableTotal] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  // Bumping this key remounts the Elements provider (same clientSecret — a
  // PaymentIntent awaiting a payment method is reusable), which resets the
  // Payment Element to the full method-tab view. This is the guaranteed way
  // out of Stripe Link's saved-card takeover UI, and restores every method
  // after a failed attempt if the element collapsed to one.
  const [elementsKey, setElementsKey] = useState(0);
  const resetPaymentMethods = () => setElementsKey((k) => k + 1);
  // One idempotency key per distinct request: a repeat of the same request
  // (a re-render, a remount) replays the same checkout and the same payment;
  // a changed request is a new checkout.
  const idempotencyKeys = useRef(new Map());

  // What the server prices (POST /v1/checkout): products, variants and
  // quantities, the buyer's e-mail address, the delivery, the recipient
  // (name, address or pickup occasion), the consents and the cart's discount
  // code. Never a price, a total, a carriage or a VAT figure.
  const checkoutRequest = buildCheckoutRequest({
    items: checkoutItems(),
    email: customerInfo?.email,
    deliveryMethod: deliveryInfo?.method,
    shippingCountry: shippingInfo?.country,
    shippingInfo,
    pickupLocationId: deliveryInfo?.pickupLocation?.id,
    pickupDate: deliveryInfo?.pickupDate,
    marketing: customerInfo?.marketing,
    // CP9-AC: the reminder box; nothing is sent unless it was ticked.
    reminder: customerInfo?.reminder,
    withdrawal: withdrawalGate,
    // CP8-DC: the code the cart holds, never the field's text.
    discountCode: cart.discountCode,
  });

  // Recreation fingerprint (2026-08-15 verifier + 07-25 audit fixes).
  // Checkout passes customerInfo/shippingInfo as FRESH inline literals every
  // render, so depending on those objects recreated the payment on every
  // parent re-render ("PI-per-keystroke"). This key is a PRIMITIVE built from
  // exactly the inputs the server prices from — the effect refires only when
  // one of them actually changes.
  const paymentInputsKey = JSON.stringify({ request: checkoutRequest, shopId, gateBlocked });

  useEffect(() => {
    // Defer the checkout until the no-withdrawal notice is accepted (when
    // required): the consent is frozen with the checkout, so it must be in the
    // request that creates it. Until then we show the gate (not a spinner).
    if (gateBlocked) {
      // Clear any payment created before an un-check so the UI consistently
      // shows the gate (and a stale consented secret is never reused).
      setClientSecret('');
      setIsLoading(false);
      onCheckout?.({ status: 'pending' });
      return undefined;
    }

    let stale = false;
    const controller = new AbortController();
    const fingerprint = JSON.stringify(checkoutRequest);
    const keyFor = (fresh) => {
      if (fresh || !idempotencyKeys.current.has(fingerprint)) {
        idempotencyKeys.current.set(fingerprint, newIdempotencyKey());
      }
      return idempotencyKeys.current.get(fingerprint);
    };

    const initializePayment = async () => {
      try {
        setIsLoading(true);
        setError(null);
        setClientSecret('');
        onCheckout?.({ status: 'pending' });

        console.log('🔄 Creating checkout and payment...', { items: checkoutRequest.items.length });

        // 1. The server prices the order.
        let checkout;
        try {
          ({ checkout } = await createCheckout(
            { ...checkoutRequest, idempotencyKey: keyFor(false) },
            { signal: controller.signal },
          ));
        } catch (checkoutError) {
          // 409: the key was used for another request (a price or a carriage
          // changed on the server between two attempts). Once more, new key.
          if (checkoutRefusal(checkoutError) !== 'conflict') throw checkoutError;
          ({ checkout } = await createCheckout(
            { ...checkoutRequest, idempotencyKey: keyFor(true) },
            { signal: controller.signal },
          ));
        }
        if (stale) return;
        onCheckout?.({ status: 'ready', checkout });

        // 2. The payment of exactly that checkout (its frozen total).
        const payment = await createPayment(checkout.checkoutId, { signal: controller.signal });
        if (stale) return;
        // This tab's record of which checkout the payment pays, so the
        // confirmation page (reached by the payment's id) can wait for its order.
        savePendingCheckout(payment.paymentIntentId, checkout.checkoutId);
        setPayableTotal(checkout.totalMinor / 100);
        setClientSecret(payment.clientSecret);
        console.log('✅ Checkout priced and payment created');
      } catch (error) {
        if (stale || error?.name === 'AbortError') return;
        const refusal = checkoutRefusal(error);
        console.error('❌ Error initializing payment:', refusal, error?.code);
        if (refusal === 'closed') {
          // The shop does not sell (its legal gate, its payment account, or it
          // is not open): Checkout shows its "not accepting orders" block.
          onCheckout?.({ status: 'closed' });
          setError('Butiken tar inte emot beställningar ännu. Försök igen lite senare.');
          return;
        }
        if (refusal === 'waiver_required') {
          // The basket holds a personalised line: Checkout shows the gate, and
          // this form waits for it.
          onCheckout?.({ status: 'waiver_required' });
          toast.error(t('checkout_withdrawal_required', 'Du måste godkänna villkoren för specialtillverkade produkter innan du betalar.'));
          return;
        }
        onCheckout?.({ status: 'refused' });
        if (refusal === 'unpurchasable') {
          // A line that cannot be bought (or not the chosen way) is the one
          // failure the customer can fix themselves — say how.
          setError('Något i varukorgen är inte längre tillgängligt. Gå tillbaka till varukorgen, uppdatera sidan och försök igen.');
        } else {
          setError(error.message);
        }
        toast.error('Kunde inte initiera betalning');
      } finally {
        if (!stale) setIsLoading(false);
      }
    };

    if (cart.items.length > 0 && customerInfo?.email) {
      initializePayment();
    }
    return () => {
      stale = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentInputsKey]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <svg className="animate-spin h-8 w-8 text-blue-600 mx-auto mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="text-gray-600">Förbereder betalning...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
        <svg className="h-12 w-12 text-red-400 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <h3 className="text-lg font-semibold text-red-800 mb-2">Kunde inte ladda betalning</h3>
        <p className="text-red-700">{error}</p>
      </div>
    );
  }

  if (!clientSecret) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
        <p className="text-gray-600">
          {gateBlocked
            ? t('checkout_withdrawal_gate_hint', 'Godkänn villkoren ovan för att fortsätta till betalning.')
            : 'Väntar på betalningsinformation...'}
        </p>
      </div>
    );
  }

  const options = {
    clientSecret,
    appearance: STRIPE_CONFIG.appearance,
    locale: STRIPE_CONFIG.locale
  };

  return (
    <Elements key={elementsKey} stripe={getStripe()} options={options}>
      <PaymentForm
        customerInfo={customerInfo}
        shippingInfo={shippingInfo}
        onPaymentSuccess={onPaymentSuccess}
        onPaymentError={onPaymentError}
        clientSecret={clientSecret} // Pass clientSecret to form for validation
        payableTotal={payableTotal}
        gateBlocked={gateBlocked}
        onResetPaymentMethods={resetPaymentMethods}
      />
    </Elements>
  );
};

export default StripePaymentForm;