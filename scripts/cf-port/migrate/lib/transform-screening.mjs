/**
 * scripts/cf-port/migrate/lib/transform-screening.mjs — manifest row 72:
 * `settings/contentScreening` → `content_screening_terms` (normalised exactly
 * as the Worker normalises — screening-normalize.mjs, a JS port of
 * screening-core.ts) + the two scalar settings in `platform_settings`, plus
 * the term version bumped by one in the same group of statements (0034,
 * builder D's notes: "screening_terms_version bumped by every change of the
 * screening input that is not product content").
 *
 * `note` is carried verbatim (0034 adds the column, nullable, '' admitted).
 * `blocklist count = source doc` per the go-live checklist item 7: this
 * module writes one content_screening_terms row per NORMALISED term (two
 * source terms that normalise to the same matcher key would collide on the
 * table's own natural key — reported, not silently dropped, matching
 * findScreeningHits' de-dupe-by-matcher-key behaviour, which keeps the FIRST
 * entry of a key).
 */

import { insertStatement, updateStatement } from './sql.mjs';
import { rowContentHash, carriedRow } from './plan.mjs';
import { normalizeScreeningTerm } from './screening-normalize.mjs';
import { formatTime } from './time-columns.mjs';

function readSchema(name) {
  // 0024_product_screening.sql: content_screening_terms(term, kind, hard_block, created_at)
  // 0034 adds `note`. This module writes the table's PK as `term` (its
  // natural key, per 0024's own comment).
  return name;
}

export function transformContentScreening({ contentScreeningDoc, nowMillis }) {
  const problems = [];
  const rows = [];
  const report = { hardBlock: false, reviewFirstProducts: 2, termCount: 0, termsDropped: [] };

  const data = contentScreeningDoc?.data ?? null;
  if (data === null) {
    problems.push('settings/contentScreening is absent from the bundle — nothing imported for row 72');
    return { problems, report, rows };
  }

  const blocklist = Array.isArray(data.blocklist) ? data.blocklist : [];
  const globalHardBlock = data.hardBlock === true;
  report.hardBlock = globalHardBlock;
  report.reviewFirstProducts = typeof data.reviewFirstProducts === 'number' ? data.reviewFirstProducts : 2;

  const seenKeys = {}; // matcher key -> true; a plain object, not a Set (see the no-write-calls scan note in transform-users.mjs)
  let imported = 0;
  for (const entry of blocklist) {
    const term = typeof entry?.term === 'string' ? entry.term : null;
    if (term === null) {
      problems.push(`a blocklist entry with no string term was skipped: ${JSON.stringify(entry).slice(0, 200)}`);
      continue;
    }
    const normalized = normalizeScreeningTerm(term);
    if (normalized === null) {
      report.termsDropped.push(term);
      problems.push(`term ${JSON.stringify(term)} normalises to nothing (empty/too long/control character) — dropped`);
      continue;
    }
    const matchKey = normalized.symbolOnly ? normalized.term : normalized.term;
    if (Object.hasOwn(seenKeys, matchKey)) {
      report.termsDropped.push(term);
      problems.push(`term ${JSON.stringify(term)} normalises to the same matcher key as an earlier term (${JSON.stringify(matchKey)}) — kept the first, dropped this one, as findScreeningHits does`);
      continue;
    }
    seenKeys[matchKey] = true;

    const hardBlock = entry.hardBlock === true;
    const columns = ['term', 'kind', 'hard_block', 'note', 'created_at'];
    const row = {
      created_at: formatTime('content_screening_terms', 'created_at', nowMillis),
      hard_block: hardBlock ? 1 : 0,
      kind: typeof entry.kind === 'string' ? entry.kind : 'other',
      note: typeof entry.note === 'string' ? entry.note : null,
      term: normalized.term,
    };
    rows.push(
      carriedRow(readSchema('content_screening_terms'), normalized.term, insertStatement('content_screening_terms', columns, row), rowContentHash('content_screening_terms', columns, row)),
    );
    imported += 1;
  }
  report.termCount = imported;

  // platform_settings: the two scalars + a version bump, in the same batch
  // (the row is a migration-seeded singleton; UPDATE only).
  const settingsSet = {
    review_first_products: report.reviewFirstProducts,
    screening_hard_block: globalHardBlock ? 1 : 0,
    updated_at: formatTime('platform_settings', 'updated_at', nowMillis),
  };
  rows.push(
    carriedRow(
      'platform_settings',
      '1:screening',
      updateStatement('platform_settings', settingsSet, { id: 1 }),
      rowContentHash('platform_settings', ['id', ...Object.keys(settingsSet)], { id: 1, ...settingsSet }),
    ),
  );
  // Bump screening_terms_version by exactly one (platform_settings_terms_version_forward
  // requires strictly-increasing values; this SELECT-based UPDATE reads the
  // current value in the same statement so it is correct regardless of the
  // migration's seeded starting value).
  rows.push(
    carriedRow(
      'platform_settings',
      '1:terms_version_bump',
      'UPDATE platform_settings SET screening_terms_version = screening_terms_version + 1 WHERE id = 1;',
      rowContentHash('platform_settings', ['bump'], { bump: 'screening_terms_version+1' }),
    ),
  );

  return { problems, report, rows };
}
