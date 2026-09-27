import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicUserId, deterministicId } from '../lib/ids.mjs';

test('deterministicUserId: same env + legacy id -> same output across calls', () => {
  const a = deterministicUserId('staging', 'firebase-uid-1');
  const b = deterministicUserId('staging', 'firebase-uid-1');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('deterministicUserId: staging and production never collide for the same legacy id', () => {
  const staging = deterministicUserId('staging', 'firebase-uid-1');
  const production = deterministicUserId('production', 'firebase-uid-1');
  assert.notEqual(staging, production);
});

test('deterministicUserId: different legacy ids produce different outputs', () => {
  const a = deterministicUserId('staging', 'uid-a');
  const b = deterministicUserId('staging', 'uid-b');
  assert.notEqual(a, b);
});

test('deterministicUserId: refuses an unknown env', () => {
  assert.throws(() => deterministicUserId('prod', 'uid-a'));
});

test('deterministicUserId: refuses an empty legacy id', () => {
  assert.throws(() => deterministicUserId('staging', ''));
});

test('deterministicId: deterministic and namespace-sensitive', () => {
  const a = deterministicId('ns1', 'x', 'y');
  const b = deterministicId('ns1', 'x', 'y');
  const c = deterministicId('ns2', 'x', 'y');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
