import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { doc, getDoc } from 'firebase/firestore';
import { Helmet } from 'react-helmet-async';
import { db } from '../../firebase/config';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import { useShopId } from '../../contexts/ShopContext';
import { useTranslation } from '../../contexts/TranslationContext';

/**
 * "Rapportera intrång" — notice & takedown (SnapWear A10).
 *
 * A public page on EVERY storefront (footer link) where a rights holder, or
 * someone acting for one, reports a product that uses their trademark or
 * copyrighted work. The report goes to the PLATFORM, not the shop (the seller
 * is the reported party) via the submitInfringementReport callable, which
 * resolves the product, stores the report and emails the platform.
 *
 * Product pre-fill, two ways:
 *   ?product=<productId>  — explicit link; the name is read from the public
 *                           catalogue mirror (productsPublic) for display.
 *   router state `from`   — the footer link carries the page it was clicked
 *                           on, so a report started from a product page gets
 *                           that product's URL filled in automatically.
 *
 * Plain Swedish on purpose: the reader is often a small artist or band, not a
 * lawyer. The good-faith statement is the one legal sentence (Kent's wording).
 */
const RIGHT_TYPES = [
  { value: 'trademark', key: 'infringement_right_trademark', label: 'Varumärke', hint: 'Ett namn eller en logga' },
  { value: 'copyright', key: 'infringement_right_copyright', label: 'Upphovsrätt', hint: 'En bild, illustration eller text' },
  { value: 'other', key: 'infringement_right_other', label: 'Annat', hint: 'Något annat som är ditt' },
];

const MIN_DESCRIPTION = 20;

