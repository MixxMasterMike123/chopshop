// PlatformLayout's data layer — the OLDER build's implementation (Firebase).
//
// The console shell (PlatformLayout.jsx) reaches its data only through this
// module, so one shell serves two builds: the older build (vite.config.js)
// uses this file as it is; the admin build (vite.admin.config.js) swaps it, by
// its alias list, for src/admin-app/replacements/platformLayoutData.js (the
// API). Both export the same names with the same meaning:
//
//   scopePlatformNav(nav)                 the menu entries this build shows
//   useNavBadgeCounts(override, event)    { reports: <unhandled reports> }
//   usePlatformNotices()                  shows what the console must be told on arrival
//
// The shell's former inline badge read, moved and unchanged.

import { useEffect, useState } from 'react';
import { collection, query, where, getCountFromServer } from 'firebase/firestore';
import { db } from '../../firebase/config';

export function scopePlatformNav(nav) {
  return nav;
}

// Nav badge counts. One aggregation read per layout mount: count of
// infringementReports still status 'new' (a report nobody has looked at).
// A failure just hides the badge — the nav must never break over it.
export const useNavBadgeCounts = (override, badgesEvent) => {
  const [counts, setCounts] = useState({});
  useEffect(() => {
    if (override) return undefined;
    let cancelled = false;
    const load = () => {
      getCountFromServer(query(collection(db, 'infringementReports'), where('status', '==', 'new')))
        .then((agg) => { if (!cancelled) setCounts({ reports: agg.data().count }); })
        .catch(() => {});
    };
    load();
    window.addEventListener(badgesEvent, load);
    return () => { cancelled = true; window.removeEventListener(badgesEvent, load); };
  }, [override, badgesEvent]);
  return override || counts;
};

export function usePlatformNotices() {}
