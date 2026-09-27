/**
 * scripts/cf-port/migrate/lib/time-columns.mjs — THE ONE mapping of
 * (table, column) -> storage type for every time column of every table this
 * importer writes. Every transform module gets its time values through this
 * module's `formatTime()` rather than writing an ISO string or a millisecond
 * number by hand, so a table can never silently receive the wrong shape.
 *
 * SOURCE OF TRUTH: the CREATE TABLE statement in the migration that declares
 * the column, confirmed against the Worker source where it writes that table
 * (never guessed from the column's name — `created_at`/`updated_at` alone
 * says nothing about the stored type in this schema, since the convention
 * changed partway through the migration history).
 *
 *   INTEGER milliseconds (the OLDER convention: 0001, 0002, 0009, 0012, 0019,
 *   0027 and everything that only ever ALTERs one of those tables):
 *     tenants: created_at, updated_at, stripe_account_synced_at
 *     tenant_domains: created_at, updated_at, verified_at
 *     "user": createdAt, updatedAt          -- TEXT ISO, see below (Better Auth)
 *     "account": createdAt, updatedAt        -- TEXT ISO, see below (Better Auth)
 *     identity_access: created_at, updated_at
 *     tenant_memberships: created_at, updated_at
 *     audit_events: created_at
 *     pod_profiles: created_at, updated_at   (0012, CP2 — this importer writes it)
 *
 *   TEXT ISO-8601 UTC, the `strftime('%Y-%m-%dT%H:%M:%fZ', col)` round-trip
 *   CHECK (the NEWER convention: 0013/0014/0017 onward, and everything CP3
 *   added in 0023, 0032-0038):
 *     tenant_settings: updated_at
 *     tenant_features: updated_at
 *     printers: created_at, updated_at
 *     printer_sku_tiers: created_at, updated_at
 *     printer_catalog: imported_at
 *     print_defaults: updated_at
 *     platform_settings: updated_at
 *     content_screening_terms: created_at    (0024 — TEXT, not INTEGER: verified below)
 *     legacy_id_map: created_at
 *     import_runs: started_at, finished_at
 *     import_row_hashes: (no time column)
 *     legal_acceptances: accepted_at (accepted_at_original is a KEPT-VERBATIM
 *       string, not reformatted — see the module's own handling, it is never
 *       passed through formatTime())
 *
 * BETTER AUTH'S OWN TABLES ("user"/"account"/"session"/"verification", all
 * declared with SQL type DATE in 0002) store ISO TEXT on this D1 adapter —
 * confirmed read-only against the staging database by the reviewer (round 1
 * fix 1). DATE is not a real SQLite storage class; SQLite stores whatever the
 * driver binds, and Better Auth's D1 adapter binds ISO strings. This module
 * therefore lists them under TEXT, matching the reviewer's finding, not the
 * column's declared affinity.
 *
 * A (table, column) this module does not list is, by construction (see the
 * drift-guard test), a column import.mjs never writes — the completeness
 * test parses every migration under cloudflare/migrations/ for the tables in
 * TABLES_THIS_IMPORTER_WRITES and fails if any of THEIR time columns is
 * missing from this map.
 */

export const INTEGER_MS = 'integer_ms';
export const TEXT_ISO = 'text_iso';

/** Tables this importer ever writes a row into (used by the completeness
 * test's migration parser — kept in sync manually with every transform
 * module's INSERT/UPDATE target). */
export const TABLES_THIS_IMPORTER_WRITES = [
  'tenants',
  'tenant_domains',
  'tenant_settings',
  'tenant_features',
  'user',
  'account',
  'identity_access',
  'tenant_memberships',
  'legacy_id_map',
  'printers',
  'printer_sku_tiers',
  'printer_catalog',
  'print_defaults',
  'pod_profiles',
  'content_screening_terms',
  'platform_settings',
  'legal_acceptances',
  'audit_events',
  'import_runs',
  'import_row_hashes',
];

/** (table, column) pairs that hold a TIME-shaped value but are DELIBERATELY
 * never passed through formatTime(): the source's own timestamp STRING is
 * kept byte-verbatim as evidence, never reparsed/reformatted. Currently only
 * `legal_acceptances.accepted_at_original` (0037: the source's acceptedAtIso
 * string, kept exactly as it was, alongside `accepted_at` which IS the
 * formatTime()-derived column). Listed here so the completeness test can
 * distinguish "forgotten" from "deliberately verbatim". */
