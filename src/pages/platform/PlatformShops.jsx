// PlatformShops — the operator console HOME: the tenant fleet table.
// Lists every shop with status + counts, and the highest-value ops:
// Open Storefront, kill-switch (status), Open Shop Admin (stubbed until the
// audited-impersonation slice P4.3). Platform-only. (docs/PLATFORM_ARCHITECTURE.md)
import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { COUNT_COLUMNS, PUBLISH_COPY, SHOW_COUNTS, loadShops as readShops, openStorefront, setShopStatus } from './platformShopsData';
import PlatformLayout from '../../components/platform/PlatformLayout';
import ProvisionShopModal from '../../components/platform/ProvisionShopModal';
import ImpersonateShopModal from '../../components/platform/ImpersonateShopModal';
import toast from 'react-hot-toast';
import {
  BuildingStorefrontIcon,
  ArrowTopRightOnSquareIcon,
  UserCircleIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';

const PlatformShops = () => {
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [showProvision, setShowProvision] = useState(false);
  const [impersonateShop, setImpersonateShop] = useState(null);

  // The two most-used per-shop actions live on the list row (quick access);
  // the rest stay on the detail page.
  const loadShops = useCallback(async () => {
    try {
      setLoading(true);
      setShops(await readShops());
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

  const toggleStatus = async (shop) => {
    const next = shop.status === 'disabled' ? 'active' : 'disabled';
    const verb = next === 'disabled' ? 'inaktivera' : 'aktivera';
    if (!window.confirm(`Vill du ${verb} "${shop.name || shop.id}"?`)) return;
    try {
      setSavingId(shop.id);
      await setShopStatus(shop, next);
      setShops((prev) => prev.map((s) => (s.id === shop.id ? { ...s, status: next } : s)));
      toast.success(`"${shop.name || shop.id}" ${next === 'disabled' ? 'inaktiverad' : 'aktiverad'}`);
    } catch (e) {
      console.error('Error toggling status:', e);
      toast.error('Kunde inte ändra status');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <PlatformLayout>
      <div className="px-6 lg:px-10 py-8 max-w-[1600px]">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Butiker</h1>
            <p className="text-gray-400 mt-1">Alla butiker på plattformen.</p>
          </div>
          <button
            onClick={() => setShowProvision(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            <PlusIcon className="h-4 w-4" />
            Ny butik
          </button>
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
                  <th className="px-4 py-3">Butik</th>
                  <th className="px-4 py-3">{PUBLISH_COPY.column}</th>
                  <th className="px-4 py-3">Status</th>
                  {SHOW_COUNTS && COUNT_COLUMNS.map((c) => <th key={c.key} title={c.title} className="px-3 py-3 text-right">{c.label}</th>)}
                  <th className="px-4 py-3 text-right">Åtgärder</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {shops.map((shop) => {
                  const disabled = shop.status === 'disabled';
                  // Indexing gate: only an explicit published===false hides the shop
                  // from search engines; missing/true = searchable (backward-compat
                  // with pre-existing shops that have no field). Store is open either way.
                  const isSearchable = shop.published !== false;
                  return (
                    <tr key={shop.id} className="hover:bg-white/5">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{shop.name || shop.id}</div>
                        <div className="text-xs text-gray-500">{shop.id}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          title={isSearchable ? PUBLISH_COPY.titleOn : PUBLISH_COPY.titleOff}
                          className={
                            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ' +
                            (isSearchable ? 'bg-green-500/15 text-green-300' : 'bg-amber-500/15 text-amber-300')
                          }
                        >
                          {isSearchable ? PUBLISH_COPY.badgeOn : PUBLISH_COPY.badgeOff}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ' +
                            (disabled ? 'bg-red-500/15 text-red-300' : 'bg-green-500/15 text-green-300')
                          }
                        >
                          {disabled ? 'Inaktiverad' : 'Aktiv'}
                        </span>
                      </td>
                      {SHOW_COUNTS && COUNT_COLUMNS.map((c) => <td key={c.key} className="px-3 py-3 text-right tabular-nums text-gray-300">{shop.counts?.[c.key] ?? '–'}</td>)}
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                          <button
                            onClick={() => openStorefront(shop)}
                            title="Öppna butikens storefront"
                            className="inline-flex items-center rounded-lg p-1.5 text-gray-300 hover:bg-white/10 hover:text-white"
                          >
                            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setImpersonateShop(shop)}
                            disabled={disabled}
                            title={disabled ? 'Butiken är inaktiverad — aktivera först' : 'Öppna butikens admin som plattformsadmin (loggas)'}
                            className={
                              'inline-flex items-center rounded-lg p-1.5 ' +
                              (disabled
                                ? 'text-gray-600 cursor-not-allowed'
                                : 'text-gray-300 hover:bg-amber-500/15 hover:text-amber-300')
                            }
                          >
                            <UserCircleIcon className="h-4 w-4" />
                          </button>
                          <Link
                            to={`/shops/${shop.id}`}
                            title="Öppna butikens detaljsida"
                            className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium bg-white/5 text-gray-200 hover:bg-white/10"
                          >
                            Öppna
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-6 text-xs text-gray-600">
          Nästa steg: fakturering.
        </p>
      </div>

      {showProvision && (
        <ProvisionShopModal
          onClose={() => setShowProvision(false)}
          onCreated={loadShops}
        />
      )}

      {impersonateShop && (
        <ImpersonateShopModal
          shop={impersonateShop}
          onClose={() => setImpersonateShop(null)}
        />
      )}
    </PlatformLayout>
  );
};

export default PlatformShops;
