// PlatformPrinters' admin-build data module (unit FK), end to end against the
// dev API under Node: fetch is routed into dev-api.mjs's route(), and the
// payloads are built by the page's own form code (printerTierForm.js).
//   node --test src/admin-app/replacements/platformPrintersData.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { docToForm, formToPricing, formToPrintAreas } from '../../components/platform/printerTierForm.js';
import { POD_GARMENTS } from '../../config/podGarments.js';
import { createState, route } from '../dev/dev-api.mjs';
import { setRequestShopId } from '../../api/admin/client.js';
import {
  CREATE_ACCOUNT,
  ROUTE_BY_GARMENT,
  createPrintShopAccount,
  loadPrinters,
  savePrintRouting,
  savePrinterTier,
  setPrinterActive,
  tierEditorNote,
} from './platformPrintersData.js';

const realFetch = globalThis.fetch;
let state;
let cookie;
let sent;

function useDevApi(extraCookie = '') {
  state = createState();
  const signIn = route(state, 'POST', new URL('http://dev.invalid/_api/api/auth/sign-in/email'), {}, { email: 'platform@example.com', password: 'dev-password-2' });
  cookie = signIn.setCookie.split(';')[0] + (extraCookie ? `; ${extraCookie}` : '');
  globalThis.fetch = async (url, init = {}) => {
    const headers = { cookie, ...Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])) };
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    sent.push({ url, method: init.method, headers, body });
    const answer = route(state, init.method || 'GET', new URL(url, 'http://dev.invalid'), headers, body);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
}

/** The page's saveTier payload for a form. */
function payloadOf(form) {
  const garments = POD_GARMENTS.filter((g) => form.garments.has(g.id)).map((g) => g.id);
  return {
    name: 'ignored', active: true, // the page sends them; nothing of them is written
    garments,
    pricing: formToPricing(form),
    printAreasMm: formToPrintAreas(form),
    provisionalAreas: garments.filter((g) => form.provisional.has(g)),
  };
}

