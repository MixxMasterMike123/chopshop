import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { doc, getDoc } from 'firebase/firestore';
import { Helmet } from 'react-helmet-async';
import { db } from '../../firebase/config';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import { useShopId } from '../../contexts/ShopContext';
import { useCart } from '../../contexts/CartContext';
import { useTranslation } from '../../contexts/TranslationContext';

/**
 * Checkout recovery page — /{shopId}/aterta/:token.
 *
 * Reached from the abandoned-checkout reminder email. On mount it resolves the
 * checkout server-side (resolveCheckoutRecovery, which returns only line refs —
 * no prices, no PII), then rebuilds the cart through the NORMAL CartContext add
 * path (fetching each live product so the server-recomputed price at payment
 * matches — total-parity invariant), and forwards to the checkout.
 *
 * States: loading → (invalid → shop home) | (completed → friendly panel) |
 * (open → restore cart → /{shopId}/checkout). Works even if the add-on was later
 * disabled (no AddonGate) — the recovery link must never dead-end.
 */
const CheckoutRecoveryPage = () => {
  const shopId = useShopId();
  const { token } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { clearCart, addToCart } = useCart();

  const [status, setStatus] = useState('loading'); // 'loading' | 'completed' | 'error'
  const ranRef = useRef(false); // guard against double-run (StrictMode / re-render)

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      try {
        const functions = getFunctions(undefined, 'us-central1');
        const resolveCheckoutRecovery = httpsCallable(functions, 'resolveCheckoutRecovery');
        const res = await resolveCheckoutRecovery({ shopId, token });
        const data = res?.data || {};

        if (data.status === 'invalid') {
          navigate(`/${shopId}`, { replace: true });
          return;
        }
        if (data.status === 'completed') {
          setStatus('completed');
          return;
        }

        // Open: rebuild the cart from live products, then go to checkout.
        const items = Array.isArray(data.items) ? data.items : [];
        clearCart();

        let anyMissing = false;
        for (const it of items) {
          const productId = it.productId;
          if (!productId) { anyMissing = true; continue; }
          try {
            const snap = await getDoc(doc(db, 'productsPublic', productId));
            if (!snap.exists()) { anyMissing = true; continue; }
            const productData = snap.data();
            // Only restore products that still belong to this shop, are active
            // and B2C-available (the server would reject anything else at payment).
            if (
              productData.shopId !== shopId ||
              productData.isActive === false ||
              productData.availability?.b2c === false
            ) {
              anyMissing = true;
              continue;
            }
            const product = { id: snap.id, ...productData };
            // Match the saved variant by sku against the embedded variants.
            const variantSku = it.variantSku || it.sku || '';
            let matchedVariant = null;
            if (variantSku && Array.isArray(product.variants)) {
              matchedVariant = product.variants.find((v) => v && v.sku === variantSku) || null;
            }
            const quantity = Number(it.quantity) || 1;
            addToCart(product, quantity, matchedVariant);
          } catch (e) {
            console.warn('CheckoutRecovery: could not restore item', productId, e?.message);
            anyMissing = true;
          }
        }

        if (anyMissing) {
          // Non-blocking notice — the buyer still proceeds with whatever restored.
          try {
            const toast = (await import('react-hot-toast')).default;
            toast(t('checkout_recovery_partial', 'Vissa varor har uppdaterats sedan du var här sist.'));
          } catch { /* toast is best-effort */ }
        }

        navigate(`/${shopId}/checkout`, { replace: true });
      } catch (err) {
        console.error('resolveCheckoutRecovery failed', err);
        setStatus('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
              {t('checkout_recovery_completed_body', 'Den här beställningen är redan slutförd. Tack för ditt köp!')}
            </p>
            <a
              href={`/${shopId}`}
              className="inline-block bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity"
            >
              {t('checkout_recovery_back_to_shop', 'Till butiken')}
            </a>
          </div>
        )}

        {status === 'error' && (
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
            <p className="text-ink/80 mb-6">
              {t('checkout_recovery_error', 'Något gick fel när vi skulle återställa din varukorg. Gå till butiken och försök igen.')}
            </p>
            <a
              href={`/${shopId}`}
              className="inline-block bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity"
            >
              {t('checkout_recovery_back_to_shop', 'Till butiken')}
            </a>
          </div>
        )}
      </main>

      <ShopFooter />
    </div>
  );
};

export default CheckoutRecoveryPage;
