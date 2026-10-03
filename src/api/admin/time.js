// Time, the one place (PLAN §2.8). The API writes UTC ISO-8601 text (a NEW
// table) or integer milliseconds (an older one, e.g. stored_objects, tenants);
// a date-only field `YYYY-MM-DD` is a day in Europe/Stockholm. Nulls stay null.
//
// The pages call `.toDate()` and `.seconds` on what Firestore handed them; an
// adapter gives them `toTimestamp(value)` instead, which answers both, so the
// markup does not change.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONE = 'Europe/Stockholm';

let zoneFormat = null;

function stockholmParts(millis) {
  zoneFormat ??= new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const { type, value } of zoneFormat.formatToParts(new Date(millis))) parts[type] = Number(value);
  return parts;
}

/** Stockholm's offset from UTC at the instant `millis`, in milliseconds. */
function stockholmOffset(millis) {
  const p = stockholmParts(millis);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(millis / 1000) * 1000;
}

/** The instant a Stockholm day `YYYY-MM-DD` begins, or null for anything else. */
export function stockholmDayStart(text) {
  const m = typeof text === 'string' ? DATE_ONLY.exec(text) : null;
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utcMidnight = Date.UTC(year, month - 1, day);
  const check = new Date(utcMidnight);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  // Two passes: the offset at the guess, then at the corrected guess. Stockholm
  // never changes its clock at midnight, so the second pass is the answer.
  let at = utcMidnight - stockholmOffset(utcMidnight);
  at = utcMidnight - stockholmOffset(at);
  return new Date(at);
}

/**
 * The instant of an API value, or null: ISO-8601 text with a time, a date-only
 * `YYYY-MM-DD` (its Stockholm midnight), integer milliseconds, a Date, or
 * something with `toDate()` (already adapted).
 */
export function toInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value === 'string') {
    const day = stockholmDayStart(value);
    if (day) return day;
    // SQLite's datetime() text ('YYYY-MM-DD HH:MM:SS') is UTC.
    const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(\.\d+)?)$/.exec(value);
    if (sqlite) return toInstant(`${sqlite[1]}T${sqlite[2]}Z`);
    // Otherwise only text that names its zone: a time without one would be
    // read in the browser's zone, which is not what the server meant.
    if (!/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? new Date(at) : null;
  }
  if (typeof value === 'object' && typeof value.toDate === 'function') return toInstant(value.toDate());
  return null;
}

/**
 * What a page that once read a Firestore Timestamp calls: `.toDate()`,
 * `.seconds`, `.nanoseconds`, `.toMillis()`; plus `.toISOString()` and
 * `valueOf()` (so two of them compare and sort). Null for no value.
 */
export function toTimestamp(value) {
  const instant = toInstant(value);
  if (instant === null) return null;
  const millis = instant.getTime();
  return Object.freeze({
    seconds: Math.floor(millis / 1000),
    nanoseconds: (((millis % 1000) + 1000) % 1000) * 1e6,
    toDate: () => new Date(millis),
    toMillis: () => millis,
    toISOString: () => new Date(millis).toISOString(),
    valueOf: () => millis,
  });
}

/** ISO-8601 UTC text of a value (what the API takes), or null. */
export function toIso(value) {
  const instant = toInstant(value);
  return instant === null ? null : instant.toISOString();
}
