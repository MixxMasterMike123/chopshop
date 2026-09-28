import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import { useTranslation } from '../../contexts/TranslationContext';
import { submitWithdrawal } from '../../api/withdrawal';
import { toWithdrawalRequest, toWithdrawalView, withdrawalErrorKind } from '../../storefront/adapters/withdrawal';

/**
 * Ångerfunktionen — the public "Ångra avtalet här" page (DAL 2 kap. 10 a § /
 * CRD Art. 11a, in force 19 June 2026).
 *
 * The law requires a withdrawal function that is easily accessible in the online
 * interface THROUGHOUT the withdrawal period, clearly labelled ("ångra avtalet
 * här"), where the consumer states/confirms their NAME, details identifying the
 * CONTRACT (order number) and the EMAIL for the acknowledgement, and submits by
 * expressly confirming ("Bekräfta ångra"). This page is that function for ALL
 * buyers — including guest purchases without an account (requiring login here
 * would be the hoop-jumping the law prohibits). Ownership proof for guests =
 * order number + the purchase email, verified server-side by POST
 * /v1/withdrawals (the shop from the address, never from the page), which also
 * stamps the legally load-bearing time of receipt and returns the durable
 * mottagningsbevis rendered below. A second message for the same order gets
 * the first message's receipt, with its time.
 *
 * Linked from the footer on every storefront page (continuous availability) and
 * from the legal pages. There are no customer accounts on this storefront
 * (D81): every buyer withdraws here.
 */
