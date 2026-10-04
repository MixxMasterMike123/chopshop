// The data modules of the CP5-FL pages, end to end against the dev API under
// Node: fetch is routed into dev-api.mjs's route(), with the dev scenarios
// (cookie admin_dev_fl) for a lost answer, a write not done, an unclear
// outcome, a conflict and a stale value.
//   node --test src/admin-app/pages/new/pagesData.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from '../../../api/admin/client.js';
import { createState, route } from '../../dev/dev-api.mjs';
import { SEED_TEXT } from '../../dev/platform-settings-dev.mjs';
import { newTermBody } from '../../adapters/platformSettings.js';
import { parseTermsText } from '../../adapters/termsVersions.js';
import {
  addTerm, freshSettingsFor, loadGlobalHardBlock, loadScreening, loadSettings, loadTerms, removeTerm, runRescreen, saveSettings, updateTerm,
} from './platformSettingsData.js';
import { archiveText, currentVersionOf, loadVersionText, loadVersions, publishVersion, startingDocuments, textOfFile } from './termsVersionsData.js';
import { findForward, loadForwards, removeForward, saveForward } from './redirectsData.js';

const realFetch = globalThis.fetch;
let state;
let session;
let cookie;
let sent;

function scenario(name = '') {
  cookie = session + (name ? `; admin_dev_fl=${name}` : '');
}

function signIn(email, password) {
  const answer = route(state, 'POST', new URL('http://dev.invalid/_api/api/auth/sign-in/email'), {}, { email, password });
  session = answer.setCookie.split(';')[0];
  scenario();
}

beforeEach(() => {
  sent = [];
  state = createState();
  globalThis.fetch = async (url, init = {}) => {
    const headers = { cookie, ...Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])) };
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    sent.push({ url, method: init.method || 'GET', headers, body });
    const answer = route(state, init.method || 'GET', new URL(url, 'http://dev.invalid'), headers, body);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

const writes = () => sent.filter((s) => s.method !== 'GET');

describe('the platform settings', () => {
  beforeEach(() => {
    signIn('platform@example.com', 'dev-password-2');
    setRequestShopId('test-shop-a'); // a shop active in the tab: never sent on a platform route
  });

  it('reads every value; a PATCH answers the stored settings; nothing carries X-Shop-Id', async () => {
    const s = await loadSettings();
    assert.equal(s.defaultCommissionBps, 500);
    const fresh = await freshSettingsFor(s, { defaultCommissionBps: 650 });
    assert.equal(fresh.defaultCommissionBps, 500);
    const answer = await saveSettings({ defaultCommissionBps: 650 });
    assert.equal(answer.settings.defaultCommissionBps, 650);
    assert.equal(answer.readBack, false);
    assert.ok(sent.every((r) => !('x-shop-id' in r.headers)));
  });

  it('a value someone else changed stops the change before the confirm, with the value now', async () => {
    const s = await loadSettings();
    scenario('stale');
    await assert.rejects(freshSettingsFor(s, { defaultCommissionBps: 650 }), (e) =>
      /ändrats av någon annan/.test(e.userMessage) && e.fresh.defaultCommissionBps === 525);
    assert.equal(writes().length, 0);
  });

  it('the hard block answers the server\'s counts', async () => {
    const answer = await saveSettings({ screeningHardBlock: true });
    assert.equal(answer.settings.screeningHardBlock, true);
    assert.ok(Number.isInteger(answer.rescreen.blockedNow));
    assert.equal(answer.settings.screeningTermsVersion, 15);
  });

  it('lost: read back and found saved; drop: read back and told not saved; unclear: told to reload', async () => {
    scenario('lost');
    const saved = await saveSettings({ reviewFirstProducts: 3 });
    assert.deepEqual([saved.settings.reviewFirstProducts, saved.readBack], [3, true]);
    scenario('drop');
    await assert.rejects(saveSettings({ reviewFirstProducts: 4 }), (e) => e.userMessage === 'Anslutningen bröts och ändringen sparades inte. Försök igen.' && e.fresh.reviewFirstProducts === 3);
    scenario('unclear');
    await assert.rejects(saveSettings({ reviewFirstProducts: 4 }), (e) => /oklart om ändringen sparades\. Ladda om sidan/.test(e.userMessage));
  });

  it('a refusal is a Swedish sentence (a pinned field, a conflict)', async () => {
    await assert.rejects(saveSettings({ refundApplicationFee: true }), (e) => /låst i koden/.test(e.userMessage));
    scenario('conflict');
    await assert.rejects(saveSettings({ screeningHardBlock: true }), (e) => /Ladda om sidan och försök igen/.test(e.userMessage));
  });

  it('a read that fails says so', async () => {
    scenario('error');
    await assert.rejects(loadSettings(), (e) => /Inställningarna kunde inte läsas: servern svarade med ett fel \(HTTP 500\)/.test(e.userMessage));
  });
});

