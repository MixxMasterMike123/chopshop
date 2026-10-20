// FlatStudio.jsx — the design studio's "Nytt tryck" (CP12 unit F3, phase 1:
// framed posters). Five pages in one column, the garment studio's frame
// (step chips, CardSection pages, Tillbaka/Nästa, the publish panel):
//   1 · Produkt          the flat families a printer offers (tiles by
//                        `garment`), the finish, and each size with the
//                        server's Inköp
//   2 · Motiv            the artwork library; per size ✓ or "För låg
//                        upplösning (minst W×H px)" (contain at the sheet's
//                        exact px, POD_PRINT_SPEC §2 per sheet); the seller
//                        ticks the sizes to sell. "Fyll arket" (cover) needs
//                        the motif to reach the sheet on both axes (the
//                        Worker's flatReachesPx): step 3 says which ticked
//                        sizes it cannot fill and holds the step until the
//                        seller picks contain or unticks them
//   3 · Placering        the sheet (Pixi) with the 3 mm bleed and the safe
//                        area; fill (cover) or whole motif (contain) on a
//                        background colour, white by default; one motif, no
//                        rotation
//   4 · Förhandsvisning  the print framed on a wall, per ticked size (drawn:
//                        flatRender.js says why it is not a mockup template);
//                        the seller picks the product image
//   5 · Publicera        the existing PublishPanel: one product, the finish as
//                        its one colour, the ticked sizes as its variants, each
//                        on its printer article; the mapping freezes { fit,
//                        background } (studioData publishDesign → ctx.flatPlacement)
// What the garment studio has and this drops (CP12_FLAT_PRINTS_DESIGN §4):
// print surfaces, colourway review, overrides per colour, 3D, fabric tuning.
//
// THE SELLER SEES ONE NUMBER: the only figures are the server's quote per
// size (Inköp, and the floor in the publish panel).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PhotoIcon } from '@heroicons/react/24/outline';
import { CardSection } from '../../../../components/admin/ui';
import { loadPrintRouting, clearPrintRoutingCache } from '../../../../config/printRouting';
import { STORE } from '../../../../config/store';
import { quoteRefusalMessage } from '../../../../admin-app/adapters/pod.js';
import { inkopText, quoteSummary } from '../../../../admin-app/adapters/studio.js';
import {
  BLEED_MM,
  DEFAULT_BACKGROUND,
  DEFAULT_FIT,
  FLAT_GARMENTS,
  SAFE_MM,
  flatEffectiveDpi,
  flatPlacement,
  flatPublishShape,
  flatQualifies,
  flatResolutionText,
  normalizeHex,
  sizesInFinish,
} from '../../../../admin-app/adapters/studioFlat.js';
import { loadCorsImage } from '../corsImage';
import { isComposable } from '../placementMath';
import PublishPanel from '../PublishPanel';
import { publishDesign, quoteFlatSize, useStudioEnv } from '../studioData';
import FlatCanvas from './FlatCanvas';
import { canvasBlob, renderFramed } from './flatRender';

const STEPS = 5;
const BACKGROUND_SWATCHES = [
  { hex: '#ffffff', label: 'Vit' },
  { hex: '#f3efe6', label: 'Benvit' },
  { hex: '#1d1d1f', label: 'Svart' },
];

// A small drawn poster for the family tiles (no photograph exists for a family).
const PosterThumb = ({ dim = false }) => (
  <svg viewBox="0 0 64 64" className={`h-full w-full ${dim ? 'opacity-50' : ''}`} aria-hidden="true">
    <rect x="15" y="8" width="34" height="46" rx="1" className="fill-admin-surface stroke-admin-text-faint" strokeWidth="2.5" />
    <rect x="20" y="13" width="24" height="36" className="fill-admin-surface-3" />
    <path d="M20 41 L28 32 L34 38 L38 34 L44 41 V49 H20 Z" className="fill-admin-text-faint" opacity="0.55" />
    <circle cx="37" cy="21" r="3" className="fill-admin-text-faint" opacity="0.55" />
  </svg>
);
const CardThumb = () => (
  <svg viewBox="0 0 64 64" className="h-full w-full opacity-50" aria-hidden="true">
    <rect x="8" y="17" width="48" height="31" rx="2" className="fill-admin-surface stroke-admin-text-faint" strokeWidth="2" />
    <path d="M33 22 V43" className="stroke-admin-text-faint" strokeWidth="1.5" />
    <path d="M37 27 H51 M37 32 H51 M37 37 H47" className="stroke-admin-text-faint" strokeWidth="1.5" />
  </svg>
);
const StickerThumb = () => (
  <svg viewBox="0 0 64 64" className="h-full w-full opacity-50" aria-hidden="true">
    <path d="M32 9 C45 9 55 19 55 32 C55 45 45 55 32 55 C19 55 9 45 9 32 C9 19 19 9 32 9 Z" className="fill-admin-surface stroke-admin-text-faint" strokeWidth="2" strokeDasharray="4 3" />
    <path d="M23 36 C26 41 38 41 41 36" className="stroke-admin-text-faint" strokeWidth="2.5" fill="none" />
    <circle cx="25" cy="27" r="2.5" className="fill-admin-text-faint" />
    <circle cx="39" cy="27" r="2.5" className="fill-admin-text-faint" />
  </svg>
);
const THUMBS = { poster: PosterThumb, postcard: CardThumb, sticker: StickerThumb };

