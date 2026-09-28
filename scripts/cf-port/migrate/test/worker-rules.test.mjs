/**
 * lib/worker-rules.mjs: the importer runs the Worker's OWN rules, bundled from
 * cloudflare/src, not a copy. Pinned here: every name is exported, the rules
 * answer the vectors the Worker's own tests pin (cloudflare/test/
 * admin-products.test.ts "the address rule"), and the bundle is the same
 * bytes run after run. Plus the small money and scrub helpers of the
 * catalogue transforms.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bundleWorkerRules, loadWorkerRules, WORKER_RULE_EXPORTS } from '../lib/worker-rules.mjs';
import { krToMinorExact, makeTextScrubber } from '../lib/transform-products.mjs';
import { UnmappedEmailError } from '../lib/scrub.mjs';

const rules = await loadWorkerRules();

test('every rule the importer names is exported by the bundled Worker source', () => {
  for (const names of Object.values(WORKER_RULE_EXPORTS)) {
    for (const name of names) assert.notEqual(rules[name], undefined, `${name} is missing from the Worker bundle`);
  }
});

test('the bundle is deterministic: the same tree gives the same bytes', () => {
  assert.equal(bundleWorkerRules(), bundleWorkerRules());
});

test('slugify and productHandle answer the vectors the Worker\'s own suite pins for the importer', () => {
  for (const [input, expected] of [
    ['Vitlökssill (300g)', 'vitlokssill-300g'],
    ['  Trimmed  Name  ', 'trimmed-name'],
    ['Räkor & Sill', 'rakor-and-sill'],
    ["Åsa's Öl", 'asas-ol'],
    ['ÅÄÖ', 'aao'],
    ['Crème brûlée', 'crme-brle'],
    ['a_b', 'a_b'],
    ['--x--', '-x-'],
    ['Hoodie – Svart', 'hoodie-svart'],
    ['!!!', ''],
  ]) {
    assert.equal(rules.slugify(input), expected, input);
  }
  assert.equal(rules.productHandle('Minbutik Vasskydd', '6', 'ABC-6-GL'), 'minbutik-vasskydd-6_ABC-6-GL');
  assert.equal(rules.productHandle('Tee', null, 'tee-1'), 'tee_tee-1');
  assert.equal(rules.productHandle('!!!', null, 'X'), '_X');
  assert.equal(rules.productHandle('Tee', null, 'A/B'), 'tee_A-B');
  assert.equal(rules.productPath('tee_A B(1)'), '/product/tee_A%20B%281%29');
});

test('the refusing rules are the Worker\'s: checkHtml, the collection handle, the page slug, the identity parser', () => {
  assert.deepEqual(rules.checkHtml('<p>ok</p>'), { ok: true });
  assert.equal(rules.checkHtml('<script>x</script>').ok, false);
  assert.equal(rules.checkHtml('<a href="about:blank">x</a>').reason, 'unsafe_address');
  assert.equal(rules.isCollectionHandle('ny-het'), true);
  assert.equal(rules.isCollectionHandle('Ny het'), false);
  assert.ok(rules.RESERVED_PAGE_SLUGS.includes('produkter'));
  assert.equal(rules.parsePageInput({ content: { 'sv-SE': '<p>x</p>' }, slug: 'kategori', title: { 'sv-SE': 'x' } }, 'create').status, 'reserved_slug');
  assert.equal(rules.parseStoreSettingsInput({ storeIdentity: { logoObjectId: 'not an id!' } }).status, 'invalid');
  assert.equal(rules.parseStoreSettingsInput({ storeIdentity: { logoObjectId: 'obj-1' } }).status, 'ok');
  assert.equal(rules.isSourceStorageAddress('gs://bucket/x.png'), true);
  assert.equal(rules.isSourceStorageAddress('https://files.example.test/x.png'), false);
  assert.equal(rules.parseCreateProductInput({ currency: 'SEK', name: 'x', priceMinor: -1, sku: 'x' }), null);
  assert.equal(rules.MAX_PRODUCT_IMAGES, 30);
});

test('kronor become öre only when exact; nothing is rounded', () => {
  assert.equal(krToMinorExact(19.9), 1990);
  assert.equal(krToMinorExact(0), 0);
  assert.equal(krToMinorExact(149.5), 14950);
  assert.equal(krToMinorExact(99.999), null);
  assert.equal(krToMinorExact(-1), null);
  assert.equal(krToMinorExact('100'), null);
  assert.equal(krToMinorExact(Number.NaN), null);
});

test('a text\'s e-mail addresses go through the map, the placeholder, or refuse; the message never holds the address', () => {
  const mapped = makeTextScrubber({ emailMap: { 'a@example.com': 'b@example.com' }, scrubUnmapped: false });
  assert.equal(mapped.scrub('Write to a@example.com.', 'x'), 'Write to b@example.com.');
  assert.deepEqual(mapped.actions, { mapped: 1, scrubbed: 0 });
  assert.throws(() => mapped.scrub('c@example.com', 'products/p.description'), (error) => error instanceof UnmappedEmailError && !error.message.includes('c@example.com'));
  const scrubbed = makeTextScrubber({ emailMap: {}, scrubUnmapped: true });
  assert.match(scrubbed.scrub('<a href="mailto:c@example.com">c@example.com</a>', 'x'), /^<a href="mailto:scrubbed\+[0-9a-f]{12}@example\.com">scrubbed\+[0-9a-f]{12}@example\.com<\/a>$/);
  assert.equal(scrubbed.scrub('a link https://www.tiktok.com/@name.surname', 'x'), 'a link https://www.tiktok.com/@name.surname');
});
