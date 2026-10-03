// A stand-in for an admin or platform page that still reads from Firebase.
// Its route exists (so the router, the guards, the providers and the client
// are proven end to end); it shows the page's name, the active shop and the
// signed-in user, inside the shell its page mounts (AppLayout for the admin,
// PlatformLayout for the console: unit FB), so the shells can be looked at
// before every page is swapped. A unit swaps the page in by its ONE line of
// pages.jsx.

import React from 'react';
import AppLayout from '../components/layout/AppLayout';
import PlatformLayout from '../components/platform/PlatformLayout';
import { useAuth } from './providers/Session.jsx';
import { useShopId } from './providers/ActiveShop.jsx';

export function pending(name) {
  function Pending() {
    const { currentUser } = useAuth();
    const shopId = useShopId();
    return (
      <AppLayout>
        <div className="py-16 text-center" data-pending-page={name}>
          <p className="text-sm text-admin-text-muted">
            {name} · {shopId} · {currentUser?.email}
          </p>
        </div>
      </AppLayout>
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
      <PlatformLayout>
        <div className="px-6 lg:px-10 py-16 text-center" data-pending-page={name}>
          <p className="text-sm text-gray-400">
            {name} · {currentUser?.email}
          </p>
        </div>
      </PlatformLayout>
    );
  }
  PendingPlatform.displayName = `Pending(${name})`;
  return PendingPlatform;
}
