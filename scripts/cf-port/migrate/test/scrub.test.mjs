import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeEmail,
  scrubbedEmailFor,
  resolveEmail,
  UnmappedEmailError,
  normalizeEmailMap,
  scrubEmailsDeep,
  normalizeConnectMap,
  resolveConnectFacts,
  containsFirebaseStorageUrl,
  removeStorageUrlsDeep,
  emailMapFor,
  scrubOptionsProblem,
  KEEP_ADDRESSES,
  findFirebaseStorageUrls,
  FIREBASE_STORAGE_HOSTS,
} from '../lib/scrub.mjs';

test('looksLikeEmail', () => {
  assert.ok(looksLikeEmail('a@b.com'));
  assert.ok(looksLikeEmail('first.last+tag@sub.example.co.uk'));
  assert.ok(!looksLikeEmail('not-an-email'));
  assert.ok(!looksLikeEmail(''));
});

test('looksLikeEmail: a profile link with an @ in its path is a URL, not an address', () => {
  assert.ok(!looksLikeEmail('https://www.tiktok.com/@test.shop'));
  assert.ok(!looksLikeEmail('www.tiktok.com/@test.shop'));
  assert.ok(!looksLikeEmail('mailto:someone@example.com'));
  const { value, changed } = scrubEmailsDeep({ social: { tiktok: 'https://www.tiktok.com/@test.shop' } }, normalizeEmailMap({}), true);
  assert.equal(changed, false);
  assert.equal(value.social.tiktok, 'https://www.tiktok.com/@test.shop');
});

test('resolveEmail: a production run keeps every address (KEEP_ADDRESSES)', () => {
  assert.deepEqual(resolveEmail('real@example.com', emailMapFor('production', {}), false), { action: 'unchanged', value: 'real@example.com' });
  assert.equal(emailMapFor('production', { 'a@example.com': 'b@example.com' }), KEEP_ADDRESSES);
  assert.throws(() => resolveEmail('real@example.com', emailMapFor('staging', {}), false), UnmappedEmailError);
});

test('scrubOptionsProblem: the two scrub options are refused on production only', () => {
  assert.equal(scrubOptionsProblem('staging', { emailMapGiven: true, scrubUnmapped: true }), null);
  assert.equal(scrubOptionsProblem('production', { emailMapGiven: false, scrubUnmapped: false }), null);
  assert.match(scrubOptionsProblem('production', { emailMapGiven: true, scrubUnmapped: false }), /--email-map/);
  assert.match(scrubOptionsProblem('production', { emailMapGiven: false, scrubUnmapped: true }), /--scrub-unmapped/);
});

test('no message names an address: the unmapped refusal and a bad map value carry a fingerprint only', () => {
  try {
    resolveEmail('secret.person@example.com', normalizeEmailMap({}), false, 'users/<uid x>.email');
    assert.fail('must throw');
  } catch (error) {
    assert.ok(!error.message.includes('secret.person'));
    assert.match(error.message, /fingerprint [0-9a-f]{12}/);
  }
  assert.throws(
    () => normalizeEmailMap({ 'secret.person@example.com': '' }),
    (error) => !error.message.includes('secret.person') && /fingerprint [0-9a-f]{12}/.test(error.message),
  );
});

test('scrubbedEmailFor is deterministic and case-insensitive on the address', () => {
  const a = scrubbedEmailFor('Real@Example.com');
  const b = scrubbedEmailFor('real@example.com');
  assert.equal(a, b);
  assert.match(a, /^scrubbed\+[0-9a-f]{12}@example\.com$/);
});

test('resolveEmail: mapped address is replaced', () => {
  const map = normalizeEmailMap({ 'real@example.com': 'test@example.com' });
  const result = resolveEmail('real@example.com', map, false);
  assert.deepEqual(result, { action: 'mapped', value: 'test@example.com' });
});

test('resolveEmail: unmapped address refuses without --scrub-unmapped', () => {
  const map = normalizeEmailMap({});
  assert.throws(() => resolveEmail('nobody@example.com', map, false), UnmappedEmailError);
});

test('resolveEmail: unmapped address scrubs with --scrub-unmapped', () => {
  const map = normalizeEmailMap({});
  const result = resolveEmail('nobody@example.com', map, true);
  assert.equal(result.action, 'scrubbed');
  assert.equal(result.value, scrubbedEmailFor('nobody@example.com'));
});

test('resolveEmail: a non-email-shaped string passes through unchanged', () => {
  const result = resolveEmail('', normalizeEmailMap({}), true);
  assert.deepEqual(result, { action: 'unchanged', value: '' });
});

test('normalizeEmailMap: lower-cases keys', () => {
  const map = normalizeEmailMap({ 'Real@Example.COM': 'test@example.com' });
  assert.equal(resolveEmail('REAL@example.com', map, false).value, 'test@example.com');
});

test('normalizeEmailMap: refuses a non-object', () => {
  assert.throws(() => normalizeEmailMap([]));
});

test('scrubEmailsDeep: walks nested objects/arrays and resolves every email-shaped string; no source address survives', () => {
  const map = normalizeEmailMap({ 'realaddr@sourcedomain.test': 'scrubbed1@example.com', 'otheraddr@sourcedomain.test': 'scrubbed2@example.com' });
  const input = { list: [{ email: 'realaddr@sourcedomain.test' }, { note: 'no email here' }], top: 'otheraddr@sourcedomain.test' };
  const { value, changed, actions } = scrubEmailsDeep(input, map, false);
  assert.equal(changed, true);
  assert.equal(value.top, 'scrubbed2@example.com');
  assert.equal(value.list[0].email, 'scrubbed1@example.com');
  assert.equal(actions.length, 2);
  const asJson = JSON.stringify(value);
  assert.ok(!asJson.includes('sourcedomain.test'));
});

