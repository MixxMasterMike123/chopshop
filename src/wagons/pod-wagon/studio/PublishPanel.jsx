// PublishPanel.jsx — the Design Studio's final step (POD add-on, slice 4):
// pick colourways + sizes, price them, and CREATE the real product.
//
// PRESENTATIONAL + local form state only. The actual publish work (sku resolution,
// image uploads, addDoc, podMappings) lives in DesignStudio's `publish` handler —
// which owns all the studio state and Firebase. This component therefore imports NO
// firebase, so the dev harness can mount it with a fake publish() and stay
// Firebase-free.
//
// Money display note: prices are stored INKL. moms. Profit/margin are shown ex moms
// (prisInklMoms / (1 + VAT) − cost). The VAT rate + template cost come from props so
// this stays pure.
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import HelpPopover from './HelpPopover';
import { sellerProfitExVat, sellerMargin, priceFloor, FEE_RATE, FEE_FIXED } from '../podPricing';

const DEFAULT_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];

// Swedish number formatting: comma decimals, no trailing ,0.
const fmtSek = (n) => {
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n * 100) / 100;
  // Whole number → no decimals; otherwise up to 2 decimals with a comma, no
  // trailing zeros ("18,5" not "18,50"; "100" not "100,00").
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded).replace('.', ',');
};
const fmtKr = (n) => (Number.isFinite(n) ? `${fmtSek(n)} kr` : '—');
const fmtPct = (frac) => (Number.isFinite(frac) ? `${Math.round(frac * 100)} %` : '—');

// Round a price UP to the nearest number ending in 9 (…9): 260.75 → 269, 269 → 269.
const roundUpTo9 = (value) => {
  const n = Math.ceil(value);
  const rem = ((n - 9) % 10 + 10) % 10; // distance above the previous …9
  return n + ((10 - rem) % 10);
};

/**
 * Props:
 *   mockups        — [{ key, colorwayId, colorwayLabel, slot, objectUrl, ... }]
 *   template       — selectedTemplate (reads .costSek + .colorways for labels)
 *   vatRate        — number (e.g. 0.25)
 *   hasArtwork     — bool (the trycklista has ≥1 print AND every row has a motif —
 *                     publish needs a mapping motif per designed slot)
 *   printSummary   — [{ slot, slotLabel, artworkLabel }] — the prints about to
 *                     publish, shown as the "Detta trycks" receipt (slice A)
 *   shopId         — string | null (null → publish disabled with an explanation)
 *   publishing     — bool (handler in flight)
 *   result         — { name, sku } | null (success)
 *   error          — string | null (honest failure message)
 *   reviewedColorwayIds — Set|array of colourway ids the seller has SEEN in the strip.
 *                     LAST publish gate: every selected colourway must be reviewed
 *                     ("inga tryck-överraskningar").
 *   selectedColorwayIds — colours chosen in Studio step 5. Null keeps the
 *                     standalone harness backwards-compatible by using all mockups.
 *   onPublish(form) — form = { name, price, selectedColorwayIds, sizesByColorway,
 *                     perColorwayPrices }
 *   products       — [{ id, sku, name, image, hasSku, variants }] existing shop
 *                     products (shared library load) — the "Uppdatera befintlig
 *                     produkt" target picker
 *   onUpdateExisting(form) — form = { productId, selectedColorwayIds,
 *                     replaceImages } — attach mockups (+ POD
 *                     mappings) to an EXISTING product instead of creating one
 *   initialTargetProductId — preselects target='existing' with this product
 *                     (the ?designFor deep link from the product form)
 *   onReset()      — clear name/price after a success ("Skapa en till")
 */