beforeEach(() => {
  sent = [];
  setRequestShopId('test-shop-a'); // a shop active in the tab: never sent on these routes
  useDevApi();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

const noShop = () => sent.every((r) => !('x-shop-id' in r.headers));

describe('what leaves', () => {
  it('no print-shop accounts and no routing per garment', async () => {
    assert.equal(CREATE_ACCOUNT, false);
    assert.equal(ROUTE_BY_GARMENT, false);
    await assert.rejects(createPrintShopAccount({ email: 'x@example.com' }), (e) => e.code === 'not_available');
    await assert.rejects(savePrintRouting({ byGarment: { tee: 'fake-printer' }, defaultPrinterUid: null }), (e) => /Styrning per plagg/.test(e.userMessage));
    assert.equal(sent.length, 0);
  });
});

describe('load', () => {
  it('every printer as the page\'s doc, no shops, no accounts, the default as the routing', async () => {
    const loaded = await loadPrinters();
    assert.deepEqual(loaded.shops, []);
    assert.deepEqual(loaded.printers, []);
    assert.deepEqual(Object.keys(loaded.tiers), ['fake-printer', 'handtryck-exempel', 'supplier-import']);
    assert.deepEqual(loaded.routing, { byGarment: {}, defaultPrinterUid: 'fake-printer' });
    const fake = loaded.tiers['fake-printer'];
    assert.equal(fake.type, 'api');
    assert.equal(fake.active, true);
    assert.deepEqual(fake.garments, ['tee', 'hoodie']);
    assert.equal(tierEditorNote(fake), null);
    assert.match(tierEditorNote(loaded.tiers['handtryck-exempel']), /T-shirt \(blankpris\).*T-shirt bröst \(tryckyta\)/);
    assert.ok(noShop());
  });
});

describe('the tier editor', () => {
  it('an untouched save sends nothing; a changed price is saved, re-read and fenced', async () => {
    const { tiers } = await loadPrinters();
    const before = tiers['fake-printer'];
    sent = [];
    const same = await savePrinterTier({ id: 'fake-printer' }, payloadOf(docToForm(before)), before);
    assert.equal(same.doc, before);
    assert.equal(sent.length, 0);

    const form = docToForm(before);
    form.blank.tee = '49';
    const saved = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'PATCH');
    assert.equal(sent[0].body.expectedRevision, 3);
    assert.equal(saved.doc.revision, 4);
    assert.equal(saved.doc.pricing.blankCostSek.tee, 49);
    assert.equal(saved.note, null);
    assert.equal((await loadPrinters()).tiers['fake-printer'].pricing.blankCostSek.tee, 49);
    assert.ok(noShop());

    // The page now holds the new doc; a second save from it is fenced on 4, not 3.
    form.blank.tee = '50';
    const again = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), saved.doc);
    assert.equal(again.doc.revision, 5);
  });

  it('a save from a stale page is refused in Swedish (409 revision_mismatch)', async () => {
    const { tiers } = await loadPrinters();
    const stale = tiers['fake-printer'];
    await setPrinterActive({ id: 'fake-printer', active: true }); // someone else's edit: revision 4
    const form = docToForm(stale);
    form.blank.tee = '49';
    await assert.rejects(savePrinterTier({ id: 'fake-printer' }, payloadOf(form), stale), (e) => /Ladda om sidan/.test(e.userMessage));
  });

  it('removing a frame says how many product mappings were paused', async () => {
    const before = (await loadPrinters()).tiers['fake-printer'];
    const form = docToForm(before);
    form.areas.tee.back = { w: '', h: '', top: '' };
    const saved = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before);
    assert.match(saved.note, /^1 produktkoppling pausades/);
    assert.deepEqual(Object.keys(saved.doc.printAreasMm.tee), ['front']);
  });

  it('the floor report reaches the note', async () => {
    useDevApi('admin_dev_fk=floor');
    const before = (await loadPrinters()).tiers['fake-printer'];
    const form = docToForm(before);
    form.print.front = '40';
    const saved = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before);
    assert.equal(saved.note, '2 produkter ligger nu under prisgolvet.');
  });

  it('a mixed printer: an untouched mixed field is kept per SKU', async () => {
    const before = (await loadPrinters()).tiers['handtryck-exempel'];
    const form = docToForm(before);
    form.print.front = '27';
    const saved = await savePrinterTier({ id: 'handtryck-exempel' }, payloadOf(form), before);
    const blanks = Object.fromEntries(saved.doc.view.tiers.map((t) => [t.sku, t.blankCostMinor]));
    assert.deepEqual(blanks, { 'HT-TEE-C': 5200, 'HT-TEE-F': 5900 });
    assert.deepEqual(saved.doc.view.tiers.map((t) => t.printCostsMinor.front), [2700, 2700]);
    const frames = saved.doc.view.capabilities.models;
    assert.equal(frames['tee-classic'].printAreasMm.front.w, 250);
    assert.equal(frames['tee-fitted'].printAreasMm.front.w, 230);
  });

  it('the editor\'s own refusals send nothing', async () => {
    const before = (await loadPrinters()).tiers['fake-printer'];
    sent = [];
    const form = docToForm(before);
    form.garments.add('cap');
    await assert.rejects(savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before), (e) => /Keps finns inte i tryckeriets katalog/.test(e.userMessage));
    assert.equal(sent.length, 0);
  });
});

describe('status and the default printer', () => {
  it('activate, deactivate; a printer not of this environment is refused in Swedish', async () => {
    await setPrinterActive({ id: 'handtryck-exempel', active: false });
    assert.equal((await loadPrinters()).tiers['handtryck-exempel'].active, true);
    await assert.rejects(setPrinterActive({ id: 'supplier-import', active: false }), (e) => /inte miljöns tryckeri/.test(e.userMessage));
  });

  it('sets and clears the default; an inactive one is refused in Swedish', async () => {
    await savePrintRouting({ byGarment: {}, defaultPrinterUid: null });
    assert.equal((await loadPrinters()).routing.defaultPrinterUid, null);
    await assert.rejects(savePrintRouting({ byGarment: {}, defaultPrinterUid: 'supplier-import' }), (e) => /aktivt/.test(e.userMessage));
    await savePrintRouting({ byGarment: {}, defaultPrinterUid: 'fake-printer' });
    assert.equal((await loadPrinters()).routing.defaultPrinterUid, 'fake-printer');
    assert.ok(noShop());
  });

  it('a read that fails is not given a page text (the page shows its own)', async () => {
    useDevApi('admin_dev_fk=error');
    await assert.rejects(loadPrinters(), (e) => e.status === 500 && e.userMessage === undefined);
  });
});
