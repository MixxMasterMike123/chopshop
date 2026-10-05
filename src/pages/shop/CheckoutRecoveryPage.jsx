import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import toast from 'react-hot-toast';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import { useCart } from '../../contexts/CartContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { getCountryAwareUrl } from '../../utils/productUrls';
import { getProduct } from '../../api/products';
import { resolveCheckoutRecovery } from '../../api/checkoutRecovery';
import { recoveryPlan, recoveryProductIds } from '../../storefront/adapters/recovery';

/**
 * Checkout recovery page — <root>/aterta/:token (CP9-AC).
 *
 * Reached from the abandoned-checkout reminder email. On mount it resolves the
 * link (POST /v1/checkout-recovery/:token, which answers line references only:
 * no prices, no personal data), reads each product as the storefront always
 * does (the live public product), and rebuilds the cart through the NORMAL
 * cart path: the visitor's cart is replaced (AC12), each line added with the
 * live price, without the "added" modal. Then on to the checkout, which asks
 * for contact and delivery again and prices a NEW checkout from scratch.
 * Nothing of the old checkout's money, its discount code or its payment is
 * carried.
 *
 * States: loading → open (rebuild → checkout) | completed (the order exists)
 * | invalid (the link does not work) | gone (nothing of it is for sale any
 * more; the visitor's cart is left as it was) | error (retry from the shop).
 * Works whatever the add-on's state: a link must never dead-end.
 */
const CheckoutRecoveryPage = () => {
  const { token } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { clearCart, addToCart } = useCart();

  const [status, setStatus] = useState('loading'); // 'loading' | 'completed' | 'invalid' | 'gone' | 'error'
  const ranRef = useRef(false); // guard against double-run (StrictMode / re-render)

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      try {
        const recovery = await resolveCheckoutRecovery(token);
        if (recovery.status !== 'open') {
          setStatus(recovery.status);
          return;
        }

        // Every product first: a read that fails leaves the visitor's cart as it was.
        const productsById = {};
        for (const productId of recoveryProductIds(recovery.items)) {
          productsById[productId] = await getProduct(productId);
        }
        const { lines, missing } = recoveryPlan(recovery.items, productsById);
        if (lines.length === 0) {
          setStatus('gone');
          return;
        }

        clearCart();
        for (const line of lines) {
          addToCart(line.product, line.quantity, line.variant, { quiet: true });
        }
        if (missing > 0) {
          toast(t('checkout_recovery_partial', 'Vissa varor finns inte längre och togs bort ur varukorgen.'));
        }
        navigate(getCountryAwareUrl('checkout'), { replace: true });
      } catch (err) {
        console.error('checkout recovery failed', err?.code || err?.name);
        setStatus('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const backToShop = (
    <a
      href={getCountryAwareUrl('')}
      className="inline-block bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity"
    >
      {t('checkout_recovery_back_to_shop', 'Till butiken')}
    </a>
  );

  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      <Helmet>
        <title>{t('checkout_recovery_title', 'Återställer din varukorg')}</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <ShopNavigation />

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 py-16">
        {status === 'loading' && (
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-10 text-center">
            <span className="inline-block h-6 w-6 animate-spin rounded-full border-b-2 border-accent" />
            <p className="mt-4 text-ink/70">
              {t('checkout_recovery_loading', 'Vi återställer din varukorg…')}
            </p>
          </div>
        )}

        {status === 'completed' && (
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
            <h1 className="font-display text-3xl font-bold text-ink tracking-tight mb-3">
              {t('checkout_recovery_completed_title', 'Köpet är redan genomfört')}
            </h1>
            <p className="text-ink/70 mb-6 leading-relaxed">
              {t('checkout_recovery_completed_body', 'Den här beställningen är redan slutförd. Tack för ditt köp.')}
            </p>
            {backToShop}
          </div>
        )}

        {status === 'invalid' && (
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
            <h1 className="font-display text-3xl font-bold text-ink tracking-tight mb-6">
              {t('checkout_recovery_invalid_title', 'Länken till din varukorg fungerar inte längre.')}
            </h1>
            {backToShop}
          </div>
        )}

        {status === 'gone' && (
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
            <h1 className="font-display text-3xl font-bold text-ink tracking-tight mb-6">
              {t('checkout_recovery_gone_title', 'Varorna från din varukorg finns inte längre i butiken.')}
            </h1>
            {backToShop}
          </div>
        )}

        {status === 'error' && (
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
            <p className="text-ink/80 mb-6">
              {t('checkout_recovery_error', 'Något gick fel när vi skulle återställa din varukorg. Gå till butiken och försök igen.')}
            </p>
            {backToShop}
          </div>
        )}
      </main>

      <ShopFooter />
    </div>
  );
};

export default CheckoutRecoveryPage;