const PublishPanel = ({
  mockups = [],
  template = null,
  vatRate = 0.25,
  hasArtwork = false,
  printSummary = [],
  shopId = null,
  publishing = false,
  result = null,
  error = null,
  reviewedColorwayIds = [],
  selectedColorwayIds: requestedColorwayIds = null,
  onPublish,
  products = [],
  onUpdateExisting,
  initialTargetProductId = null,
  onReset,
}) => {
  // Colourways that actually have ≥1 generated mockup (the only publishable set).
  const availableColorways = useMemo(() => {
    const withMockup = new Set(mockups.map((m) => m.colorwayId));
    const requested = Array.isArray(requestedColorwayIds) ? new Set(requestedColorwayIds) : null;
    const labelById = new Map(mockups.map((m) => [m.colorwayId, m.colorwayLabel]));
    // Preserve template colourway order; fall back to mockup order/labels.
    const ordered = (template?.colorways || [])
      .filter((c) => withMockup.has(c.id) && (!requested || requested.has(c.id)))
      .map((c) => ({ id: c.id, label: c.label }));
    if (ordered.length) return ordered;
    return [...withMockup]
      .filter((id) => !requested || requested.has(id))
      .map((id) => ({ id, label: labelById.get(id) || id }));
  }, [mockups, template, requestedColorwayIds]);

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  // Publish TARGET: create a new product (default) or update an existing one
  // (attach mockups + POD mappings to a product built content-first).
  const [target, setTarget] = useState(initialTargetProductId ? 'existing' : 'new');
  const [targetProductId, setTargetProductId] = useState(initialTargetProductId || '');
  const [replaceImages, setReplaceImages] = useState(false); // never silently replace
  const [margin, setMargin] = useState('40');
  const [sizes, setSizes] = useState(DEFAULT_SIZES);
  const [newSize, setNewSize] = useState('');
  // Per-(colourway,size) opt-out: default all-on. { [cwId]: { [size]: bool } }.
  const [sizeOptOut, setSizeOptOut] = useState({});
  // Per-colourway explicit price override (empty = inherit product price).
  const [rowPrices, setRowPrices] = useState({});

  const cost = Number.isFinite(template?.costSek) ? template.costSek : null;

  const selectedColorways = availableColorways;
  const selectedColorwayIds = selectedColorways.map((c) => c.id);

  // The effective sizes for a colourway (global sizes minus its opt-outs).
  const sizesFor = (cwId) => sizes.filter((s) => sizeOptOut[cwId]?.[s] !== true);

  const toggleSizeCell = (cwId, size) =>
    setSizeOptOut((prev) => ({
      ...prev,
      [cwId]: { ...(prev[cwId] || {}), [size]: !(prev[cwId]?.[size] === true) },
    }));

  const addSize = () => {
    const s = newSize.trim().toUpperCase();
    if (!s) return;
    setSizes((prev) => (prev.includes(s) ? prev : [...prev, s]));
    setNewSize('');
  };
  const removeSize = (s) => setSizes((prev) => prev.filter((x) => x !== s));

  const priceNum = parseFloat(price);
  const applyMarginToPrice = () => {
    const m = parseFloat(margin);
    if (cost == null || !(m >= 0)) return;
    const target = cost * (1 + m / 100) * (1 + vatRate);
    // Never suggest below break-even — the floor wins over a low margin target.
    setPrice(String(Math.max(roundUpTo9(target), floor ?? 0)));
  };

  // Seller profit/margin (fee-aware, exkl. moms) + the break-even PRICE FLOOR —
  // the single podPricing source, so Studio, product edit and Kent's brief agree.
  const profitFor = (inklMoms) => sellerProfitExVat(inklMoms, cost ?? NaN, vatRate);
  const marginFor = (inklMoms) => sellerMargin(inklMoms, cost ?? NaN, vatRate);
  const floor = cost == null ? null : priceFloor(cost, vatRate);

  const validName = name.trim().length > 0;
  const validPrice = priceNum > 0 && (floor == null || priceNum >= floor);
  // Per-colourway override prices must respect the floor too — an override row
  // below break-even would undercut the platform's base revenue on that colour.
  const belowFloorColorways = floor == null ? [] : selectedColorways.filter((c) => {
    const rp = (rowPrices[c.id] || '').trim();
    if (rp === '') return false;
    const n = parseFloat(rp);
    return Number.isFinite(n) && n > 0 && n < floor;
  });
  const hasColorways = selectedColorwayIds.length > 0;
  // A colour with EVERY size unchecked is almost always an accident — block it
  // (Codex/impeccable 2026-08-15). But an EMPTY global size list is the
  // deliberate one-size path (kepsar/väskor: one variant per colour, the
  // documented pre-existing behavior) — that must stay publishable, so only
  // flag when sizes exist to choose from.
  const anySizeless = sizes.length > 0 && selectedColorways.some((c) => sizesFor(c.id).length === 0);

  // REVIEW GATE (slice 5): every SELECTED colourway must have been seen in the
  // strip. Accepts a Set or array. The unreviewed ones drive the actionable hint.
  const reviewedSet = reviewedColorwayIds instanceof Set ? reviewedColorwayIds : new Set(reviewedColorwayIds);
  const unreviewedColorways = selectedColorways.filter((c) => !reviewedSet.has(c.id));
  const allReviewed = hasColorways && unreviewedColorways.length === 0;

  // Success + validity gates. Review is the LAST gate — everything else keeps its
  // priority so the hint only surfaces once the form is otherwise publishable.
  const canPublish =
    !publishing && validName && validPrice && hasColorways && hasArtwork && !!shopId && allReviewed && !anySizeless && belowFloorColorways.length === 0;

  const targetProduct = products.find((p) => p.id === targetProductId) || null;
  const targetHasSku = Boolean(targetProduct?.hasSku);
  const targetSkuConflict = Boolean(
    targetProduct?.sku && products.some((p) => p.id !== targetProduct.id && p.hasSku && p.sku === targetProduct.sku)
  );
  const canUpdate =
    !publishing && !!targetProductId && targetHasSku && !targetSkuConflict && hasColorways && hasArtwork && !!shopId && allReviewed;

  const publishBlocker = (() => {
    if (!shopId) return 'Välj en butik och öppna Designstudion från butikens admin.';
    if (!hasArtwork) return 'Gå tillbaka och välj ett motiv för varje tryckyta.';
    if (!hasColorways) return 'Gå tillbaka och välj minst en färg.';
    if (!allReviewed) return `Gå tillbaka till Godkänn och granska ${unreviewedColorways.map((c) => c.label).join(', ')}.`;
    if (target === 'existing' && !targetProductId) return 'Välj produkten som ska uppdateras.';
    if (target === 'existing' && !targetHasSku) return 'Ge produkten en unik SKU under Produkter och försök igen.';
    if (target === 'existing' && targetSkuConflict) return `SKU ”${targetProduct.sku}” används av flera produkter. Ge varje produkt en unik SKU under Produkter.`;
    if (target === 'new' && !validName) return 'Ange ett produktnamn.';
    if (target === 'new' && anySizeless) return 'Välj minst en storlek för varje färg.';
    if (target === 'new' && !validPrice) {
      return floor != null && priceNum > 0 && priceNum < floor
        ? `Priset måste vara minst prisgolvet ${floor} kr — under det tjänar du 0 kr.`
        : 'Ange ett pris större än 0 kr.';
    }
    if (target === 'new' && belowFloorColorways.length > 0) {
      return `Priset för ${belowFloorColorways.map((c) => c.label).join(', ')} ligger under prisgolvet ${floor} kr.`;
    }
    return null;
  })();

  const submitExisting = () => {
    if (!canUpdate) return;
    onUpdateExisting?.({
      productId: targetProductId,
      selectedColorwayIds,
      replaceImages,
    });
  };

  const submit = () => {
    if (!canPublish) return;
    const sizesByColorway = {};
    const perColorwayPrices = {};
    selectedColorways.forEach((c) => {
      sizesByColorway[c.id] = sizesFor(c.id);
      const rp = (rowPrices[c.id] || '').trim();
      perColorwayPrices[c.id] = rp === '' ? '' : rp;
    });
    onPublish?.({
      name: name.trim(),
      price: priceNum,
      selectedColorwayIds,
      sizesByColorway,
      perColorwayPrices,
    });
  };

  const inputCls =
    'w-full rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] text-admin-text placeholder:text-admin-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]';
  const smallInputCls =
    'rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1 text-[12px] text-admin-text placeholder:text-admin-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]';
  const labelCls = 'block text-[13px] font-medium text-admin-text mb-1';
  const checkboxCls =
    'h-4 w-4 rounded-[4px] border-admin-border text-[var(--color-admin-primary)] focus:ring-[var(--color-admin-primary)]';

  return (
    // No own frame/heading — the studio renders this inside its numbered
    // "4 · Publicera" section (the harness mounts it bare, also fine).
    <div>
      <p className="text-[13px] text-admin-text-muted">
        Kontrollera uppgifterna nedan. En ny produkt blir köpbar direkt när du skapar den.
      </p>
      <div className="mt-3 rounded-[var(--radius-admin-el)] bg-admin-success-bg px-3 py-2 text-[12px] text-admin-success-text">
        Tryckkoppling ingår. Motivet och placeringen kopplas automatiskt till just den här produkten och följer med till Printkön vid beställning.
      </div>

      {mockups.length === 0 ? (
        <p className="mt-3 text-[12px] text-admin-text-muted">Generera mockuper först.</p>
      ) : (
        <div className="mt-4 space-y-5">
          {/* 1. What gets printed — the trycklista receipt. The seller confirms
              position + motif per print BEFORE naming/pricing (slot-aware
              publish, slice A). */}
          {printSummary.length > 0 && (
            <div className="rounded-[var(--radius-admin-el)] bg-admin-surface-2 px-3 py-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-admin-text-muted">Detta trycks</span>
              <ul className="mt-1 space-y-0.5">
                {printSummary.map((p) => (
                  <li key={p.slot} className="text-[12px] text-admin-text">
                    <span className="font-medium">{p.slotLabel}</span>
                    <span className="text-admin-text-muted"> — {p.artworkLabel}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 2. Target: new product (default) or an existing one. Closes the
              content-first gap — a product created without images gets its
              studio mockups AND its print connection here. */}
          <div>
            <label className={labelCls}>Mål</label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-admin-text">
                <input type="radio" name="pub-target" checked={target === 'new'}
                  onChange={() => { setTarget('new'); if (result) onReset?.(); }} className="h-4 w-4 accent-admin-primary" />
                Skapa ny produkt
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-admin-text">
                <input type="radio" name="pub-target" checked={target === 'existing'}
                  onChange={() => { setTarget('existing'); if (result) onReset?.(); }} className="h-4 w-4 accent-admin-primary" />
                Uppdatera befintlig produkt
              </label>
            </div>
            {target === 'existing' && (
              <div className="mt-2.5 space-y-2.5">
                <select
                  value={targetProductId}
                  onChange={(e) => setTargetProductId(e.target.value)}
                  aria-label="Produkt att uppdatera"
                  className={`${inputCls} max-w-md`}
                >
                  <option value="">Välj produkt…</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || '(namnlös produkt)'}{p.hasSku ? '' : ' — saknar SKU'}
                    </option>
                  ))}
                </select>
                {targetProduct && targetSkuConflict && (
                  <p className="text-[12px] text-admin-critical-text">
                    Flera produkter delar SKU ”{targetProduct.sku}”. De kan därför inte ha olika motiv. Ge varje produkt en unik SKU under Produkter innan du fortsätter.
                  </p>
                )}
                {targetProduct && !targetHasSku && (
                  <p className="text-[12px] text-admin-caution-text">
                    Produkten saknar SKU. Ge den en unik SKU under Produkter innan du fortsätter.
                  </p>
                )}
                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-admin-text">
                  <input type="checkbox" checked={replaceImages}
                    onChange={(e) => setReplaceImages(e.target.checked)} className={checkboxCls} />
                  Ersätt även befintlig huvudbild/variantbilder (annars fylls bara tomma)
                </label>
              </div>
            )}
          </div>

          {/* 2b. Product name (new-product target only) */}
          {target === 'new' && (
          <div>
            <label className={labelCls} htmlFor="pub-name">Produktnamn</label>
            <input
              id="pub-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="t.ex. Fjäll-tee"
              className={inputCls}
            />
          </div>
          )}

          {/* 3. Colourway receipt — selection is owned by Studio step 5. */}
          <div>
            <span className={labelCls}>Färger som publiceras</span>
            <div className="flex flex-wrap gap-1.5">
              {selectedColorways.map((c) => (
                <span
                  key={c.id}
                  className="rounded-full bg-admin-surface-2 px-2.5 py-1 text-[12px] text-admin-text"
                >
                  {c.label}
                </span>
              ))}
            </div>
            {!hasColorways && (
              <p className="mt-1 text-[12px] text-admin-caution-text">Välj minst en färg att publicera.</p>
            )}
          </div>

          {/* 4. Sizes — new-product target only (an existing product keeps
              its own variants untouched; v1 does no variant surgery). */}
          {target === 'new' && (
          <div>
            <label className={labelCls}>Storlekar</label>
            <p className="mb-2 text-[12px] text-admin-text-muted">
              Alla storlekar erbjuds från början. Avmarkera en kombination som inte ska säljas. Det ändrar inte lagersaldo.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {sizes.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 px-2 py-0.5 text-[12px] text-admin-text"
                >
                  {s}
                  <button
                    type="button"
                    onClick={() => removeSize(s)}
                    className="px-1.5 py-1 -my-1 text-admin-text-muted hover:text-admin-text"
                    aria-label={`Ta bort storlek ${s} från alla färger`}
                  >
                    Ta bort
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={newSize}
                onChange={(e) => setNewSize(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSize(); } }}
                aria-label="Lägg till storlek"
                placeholder="+ storlek"
                className={`${smallInputCls} w-20`}
              />
            </div>

            {/* Per-colourway opt-out matrix (only when there are sizes + colourways) */}
            {sizes.length > 0 && selectedColorways.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="text-[12px] text-admin-text">
                  <thead>
                    <tr>
                      <th className="px-2 py-1 text-left font-medium text-admin-text-muted">Färg</th>
                      {sizes.map((s) => (
                        <th key={s} className="px-2 py-1 text-center font-medium text-admin-text-muted">{s}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedColorways.map((c) => (
                      <tr key={c.id} className="border-t border-admin-border-soft">
                        <td className="px-2 py-1 text-admin-text">{c.label}</td>
                        {sizes.map((s) => (
                          <td key={s} className="px-2 py-1 text-center">
                            <input
                              type="checkbox"
                              aria-label={`${c.label}, storlek ${s}, erbjuds`}
                              checked={sizeOptOut[c.id]?.[s] !== true}
                              onChange={() => toggleSizeCell(c.id, s)}
                              className={checkboxCls}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {anySizeless && (
              <p className="mt-2 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
                Minst en färg saknar storlek. Välj minst en storlek per färg för att kunna skapa produkten.
              </p>
            )}
            {sizes.length === 0 && (
              <p className="mt-2 text-[12px] text-admin-text-muted">
                Inga storlekar — produkten publiceras i en storlek (en variant per färg).
              </p>
            )}
          </div>
          )}

          {/* 5. Pricing (new-product target only) */}
          {target === 'new' && (
          <div>
            <label className={labelCls} htmlFor="pub-price">Pris (SEK, inkl. moms)</label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="pub-price"
                type="number"
                min="0"
                step="1"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0"
                className={`${inputCls} w-32`}
              />
              <span className="text-admin-text-muted">·</span>
              <span className="flex items-center gap-0.5 text-[12px] text-admin-text-muted">
                Marginal
                <HelpPopover label="Så beräknas marginalen">
                  Vinsten är priset exklusive moms minus produktionskostnaden och transaktionsavgiften ({Math.round(FEE_RATE * 100)} % + {FEE_FIXED} kr på slutpriset). Marginalen är vinsten delad med priset exklusive moms. Prisgolvet är där vinsten blir 0 kr.
                </HelpPopover>
              </span>
              <input
                type="number"
                min="0"
                step="1"
                value={margin}
                aria-label="Marginal i procent"
                onChange={(e) => setMargin(e.target.value)}
                className={`${smallInputCls} w-16`}
                disabled={cost == null}
              />
              <span className="text-[12px] text-admin-text-muted">%</span>
              <button
                type="button"
                onClick={applyMarginToPrice}
                disabled={cost == null}
                className="rounded-[var(--radius-admin-el)] border border-admin-border px-2.5 py-1 text-[12px] text-admin-text hover:bg-admin-surface-2 disabled:cursor-default disabled:opacity-40"
                title={cost == null ? 'Produktionskostnad saknas för den här mallen' : undefined}
              >
                Sätt pris från marginal
              </button>
            </div>
            {floor != null && (
              <p className="mt-1 text-[12px] text-admin-text-muted">
                Prisgolv: <span className="font-medium text-admin-text">{floor} kr</span> — vid det priset tjänar du 0 kr
                (produktionskostnad {fmtSek(cost)} kr + avgift {Math.round(FEE_RATE * 100)} % + {FEE_FIXED} kr är inräknade).
              </p>
            )}
            {!validPrice && (
              <p className="mt-1 text-[12px] text-admin-caution-text">
                {floor != null && priceNum > 0 && priceNum < floor
                  ? `Priset måste vara minst prisgolvet ${floor} kr.`
                  : 'Ange ett pris större än 0.'}
              </p>
            )}

            {/* Per-colourway pricing table */}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] text-[12px]">
                <thead>
                  <tr className="text-left text-admin-text-muted">
                    <th className="px-2 py-1 font-medium">Färg</th>
                    <th className="px-2 py-1 font-medium">Produktionskostnad</th>
                    <th className="px-2 py-1 font-medium">Pris</th>
                    <th className="px-2 py-1 font-medium">Vinst</th>
                    <th className="px-2 py-1 font-medium">Marginal</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedColorways.map((c) => {
                    const rp = (rowPrices[c.id] || '').trim();
                    const rowNum = rp === '' ? priceNum : parseFloat(rp);
                    const effective = Number.isFinite(rowNum) && rowNum > 0 ? rowNum : NaN;
                    return (
                      <tr key={c.id} className="border-t border-admin-border-soft text-admin-text">
                        <td className="px-2 py-1.5">{c.label}</td>
                        <td className="px-2 py-1.5 text-admin-text-muted">{cost == null ? '—' : `${fmtSek(cost)} kr`}</td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={rowPrices[c.id] || ''}
                            aria-label={`Pris för ${c.label}`}
                            onChange={(e) => setRowPrices((prev) => ({ ...prev, [c.id]: e.target.value }))}
                            placeholder={validPrice ? fmtSek(priceNum) : '—'}
                            className={`${smallInputCls} w-24 ${floor != null && rp !== '' && parseFloat(rp) > 0 && parseFloat(rp) < floor ? 'border-admin-critical-dot' : ''}`}
                          />
                        </td>
                        <td className="px-2 py-1.5 text-admin-text-muted">{fmtKr(profitFor(effective))}</td>
                        <td className="px-2 py-1.5 text-admin-text-muted">{fmtPct(marginFor(effective))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {cost == null && (
              <p className="mt-1.5 text-[12px] text-admin-text-muted">
                Produktionskostnad saknas för den här mallen — vinst och marginal visas när priset är satt av tryckeriet.
              </p>
            )}
          </div>
          )}

          {/* 6. Publish action + status */}
          {result ? (
            <div className="rounded-[var(--radius-admin)] border border-admin-success-dot/40 bg-admin-success-bg px-4 py-3">
              <p className="text-[13px] font-medium text-admin-success-text">
                {result.updated
                  ? `Produkten ”${result.name}” uppdaterades med dina mockuper och trycket kopplades automatiskt.`
                  : `Produkten ”${result.name}” skapades.`}
              </p>
              <p className="mt-1 text-[12px] text-admin-success-text">
                {result.sku ? `SKU: ${result.sku} · ` : ''}den är {result.updated ? 'uppdaterad' : 'nu LIVE'} i butiken.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Link to="/admin/products" className="text-[12px] font-medium text-admin-info-text hover:underline">
                  Öppna Produkter
                </Link>
                <button
                  type="button"
                  onClick={onReset}
                  className="text-[12px] text-admin-text-muted hover:text-admin-text hover:underline"
                >
                  Skapa en till
                </button>
              </div>
            </div>
          ) : (
            <div>
              {!shopId ? (
                <p className="text-[12px] text-admin-text-muted">
                  Ingen butik är vald — publicering är inte tillgänglig här. Öppna studion inifrån en butiks admin.
                </p>
              ) : (
                <button
                  type="button"
                  onClick={target === 'existing' ? submitExisting : submit}
                  disabled={target === 'existing' ? !canUpdate : !canPublish}
                  className="min-h-10 rounded-[var(--radius-admin-el)] bg-admin-primary px-4 py-2 text-[13px] font-medium text-white dark:text-admin-bg hover:bg-admin-primary-hover disabled:cursor-default disabled:opacity-40"
                >
                  {publishing
                    ? (target === 'existing' ? 'Uppdaterar…' : 'Skapar…')
                    : (target === 'existing' ? 'Uppdatera produkten' : 'Skapa produkt')}
                </button>
              )}
              {error && (
                <p className="mt-2 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
                  {error}
                </p>
              )}
              {publishBlocker && !publishing && (
                <p className="mt-2 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
                  För att fortsätta: {publishBlocker}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PublishPanel;
