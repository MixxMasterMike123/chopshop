// AdminDiscountCodes' shapes on the API (CP8-DC). Pure. Under Node:
//   node --test "src/admin-app/**/*.test.mjs"
//
// The page holds a code as the older build's documents held it: the value in
// kronor (a fixed code) or in percent (12.5), the minimum in whole kronor, the
// dates as days of the date input. The API holds öre, basis points and
// instants (ms). The bridge, both ways:
//   kronor → öre, percent → basis points   rounded half up to the unit
//   minimum                                 floored to whole kronor, × 100
//   the start day                           00:00 in Stockholm (the day's first instant)
//   the end day                             INCLUSIVE: the last millisecond of
//                                           that day in Stockholm, i.e. the start
//                                           of the next day − 1 (DC15)
// The days are Stockholm's whatever the browser's zone, so a code edited and
// saved again keeps its dates (the older build's moved a day back each time).

import { stockholmDayStart } from '../../api/admin/time.js';

const ZONE = 'Europe/Stockholm';
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A decimal number of units × 100, rounded half up: 49.9 → 4990, 12.5 → 1250. */
function hundredths(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // toFixed(6) first: 0.285 × 100 is 28.499999999999996 in floating point.
  return Math.round(Number((number * 100).toFixed(6)));
}

/** The Stockholm day `YYYY-MM-DD` of an instant (ms), or '' for none. */
export function stockholmDayOf(ms) {
  if (!Number.isFinite(ms)) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: '2-digit', timeZone: ZONE, year: 'numeric' })
      .formatToParts(new Date(ms))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The day after `YYYY-MM-DD`, or null. */
function nextDay(day) {
  const m = DAY.exec(day);
  if (!m) return null;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return next.toISOString().slice(0, 10);
}

/** The first instant (ms) of a Stockholm day, or null for '' or anything else. */
export function dayStartMs(day) {
  return stockholmDayStart(day)?.getTime() ?? null;
}

/** The last instant (ms) of a Stockholm day (the end date counts in full), or null. */
export function dayEndMs(day) {
  if (dayStartMs(day) === null) return null;
  const following = dayStartMs(nextDay(day));
  return following === null ? null : following - 1;
}

/** A day as the page shows it ("2026-10-31", sv-SE), or ''. */
export function formatStockholmDay(ms) {
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('sv-SE', { timeZone: ZONE }) : '';
}

const nullableNumber = (value) => (Number.isFinite(value) ? value : null);

/** The page's row from the API's AdminDiscountCode, or null. */
export function discountCodeRowFromApi(code) {
  if (!code || typeof code !== 'object' || typeof code.discountCodeId !== 'string') return null;
  const percent = code.type === 'percent';
  return {
    id: code.discountCodeId,
    code: String(code.code ?? ''),
    type: percent ? 'percent' : 'fixed',
    value: percent ? (code.percentBp ?? 0) / 100 : (code.valueMinor ?? 0) / 100,
    scope: code.scope === 'products' ? 'products' : 'all',
    productIds: Array.isArray(code.productIds) ? code.productIds : [],
    minSpend: Number.isFinite(code.minSpendMinor) ? code.minSpendMinor / 100 : null,
    startsAt: nullableNumber(code.startsAt),
    endsAt: nullableNumber(code.endsAt),
    maxUses: Number.isSafeInteger(code.maxUses) ? code.maxUses : null,
    usedCount: Number.isSafeInteger(code.usedCount) ? code.usedCount : 0,
    heldCount: Number.isSafeInteger(code.heldCount) ? code.heldCount : 0,
    active: code.active !== false,
  };
}

/**
 * The create body, which is also the full PATCH, from the page's validated
 * form: { code (normalised), type, value (kronor or percent), scope,
 * productIds, minSpend (kronor or null), startsDay, endsDay ('' or
 * YYYY-MM-DD), maxUses (or null), active }. Only the type's own value key and,
 * for a products-scoped code, the product list are sent: the Worker clears
 * the other branch itself.
 */
export function discountCodeBodyFromForm(form) {
  const body = {
    active: form.active === true,
    code: form.code,
    endsAt: form.endsDay ? dayEndMs(form.endsDay) : null,
    maxUses: Number.isSafeInteger(form.maxUses) ? form.maxUses : null,
    minSpendMinor: Number.isFinite(form.minSpend) ? Math.floor(form.minSpend) * 100 : null,
    scope: form.scope === 'products' ? 'products' : 'all',
    startsAt: form.startsDay ? dayStartMs(form.startsDay) : null,
    type: form.type === 'fixed' ? 'fixed' : 'percent',
  };
  if (body.type === 'fixed') body.valueMinor = hundredths(form.value);
  else body.percentBp = hundredths(form.value);
  if (body.scope === 'products') body.productIds = [...form.productIds];
  return body;
}
