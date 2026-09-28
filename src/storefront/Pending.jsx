// A stand-in for a storefront page that still reads from Firebase. Every page
// under src/pages/shop imports the Firebase SDK today, so none of them can be
// part of the Cloudflare build until builder F swaps its data layer; until
// then its address renders this, which proves the router, the providers and
// the API client end to end (it shows the shop's name from the API).

import React from 'react';
import { useStoreSettings } from './providers/StoreSettings.jsx';
import { useStorefront } from './providers/Storefront.jsx';

export function pending(name) {
  function Pending() {
    const settings = useStoreSettings();
    const { status } = useStorefront();
    return (
      <main
        className="min-h-screen bg-canvas text-ink font-body flex items-center justify-center p-8"
        data-pending-page={name}
      >
        <p className="text-sm text-ink-muted">
          {settings.shopName} · {name} · {status}
        </p>
      </main>
    );
  }
  Pending.displayName = `Pending(${name})`;
  return Pending;
}

/** The gate's stand-in: the shop's not-found page when the API has no such shop. */
export function pendingGate(NotFound) {
  function PendingGate({ children }) {
    const { status } = useStorefront();
    return status === 'not_found' || status === 'no_shop' ? <NotFound /> : children;
  }
  PendingGate.displayName = 'Pending(ShopGate)';
  return PendingGate;
}