describe('the brand filter', () => {
  beforeEach(() => signIn('platform@example.com', 'dev-password-2'));

  it('lists every term with the version; add, change and remove answer the server\'s term and counts', async () => {
    const { terms, termsVersion } = await loadTerms();
    assert.equal(terms.length, 8);
    assert.equal(termsVersion, 14);
    const added = await addTerm(newTermBody({ term: 'Ny Artist!', kind: 'band', hardBlock: true, note: '' }).body, terms);
    assert.equal(added.term.term, 'ny artist'); // the server's stored form
    assert.equal(added.rescreen.blockedNow, 2);
    const changed = await updateTerm(added.term, { hardBlock: false, note: 'n' });
    assert.deepEqual([changed.term.hardBlock, changed.term.note], [false, 'n']);
    assert.equal((await removeTerm(added.term)).readBack, false);
    assert.equal((await loadTerms()).terms.length, 8);
    assert.ok(sent.every((r) => !('x-shop-id' in r.headers)));
  });

  it('lost answers are read back by the list: the one new term, the named fields, the absence', async () => {
    const { terms } = await loadTerms();
    scenario('lost');
    const body = newTermBody({ term: 'Ny Artist', kind: 'band', hardBlock: false, note: '' }).body;
    const added = await addTerm(body, terms);
    assert.deepEqual([added.term.term, added.readBack], ['ny artist', true]);
    const changed = await updateTerm(added.term, { kind: 'brand' });
    assert.deepEqual([changed.term.kind, changed.readBack], ['brand', true]);
    assert.equal((await removeTerm(added.term)).readBack, true);
  });

  it('drop: not done and said so; unclear: told to reload; a duplicate and a full filter are refused', async () => {
    const { terms } = await loadTerms();
    const body = newTermBody({ term: 'Ny Artist', kind: 'band', hardBlock: false, note: '' }).body;
    scenario('drop');
    await assert.rejects(addTerm(body, terms), (e) => e.userMessage === 'Anslutningen bröts och ordet lades inte till. Försök igen.');
    await assert.rejects(removeTerm(terms[0]), (e) => e.userMessage === 'Anslutningen bröts och ordet togs inte bort. Försök igen.');
    scenario('unclear');
    await assert.rejects(addTerm(body, terms), (e) => /oklart om ordet lades till/.test(e.userMessage));
    scenario('');
    await assert.rejects(addTerm({ ...body, term: 'GLIMMERKRAFT' }, terms), (e) => /redan ett ord/.test(e.userMessage));
    scenario('full');
    await assert.rejects(addTerm(body, terms), (e) => /Filtret är fullt/.test(e.userMessage));
  });

  it('a lost add while someone else adds a term alike in kind, flag and note: unclear, never a success', async () => {
    const { terms } = await loadTerms();
    await addTerm(newTermBody({ term: 'Annan Artist', kind: 'band', hardBlock: false, note: '' }).body, terms); // the other operator
    scenario('drop');
    const body = newTermBody({ term: 'Ny Artist', kind: 'band', hardBlock: false, note: '' }).body;
    await assert.rejects(addTerm(body, terms), (e) => /oklart om ordet lades till/.test(e.userMessage));
    scenario('lost'); // this time it is stored: told by the term itself, beside the other's
    assert.deepEqual([(await addTerm(body, terms)).term.term, (await loadTerms()).terms.length], ['ny artist', 10]);
  });

  it('the global hard block is read as the server holds it; a settings read that fails leaves it NOT KNOWN, never "off"', async () => {
    assert.equal((await loadScreening()).globalHardBlock, false);
    await saveSettings({ screeningHardBlock: true });
    assert.equal(await loadGlobalHardBlock(), true);
    const routed = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => (String(url).includes('/v1/platform/settings')
      ? new Response(JSON.stringify({ error: { code: 'internal_error', message: 'x' } }), { status: 500 })
      : routed(url, init));
    const page = await loadScreening(); // the terms still load: the page shows them, locked
    assert.deepEqual([page.terms.length, page.termsVersion > 0, page.globalHardBlock], [8, true, null]);
    assert.equal(await loadGlobalHardBlock(), null);
    globalThis.fetch = async (url, init = {}) => (String(url).includes('/v1/platform/settings')
      ? new Response(JSON.stringify({ settings: { defaultCommissionBps: 500 } }), { status: 200 })
      : routed(url, init));
    assert.equal(await loadGlobalHardBlock(), null); // an answer without the value is not "off" either
  });

  it('a term someone removed meanwhile: the change is refused with a reload', async () => {
    const { terms } = await loadTerms();
    await removeTerm(terms[0]);
    await assert.rejects(updateTerm(terms[0], { note: 'x' }), (e) => /tagit bort det/.test(e.userMessage));
  });

  it('a re-screen run answers its counts; a lost one says it may have run', async () => {
    const first = await runRescreen();
    assert.deepEqual(first, { pending: 12, rescreened: 25, unverified: 2 });
    scenario('lost');
    await assert.rejects(runRescreen(), (e) => /oklart om omgranskningen kördes/.test(e.userMessage));
  });
});

