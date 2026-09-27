/**
 * scripts/cf-port/migrate/lib/transform-pod-profiles.mjs — manifest row 70:
 * `settings/podProfiles` → `pod_profiles` (0012).
 *
 * "The target may already hold a profile with the same id written by the
 * staging seed: with --target-state report the difference per field; do not
 * overwrite." This module therefore only emits statements for profile ids
 * NOT already present in the target (per `targetState.podProfileIds`); an id
 * already present is reported with a per-field diff and no statement is
 * written for it (INSERT would collide on the PRIMARY KEY anyway, but the
 * intent is to never even attempt the overwrite, so the diff is computed
 * proactively rather than relying on the PK to silently no-op via OR IGNORE
 * — OR IGNORE would in fact discard a real field-level difference from view).
 */

import { insertStatement } from './sql.mjs';
import { rowContentHash, carriedRow } from './plan.mjs';
import { formatTime } from './time-columns.mjs';

function diffFields(existing, next) {
  if (!existing) return null;
  const fields = ['label', 'min_dpi', 'print_area_w_mm', 'print_area_h_mm', 'max_file_mb', 'accepted_formats_json'];
  const diffs = [];
  for (const field of fields) {
    if (JSON.stringify(existing[field]) !== JSON.stringify(next[field])) {
      diffs.push({ existing: existing[field], field, next: next[field] });
    }
  }
  return diffs;
}

export function transformPodProfiles({ nowMillis, podProfilesDoc, targetState = null }) {
  const problems = [];
  const rows = [];
  const report = { conflicts: [], imported: [] };

  const data = podProfilesDoc?.data ?? null;
  if (data === null) {
    problems.push('settings/podProfiles is absent from the bundle — nothing imported for row 70');
    return { problems, report, rows };
  }

  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const existingIds = targetState?.podProfileIds instanceof Map ? targetState.podProfileIds : new Map();

  for (const profile of profiles) {
    const id = profile.id;
    if (typeof id !== 'string' || id.length === 0) {
      problems.push(`a profile with no valid id was skipped: ${JSON.stringify(profile).slice(0, 200)}`);
      continue;
    }
    const acceptedFormatsJson = JSON.stringify((profile.accepted_formats ?? []).map((f) => ({ ext: f.ext })));
    const next = {
      accepted_formats_json: acceptedFormatsJson,
      active: 1,
      label: profile.label ?? id,
      max_file_mb: profile.max_file_mb,
      min_dpi: profile.min_dpi,
      print_area_h_mm: profile.print_area_mm?.h,
      print_area_w_mm: profile.print_area_mm?.w,
      profile_id: id,
      sort_order: 0,
    };

    const existing = existingIds.get(id);
    if (existing !== undefined) {
      const diffs = diffFields(existing, next);
      report.conflicts.push({ diffs, profileId: id });
      continue;
    }

    const columns = ['profile_id', 'label', 'min_dpi', 'print_area_w_mm', 'print_area_h_mm', 'max_file_mb', 'accepted_formats_json', 'sort_order', 'active', 'created_at', 'updated_at'];
    const row = { ...next, created_at: formatTime('pod_profiles', 'created_at', nowMillis), updated_at: formatTime('pod_profiles', 'updated_at', nowMillis) };
    rows.push(carriedRow('pod_profiles', id, insertStatement('pod_profiles', columns, row), rowContentHash('pod_profiles', columns, row)));
    report.imported.push(id);
  }

  return { problems, report, rows };
}
