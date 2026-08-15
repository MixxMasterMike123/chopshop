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
import { setMapping, deleteMapping } from '../../../utils/podMappings';
import { getProfileById } from '../../../config/podProfiles';
import { POD_SLOTS, slotOf, slotLabel } from '../../../config/podSlots';
import { tierTone, tierLabel } from './podTier';
import PodProductPicker from './PodProductPicker';

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
  const [manualSku, setManualSku] = useState(false); // freetext escape hatch (variant SKUs)

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
    setSaving(true);
    try {
      const art = artworkById(artworkId);
      const { replaced } = await setMapping({
        shopId, sku: cleanSku, artworkId, profileId: art?.purpose || null, placement, placementSlot,
      });
      // Same product+slot replaces that slot's artwork — say so explicitly.
      toast.success(replaced ? `Ersatte tidigare koppling för ${slotLabel(placementSlot)}` : 'Koppling sparad');
      setSku(''); setArtworkId(''); setPlacement(''); setPlacementSlot('front');
      refresh();
    } catch (e) {
      toast.error(e?.message || 'Kunde inte spara kopplingen.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (m) => {
    if (!window.confirm(`Ta bort kopplingen för SKU "${m.sku}" (${slotLabel(slotOf(m))})?`)) return;
    try {
      await deleteMapping(m.id);
      toast.success('Koppling borttagen');
      refresh();
    } catch (e) {
      toast.error('Kunde inte ta bort kopplingen.');
    }
  };

  // artwork eligible to attach: not FAIL (a seller can still pick, but we surface tier)
  const selectableArtwork = artwork;

  return (
    <CardSection title="Manuella tryckkopplingar">
      <p className="mb-3 text-[13px] text-admin-text-muted">
        Designstudion kopplar motiv och placering automatiskt när en produkt skapas eller uppdateras.
        Använd bara den här avancerade vyn för att reparera en äldre produkt eller koppla en produkt som inte skapats i Designstudion.
      </p>

      {/* Add-row form. A product can carry SEVERAL originals — one per placering
          (Bröst/Rygg/ärm). Adding the same product+placering replaces that slot's
          artwork; a different placering is a new coupling. */}
      <div className="mb-4 grid gap-3 rounded-[var(--radius-admin)] border border-admin-border-soft bg-admin-surface-2 p-3 sm:grid-cols-5">
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
        <div className="flex items-end">
          <Button variant="primary" onClick={handleAdd} disabled={saving} className="w-full">
            {saving ? 'Sparar…' : 'Lägg till'}
          </Button>
        </div>
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
                      {slotLabel(slot)}
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
                  </div>
                  <div className="truncate text-[12px] text-admin-text-faint">
                    {art ? (art.label || art.fileName) : '—'}
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