const WithdrawalPage = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const prefillOrder = new URLSearchParams(location.search).get('order') || '';

  const [name, setName] = useState('');
  const [orderNumber, setOrderNumber] = useState(prefillOrder);
  const [contactEmail, setContactEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState(null);
  const [refusal, setRefusal] = useState(null); // 'personalized_exempt' | 'window_passed'
  const [error, setError] = useState(null);

  const canSubmit = name.trim() && orderNumber.trim() && contactEmail.trim() && !submitting;

  const handleConfirm = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setRefusal(null);
    try {
      const answer = await submitWithdrawal(toWithdrawalRequest({ orderNumber, name, contactEmail }));
      const view = toWithdrawalView(answer);
      if (view.refusal) {
        setRefusal(view.refusal);
      } else if (view.acknowledgement) {
        setAcknowledgement(view.acknowledgement);
      }
    } catch (err) {
      console.error('submitWithdrawal failed', err?.code);
      const kind = withdrawalErrorKind(err);
      if (kind === 'not_found') {
        setError(t(
          'withdrawal_page_not_found',
          'Vi hittade ingen beställning som matchar ordernumret och e-postadressen. Kontrollera uppgifterna — e-postadressen måste vara samma som vid köpet.'
        ));
      } else if (kind === 'rate_limited') {
        setError(t('withdrawal_page_rate_limited', 'För många försök. Vänta en stund och försök igen.'));
      } else {
        setError(t('withdrawal_page_error', 'Något gick fel. Försök igen.'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'w-full px-4 py-3 text-[15px] rounded-el border border-ink/15 bg-white text-ink ' +
    'placeholder:text-ink/35 focus:outline-hidden focus:ring-2 focus:ring-accent focus:border-accent';

  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      <Helmet>
        <title>{t('withdrawal_page_title', 'Ångra avtalet här')}</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <ShopNavigation />

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 py-12">
        {/* Statutory label — must be clear and easily legible (2 kap. 10 a § 1 st.) */}
        <h1 className="font-display text-4xl font-bold text-ink tracking-tight mb-3">
          {t('withdrawal_page_heading', 'Ångra avtalet här')}
        </h1>
        <p className="text-ink/70 mb-8 leading-relaxed">
          {t(
            'withdrawal_page_intro',
            'Som konsument har du normalt 14 dagars ångerrätt från den dag du tar emot varan. ' +
            'Här ångrar du ditt köp: fyll i dina uppgifter och bekräfta. Du får ett mottagningsbevis ' +
            'direkt på skärmen och via e-post. Du behöver inget konto.'
          )}
        </p>

        {acknowledgement ? (
          // ── Mottagningsbevis (acknowledgement of receipt) — durable on-screen copy ──
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
            <div className="rounded-el bg-green-50 border border-green-200 p-5">
              <p className="text-base font-semibold text-green-800">
                {t('order_withdrawal_receipt_title', 'Mottagningsbevis – ångrat köp')}
              </p>
              <p className="text-sm text-green-700 mt-2">
                {t('order_withdrawal_receipt_received', 'Mottaget')}: {acknowledgement.submittedAt}
              </p>
              <p className="text-sm text-green-700 mt-1">
                {t('withdrawal_page_receipt_order', 'Order')}: {acknowledgement.orderNumber}
              </p>
              {Array.isArray(acknowledgement.withdrawnItems) && acknowledgement.withdrawnItems.length > 0 && (
                <ul className="text-sm text-green-700 mt-2 list-disc pl-5">
                  {acknowledgement.withdrawnItems.map((it, i) => (
                    <li key={i}>{it.name}{it.sku ? ` (${it.sku})` : ''} × {it.quantity}</li>
                  ))}
                </ul>
              )}
              <p className="text-sm text-green-700 mt-3">{acknowledgement.statement}</p>
              <p className="text-xs text-green-600 mt-3">
                {t('order_withdrawal_receipt_save', 'Spara detta mottagningsbevis. Återbetalning hanteras enligt våra villkor.')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => window.print()}
              className="mt-5 bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity print:hidden"
            >
              {t('withdrawal_page_print', 'Skriv ut / spara')}
            </button>
          </div>
        ) : refusal === 'personalized_exempt' ? (
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
            <p className="text-ink/80">
              {t(
                'order_withdrawal_not_allowed_pod',
                'Den här beställningen innehåller specialtillverkade produkter – ångerrätten gäller inte. Reklamationsrätten vid fel på varan gäller alltid.'
              )}
            </p>
          </div>
        ) : refusal ? (
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8">
            <p className="text-ink/80">
              {t(
                'withdrawal_page_window_passed',
                'Det har gått för lång tid sedan beställningen för att den ska kunna ångras här. Kontakta oss om du har frågor.'
              )}
            </p>
          </div>
        ) : (
          // ── The online withdrawal statement (2 kap. 10 a § 2 st.): name +
          //    contract details (order number) + email for the mottagningsbevis ──
          <form onSubmit={handleConfirm} className="bg-white rounded-tile shadow-xs border border-ink/5 p-8 space-y-5">
            <div>
              <label htmlFor="wd-name" className="block text-sm font-medium text-ink mb-1.5">
                {t('order_withdrawal_name', 'Namn')}
              </label>
              <input
                id="wd-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="wd-order" className="block text-sm font-medium text-ink mb-1.5">
                {t('withdrawal_page_order_number', 'Ordernummer')}
              </label>
              <input
                id="wd-order"
                type="text"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder={t('withdrawal_page_order_placeholder', 'T.ex. ORD-123456-AB1C')}
                className={inputCls}
              />
              <p className="text-xs text-ink/50 mt-1.5">
                {t('withdrawal_page_order_hint', 'Ordernumret står i din orderbekräftelse.')}
              </p>
            </div>
            <div>
              <label htmlFor="wd-email" className="block text-sm font-medium text-ink mb-1.5">
                {t('withdrawal_page_email', 'E-postadress (samma som vid köpet)')}
              </label>
              <input
                id="wd-email"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                autoComplete="email"
                className={inputCls}
              />
              <p className="text-xs text-ink/50 mt-1.5">
                {t('withdrawal_page_email_hint', 'Hit skickar vi mottagningsbeviset.')}
              </p>
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-el px-4 py-3">{error}</p>
            )}

            {/* Statutory confirmation control (2 kap. 10 a § 2 st. 2 p.) */}
            <button
              type="submit"
              disabled={!canSubmit}
              className="bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting
                ? t('order_withdrawal_submitting', 'Skickar…')
                : t('order_withdrawal_confirm', 'Bekräfta ångra')}
            </button>
            <p className="text-xs text-ink/50 leading-relaxed">
              {t(
                'withdrawal_page_footnote',
                'Gäller inte specialtillverkade varor (t.ex. med din egen bild eller text) – det framgick i så fall vid köpet. Reklamationsrätten vid fel på varan gäller alltid.'
              )}
            </p>
          </form>
        )}
      </main>

      <ShopFooter />
    </div>
  );
};

export default WithdrawalPage;
