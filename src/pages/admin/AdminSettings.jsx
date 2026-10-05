// AdminSettings.jsx — store/application settings. Add-ons are controlled per
// shop from the PLATFORM console (/addons); the old per-user wagon toggle was
// removed (add-ons S4, docs/ADDONS_PLATFORM_CONTROL_PLAN.md).
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DOMPurify from 'dompurify';
import AppLayout from '../../components/layout/AppLayout';
import toast from 'react-hot-toast';
import { STORE } from '../../config/store';
import { loadShopConfig, saveShopConfig, loadCartRecovery, saveCartRecovery, loadReviewSettings, saveReviewSettings } from '../../config/shopConfig';
import { APP_URLS } from '../../config/urls';
import { useShopId } from '../../contexts/ShopContext';
import { useAuth } from '../../contexts/AuthContext';
import { useShopFeatures } from '../../contexts/ShopFeaturesContext';
import { getLegalReadiness } from '../../utils/legalPageReadiness';
import { legalIdentityGaps } from '../../utils/legalIdentity';
import { withoutPlaceholderIdentity } from '../../utils/placeholderIdentity';
import {
  LEGAL_ACCEPTANCE_LABEL,
  LEGAL_PAGES,
  LEGAL_PAGE_KEYS,
  LEGAL_TEMPLATE_DISCLAIMER,
} from '../../config/legalTemplates';
import { renderLegalPage } from '../../utils/legalPageRenderer';
import { recordLegalAcceptance, renderAcceptedLegalTexts } from '../../utils/legalAcceptance';
import {
  LEGAL_TEXTS_IN_SETTINGS,
  PLATFORM_OWNED_FIELDS,
  collectCustomHtml,
  legalTextsChanged,
  loadLegalState,
  openLegalText,
  revertLegalText,
  takeOverLegalText,
} from './adminSettingsData';
import PickupLocationsEditor from '../../components/admin/PickupLocationsEditor';
import { LEGAL_DOC_TYPO } from '../../components/admin/PlatformTermsGate';
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