const InfringementReportPage = () => {
  const shopId = useShopId();
  const { t } = useTranslation();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const prefillProductId = params.get('product') || '';
  const fromPath = typeof location.state?.from === 'string' ? location.state.from : '';
  const prefillUrl = fromPath.includes('/product/') ? `${window.location.origin}${fromPath}` : '';

  const [form, setForm] = useState({
    reporterName: '',
    reporterOrg: '',
    reporterEmail: '',
    productUrl: prefillUrl,
    rightType: '',
    description: '',
    attestation: false,
    website: '', // honeypot
  });
  const [productName, setProductName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reportId, setReportId] = useState(null);
  const [error, setError] = useState(null);

  // ?product=<id> → show which product the report is about. Only a product of
  // THIS shop counts; anything else is ignored (the server re-checks anyway).
  useEffect(() => {
    if (!prefillProductId) return undefined;
    let cancelled = false;
    getDoc(doc(db, 'productsPublic', prefillProductId))
      .then((snap) => {
        if (cancelled || !snap.exists() || snap.data().shopId !== shopId) return;
        const n = snap.data().name;
        setProductName(typeof n === 'string' ? n : (n && Object.values(n)[0]) || '');
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [prefillProductId, shopId]);

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const hasProduct = Boolean(productName || form.productUrl.trim());
  const descLength = form.description.trim().length;
  const canSubmit =
    form.reporterName.trim() &&
    form.reporterEmail.trim() &&
    hasProduct &&
    form.rightType &&
    descLength >= MIN_DESCRIPTION &&
    form.attestation &&
    !submitting;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const functions = getFunctions(undefined, 'us-central1');
      const submit = httpsCallable(functions, 'submitInfringementReport');
      const res = await submit({
        shopId,
        productId: productName ? prefillProductId : '',
        productUrl: form.productUrl.trim(),
        reporterName: form.reporterName.trim(),
        reporterOrg: form.reporterOrg.trim(),
        reporterEmail: form.reporterEmail.trim(),
        rightType: form.rightType,
        description: form.description.trim(),
        attestation: form.attestation === true,
        website: form.website,
      });
      setReportId(res?.data?.reportId || '');
      window.scrollTo?.({ top: 0, behavior: 'smooth' });
    } catch (err) {
      console.error('submitInfringementReport failed', err);
      if (err?.code === 'functions/resource-exhausted') {
        setError(t('infringement_rate_limited', 'För många försök. Vänta en stund och försök igen.'));
      } else if (err?.code === 'functions/invalid-argument') {
        setError(t('infringement_invalid', 'Något i formuläret stämmer inte. Kontrollera fälten och försök igen.'));
      } else {
        setError(t('infringement_error', 'Något gick fel. Försök igen.'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'w-full px-4 py-3 text-[15px] rounded-el border border-ink/15 bg-white text-ink ' +
    'placeholder:text-ink/35 focus:outline-hidden focus:ring-2 focus:ring-accent focus:border-accent';
  const labelCls = 'block text-sm font-medium text-ink mb-1.5';
  const hintCls = 'text-xs text-ink/50 mt-1.5';

  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      <Helmet>
        <title>{t('infringement_page_title', 'Rapportera intrång')}</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <ShopNavigation />

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="font-display text-4xl font-bold text-ink tracking-tight mb-3">
          {t('infringement_page_heading', 'Rapportera intrång')}
        </h1>
        <p className="text-ink/70 mb-8 leading-relaxed">
          {t(
            'infringement_page_intro',
            'Säljs en produkt här som använder ditt varumärke, din bild eller något annat som är ditt – utan lov? ' +
            'Berätta vilken produkt det gäller. Vi läser alla anmälningar och stänger av produkten om anmälan stämmer.'
          )}
        </p>

        {reportId !== null ? (
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8" role="status">
            <div className="rounded-el bg-green-50 border border-green-200 p-5">
              <p className="text-base font-semibold text-green-800">
                {t('infringement_success_title', 'Anmälan skickad')}
              </p>
              <p className="text-sm text-green-700 mt-2 leading-relaxed">
                {t(
                  'infringement_success_body',
                  'Tack. Vi granskar anmälan inom 24 timmar och stänger av produkten om anmälan är befogad.'
                )}
              </p>
              {reportId && (
                <p className="text-sm text-green-700 mt-3">
                  {t('infringement_success_reference', 'Ärendenummer')}: <span className="font-mono">{reportId}</span>
                </p>
              )}
            </div>
            <p className="text-xs text-ink/50 mt-4">
              {t('infringement_success_followup', 'Behöver vi veta mer hör vi av oss till e-postadressen du angav.')}
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="relative bg-white rounded-tile shadow-xs border border-ink/5 p-6 sm:p-8 space-y-6">
            {/* ── Vem är du ── */}
            <fieldset className="space-y-5">
              <legend className="font-display text-lg font-bold text-ink tracking-tight mb-4">
                {t('infringement_section_you', 'Om dig')}
              </legend>
              <div>
                <label htmlFor="ir-name" className={labelCls}>{t('infringement_name', 'Ditt namn')}</label>
                <input id="ir-name" type="text" value={form.reporterName} onChange={set('reporterName')} autoComplete="name" className={inputCls} />
              </div>
              <div>
                <label htmlFor="ir-org" className={labelCls}>
                  {t('infringement_org', 'Företag eller rättighetshavare')}{' '}
                  <span className="font-normal text-ink/50">{t('infringement_optional', '(valfritt)')}</span>
                </label>
                <input id="ir-org" type="text" value={form.reporterOrg} onChange={set('reporterOrg')} autoComplete="organization" className={inputCls} />
                <p className={hintCls}>{t('infringement_org_hint', 'Om du anmäler för någon annans räkning, t.ex. ett band eller ett bolag.')}</p>
              </div>
              <div>
                <label htmlFor="ir-email" className={labelCls}>{t('infringement_email', 'E-postadress')}</label>
                <input id="ir-email" type="email" value={form.reporterEmail} onChange={set('reporterEmail')} autoComplete="email" className={inputCls} />
                <p className={hintCls}>{t('infringement_email_hint', 'Hit hör vi av oss om vi behöver veta mer.')}</p>
              </div>
            </fieldset>

            <hr className="border-ink/10" />

            {/* ── Vad gäller det ── */}
            <fieldset className="space-y-5">
              <legend className="font-display text-lg font-bold text-ink tracking-tight mb-4">
                {t('infringement_section_what', 'Vad gäller det?')}
              </legend>
              <div>
                <label htmlFor="ir-product" className={labelCls}>{t('infringement_product', 'Produkt')}</label>
                {productName && (
                  <p className="mb-2 rounded-el bg-canvas border border-ink/10 px-4 py-3 text-[15px] text-ink">
                    {productName}
                  </p>
                )}
                <input
                  id="ir-product"
                  type="text"
                  value={form.productUrl}
                  onChange={set('productUrl')}
                  placeholder={productName
                    ? t('infringement_product_extra_placeholder', 'Fler produkter? Klistra in länkarna här (valfritt)')
                    : t('infringement_product_placeholder', 'Länk till produkten eller dess namn')}
                  className={inputCls}
                />
              </div>

              <div role="radiogroup" aria-labelledby="ir-right-label">
                <p id="ir-right-label" className={labelCls}>{t('infringement_right', 'Vad är det som används utan lov?')}</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {RIGHT_TYPES.map((r) => {
                    const checked = form.rightType === r.value;
                    return (
                      <label
                        key={r.value}
                        className={
                          'flex cursor-pointer flex-col rounded-el border px-4 py-3 transition-colors ' +
                          'focus-within:ring-2 focus-within:ring-accent ' +
                          (checked ? 'border-accent bg-accent/5' : 'border-ink/15 bg-white hover:border-ink/30')
                        }
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="rightType"
                            value={r.value}
                            checked={checked}
                            onChange={set('rightType')}
                            className="h-4 w-4 accent-[var(--color-accent)] shrink-0"
                          />
                          <span className="text-[15px] font-medium text-ink">{t(r.key, r.label)}</span>
                        </span>
                        <span className="mt-1 pl-6 text-xs text-ink/55">{t(`${r.key}_hint`, r.hint)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <label htmlFor="ir-desc" className={labelCls}>{t('infringement_description', 'Beskriv kort')}</label>
                <textarea
                  id="ir-desc"
                  rows={5}
                  value={form.description}
                  onChange={set('description')}
                  placeholder={t('infringement_description_placeholder', 'Vad är ditt, och hur används det i produkten? Länka gärna till ditt original eller din registrering.')}
                  className={inputCls + ' resize-y'}
                />
                <p className={hintCls + (descLength > 0 && descLength < MIN_DESCRIPTION ? ' text-ink/70' : '')}>
                  {descLength < MIN_DESCRIPTION
                    ? t('infringement_description_min', 'Minst {n} tecken').replace('{n}', String(MIN_DESCRIPTION)) +
                      (descLength > 0 ? ` · ${descLength}/${MIN_DESCRIPTION}` : '')
                    : t('infringement_description_ok', 'Tack, det räcker.')}
                </p>
              </div>
            </fieldset>

            {/* Honeypot — hidden from humans (off-screen + untabbable); bots
                that fill it get rejected server-side. */}
            <input
              type="text"
              name="website"
              value={form.website}
              onChange={set('website')}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
            />

            <div className="flex items-start gap-3 rounded-el bg-canvas border border-ink/10 p-4">
              <input
                id="ir-attest"
                type="checkbox"
                checked={form.attestation}
                onChange={set('attestation')}
                className="h-4 w-4 accent-[var(--color-accent)] border-ink/20 rounded-sm mt-0.5 shrink-0"
              />
              <label htmlFor="ir-attest" className="text-sm text-ink/80 leading-relaxed">
                {t(
                  'infringement_attestation',
                  'Jag intygar att uppgifterna är korrekta och att jag är rättighetshavare eller behörig att företräda denne.'
                )}
              </label>
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-el px-4 py-3">{error}</p>
            )}

            <div>
              <button
                type="submit"
                disabled={!canSubmit}
                className="bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting
                  ? t('infringement_submitting', 'Skickar…')
                  : t('infringement_submit', 'Skicka anmälan')}
              </button>
              <p className="text-xs text-ink/50 leading-relaxed mt-3">
                {t(
                  'infringement_footnote',
                  'Anmälan går till plattformen som driver butiken, inte till butiksägaren. Dina uppgifter används bara för att hantera anmälan.'
                )}
              </p>
            </div>
          </form>
        )}
      </main>

      <ShopFooter />
    </div>
  );
};

export default InfringementReportPage;
