import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, canonicalStringify, UnknownFirestoreTypeError } from '../lib/typed-json.mjs';
import { FakeTimestamp, FakeDocumentReference, FakeGeoPoint, FakeBytes, FakeUnknownFirestoreType } from './fake-firestore.mjs';

test('round-trips a Timestamp', () => {
  const ts = new FakeTimestamp(1_700_000_000, 123_000_000);
  const encoded = encode(ts);
  assert.equal(encoded.__t, 'ts');
  assert.equal(encoded.s, 1_700_000_000);
  assert.equal(encoded.ns, 123_000_000);
  assert.equal(encoded.iso, ts.toDate().toISOString());
  const decoded = decode(encoded);
  assert.equal(decoded.seconds, ts.seconds);
  assert.equal(decoded.nanoseconds, ts.nanoseconds);
  assert.equal(decoded.toDate().toISOString(), ts.toDate().toISOString());
});

test('round-trips a DocumentReference', () => {
  const ref = new FakeDocumentReference('shops/melodie-mc');
  const encoded = encode(ref);
  assert.deepEqual(encoded, { __t: 'ref', path: 'shops/melodie-mc' });
  const decoded = decode(encoded);
  assert.equal(decoded.path, 'shops/melodie-mc');
});

test('round-trips a GeoPoint', () => {
  const geo = new FakeGeoPoint(59.33, 18.06);
  const encoded = encode(geo);
  assert.deepEqual(encoded, { __t: 'geo', lat: 59.33, lng: 18.06 });
  const decoded = decode(encoded);
  assert.equal(decoded.latitude, 59.33);
  assert.equal(decoded.longitude, 18.06);
});

test('round-trips Bytes (a Buffer)', () => {
  const buf = Buffer.from('hello world', 'utf8');
  const encoded = encode(buf);
  assert.equal(encoded.__t, 'bytes');
  const decoded = decode(encoded);
  assert.ok(Buffer.isBuffer(decoded));
  assert.equal(decoded.toString('utf8'), 'hello world');
});

test('round-trips Bytes (a Uint8Array)', () => {
  const arr = new Uint8Array([1, 2, 3, 255]);
  const encoded = encode(arr);
  assert.equal(encoded.__t, 'bytes');
  const decoded = decode(encoded);
  assert.deepEqual([...decoded], [1, 2, 3, 255]);
});

test('round-trips Bytes (a firebase-admin-shaped Bytes object)', () => {
  const bytesLike = new FakeBytes(Buffer.from([9, 8, 7]));
  const encoded = encode(bytesLike);
  assert.equal(encoded.__t, 'bytes');
  const decoded = decode(encoded);
  assert.deepEqual([...decoded], [9, 8, 7]);
});

