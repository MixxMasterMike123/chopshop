// ArtworkLibrary — the seller's print-artwork library: upload + validate + list +
// delete. Shop-scoped. Admin-Neutral design.
//
// UNMAPPED VISIBILITY: an unmapped artwork means orders never reach the print queue
// — this state MUST be loud. Each row shows either an amber "Inte kopplad till
// produkt" chip + a "Koppla…" action (jumps to Produktkoppling prefilled), or the
// SKU(s) it's mapped to as small chips. The mapping data comes from the shared
// usePodLibrary load (ONE listMappings call, not N).
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { TrashIcon, PhotoIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { httpsCallable } from 'firebase/functions';
import { CardSection, Button } from '../../../components/admin/ui';
import StatusPill from '../../../components/admin/ui/StatusPill';
import { deleteArtwork } from '../../../utils/podArtwork';
import { getProfileById } from '../../../config/podProfiles';
import { slotOf, slotLabel } from '../../../config/podSlots';
import { functions } from '../../../firebase/config';
import { tierTone, tierLabel } from './podTier';
import ArtworkUploadModal from './ArtworkUploadModal';

const formatBytes = (b) => (b ? `${(b / 1024 / 1024).toFixed(1)} MB` : '');

// Data comes from the shared usePodLibrary load (lifted to PodAdminPage) so the
// mapped/unmapped chips + the page banner all agree from a single fetch.
const ArtworkLibrary = ({
  shopId,
  artwork = [],
  profiles = [],
  products = [],
  mappings = [],
  loading = false,
  onChanged,
  onMapArtwork,
}) => {
  const [uploadOpen, setUploadOpen] = useState(false);
  // When set, the upload modal opens in REPLACE mode for this artwork (profile
  // locked, updates the doc in place → all products + queue orders get the new file).
  const [replaceTarget, setReplaceTarget] = useState(null);
  const [revalidatingIds, setRevalidatingIds] = useState(() => new Set()); // artworkIds in flight
  const [bulkProgress, setBulkProgress] = useState(null); // { done, total } during Validera alla
  const items = artwork;

  const refresh = () => onChanged?.();

  // LEGACY docs (no status field) predate the 2026-07-27 gate pipeline: they were
  // validated against the old advisory thresholds and have no print PNG — the
  // printer would get the raw original. "Validera om" runs them through the
  // server pipeline (trim + PNG + authoritative gate) and stamps ready/rejected.
  // Each row is independent — validating one never locks the others.
  const revalidateOne = async (art) => {
    const call = httpsCallable(functions, 'processPodArtwork');
    const { data: result } = await call({ shopId, artworkId: art.id });
    return result;
  };

  const markRevalidating = (id, on) => {
    setRevalidatingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  };

  const handleRevalidate = async (art) => {
    if (revalidatingIds.has(art.id)) return;
    markRevalidating(art.id, true);
    try {
      const result = await revalidateOne(art);
      if (result?.ok) toast.success(`Godkänd — tryckfil (PNG) skapad (${art.label || art.fileName})`);
      else toast.error(result?.reasons?.[0]?.message || 'Filen godkändes inte mot de nya kraven.');
      refresh();
    } catch (e) {
      // httpsCallable surfaces uncaught server crashes as the bare string
      // "internal" — translate it instead of showing a raw error code.
      const msg = e?.message === 'internal'
        ? 'Filen kunde inte bearbetas på servern — försök igen om en stund.'
        : (e?.message || 'Kunde inte validera om.');
      toast.error(msg);
    } finally {
      markRevalidating(art.id, false);
    }
  };

  // Bulk: run every LEGACY item (no status yet) through the pipeline SEQUENTIALLY
  // (each call decodes a full-res image server-side — no reason to stampede the
  // function), with live progress on the button and one summary toast at the end.
  // Already-rejected items are excluded: same bytes give the same verdict — the
  // per-row button remains for deliberate retries.
  const pendingItems = items.filter((a) => a.status == null);
  const handleRevalidateAll = async () => {
    if (bulkProgress || pendingItems.length === 0) return;
    setBulkProgress({ done: 0, total: pendingItems.length });
    let ok = 0;
    let failed = 0;
    for (const art of pendingItems) {
      markRevalidating(art.id, true);
      try {
        const result = await revalidateOne(art);
        if (result?.ok) ok++; else failed++;
      } catch {
        failed++;
      } finally {
        markRevalidating(art.id, false);
        setBulkProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    }
    setBulkProgress(null);
    refresh();
    if (failed === 0) toast.success(`${ok} original godkända — tryckfiler (PNG) skapade`);
    else toast(`${ok} godkända · ${failed} underkända — se raderna för orsak`, { icon: '⚠️' });
  };

  // Map artworkId → the SKU+slot pills that reference it (built once from the shared
  // mappings). MULTI-PLACEMENT: a SKU may appear per slot, so the pill carries the
  // slot too ("north-01 · Rygg"). Missing placementSlot → 'front' (Bröst).
  const pillsByArtwork = React.useMemo(() => {
    const m = new Map();
    mappings.forEach((mp) => {
      if (!mp.artworkId || !mp.sku) return;
      const arr = m.get(mp.artworkId) || [];
      arr.push({ sku: mp.sku, slot: slotOf(mp), id: mp.id });
      m.set(mp.artworkId, arr);
    });
    return m;
  }, [mappings]);

  const handleDelete = async (art) => {
    if (!window.confirm(`Ta bort "${art.label || art.fileName}"?`)) return;
    try {
      await deleteArtwork(art, shopId);
      toast.success('Original borttaget');
      refresh();
    } catch (e) {
      // Soft guard: mapped artwork can't be deleted until the mapping is removed.
      toast.error(e?.message || 'Kunde inte ta bort originalet.');
    }
  };

  const purposeLabel = (id) => getProfileById(profiles, id)?.label || id;

  return (
    <CardSection
      title="Original"
      actions={
        <div className="flex items-center gap-2">
          {pendingItems.length > 0 && (
            <Button variant="secondary" onClick={handleRevalidateAll} disabled={!!bulkProgress}>
              {bulkProgress ? `Validerar ${bulkProgress.done + 1}/${bulkProgress.total}…` : `Validera om alla (${pendingItems.length})`}
            </Button>
          )}
          <Button variant="primary" onClick={() => setUploadOpen(true)}>Ladda upp original</Button>
        </div>
      }
    >
      {loading ? (
        <p className="text-[13px] text-admin-text-muted">Laddar…</p>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-admin-text-muted">
          Inga original ännu. Ladda upp en tryckfärdig fil för att börja.
        </p>
      ) : (
        <ul className="divide-y divide-admin-border-soft">
          {items.map((art) => {
            const mappedPills = pillsByArtwork.get(art.id) || [];
            const isMapped = mappedPills.length > 0;
            return (
            <li key={art.id} className="flex items-center gap-3 py-2.5">
              {/* thumbnail (preview is null for PDF/SVG/TIFF → placeholder) */}
              {art.previewUrl ? (
                <img src={art.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded-[6px] border border-admin-border object-cover" />
              ) : (
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[6px] border border-admin-border bg-admin-surface-2 text-admin-text-faint">
                  <PhotoIcon className="h-5 w-5" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-admin-text">{art.label || art.fileName}</span>
                  {art.status === 'ready' ? (
                    <StatusPill tone={tierTone('PASS')}>{tierLabel('PASS')}</StatusPill>
                  ) : art.status === 'rejected' ? (
                    <StatusPill tone={tierTone('FAIL')}>{tierLabel('FAIL')}</StatusPill>
                  ) : (
                    <span className="inline-flex items-center rounded-full border border-admin-caution-dot/30 bg-admin-caution-bg px-2 py-0.5 text-[11px] font-medium text-admin-caution-text">
                      Ej omvaliderad
                    </span>
                  )}
                  {art.validation?.notices?.some((n) => n.code === 'opaque') && (
                    <span className="inline-flex items-center rounded-full border border-admin-border-soft bg-admin-surface-2 px-2 py-0.5 text-[11px] text-admin-text-muted" title="Hela rektangeln trycks, inklusive ev. vit bakgrund">
                      Ej transparent
                    </span>
                  )}
                  {isMapped ? (
                    mappedPills.map((p) => (
                      <span key={p.id || `${p.sku}-${p.slot}`} className="inline-flex items-center rounded-full border border-admin-border-soft bg-admin-surface-2 px-2 py-0.5 font-mono text-[11px] text-admin-text-muted">
                        {p.sku} · {slotLabel(p.slot)}
                      </span>
                    ))
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-admin-caution-dot/30 bg-admin-caution-bg px-2 py-0.5 text-[11px] font-medium text-admin-caution-text">
                      <ExclamationTriangleIcon className="h-3 w-3" /> Inte kopplad till produkt
                    </span>
                  )}
                </div>
                <div className="truncate text-[12px] text-admin-text-faint">
                  {purposeLabel(art.purpose)}
                  {art.sourceWidthPx ? ` · ${art.sourceWidthPx}×${art.sourceHeightPx} px` : ''}
                  {art.validation?.effectiveDpi != null ? ` · ${art.validation.effectiveDpi} DPI` : ''}
                  {art.ext ? ` · ${art.ext.toUpperCase()}` : ''}
                  {art.fileSizeBytes ? ` · ${formatBytes(art.fileSizeBytes)}` : ''}
                </div>
                {art.status === 'rejected' && art.validation?.reasons?.[0] && (
                  <p className="mt-0.5 text-[12px] text-admin-critical-text">{art.validation.reasons[0].message}</p>
                )}
              </div>
              {art.status !== 'ready' && (
                <button
                  onClick={() => handleRevalidate(art)}
                  disabled={revalidatingIds.has(art.id) || !!bulkProgress}
                  className="shrink-0 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2.5 py-1 text-[12px] font-medium text-admin-text hover:bg-admin-surface-2 disabled:opacity-50"
                  title="Kör filen genom den nya tryckpipelinen (PNG + 300 DPI-krav)"
                >
                  {revalidatingIds.has(art.id) ? 'Validerar…' : 'Validera om'}
                </button>
              )}
              {!isMapped && onMapArtwork && (
                <button
                  onClick={() => onMapArtwork(art.id)}
                  className="shrink-0 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2.5 py-1 text-[12px] font-medium text-admin-text hover:bg-admin-surface-2"
                >
                  Koppla…
                </button>
              )}
              <button
                onClick={() => setReplaceTarget(art)}
                className="shrink-0 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2.5 py-1 text-[12px] font-medium text-admin-text hover:bg-admin-surface-2"
                title="Byt ut filen men behåll alla kopplingar"
              >
                Ersätt fil
              </button>
              <a
                href={art.printUrl || art.originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-[12px] text-admin-text-muted underline hover:text-admin-text"
                title={art.printUrl ? 'Den konverterade tryckfilen (PNG) som tryckeriet får' : 'Originalfilen (ingen tryckfil skapad ännu)'}
              >
                {art.printUrl ? 'Tryckfil' : 'Original'}
              </a>
              <button
                onClick={() => handleDelete(art)}
                title="Ta bort"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-critical-dot"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </li>
            );
          })}
        </ul>
      )}

      {uploadOpen && (
        <ArtworkUploadModal
          shopId={shopId}
          products={products}
          artwork={items}
          onClose={() => setUploadOpen(false)}
          onCreated={refresh}
        />
      )}

      {replaceTarget && (
        <ArtworkUploadModal
          shopId={shopId}
          products={products}
          artwork={items}
          replaceTarget={replaceTarget}
          onClose={() => setReplaceTarget(null)}
          onCreated={refresh}
        />
      )}
    </CardSection>
  );
};

export default ArtworkLibrary;
