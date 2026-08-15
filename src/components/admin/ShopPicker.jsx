// ShopPicker — the admin surface's answer to "no shop resolved".
//
// Replaces the old b8shield default fallback (removed 2026-08-15). A platform
// operator's /admin/* URL carries no shop and they have no own shopId, so the
// context used to resolve SILENTLY to b8shield — the operator would edit a
// tenant the UI never named. That is the seam behind the Kent wrong-shop Connect
// binding. Now an unresolved context renders this: an explicit, deliberate
// choice, remembered for next time (config/activeShop last-picked).
//
// Platform-operator UI only. A real shop admin always resolves to their own
// users/{uid}.shopId and never sees this. Choosing a shop here is NOT an
// authorization step — the Firestore/Storage rules remain the hard gate
// (isPlatform bypasses scoping); this only decides which tenant the admin UI
// renders, and says so out loud in the top bar afterwards.
import React, { useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { setDeepLinkShopId, setLastPickedShopId } from '../../config/activeShop';
import { BuildingStorefrontIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

const ShopPicker = ({ onLogout }) => {
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'shops'));
        if (cancelled) return;
        const list = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
        setShops(list);
      } catch (e) {
        console.error('ShopPicker: could not load shops:', e);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Publishing the pick re-renders ShopProvider through its external store, so
  // the admin surface swaps to the chosen tenant in place — no reload needed.
  const pick = (shopId) => {
    setDeepLinkShopId(null);
    setLastPickedShopId(shopId);
  };

  return (
    <div className="min-h-screen bg-admin-bg px-4 py-12">
      <div className="mx-auto max-w-lg">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-[var(--radius-admin)] bg-admin-surface text-admin-text-muted ring-1 ring-admin-border">
            <BuildingStorefrontIcon className="h-6 w-6" aria-hidden="true" />
          </span>
          <h1 className="text-[19px] font-semibold text-admin-text">Välj butik</h1>
          <p className="mt-1 text-[13px] text-admin-text-muted">
            Du är inloggad som plattformsadmin. Välj vilken butik du vill administrera.
          </p>
        </div>

        <div className="overflow-hidden rounded-[var(--radius-admin)] bg-admin-surface ring-1 ring-admin-border">
          {loading && (
            <p className="px-4 py-8 text-center text-[13px] text-admin-text-muted">Laddar butiker…</p>
          )}

          {!loading && error && (
            <div className="flex items-start gap-3 px-4 py-6">
              <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-admin-critical-dot" aria-hidden="true" />
              <p className="text-[13px] text-admin-text">
                Kunde inte hämta butikerna. Ladda om sidan och försök igen.
              </p>
            </div>
          )}

          {!loading && !error && shops.length === 0 && (
            <p className="px-4 py-8 text-center text-[13px] text-admin-text-muted">
              Inga butiker finns ännu. Skapa en i plattformskonsolen.
            </p>
          )}

          {!loading && !error && shops.map((shop, i) => (
            <button
              key={shop.id}
              onClick={() => pick(shop.id)}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-admin-surface-3 ${
                i > 0 ? 'border-t border-admin-border-soft' : ''
              }`}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-admin-el)] bg-admin-surface-2 text-[12px] font-semibold text-admin-text-muted">
                {(shop.name || shop.id).slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-admin-text">
                  {shop.name || shop.id}
                </span>
                <span className="block truncate font-mono text-[11px] text-admin-text-faint">{shop.id}</span>
              </span>
              {shop.status === 'disabled' && (
                <span className="shrink-0 rounded-full bg-admin-neutral-bg px-2 py-0.5 text-[11px] font-medium text-admin-neutral-text">
                  Pausad
                </span>
              )}
            </button>
          ))}
        </div>

        <p className="mt-4 text-center text-[12px] text-admin-text-faint">
          Valet sparas i den här webbläsaren. Du kan byta butik när som helst från butiksväljaren uppe till höger.
        </p>

        {onLogout && (
          <p className="mt-2 text-center">
            <button
              onClick={onLogout}
              className="text-[12px] text-admin-text-muted underline underline-offset-2 hover:text-admin-text"
            >
              Logga ut
            </button>
          </p>
        )}
      </div>
    </div>
  );
};

export default ShopPicker;
