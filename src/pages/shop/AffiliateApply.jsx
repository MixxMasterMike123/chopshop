import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import { useTranslation } from '../../contexts/TranslationContext';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';
import { getCountryAwareUrl } from '../../utils/productUrls';
import {
  MESSAGE_MAX,
  applicationReady,
  applicationRefusal,
  getAffiliateTerms,
  submitAffiliateApplication,
  toApplicationBody,
} from '../../api/affiliate';

/**
 * "Bli affiliate" — the storefront's application form (CP13, design §5.1,
 * §7.4; NORD). Reached at `<root>/affiliate` only while the shop's
 * `affiliate` add-on is on (src/storefront/pages.jsx gates it). The terms are
 * the server's text for this shop (GET /v1/affiliate-terms), shown in full
 * and accepted with the version the page showed; the server refuses any
 * other version. The answer is the same for a new and a repeated address
 * (202): the page always thanks.
 *
 * The older build keeps AffiliateRegistration.jsx; this page is the
 * Cloudflare storefront's only.
 */

const CHANNELS = [
  ['blog', 'affiliate_apply_channel_blog', 'Blogg / webbplats'],
  ['youtube', 'affiliate_apply_channel_youtube', 'YouTube'],
  ['instagram', 'affiliate_apply_channel_instagram', 'Instagram'],
  ['facebook', 'affiliate_apply_channel_facebook', 'Facebook'],
  ['tiktok', 'affiliate_apply_channel_tiktok', 'TikTok'],
  ['forum', 'affiliate_apply_channel_forum', 'Forum'],
  ['other', 'affiliate_apply_channel_other', 'Annat'],
];

const LINKS = [
  ['website', 'affiliate_apply_link_website', 'Webbplats', 'https://'],
  ['instagram', 'affiliate_apply_link_instagram', 'Instagram', 'https://instagram.com/'],
  ['youtube', 'affiliate_apply_link_youtube', 'YouTube', 'https://youtube.com/@'],
  ['facebook', 'affiliate_apply_link_facebook', 'Facebook', 'https://facebook.com/'],
  ['tiktok', 'affiliate_apply_link_tiktok', 'TikTok', 'https://tiktok.com/@'],
];

const EMPTY_FORM = {
  name: '',
  email: '',
  phone: '',
  promotionMethod: '',
  socials: {},
  message: '',
  preferredLang: 'sv',
  termsAccepted: false,
};

const inputCls =
  // NORD §1.7: inputs at 16px (no zoom on a phone); placeholders at the muted tier (AA on white).
  'w-full px-4 py-3 text-base rounded-el border border-ink/15 bg-white text-ink ' +
  'placeholder:text-ink-muted focus:outline-hidden focus:ring-2 focus:ring-accent focus:border-accent';
const labelCls = 'block text-sm font-medium text-ink mb-1.5';

function Required() {
  return <span className="text-ink/40" aria-hidden="true"> *</span>;
}

