/**
 * SnapWear A11 — brand-screening matcher: unit cases + client/server PARITY.
 *
 * src/utils/contentScreening.js           (client: the seller's publish notice)
 * functions/src/catalog/contentScreening.ts (server: screenProductOnWrite stamps)
 *
 * Twins for the same reason as printRouting (functions tsconfig rootDir pins
 * src/, no bundler): this suite runs one fixture table through BOTH and fails
 * on any divergence — a seller must never be told "clean" while the server
 * flags, or vice versa. Also unit-tests the server's decideScreening state
 * machine (loop convergence, cleared stickiness, new-shop review, hard block)
 * and productUsesMappingSku (which products the F4 rescreen triggers pick).
 *
 * RUN: npm --prefix functions run build && node rules-tests/content-screening-parity.test.cjs
 */
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const requireFromHere = createRequire(__filename);
const server = requireFromHere('../functions/lib/catalog/contentScreening.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const LIST = [
  { term: 'kent', kind: 'band' },
  { term: 'Håkan Hellström', kind: 'band' },
  { term: 'Djurgården', kind: 'club' },
  { term: 'malmö ff', kind: 'club' },
  { term: 'AC/DC', kind: 'band' },
  { term: 'coca-cola', kind: 'brand' },
  { term: 'pokemon', kind: 'brand' },
  { term: 'louis vuitton', kind: 'brand' },
  { term: 'star wars', kind: 'brand' },
  { term: 'nike', kind: 'brand', hardBlock: true },
  { term: '™', kind: 'other' },
  { term: '®', kind: 'other' },
  'official',            // plain-string entry (hand-edited doc) must not crash
  { term: '   ' },       // blank entry ignored
  null,                  // garbage ignored
];

// [name, product, artworkFileNames, expected hit terms]
const TABLE = [
  ['kent as a word', { name: 'Kent tour 2026 tee' }, [], ['kent']],
  ['kentucky is NOT kent', { name: 'Kentucky fried hoodie' }, [], []],
  ['kent inside a word (kentaur) is NOT kent', { name: 'Kentaur' }, [], []],
  ['å/ä/ö folded: hakan hellstrom', { name: 'hakan hellstrom fan tee' }, [], ['Håkan Hellström']],
  ['å/ä/ö folded: DJURGARDEN', { name: 'DJURGARDEN IF' }, [], ['Djurgården']],
  ['exact diacritics still match', { name: 'Djurgården 1891' }, [], ['Djurgården']],
  ['multi-word term split by punctuation', { name: 'Malmö-FF supporter' }, [], ['malmö ff']],
  ['multi-word term needs both words adjacent', { name: 'Malmö stad, FF' }, [], []],
  ['AC/DC written ac-dc', { name: 'ac-dc back in black' }, [], ['AC/DC']],
  ['AC/DC written acdc is not caught (documented gap)', { name: 'acdc' }, [], []],
  ['coca cola without hyphen', { name: 'Coca Cola retro' }, [], ['coca-cola']],
  ['Pokémon accent folded', { name: 'Pokémon trainer' }, [], ['pokemon']],
  ['description HTML is stripped', { name: 'Tee', descriptions: { b2c: '<p>Inspired by <strong>Star</strong> Wars</p>' } }, [], ['star wars']],
  ['b2cMoreInfo is screened', { name: 'Tee', descriptions: { b2cMoreInfo: 'Louis Vuitton-mönster' } }, [], ['louis vuitton']],
  ['legacy description field', { name: 'Tee', description: 'Official merch' }, [], ['official']],
  ['tags are screened', { name: 'Tee', tags: ['summer', 'Nike'] }, [], ['nike']],
  ['artwork file name is screened', { name: 'Tee' }, ['nike_swoosh_final.png'], ['nike']],
  ['legacy per-locale name object', { name: { 'sv-SE': 'Kent-tröja' } }, [], ['kent']],
  ['™ symbol matched raw', { name: 'Min Logga™ tee' }, [], ['™']],
  ['® symbol matched raw', { name: 'Brand® hoodie' }, [], ['®']],
  ['clean product', { name: 'Blå hoodie med fiskmotiv', tags: ['fiske'] }, ['fisk.png'], []],
  ['several hits keep blocklist order, deduped', { name: 'Nike x Kent', tags: ['kent', 'NIKE'] }, [], ['kent', 'nike']],
  ['entity-encoded text does not glue words', { name: 'Tee', descriptions: { b2c: 'star&nbsp;wars' } }, [], ['star wars']],
  ['ø folded (dodge caught)', { name: 'Tee', tags: ['Pokemøn'] }, [], ['pokemon']],
  ['null product', null, [], []],
];