// The form from saved settings: the static defaults under every non-empty saved
// value. A stored placeholder (the older admin saved its defaults as values,
// CP9-OB) is shown as the empty field it really is.
const formFromSaved = (saved) => ({ ...STORE, ...withoutPlaceholderIdentity(Object.fromEntries(
  Object.entries(saved || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
)) });

// The hint in each empty identity field (CP9-OB): an example, never a value.
const IDENTITY_HINTS = {
  shopName: 'Butikens namn',
  legalName: 'T.ex. Mitt Företag AB, eller ditt namn om du säljer som privatperson',
  tagline: 'T.ex. Tryck och merch från Sundsvall',
  supportEmail: 'Inte angiven ännu',
  address: 'T.ex. Storgatan 1<br>123 45 Sundsvall',
  companyDescription: 'En eller två meningar om butiken. Visas i sidfoten.',
};

const AdminSettings = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [storeForm, setStoreForm] = useState(STORE);
  // The form as rendered last, for an answer that arrives while it is edited.
  const storeFormRef = useRef(storeForm);
  storeFormRef.current = storeForm;
  // The shop this admin manages (impersonation > shop-admin's own shop > path).
  // Config MUST read/write THIS shop, not the default — else a non-default shop
  // (e.g. 'sillmans') would save to the default shop and the storefront, which reads
  // its own shopId, would never see the change (pickup locations, branding…).
  const shopId = useShopId();
  const navigate = useNavigate();
  const { currentUser, actingAs } = useAuth();
  const { isEnabled } = useShopFeatures();
  const abandonedCheckoutEnabled = isEnabled('abandonedCheckout');
  const productReviewsEnabled = isEnabled('productReviews');

  // Cart-recovery ("Övergiven kassa") reminder delay (hours). Loaded/saved via
  // the dedicated cartRecovery seam. Default 1h, clamped 1–24.
  const [cartRecoveryDelay, setCartRecoveryDelay] = useState(1);
  // CP9-AC: the seller's own switch (off by default), and what the seam says
  // of the stored state: since when it is on, the queued count, and whether a
  // mail can leave this environment at all.
  const [cartRecoveryEnabled, setCartRecoveryEnabled] = useState(false);
  const [cartRecoveryStored, setCartRecoveryStored] = useState({});
  const [savingRecovery, setSavingRecovery] = useState(false);

  // Product-reviews ("Recensioner") request delay (days). Loaded/saved via the
  // dedicated productReviews seam. Default 7d, clamped 3–21.
  const [reviewDelayDays, setReviewDelayDays] = useState(7);
  const [savingReviews, setSavingReviews] = useState(false);

  // The server's legal state where the build has one (adminSettingsData.js:
  // null in the older build, which reads the readiness off the form).
  const [legalState, setLegalState] = useState(null);
  // The seller's own legal texts as last saved (LEGAL_TEXTS_IN_SETTINGS), so
  // leaving an unchanged text field writes nothing.
  const savedLegalTextsRef = useRef({});

  // Seed the store-identity form from the shopConfig SEAM for THIS shop.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let saved = {};
      let legal = null;
      try {
        saved = (await loadShopConfig(shopId)) || {};
      } catch (e) {
        console.warn('AdminSettings: could not load shop config, using defaults:', e?.message);
      }
      try {
        legal = await loadLegalState(shopId);
      } catch (e) {
        console.warn('AdminSettings: could not load the legal state:', e?.message);
      }
      if (cancelled) return;
      const form = formFromSaved(saved);
      if (legal?.acceptance) form.legal = { ...(form.legal || {}), acceptance: legal.acceptance };
      savedLegalTextsRef.current = { ...(form.legal?.customTexts || {}) };
      setLegalState(legal);
      setStoreForm(form);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  // Where the build's save answers what is stored (the admin build's fenced
  // write: `follow`), the form follows it, keeping what was typed in fields
  // the write did not change. The older build's save answers nothing.
  const followSaved = useCallback((outcome) => {
    if (typeof outcome?.follow !== 'function') return;
    setStoreForm((prev) => outcome.follow(prev, formFromSaved).value);
  }, []);

  // A save refused because someone else changed the settings since this page
  // read them (the admin build only): nothing was saved; the form follows what
  // is stored now, keeping the edits the other change did not touch, and the
  // seller is told which were lost. → true when it was such a refusal.
  const followConflict = useCallback((error) => {
    if (typeof error?.follow !== 'function') return false;
    const { value, message } = error.follow(storeFormRef.current, formFromSaved);
    savedLegalTextsRef.current = { ...(error.saved?.legal?.customTexts || {}) };
    setStoreForm(value);
    toast.error(message, { duration: 12000 });
    return true;
  }, []);

  // Re-read the server's legal state after a write that changes it.
  const refreshLegalState = useCallback(async () => {
    try {
      const next = await loadLegalState(shopId);
      if (next) setLegalState(next);
    } catch (e) {
      console.warn('AdminSettings: could not reload the legal state:', e?.message);
    }
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
          setCartRecoveryEnabled(cr.enabled === true);
          setCartRecoveryStored(cr);
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
      const saved = await saveCartRecovery({ delayHours: clamped, enabled: cartRecoveryEnabled }, shopId);
      setCartRecoveryDelay(clamped);
      if (saved && typeof saved === 'object' && typeof saved.enabled === 'boolean') setCartRecoveryStored(saved);
      toast.success('Inställningar för övergiven kassa sparade.');
    } catch (error) {
      console.error('Error saving cart recovery settings:', error);
      toast.error('Fel vid sparande av inställningar för övergiven kassa');
    } finally {
      setSavingRecovery(false);
    }
  }, [cartRecoveryDelay, cartRecoveryEnabled, shopId]);

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
      followSaved(await saveShopConfig(patch, shopId));
      await refreshLegalState();
      toast.success('Butiksinställningar sparade. Ladda om butiken för att se ändringarna.');
    } catch (error) {
      if (followConflict(error)) return;
      console.error('Error saving store identity:', error);
      toast.error(error?.userMessage || 'Fel vid sparande av butiksinställningar');
    } finally {
      setSaving(false);
    }
  }, [storeForm, shopId, refreshLegalState, followSaved, followConflict]);

  // ── Juridiska sidor: copy-on-write + seller acceptance ────────────────────
  // A legal page is either the PLATFORM TEMPLATE (default) or the SELLER's own
  // text (flagged in storeIdentity.legal.custom[key]). Taking over the text
  // copies the currently rendered template, so the seller starts from the full
  // legal text rather than a blank editor. Where that text lives is the data
  // layer's (adminSettingsData.js): a CMS page on the legal slug in the older
  // build, the identity itself (legal.customTexts) where LEGAL_TEXTS_IN_SETTINGS.
  const [legalBusyKey, setLegalBusyKey] = useState('');   // key being switched
  const [legalAccepted, setLegalAccepted] = useState(false); // the checkbox
  const [acceptingLegal, setAcceptingLegal] = useState(false);
  const [legalOpenKey, setLegalOpenKey] = useState('');   // text shown on this page
  const [legalRefused, setLegalRefused] = useState({});   // key → the server refused its HTML

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
    followSaved(await saveShopConfig({ legal: patch }, shopId));
    if (patch.customTexts) Object.assign(savedLegalTextsRef.current, patch.customTexts);
    setStoreForm(prev => ({
      ...prev,
      legal: {
        ...(prev.legal || {}),
        ...patch,
        // `custom` is a map of per-page flags: merge it like Firestore does,
        // or taking over page B would locally "forget" page A's flag.
        ...(patch.custom ? { custom: { ...(prev.legal?.custom || {}), ...patch.custom } } : {}),
        ...(patch.customTexts ? { customTexts: { ...(prev.legal?.customTexts || {}), ...patch.customTexts } } : {}),
      },
    }));
  }, [shopId, followSaved]);

  // "Redigera texten själv" — copy-on-write. Renders the template as it stands
  // today, hands it to the data layer as the seller's own text (never
  // overwriting one the seller already has), flags the key as custom and opens
  // the editor.
  const takeOverLegalPage = useCallback(async (slug) => {
    const key = LEGAL_PAGE_KEYS[slug];
    if (!key) return;
    if (!window.confirm('Du tar över texten och ansvarar själv för att den är fullständig och korrekt. Fortsätt?')) return;
    try {
      setLegalBusyKey(key);
      const rendered = renderLegalPage(slug, storeForm, { pod: isEnabled('pod') });
      if (!rendered) throw new Error('Kunde inte generera texten');

      const { navigateTo, legalPatch } = await takeOverLegalText({
        shopId,
        slug,
        key,
        rendered,
        uid: currentUser?.uid || '',
        currentText: storeForm.legal?.customTexts?.[key],
      });

      // Narrow patch: only THIS key's flag. The merge write leaves the other
      // two keys' flags untouched (see persistLegal).
      await persistLegal(legalPatch);

      toast.success('Du äger nu texten. Kom ihåg att godkänna villkoren på nytt när du är klar.');
      if (navigateTo) navigate(navigateTo);
      else setLegalOpenKey(key);
    } catch (error) {
      if (followConflict(error)) return;
      console.error('Error taking over legal page:', error);
      toast.error(error?.message || 'Kunde inte ta över texten');
    } finally {
      setLegalBusyKey('');
    }
  }, [storeForm, isEnabled, currentUser, shopId, persistLegal, navigate, followConflict]);

  // Open the seller's own text in its editor.
  const editLegalPage = useCallback(async (slug) => {
    const key = LEGAL_PAGE_KEYS[slug];
    try {
      setLegalBusyKey(key);
      const opened = await openLegalText({ shopId, slug });
      if (!opened) {
        toast.error('Sidan hittades inte. Återgå till plattformens mall och ta över texten på nytt.');
        return;
      }
      if (opened.navigateTo) navigate(opened.navigateTo);
      else setLegalOpenKey(prev => (prev === key ? '' : key));
    } catch (error) {
      console.error('Error opening legal page:', error);
      toast.error('Kunde inte öppna sidan');
    } finally {
      setLegalBusyKey('');
    }
  }, [shopId, navigate]);

  // "Återgå till plattformens mall" — clears the custom flag; the seller's own
  // text is kept (never deleted), so it is recoverable.
  const revertLegalPage = useCallback(async (slug) => {
    const key = LEGAL_PAGE_KEYS[slug];
    if (!key) return;
    if (!window.confirm('Plattformens mall visas igen och din egen text sparas som utkast. Fortsätt?')) return;
    try {
      setLegalBusyKey(key);
      const patch = await revertLegalText({ shopId, slug, key, uid: currentUser?.uid || '' });
      await persistLegal(patch);
      toast.success('Plattformens mall visas igen.');
    } catch (error) {
      if (followConflict(error)) return;
      console.error('Error reverting legal page:', error);
      toast.error(error?.userMessage || 'Kunde inte återgå till mallen');
    } finally {
      setLegalBusyKey('');
    }
  }, [shopId, currentUser, persistLegal, followConflict]);

  // The seller's own text, edited on this page (LEGAL_TEXTS_IN_SETTINGS).
  const changeLegalText = useCallback((key, value) => {
    setLegalRefused(prev => (prev[key] ? { ...prev, [key]: false } : prev));
    setStoreForm(prev => ({
      ...prev,
      legal: { ...(prev.legal || {}), customTexts: { ...(prev.legal?.customTexts || {}), [key]: value } },
    }));
  }, []);

  // Saved when the field is left, as the page editor saved it; unchanged → nothing.
  const saveLegalText = useCallback(async (key, value) => {
    if (savedLegalTextsRef.current[key] === value) return;
    try {
      await persistLegal({ customTexts: { [key]: value }, customUpdatedAt: new Date().toISOString() });
    } catch (error) {
      if (followConflict(error)) return;
      console.error('Error saving legal text:', error);
      toast.error(error?.userMessage || 'Kunde inte spara texten');
    }
  }, [persistLegal, followConflict]);

  // The texts as this page SHOWS them (LEGAL_TEXTS_IN_SETTINGS): the template
  // rendered from the form, or the seller's own HTML as DOMPurify leaves it.
  // These very strings are what an acceptance sends: what is adopted is what
  // was shown.
  const podEnabled = isEnabled('pod');
  const legalInputs = JSON.stringify([
    storeForm.shopName, storeForm.legalName, storeForm.address, storeForm.supportEmail,
    storeForm.orgNumber, storeForm.vatNumber, storeForm.returnAddress, storeForm.phone,
    storeForm.sellerType, storeForm.vatRegistered, storeForm.legal?.custom, storeForm.legal?.customTexts,
    podEnabled,
  ]);
  const { shownCustomHtml, shownTexts } = useMemo(() => {
    if (!LEGAL_TEXTS_IN_SETTINGS) return { shownCustomHtml: {}, shownTexts: null };
    const customHtml = {};
    for (const [slug, key] of Object.entries(LEGAL_PAGE_KEYS)) {
      if (storeForm.legal?.custom?.[key] !== true) continue;
      const draft = storeForm.legal?.customTexts?.[key];
      const raw = typeof draft === 'string' && draft.trim()
        ? draft
        : (renderLegalPage(slug, storeForm, { pod: podEnabled })?.html || '');
      customHtml[key] = DOMPurify.sanitize(raw);
    }
    return {
      shownCustomHtml: customHtml,
      shownTexts: renderAcceptedLegalTexts(storeForm, { pod: podEnabled }, customHtml),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legalInputs]);

  // The text in the editor: the saved draft, or the template it starts from.
  const legalDraftOf = (slug, key) => {
    const draft = storeForm.legal?.customTexts?.[key];
    if (typeof draft === 'string' && draft.trim()) return draft;
    return renderLegalPage(slug, storeForm, { pod: podEnabled })?.html || '';
  };

  // Do the texts shown differ from the latest adoption? (null: this build
  // reads it off the identity, legalPageReadiness.js needsLegalReacceptance.)
  const [legalTextsDiffer, setLegalTextsDiffer] = useState(null);
  useEffect(() => {
    if (!LEGAL_TEXTS_IN_SETTINGS || !legalState || !shownTexts) return undefined;
    let cancelled = false;
    const customPages = Object.fromEntries(
      Object.values(LEGAL_PAGE_KEYS).map((key) => [key, Boolean(shownCustomHtml[key]?.trim())])
    );
    legalTextsChanged(legalState, shownTexts, customPages)
      .then((differ) => { if (!cancelled) setLegalTextsDiffer(differ); })
      .catch((e) => console.warn('AdminSettings: could not compare the legal texts:', e?.message));
    return () => { cancelled = true; };
  }, [legalState, shownTexts, shownCustomHtml]);

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
      followSaved(await saveShopConfig(identityWithoutLegal, shopId));

      // The seller's own HTML for every key they took over, so the evidence
      // snapshot holds the text the STOREFRONT actually serves (the data
      // layer says where it lives; see adminSettingsData.js).
      const custom = storeForm.legal?.custom || {};
      const { customHtml, unpublished } = await collectCustomHtml({ shopId, custom, shownCustomHtml });
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
        // The texts as shown on this page, where the build shows them.
        ...(shownTexts ? { texts: shownTexts } : {}),
      });

      setStoreForm(prev => ({ ...prev, legal: { ...(prev.legal || {}), acceptance: pointer } }));
      setLegalAccepted(false);
      setLegalRefused({});
      await refreshLegalState();
      toast.success('Villkoren är godkända. Kassan är nu öppen.');
    } catch (error) {
      if (followConflict(error)) return;
      console.error('Error accepting legal terms:', error);
      if (Array.isArray(error?.refusedKeys) && error.refusedKeys.length > 0) {
        setLegalRefused(Object.fromEntries(error.refusedKeys.map((key) => [key, true])));
        setLegalOpenKey(error.refusedKeys[0]);
      }
      toast.error(error?.message || 'Kunde inte godkänna villkoren');
    } finally {
      setAcceptingLegal(false);
    }
  }, [storeForm, shopId, shownCustomHtml, shownTexts, currentUser, isEnabled, refreshLegalState, followSaved, followConflict]);

  // Live legal-page readiness, recomputed from the in-progress form so the
  // banner updates as the seller fills in the return address / VAT status.
  // Where the build has the server's legal state, the banner shows the
  // checkout's own gate instead (as saved; re-read after every save).
  const formReadiness = getLegalReadiness(storeForm);
  const legalReadiness = legalState?.readiness
    ? { ...formReadiness, ...legalState.readiness, needsReacceptance: legalTextsDiffer === true }
    : formReadiness;

  // The acceptance button only unblocks once the OTHER hard gates are clear —
  // accepting a page that still prints "⚠️ Returadress ej angiven" would record
  // a broken text as the seller's own terms. (From the form: the acceptance
  // saves it first.)
  // CP9-OB: and once the pages would print no hole: the identity they print
  // (legalIdentity.js; the Worker refuses an adoption without it too).
  const otherLegalBlockers = [
    ...formReadiness.blockers.filter((b) => b.key !== 'acceptance'),
    ...legalIdentityGaps(storeForm, { supportEmailByPlatform: PLATFORM_OWNED_FIELDS.includes('supportEmail') }),
  ];
  const legalAcceptance = storeForm.legal?.acceptance;
  // Only the shop's own admin adopts the texts: a platform user acting as the
  // shop may not (the API refuses it), so the button says why instead.
  const actingAsShop = Array.isArray(actingAs) && actingAs.some((grant) => grant?.tenantId === shopId);
  const canAcceptLegal = legalAccepted && otherLegalBlockers.length === 0 && Boolean(currentUser?.uid) && !actingAsShop;

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
                    { key: 'shopName', label: 'Butiksnamn', type: 'text', placeholder: IDENTITY_HINTS.shopName },
                    { key: 'legalName', label: 'Juridiskt företagsnamn', type: 'text', placeholder: IDENTITY_HINTS.legalName },
                    { key: 'tagline', label: 'Slogan', type: 'text', placeholder: IDENTITY_HINTS.tagline },
                    { key: 'supportEmail', label: 'Support-e-post', type: 'email', placeholder: IDENTITY_HINTS.supportEmail },
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
                        readOnly={PLATFORM_OWNED_FIELDS.includes(field.key)}
                        onChange={(e) => setStoreForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                        className={inputCls}
                      />
                      {PLATFORM_OWNED_FIELDS.includes(field.key) && (
                        <p className={helpCls}>Sätts av plattformen och kan inte ändras här.</p>
                      )}
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
                      readOnly={PLATFORM_OWNED_FIELDS.includes('vatRate')}
                      onChange={(e) => setStoreForm(prev => ({ ...prev, vatRate: parseFloat(e.target.value) }))}
                      className={inputCls}
                    />
                    {PLATFORM_OWNED_FIELDS.includes('vatRate') && (
                      <p className={helpCls}>Sätts av plattformen och kan inte ändras här.</p>
                    )}
                  </div>

                  <div className="md:col-span-2">
                    <label className={labelCls}>
                      Adress (HTML tillåten, t.ex. {'<br>'} för radbrytning)
                    </label>
                    <textarea
                      rows={3}
                      value={storeForm.address ?? ''}
                      placeholder={IDENTITY_HINTS.address}
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
                      placeholder={IDENTITY_HINTS.companyDescription}
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
                    ångerrätt &amp; returer och integritetspolicy. Juridiskt namn, adress, support-e-post,
                    returadress och momsstatus måste finnas innan du kan godkänna sidorna.
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
                                  onClick={LEGAL_TEXTS_IN_SETTINGS ? (e) => {
                                    // The shop shows only what was adopted: the
                                    // texts to adopt are shown here instead.
                                    e.preventDefault();
                                    setLegalOpenKey(prev => (prev === key ? '' : key));
                                  } : undefined}
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
                            {/* The text itself, shown and (when it is the
                                seller's own) edited here: what is shown is
                                what an acceptance adopts. */}
                            {LEGAL_TEXTS_IN_SETTINGS && legalOpenKey === key && shownTexts && (
                              <div className="w-full space-y-3">
                                {isCustom && (
                                  <div>
                                    <label className={labelCls}>Din text (HTML)</label>
                                    <textarea
                                      rows={12}
                                      value={legalDraftOf(slug, key)}
                                      onChange={(e) => changeLegalText(key, e.target.value)}
                                      onBlur={(e) => saveLegalText(key, e.target.value)}
                                      className={inputCls}
                                    />
                                    {legalRefused[key] ? (
                                      <p className="mt-1 text-[12px] text-admin-critical-text">
                                        Texten godtogs inte: den innehåller HTML som inte kan publiceras (till exempel
                                        skript, formulär, inbäddat innehåll eller data:-adresser).
                                      </p>
                                    ) : (
                                      <p className={helpCls}>
                                        Sparas när du lämnar fältet. Det som visas nedan är det som godkänns.
                                      </p>
                                    )}
                                  </div>
                                )}
                                <div
                                  className={
                                    'max-h-[60vh] overflow-y-auto rounded-[var(--radius-admin)] border border-admin-border ' +
                                    `bg-admin-surface-2 p-4 ${LEGAL_DOC_TYPO}`
                                  }
                                  dangerouslySetInnerHTML={{ __html: shownTexts[key] }}
                                />
                              </div>
                            )}
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
                          {actingAsShop ? (
                            'Endast butikens egen administratör kan godkänna villkoren, inte plattformen för butikens räkning.'
                          ) : otherLegalBlockers.length > 0 ? (
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
                  <div className="space-y-2">
                    <p className="text-[13px] text-admin-text-muted">
                      Skicka ett påminnelsemejl till kunder som kom till betalningen men inte slutförde
                      köpet. Högst en påminnelse per kassa och högst en per kund och vecka. Bara kunder
                      som kryssat i påminnelserutan eller sagt ja till e-post från butiken får mejlet.
                    </p>
                    <p className="text-[12px] text-admin-text-muted">
                      Påminnelserna skickas i butikens namn. Du ansvarar för att de följer
                      marknadsföringslagen.
                    </p>
                  </div>
                  {cartRecoveryStored.mailConfigured === false && (
                    <p className="rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
                      E-post är inte inställd här ännu. Påminnelser köas men skickas inte förrän
                      plattformen har ställt in e-posten.
                    </p>
                  )}
                  <div className="flex max-w-md items-start justify-between gap-4">
                    <div>
                      <p id="cart-recovery-switch" className={labelCls}>Skicka påminnelser</p>
                      {cartRecoveryStored.enabled === true && cartRecoveryStored.enabledAt ? (
                        <p className={helpCls}>
                          På sedan{' '}
                          {new Date(cartRecoveryStored.enabledAt).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' })}
                          : kassor från och med då kan få en påminnelse.
                        </p>
                      ) : cartRecoveryStored.enabled !== true ? (
                        <p className={helpCls}>Av: inga påminnelser skickas.</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={cartRecoveryEnabled}
                      aria-labelledby="cart-recovery-switch"
                      onClick={() => setCartRecoveryEnabled((on) => !on)}
                      className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                        cartRecoveryEnabled ? 'bg-[var(--color-admin-primary)]' : 'bg-admin-border'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          cartRecoveryEnabled ? 'translate-x-[18px]' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
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
                  {typeof cartRecoveryStored.queuedLast30Days === 'number' && (
                    <p className="text-[13px] text-admin-text-muted">
                      Köade påminnelser de senaste 30 dagarna: {cartRecoveryStored.queuedLast30Days}
                    </p>
                  )}
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