export const VERBATIM_TIME_COLUMNS = [{ column: 'accepted_at_original', table: 'legal_acceptances' }];

/** (table, column) -> INTEGER_MS | TEXT_ISO, for every TIME column of every
 * table this importer writes. A time column this importer never writes a
 * value into (e.g. `tenants.stripe_account_synced_at`, which this importer
 * always leaves NULL) is still listed, because the completeness test checks
 * the SCHEMA, not just which columns happen to appear in a given INSERT. */
export const TIME_COLUMN_TYPES = {
  account: { createdAt: TEXT_ISO, updatedAt: TEXT_ISO },
  audit_events: { created_at: INTEGER_MS },
  content_screening_terms: { created_at: TEXT_ISO },
  identity_access: { created_at: INTEGER_MS, updated_at: INTEGER_MS },
  import_row_hashes: {},
  import_runs: { finished_at: TEXT_ISO, started_at: TEXT_ISO },
  legacy_id_map: { created_at: TEXT_ISO },
  // accepted_at_original is deliberately NOT listed: it is the source's own
  // acceptedAtIso string kept BYTE-VERBATIM as evidence (0037), never
  // reformatted through formatTime() — see transform-legal-acceptances.mjs.
  legal_acceptances: { accepted_at: TEXT_ISO },
  platform_settings: { updated_at: TEXT_ISO },
  pod_profiles: { created_at: INTEGER_MS, updated_at: INTEGER_MS },
  print_defaults: { updated_at: TEXT_ISO },
  printer_catalog: { imported_at: TEXT_ISO },
  printer_sku_tiers: { created_at: TEXT_ISO, updated_at: TEXT_ISO },
  printers: { created_at: TEXT_ISO, updated_at: TEXT_ISO },
  tenant_domains: { created_at: INTEGER_MS, updated_at: INTEGER_MS, verified_at: INTEGER_MS },
  tenant_features: { updated_at: TEXT_ISO },
  tenant_memberships: { created_at: INTEGER_MS, updated_at: INTEGER_MS },
  tenant_settings: { updated_at: TEXT_ISO },
  tenants: { created_at: INTEGER_MS, stripe_account_synced_at: INTEGER_MS, updated_at: INTEGER_MS },
  user: { createdAt: TEXT_ISO, updatedAt: TEXT_ISO },
};

/** Looks up the type for one (table, column); throws loudly on an unmapped
 * pair rather than silently defaulting — a new time column MUST be added
 * here deliberately (the completeness test also catches this earlier, at the
 * schema level, before any transform module ever runs). */
export function timeColumnType(table, column) {
  const forTable = TIME_COLUMN_TYPES[table];
  if (forTable === undefined || !Object.hasOwn(forTable, column)) {
    throw new Error(`time-columns.mjs: no entry for ${table}.${column} — add it to TIME_COLUMN_TYPES before writing this column`);
  }
  return forTable[column];
}

/**
 * Formats a JS timestamp (milliseconds since epoch, a `number`) for one
 * (table, column), returning either an INTEGER (a plain JS number, for
 * sqlLiteral to encode as a decimal literal) or the ISO-8601 UTC STRING
 * (millisecond precision, exact `Date.prototype.toISOString()` shape, for
 * sqlLiteral to quote).
 *
 * `millis` must already be a finite integer number of milliseconds; every
 * transform module converts its source Timestamp/ISO-string/whatever into
 * milliseconds ONCE (see lib/timestamps.mjs) and then calls this function
 * once per (table, column) it writes, so the two conversions (parse source
 * -> millis, millis -> stored shape) never conflate.
 */
export function formatTime(table, column, millis) {
  if (typeof millis !== 'number' || !Number.isFinite(millis)) {
    throw new Error(`formatTime(${table}.${column}): millis must be a finite number, got ${JSON.stringify(millis)}`);
  }
  const type = timeColumnType(table, column);
  return type === INTEGER_MS ? Math.trunc(millis) : new Date(millis).toISOString();
}

/** Same as formatTime, but passes NULL through untouched (many time columns
 * are nullable: tenant_domains.verified_at, import_runs.finished_at, …). */
export function formatTimeOrNull(table, column, millis) {
  return millis === null || millis === undefined ? null : formatTime(table, column, millis);
}
