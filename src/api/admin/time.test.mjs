// Time (PLAN §2.8): node --test src/api/admin/time.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stockholmDayStart, toInstant, toIso, toTimestamp } from './time.js';

describe('toInstant', () => {
  it('ISO text with a zone, milliseconds, a Date', () => {
    assert.equal(toInstant('2026-10-03T18:00:00.000Z').toISOString(), '2026-10-03T18:00:00.000Z');
    assert.equal(toInstant('2026-10-03T20:00:00+02:00').toISOString(), '2026-10-03T18:00:00.000Z');
    assert.equal(toInstant(1_759_514_400_000).getTime(), 1_759_514_400_000);
    assert.equal(toInstant(new Date(5)).getTime(), 5);
  });

  it("SQLite's datetime() text is UTC", () => {
    assert.equal(toInstant('2026-10-03 18:00:00').toISOString(), '2026-10-03T18:00:00.000Z');
  });

  it('nulls stay null; text without a zone, junk and impossible days are null', () => {
    for (const value of [null, undefined, '', 'yesterday', '2026-10-03T18:00:00', '2026-02-30', NaN, Infinity, {}, new Date('x')]) {
      assert.equal(toInstant(value), null, String(value));
    }
  });
});

describe('a date-only field is a day in Stockholm', () => {
  it('winter (UTC+1) and summer (UTC+2)', () => {
    assert.equal(stockholmDayStart('2026-01-15').toISOString(), '2026-01-14T23:00:00.000Z');
    assert.equal(stockholmDayStart('2026-07-15').toISOString(), '2026-07-14T22:00:00.000Z');
  });

  it('the days the clock changes (29 March and 25 October 2026) start at their own offset', () => {
    assert.equal(stockholmDayStart('2026-03-29').toISOString(), '2026-03-28T23:00:00.000Z');
    assert.equal(stockholmDayStart('2026-03-30').toISOString(), '2026-03-29T22:00:00.000Z');
    assert.equal(stockholmDayStart('2026-10-25').toISOString(), '2026-10-24T22:00:00.000Z');
    assert.equal(stockholmDayStart('2026-10-26').toISOString(), '2026-10-25T23:00:00.000Z');
  });

  it('through toInstant', () => {
    assert.equal(toInstant('2026-07-15').toISOString(), '2026-07-14T22:00:00.000Z');
  });
});

describe('toTimestamp: what a page that read a Firestore Timestamp calls', () => {
  it('toDate, seconds, nanoseconds, toMillis', () => {
    const ts = toTimestamp('2026-10-03T18:00:00.250Z');
    assert.equal(ts.toDate().toISOString(), '2026-10-03T18:00:00.250Z');
    assert.equal(ts.seconds, 1_791_050_400);
    assert.equal(ts.nanoseconds, 250_000_000);
    assert.equal(ts.toMillis(), 1_791_050_400_250);
    assert.ok(Object.isFrozen(ts));
  });

  it('a page that mutates the Date it got does not change the timestamp', () => {
    const ts = toTimestamp(0);
    ts.toDate().setFullYear(2000);
    assert.equal(ts.toMillis(), 0);
  });

  it('they compare and sort by their instant; an adapted value adapts again', () => {
    const a = toTimestamp('2026-01-01T00:00:00Z');
    const b = toTimestamp('2026-01-02T00:00:00Z');
    assert.ok(a < b);
    assert.equal(toTimestamp(a).toMillis(), a.toMillis());
  });

  it('null for no value', () => {
    assert.equal(toTimestamp(null), null);
    assert.equal(toIso(undefined), null);
    assert.equal(toIso(0), '1970-01-01T00:00:00.000Z');
  });
});
