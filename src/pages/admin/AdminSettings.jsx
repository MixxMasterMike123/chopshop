// AdminSettings.jsx — store/application settings. Add-ons are controlled per
// shop from the PLATFORM console (/addons); the old per-user wagon toggle was
// removed (add-ons S4, docs/ADDONS_PLATFORM_CONTROL_PLAN.md).
import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addDoc, collection, doc, getDocs, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import AppLayout from '../../components/layout/AppLayout';
import toast from 'react-hot-toast';
import { db } from '../../firebase/config';
import { STORE } from '../../config/store';
import { loadShopConfig, saveShopConfig, loadCartRecovery, saveCartRecovery, loadReviewSettings, saveReviewSettings } from '../../config/shopConfig';
import { withShopId } from '../../config/withShopId';
import { APP_URLS } from '../../config/urls';
import { useShopId } from '../../contexts/ShopContext';
import { useAuth } from '../../contexts/AuthContext';
import { useShopFeatures } from '../../contexts/ShopFeaturesContext';
import { getLegalReadiness } from '../../utils/legalPageReadiness';
import {
  LEGAL_ACCEPTANCE_LABEL,
  LEGAL_PAGES,
  LEGAL_PAGE_KEYS,
  LEGAL_TEMPLATE_DISCLAIMER,
} from '../../config/legalTemplates';
import { renderLegalPage } from '../../utils/legalPageRenderer';
import { recordLegalAcceptance } from '../../utils/legalAcceptance';
import PickupLocationsEditor from '../../components/admin/PickupLocationsEditor';
import {
  Page,
  Card,
  CardSection,
  Button,
} from '../../components/admin/ui';

// Icons
import {
  CheckIcon,
} from '@heroicons/react/24/outline';

