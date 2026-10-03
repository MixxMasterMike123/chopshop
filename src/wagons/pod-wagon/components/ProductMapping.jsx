// ProductMapping — maps a validated artwork → product SKU + placement. Products are
// a SEPARATE entity; this never edits products. Orphan visibility (don't prevent
// renames — surface breakage): a mapping whose SKU no longer matches any current
// product, or whose artworkId no longer resolves, is flagged so the seller fixes it
// before an order silently arrives with no file.
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { TrashIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { CardSection, Button, Field, Input, Select } from '../../../components/admin/ui';
import StatusPill from '../../../components/admin/ui/StatusPill';
import { getProfileById } from '../../../config/podProfiles';
import { POD_SLOTS, slotOf, slotLabel } from '../../../config/podSlots';
import { POD_GARMENTS, garmentLabel } from '../../../config/podGarments';
import { tierTone, tierLabel } from './podTier';
import PodProductPicker from './PodProductPicker';
import {
  MAPPING_INTRO,
  PRINTER_ROUTED,
  addMapping,
  removeMapping,
  selectableForMapping,
  usePrinterChoice,
} from './productMappingData';

// Non-apparel print profiles. A poster/sticker/mug original mapped onto a garment
// is a likely mistake — surfaced as an info chip (we can't know the product's type;
// visibility of the artwork's profile is the honest check). Task E.
const NON_APPAREL_PROFILES = new Set(['poster_large', 'sticker_diecut', 'mug_wrap']);

// Data (mappings/artwork/profiles/products) comes from the shared usePodLibrary
// load lifted to PodAdminPage — one fetch feeds the banner + both tabs (no
// duplicate per-tab reads). onChanged() re-runs that shared load after a write.
const ProductMapping = ({
  shopId,
  mappings = [],
  artwork = [],
  profiles = [],
  products = [],
  productSkus = new Set(),
  loading = false,
  onChanged,
}) => {
  const [saving, setSaving] = useState(false);

  // add-row form state
  const [sku, setSku] = useState('');
  const [artworkId, setArtworkId] = useState('');
  const [placementSlot, setPlacementSlot] = useState('front'); // default Bröst
  const [placement, setPlacement] = useState('');
  const [garment, setGarment] = useState(''); // print-routing key — required
  const [manualSku, setManualSku] = useState(false); // freetext escape hatch (variant SKUs)
  // The printer, its article and the print slots (the build whose mappings
  // name a printer article; null in the build that maps to a garment).
  const choice = usePrinterChoice({ shopId, sku, products, mappings });

  const refresh = () => onChanged?.();

  const artworkById = (id) => artwork.find((a) => a.id === id) || null;
  const purposeLabel = (id) => getProfileById(profiles, id)?.label || id;

  // Orphan check — mirrors resolveMapping() (printProjection.ts) client-side. A
  // mapping SKU is NOT orphaned if it is a known SKU (parent / colorway / size row),
  // OR if it '-'-boundary-extends one (a size-level SKU like `north-01-svart-xxl`
  // that inherits from the colorway `north-01-svart`). Otherwise the product was
  // renamed/deleted and the mapping would never resolve — flag it.
  const isKnownSku = (sku) => {
    if (!sku) return false;
    if (productSkus.has(sku)) return true;
    for (const known of productSkus) {
      if (sku.startsWith(known + '-')) return true;
    }
    return false;
  };

  const handleAdd = async () => {
    if (saving) return;
    const cleanSku = sku.trim();
    if (!cleanSku) { toast.error('Ange en SKU.'); return; }
    if (!artworkId) { toast.error('Välj ett original.'); return; }
    if (!PRINTER_ROUTED && !garment) { toast.error('Välj plagg.'); return; }
    setSaving(true);
    try {
      const art = artworkById(artworkId);
      const { message } = await addMapping({
        shopId, sku: cleanSku, artworkId, art, placement, placementSlot, garment, choice, products,
      });
      toast.success(message);
      setSku(''); setArtworkId(''); setPlacement(''); setPlacementSlot('front'); setGarment('');
      choice?.reset();
      refresh();
    } catch (e) {
      toast.error(e?.message || 'Kunde inte spara kopplingen.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (m) => {
    if (!window.confirm(`Ta bort kopplingen för SKU "${m.sku}" (${m.slotsLabel || slotLabel(slotOf(m))})?`)) return;
    try {
      await removeMapping({ m, mappings, products, shopId });

      toast.success('Koppling borttagen');
      refresh();
    } catch (e) {
      toast.error(e?.userMessage || 'Kunde inte ta bort kopplingen.');
    }
  };

  // artwork eligible to attach: not FAIL (a seller can still pick, but we surface tier)
  const selectableArtwork = artwork.filter(selectableForMapping);

  return (
    <CardSection title="Manuella tryckkopplingar">
      <p className="mb-3 text-[13px] text-admin-text-muted">
        {MAPPING_INTRO}
      </p>

      {/* Add-row form. A product can carry SEVERAL originals — one per placering
          (Bröst/Rygg/ärm). Adding the same product+placering replaces that slot's
          artwork; a different placering is a new coupling. */}
      <div className="mb-4 grid gap-3 rounded-[var(--radius-admin)] border border-admin-border-soft bg-admin-surface-2 p-3 sm:grid-cols-6">
        <Field label="Produkt" htmlFor="map-pick-product">
          <PodProductPicker
            products={products}
            value={sku}
            onChange={setSku}
            manual={manualSku}
            onToggleManual={setManualSku}
            idPrefix="map-pick"
          />
        </Field>
        <Field label="Original" htmlFor="map-art">
          <Select id="map-art" value={artworkId} onChange={(e) => setArtworkId(e.target.value)}>
            <option value="">Välj original…</option>
            {selectableArtwork.map((a) => (
              <option key={a.id} value={a.id}>
                {(a.label || a.fileName)} {a.validation?.tier ? `· ${tierLabel(a.validation.tier)}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        {PRINTER_ROUTED ? (
          <>
            {/* The mapping names the printer, its article (the physical blank)
                and the print slots; the garment follows from the article. */}
            <Field label="Tryckeri" htmlFor="map-printer">
              <Select id="map-printer" value={choice.printerId} onChange={(e) => choice.setPrinterId(e.target.value)} disabled={saving}>
                <option value="">{choice.printersLoading ? 'Hämtar tryckerier…' : 'Välj tryckeri…'}</option>
                {choice.printers.map((p) => (
                  <option key={p.printerId} value={p.printerId}>{p.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Artikel" htmlFor="map-article">
              <Select id="map-article" value={choice.articleSku} onChange={(e) => choice.setArticleSku(e.target.value)} disabled={saving || !choice.printerId}>
                <option value="">Välj artikel…</option>
                {choice.articles.map((a) => (
                  <option key={a.sku} value={a.sku}>{a.text}</option>
                ))}
              </Select>
            </Field>
            <Field label="Placering" htmlFor={choice.slotOptions[0] ? `map-slot-${choice.slotOptions[0].id}` : undefined}>
              {choice.slotOptions.length === 0 ? (
                <p className="py-1.5 text-[12px] text-admin-text-faint">Välj en artikel först.</p>
              ) : (
                <div className="space-y-1 py-0.5">
                  {choice.slotOptions.map((s) => (
                    <label key={s.id} htmlFor={`map-slot-${s.id}`} className="flex items-center gap-2 text-[13px] text-admin-text">
                      <input
                        id={`map-slot-${s.id}`}
                        type="checkbox"
                        checked={s.checked}
                        onChange={() => choice.toggleSlot(s.id)}
                        disabled={saving}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              )}
            </Field>
          </>
        ) : (
          <>
            <Field label="Plagg" htmlFor="map-garment">
              <Select id="map-garment" value={garment} onChange={(e) => setGarment(e.target.value)}>
                <option value="">Välj plagg…</option>
                {POD_GARMENTS.map((g) => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Placering" htmlFor="map-slot">
              <Select id="map-slot" value={placementSlot} onChange={(e) => setPlacementSlot(e.target.value)}>
                {POD_SLOTS.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Detalj (valfritt)" htmlFor="map-place">
              <Input id="map-place" value={placement} onChange={(e) => setPlacement(e.target.value)} placeholder="t.ex. Centrerat på bröstet, 25 cm" />
            </Field>
          </>
        )}
        <div className="flex items-end">
          <Button variant="primary" onClick={handleAdd} disabled={saving} className="w-full">
            {saving ? 'Sparar…' : 'Lägg till'}
          </Button>
        </div>
        {/* The server's ONE number for the choice (Inköp and the price floor), or why it has none. */}
        {PRINTER_ROUTED && choice.note && (
          <p className={`text-[12px] sm:col-span-6 ${choice.note.tone === 'caution' ? 'text-admin-caution-text' : 'text-admin-text-muted'}`}>
            {choice.note.text}
          </p>
        )}
      </div>

      {loading ? (
        <p className="text-[13px] text-admin-text-muted">Laddar…</p>
      ) : mappings.length === 0 ? (
        <p className="text-[13px] text-admin-text-muted">Inga kopplingar ännu.</p>
      ) : (
        <ul className="divide-y divide-admin-border-soft">
          {mappings.map((m) => {
            const art = artworkById(m.artworkId);
            const skuOrphan = m.sku && !isKnownSku(m.sku);
            const artOrphan = m.artworkId && !art;
            const slot = slotOf(m); // missing placementSlot → 'front' (Bröst)
            // Task E: the artwork's profile — a NON-apparel profile mapped to what may
            // be a garment is worth surfacing (we can't know the product's type).
            const artProfile = art?.purpose || m.profileId;
            const nonApparel = artProfile && NON_APPAREL_PROFILES.has(artProfile);
            const isFail = art?.validation?.tier === 'FAIL';
            return (
              <li key={m.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-[13px] font-medium text-admin-text">{m.sku}</span>
                    {/* Slot chip — which physical placement this coupling targets. */}
                    <span className="inline-flex items-center rounded-full border border-admin-border-soft bg-admin-surface-2 px-2 py-0.5 text-[11px] font-medium text-admin-text-muted">
                      {m.slotsLabel || slotLabel(slot)}
                    </span>
                    {art && <StatusPill tone={tierTone(art.validation?.tier)}>{tierLabel(art.validation?.tier)}</StatusPill>}
                    {isFail && (
                      <span className="inline-flex items-center gap-1 text-[12px] text-admin-critical-text">
                        <ExclamationTriangleIcon className="h-3.5 w-3.5" /> Originalet är underkänt av valideringen
                      </span>
                    )}
                    {nonApparel && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-admin-border-soft bg-admin-surface-2 px-2 py-0.5 text-[11px] font-medium text-admin-text-muted">
                        {purposeLabel(artProfile)}
                      </span>
                    )}
                    {skuOrphan && (
                      <span className="inline-flex items-center gap-1 text-[12px] text-admin-caution-text">
                        <ExclamationTriangleIcon className="h-3.5 w-3.5" /> Ingen produkt med denna SKU – omdöpt eller borttagen?
                      </span>
                    )}
                    {artOrphan && (
                      <span className="inline-flex items-center gap-1 text-[12px] text-admin-critical-text">
                        <ExclamationTriangleIcon className="h-3.5 w-3.5" /> Originalet saknas
                      </span>
                    )}
                    {/* Why this mapping cannot be produced (paused, or its printer article is gone). */}
                    {m.problem && (
                      <span className="inline-flex items-center gap-1 text-[12px] text-admin-caution-text">
                        <ExclamationTriangleIcon className="h-3.5 w-3.5" /> {m.problem}
                      </span>
                    )}
                    {/* No garment = no printer (SnapWear A4) — checkout refuses the line. */}
                    {!m.garment && !m.problem && (
                      <span className="inline-flex items-center gap-1 text-[12px] text-admin-caution-text">
                        <ExclamationTriangleIcon className="h-3.5 w-3.5" /> Plagg saknas – lägg till kopplingen igen med plagg valt, annars kan den inte skickas till tryckeri
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[12px] text-admin-text-faint">
                    {art ? (art.label || art.fileName) : '—'}
                    {m.garment ? ` · ${garmentLabel(m.garment)}` : ''}
                    {m.profileId ? ` · ${purposeLabel(m.profileId)}` : ''}
                    {m.placement ? ` · ${m.placement}` : ''}
                  </div>
                </div>
                {art?.previewUrl && (
                  <img src={art.previewUrl} alt="" className="h-10 w-10 shrink-0 rounded-[6px] border border-admin-border object-cover" />
                )}
                <button
                  onClick={() => handleDelete(m)}
                  title="Ta bort koppling"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-critical-dot"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </CardSection>
  );
};

export default ProductMapping;
