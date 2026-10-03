// src/components/platform/platformLayoutData.js for the admin build (alias
// list, vite.admin.config.js): what the console shell shows on Cloudflare.
//
//   the menu      the launch scope (CP5_GAP_ANALYSIS.md §1b, D103): the 3D
//                 models, DAC7 and leads pages left the build, so their
//                 entries leave; the "snart" placeholders stay as they were
//   the badge     GET /v1/platform/reports?status=new → `newCount` (every
//                 shop's unhandled reports), per mount and on the badge event
//   the notices   an acting-as session that ended in this tab (ran out, or
//                 "Avsluta") is said once when the console opens

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { platformRequest } from '../../api/admin/client.js';
import { actingAsNoticeText, takeActingAsNotice } from './impersonationAudit.js';

/** Console paths that leave this build, with why (the CP5-FB report lists them). */
export const LEFT_PLATFORM_PATHS = Object.freeze({
  '/models': '3D model tooling is PORT-LATER (PLAN §3.2); the page left the build',
  '/dac7': 'DAC7 is CP9 (D23); the page left the build',
  '/leads': 'the leads page leaves (D103)',
});

export function scopePlatformNav(nav) {
  return nav.filter((item) => !Object.hasOwn(LEFT_PLATFORM_PATHS, item.path));
}

/** The badge counts of a `GET /v1/platform/reports` answer (pure). */
export function badgeCountsOf(data) {
  const n = data?.newCount;
  return Number.isInteger(n) && n >= 0 ? { reports: n } : {};
}

export const useNavBadgeCounts = (override, badgesEvent) => {
  const [counts, setCounts] = useState({});
  useEffect(() => {
    if (override) return undefined;
    let cancelled = false;
    const load = () => {
      platformRequest('GET', '/v1/platform/reports?status=new&limit=1')
        .then(({ data }) => {
          if (!cancelled) setCounts(badgeCountsOf(data));
        })
        .catch(() => {});
    };
    load();
    window.addEventListener(badgesEvent, load);
    return () => {
      cancelled = true;
      window.removeEventListener(badgesEvent, load);
    };
  }, [override, badgesEvent]);
  return override || counts;
};

export function usePlatformNotices() {
  useEffect(() => {
    const text = actingAsNoticeText(takeActingAsNotice());
    if (text) toast(text, { id: 'acting-as-ended', duration: 8000 });
  }, []);
}
