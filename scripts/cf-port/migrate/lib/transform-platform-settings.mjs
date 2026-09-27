/**
 * scripts/cf-port/migrate/lib/transform-platform-settings.mjs — manifest row
 * 67: `settings/platform` → `platform_settings`. The document is ABSENT in
 * production (§0 census), so the values are set EXPLICITLY to the defaults
 * the manifest names (§e checklist items 1–3): default_commission_bps = 500,
 * refund_application_fee = false → but 0034 PINS this column to 0 by CHECK
 * (`refund_application_fee = 0`), so this module writes 0 unconditionally and
 * NEVER attempts to write 1 — the brief's "Never touch refund_application_fee"
 * is honoured by simply never including it in the UPDATE's SET list at all;
 * the migration's own DEFAULT/CHECK already pins it. reverse_dispute_on_created
 * = true (1).
 *
 * `settings/app` (row 68) is asserted absent — see assertSettingsAppAbsent.
 */

import { updateStatement } from './sql.mjs';
import { rowContentHash, carriedRow } from './plan.mjs';
import { formatTime } from './time-columns.mjs';

const DEFAULT_COMMISSION_BPS = 500;
const REVERSE_DISPUTE_ON_CREATED = 1;

export function transformPlatformSettings({ nowMillis, platformDoc }) {
  const problems = [];
  if (platformDoc !== null && platformDoc !== undefined) {
    problems.push('settings/platform unexpectedly present in the bundle — the manifest documents it as absent in production; values are still set to the pinned defaults, the doc content is ignored');
  }

  const set = {
    default_commission_bps: DEFAULT_COMMISSION_BPS,
    reverse_dispute_on_created: REVERSE_DISPUTE_ON_CREATED,
    updated_at: formatTime('platform_settings', 'updated_at', nowMillis),
  };
  const statement = updateStatement('platform_settings', set, { id: 1 });
  const row = carriedRow('platform_settings', '1:defaults', statement, rowContentHash('platform_settings', ['id', ...Object.keys(set)], { id: 1, ...set }));

  return { problems, report: { defaultCommissionBps: DEFAULT_COMMISSION_BPS, reverseDisputeOnCreated: true }, rows: [row] };
}

/** Row 68: `settings/app` — assert absent, write nothing (n/a fate). */
export function assertSettingsAppAbsent({ appDoc }) {
  if (appDoc !== null && appDoc !== undefined) {
    return { ok: false, problem: 'settings/app is present in the bundle — the manifest documents it as always absent; nothing is imported for it regardless (the fallback seam it fed is deleted with the SDK)' };
  }
  return { ok: true, problem: null };
}
