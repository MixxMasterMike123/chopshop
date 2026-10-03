// A stand-in for an admin or platform page that still reads from Firebase.
// Its route exists (so the router, the guards, the providers and the client
// are proven end to end); it shows the page's name, the active shop and the
// signed-in user. A unit swaps the page in by its ONE line of pages.jsx.

import React from 'react';
import { useAuth } from './providers/Session.jsx';
import { useShopId } from './providers/ActiveShop.jsx';

export function pending(name) {
  function Pending() {
    const { currentUser } = useAuth();
    const shopId = useShopId();
    return (
      <main
        className="min-h-screen bg-admin-bg text-admin-text flex items-center justify-center p-8"
        data-pending-page={name}
      >
        <p className="text-sm text-admin-text-muted">
          {name} · {shopId} · {currentUser?.email}
        </p>
      </main>
    );
  }
  Pending.displayName = `Pending(${name})`;
  return Pending;
}

/** The platform console's stand-in: the console is always dark and untokenized (DESIGN_CONTRACT §1.3). */
export function pendingPlatform(name) {
  function PendingPlatform() {
    const { currentUser } = useAuth();
    return (
      <main
        className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-8"
        data-pending-page={name}
      >
        <p className="text-sm text-gray-400">
          {name} · {currentUser?.email}
        </p>
      </main>
    );
  }
  PendingPlatform.displayName = `Pending(${name})`;
  return PendingPlatform;
}
