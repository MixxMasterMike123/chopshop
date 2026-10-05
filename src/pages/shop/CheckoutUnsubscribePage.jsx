import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';
import { useTranslation } from '../../contexts/TranslationContext';
import { getCountryAwareUrl } from '../../utils/productUrls';
import { unsubscribeCheckoutReminders } from '../../api/checkoutRecovery';

/**
 * Checkout-reminder unsubscribe page — <root>/avregistrera/:token (CP9-AC).
 *
 * Reached from the footer link of the abandoned-checkout reminder email. It
 * unsubscribes as soon as it opens (AC14; the call is idempotent) and says
 * what actually happened (F2): done, a link that does not work (with where
 * else to turn), or a failure with a retry. It never claims a success it did
 * not get. Mail providers' one-click control posts to the API route itself,
 * without this page (List-Unsubscribe-Post).
 *
 * No add-on gate: unsubscribing must work whatever the shop's settings.
 */
const CheckoutUnsubscribePage = () => {
  const { token } = useParams();
  const { t } = useTranslation();
  const store = useStoreSettings();
  const shop = String(store?.shopName || '').trim() || t('checkout_terms_seller_fallback', 'butiken');
  const supportEmail = String(store?.supportEmail || '').trim();

  const [status, setStatus] = useState('loading'); // 'loading' | 'done' | 'invalid' | 'error'
  const ranRef = useRef(false);

  const unsubscribe = useCallback(async () => {
    setStatus('loading');
    try {
      setStatus((await unsubscribeCheckoutReminders(token)) ? 'done' : 'invalid');
    } catch (err) {
      console.warn('checkout reminder unsubscribe failed', err?.code || err?.name);
      setStatus('error');
    }
  }, [token]);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    unsubscribe();
  }, [unsubscribe]);

  const button = 'inline-block bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity';

  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      <Helmet>
        <title>{t('checkout_unsub_title', 'Avregistrera påminnelser')}</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <ShopNavigation />

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 py-16">
        <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
          {status === 'loading' && (
            <div className="text-center py-6">
              <span className="inline-block h-6 w-6 animate-spin rounded-full border-b-2 border-accent" />
              <p className="mt-4 text-ink/70">
                {t('checkout_unsub_loading', 'Avregistrerar…')}
              </p>
            </div>
          )}

          {status === 'done' && (
            <>
              <h1 className="font-display text-3xl font-bold text-ink tracking-tight mb-3">
                {t('checkout_unsub_done_title', 'Du är avregistrerad från påminnelser')}
              </h1>
              <p className="text-ink/70 mb-6 leading-relaxed">
                {t('checkout_unsub_done_body', 'Vi skickar inga fler påminnelser om varukorgar från {{shop}}. Du kan handla i butiken som vanligt.', { shop })}
              </p>
              <a href={getCountryAwareUrl('')} className={button}>
                {t('checkout_unsub_back_to_shop', 'Till butiken')}
              </a>
            </>
          )}

          {status === 'invalid' && (
            <>
              <h1 className="font-display text-3xl font-bold text-ink tracking-tight mb-3">
                {t('checkout_unsub_invalid_title', 'Länken fungerar inte längre.')}
              </h1>
              <p className="text-ink/70 mb-6 leading-relaxed">
                {supportEmail
                  ? t('checkout_unsub_invalid_body', 'Vill du inte få påminnelser från {{shop}}? Svara på mejlet eller kontakta butiken på {{email}}.', { shop, email: supportEmail })
                  : t('checkout_unsub_invalid_body_no_email', 'Vill du inte få påminnelser från {{shop}}? Svara på mejlet eller kontakta butiken.', { shop })}
              </p>
              <a href={getCountryAwareUrl('')} className={button}>
                {t('checkout_unsub_back_to_shop', 'Till butiken')}
              </a>
            </>
          )}

          {status === 'error' && (
            <>
              <p className="text-ink/80 mb-6">
                {t('checkout_unsub_error', 'Något gick fel. Försök igen om en stund.')}
              </p>
              <button type="button" onClick={unsubscribe} className={button}>
                {t('checkout_unsub_retry', 'Försök igen')}
              </button>
            </>
          )}
        </div>
      </main>

      <ShopFooter />
    </div>
  );
};

export default CheckoutUnsubscribePage;
