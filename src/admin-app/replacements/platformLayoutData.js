// src/components/platform/platformLayoutData.js for the admin build (alias
// list, vite.admin.config.js): what the console shell shows on Cloudflare.
//
//   the menu      the launch scope (CP5_GAP_ANALYSIS.md §1b, D103): the DAC7
//                 and leads pages left the build, so their entries leave; the
//                 "snart" placeholders stay as they were. 3D-modeller is back
//                 (unit CP5-FO: the page on the Worker's 3D-model routes).
//                 Inställningar is live (unit CP5-FL: the settings, the brand
//                 filter and the terms versions); Betalningar stays "snart".
//                 Tryckjobb is added after Tryckerier (unit CP5-FP: the print
//                 jobs and their production status)
//   the badge     GET /v1/platform/reports?status=new → `newCount` (every
//                 shop's unhandled reports), per mount and on the badge event
//   the notices   an acting-as session that ended in this tab (ran out, or
//                 "Avsluta") is said once when the console opens

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { QueueListIcon } from '@heroicons/react/24/outline';
import { platformRequest } from '../../api/admin/client.js';
import { actingAsNoticeText, takeActingAsNotice } from './impersonationAudit.js';

/** Console paths that leave this build, with why (the CP5-FB report lists them). */
export const LEFT_PLATFORM_PATHS = Object.freeze({
  '/dac7': 'DAC7 is CP9 (D23); the page left the build',
  '/leads': 'the leads page leaves (D103)',
});

/** Console paths the shell marks "snart" whose page this build has (unit CP5-FL). */
export const LIVE_PLATFORM_PATHS = Object.freeze(['/settings']);

/** Console entries this build adds, each after the entry it follows (unit CP5-FP). */
export const ADDED_PLATFORM_LINKS = Object.freeze([
  { after: '/printers', link: { name: 'Tryckjobb', path: '/print-jobs', icon: QueueListIcon, live: true } },
]);

export function scopePlatformNav(nav) {
  return nav
    .filter((item) => !Object.hasOwn(LEFT_PLATFORM_PATHS, item.path))
    .map((item) => (LIVE_PLATFORM_PATHS.includes(item.path) ? { ...item, live: true } : item))
    .flatMap((item) => [item, ...ADDED_PLATFORM_LINKS.filter((a) => a.after === item.path).map((a) => a.link)]);
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
