import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceTimestampMillis, clampForward } from '../lib/timestamps.mjs';

test('parseSourceTimestampMillis: null/undefined -> fallback', () => {
  assert.equal(parseSourceTimestampMillis(null, 123), 123);
  assert.equal(parseSourceTimestampMillis(undefined, 123), 123);
});

test('parseSourceTimestampMillis: an ISO string parses to millis', () => {
  assert.equal(parseSourceTimestampMillis('2025-01-01T00:00:00.000Z', 0), Date.parse('2025-01-01T00:00:00.000Z'));
});

test('parseSourceTimestampMillis: an unparseable string falls back', () => {
  assert.equal(parseSourceTimestampMillis('not-a-date', 999), 999);
});

test('parseSourceTimestampMillis: a decoded Timestamp-like object (.toDate()) is used', () => {
  const fakeTimestamp = { toDate: () => new Date('2025-06-01T00:00:00.000Z') };
  assert.equal(parseSourceTimestampMillis(fakeTimestamp, 0), Date.parse('2025-06-01T00:00:00.000Z'));
});

test('clampForward: keeps a value already >= the floor', () => {
  assert.equal(clampForward(100, 50), 100);
  assert.equal(clampForward(50, 50), 50);
});

test('clampForward: clamps a value below the floor up to the floor', () => {
  assert.equal(clampForward(10, 50), 50);
});

test('parseSourceTimestampMillis: a Timestamp that was written back as a plain map', () => {
  assert.equal(parseSourceTimestampMillis({ _nanoseconds: 123_000_000, _seconds: 1_735_689_600 }, 7), 1_735_689_600_123);
  assert.equal(parseSourceTimestampMillis({ nanoseconds: 999_999_999, seconds: 1_735_689_600 }, 7), 1_735_689_600_999);
  assert.equal(parseSourceTimestampMillis({ _seconds: 1_735_689_600 }, 7), 1_735_689_600_000);
});

test('parseSourceTimestampMillis: a map that is not a time falls back, it is never guessed', () => {
  for (const value of [{}, { seconds: '1735689600' }, { _seconds: Number.NaN }, { _seconds: -5 }, { _seconds: 1, _nanoseconds: 2_000_000_000 }, { _seconds: 9e15 }, { iso: '2025-01-01' }, [1735689600], 1735689600]) {
    assert.equal(parseSourceTimestampMillis(value, 7), 7, JSON.stringify(value));
  }
});