test('round-trips NaN, Infinity, -Infinity', () => {
  for (const [value, tag] of [[NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity']]) {
    const encoded = encode(value);
    assert.deepEqual(encoded, { __t: 'num', v: tag });
    const decoded = decode(encoded);
    if (Number.isNaN(value)) {
      assert.ok(Number.isNaN(decoded));
    } else {
      assert.equal(decoded, value);
    }
  }
});

test('round-trips ordinary scalars unchanged', () => {
  for (const value of [42, 3.14, 'hello', true, false, null]) {
    assert.equal(decode(encode(value)), value);
  }
});

test('round-trips nested arrays and maps containing every type', () => {
  const ts = new FakeTimestamp(1_600_000_000, 0);
  const ref = new FakeDocumentReference('a/b');
  const geo = new FakeGeoPoint(1, 2);
  const bytes = Buffer.from([1, 2, 3]);
  const original = {
    name: 'Test Shop',
    when: ts,
    ref,
    location: geo,
    blob: bytes,
    weird: NaN,
    list: [ts, ref, geo, bytes, NaN, 'x', { nested: [Infinity, -Infinity] }],
    nullish: null,
  };
  const encoded = encode(original);
  const decoded = decode(encoded);
  assert.equal(decoded.name, 'Test Shop');
  assert.equal(decoded.when.toDate().toISOString(), ts.toDate().toISOString());
  assert.equal(decoded.ref.path, 'a/b');
  assert.equal(decoded.location.latitude, 1);
  assert.deepEqual([...decoded.blob], [1, 2, 3]);
  assert.ok(Number.isNaN(decoded.weird));
  assert.equal(decoded.list[5], 'x');
  assert.equal(decoded.list[6].nested[0], Infinity);
  assert.equal(decoded.list[6].nested[1], -Infinity);
});

test('escapes a plain object that itself has a __t key, and decode reverses it', () => {
  const original = { __t: 'not-really-typed', payload: 'raw data', n: 5 };
  const encoded = encode(original);
  assert.equal(encoded.__t, 'esc');
  assert.deepEqual(encoded.v, { __t: 'not-really-typed', payload: 'raw data', n: 5 });
  const decoded = decode(encoded);
  assert.deepEqual(decoded, original);
});

test('escapes a __t object nested one level deep', () => {
  const original = { outer: { __t: 'x', a: 1 } };
  const encoded = encode(original);
  assert.equal(encoded.outer.__t, 'esc');
  const decoded = decode(encoded);
  assert.deepEqual(decoded, original);
});

test('escapes a __t object whose OWN value also has __t (double nesting)', () => {
  const original = { __t: 'level1', v: { __t: 'level2', x: 1 } };
  const encoded = encode(original);
  const decoded = decode(encoded);
  assert.deepEqual(decoded, original);
});

test('escape does not confuse a real typed envelope with a coincidental shape', () => {
  // A real ts envelope decodes to a Timestamp-like; a document that legitimately
  // stores { __t: 'ts', s: 1, ns: 2, iso: '...' } as PLAIN DATA (not from our
  // encoder) is indistinguishable from an actual encoded Timestamp UNLESS it
  // was escaped at encode time — which it is, because encode() sees the __t
  // key on the source object and escapes.
  const dataThatHappensToLookTyped = { __t: 'ts', s: 1, ns: 2, iso: 'not a real iso string' };
  const encoded = encode(dataThatHappensToLookTyped);
  assert.equal(encoded.__t, 'esc');
  const decoded = decode(encoded);
  assert.deepEqual(decoded, dataThatHappensToLookTyped);
});

// ── Review round 1, fix 1 ───────────────────────────────────────────────────
// Duck typing on shape alone would misclassify a plain map that happens to
// carry the same keys as a Firestore type. Detection now requires the value
// to be a CLASS INSTANCE (not a plain object) before the shape is even
// checked, so these three plain maps must survive completely unchanged.

test('fix 1: a plain map with latitude, longitude AND a third key survives unchanged (not misread as a GeoPoint)', () => {
  const original = { latitude: 59.3, longitude: 18.0, label: 'Butiken' };
  const encoded = encode(original);
  // Must NOT be a geo envelope — must be the plain object, recursed as-is.
  assert.equal(encoded.__t, undefined);
  assert.deepEqual(encoded, original);
  const decoded = decode(encoded);
  assert.deepEqual(decoded, original);
});

test('fix 1: a plain map with path + firestore keys survives unchanged (not misread as a DocumentReference)', () => {
  const original = { path: 'some/logical/path', firestore: { note: 'not a real Firestore handle' } };
  const encoded = encode(original);
  assert.equal(encoded.__t, undefined);
  assert.deepEqual(encoded, original);
  const decoded = decode(encoded);
  assert.deepEqual(decoded, original);
});

test('fix 1: a plain map with numeric seconds/nanoseconds but no toDate survives unchanged (not misread as a Timestamp)', () => {
  const original = { seconds: 1_700_000_000, nanoseconds: 0, note: 'just a map, no toDate()' };
  const encoded = encode(original);
  assert.equal(encoded.__t, undefined);
  assert.deepEqual(encoded, original);
  const decoded = decode(encoded);
  assert.deepEqual(decoded, original);
});

// ── Review round 1, fix 2 ───────────────────────────────────────────────────

test('fix 2: a class instance matching none of the known Firestore shapes throws, naming the constructor', () => {
  const mystery = new FakeUnknownFirestoreType('some data');
  assert.throws(() => encode(mystery), (error) => {
    assert.ok(error instanceof UnknownFirestoreTypeError);
    assert.match(error.message, /FakeUnknownFirestoreType/);
    // Never leak field contents into the error message.
    assert.ok(!error.message.includes('some data'));
    return true;
  });
});

test('fix 2: decoded ts/ref/geo are class instances that re-encode to identical bytes', () => {
  const ts = new FakeTimestamp(1_700_000_000, 500_000_000);
  const ref = new FakeDocumentReference('shops/melodie-mc');
  const geo = new FakeGeoPoint(59.33, 18.06);

  const encodedTs = encode(ts);
  const decodedTs = decode(encodedTs);
  const reencodedTs = encode(decodedTs);
  assert.deepEqual(reencodedTs, encodedTs);

  const encodedRef = encode(ref);
  const decodedRef = decode(encodedRef);
  const reencodedRef = encode(decodedRef);
  assert.deepEqual(reencodedRef, encodedRef);

  const encodedGeo = encode(geo);
  const decodedGeo = decode(encodedGeo);
  const reencodedGeo = encode(decodedGeo);
  assert.deepEqual(reencodedGeo, encodedGeo);
});

test('canonicalStringify sorts object keys recursively but keeps array order', () => {
  const a = canonicalStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalStringify({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}');
  const arr = canonicalStringify({ list: [3, 1, 2] });
  assert.equal(arr, '{"list":[3,1,2]}');
});
