// The stand-in for PlatformShops until unit FI swaps the real page in (its
// ONE line in pages.jsx). Unlike the other stand-ins it lists the shops
// (GET /v1/platform/tenants) with the one action the shells need end to end:
// "Öppna admin" → ImpersonateShopModal (the acting-as dialog, unit FB). Its
// markup is the console's vocabulary, taken from PlatformShops.jsx (the page
// frame, the table card, the status pill, the impersonate icon button);
// FI replaces this file, it is not a design.

import React, { useEffect, useState } from 'react';
import { UserCircleIcon } from '@heroicons/react/24/outline';
import PlatformLayout from '../components/platform/PlatformLayout';
import ImpersonateShopModal from '../components/platform/ImpersonateShopModal';
import { listTenants } from '../api/admin/actingAs.js';

export default function PendingPlatformShops() {
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [impersonateShop, setImpersonateShop] = useState(null);

  useEffect(() => {
    let alive = true;
    listTenants({ limit: 100 })
      .then(({ tenants }) => {
        if (alive) setShops(tenants.map((t) => ({ id: t.tenantId, name: t.shopName, status: t.status })));
      })
      .catch((e) => console.error('PlatformShops (stand-in): could not load shops', e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PlatformLayout>
      <div className="px-6 lg:px-10 py-8 max-w-[1600px]" data-pending-page="PlatformShops">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white">Butiker</h1>
          <p className="text-gray-400 mt-1">Alla butiker på plattformen.</p>
        </div>

        {loading ? (
          <div className="py-16 text-center text-gray-500">Laddar…</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10 bg-gray-900">
            <table className="min-w-full divide-y divide-white/10 text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-3">Butik</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Åtgärder</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {shops.map((shop) => {
                  const disabled = shop.status !== 'active';
                  return (
                    <tr key={shop.id} className="hover:bg-white/5">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{shop.name || shop.id}</div>
                        <div className="text-xs text-gray-500">{shop.id}</div>
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
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end">
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
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {impersonateShop && (
        <ImpersonateShopModal shop={impersonateShop} onClose={() => setImpersonateShop(null)} />
      )}
    </PlatformLayout>
  );
}