test('scrubEmailsDeep: refuses when an address inside the tree is unmapped', () => {
  assert.throws(() => scrubEmailsDeep({ e: 'nobody@example.com' }, normalizeEmailMap({}), false), UnmappedEmailError);
});

test('resolveConnectFacts: staging with no account id stays null/false', () => {
  const result = resolveConnectFacts({ chargesEnabled: false, detailsSubmitted: false, payoutsEnabled: false, stripeAccountId: null }, {}, 'staging');
  assert.deepEqual(result, { chargesEnabled: false, detailsSubmitted: false, payoutsEnabled: false, stripeAccountId: null });
});

test('resolveConnectFacts: staging with an unmapped live account id drops to null + false', () => {
  const result = resolveConnectFacts({ chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true, stripeAccountId: 'acct_live_123' }, {}, 'staging');
  assert.deepEqual(result, { chargesEnabled: false, detailsSubmitted: false, payoutsEnabled: false, stripeAccountId: null });
});

test('resolveConnectFacts: staging with a mapped account id keeps the flags and swaps the id', () => {
  const connectMap = normalizeConnectMap({ acct_live_123: 'acct_sandbox_456' });
  const result = resolveConnectFacts({ chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true, stripeAccountId: 'acct_live_123' }, connectMap, 'staging');
  assert.deepEqual(result, { chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true, stripeAccountId: 'acct_sandbox_456' });
});

test('resolveConnectFacts: production carries the live account id verbatim', () => {
  const result = resolveConnectFacts({ chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true, stripeAccountId: 'acct_live_123' }, {}, 'production');
  assert.deepEqual(result, { chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true, stripeAccountId: 'acct_live_123' });
});

test('never a live account id written to staging (property check over a small map)', () => {
  const ids = ['acct_live_a', 'acct_live_b', 'acct_live_c'];
  const connectMap = normalizeConnectMap({ acct_live_a: 'acct_sandbox_a' }); // b and c unmapped
  for (const id of ids) {
    const result = resolveConnectFacts({ chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true, stripeAccountId: id }, connectMap, 'staging');
    assert.ok(result.stripeAccountId === null || result.stripeAccountId !== id, `staging must never keep the live id ${id} verbatim`);
    assert.ok(result.stripeAccountId === null || connectMap[id] === result.stripeAccountId);
  }
});

test('containsFirebaseStorageUrl detects both hosts', () => {
  assert.ok(containsFirebaseStorageUrl('https://firebasestorage.googleapis.com/v0/b/x/o/y'));
  assert.ok(containsFirebaseStorageUrl('https://storage.googleapis.com/bucket/path'));
  assert.ok(!containsFirebaseStorageUrl('https://example.com/logo.png'));
  assert.ok(!containsFirebaseStorageUrl(42));
});

test('removeStorageUrlsDeep removes only Firebase-hosted URLs, reports the paths', () => {
  const identity = {
    faviconUrl: '',
    heroImageUrl: 'https://storage.googleapis.com/bucket/hero.jpg',
    logoUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/logo.png',
    other: 'unrelated',
  };
  const { identity: out, removedPaths } = removeStorageUrlsDeep(identity);
  assert.deepEqual(removedPaths.sort(), ['heroImageUrl', 'logoUrl']);
  assert.ok(!Object.hasOwn(out, 'logoUrl'));
  assert.ok(!Object.hasOwn(out, 'heroImageUrl'));
  assert.equal(out.faviconUrl, ''); // empty string kept, not a Firebase URL
  assert.equal(out.other, 'unrelated');
  assert.ok(Object.hasOwn(identity, 'logoUrl'), 'the input is not changed');
});

test('removeStorageUrlsDeep reaches a gallery: the image URL goes, the rest of the entry stays', () => {
  const identity = {
    gallery: [
      { caption: 'First', imageUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/g1.jpg' },
      { caption: 'Second', imageUrl: 'https://example.com/elsewhere.jpg' },
    ],
    links: ['https://storage.googleapis.com/bucket/a.png', 'https://example.com/b.png'],
    nested: { deep: { url: 'https://firebasestorage.googleapis.com/v0/b/x/o/d.png', width: 3 } },
  };
  const { identity: out, removedPaths } = removeStorageUrlsDeep(identity);
  assert.deepEqual(removedPaths.sort(), ['gallery[0].imageUrl', 'links[0]', 'nested.deep.url']);
  assert.deepEqual(out.gallery, [{ caption: 'First' }, { caption: 'Second', imageUrl: 'https://example.com/elsewhere.jpg' }]);
  assert.deepEqual(out.links, ['https://example.com/b.png']);
  assert.deepEqual(out.nested, { deep: { width: 3 } });
  assert.deepEqual(findFirebaseStorageUrls(out), []);
});

test('findFirebaseStorageUrls finds every occurrence, nested', () => {
  const value = { a: 'https://storage.googleapis.com/x', b: [{ c: 'https://firebasestorage.googleapis.com/y' }, 'clean'] };
  const found = findFirebaseStorageUrls(value);
  assert.equal(found.length, 2);
});

test('FIREBASE_STORAGE_HOSTS is exactly the two named hosts', () => {
  assert.deepEqual(FIREBASE_STORAGE_HOSTS, ['firebasestorage.googleapis.com', 'storage.googleapis.com']);
});