(async () => {
  const client = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'utils', 'contentScreening.js')).href);

  console.log('\n=== matcher: expected hits + client/server agree ===');
  for (const [name, product, files, expected] of TABLE) {
    const c = client.screenProduct(product, LIST, files);
    const s = server.screenProduct(product, LIST, files);
    ok(eq(c, expected), `client: ${name} → ${JSON.stringify(c)}`);
    ok(eq(s, c), `server == client: ${name}`);
  }

  console.log('\n=== helpers agree ===');
  for (const v of ['Håkan', 'ÆØÅ æøå', 'Straße', 'Łódź', 'Pokémon™', '', null, 42]) {
    ok(client.foldText(v) === server.foldText(v), `foldText(${JSON.stringify(v)}) = ${JSON.stringify(client.foldText(v))}`);
    ok(client.tokenize(v) === server.tokenize(v), `tokenize(${JSON.stringify(v)})`);
  }
  ok(eq(client.normalizeBlocklist(LIST), server.normalizeBlocklist(LIST)), 'normalizeBlocklist agrees');
  ok(client.normalizeBlocklist(LIST).length === 13, 'blank/null entries dropped, plain string kept');
  ok(server.findScreeningHits(['nike'], LIST)[0].hardBlock === true, 'hardBlock flag carried on the hit');
  ok(client.screeningNotice(['nike']).includes("'nike'") && client.screeningNotice(['nike']).includes('granskas av plattformen'), 'seller notice names the term');
  ok(client.screeningNotice([]) === '', 'no hits → no notice');

  console.log('\n=== decideScreening (server trigger state machine) ===');
  const d = server.decideScreening;
  const base = { hardBlock: false, shopPublishedCount: 10, reviewFirstProducts: 2 };

  let r = d({ ...base, prev: null, terms: [] });
  ok(r.screening?.status === 'ok' && !r.deactivate, 'first screen, clean, established shop → ok');
  r = d({ ...base, prev: null, terms: [], shopPublishedCount: 1 });
  ok(r.screening?.status === 'review', 'first screen, clean, shop with 1 live product (< 2) → review');
  r = d({ ...base, prev: null, terms: [], shopPublishedCount: 2 });
  ok(r.screening?.status === 'ok', 'shop with exactly reviewFirstProducts live products → ok');
  r = d({ ...base, prev: null, terms: ['kent'] });
  ok(r.screening?.status === 'flagged' && eq(r.screening.hits, ['kent']), 'hit → flagged with hits');
  r = d({ ...base, prev: null, terms: ['kent'], shopPublishedCount: 0 });
  ok(r.screening?.status === 'flagged', 'hit beats new-shop review');

  // Convergence: the trigger's own write re-fires it with the same input.
  r = d({ ...base, prev: { status: 'flagged', hits: ['kent'] }, terms: ['kent'] });
  ok(r.screening === null && !r.deactivate, 'unchanged hits → no-op (loop converges)');
  r = d({ ...base, prev: { status: 'ok', hits: [] }, terms: [] });
  ok(r.screening === null, 'unchanged clean → no-op');
  r = d({ ...base, prev: { status: 'review', hits: [] }, terms: [], shopPublishedCount: 50 });
  ok(r.screening === null, 'review sticks until the platform clears it');

  r = d({ ...base, prev: { status: 'cleared', hits: ['kent'] }, terms: ['kent'] });
  ok(r.screening === null, 'cleared + same hits → stays cleared');
  r = d({ ...base, prev: { status: 'cleared', hits: ['kent'] }, terms: ['kent', 'nike'] });
  ok(r.screening?.status === 'flagged', 'cleared + NEW term → flagged again');
  r = d({ ...base, prev: { status: 'cleared', hits: ['kent', 'nike'] }, terms: ['kent'] });
  ok(r.screening?.status === 'cleared' && eq(r.screening.earlierHits, ['nike']), 'cleared + subset → stays cleared, dropped term remembered');

  r = d({ ...base, prev: { status: 'flagged', hits: ['kent'] }, terms: [] });
  ok(r.screening?.status === 'flagged' && eq(r.screening.hits, []) && eq(r.screening.earlierHits, ['kent']), 'rename that drops the term stays flagged (dodge still reviewed)');
  r = d({ ...base, prev: { status: 'flagged', hits: [], earlierHits: ['kent'] }, terms: ['kent'] });
  ok(r.screening?.status === 'flagged' && eq(r.screening.hits, ['kent']) && r.screening.earlierHits === undefined, 'term re-added → hits restored, earlierHits emptied');

  r = d({ ...base, prev: null, terms: ['nike'], hardBlock: true });
  ok(r.screening?.status === 'blocked' && r.deactivate === true, 'hard-blocked term → blocked + deactivate');
  r = d({ ...base, prev: { status: 'blocked', hits: ['nike'] }, terms: ['nike'], hardBlock: true });
  ok(r.screening === null && r.deactivate === true, 'seller re-activates a blocked product → switched off again (no stamp churn)');
  r = d({ ...base, prev: { status: 'cleared', hits: ['nike'] }, terms: ['nike'], hardBlock: true });
  ok(r.screening === null && r.deactivate === false, 'platform-cleared hard-block term stays live');
  r = d({ ...base, prev: { status: 'blocked', hits: ['nike'] }, terms: [], hardBlock: false });
  ok(r.screening?.status === 'flagged' && !r.deactivate, 'blocked term renamed away → flagged, not blocked');
  r = d({ ...base, prev: { status: 'taken_down', hits: ['nike'] }, terms: ['nike'], hardBlock: true });
  ok(r.screening === null && !r.deactivate, 'taken_down is the platform\'s state — trigger leaves it');
  r = d({ ...base, prev: { status: 'taken_down', hits: ['nike'] }, terms: ['nike', 'kent'] });
  ok(r.screening?.status === 'taken_down', 'taken_down sticks even when hits change');

  // F4: a cleared, clean product whose mapping switches to artwork named
  // "nike_…png" — the rescreen trigger re-runs this with the new file name.
  r = d({ ...base, prev: { status: 'cleared', hits: [] }, terms: ['nike'] });
  ok(r.screening?.status === 'flagged' && eq(r.screening.hits, ['nike']) && !r.deactivate, 'F4: cleared + clean → new artwork name hits → flagged');
  r = d({ ...base, prev: { status: 'cleared', hits: [] }, terms: ['nike'], hardBlock: true });
  ok(r.screening?.status === 'blocked' && r.deactivate === true, 'F4: same with a hard-blocked term → blocked + deactivate');

  console.log('\n=== productUsesMappingSku (which products a podMappings row feeds) ===');
  const u = server.productUsesMappingSku;
  const tee = { sku: 'TEE-1', variantGroups: [{ sku: 'TEE-1-BLK' }, { sku: 'TEE-1-WHT' }] };
  ok(u(tee, 'TEE-1') === true, 'parent sku matches');
  ok(u(tee, 'TEE-1-WHT') === true, 'variantGroups sku matches');
  ok(u(tee, 'TEE-2') === false, 'other sku → no match');
  ok(u(tee, 'TEE') === false && u(tee, 'tee-1') === false, 'exact match only (no prefix, case-sensitive)');
  ok(u({ sku: 'A' }, 'A') === true && u({ sku: 'A' }, 'B') === false, 'missing variantGroups → parent only');
  ok(u({ sku: 'A', variantGroups: 'garbage' }, 'A') === true, 'non-array variantGroups ignored');
  ok(u({ sku: 'A', variantGroups: [null, 5, {}, { sku: null }] }, 'null') === false, 'garbage groups dropped, not stringified');
  ok(u(tee, null) === false && u(tee, undefined) === false && u(tee, '') === false, 'sku null/undefined/empty → false');
  ok(u({ variantGroups: [{ sku: 'V' }] }, 'V') === false, 'no parent sku → no lookup → false (mirrors artworkFileNames)');
  ok(u(null, 'A') === false, 'null product → false');
  ok(u({ sku: 123 }, '123') === true && u(tee, 42) === false, 'product sku stringified like the lookup; non-string mapping sku never matches');
  const many = { sku: 'P', variantGroups: Array.from({ length: 40 }, (_, i) => ({ sku: `V${i}` })) };
  ok(server.productMappingSkus(many).length === 30 && u(many, 'V28') === true && u(many, 'V29') === false,
    'capped at 30 like the `in` lookup');
  ok(eq(server.productMappingSkus({ sku: 'A', variantGroups: [{ sku: 'A' }, { sku: 'B' }] }), ['A', 'B']), 'deduped, parent first');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('Harness error:', e); process.exit(2); });
