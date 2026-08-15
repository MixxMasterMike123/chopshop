// PlatformAddons — the operator console's per-shop ADD-ON control (P4.5).
// Each shop × each add-on is a toggle writing shops/{id}.features.<key>. This is
// the ONLY place add-ons are enabled/disabled (platform-only control); the shop
// admin can no longer toggle them. Read app-wide via useShopFeatures().
// Default-ON: a missing flag shows as ON (shops predating the `features` field have no
// features field and keeps every add-on until an operator turns one off).
// Mirrors PlatformShops' toggleStatus kill-switch write shape exactly.
// (docs/ADDONS_PLATFORM_CONTROL_PLAN.md)
import React, { useState, useEffect, useCallback } from 'react';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase/config';
import PlatformLayout from '../../components/platform/PlatformLayout';
import { ADDON_CATALOG, isFeatureEnabled } from '../../config/addons';
import toast from 'react-hot-toast';
import { BuildingStorefrontIcon, PuzzlePieceIcon } from '@heroicons/react/24/outline';

const PlatformAddons = () => {
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingCell, setSavingCell] = useState(null); // `${shopId}:${key}` while writing

  const loadShops = useCallback(async () => {
    try {
      setLoading(true);
      const snap = await getDocs(collection(db, 'shops'));
      const base = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      base.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
      setShops(base);
    } catch (e) {
      console.error('Error loading shops:', e);
      toast.error('Kunde inte ladda butiker');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadShops();
  }, [loadShops]);

  // Toggle one add-on for one shop. Writes the dot-path features.<key> so other
  // feature flags on the doc are untouched — same merge semantics the rest of
  // the app relies on. Optimistic local update + revert on error.
  const toggleAddon = async (shop, key) => {
    const current = isFeatureEnabled(shop.features, key);
    const next = !current;
    const cell = `${shop.id}:${key}`;
    try {
      setSavingCell(cell);
      await updateDoc(doc(db, 'shops', shop.id), { [`features.${key}`]: next });
      setShops((prev) =>
        prev.map((s) =>
          s.id === shop.id ? { ...s, features: { ...(s.features || {}), [key]: next } } : s
        )
      );
    } catch (e) {
      console.error('Error toggling add-on:', e);
      toast.error('Kunde inte ändra tillägg');
    } finally {
      setSavingCell(null);
    }
  };

  return (
    <PlatformLayout>
      <div className="px-6 lg:px-10 py-8 max-w-6xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white">Tillägg</h1>
          <p className="text-gray-400 mt-1">
            Aktivera eller inaktivera tillägg per butik. Standard är på — ett tillägg är aktivt tills det stängs av här.
          </p>
        </div>

        {loading ? (
          <div className="py-16 text-center text-gray-500">Laddar…</div>
        ) : shops.length === 0 ? (
          <div className="py-16 text-center text-gray-500">
            <BuildingStorefrontIcon className="h-10 w-10 mx-auto mb-3 text-gray-700" />
            Inga butiker ännu.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10 bg-gray-900">
            <table className="min-w-full divide-y divide-white/10 text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-5 py-3">Butik</th>
                  {ADDON_CATALOG.map((addon) => (
                    <th key={addon.key} className="px-4 py-3 text-center" title={addon.description}>
                      {addon.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {shops.map((shop) => (
                  <tr key={shop.id} className="hover:bg-white/5">
                    <td className="px-5 py-4">
                      <div className="font-medium text-white">{shop.name || shop.id}</div>
                      <div className="text-xs text-gray-500">{shop.id}</div>
                    </td>
                    {ADDON_CATALOG.map((addon) => {
                      const on = isFeatureEnabled(shop.features, addon.key);
                      const saving = savingCell === `${shop.id}:${addon.key}`;
                      return (
                        <td key={addon.key} className="px-4 py-4 text-center">
                          <button
                            type="button"
                            onClick={() => toggleAddon(shop, addon.key)}
                            disabled={saving}
                            role="switch"
                            aria-checked={on}
                            aria-label={`${addon.label} för ${shop.name || shop.id}`}
                            title={on ? 'Aktiv — klicka för att inaktivera' : 'Inaktiv — klicka för att aktivera'}
                            className={
                              'relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ' +
                              (on ? 'bg-green-600' : 'bg-white/10')
                            }
                          >
                            <span
                              className={
                                'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ' +
                                (on ? 'translate-x-5' : 'translate-x-1')
                              }
                            />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-6 flex items-start gap-2 text-xs text-gray-600">
          <PuzzlePieceIcon className="h-4 w-4 shrink-0 mt-0.5" />
          <p>
            Tillägg styrs endast härifrån (plattformsnivå). Affiliate visas här men dess full­ständiga gating
            (storefront + kassan + funktioner) aktiveras i ett kommande steg.
          </p>
        </div>
      </div>
    </PlatformLayout>
  );
};

export default PlatformAddons;