describe('the terms versions', () => {
  beforeEach(() => signIn('platform@example.com', 'dev-password-2'));

  it('the seed without text is current; a new version then starts empty', async () => {
    const rows = await loadVersions();
    assert.deepEqual(rows.map((r) => [r.version, r.state, r.textArchived]), [['2026-09-07', 'current', false], ['2026-06-01', 'superseded', true]]);
    assert.equal((await loadVersionText('2026-09-07')).text, null);
    assert.deepEqual(await startingDocuments('2026-09-07'), { terms: '', dpa: '', fromCurrent: false });
    assert.equal((await startingDocuments('2026-06-01')).fromCurrent, true);
  });

  it('archives the exact text of the seed: another text is refused by its hash; a lost answer is read back', async () => {
    await assert.rejects(archiveText('2026-09-07', 'en annan text'), (e) => /kontrollsumma/.test(e.userMessage));
    await assert.rejects(archiveText('2026-09-07', ''), (e) => /Klistra in texten/.test(e.userMessage));
    scenario('lost');
    const answer = await archiveText('2026-09-07', textOfFile(JSON.stringify({ text: SEED_TEXT })));
    assert.equal(answer.created, true);
    scenario('');
    const held = await loadVersionText('2026-09-07');
    assert.equal(held.text, SEED_TEXT);
    assert.ok(held.parsed.terms.length > 1000);
    assert.equal(textOfFile('plain'), 'plain');
    assert.equal(textOfFile('{"text":"x","other":1}'), '{"text":"x","other":1}');
  });

  it('publishes now in the seller\'s format; the list then has it as current', async () => {
    const rows = await loadVersions();
    assert.equal(currentVersionOf(rows), '2026-09-07');
    const published = await publishVersion({ version: 'v-test', terms: '## Villkor', dpa: '## Avtal' }, '2026-09-07');
    assert.equal(published.version, 'v-test');
    const post = writes().find((w) => w.method === 'POST');
    assert.deepEqual(Object.keys(post.body), ['version', 'text']); // no publishedAt: now
    assert.deepEqual(parseTermsText(post.body.text), { terms: '## Villkor', dpa: '## Avtal' });
    const after = await loadVersions();
    assert.deepEqual(after.map((r) => [r.version, r.state]), [['v-test', 'current'], ['2026-09-07', 'superseded'], ['2026-06-01', 'superseded']]);
    assert.deepEqual((await startingDocuments('v-test')), { terms: '## Villkor', dpa: '## Avtal', fromCurrent: true });
  });

  it('a taken name is refused before sending; a lost publish is read back; a dropped one is not published', async () => {
    await assert.rejects(publishVersion({ version: '2026-09-07', terms: 'T', dpa: 'D' }, '2026-09-07'), (e) => /redan en version/.test(e.userMessage));
    assert.equal(writes().length, 0);
    scenario('lost');
    assert.equal((await publishVersion({ version: 'v-lost', terms: 'T', dpa: 'D' }, '2026-09-07')).version, 'v-lost');
    await new Promise((r) => setTimeout(r, 5)); // a new version must be published strictly after the latest
    scenario('drop');
    await assert.rejects(publishVersion({ version: 'v-drop', terms: 'T', dpa: 'D' }, 'v-lost'), (e) => e.userMessage === 'Anslutningen bröts och versionen publicerades inte. Försök igen.');
    // unclear: the answer AND the read-back are lost (the list before the request was still readable)
    const routed = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === 'POST') scenario('unclear');
      return routed(url, init);
    };
    scenario('');
    await assert.rejects(publishVersion({ version: 'v-unclear', terms: 'T', dpa: 'D' }, 'v-lost'), (e) => /oklart om versionen publicerades/.test(e.userMessage));
  });

  it('a version that came into force after the confirm was written: nothing is sent, the error carries the version now', async () => {
    assert.equal(currentVersionOf(await loadVersions()), '2026-09-07'); // what the page loaded
    await publishVersion({ version: 'v-other', terms: 'T', dpa: 'D' }, '2026-09-07'); // another operator publishes
    await new Promise((r) => setTimeout(r, 5));
    const before = writes().length;
    let refusal;
    await assert.rejects(publishVersion({ version: 'v-mine', terms: 'T', dpa: 'D' }, '2026-09-07'), (e) => { refusal = e; return true; });
    assert.equal(writes().length, before); // no POST
    assert.match(refusal.userMessage, /Version v-other har börjat gälla sedan bekräftelsen skrevs\. Ingenting är publicerat/);
    assert.deepEqual([refusal.currentMoved, refusal.current, currentVersionOf(refusal.rows)], [true, 'v-other', 'v-other']);
    // Confirmed again on the version now in force, it goes through.
    assert.equal((await publishVersion({ version: 'v-mine', terms: 'T', dpa: 'D' }, refusal.current)).version, 'v-mine');
    // No version in force and a confirm that named one (and the reverse) is the same refusal.
    scenario('empty');
    await assert.rejects(publishVersion({ version: 'v-none', terms: 'T', dpa: 'D' }, 'v-mine'), (e) => e.currentMoved === true && e.current === null && /Ingen version gäller längre/.test(e.userMessage));
    scenario('');
    await assert.rejects(publishVersion({ version: 'v-none', terms: 'T', dpa: 'D' }, null), (e) => e.currentMoved === true && e.current === 'v-mine');
  });

  it('a list that cannot be read before a publish: nothing is sent', async () => {
    scenario('error');
    await assert.rejects(publishVersion({ version: 'v-x', terms: 'T', dpa: 'D' }, '2026-09-07'), (e) => /Villkorsversionerna kunde inte läsas/.test(e.userMessage));
    assert.equal(writes().length, 0);
  });

  it('without the archive (dark), the text and the publish are refused in words', async () => {
    scenario('dark');
    await assert.rejects(loadVersionText('2026-05-01'), (e) => /villkorsarkivet inte påslaget/.test(e.userMessage)); // a text never cached
    await assert.rejects(publishVersion({ version: 'v-dark', terms: 'T', dpa: 'D' }, '2026-09-07'), (e) => /villkorsarkivet/.test(e.userMessage));
  });
});