const AffiliateApply = () => {
  const { t } = useTranslation();
  const store = useStoreSettings();
  const shopName = store?.shopName || t('affiliate_apply_the_shop', 'butiken');

  const [terms, setTerms] = useState(null);
  const [termsState, setTermsState] = useState('loading'); // loading | ready | error
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  const loadTerms = async () => {
    try {
      const next = await getAffiliateTerms();
      setTerms(next);
      setTermsState('ready');
      return next;
    } catch (err) {
      console.error('affiliate terms could not be read', err?.code);
      setTermsState('error');
      return null;
    }
  };

  useEffect(() => {
    loadTerms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const setLink = (key) => (e) =>
    setForm((prev) => ({ ...prev, socials: { ...prev.socials, [key]: e.target.value } }));

  const canSubmit = termsState === 'ready' && applicationReady(form) && !submitting;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitAffiliateApplication(toApplicationBody(form, terms.version));
      setSent(true);
      window.scrollTo?.({ top: 0 });
    } catch (err) {
      const refusal = applicationRefusal(err);
      if (refusal === 'rate_limited') {
        setError(t('affiliate_apply_rate_limited', 'Vi har tagit emot många ansökningar på kort tid. Vänta en stund och försök igen.'));
      } else if (refusal === 'invalid') {
        // The terms may have moved under the page: read them again.
        const fresh = await loadTerms();
        if (fresh && fresh.version !== terms.version) {
          setForm((prev) => ({ ...prev, termsAccepted: false }));
          setError(t('affiliate_apply_terms_changed', 'Villkoren har uppdaterats. Läs dem och kryssa i rutan igen.'));
        } else {
          setError(t('affiliate_apply_invalid', 'Något i formuläret kunde inte tas emot. Kontrollera e-postadressen och fälten och försök igen.'));
        }
      } else if (refusal === 'closed') {
        setError(t('affiliate_apply_closed', 'Butiken tar inte emot ansökningar just nu.'));
      } else {
        setError(t('affiliate_apply_error', 'Ansökan kunde inte skickas. Försök igen.'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const paragraphs = typeof terms?.text === 'string' ? terms.text.split(/\n{2,}/).filter(Boolean) : [];

  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      <Helmet>
        <title>{t('affiliate_apply_title', 'Bli affiliate hos {{shop_name}}', { shop_name: shopName })}</title>
      </Helmet>
      <ShopNavigation />

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-ink tracking-tight mb-3 text-balance">
          {t('affiliate_apply_heading', 'Bli affiliate hos {{shop_name}}', { shop_name: shopName })}
        </h1>

        {sent ? (
          <div className="bg-white rounded-tile shadow-xs border border-ink/5 p-8" role="status">
            <p className="font-display text-xl font-bold text-ink">
              {t('affiliate_apply_thanks', 'Tack! Vi hör av oss inom 1–3 arbetsdagar.')}
            </p>
            <p className="text-ink/70 mt-2 leading-relaxed">
              {t('affiliate_apply_thanks_detail', 'Du får ett mejl när ansökan har tagits emot, och ett till när butiken har bestämt sig.')}
            </p>
            <Link
              to={getCountryAwareUrl('')}
              className="inline-block mt-6 bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity"
            >
              {t('affiliate_apply_back', 'Till butiken')}
            </Link>
          </div>
        ) : (
          <>
            <p className="text-ink/70 mb-8 leading-relaxed">
              {t(
                'affiliate_apply_intro',
                'Tipsa om {{shop_name}} med en egen länk och rabattkod. Den som handlar via dig får rabatt, och du får provision på köpet. Fyll i formuläret, så återkommer butiken.',
                { shop_name: shopName },
              )}
            </p>

            <form onSubmit={handleSubmit} className="bg-white rounded-tile shadow-xs border border-ink/5 p-6 sm:p-8 space-y-6" noValidate>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="sm:col-span-2">
                  <label htmlFor="af-name" className={labelCls}>
                    {t('affiliate_apply_name', 'Namn')}<Required />
                  </label>
                  <input id="af-name" type="text" value={form.name} onChange={set('name')} autoComplete="name" maxLength={100} required className={inputCls} />
                </div>
                <div>
                  <label htmlFor="af-email" className={labelCls}>
                    {t('affiliate_apply_email', 'E-post')}<Required />
                  </label>
                  <input id="af-email" type="email" value={form.email} onChange={set('email')} autoComplete="email" required className={inputCls} />
                </div>
                <div>
                  <label htmlFor="af-phone" className={labelCls}>
                    {t('affiliate_apply_phone', 'Telefon')}
                  </label>
                  <input id="af-phone" type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" maxLength={40} className={inputCls} />
                </div>
                <div>
                  <label htmlFor="af-channel" className={labelCls}>
                    {t('affiliate_apply_channel', 'Kanal')}<Required />
                  </label>
                  <select id="af-channel" value={form.promotionMethod} onChange={set('promotionMethod')} required className={inputCls}>
                    <option value="">{t('affiliate_apply_channel_pick', 'Välj din viktigaste kanal')}</option>
                    {CHANNELS.map(([value, key, fallback]) => (
                      <option key={value} value={value}>{t(key, fallback)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="af-lang" className={labelCls}>
                    {t('affiliate_apply_language', 'Språk')}<Required />
                  </label>
                  <select id="af-lang" value={form.preferredLang} onChange={set('preferredLang')} required className={inputCls}>
                    <option value="sv">Svenska</option>
                    <option value="en">English</option>
                  </select>
                </div>
              </div>

              <fieldset>
                <legend className={labelCls}>{t('affiliate_apply_links', 'Länkar')}</legend>
                <p className="text-sm text-ink-muted -mt-0.5 mb-3">
                  {t('affiliate_apply_links_hint', 'Fyll i de kanaler du använder.')}
                </p>
                <div className="space-y-3">
                  {LINKS.map(([key, labelKey, fallback, placeholder]) => (
                    <div key={key} className="grid grid-cols-1 sm:grid-cols-[7rem_1fr] sm:items-center gap-1.5 sm:gap-3">
                      <label htmlFor={`af-link-${key}`} className="text-sm text-ink/70">{t(labelKey, fallback)}</label>
                      <input
                        id={`af-link-${key}`}
                        type="url"
                        inputMode="url"
                        value={form.socials[key] || ''}
                        onChange={setLink(key)}
                        placeholder={placeholder}
                        maxLength={300}
                        className={inputCls}
                      />
                    </div>
                  ))}
                </div>
              </fieldset>

              <div>
                <label htmlFor="af-message" className={labelCls}>
                  {t('affiliate_apply_about', 'Berätta om dig')}
                </label>
                <textarea
                  id="af-message"
                  rows={4}
                  value={form.message}
                  onChange={set('message')}
                  maxLength={MESSAGE_MAX}
                  placeholder={t('affiliate_apply_about_placeholder', 'Vem är din publik, och hur vill du tipsa om butiken?')}
                  className={inputCls}
                />
              </div>

              <section aria-labelledby="af-terms-heading">
                <h2 id="af-terms-heading" className={labelCls}>
                  {t('affiliate_apply_terms_heading', 'Affiliatevillkor')}
                  {terms?.version ? <span className="text-ink-muted font-normal"> · {t('affiliate_apply_terms_version', 'version {{version}}', { version: terms.version })}</span> : null}
                </h2>
                {termsState === 'loading' && (
                  <p className="text-sm text-ink-muted">{t('affiliate_apply_terms_loading', 'Hämtar villkoren…')}</p>
                )}
                {termsState === 'error' && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-el px-4 py-3">
                    {t('affiliate_apply_terms_error', 'Villkoren kunde inte hämtas. Ladda om sidan och försök igen.')}
                  </p>
                )}
                {termsState === 'ready' && (
                  <div
                    className="max-h-72 overflow-y-auto rounded-el border border-ink/10 bg-canvas px-4 py-3 text-sm text-ink/80 leading-relaxed space-y-3"
                    tabIndex={0}
                  >
                    {paragraphs.map((text, i) =>
                      i === 0 ? (
                        <p key={i} className="font-semibold text-ink">{text}</p>
                      ) : (
                        <p key={i}>{text}</p>
                      ),
                    )}
                  </div>
                )}
                <label htmlFor="af-terms" className="mt-4 flex items-start gap-3 text-sm text-ink cursor-pointer">
                  <input
                    id="af-terms"
                    type="checkbox"
                    checked={form.termsAccepted}
                    onChange={(e) => setForm((prev) => ({ ...prev, termsAccepted: e.target.checked }))}
                    disabled={termsState !== 'ready'}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-ink/30 accent-[var(--color-accent)]"
                  />
                  <span>
                    {t('affiliate_apply_terms_accept_before', 'Jag godkänner affiliatevillkoren (version {{version}}) och att mina uppgifter behandlas enligt ', { version: terms?.version ?? '–' })}
                    <Link to={getCountryAwareUrl('legal/integritetspolicy')} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-accent">
                      {t('affiliate_apply_terms_privacy', 'integritetspolicyn')}
                    </Link>
                    <Required />
                  </span>
                </label>
              </section>

              {error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-el px-4 py-3" role="alert">{error}</p>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {submitting ? t('affiliate_apply_sending', 'Skickar…') : t('affiliate_apply_submit', 'Skicka ansökan')}
                </button>
                <p className="text-sm text-ink-muted">{t('affiliate_apply_required_note', '* obligatoriskt')}</p>
              </div>
            </form>
          </>
        )}
      </main>

      <ShopFooter />
    </div>
  );
};

export default AffiliateApply;
