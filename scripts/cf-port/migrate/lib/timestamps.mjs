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
 *   - a plain map `{ _seconds, _nanoseconds }` or `{ seconds, nanoseconds }`:
 *     what a Timestamp becomes when a script serialises it and writes the
 *     result back as a map (the two catalogue migrators did, on 21 products
 *     of the real bundle). Without this case such a value fell through to
 *     the fallback, and the row was dated by the run's clock.
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
  if (typeof value === 'object') {
    const seconds = value._seconds ?? value.seconds;
    const nanoseconds = value._nanoseconds ?? value.nanoseconds ?? 0;
    if (Number.isFinite(seconds) && Number.isFinite(nanoseconds) && nanoseconds >= 0 && nanoseconds < 1_000_000_000) {
      const millis = seconds * 1000 + Math.floor(nanoseconds / 1_000_000);
      // Outside what a Date can hold, or before 1970: not a time this system wrote.
      return millis >= 0 && millis <= 8.64e15 ? millis : fallbackMillis;
    }
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
