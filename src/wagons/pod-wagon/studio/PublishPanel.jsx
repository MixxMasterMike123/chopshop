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
 *   onPublish(form) — form = { name, price, selectedColorwayIds, sizesByColorway,
 *                     perColorwayPrices }
 *   products       — [{ id, sku, name, image, hasSku, variants }] existing shop
 *                     products (shared library load) — the "Uppdatera befintlig
 *                     produkt" target picker
 *   onUpdateExisting(form) — form = { productId, selectedColorwayIds,
 *                     connectPrint, replaceImages } — attach mockups (+ POD
 *                     mappings) to an EXISTING product instead of creating one
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
  onPublish,
  products = [],
  onUpdateExisting,
  onReset,
}) => {
  // Colourways that actually have ≥1 generated mockup (the only publishable set).
  const availableColorways = useMemo(() => {
    const withMockup = new Set(mockups.map((m) => m.colorwayId));
    const labelById = new Map(mockups.map((m) => [m.colorwayId, m.colorwayLabel]));
    // Preserve template colourway order; fall back to mockup order/labels.
    const ordered = (template?.colorways || [])
      .filter((c) => withMockup.has(c.id))
      .map((c) => ({ id: c.id, label: c.label }));
    if (ordered.length) return ordered;
    return [...withMockup].map((id) => ({ id, label: labelById.get(id) || id }));
  }, [mockups, template]);

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  // Publish TARGET: create a new product (default) or update an existing one
  // (attach mockups + POD mappings to a product built content-first).
  const [target, setTarget] = useState('new');
  const [targetProductId, setTargetProductId] = useState('');
  const [connectPrint, setConnectPrint] = useState(true);   // mappings = printability
  const [replaceImages, setReplaceImages] = useState(false); // never silently replace
  const [margin, setMargin] = useState('40');
  const [sizes, setSizes] = useState(DEFAULT_SIZES);
  const [newSize, setNewSize] = useState('');
  // Selected colourways: default all. Keyed by colourway id → bool.
  const [selected, setSelected] = useState(() => {
    const m = {};
    availableColorways.forEach((c) => { m[c.id] = true; });
    return m;
  });
  // Per-(colourway,size) opt-out: default all-on. { [cwId]: { [size]: bool } }.
  const [sizeOptOut, setSizeOptOut] = useState({});
  // Per-colourway explicit price override (empty = inherit product price).
  const [rowPrices, setRowPrices] = useState({});

  const cost = Number.isFinite(template?.costSek) ? template.costSek : null;

  // Keep selection map in sync when the available set changes (regenerated mockups).
  const syncedSelected = useMemo(() => {
    const m = {};
    availableColorways.forEach((c) => { m[c.id] = c.id in selected ? selected[c.id] : true; });
    return m;
  }, [availableColorways, selected]);

  const selectedColorways = availableColorways.filter((c) => syncedSelected[c.id]);
  const selectedColorwayIds = selectedColorways.map((c) => c.id);

  // The effective sizes for a colourway (global sizes minus its opt-outs).
  const sizesFor = (cwId) => sizes.filter((s) => sizeOptOut[cwId]?.[s] !== true);

  const toggleColorway = (id) =>
    setSelected((prev) => ({ ...prev, [id]: !(id in prev ? prev[id] : true) }));

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
    setPrice(String(roundUpTo9(target)));
  };

  // Profit/margin for a given inkl-moms price (ex moms − cost).
  const profitFor = (inklMoms) => {
    if (cost == null || !(inklMoms > 0)) return null;
    return inklMoms / (1 + vatRate) - cost;
  };
  const marginFor = (inklMoms) => {
    const exMoms = inklMoms > 0 ? inklMoms / (1 + vatRate) : 0;
    const p = profitFor(inklMoms);
    if (p == null || !(exMoms > 0)) return null;
    return p / exMoms;
  };

  const validName = name.trim().length > 0;
  const validPrice = priceNum > 0;
  const hasColorways = selectedColorwayIds.length > 0;
  const anySizeless = selectedColorways.some((c) => sizesFor(c.id).length === 0);

  // REVIEW GATE (slice 5): every SELECTED colourway must have been seen in the
  // strip. Accepts a Set or array. The unreviewed ones drive the actionable hint.
  const reviewedSet = reviewedColorwayIds instanceof Set ? reviewedColorwayIds : new Set(reviewedColorwayIds);
  const unreviewedColorways = selectedColorways.filter((c) => !reviewedSet.has(c.id));
  const allReviewed = hasColorways && unreviewedColorways.length === 0;

  // Success + validity gates. Review is the LAST gate — everything else keeps its
  // priority so the hint only surfaces once the form is otherwise publishable.
  const canPublish =
    !publishing && validName && validPrice && hasColorways && hasArtwork && !!shopId && allReviewed;

  const targetProduct = products.find((p) => p.id === targetProductId) || null;
  const targetHasSku = Boolean(targetProduct?.hasSku);
  const canUpdate =
    !publishing && !!targetProductId && hasColorways && hasArtwork && !!shopId && allReviewed;

  const submitExisting = () => {
    if (!canUpdate) return;
    onUpdateExisting?.({
      productId: targetProductId,
      selectedColorwayIds,
      // Print connection needs a product SKU to key the mappings on.
      connectPrint: connectPrint && targetHasSku,
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
      <p className="text-[12px] text-admin-text-muted">
        Skapa en riktig produkt av dina mockuper — den blir direkt köpbar i butiken.
      </p>

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
                <label className={`flex items-center gap-2 text-[13px] ${targetHasSku ? 'cursor-pointer text-admin-text' : 'cursor-not-allowed text-admin-text-muted'}`}>
                  <input type="checkbox" checked={connectPrint && targetHasSku} disabled={!targetHasSku}
                    onChange={(e) => setConnectPrint(e.target.checked)} className={checkboxCls} />
                  Koppla trycket till produkten (krävs för POD-beställningar)
                </label>
                {targetProduct && targetHasSku &&
                  products.filter((p) => p.hasSku && p.sku === targetProduct.sku).length > 1 && (
                  <p className="text-[12px] text-admin-caution-text">
                    Fler produkter delar SKU ”{targetProduct.sku}” — tryckkopplingen gäller
                    ALLA produkter med det SKU:t. Ge produkterna unika SKU:n om de ska
                    tryckas olika.
                  </p>
                )}
                {targetProduct && !targetHasSku && (
                  <p className="text-[12px] text-admin-caution-text">
                    Produkten saknar SKU — bilderna läggs till, men trycket kan inte kopplas.
                    Ge produkten ett SKU under Produkter först.
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

          {/* 3. Colourway multi-select */}
          <div>
            <label className={labelCls}>Färger som publiceras</label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {availableColorways.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 text-[13px] text-admin-text">
                  <input
                    type="checkbox"
                    checked={!!syncedSelected[c.id]}
                    onChange={() => toggleColorway(c.id)}
                    className={checkboxCls}
                  />
                  {c.label}
                </label>
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
                    aria-label={`Ta bort ${s}`}
                  >
                    ×
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
                              aria-label={`${c.label} storlek ${s}`}
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
              <p className="mt-1.5 text-[12px] text-admin-text-muted">
                En färg utan valda storlekar publiceras utan storleksval (en enda variant).
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
              <span className="text-[12px] text-admin-text-muted">Marginal</span>
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
            {!validPrice && (
              <p className="mt-1 text-[12px] text-admin-caution-text">Ange ett pris större än 0.</p>
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
                            className={`${smallInputCls} w-24`}
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
                  ? `Produkten ”${result.name}” uppdaterades med dina mockuper${result.connected ? ' och trycket kopplades' : ''}.`
                  : `Produkten ”${result.name}” skapades.`}
              </p>
              <p className="mt-1 text-[12px] text-admin-success-text">
                {result.sku ? `SKU: ${result.sku} · ` : ''}den är {result.updated ? 'uppdaterad' : 'nu LIVE'} i butiken.
              </p>
              {result.skippedOverrides?.length > 0 && (
                <p className="mt-2 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
                  Obs: eget motiv för {result.skippedOverrides.join(', ')} kunde INTE kopplas
                  (ingen variant med matchande namn på produkten) — de färgerna trycks med
                  standardmotivet. Kontrollera under Produktkoppling.
                </p>
              )}
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
                  className="rounded-[var(--radius-admin-el)] bg-admin-primary px-4 py-2 text-[13px] font-medium text-white dark:text-admin-bg hover:bg-admin-primary-hover disabled:cursor-default disabled:opacity-40"
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
              {!hasArtwork && shopId && (
                <p className="mt-2 text-[12px] text-admin-text-muted">
                  Lägg till minst ett tryck med motiv innan du publicerar (varje tryckrad behöver ett motiv).
                </p>
              )}
              {/* Review gate is the LAST gate: shown only when everything else is
                  valid but not every selected colourway has been seen in the strip. */}
              {shopId && hasArtwork && (target === 'existing' ? !!targetProductId : (validName && validPrice)) && hasColorways && !allReviewed && (
                <p className="mt-2 rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
                  Granska färgerna i färglisten innan du publicerar — {selectedColorways.length - unreviewedColorways.length} av {selectedColorways.length} granskade.
                  {' '}Kvar: {unreviewedColorways.map((c) => c.label).join(', ')}.
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
