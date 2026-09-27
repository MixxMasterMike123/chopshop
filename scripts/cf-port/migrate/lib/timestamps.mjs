/**
 * scripts/cf-port/migrate/lib/timestamps.mjs — parses a SOURCE timestamp
 * (a decoded Firestore Timestamp-like object, an ISO string, or absent) into
 * milliseconds since the epoch, ONCE, before any transform module hands the
 * value to lib/time-columns.mjs's formatTime() for the TARGET column's own
 * storage shape. Keeping "parse the source" and "format for the target"
 * as two separate steps is what let round 1's timestamp-type bug be fixed in
 * one place instead of in every transform module that touches a time value.
 */

/** Parses a bundle timestamp value into milliseconds, or `fallbackMillis`
 * (itself milliseconds) when the value is absent/unparseable. Accepts:
 *   - a decoded Firestore Timestamp (an object with `.toDate()`, per
 *     lib/typed-json.mjs's DecodedTimestamp)
 *   - an ISO-8601 string
 *   - null/undefined
 */
export function parseSourceTimestampMillis(value, fallbackMillis) {
  if (value === null || value === undefined) {
    return fallbackMillis;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? fallbackMillis : parsed;
  }
  if (typeof value?.toDate === 'function') {
    return value.toDate().getTime();
  }
  return fallbackMillis;
}

/** millis >= floorMillis, clamped forward (never invents a LATER time than
 * what actually happened when the source's own value already satisfies the
 * invariant; only refuses to write an impossible one — see MIGRATION CHECKs
 * such as `updated_at >= created_at`). */
export function clampForward(millis, floorMillis) {
  return millis >= floorMillis ? millis : floorMillis;
}