const AdminSettings = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [storeForm, setStoreForm] = useState(STORE);
  // The shop this admin manages (impersonation > shop-admin's own shop > path).
  // Config MUST read/write THIS shop, not the default — else a non-default shop
  // (e.g. 'sillmans') would save to 'b8shield' and the storefront, which reads
  // its own shopId, would never see the change (pickup locations, branding…).
  const shopId = useShopId();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const { isEnabled } = useShopFeatures();
  const abandonedCheckoutEnabled = isEnabled('abandonedCheckout');
  const productReviewsEnabled = isEnabled('productReviews');

  // Cart-recovery ("Övergiven kassa") reminder delay (hours). Loaded/saved via
  // the dedicated cartRecovery seam. Default 1h, clamped 1–24.
  const [cartRecoveryDelay, setCartRecoveryDelay] = useState(1);
  const [savingRecovery, setSavingRecovery] = useState(false);

  // Product-reviews ("Recensioner") request delay (days). Loaded/saved via the
  // dedicated productReviews seam. Default 7d, clamped 3–21.
  const [reviewDelayDays, setReviewDelayDays] = useState(7);
  const [savingReviews, setSavingReviews] = useState(false);

  // Seed the store-identity form from the shopConfig SEAM for THIS shop.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let saved = {};
      try {
        saved = (await loadShopConfig(shopId)) || {};
      } catch (e) {
        console.warn('AdminSettings: could not load shop config, using defaults:', e?.message);
      }
      if (cancelled) return;
      setStoreForm({ ...STORE, ...Object.fromEntries(
        Object.entries(saved).filter(([, v]) => v !== undefined && v !== null && v !== '')
      ) });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  // Load the cart-recovery reminder delay for THIS shop (default 1h).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cr = (await loadCartRecovery(shopId)) || {};
        const n = Number(cr.delayHours);
        if (!cancelled) {
          setCartRecoveryDelay(Number.isFinite(n) ? Math.min(24, Math.max(1, Math.round(n))) : 1);
        }
      } catch (e) {
        console.warn('AdminSettings: could not load cart recovery config:', e?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  // Load the product-reviews request delay for THIS shop (default 7d).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pr = (await loadReviewSettings(shopId)) || {};
        const n = Number(pr.requestDelayDays);
        if (!cancelled) {
          setReviewDelayDays(Number.isFinite(n) ? Math.min(21, Math.max(3, Math.round(n))) : 7);
        }
      } catch (e) {
        console.warn('AdminSettings: could not load review settings:', e?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  const saveReviewSettingsHandler = useCallback(async () => {
    try {
      setSavingReviews(true);
      const clamped = Math.min(21, Math.max(3, Math.round(Number(reviewDelayDays) || 7)));
      await saveReviewSettings({ requestDelayDays: clamped }, shopId);
      setReviewDelayDays(clamped);
      toast.success('Inställningar för recensioner sparade.');
    } catch (error) {
      console.error('Error saving review settings:', error);
      toast.error('Fel vid sparande av inställningar för recensioner');
    } finally {
      setSavingReviews(false);
    }
  }, [reviewDelayDays, shopId]);

  const saveCartRecoverySettings = useCallback(async () => {
    try {
      setSavingRecovery(true);
      const clamped = Math.min(24, Math.max(1, Math.round(Number(cartRecoveryDelay) || 1)));
      await saveCartRecovery({ delayHours: clamped }, shopId);
      setCartRecoveryDelay(clamped);
      toast.success('Inställningar för övergiven kassa sparade.');
    } catch (error) {
      console.error('Error saving cart recovery settings:', error);
      toast.error('Fel vid sparande av inställningar för övergiven kassa');
    } finally {
      setSavingRecovery(false);
    }
  }, [cartRecoveryDelay, shopId]);

  // Save store identity via the shopConfig seam for THIS shop.
  const saveStoreIdentity = useCallback(async () => {
    try {
      setSaving(true);
      // `legal` is co-owned (acceptance pointer, custom flags, customUpdatedAt
      // are written by legalAcceptance.js / AdminPageEdit as narrow leaf
      // patches). Write only the one legal field THIS form edits, so a stale
      // mount-time copy never reverts the others. Merge is leaf-by-leaf.
      const { legal, ...rest } = storeForm;
      const patch = legal && typeof legal.noWithdrawalNotice === 'string'
        ? { ...rest, legal: { noWithdrawalNotice: legal.noWithdrawalNotice } }
        : rest;
      await saveShopConfig(patch, shopId);
      toast.success('Butiksinställningar sparade. Ladda om butiken för att se ändringarna.');
    } catch (error) {
      console.error('Error saving store identity:', error);
      toast.error('Fel vid sparande av butiksinställningar');
    } finally {
      setSaving(false);
    }
  }, [storeForm, shopId]);

  // ── Juridiska sidor: copy-on-write + seller acceptance ────────────────────
  // A legal page is either the PLATFORM TEMPLATE (default) or the SELLER's own
  // text (a CMS `pages` doc on the same legal slug, flagged in
  // storeIdentity.legal.custom[key]). Taking over the text copies the currently
  // rendered template into that CMS page, so the seller starts from the full
  // legal text rather than a blank editor.
  const [legalBusyKey, setLegalBusyKey] = useState('');   // key being switched
  const [legalAccepted, setLegalAccepted] = useState(false); // the checkbox
  const [acceptingLegal, setAcceptingLegal] = useState(false);

  // Read the content of a multilingual-or-plain CMS field. Mirrors
  // useContentTranslation().getContentValue / DynamicPage, but standalone: the
  // acceptance snapshot must capture the SWEDISH consumer text regardless of
  // which admin UI language happens to be active.
  const readContentValue = useCallback((field) => {
    if (!field) return '';
    if (typeof field === 'string') return field;
    if (typeof field === 'object') {
      if (field['sv-SE']) return field['sv-SE'];
      const first = Object.keys(field)[0];
      if (first) return field[first] || '';
    }
    return '';
  }, []);

  // Find this shop's CMS page on a given slug, if it exists.
  // Nothing enforces slug uniqueness on `pages`, so more than one doc can share
  // a slug. Prefer a PUBLISHED one — that is the doc DynamicPage serves — so the
  // editor, the acceptance snapshot and the storefront all resolve to the same
  // document instead of an arbitrary `docs[0]`.
  const findLegalPage = useCallback(async (slug, { publishedOnly = false } = {}) => {
    const snap = await getDocs(query(
      collection(db, 'pages'),
      where('shopId', '==', shopId),
      where('slug', '==', slug)
    ));
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const published = docs.find((p) => p.status === 'published');
    if (publishedOnly) return published || null;
    return published || docs[0] || null;
  }, [shopId]);

  // Persist a legal patch to storeIdentity.legal AND mirror it into the local
  // form, so the readiness banner + the rows re-render without a reload.
  //
  // ⚠️ The patch is passed to saveShopConfig UNMODIFIED, never merged with the
  // local storeForm.legal first. `legal` is co-owned: AdminPageEdit stamps
  // customUpdatedAt and legalAcceptance.js writes the acceptance pointer, both
  // as narrow leaf patches. Firestore's setDoc(merge:true) deep-merges nested
  // maps leaf by leaf, so a narrow patch touches only its own leaves — whereas
  // writing a whole `legal` object rebuilt from this component's mount-time
  // state would silently revert whatever those other writers changed (e.g. push
  // customUpdatedAt back in time and make a real re-acceptance notice vanish).
  const persistLegal = useCallback(async (patch) => {
    await saveShopConfig({ legal: patch }, shopId);
    setStoreForm(prev => ({
      ...prev,
      legal: {
        ...(prev.legal || {}),
        ...patch,
        // `custom` is a map of per-page flags: merge it like Firestore does,
        // or taking over page B would locally "forget" page A's flag.
        ...(patch.custom ? { custom: { ...(prev.legal?.custom || {}), ...patch.custom } } : {}),
      },
    }));
  }, [shopId]);

  // "Redigera texten själv" — copy-on-write. Renders the template as it stands
  // today, writes it into a CMS page on the legal slug (reusing an existing one
  // rather than creating a duplicate), flags the key as custom and opens the editor.
  const takeOverLegalPage = useCallback(async (slug) => {
    const key = LEGAL_PAGE_KEYS[slug];
    if (!key) return;
    if (!window.confirm('Du tar över texten och ansvarar själv för att den är fullständig och korrekt. Fortsätt?')) return;
    try {
      setLegalBusyKey(key);
      const rendered = renderLegalPage(slug, storeForm, { pod: isEnabled('pod') });
      if (!rendered) throw new Error('Kunde inte generera texten');

      const existing = await findLegalPage(slug);
      let pageId = existing?.id;
      if (existing) {
        // Reuse the page already on this slug rather than creating a duplicate.
        // Only SEED the template text when that page has no content of its own —
        // a page the seller previously wrote (and reverted to draft, or drafted
        // by hand) must never be overwritten; there is no undo for that.
        const existingHtml = readContentValue(existing.content).trim();
        await updateDoc(doc(db, 'pages', existing.id), {
          ...(existingHtml ? {} : { content: { 'sv-SE': rendered.html } }),
          status: 'published',
          updatedAt: serverTimestamp(),
          updatedBy: currentUser?.uid || '',
        });
      } else {
        const created = await addDoc(collection(db, 'pages'), withShopId({
          title: { 'sv-SE': rendered.title },
          slug,
          content: { 'sv-SE': rendered.html },
          status: 'published',
          metaTitle: '',
          metaDescription: '',
          attachments: [],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdBy: currentUser?.uid || '',
          updatedBy: currentUser?.uid || '',
        }, shopId));
        pageId = created.id;
      }

      // Narrow patch: only THIS key's flag. The merge write leaves the other
      // two keys' flags untouched (see persistLegal).
      await persistLegal({ custom: { [key]: true }, customUpdatedAt: new Date().toISOString() });

      toast.success('Du äger nu texten. Kom ihåg att godkänna villkoren på nytt när du är klar.');
      navigate(`/admin/pages/${pageId}`);
    } catch (error) {
      console.error('Error taking over legal page:', error);
      toast.error(error?.message || 'Kunde inte ta över texten');
    } finally {
      setLegalBusyKey('');
    }
  }, [storeForm, isEnabled, findLegalPage, readContentValue, currentUser, shopId, persistLegal, navigate]);

  // Open the seller's own page in the CMS editor.
  const editLegalPage = useCallback(async (slug) => {
    const key = LEGAL_PAGE_KEYS[slug];
    try {
      setLegalBusyKey(key);
      const existing = await findLegalPage(slug);
      if (!existing) {
        toast.error('Sidan hittades inte. Återgå till plattformens mall och ta över texten på nytt.');
        return;
      }
      navigate(`/admin/pages/${existing.id}`);
    } catch (error) {
      console.error('Error opening legal page:', error);
      toast.error('Kunde inte öppna sidan');
    } finally {
      setLegalBusyKey('');
    }
  }, [findLegalPage, navigate]);

  // "Återgå till plattformens mall" — clears the custom flag and unpublishes the
  // seller's page (never deletes it, so the text is recoverable) so it stops
  // rendering on the storefront.
  const revertLegalPage = useCallback(async (slug) => {
    const key = LEGAL_PAGE_KEYS[slug];
    if (!key) return;
    if (!window.confirm('Plattformens mall visas igen och din egen text sparas som utkast. Fortsätt?')) return;
    try {
      setLegalBusyKey(key);
      const existing = await findLegalPage(slug);
      if (existing) {
        await updateDoc(doc(db, 'pages', existing.id), {
          status: 'draft',
          updatedAt: serverTimestamp(),
          updatedBy: currentUser?.uid || '',
        });
      }
      await persistLegal({ custom: { [key]: false }, customUpdatedAt: new Date().toISOString() });
      toast.success('Plattformens mall visas igen.');
    } catch (error) {
      console.error('Error reverting legal page:', error);
      toast.error('Kunde inte återgå till mallen');
    } finally {
      setLegalBusyKey('');
    }
  }, [findLegalPage, currentUser, persistLegal]);

  // Record the seller's acceptance. Saves the identity FIRST so the snapshot in
  // the evidence doc is exactly what the shop has stored, then renders + records.
  const acceptLegalTerms = useCallback(async () => {
    try {
      setAcceptingLegal(true);
      // Save the identity so the accepted snapshot is exactly what is stored —
      // but WITHOUT the `legal` subtree. `legal` is co-owned (AdminPageEdit
      // stamps customUpdatedAt, legalAcceptance.js writes the acceptance
      // pointer); writing this component's mount-time copy of it would revert
      // a customUpdatedAt bumped elsewhere and silently clear a legitimate
      // "needs re-acceptance" state. The merge write skips what we omit.
      const { legal: _legal, ...identityWithoutLegal } = storeForm;
      await saveShopConfig(identityWithoutLegal, shopId);

      // Pull the seller's own HTML for every key they took over, so the
      // evidence snapshot holds the text the STOREFRONT actually serves.
      // Only a PUBLISHED page counts: DynamicPage falls back to the platform
      // template when the seller's page is a draft, so snapshotting draft HTML
      // would record an acceptance of text nobody can read.
      const custom = storeForm.legal?.custom || {};
      const customHtml = {};
      const unpublished = [];
      for (const [slug, key] of Object.entries(LEGAL_PAGE_KEYS)) {
        if (custom[key] !== true) continue;
        const page = await findLegalPage(slug, { publishedOnly: true });
        const html = readContentValue(page?.content);
        if (html) customHtml[key] = html;
        else unpublished.push(LEGAL_PAGES[slug].title);
      }
      // The seller owns the text but hasn't published it — the storefront is
      // still showing the platform template. Refuse rather than record an
      // acceptance that misrepresents what the shop publishes.
      if (unpublished.length > 0) {
        throw new Error(
          `Publicera din egen text först: ${unpublished.join(', ')}. Butiken visar plattformens mall tills sidan är publicerad.`
        );
      }

      const pointer = await recordLegalAcceptance({
        shopId,
        user: currentUser,
        identity: storeForm,
        pod: isEnabled('pod'),
        custom,
        customHtml,
      });

      setStoreForm(prev => ({ ...prev, legal: { ...(prev.legal || {}), acceptance: pointer } }));
      setLegalAccepted(false);
      toast.success('Villkoren är godkända. Kassan är nu öppen.');
    } catch (error) {
      console.error('Error accepting legal terms:', error);
      toast.error(error?.message || 'Kunde inte godkänna villkoren');
    } finally {
      setAcceptingLegal(false);
    }
  }, [storeForm, shopId, findLegalPage, readContentValue, currentUser, isEnabled]);

  // Live legal-page readiness, recomputed from the in-progress form so the
  // banner updates as the seller fills in the return address / VAT status.
  const legalReadiness = getLegalReadiness(storeForm);

  // The acceptance button only unblocks once the OTHER hard gates are clear —
  // accepting a page that still prints "⚠️ Returadress ej angiven" would record
  // a broken text as the seller's own terms.
  const otherLegalBlockers = legalReadiness.blockers.filter((b) => b.key !== 'acceptance');
  const legalAcceptance = storeForm.legal?.acceptance;
  const canAcceptLegal = legalAccepted && otherLegalBlockers.length === 0 && Boolean(currentUser?.uid);

  const formatAcceptedAt = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('sv-SE');
  };

  const labelCls = 'block text-[13px] font-medium text-admin-text mb-1';
  const inputCls =
    'w-full rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]';
  const helpCls = 'mt-1 text-[12px] text-admin-text-muted';

  if (loading) {
    return (
      <AppLayout>
        <Page title="Inställningar">
          <Card className="flex items-center justify-center py-16">
            <span className="h-5 w-5 animate-spin rounded-full border-b-2 border-admin-text" />
            <span className="ml-3 text-[13px] text-admin-text-muted">Laddar inställningar...</span>
          </Card>
        </Page>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <Page
        title="Inställningar"
        subtitle="Hantera applikationsinställningar"
      >
        <div className="space-y-4">
          {/* Add-ons are controlled per shop from the PLATFORM console (/addons),
              not here — the old per-user wagon toggle was removed (add-ons S4).
              This page now holds only store/application settings. */}
              <CardSection title="Butiksidentitet">
                <p className="text-[13px] text-admin-text-muted">
                  Ställ in butikens namn, logotyp och kontaktuppgifter. Dessa värden visas i butiken
                  (navigering, sidfot, kassa). Ladda om butiken efter sparande för att se ändringarna.
                </p>
              </CardSection>

              <CardSection title="Allmänt" bodyClassName="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {[
                    { key: 'shopName', label: 'Butiksnamn', type: 'text', placeholder: STORE.shopName },
                    { key: 'legalName', label: 'Juridiskt företagsnamn', type: 'text', placeholder: STORE.legalName },
                    { key: 'tagline', label: 'Slogan', type: 'text', placeholder: STORE.tagline },
                    { key: 'supportEmail', label: 'Support-e-post', type: 'email', placeholder: STORE.supportEmail },
                    { key: 'phone', label: 'Telefon (visas i köpvillkor & integritetspolicy)', type: 'tel', placeholder: 'T.ex. 070-123 45 67' },
                    { key: 'logoUrl', label: 'Logotyp-URL', type: 'text', placeholder: STORE.logoUrl },
                    { key: 'currency', label: 'Valuta', type: 'text', placeholder: STORE.currency },
                  ].map((field) => (
                    <div key={field.key}>
                      <label className={labelCls}>{field.label}</label>
                      <input
                        type={field.type}
                        value={storeForm[field.key] ?? ''}
                        placeholder={field.placeholder}
                        onChange={(e) => setStoreForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                        className={inputCls}
                      />
                    </div>
                  ))}

                  <div>
                    <label className={labelCls}>Moms (t.ex. 0.25 = 25%)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={storeForm.vatRate ?? ''}
                      placeholder={String(STORE.vatRate)}
                      onChange={(e) => setStoreForm(prev => ({ ...prev, vatRate: parseFloat(e.target.value) }))}
                      className={inputCls}
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className={labelCls}>
                      Adress (HTML tillåten, t.ex. {'<br>'} för radbrytning)
                    </label>
                    <textarea
                      rows={3}
                      value={storeForm.address ?? ''}
                      placeholder={STORE.address}
                      onChange={(e) => setStoreForm(prev => ({ ...prev, address: e.target.value }))}
                      className={inputCls}
                    />
                  </div>

                  <PickupLocationsEditor
                    value={storeForm.pickupLocations}
                    onChange={(next) => setStoreForm(prev => ({ ...prev, pickupLocations: next }))}
                  />

                  <div className="md:col-span-2">
                    <label className={labelCls}>Företagsbeskrivning (sidfot)</label>
                    <textarea
                      rows={2}
                      value={storeForm.companyDescription ?? ''}
                      placeholder={STORE.companyDescription}
                      onChange={(e) => setStoreForm(prev => ({ ...prev, companyDescription: e.target.value }))}
                      className={inputCls}
                    />
                  </div>

                  <div>
                    <label className={labelCls}>Säljartyp</label>
                    <select
                      value={storeForm.sellerType ?? ''}
                      onChange={(e) => setStoreForm(prev => ({ ...prev, sellerType: e.target.value }))}
                      className={inputCls}
                    >
                      <option value="">Ej angivet</option>
                      <option value="individual">Privatperson</option>
                      <option value="company">Företag</option>
                    </select>
                    <p className="mt-1 text-[12px] text-admin-text-muted">Hämtas automatiskt från Stripe vid betalnings-onboarding; kan anges här innan dess.</p>
                  </div>

                  {[
                    { key: 'orgNumber', label: 'Organisationsnummer', placeholder: 'T.ex. 556677-8899' },
                    { key: 'businessInfo', label: 'Företagsinfo (sidfot)', placeholder: 'T.ex. Registrerad för F-skatt' },
                  ].map((field) => (
                    <div key={field.key}>
                      <label className={labelCls}>{field.label}</label>
                      <input
                        type="text"
                        value={storeForm[field.key] ?? ''}
                        placeholder={field.placeholder}
                        onChange={(e) => setStoreForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                        className={inputCls}
                      />
                    </div>
                  ))}
                </div>

                {/* Social links — empty fields hide the matching footer icon */}
                <div>
                  <h4 className="mb-3 text-[13px] font-semibold text-admin-text">
                    Sociala länkar (lämna tomt för att dölja)
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {['facebook', 'instagram', 'youtube', 'tiktok', 'pinterest', 'linkedin', 'website'].map((key) => (
                      <div key={key}>
                        <label className={`${labelCls} capitalize`}>{key}</label>
                        <input
                          type="url"
                          value={storeForm.social?.[key] ?? ''}
                          placeholder="https://…"
                          onChange={(e) => setStoreForm(prev => ({
                            ...prev,
                            social: { ...(prev.social || {}), [key]: e.target.value },
                          }))}
                          className={inputCls}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Trustpilot — empty = no reviews widget. Domain + invite email. */}
                <div>
                  <h4 className="mb-3 text-[13px] font-semibold text-admin-text">
                    Trustpilot (lämna tomt för att inaktivera)
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Trustpilot-domän</label>
                      <input
                        type="text"
                        value={storeForm.trustpilot?.domain ?? ''}
                        placeholder="t.ex. minbutik.se"
                        onChange={(e) => setStoreForm(prev => ({
                          ...prev,
                          trustpilot: { ...(prev.trustpilot || {}), domain: e.target.value },
                        }))}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Trustpilot inbjudnings-e-post</label>
                      <input
                        type="email"
                        value={storeForm.trustpilot?.email ?? ''}
                        placeholder="t.ex. info@minbutik.se"
                        onChange={(e) => setStoreForm(prev => ({
                          ...prev,
                          trustpilot: { ...(prev.trustpilot || {}), email: e.target.value },
                        }))}
                        className={inputCls}
                      />
                    </div>
                  </div>
                </div>

                {/* Right-of-withdrawal notice (POD). Shown in the checkout gate
                    for personalized products. Leave empty to use the neutral
                    platform default. Editing bumps the stored version so the
                    proof persisted on orders references the exact text. */}
                <div>
                  <h4 className="mb-3 text-[13px] font-semibold text-admin-text">
                    Ångerrätt — text för specialtillverkade produkter
                  </h4>
                  <textarea
                    rows={4}
                    value={storeForm.legal?.noWithdrawalNotice ?? ''}
                    placeholder="Lämna tomt för plattformens standardtext (ingen ångerrätt för specialtillverkade varor)."
                    onChange={(e) => setStoreForm(prev => ({
                      ...prev,
                      legal: {
                        ...(prev.legal || {}),
                        noWithdrawalNotice: e.target.value,
                        // Stamp a version when the shop sets its own text, so the
                        // order proof can cite it. ISO date keeps it human + sortable.
                        withdrawalNoticeVersion: e.target.value.trim()
                          ? `shop-${new Date().toISOString().slice(0, 10)}`
                          : '',
                      },
                    }))}
                    className={inputCls}
                  />
                  <p className="mt-1 text-[12px] text-admin-text-muted">
                    Visas i kassan när kunden köper en specialtillverkad produkt. Kunden måste kryssa i en ruta innan betalning.
                  </p>
                </div>

                {/* Juridik & moms — feeds the auto-genererade juridiska sidorna
                    (köpvillkor, ångerrätt & returer, integritetspolicy). Returadress
                    + momsregistrering är HÅRDA krav innan sidorna får publiceras på
                    en skarp butik (legalPageReadiness.js). */}
                <div className="border-t border-admin-border pt-5">
                  <h4 className="mb-1 text-[13px] font-semibold text-admin-text">
                    Juridik &amp; moms (för automatiska juridiska sidor)
                  </h4>
                  <p className="mb-3 text-[12px] text-admin-text-muted">
                    Dessa uppgifter fyller i butikens juridiska sidor automatiskt: köpvillkor,
                    ångerrätt &amp; returer och integritetspolicy. Returadress och momsstatus måste
                    anges innan sidorna kan publiceras på en skarp butik.
                  </p>

                  {/* Readiness banner — clear "legal pages incomplete" state. */}
                  {legalReadiness.ready ? (
                    <div className="mb-4 rounded-[var(--radius-admin-el)] border border-admin-success-dot bg-admin-success-bg px-3 py-2 text-[12px] text-admin-success-text">
                      ✓ Juridiska sidor är kompletta och kan publiceras.
                    </div>
                  ) : (
                    <div className="mb-4 rounded-[var(--radius-admin-el)] border border-admin-caution-dot bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
                      <p className="font-medium">⚠️ Juridiska sidor är inte kompletta. Kassan är stängd tills följande är åtgärdat:</p>
                      <ul className="mt-1 list-disc pl-5">
                        {legalReadiness.blockers.map((b) => (
                          <li key={b.key}>{b.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div>
                      <label className={labelCls}>Momsregistrerad?</label>
                      <select
                        value={
                          storeForm.vatRegistered === true ? 'yes'
                          : storeForm.vatRegistered === false ? 'no'
                          : ''
                        }
                        onChange={(e) => setStoreForm(prev => ({
                          ...prev,
                          vatRegistered: e.target.value === 'yes' ? true
                            : e.target.value === 'no' ? false
                            : null,
                        }))}
                        className={inputCls}
                      >
                        <option value="">Ej angivet</option>
                        <option value="yes">Ja – momsregistrerad (priser inkl. moms)</option>
                        <option value="no">Nej – ej momsregistrerad (ingen moms tillkommer)</option>
                      </select>
                      <p className={helpCls}>
                        Styr momstexten på de juridiska sidorna. Måste matcha vad kassan faktiskt tar ut.
                      </p>
                    </div>

                    {storeForm.vatRegistered === true && (
                      <div>
                        <label className={labelCls}>Momsregistreringsnummer</label>
                        <input
                          type="text"
                          value={storeForm.vatNumber ?? ''}
                          placeholder="T.ex. SE556677889901"
                          onChange={(e) => setStoreForm(prev => ({ ...prev, vatNumber: e.target.value }))}
                          className={inputCls}
                        />
                      </div>
                    )}

                    <div className="md:col-span-2">
                      <label className={labelCls}>Returadress (krävs)</label>
                      <textarea
                        rows={3}
                        value={storeForm.returnAddress ?? ''}
                        placeholder={'Mottagarens namn\nGatuadress\nPostnummer Ort'}
                        onChange={(e) => setStoreForm(prev => ({ ...prev, returnAddress: e.target.value }))}
                        className={inputCls}
                      />
                      <p className={helpCls}>
                        Adressen dit kunder skickar returer. Visas i köpvillkoren och på sidan
                        "Ångerrätt &amp; returer".
                      </p>
                    </div>
                  </div>

                  {/* Juridiska sidor — copy-on-write per sida + säljarens
                      godkännande. Godkännandet är den hårda spärr som öppnar
                      kassan (legalPageReadiness.js gate (c)); custom-flaggan
                      avgör om butiken visar plattformens mall eller säljarens
                      egen CMS-sida på samma slug. */}
                  <div className="mt-6 border-t border-admin-border pt-5">
                    <h4 className="mb-1 text-[13px] font-semibold text-admin-text">Juridiska sidor</h4>
                    <p className="mb-3 text-[12px] text-admin-text-muted">
                      De tre sidor som måste finnas i butiken. Du kan behålla plattformens mall eller
                      ta över texten och skriva din egen.
                    </p>

                    <div className="mb-4 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 px-3 py-2 text-[12px] text-admin-text-muted">
                      {LEGAL_TEMPLATE_DISCLAIMER}
                    </div>

                    <div className="divide-y divide-admin-border rounded-[var(--radius-admin-el)] border border-admin-border">
                      {Object.keys(LEGAL_PAGES).map((slug) => {
                        const key = LEGAL_PAGE_KEYS[slug];
                        const isCustom = storeForm.legal?.custom?.[key] === true;
                        const busy = legalBusyKey === key;
                        return (
                          <div key={slug} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                            <div className="min-w-0">
                              <p className="text-[13px] font-medium text-admin-text">{LEGAL_PAGES[slug].title}</p>
                              <p className="mt-0.5 text-[12px] text-admin-text-muted">
                                {isCustom ? 'Egen text' : 'Plattformens mall'}
                                {' · '}
                                <a
                                  href={`${APP_URLS.B2C_SHOP}/${shopId}/${slug}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="underline hover:text-admin-text"
                                >
                                  Förhandsgranska
                                </a>
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {isCustom ? (
                                <>
                                  <Button variant="secondary" disabled={busy} onClick={() => editLegalPage(slug)}>
                                    Redigera
                                  </Button>
                                  <Button variant="plain" disabled={busy} onClick={() => revertLegalPage(slug)}>
                                    Återgå till plattformens mall
                                  </Button>
                                </>
                              ) : (
                                <Button variant="secondary" disabled={busy} onClick={() => takeOverLegalPage(slug)}>
                                  {busy ? 'Förbereder…' : 'Redigera texten själv'}
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Godkännande — den hårda spärren som öppnar kassan. */}
                    <Card className="mt-4 p-4">
                      {legalAcceptance ? (
                        <p className="text-[12px] text-admin-text-muted">
                          Godkända av {legalAcceptance.email || legalAcceptance.uid}{' '}
                          {formatAcceptedAt(legalAcceptance.acceptedAt)} · mallversion{' '}
                          {legalAcceptance.templateVersion}
                        </p>
                      ) : (
                        <p className="text-[12px] text-admin-text-muted">
                          Villkoren är ännu inte godkända. Kassan öppnar när du godkänt dem.
                        </p>
                      )}

                      {legalReadiness.needsReacceptance && (
                        <div className="mt-3 rounded-[var(--radius-admin-el)] border border-admin-caution-dot bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
                          Texterna har ändrats sedan ditt senaste godkännande (ny mallversion eller egen
                          redigering). Läs igenom och godkänn på nytt.
                        </div>
                      )}

                      <label className="mt-3 flex items-start gap-2 text-[13px] text-admin-text">
                        <input
                          type="checkbox"
                          checked={legalAccepted}
                          onChange={(e) => setLegalAccepted(e.target.checked)}
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-admin-border accent-[var(--color-admin-primary)]"
                        />
                        <span>{LEGAL_ACCEPTANCE_LABEL}</span>
                      </label>

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <p className="text-[12px] text-admin-text-muted">
                          {otherLegalBlockers.length > 0 ? (
                            <>Kan inte godkännas ännu: {otherLegalBlockers.map((b) => b.label).join(', ')}.</>
                          ) : !currentUser?.uid ? (
                            'Du behöver vara inloggad för att godkänna villkoren.'
                          ) : !legalAccepted ? (
                            'Kryssa i rutan ovan för att godkänna.'
                          ) : (
                            'Ditt godkännande sparas med tidpunkt, mallversion och en kopia av texten.'
                          )}
                        </p>
                        <Button
                          variant="primary"
                          disabled={!canAcceptLegal || acceptingLegal}
                          onClick={acceptLegalTerms}
                        >
                          {acceptingLegal
                            ? 'Sparar…'
                            : legalAcceptance
                              ? 'Godkänn på nytt'
                              : 'Godkänn villkoren'}
                        </Button>
                      </div>
                    </Card>

                    <p className="mt-3 text-[12px] text-admin-text-muted">
                      <Link to="/admin/plattformsvillkor" className="underline hover:text-admin-text">
                        Plattformsvillkor och personuppgiftsbiträdesavtal
                      </Link>
                    </p>
                  </div>
                </div>

                <div className="flex justify-end border-t border-admin-border pt-4">
                  <Button variant="primary" onClick={saveStoreIdentity} disabled={saving}>
                    {saving ? (
                      <span className="h-4 w-4 animate-spin rounded-full border-b-2 border-current" />
                    ) : (
                      <CheckIcon className="h-4 w-4" />
                    )}
                    {saving ? 'Sparar…' : 'Spara butiksinställningar'}
                  </Button>
                </div>
              </CardSection>

              {/* Övergiven kassa (abandoned-checkout reminder) — only when the
                  add-on is enabled for this shop (platform-controlled). */}
              {abandonedCheckoutEnabled && (
                <CardSection title="Övergiven kassa" bodyClassName="space-y-4">
                  <p className="text-[13px] text-admin-text-muted">
                    Skicka en påminnelse via e-post till kunder som påbörjade en betalning men inte
                    slutförde köpet. En påminnelse per kassa. Kunden måste ha kryssat i påminnelserutan
                    i kassan.
                  </p>
                  <div className="max-w-xs">
                    <label className={labelCls}>Fördröjning innan påminnelse (timmar)</label>
                    <input
                      type="number"
                      min="1"
                      max="24"
                      step="1"
                      value={cartRecoveryDelay}
                      onChange={(e) => setCartRecoveryDelay(e.target.value)}
                      className={inputCls}
                    />
                    <p className={helpCls}>Mellan 1 och 24 timmar. Standard: 1 timme.</p>
                  </div>
                  <div className="flex justify-end border-t border-admin-border pt-4">
                    <Button variant="primary" onClick={saveCartRecoverySettings} disabled={savingRecovery}>
                      {savingRecovery ? (
                        <span className="h-4 w-4 animate-spin rounded-full border-b-2 border-current" />
                      ) : (
                        <CheckIcon className="h-4 w-4" />
                      )}
                      {savingRecovery ? 'Sparar…' : 'Spara'}
                    </Button>
                  </div>
                </CardSection>
              )}

              {/* Recensioner (product reviews) — only when the add-on is enabled
                  for this shop (platform-controlled). */}
              {productReviewsEnabled && (
                <CardSection title="Recensioner" bodyClassName="space-y-4">
                  <p className="text-[13px] text-admin-text-muted">
                    Skicka automatiskt en e-postförfrågan till kunden efter att en order har
                    levererats och be dem lämna ett omdöme. Godkända omdömen visas på produktsidan.
                  </p>
                  <div className="max-w-xs">
                    <label className={labelCls}>Dagar efter leverans innan förfrågan skickas</label>
                    <input
                      type="number"
                      min="3"
                      max="21"
                      step="1"
                      value={reviewDelayDays}
                      onChange={(e) => setReviewDelayDays(e.target.value)}
                      className={inputCls}
                    />
                    <p className={helpCls}>Mellan 3 och 21 dagar. Standard: 7 dagar.</p>
                  </div>
                  <div className="flex justify-end border-t border-admin-border pt-4">
                    <Button variant="primary" onClick={saveReviewSettingsHandler} disabled={savingReviews}>
                      {savingReviews ? (
                        <span className="h-4 w-4 animate-spin rounded-full border-b-2 border-current" />
                      ) : (
                        <CheckIcon className="h-4 w-4" />
                      )}
                      {savingReviews ? 'Sparar…' : 'Spara'}
                    </Button>
                  </div>
                </CardSection>
              )}
        </div>
      </Page>
    </AppLayout>
  );
};

export default AdminSettings;
