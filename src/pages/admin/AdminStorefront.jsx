// AdminStorefront — shop-owner controls for the storefront's visual identity.
// Reskinned to the Admin Neutral / Shopify design system (Page / RightRail /
// CardSection / Button), matching ProductForm + AdminOrderDetail.
//
// Reads/writes via the shopConfig seam (settings/app today, shops/{shopId}
// later). Images go through the shared uploader (utils/imageUpload).

import React, { useState, useEffect, useCallback } from 'react';
import AppLayout from '../../components/layout/AppLayout';
import toast from 'react-hot-toast';
import { STORE } from '../../config/store';
import { useShopId } from '../../contexts/ShopContext';
import { loadShopCategories, loadBranding, saveBranding, uploadBrandImage } from './adminStorefrontData';
import { evaluateAccentContrast } from '../../utils/colorContrast';
import { TEMPLATES } from '../../config/templates';
import { Page, Card, CardSection, RightRail, Button } from '../../components/admin/ui';
import { FRONTPAGE_FEATURED } from '../../utils/productSorting';
import {
  PhotoIcon,
  ArrowUpTrayIcon,
  ArrowTopRightOnSquareIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';

// Only the keys this page owns. We load the full config but save a merge of
// just these, so we never clobber identity/social fields owned by Settings.
// ⚠️ Do NOT add `pickupLocations` (or any array field owned by Settings) here.
// saveShopConfig does setDoc({storeIdentity: patch}, {merge:true}); Firestore
// deep-merges nested maps but REPLACES arrays wholesale when the array key is
// present in the patch — so listing pickupLocations here would wipe a shop's
// pickup locations + their dates whenever this page is saved. Settings owns it.
const BRANDING_KEYS = [
  'templateId',
  'accent',
  'logoUrl',
  'faviconUrl',
  'heroImageUrl',
  'heroHeadline',
  'heroSubtitle',
  'heroCtaLabel',
  'heroSecondaryLabel',
  'introTitle',
  'introBody',
  'storyTitle',
  'story',
  'gallery',
  'blocks',
  'frontpageCategory',
  'featuredLimit',
  // Section headings/subtitles (close the rendered-but-uncontrollable gap).
  'featuredTitle',
  'collectionsTitle',
  'productsTitle',
  'productsSubtitle',
  'reviewsTitle',
  'reviewsSubtitle',
];

const pickBranding = (cfg) =>
  BRANDING_KEYS.reduce((acc, k) => {
    if (cfg[k] !== undefined) acc[k] = cfg[k];
    return acc;
  }, {});

const AdminStorefront = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState({ logo: false, hero: false });
  const [galleryUploading, setGalleryUploading] = useState(-1);
  const [form, setForm] = useState(pickBranding(STORE));
  const shopId = useShopId();
  // Existing category names for THIS shop — same derivation AdminProducts +
  // the storefront use (products' category/group fields). Drives the frontpage
  // showcase-category picker.
  const [availableCategories, setAvailableCategories] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cats = await loadShopCategories(shopId);
        if (!cancelled) setAvailableCategories(cats);
      } catch (err) {
        console.warn('AdminStorefront: could not load categories:', err?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await loadBranding(shopId);
        if (cancelled) return;
        // STORE defaults under saved values (only branding keys).
        setForm({ ...pickBranding(STORE), ...pickBranding(saved) });
      } catch (error) {
        console.warn('AdminStorefront: using defaults:', error?.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = useCallback(async () => {
    try {
      setSaving(true);
      await saveBranding(pickBranding(form), shopId);
      toast.success('Butikens utseende sparat. Ladda om butiken för att se ändringarna.');
    } catch (error) {
      console.error('Error saving storefront branding:', error);
      toast.error(error?.userMessage || 'Kunde inte spara. Försök igen.');
    } finally {
      setSaving(false);
    }
  }, [form, shopId]);

  const UPLOAD_META = {
    logo: { field: 'logoUrl', label: 'Logotyp' },
    hero: { field: 'heroImageUrl', label: 'Hero-bild' },
    favicon: { field: 'faviconUrl', label: 'Favicon' },
  };

  const handleImageUpload = async (kind, file) => {
    if (!file) return;
    // .ico often reports an empty or vendor MIME type, so allow it by extension.
    const isImage = file.type.startsWith('image/') || /\.(ico|png|svg)$/i.test(file.name);
    if (!isImage) {
      toast.error(kind === 'favicon' ? 'Välj en .ico, .png eller .svg-fil.' : 'Välj en bildfil.');
      return;
    }
    const meta = UPLOAD_META[kind];
    try {
      setUploading((u) => ({ ...u, [kind]: true }));
      const url = await uploadBrandImage(file, kind, shopId);
      setField(meta.field, url);
      toast.success(`${meta.label} uppladdad. Glöm inte att spara.`);
    } catch (error) {
      console.error(`Error uploading ${kind}:`, error);
      toast.error(error?.userMessage || 'Uppladdning misslyckades.');
    } finally {
      setUploading((u) => ({ ...u, [kind]: false }));
    }
  };

  // ----- Block visibility toggles -----
  const blocks = form.blocks || {};
  const toggleBlock = (key) =>
    setForm((prev) => ({
      ...prev,
      blocks: { ...(prev.blocks || {}), [key]: (prev.blocks?.[key] ?? true) === false ? true : false },
    }));
  const blockOn = (key) => (blocks[key] ?? true) !== false;

  // ----- Story steps (array of { title, text }, max 3) -----
  const story = Array.isArray(form.story) ? form.story : [];
  const setStoryStep = (i, field, value) =>
    setForm((prev) => {
      const next = [...(Array.isArray(prev.story) ? prev.story : [])];
      next[i] = { ...next[i], [field]: value };
      return { ...prev, story: next };
    });
  const addStoryStep = () =>
    setForm((prev) => {
      const cur = Array.isArray(prev.story) ? prev.story : [];
      if (cur.length >= 3) return prev;
      return { ...prev, story: [...cur, { title: '', text: '' }] };
    });
  const removeStoryStep = (i) =>
    setForm((prev) => ({ ...prev, story: (prev.story || []).filter((_, idx) => idx !== i) }));

  // ----- Gallery items (array of { imageUrl, label, linkSku }, max 4) -----
  const gallery = Array.isArray(form.gallery) ? form.gallery : [];
  const setGalleryItem = (i, field, value) =>
    setForm((prev) => {
      const next = [...(Array.isArray(prev.gallery) ? prev.gallery : [])];
      next[i] = { ...next[i], [field]: value };
      return { ...prev, gallery: next };
    });
  const addGalleryItem = () =>
    setForm((prev) => {
      const cur = Array.isArray(prev.gallery) ? prev.gallery : [];
      if (cur.length >= 4) return prev;
      return { ...prev, gallery: [...cur, { imageUrl: '', label: '', linkSku: '' }] };
    });
  const removeGalleryItem = (i) =>
    setForm((prev) => ({ ...prev, gallery: (prev.gallery || []).filter((_, idx) => idx !== i) }));
  const handleGalleryUpload = async (i, file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Välj en bildfil.');
      return;
    }
    try {
      setGalleryUploading(i);
      const url = await uploadBrandImage(file, 'hero', shopId);
      setGalleryItem(i, 'imageUrl', url);
      toast.success('Bild uppladdad. Glöm inte att spara.');
    } catch (error) {
      console.error('Error uploading gallery image:', error);
      toast.error(error?.userMessage || 'Uppladdning misslyckades.');
    } finally {
      setGalleryUploading(-1);
    }
  };

  const accentHex = form.accent || STORE.accent;
  const contrast = evaluateAccentContrast(accentHex);

  // Admin Neutral form tokens (mirrors ProductForm's labelCls/inputCls).
  const labelCls = 'block text-[13px] font-medium text-admin-text mb-1';
  const inputCls =
    'w-full rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]';
  const helpCls = 'mt-1 text-[12px] text-admin-text-muted';

  if (loading) {
    return (
      <AppLayout>
        <Page title="Butik">
          <Card className="px-6 py-12 text-center">
            <div className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-solid border-admin-text-muted border-r-transparent" />
            <p className="mt-3 text-[13px] text-admin-text-muted">Laddar…</p>
          </Card>
        </Page>
      </AppLayout>
    );
  }

  const headerActions = (
    <>
      <Button
        as="a"
        href="/"
        target="_blank"
        rel="noopener noreferrer"
        variant="secondary"
      >
        Förhandsgranska butik
        <ArrowTopRightOnSquareIcon className="h-4 w-4" />
      </Button>
      <Button variant="primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Sparar…' : 'Spara'}
      </Button>
    </>
  );

  return (
    <AppLayout>
      <Page
        title="Butik"
        subtitle="Utseende och innehåll för din webbutik."
        actions={headerActions}
      >
        <RightRail
          main={
            <>
              {/* Template picker — choose the storefront's overall look. Each
                  template is a token preset (see src/config/templates.js); the
                  thumbnail gives a feel before selecting. Accent/logo/hero below
                  still apply on top of the chosen template. */}
              <CardSection title="Mall">
                <p className="text-[13px] text-admin-text-muted mb-4">
                  Välj butikens grundutseende. Din accentfärg och dina bilder läggs ovanpå.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {TEMPLATES.map((tpl) => {
                    const selected = (form.templateId || 'nord') === tpl.id;
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => setField('templateId', tpl.id)}
                        aria-pressed={selected}
                        className={
                          'group text-left rounded-admin overflow-hidden border transition-all ' +
                          (selected
                            ? 'border-admin-primary ring-2 ring-admin-primary'
                            : 'border-admin-border hover:border-admin-text-faint')
                        }
                      >
                        <div className="relative aspect-[16/10] bg-admin-surface-2 overflow-hidden">
                          <img
                            src={tpl.thumb}
                            alt={`Förhandsvisning av mallen ${tpl.name}`}
                            className="w-full h-full object-cover object-top"
                            loading="lazy"
                          />
                          {selected && (
                            <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-admin-primary px-2 py-0.5 text-[11px] font-semibold text-white">
                              Vald
                            </span>
                          )}
                        </div>
                        <div className="p-3">
                          <div className="text-[13px] font-semibold text-admin-text">{tpl.name}</div>
                          <div className="text-[12px] text-admin-text-muted mt-0.5">{tpl.tagline}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </CardSection>

              {/* Brand: accent + logo + hero image */}
              <CardSection title="Varumärke" bodyClassName="space-y-5">
                {/* Accent */}
                <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-start">
                  <div>
                    <label className={labelCls}>Accentfärg</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={/^#[0-9a-fA-F]{6}$/.test(accentHex) ? accentHex : '#000000'}
                        onChange={(e) => setField('accent', e.target.value)}
                        className="h-9 w-12 cursor-pointer rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface p-1"
                        aria-label="Välj accentfärg"
                      />
                      <input
                        type="text"
                        value={form.accent ?? ''}
                        placeholder={STORE.accent}
                        onChange={(e) => setField('accent', e.target.value)}
                        className={inputCls + ' w-32 font-mono'}
                      />
                    </div>
                  </div>

                  {/* Live sample + AA check */}
                  <div className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className="inline-flex items-center rounded-full px-4 py-1.5 text-[13px] font-semibold text-white"
                        style={{ backgroundColor: contrast.valid ? accentHex : '#999' }}
                      >
                        Knappexempel
                      </span>
                      {contrast.valid ? (
                        contrast.passAA ? (
                          <span className="text-[12px] font-medium text-admin-success-text">✓ Tillräcklig kontrast (AA)</span>
                        ) : contrast.passAALarge ? (
                          <span className="text-[12px] font-medium text-admin-caution-text">
                            ⚠ Endast OK för stora knappar — välj gärna mörkare
                          </span>
                        ) : (
                          <span className="text-[12px] font-medium text-admin-critical-text">
                            ⚠ För ljus — vit text blir svårläst
                          </span>
                        )
                      ) : (
                        <span className="text-[12px] font-medium text-admin-critical-text">Ogiltig färgkod</span>
                      )}
                    </div>
                    <p className={helpCls}>
                      Accentfärgen används bara på knappar och aktiva element i butiken.
                    </p>
                  </div>
                </div>

                {/* Logo */}
                <div className="border-t border-admin-border-soft pt-5">
                  <label className={labelCls}>Logotyp</label>
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex h-14 w-32 items-center justify-center overflow-hidden rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2">
                      {form.logoUrl ? (
                        <img src={form.logoUrl} alt="Logotyp" className="max-h-12 max-w-28 object-contain" />
                      ) : (
                        <PhotoIcon className="h-6 w-6 text-admin-text-faint" />
                      )}
                    </div>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] font-medium text-admin-text shadow-[var(--shadow-admin)] hover:bg-admin-surface-2">
                      <ArrowUpTrayIcon className="h-4 w-4" />
                      {uploading.logo ? 'Laddar upp…' : (form.logoUrl ? 'Byt logotyp' : 'Ladda upp logotyp')}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={uploading.logo}
                        onChange={(e) => handleImageUpload('logo', e.target.files?.[0])}
                      />
                    </label>
                    {form.logoUrl && !uploading.logo && (
                      <button
                        type="button"
                        onClick={() => setField('logoUrl', '')}
                        className="inline-flex items-center gap-1.5 rounded-[var(--radius-admin-el)] px-3 py-1.5 text-[13px] font-medium text-admin-critical-text hover:bg-admin-surface-2"
                      >
                        <TrashIcon className="h-4 w-4" />
                        Ta bort
                      </button>
                    )}
                  </div>
                </div>

                {/* Favicon */}
                <div className="border-t border-admin-border-soft pt-5">
                  <label className={labelCls}>Favicon (webbläsarfliken)</label>
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2">
                      {form.faviconUrl ? (
                        <img src={form.faviconUrl} alt="Favicon" className="h-8 w-8 object-contain" />
                      ) : (
                        <PhotoIcon className="h-6 w-6 text-admin-text-faint" />
                      )}
                    </div>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] font-medium text-admin-text shadow-[var(--shadow-admin)] hover:bg-admin-surface-2">
                      <ArrowUpTrayIcon className="h-4 w-4" />
                      {uploading.favicon ? 'Laddar upp…' : (form.faviconUrl ? 'Byt favicon' : 'Ladda upp favicon')}
                      <input
                        type="file"
                        accept=".ico,.png,.svg,image/png,image/svg+xml,image/x-icon"
                        className="hidden"
                        disabled={uploading.favicon}
                        onChange={(e) => handleImageUpload('favicon', e.target.files?.[0])}
                      />
                    </label>
                    {form.faviconUrl && !uploading.favicon && (
                      <button
                        type="button"
                        onClick={() => setField('faviconUrl', '')}
                        className="inline-flex items-center gap-1.5 rounded-[var(--radius-admin-el)] px-3 py-1.5 text-[13px] font-medium text-admin-critical-text hover:bg-admin-surface-2"
                      >
                        <TrashIcon className="h-4 w-4" />
                        Ta bort
                      </button>
                    )}
                  </div>
                  <p className={helpCls}>
                    Ikonen som visas i webbläsarfliken. Använd en kvadratisk .png, .svg eller .ico
                    (minst 32×32 px). Lämna tom för att använda standardikonen.
                  </p>
                </div>

                {/* Hero image */}
                <div className="border-t border-admin-border-soft pt-5">
                  <label className={labelCls}>Hero-bild (startsidans toppbild)</label>
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex h-20 w-32 items-center justify-center overflow-hidden rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2">
                      {form.heroImageUrl ? (
                        <img src={form.heroImageUrl} alt="Hero" className="h-full w-full object-cover" />
                      ) : (
                        <PhotoIcon className="h-6 w-6 text-admin-text-faint" />
                      )}
                    </div>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] font-medium text-admin-text shadow-[var(--shadow-admin)] hover:bg-admin-surface-2">
                      <ArrowUpTrayIcon className="h-4 w-4" />
                      {uploading.hero ? 'Laddar upp…' : (form.heroImageUrl ? 'Byt hero-bild' : 'Ladda upp hero-bild')}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={uploading.hero}
                        onChange={(e) => handleImageUpload('hero', e.target.files?.[0])}
                      />
                    </label>
                    {form.heroImageUrl && !uploading.hero && (
                      <button
                        type="button"
                        onClick={() => setField('heroImageUrl', '')}
                        className="inline-flex items-center gap-1.5 rounded-[var(--radius-admin-el)] px-3 py-1.5 text-[13px] font-medium text-admin-critical-text hover:bg-admin-surface-2"
                      >
                        <TrashIcon className="h-4 w-4" />
                        Ta bort
                      </button>
                    )}
                  </div>
                  <p className={helpCls}>
                    Lämna tom för att visa en stilren accentfärgad bakgrund istället.
                  </p>
                </div>
              </CardSection>

              {/* Hero copy */}
              <CardSection title="Hero-text" bodyClassName="space-y-4">
                <div>
                  <label className={labelCls}>Rubrik</label>
                  <input
                    type="text"
                    value={form.heroHeadline ?? ''}
                    placeholder="Lämna tom för standardrubrik"
                    onChange={(e) => setField('heroHeadline', e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Underrubrik</label>
                  <textarea
                    rows={2}
                    value={form.heroSubtitle ?? ''}
                    placeholder="Lämna tom för standardtext"
                    onChange={(e) => setField('heroSubtitle', e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>Knapptext</label>
                    <input
                      type="text"
                      value={form.heroCtaLabel ?? ''}
                      placeholder="t.ex. Handla nu"
                      onChange={(e) => setField('heroCtaLabel', e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Sekundär länktext</label>
                    <input
                      type="text"
                      value={form.heroSecondaryLabel ?? ''}
                      placeholder="t.ex. Se sortimentet ↓"
                      onChange={(e) => setField('heroSecondaryLabel', e.target.value)}
                      className={inputCls}
                    />
                  </div>
                </div>
              </CardSection>

              {/* Startsida — frontpage showcase category + section headings */}
              <CardSection title="Startsida" bodyClassName="space-y-4">
                <div>
                  <label className={labelCls}>Sortiment på startsidan</label>
                  <select
                    value={form.frontpageCategory ?? ''}
                    onChange={(e) => setField('frontpageCategory', e.target.value)}
                    className={inputCls}
                  >
                    <option value="">Alla produkter</option>
                    <option value={FRONTPAGE_FEATURED}>⭐ Endast utvalda produkter</option>
                    {availableCategories.map((cat) => (
                      <option key={cat} value={cat}>Kategori: {cat}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-[12px] text-admin-text-muted">
                    Vad produktrutnätet på startsidan visar. "Endast utvalda" = produkterna du
                    stjärnmärkt i produktlistan (alla, i din valda ordning — Utvalt-raden ovanför
                    döljs då). Besökare når alltid hela sortimentet via sidan Alla produkter.
                  </p>
                </div>

                <div>
                  <label className={labelCls}>Antal produkter i Utvalt</label>
                  <select
                    value={String(Math.min(12, Math.max(1, parseInt(form.featuredLimit, 10) || 4)))}
                    onChange={(e) => setField('featuredLimit', parseInt(e.target.value, 10))}
                    className={inputCls}
                  >
                    {[2, 3, 4, 6, 8, 12].map((n) => (
                      <option key={n} value={String(n)}>{n}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-[12px] text-admin-text-muted">
                    Max antal produkter i Utvalt-sektionen. Vilka som visas styr du med stjärnan i
                    produktlistan; ordningen med "Ändra ordning" under Produkter.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Rubrik: Utvalt</label>
                    <input
                      type="text"
                      value={form.featuredTitle ?? ''}
                      placeholder="Utvalt"
                      onChange={(e) => setField('featuredTitle', e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Rubrik: Populära samlingar</label>
                    <input
                      type="text"
                      value={form.collectionsTitle ?? ''}
                      placeholder="Populära samlingar"
                      onChange={(e) => setField('collectionsTitle', e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Rubrik: Produkter</label>
                    <input
                      type="text"
                      value={form.productsTitle ?? ''}
                      placeholder="Våra produkter"
                      onChange={(e) => setField('productsTitle', e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelCls}>Underrubrik: Produkter</label>
                    <input
                      type="text"
                      value={form.productsSubtitle ?? ''}
                      placeholder="(valfri)"
                      onChange={(e) => setField('productsSubtitle', e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Rubrik: Recensioner</label>
                    <input
                      type="text"
                      value={form.reviewsTitle ?? ''}
                      placeholder="Vad våra kunder säger"
                      onChange={(e) => setField('reviewsTitle', e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Underrubrik: Recensioner</label>
                    <input
                      type="text"
                      value={form.reviewsSubtitle ?? ''}
                      placeholder="(valfri)"
                      onChange={(e) => setField('reviewsSubtitle', e.target.value)}
                      className={inputCls}
                    />
                  </div>
                </div>
              </CardSection>

              {/* Intro / about */}
              <CardSection title="Introtext" bodyClassName="space-y-4">
                <p className="text-[12px] text-admin-text-muted">
                  Valfri text mellan hero och produkter. Lämna tomt för att dölja.
                </p>
                <div>
                  <label className={labelCls}>Rubrik</label>
                  <input
                    type="text"
                    value={form.introTitle ?? ''}
                    placeholder="t.ex. Om oss"
                    onChange={(e) => setField('introTitle', e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Text</label>
                  <textarea
                    rows={4}
                    value={form.introBody ?? ''}
                    placeholder="Berätta kort om din butik…"
                    onChange={(e) => setField('introBody', e.target.value)}
                    className={inputCls}
                  />
                </div>
              </CardSection>

              {/* Story */}
              <CardSection title="Berättelse" bodyClassName="space-y-4">
                <p className="text-[12px] text-admin-text-muted">
                  Upp till tre steg. Lämna tomt för att använda standardtexten.
                </p>
                <div>
                  <label className={labelCls}>Rubrik</label>
                  <input
                    type="text"
                    value={form.storyTitle ?? ''}
                    placeholder="t.ex. Från kusten till ditt bord"
                    onChange={(e) => setField('storyTitle', e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div className="space-y-3">
                  {story.map((step, i) => (
                    <div key={i} className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[12px] font-semibold tabular-nums text-admin-text-muted">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <Button type="button" variant="plain" onClick={() => removeStoryStep(i)} className="text-admin-critical-text">
                          Ta bort
                        </Button>
                      </div>
                      <input
                        type="text"
                        value={step?.title ?? ''}
                        placeholder="Steg-rubrik"
                        onChange={(e) => setStoryStep(i, 'title', e.target.value)}
                        className={inputCls + ' mb-2'}
                      />
                      <textarea
                        rows={2}
                        value={step?.text ?? ''}
                        placeholder="Steg-text"
                        onChange={(e) => setStoryStep(i, 'text', e.target.value)}
                        className={inputCls}
                      />
                    </div>
                  ))}
                </div>
                {story.length < 3 && (
                  <Button type="button" variant="plain" onClick={addStoryStep}>
                    <PlusIcon className="h-4 w-4" /> Lägg till steg
                  </Button>
                )}
              </CardSection>

              {/* Gallery */}
              <CardSection title="Galleri" bodyClassName="space-y-4">
                <p className="text-[12px] text-admin-text-muted">
                  Upp till fyra bilder. Lämna tomt för att använda standardgalleriet.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {gallery.map((item, i) => (
                    <div key={i} className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 p-3">
                      <div className="flex items-start gap-3">
                        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface">
                          {item?.imageUrl ? (
                            <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <PhotoIcon className="h-5 w-5 text-admin-text-faint" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2.5 py-1 text-[12px] font-medium text-admin-text shadow-[var(--shadow-admin)] hover:bg-admin-surface-2">
                            <ArrowUpTrayIcon className="h-3.5 w-3.5" />
                            {galleryUploading === i ? 'Laddar…' : 'Ladda upp'}
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              disabled={galleryUploading === i}
                              onChange={(e) => handleGalleryUpload(i, e.target.files?.[0])}
                            />
                          </label>
                          <Button type="button" variant="plain" onClick={() => removeGalleryItem(i)} className="ml-2 text-admin-critical-text">
                            Ta bort
                          </Button>
                        </div>
                      </div>
                      <input
                        type="text"
                        value={item?.label ?? ''}
                        placeholder="Etikett (valfri)"
                        onChange={(e) => setGalleryItem(i, 'label', e.target.value)}
                        className={inputCls + ' mt-3'}
                      />
                      <input
                        type="text"
                        value={item?.linkSku ?? ''}
                        placeholder="Länka till produkt-SKU (valfri)"
                        onChange={(e) => setGalleryItem(i, 'linkSku', e.target.value)}
                        className={inputCls + ' mt-2'}
                      />
                    </div>
                  ))}
                </div>
                {gallery.length < 4 && (
                  <Button type="button" variant="plain" onClick={addGalleryItem}>
                    <PlusIcon className="h-4 w-4" /> Lägg till bild
                  </Button>
                )}
              </CardSection>

              {/* Save bar */}
              <div className="flex justify-end">
                <Button variant="primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'Sparar…' : 'Spara'}
                </Button>
              </div>
            </>
          }
          rail={
            <>
              {/* Homepage block toggles */}
              <CardSection title="Startsidans block" bodyClassName="space-y-0">
                <p className="mb-1 text-[12px] text-admin-text-muted">
                  Slå av block du inte vill visa på startsidan.
                </p>
                <div className="divide-y divide-admin-border-soft">
                  {[
                    { key: 'gallery', label: 'Galleri', desc: 'Bildrad under hero-sektionen' },
                    { key: 'collections', label: 'Populära samlingar', desc: 'Utvalda samlingar som kort på startsidan' },
                    { key: 'story', label: 'Berättelse', desc: 'Tre steg som berättar om din butik' },
                    { key: 'bestseller', label: 'Bästsäljare', desc: 'Utvald produkt i hero-rutnätet' },
                    { key: 'trust', label: 'Trygghet', desc: 'Omdöme + betalsätt i hero-rutnätet' },
                  ].map((b) => (
                    <div key={b.key} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-admin-text">{b.label}</div>
                        <div className="text-[12px] text-admin-text-muted">{b.desc}</div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={blockOn(b.key)}
                        onClick={() => toggleBlock(b.key)}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                          blockOn(b.key) ? 'bg-[var(--color-admin-primary)]' : 'bg-admin-border'
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                            blockOn(b.key) ? 'translate-x-[18px]' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </CardSection>
            </>
          }
        />
      </Page>
    </AppLayout>
  );
};

export default AdminStorefront;
