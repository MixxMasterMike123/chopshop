import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Elements, useStripe } from '@stripe/react-stripe-js';
import { getStripe } from '../../utils/stripeClient';
import { useCart } from '../../contexts/CartContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { getCountryAwareUrl } from '../../utils/productUrls';

const OrderReturnInner = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const stripe = useStripe();
  const { clearCart } = useCart();
  const { t } = useTranslation();
  const [status, setStatus] = useState('processing'); // 'processing', 'success', 'error'
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (!stripe) return;

    const clientSecret = searchParams.get('payment_intent_client_secret');
    if (!clientSecret) {
      setStatus('error');
      setErrorMessage(t('order_return_no_payment_info', 'Ingen betalningsinformation hittades'));
      return;
    }

    const handlePaymentReturn = async () => {
      try {
        console.log('🔄 Retrieving payment intent after return...');
        
        // Retrieve the payment intent
        const { error, paymentIntent } = await stripe.retrievePaymentIntent(clientSecret);

        if (error) {
          console.error('❌ Error retrieving payment intent:', error);
          setStatus('error');
          setErrorMessage(error.message);
          return;
        }

        console.log('💳 Payment Intent status after return:', paymentIntent.status);

        if (paymentIntent.status === 'succeeded') {
          // Payment succeeded. The order is created SERVER-SIDE by the Stripe
          // webhook with doc ID = payment intent ID, so we just clean up and
          // send the customer to the confirmation page (which waits for the
          // webhook-created order to appear).
          console.log('✅ Payment succeeded, redirecting to confirmation...');

          clearCart();
          localStorage.removeItem('b8s_checkout_customer');
          localStorage.removeItem('b8s_checkout_shipping');
          sessionStorage.removeItem(`b8s_return_poll_${paymentIntent.id}`);
          setStatus('success');

          setTimeout(() => {
            navigate(getCountryAwareUrl(`order-confirmation/${paymentIntent.id}`));
          }, 1500);

        } else if (paymentIntent.status === 'processing') {
          console.log('⏳ Payment still processing...');
          setStatus('processing');

          // P2-11: BOUNDED polling — max 10 rechecks (~30 s), then a terminal
          // "still processing" state instead of reloading forever. Attempt
          // count survives the reload via sessionStorage (keyed per PI).
          const attemptKey = `b8s_return_poll_${paymentIntent.id}`;
          const attempts = Number(sessionStorage.getItem(attemptKey) || 0);
          if (attempts < 10) {
            sessionStorage.setItem(attemptKey, String(attempts + 1));
            setTimeout(() => {
              window.location.reload();
            }, 3000);
          } else {
            sessionStorage.removeItem(attemptKey);
            setStatus('error');
            setErrorMessage(t(
              'order_return_processing_timeout',
              'Betalningen behandlas fortfarande. Du får ett orderbekräftelsemail när den går igenom — kontakta oss om inget mail kommit inom en timme.'
            ));
          }

        } else if (paymentIntent.status === 'canceled') {
          console.log('❌ Payment was canceled');
          setStatus('error');
          setErrorMessage(t('order_return_payment_cancelled', 'Betalning avbröts'));
          
        } else {
          console.log('❌ Payment failed with status:', paymentIntent.status);
          setStatus('error');
          setErrorMessage(t('order_return_payment_failed', 'Betalning misslyckades'));
        }

      } catch (error) {
        console.error('❌ Error handling payment return:', error);
        setStatus('error');
        setErrorMessage(t('order_return_unexpected_error', 'Ett oväntat fel uppstod'));
      }
    };

    handlePaymentReturn();
  }, [stripe, searchParams]);

  if (status === 'processing') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-lg text-center max-w-md">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            {t('processing_payment', 'Behandlar betalning...')}
          </h2>
          <p className="text-gray-600">
            {t('payment_processing_message', 'Vänta medan vi bekräftar din betalning.')}
          </p>
        </div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-lg text-center max-w-md">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            {t('payment_successful', 'Betalning genomförd!')}
          </h2>
          <p className="text-gray-600">
            {t('redirecting_to_confirmation', 'Omdirigerar till orderbekräftelse...')}
          </p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-lg text-center max-w-md">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            {t('payment_failed', 'Betalning misslyckades')}
          </h2>
          <p className="text-gray-600 mb-4">
            {errorMessage || t('payment_error_message', 'Ett fel uppstod vid betalning.')}
          </p>
          <button
            onClick={() => navigate(getCountryAwareUrl('checkout'))}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors"
          >
            {t('try_again', 'Försök igen')}
          </button>
        </div>
      </div>
    );
  }

  return null;
};

const OrderReturn = () => {
  return (
    <Elements stripe={getStripe()}>
      <OrderReturnInner />
    </Elements>
  );
};

export default OrderReturn;
