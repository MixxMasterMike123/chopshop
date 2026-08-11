// PrintShopArtwork — the printer's artwork library (2026-08-11, Mikael request):
// every original the assigned shops have uploaded, for re-download and
// printability checks OUTSIDE the order flow. Calls getPrintArtworkLibrary
// (field-minimized list; NO direct DB access) and mints short-lived download
// links per file via getPrintArtworkDownload. Dark print-portal surface.
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import { httpsCallable } from 'firebase/functions';
import { PhotoIcon, ArrowDownTrayIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { functions } from '../../firebase/config';
import PrintShopLayout from '../../components/print/PrintShopLayout';

const fmtDate = (iso) => { try { return iso ? new Date(iso).toLocaleDateString('sv-SE') : ''; } catch { return iso || ''; } };

// Validation verdict chips (advisory tiers from podValidation, dark surface).
const TIER_CHIP = {
  pass: { label: 'Godkänd', cls: 'bg-emerald-500/15 text-emerald-300' },
  warn: { label: 'Varning', cls: 'bg-amber-500/15 text-amber-300' },
  fail: { label: 'Underkänd', cls: 'bg-red-500/15 text-red-300' },
};
const tierChip = (tier) => TIER_CHIP[String(tier || '').toLowerCase()] || null;

const PrintShopArtwork = () => {
  const [artworks, setArtworks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shopFilter, setShopFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [downloading, setDownloading] = useState(null); // `${id}:${kind}` in flight

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const call = httpsCallable(functions, 'getPrintArtworkLibrary');
      const res = await call();
      setArtworks(res.data?.artworks || []);
    } catch (e) {
      console.error('getPrintArtworkLibrary failed', e);
      setError(e?.message || 'Kunde inte hämta originalen.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const shops = useMemo(() => {
    const seen = new Map();
    artworks.forEach((a) => { if (!seen.has(a.shopId)) seen.set(a.shopId, a.shopName); });
    return [...seen.entries()].sort((x, y) => x[1].localeCompare(y[1], 'sv'));
  }, [artworks]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return artworks.filter((a) =>
      (shopFilter === 'all' || a.shopId === shopFilter) &&
      (!q || `${a.label} ${a.fileName}`.toLowerCase().includes(q)));
  }, [artworks, shopFilter, search]);

  // Mint a short-lived link and open it — links are per-click on purpose
  // (nothing long-lived to leak); kind 'print' = the gate-verified PNG.
  const download = async (art, kind) => {
    const key = `${art.id}:${kind}`;
    setDownloading(key);
    try {
      const call = httpsCallable(functions, 'getPrintArtworkDownload');
      const res = await call({ artworkId: art.id, kind });
      const url = res.data?.url;
      if (!url) throw new Error('Ingen länk');
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      console.error('getPrintArtworkDownload failed', e);
      toast.error(e?.message || 'Nedladdningen misslyckades.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <PrintShopLayout>
      <div className="px-6 py-8 lg:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Original</h1>
            <p className="mt-1 text-sm text-gray-400">
              Alla uppladdade original från dina tilldelade butiker — för nedladdning och tryckbarhetskontroll.
            </p>
          </div>
          <button
            onClick={load}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 hover:text-white"
          >
            <ArrowPathIcon className="h-4 w-4" /> Uppdatera
          </button>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {shops.length > 1 && (
            <select
              value={shopFilter}
              onChange={(e) => setShopFilter(e.target.value)}
              aria-label="Butik"
              className="rounded-lg border border-white/10 bg-gray-900 px-3 py-2 text-sm text-gray-200 focus:border-indigo-400 focus:outline-none"
            >
              <option value="all">Alla butiker</option>
              {shops.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Sök på namn…"
            aria-label="Sök original"
            className="w-64 max-w-full rounded-lg border border-white/10 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-500 focus:border-indigo-400 focus:outline-none"
          />
          {!loading && (
            <span className="text-sm text-gray-500">{visible.length} original</span>
          )}
        </div>

        {error && (
          <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
        )}

        {loading ? (
          <p className="mt-10 text-sm text-gray-400">Laddar original…</p>
        ) : visible.length === 0 ? (
          <p className="mt-10 text-sm text-gray-400">Inga original {search || shopFilter !== 'all' ? 'matchar filtret' : 'ännu'}.</p>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.map((a) => {
              const chip = tierChip(a.tier);
              return (
                <div key={a.id} className="flex flex-col overflow-hidden rounded-xl border border-white/10 bg-gray-900">
                  <div className="grid aspect-square place-items-center overflow-hidden bg-[conic-gradient(#1f2430_25%,#171b25_0_50%,#1f2430_0_75%,#171b25_0)] bg-[length:16px_16px]">
                    {a.previewUrl ? (
                      <img src={a.previewUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" />
                    ) : (
                      <PhotoIcon className="h-10 w-10 text-gray-600" />
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5 p-3">
                    <div className="truncate text-sm font-medium text-gray-100" title={a.label || a.fileName}>
                      {a.label || a.fileName}
                    </div>
                    <div className="truncate text-xs text-gray-500">
                      {a.shopName} · {fmtDate(a.createdAt)}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      {chip && <span className={`rounded-full px-2 py-0.5 font-medium ${chip.cls}`}>{chip.label}</span>}
                      {a.hasPrintFile && (
                        <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 font-medium text-indigo-300">Tryckfil ✓</span>
                      )}
                      {a.widthPx && a.heightPx && (
                        <span className="text-gray-500">{a.widthPx}×{a.heightPx}px{a.ext ? ` · ${a.ext}` : ''}</span>
                      )}
                    </div>
                    <div className="mt-auto flex gap-2 pt-2">
                      {a.hasPrintFile && (
                        <button
                          onClick={() => download(a, 'print')}
                          disabled={downloading === `${a.id}:print`}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-indigo-500/20 px-2 py-1.5 text-xs font-medium text-indigo-200 hover:bg-indigo-500/30 disabled:opacity-50"
                        >
                          <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                          {downloading === `${a.id}:print` ? 'Hämtar…' : 'Tryckfil'}
                        </button>
                      )}
                      <button
                        onClick={() => download(a, 'original')}
                        disabled={downloading === `${a.id}:original`}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2 py-1.5 text-xs text-gray-300 hover:bg-white/5 hover:text-white disabled:opacity-50"
                      >
                        <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                        {downloading === `${a.id}:original` ? 'Hämtar…' : 'Original'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PrintShopLayout>
  );
};

export default PrintShopArtwork;