describe('the shop\'s forwards', () => {
  beforeEach(() => {
    signIn('admin@example.com', 'dev-password-1');
    setRequestShopId('test-shop-a');
  });

  it('lists a page; saves in the stored form; removes; every call names the shop', async () => {
    const page = await loadForwards('test-shop-a');
    assert.equal(page.redirects.length, 8);
    assert.equal(page.redirects[0].fromPath, '/blogs/nyheter/hostens-kollektion');
    const { forward } = await saveForward('test-shop-a', { fromPath: '/Gamla/%C3%A5r/', toPath: '/samling/år' });
    assert.deepEqual([forward.fromPath, forward.toPath], ['/Gamla/år', '/samling/år']);
    assert.ok(await findForward('test-shop-a', '/Gamla/år'));
    await removeForward('test-shop-a', '/Gamla/år');
    assert.equal(await findForward('test-shop-a', '/Gamla/år'), null);
    assert.ok(sent.every((r) => r.headers['x-shop-id'] === 'test-shop-a'));
  });

  it('the server\'s refusals as sentences: reserved, a chain, an address outside the shop', async () => {
    await assert.rejects(saveForward('test-shop-a', { fromPath: '/cart', toPath: '/x' }), (e) => /varukorg, kassa/.test(e.userMessage));
    await assert.rejects(saveForward('test-shop-a', { fromPath: '/x', toPath: '/collections/all' }), (e) => /kedja/.test(e.userMessage));
    await assert.rejects(saveForward('test-shop-a', { fromPath: '/x', toPath: 'https://annan.example' }), (e) => /Utan domän/.test(e.userMessage));
    await assert.rejects(saveForward('test-shop-a', { fromPath: ' ', toPath: '/x' }), (e) => /Fyll i både/.test(e.userMessage));
  });

  it('lost answers are read back through the list (also past a page), drop is said, unclear says reload', async () => {
    scenario('lost');
    assert.equal((await saveForward('test-shop-a', { fromPath: '/products/😀-tee-2', toPath: '/product/x' })).readBack, true);
    assert.equal((await removeForward('test-shop-a', '/products/😀-tee-2')).readBack, true);
    scenario('many');
    assert.equal((await loadForwards('test-shop-a')).nextCursor !== null, true);
    assert.ok(await findForward('test-shop-a', '/products/exempel-230'));
    scenario('drop');
    await assert.rejects(saveForward('test-shop-a', { fromPath: '/ny', toPath: '/x' }), (e) => e.userMessage === 'Anslutningen bröts och omdirigeringen sparades inte. Försök igen.');
    await assert.rejects(removeForward('test-shop-a', '/collections/all'), (e) => e.userMessage === 'Anslutningen bröts och omdirigeringen togs inte bort. Försök igen.');
    scenario('unclear');
    await assert.rejects(saveForward('test-shop-a', { fromPath: '/ny', toPath: '/x' }), (e) => /oklart om omdirigeringen sparades/.test(e.userMessage));
  });

  it('an answer that arrives after the tab moved to another shop is dropped, never shown', async () => {
    const pending = loadForwards('test-shop-a');
    setRequestShopId('test-shop-b');
    const outcome = await Promise.race([pending.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('dropped'), 50))]);
    assert.equal(outcome, 'dropped');
  });

  it('another shop\'s forwards are its own', async () => {
    signIn('admin-c@example.com', 'dev-password-4');
    setRequestShopId('test-shop-c');
    assert.deepEqual((await loadForwards('test-shop-c')).redirects, []);
  });
});