const FlatStudio = ({ artwork = [], loading = false, shopId = null, products = [], onChanged = null, onOpenArtworkLibrary = null }) => {
  const env = useStudioEnv();
  const [families, setFamilies] = useState([]);
  const [familiesLoading, setFamiliesLoading] = useState(true);
  const [familiesError, setFamiliesError] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [familyKey, setFamilyKey] = useState(null);
  const [finishId, setFinishId] = useState(null);
  const [quotes, setQuotes] = useState({}); // sku → { state, quote?, message? }
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  const [artworkId, setArtworkId] = useState(null);
  const [ticked, setTicked] = useState(() => new Set()); // skus
  const [fit, setFit] = useState(DEFAULT_FIT);
  const [background, setBackground] = useState(DEFAULT_BACKGROUND);
  const [step, setStep] = useState(1);
  const [activeSku, setActiveSku] = useState(null); // steps 3–4: the size on screen
  const [image, setImage] = useState(null);
  const [imageError, setImageError] = useState(null);
  const [previews, setPreviews] = useState({}); // sku → { objectUrl, blob, type }
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [heroSku, setHeroSku] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState(null);
  const [publishErrorField, setPublishErrorField] = useState(null);
  const [publishResult, setPublishResult] = useState(null);
  const publishingRef = useRef(false);

  // ── the families (the tenant printer view, through the routing loader) ────
  useEffect(() => {
    let alive = true;
    setFamiliesLoading(true);
    setFamiliesError(null);
    loadPrintRouting()
      .then((routed) => {
        if (!alive) return;
        const list = routed?.flat ?? [];
        setFamilies(list);
        setFamilyKey((cur) => (cur && list.some((f) => f.key === cur) ? cur : list[0]?.key ?? null));
      })
      .catch((error) => {
        if (!alive) return;
        console.warn('FlatStudio: printers could not be read', error?.message);
        setFamiliesError('Tryckeriernas produkter kunde inte läsas. Kontrollera anslutningen och försök igen.');
      })
      .finally(() => { if (alive) setFamiliesLoading(false); });
    return () => { alive = false; };
  }, [loadAttempt, shopId]);

  const family = families.find((f) => f.key === familyKey) ?? null;
  useEffect(() => {
    const ids = (family?.finishes ?? []).map((f) => f.id);
    setFinishId((cur) => (ids.includes(cur) ? cur : ids[0] ?? null));
  }, [family]);
  const finish = family?.finishes.find((f) => f.id === finishId) ?? null;
  const sizes = useMemo(() => sizesInFinish(family, finishId), [family, finishId]);

  // ── the server's quote per size (Inköp) ───────────────────────────────────
  const sizeKey = sizes.map((s) => s.sku).join(',');
  useEffect(() => {
    if (!family || sizes.length === 0 || !shopId) return undefined;
    let alive = true;
    for (const s of sizes) {
      setQuotes((prev) => (prev[s.sku]?.state === 'ok' ? prev : { ...prev, [s.sku]: { state: 'loading' } }));
      quoteFlatSize({ printerId: family.printerId, sku: s.sku }, { shopId })
        .then((quote) => { if (alive) setQuotes((prev) => ({ ...prev, [s.sku]: { state: 'ok', quote } })); })
        .catch((error) => {
          if (!alive) return;
          setQuotes((prev) => ({ ...prev, [s.sku]: { state: error?.status === 422 ? 'refused' : 'failed', message: quoteRefusalMessage(error) } }));
        });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family?.printerId, sizeKey, shopId, quoteAttempt]);
  const inkopFor = (sku) => {
    const summary = quoteSummary([sku], quotes);
    if (summary.state === 'pending') return { text: 'Hämtar…', muted: true };
    if (summary.state === 'failed') return { text: 'Kunde inte hämtas', failed: true };
    return { text: inkopText(summary) };
  };
  const anyQuoteFailed = sizes.some((s) => ['failed', 'refused'].includes(quotes[s.sku]?.state));

  // ── the motif and the sizes it reaches ────────────────────────────────────
  const composable = useMemo(() => artwork.filter(isComposable), [artwork]);
  const art = artwork.find((a) => a.id === artworkId) ?? null;
  const checks = useMemo(
    () => Object.fromEntries(sizes.map((s) => [s.sku, art ? flatQualifies(art, s.px) : null])),
    [sizes, art],
  );
  const qualifyingCount = (a) => sizes.filter((s) => flatQualifies(a, s.px)?.ok).length;

  const resetDownstream = () => {
    setPreviews((prev) => {
      Object.values(prev).forEach((p) => URL.revokeObjectURL(p.objectUrl));
      return {};
    });
    setHeroSku(null);
    setPreviewError(null);
    setPublishError(null);
    setPublishErrorField(null);
    setPublishResult(null);
  };
  useEffect(() => () => resetDownstream(), []); // revoke on unmount

  const pickArtwork = (a) => {
    setArtworkId(a.id);
    // Every size the motif reaches is ticked from the start; the seller unticks.
    setTicked(new Set(sizes.filter((s) => flatQualifies(a, s.px)?.ok).map((s) => s.sku)));
    resetDownstream();
  };
  // A new family or finish: the sizes are other sizes.
  useEffect(() => {
    setTicked((prev) => new Set([...prev].filter((sku) => sizes.some((s) => s.sku === sku && checks[sku]?.ok))));
    resetDownstream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeKey]);
  const toggleSize = (sku) => {
    if (!checks[sku]?.ok) return;
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
    resetDownstream();
  };
  const tickedSizes = sizes.filter((s) => ticked.has(s.sku));
  const active = tickedSizes.find((s) => s.sku === activeSku) ?? tickedSizes[tickedSizes.length - 1] ?? null;

  // The motif's picture for the canvas and the preview (the library's preview image).
  useEffect(() => {
    let alive = true;
    setImage(null);
    setImageError(null);
    if (!art?.previewUrl) return undefined;
    loadCorsImage(art.previewUrl, 'Motivets bild kunde inte läsas.')
      .then((img) => { if (alive) setImage(img); })
      .catch((error) => { if (alive) setImageError(error?.message || 'Motivets bild kunde inte läsas.'); });
    return () => { alive = false; };
  }, [art?.previewUrl]);

  const changeFit = (next) => {
    if (next === fit) return;
    setFit(next);
    resetDownstream();
  };
  const changeBackground = (hex) => {
    const n = normalizeHex(hex);
    if (!n || n === background) return;
    setBackground(n);
    resetDownstream();
  };

  // ── 4 · the framed previews (one per ticked size) ─────────────────────────
  const makePreviews = useCallback(async () => {
    if (!image || !art || tickedSizes.length === 0) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const next = {};
      for (const s of tickedSizes) {
        const canvas = renderFramed({
          image, artW: art.sourceWidthPx, artH: art.sourceHeightPx, mm: s.mm, fit, background, frameHex: finish?.hex,
        });
        const blob = await canvasBlob(canvas);
        next[s.sku] = { objectUrl: URL.createObjectURL(blob), blob, type: blob.type };
      }
      setPreviews((prev) => {
        Object.values(prev).forEach((p) => URL.revokeObjectURL(p.objectUrl));
        return next;
      });
      setHeroSku((cur) => (cur && next[cur] ? cur : tickedSizes[tickedSizes.length - 1].sku));
    } catch (error) {
      console.warn('FlatStudio: preview failed', error?.message);
      setPreviewError(error?.name === 'SecurityError'
        ? 'Motivets bild kunde inte läsas för förhandsvisningen. Ladda om sidan och försök igen.'
        : 'Förhandsvisningen kunde inte skapas. Försök igen.');
    } finally {
      setPreviewing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, art, tickedSizes.map((s) => s.sku).join(','), fit, background, finish?.hex]);
  useEffect(() => {
    if (step === 4 && Object.keys(previews).length === 0 && !previewing && image) makePreviews();
  }, [step, previews, previewing, image, makePreviews]);

  // Cover never enlarges the master either: the ticked sizes it cannot fill.
  const coverShort = fit === 'cover' && art
    ? tickedSizes.map((s) => ({ size: s, check: flatQualifies(art, s.px, 'cover') })).filter((x) => !x.check?.ok)
    : [];

  // ── gates and navigation (the garment studio's rules) ─────────────────────
  const s1done = Boolean(family && finish && sizes.length > 0);
  const s2done = s1done && Boolean(art) && tickedSizes.length > 0;
  const s3done = s2done && Boolean(image) && coverShort.length === 0;
  const s4done = s3done && Boolean(heroSku && previews[heroSku]);
  const STEP_META = [
    { n: 1, label: 'Produkt', done: s1done },
    { n: 2, label: 'Motiv', done: s2done },
    { n: 3, label: 'Placering', done: s3done },
    { n: 4, label: 'Förhandsvisning', done: s4done },
    { n: 5, label: 'Publicera', done: Boolean(publishResult) },
  ];
  const canEnterStep = (n) => STEP_META.slice(0, n - 1).every((m) => m.done);
  const editorLocked = publishing;
  const goStep = (n) => {
    if (editorLocked || n < 1 || n > STEPS || !canEnterStep(n)) return;
    setStep(n);
  };
  useEffect(() => {
    if (canEnterStep(step)) return;
    let n = step - 1;
    while (n > 1 && !canEnterStep(n)) n -= 1;
    setStep(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, s1done, s2done, s3done, s4done]);

  // ── 5 · publish (the garment studio's checks, then the data module) ──────
  const shape = useMemo(
    () => (family && finish ? flatPublishShape(family, finish.id, tickedSizes.map((s) => s.sku)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [family, finish, tickedSizes.map((s) => s.sku).join(',')],
  );
  const heroMockup = heroSku && previews[heroSku] && finish
    ? { key: `${finish.id}:front`, colorwayId: finish.id, colorwayLabel: finish.label, slot: 'front', ...previews[heroSku] }
    : null;
  const mockups = heroMockup ? [heroMockup] : [];

  const publish = async (form) => {
    if (publishing || publishingRef.current) return;
    setPublishError(null);
    setPublishErrorField(null);
    setPublishResult(null);
    if (!shopId) { setPublishError('Ingen butik är vald.'); return; }
    if (!art || !artwork.some((a) => a.id === art.id)) { setPublishError('Det valda motivet finns inte längre i biblioteket — välj ett nytt motiv i steg 2.'); return; }
    if (!shape) { setPublishError('Välj minst en storlek i steg 2.'); return; }
    if (!heroMockup) { setPublishError('Skapa förhandsvisningen i steg 4 först.'); return; }
    if (!(form.name || '').trim()) { setPublishError('Ange ett produktnamn.'); return; }
    if (!(parseFloat(form.price) > 0)) { setPublishError('Ange ett pris större än 0.'); return; }
    publishingRef.current = true;
    setPublishing(true);
    try {
      const outcome = await publishDesign({
        shopId,
        env,
        selectedTemplate: shape.template,
        effTemplate: shape.template,
        prints: [{ slot: 'front', artworkId: art.id }],
        overrides: {},
        mockups,
        heroKey: heroMockup.key,
        publishSlots: ['front'],
        printArtwork: () => art,
        artworkById: (id) => artwork.find((a) => a.id === id) ?? null,
        resolveArtwork: () => art,
        production: shape.production,
        flatPlacement: flatPlacement(fit, background),
      }, form);
      if (outcome?.result) {
        setPublishResult(outcome.result);
        onChanged?.();
      } else {
        setPublishError(outcome?.error || 'Publiceringen misslyckades.');
        setPublishErrorField(outcome?.field || null);
        if (outcome?.changed) onChanged?.();
      }
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  };
  const resetPublishForm = () => {
    setPublishError(null);
    setPublishErrorField(null);
    setPublishResult(null);
  };

  // ── shared chrome ─────────────────────────────────────────────────────────
  const StepNav = ({ nextLabel, nextEnabled, onNext, hint = null }) => (
    <div className="mt-5 border-t border-admin-border-soft pt-4">
      {hint && !nextEnabled && (
        <p className="mb-3 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text" role="status">
          För att fortsätta: {hint}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {step > 1 && (
          <button
            type="button"
            onClick={() => goStep(step - 1)}
            disabled={editorLocked}
            className="min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3.5 py-2 text-[13px] text-admin-text hover:bg-admin-surface-2 disabled:cursor-default disabled:opacity-40"
          >
            ‹ Tillbaka
          </button>
        )}
        {nextLabel && (
          <button
            type="button"
            onClick={onNext}
            disabled={!nextEnabled}
            className="min-h-10 rounded-[var(--radius-admin-el)] bg-admin-primary px-4 py-2 text-[13px] font-medium text-white dark:text-admin-bg hover:bg-admin-primary-hover disabled:cursor-default disabled:opacity-40"
          >
            {nextLabel} ›
          </button>
        )}
      </div>
    </div>
  );

  // The size switcher of steps 3–4 (the garment studio's segmented control).
  const SizeSwitcher = () => {
    if (tickedSizes.length < 2) return null;
    const index = Math.max(0, tickedSizes.findIndex((s) => s.sku === active?.sku));
    return (
      <div
        role="group"
        aria-label="Byt storlek"
        className="relative mb-3 grid w-full max-w-[520px] rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 p-1"
        style={{ gridTemplateColumns: `repeat(${tickedSizes.length}, minmax(0, 1fr))` }}
      >
        <span
          aria-hidden="true"
          className="pod-thumb absolute inset-y-1 left-1 rounded-[calc(var(--radius-admin-el)-4px)] bg-admin-surface shadow-[var(--shadow-admin)]"
          style={{ width: `calc((100% - 8px) / ${tickedSizes.length})`, transform: `translateX(${index * 100}%)` }}
        />
        {tickedSizes.map((s, i) => (
          <button
            key={s.sku}
            type="button"
            onClick={() => setActiveSku(s.sku)}
            aria-pressed={i === index}
            className={`relative z-10 min-h-10 truncate px-3 text-center text-[13px] transition-colors duration-150 ${
              i === index ? 'font-medium text-admin-text' : 'text-admin-text-muted hover:text-admin-text'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    );
  };

  const offeredGarments = new Set(families.map((f) => f.garment));
  const familiesOf = (garment) => families.filter((f) => f.garment === garment);
  const currentStep = STEP_META[step - 1];
  const artName = (a) => a?.label || a?.fileName || '';
  const dpiActive = art && active ? flatEffectiveDpi(art, active, fit) : null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-[16px] font-semibold text-admin-text">Designstudio · Nytt tryck</h2>
            <p className="mt-1 max-w-[70ch] text-[13px] text-admin-text-muted">
              Ett tryck är motivet som produkten: en affisch i ram, i de storlekar motivet räcker till.
            </p>
          </div>
          <span className="text-[12px] text-admin-text-muted">Steg {step} av {STEPS}</span>
        </div>
        <p className="mt-3 text-[13px] text-admin-text">
          <span className="font-medium">Nu: {currentStep.label}.</span>{' '}
          {step === 1 && 'Välj vilken sorts tryck du vill sälja.'}
          {step === 2 && 'Välj motiv och de storlekar som ska säljas.'}
          {step === 3 && 'Välj hur motivet fyller arket.'}
          {step === 4 && 'Se trycket i ram och välj produktbild.'}
          {step === 5 && 'Kontrollera uppgifterna och skapa produkten.'}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="navigation" aria-label="Designstudions steg">
        {STEP_META.map((m) => {
          const current = m.n === step;
          const enterable = canEnterStep(m.n);
          return (
            <button
              key={m.n}
              type="button"
              onClick={() => goStep(m.n)}
              disabled={!enterable || editorLocked}
              aria-current={current ? 'step' : undefined}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] transition ${
                current
                  ? 'border-admin-info-dot bg-admin-info-bg font-medium text-admin-info-text'
                  : enterable
                    ? 'border-admin-border text-admin-text hover:bg-admin-surface-2'
                    : 'cursor-default border-admin-border-soft text-admin-text-faint'
              }`}
            >
              <span
                className={`grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-semibold ${
                  m.done && !current
                    ? 'bg-admin-success-bg text-admin-success-text'
                    : current
                      ? 'bg-admin-info-dot text-white'
                      : 'bg-admin-surface-2 text-admin-text-muted'
                }`}
              >
                {m.done && !current ? '✓' : m.n}
              </span>
              {m.label}
            </button>
          );
        })}
      </div>

      {/* ── 1 · PRODUKT ─────────────────────────────────────────────────── */}
      {step === 1 && (
      <CardSection title="1 · Produkt" className="pod-step-enter" bodyClassName="p-4">
        {familiesLoading ? (
          <p className="text-[13px] text-admin-text-muted">Laddar tryckeriernas produkter…</p>
        ) : familiesError ? (
          <div className="rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-3">
            <p className="text-[13px] text-admin-caution-text">{familiesError}</p>
            <button type="button" onClick={() => { clearPrintRoutingCache(); setLoadAttempt((n) => n + 1); }} className="mt-2 min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-2 text-[13px] font-medium text-admin-text hover:bg-admin-surface-2">
              Försök igen
            </button>
          </div>
        ) : families.length === 0 ? (
          <p className="rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-3 text-[13px] text-admin-caution-text">
            Inga tryck kan tillverkas just nu — inget tryckeri erbjuder dem. Kontakta plattformsadministratören.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
              {FLAT_GARMENTS.map((g) => {
                const offered = offeredGarments.has(g.garment);
                const selected = family?.garment === g.garment;
                const Thumb = THUMBS[g.garment] ?? PosterThumb;
                return (
                  <button
                    key={g.garment}
                    type="button"
                    disabled={!offered}
                    onClick={() => offered && setFamilyKey(familiesOf(g.garment)[0].key)}
                    aria-pressed={selected}
                    title={offered ? g.label : `${g.label} — kommer senare`}
                    className={`rounded-[var(--radius-admin-el)] border p-1.5 text-left transition ${
                      selected
                        ? 'border-admin-info-dot ring-1 ring-admin-info-dot/40'
                        : offered
                          ? 'border-admin-border hover:bg-admin-surface-2'
                          : 'cursor-not-allowed border-admin-border-soft'
                    }`}
                  >
                    <div className="grid aspect-square place-items-center overflow-hidden rounded-[4px] bg-admin-surface-2">
                      <div className="h-[78%] w-[78%]"><Thumb /></div>
                    </div>
                    <div className={`mt-1 truncate text-center text-[11px] font-medium ${offered ? 'text-admin-text' : 'text-admin-text-faint'}`}>{g.label}</div>
                    {!offered && <div className="mt-0.5 text-center text-[10px] leading-tight text-admin-text-muted">Kommer senare</div>}
                  </button>
                );
              })}
            </div>

            {family && familiesOf(family.garment).length > 1 && (
              <label className="mt-3 block max-w-md">
                <span className="mb-1 block text-[13px] font-medium text-admin-text">Tryckeri</span>
                <select
                  value={family.key}
                  onChange={(e) => setFamilyKey(e.target.value)}
                  className="w-full rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] text-admin-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
                >
                  {familiesOf(family.garment).map((f) => <option key={f.key} value={f.key}>{f.printerName}</option>)}
                </select>
              </label>
            )}

            {family && family.finishes.length > 1 && (
              <div className="mt-4">
                <span className="mb-1 block text-[13px] font-medium text-admin-text">Ram</span>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Ram">
                  {family.finishes.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setFinishId(f.id)}
                      aria-pressed={f.id === finishId}
                      className={`flex min-h-10 items-center gap-2 rounded-[var(--radius-admin-el)] border px-3 text-[13px] ${
                        f.id === finishId ? 'border-admin-info-dot bg-admin-info-bg/40 text-admin-text ring-1 ring-admin-info-dot/40' : 'border-admin-border text-admin-text hover:bg-admin-surface-2'
                      }`}
                    >
                      <span className="h-4 w-4 rounded-[3px] border border-black/15" style={{ backgroundColor: f.hex }} />
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {family && (
              <div className="mt-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[13px] font-medium text-admin-text">
                    Storlekar{finish && family.finishes.length === 1 ? ` · ${finish.label}` : ''}
                  </span>
                  <span className="text-[12px] text-admin-text-muted">Inköp inkl. moms, per styck</span>
                </div>
                <ul className="mt-2 divide-y divide-admin-border-soft rounded-[var(--radius-admin-el)] border border-admin-border">
                  {sizes.map((s) => {
                    const inkop = inkopFor(s.sku);
                    return (
                      <li key={s.sku} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <span className="text-[13px] text-admin-text">
                          <span className="font-medium">{s.label}</span>
                          {s.inchLabel && <span className="text-admin-text-muted"> · {s.inchLabel}</span>}
                        </span>
                        <span className={`text-[13px] tabular-nums ${inkop.failed ? 'text-admin-caution-text' : inkop.muted ? 'text-admin-text-muted' : 'font-medium text-admin-text'}`}>
                          {inkop.text}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {anyQuoteFailed && (
                  <p className="mt-2 text-[12px] text-admin-caution-text">
                    Inköpspriset kunde inte hämtas för alla storlekar.{' '}
                    <button type="button" onClick={() => setQuoteAttempt((n) => n + 1)} className="font-medium underline">Försök igen</button>
                  </p>
                )}
                <p className="mt-2 text-[12px] text-admin-text-muted">
                  Motivet trycks över hela arket. Du väljer storlekar efter motivet i nästa steg.
                </p>
              </div>
            )}
          </>
        )}
        <StepNav nextLabel="Nästa: Motiv" nextEnabled={s1done} onNext={() => goStep(2)} hint="Välj en produkt" />
      </CardSection>
      )}

      {/* ── 2 · MOTIV ───────────────────────────────────────────────────── */}
      {step === 2 && (
      <CardSection title="2 · Motiv" className="pod-step-enter" bodyClassName="p-4">
        {loading ? (
          <p className="text-[13px] text-admin-text-muted">Laddar original…</p>
        ) : composable.length === 0 ? (
          <div className="rounded-[var(--radius-admin-el)] bg-admin-surface-2 px-3 py-3">
            <p className="text-[13px] text-admin-text-muted">
              Inga godkända original finns ännu. Ladda upp en PNG eller JPG; designen ligger kvar här under tiden.
            </p>
            {onOpenArtworkLibrary && (
              <button type="button" onClick={onOpenArtworkLibrary} className="mt-2 min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-2 text-[13px] font-medium text-admin-text hover:bg-admin-surface">
                Gå till Original
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
            {composable.map((a) => {
              const isCurrent = a.id === artworkId;
              const reach = qualifyingCount(a);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => pickArtwork(a)}
                  aria-pressed={isCurrent}
                  aria-label={`${artName(a)} — räcker till ${reach} av ${sizes.length} storlekar`}
                  className={`overflow-hidden rounded-[var(--radius-admin-el)] border p-1 text-left ${
                    isCurrent ? 'border-admin-info-dot ring-1 ring-admin-info-dot/50' : 'border-admin-border hover:border-admin-text-faint'
                  }`}
                >
                  {a.previewUrl ? (
                    <img src={a.previewUrl} alt="" loading="lazy" decoding="async" className="aspect-square w-full rounded-[4px] object-cover" />
                  ) : (
                    <span className="grid aspect-square w-full place-items-center rounded-[4px] bg-admin-surface-2 text-admin-text-muted">
                      <PhotoIcon className="h-4 w-4" />
                    </span>
                  )}
                  <span className="mt-1 block truncate text-[11px] text-admin-text">{artName(a)}</span>
                  <span className={`block text-[10px] leading-tight ${reach > 0 ? 'text-admin-text-muted' : 'text-admin-caution-text'}`}>
                    {reach > 0 ? `${reach} av ${sizes.length} storlekar` : 'För liten för alla storlekar'}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {art && (
          <div className="mt-5">
            <p className="text-[13px] font-semibold text-admin-text">Storlekar att sälja</p>
            <p className="mt-0.5 text-[12px] text-admin-text-muted">
              {artName(art)} är {art.sourceWidthPx}×{art.sourceHeightPx} px. Trycket görs i 300 dpi, så varje storlek kräver motivet i minst arkets upplösning.
            </p>
            <ul className="mt-2 divide-y divide-admin-border-soft rounded-[var(--radius-admin-el)] border border-admin-border">
              {sizes.map((s) => {
                const check = checks[s.sku];
                const ok = check?.ok === true;
                const low = flatResolutionText(check);
                return (
                  <li key={s.sku}>
                    <label className={`flex items-center gap-3 px-3 py-2.5 ${ok ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                      <input
                        type="checkbox"
                        checked={ticked.has(s.sku)}
                        disabled={!ok}
                        onChange={() => toggleSize(s.sku)}
                        className="h-4 w-4 rounded-[4px] border-admin-border text-[var(--color-admin-primary)] focus:ring-[var(--color-admin-primary)] disabled:opacity-40"
                      />
                      <span className={`flex-1 text-[13px] ${ok ? 'text-admin-text' : 'text-admin-text-muted'}`}>
                        <span className="font-medium">{s.label}</span>
                        {s.inchLabel && <span className="text-admin-text-muted"> · {s.inchLabel}</span>}
                      </span>
                      {ok ? (
                        <span className="text-[12px] text-admin-success-text">✓ Räcker</span>
                      ) : (
                        <span className="text-right text-[12px] text-admin-caution-text">{low ?? 'Motivets storlek är okänd'}</span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <StepNav
          nextLabel="Nästa: Placering"
          nextEnabled={s2done}
          onNext={() => goStep(3)}
          hint={!art ? 'Välj ett motiv' : 'Välj minst en storlek som motivet räcker till'}
        />
      </CardSection>
      )}

      {/* ── 3 · PLACERING ───────────────────────────────────────────────── */}
      {step === 3 && active && (
      <CardSection title="3 · Placering" className="pod-step-enter" bodyClassName="p-4">
        <p className="mb-3 text-[13px] text-admin-text-muted">
          Motivet placeras centrerat. Välj om det ska fylla hela arket eller visas helt på en bakgrund.
        </p>
        <SizeSwitcher />
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_260px]">
          <div>
            {imageError ? (
              <p className="rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[13px] text-admin-caution-text">{imageError}</p>
            ) : (
              <FlatCanvas
                image={image}
                artW={art.sourceWidthPx}
                artH={art.sourceHeightPx}
                size={active}
                fit={fit}
                background={background}
                label={`${artName(art)} på ${active.label}, ${fit === 'cover' ? 'fyller arket' : 'helt motiv på bakgrund'}`}
              />
            )}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-admin-text-muted">
              <span className="flex items-center gap-1.5">
                <svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" strokeWidth="1.5" strokeDasharray="6 4" className="stroke-[var(--color-admin-critical-dot)]" /></svg>
                Skärkant {BLEED_MM} mm — utanför kan skäras bort eller döljas av ramen
              </span>
              <span className="flex items-center gap-1.5">
                <svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" strokeWidth="1.5" strokeDasharray="2 3" className="stroke-[var(--color-admin-info-dot)]" /></svg>
                Säker yta {SAFE_MM} mm — håll text innanför
              </span>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-admin-text">Motivet</span>
              <div className="grid gap-1.5" role="radiogroup" aria-label="Hur motivet fyller arket">
                {[
                  { id: 'cover', title: 'Fyll arket', text: 'Motivet täcker hela arket. Det som sticker ut beskärs.' },
                  { id: 'contain', title: 'Hela motivet', text: 'Motivet syns helt, på en bakgrundsfärg.' },
                ].map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={fit === o.id}
                    onClick={() => changeFit(o.id)}
                    className={`rounded-[var(--radius-admin-el)] border px-3 py-2.5 text-left transition ${
                      fit === o.id ? 'border-admin-info-dot bg-admin-info-bg/40 ring-1 ring-admin-info-dot/40 dark:bg-admin-surface-2' : 'border-admin-border hover:bg-admin-surface-2'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-admin-text">{o.title}</span>
                      {fit === o.id && <span className="pod-pop text-[11px] font-medium text-admin-info-text">✓ Valt</span>}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-admin-text-muted">{o.text}</span>
                  </button>
                ))}
              </div>
            </div>

            {fit === 'contain' && (
              <div>
                <span className="mb-1.5 block text-[13px] font-medium text-admin-text">Bakgrund</span>
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Bakgrundsfärg">
                  {BACKGROUND_SWATCHES.map((sw) => (
                    <button
                      key={sw.hex}
                      type="button"
                      onClick={() => changeBackground(sw.hex)}
                      aria-pressed={background === sw.hex}
                      aria-label={sw.label}
                      title={sw.label}
                      className={`grid h-8 w-8 place-items-center rounded-full border transition ${
                        background === sw.hex ? 'border-admin-info-dot ring-2 ring-admin-info-dot/40' : 'border-admin-border hover:border-admin-text-faint'
                      }`}
                    >
                      <span className="h-6 w-6 rounded-full border border-black/10" style={{ backgroundColor: sw.hex }} />
                    </button>
                  ))}
                  <label className="ml-1 flex items-center gap-1.5 text-[12px] text-admin-text-muted">
                    <input
                      type="color"
                      value={background}
                      onChange={(e) => changeBackground(e.target.value)}
                      aria-label="Egen bakgrundsfärg"
                      className="h-8 w-10 cursor-pointer rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface p-0.5"
                    />
                    Egen
                  </label>
                </div>
              </div>
            )}

            {coverShort.length > 0 && (
              <div className="rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2.5 text-[12px] text-admin-caution-text" role="status">
                <p className="font-medium">Motivet är för litet för att fylla arket i {coverShort.map((x) => x.size.label).join(', ')}.</p>
                <ul className="mt-1 space-y-0.5">
                  {coverShort.map((x) => (
                    <li key={x.size.sku}>{x.size.label}: minst {x.check?.minW}×{x.check?.minH} px</li>
                  ))}
                </ul>
                <p className="mt-1">Välj Hela motivet, eller ta bort storleken i steg 2.</p>
              </div>
            )}

            <div className="rounded-[var(--radius-admin-el)] bg-admin-surface-2 px-3 py-2.5 text-[12px] text-admin-text">
              <div className="font-medium">{active.label}{active.inchLabel ? ` · ${active.inchLabel}` : ''}</div>
              <div className="mt-0.5 text-admin-text-muted">Tryckfil {active.px.w}×{active.px.h} px</div>
              {dpiActive != null && dpiActive >= 300 && (
                <div className="mt-0.5 text-admin-text-muted">Motivet håller {dpiActive} dpi i den här storleken.</div>
              )}
            </div>
          </div>
        </div>
        <StepNav
          nextLabel="Nästa: Förhandsvisning"
          nextEnabled={s3done}
          onNext={() => goStep(4)}
          hint={coverShort.length > 0 ? 'Motivet behöver fylla arket i varje vald storlek' : 'Motivets bild behöver laddas'}
        />
      </CardSection>
      )}

      {/* ── 4 · FÖRHANDSVISNING ─────────────────────────────────────────── */}
      {step === 4 && active && (
      <CardSection title="4 · Förhandsvisning" className="pod-step-enter" bodyClassName="p-4">
        <p className="mb-3 text-[13px] text-admin-text-muted">
          Så här ser trycket ut i ramen. Välj vilken storlek som blir produktens huvudbild.
        </p>
        <SizeSwitcher />
        {previewError ? (
          <div className="rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-3">
            <p className="text-[13px] text-admin-caution-text">{previewError}</p>
            <button type="button" onClick={makePreviews} className="mt-2 min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-2 text-[13px] font-medium text-admin-text hover:bg-admin-surface-2">
              Försök igen
            </button>
          </div>
        ) : !previews[active.sku] ? (
          <div className="grid aspect-square w-full max-w-[520px] place-items-center rounded-[var(--radius-admin)] bg-admin-surface-2 text-[13px] text-admin-text-muted">
            {previewing ? 'Skapar förhandsvisning…' : 'Förhandsvisningen saknas.'}
          </div>
        ) : (
          <figure className="w-full max-w-[520px]">
            <img
              src={previews[active.sku].objectUrl}
              alt={`${artName(art)} som ${family?.label?.toLowerCase() ?? 'tryck'}, ${active.label}, ${finish?.label?.toLowerCase() ?? ''}`}
              className="aspect-square w-full rounded-[var(--radius-admin)] object-cover ring-1 ring-admin-border"
            />
            <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12px] text-admin-text-muted">
                {active.label} · {finish?.label} · {fit === 'cover' ? 'fyller arket' : 'helt motiv'}
              </span>
              {heroSku === active.sku ? (
                <span className="rounded-full bg-admin-success-bg px-2.5 py-1 text-[12px] font-medium text-admin-success-text">✓ Huvudbild</span>
              ) : (
                <button
                  type="button"
                  onClick={() => setHeroSku(active.sku)}
                  className="min-h-10 rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-1.5 text-[13px] text-admin-text hover:bg-admin-surface-2"
                >
                  Använd som huvudbild
                </button>
              )}
            </figcaption>
          </figure>
        )}
        <p className="mt-3 max-w-[70ch] text-[12px] text-admin-text-muted">
          Bilden visar ramen och arket i rätt proportioner. Den yttersta kanten av arket ligger under ramen.
        </p>
        <StepNav nextLabel="Nästa: Publicera" nextEnabled={s4done} onNext={() => goStep(5)} hint="Vänta tills förhandsvisningen är klar" />
      </CardSection>
      )}

      {/* ── 5 · PUBLICERA ───────────────────────────────────────────────── */}
      {step === 5 && shape && (
      <CardSection title="5 · Publicera" className="pod-step-enter" bodyClassName="p-4">
        <PublishPanel
          mockups={mockups}
          template={shape.template}
          vatRate={STORE.vatRate}
          hasArtwork={Boolean(art)}
          printSummary={[{ slot: 'front', slotLabel: `${family.label}, ${fit === 'cover' ? 'fyller arket' : 'helt motiv på bakgrund'}`, artworkLabel: artName(art) || '—' }]}
          shopId={shopId}
          publishing={publishing}
          result={publishResult}
          error={publishError}
          errorField={publishErrorField}
          locked={editorLocked}
          production={shape.production}
          reviewedColorwayIds={[finish.id]}
          selectedColorwayIds={[finish.id]}
          onPublish={publish}
          products={products}
          sizeOptions={shape.sizeLabels}
          allowExisting={false}
          onReset={resetPublishForm}
        />
        <StepNav nextLabel={null} nextEnabled={false} onNext={() => {}} />
      </CardSection>
      )}
    </div>
  );
};

export default FlatStudio;
