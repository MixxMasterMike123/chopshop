// PlatformPrinters' admin-build data module (unit FK; the save's dry run, unit
// CP5-FP), end to end against the dev API under Node: fetch is routed into
// dev-api.mjs's route(), and the payloads are built by the page's own form
// code (printerTierForm.js).
//   node --test src/admin-app/replacements/platformPrintersData.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { docToForm, formToPricing, formToPrintAreas } from '../../components/platform/printerTierForm.js';
import { POD_GARMENTS } from '../../config/podGarments.js';
import { createState, route } from '../dev/dev-api.mjs';
import { setRequestShopId } from '../../api/admin/client.js';
import { printerDocOf, printerPatchOf } from '../adapters/platformPrinters.js';
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
    const asked = [];
    const saved = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before, { confirmPreview: (text) => asked.push(text) });
    // The dry run first, then the write fenced on its revision; nothing to warn about, so nothing is asked.
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((r) => [r.method, r.body.dryRun, r.body.expectedRevision]), [['PATCH', true, 3], ['PATCH', undefined, 3]]);
    assert.deepEqual(asked, []);
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

  it('a save from a stale page is laid over the printer as stored now, and says so (409 revision_mismatch)', async () => {
    const { tiers } = await loadPrinters();
    const stale = tiers['fake-printer'];
    await setPrinterActive({ id: 'fake-printer', active: true }); // someone else's edit: revision 4, inactive
    const form = docToForm(stale);
    form.blank.tee = '49';
    const saved = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), stale, { confirmPreview: () => true });
    assert.equal(saved.doc.revision, 5);
    assert.equal(saved.doc.active, false, 'the other edit stays');
    assert.equal(saved.doc.pricing.blankCostSek.tee, 49);
    assert.match(saved.note, /ändrats av någon annan; din ändring sparades ovanpå/);
  });

  it('a field both changed stops the save, naming the field; nothing is written', async () => {
    const stale = (await loadPrinters()).tiers['fake-printer'];
    const other = docToForm(stale);
    other.blank.tee = '51';
    await savePrinterTier({ id: 'fake-printer' }, payloadOf(other), stale, { confirmPreview: () => true });
    const form = docToForm(stale);
    form.blank.tee = '49';
    sent = [];
    await assert.rejects(savePrinterTier({ id: 'fake-printer' }, payloadOf(form), stale, { confirmPreview: () => true }),
      (e) => /samma uppgifter.*T-shirt \(blankpris\).*Ingenting sparades/.test(e.userMessage));
    assert.equal(sent.filter((r) => r.method === 'PATCH' && r.body.dryRun !== true).length, 0);
    assert.equal((await loadPrinters()).tiers['fake-printer'].pricing.blankCostSek.tee, 51);
  });

  it('removing a frame: the preview names the mapping it pauses before anything is written; no → nothing is', async () => {
    const before = (await loadPrinters()).tiers['fake-printer'];
    const form = docToForm(before);
    form.areas.tee.back = { w: '', h: '', top: '' };
    sent = [];
    const cancelled = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before, { confirmPreview: () => false });
    assert.deepEqual(cancelled, { cancelled: true });
    assert.deepEqual(sent.map((r) => r.body.dryRun), [true]);
    assert.equal((await loadPrinters()).tiers['fake-printer'].revision, 3);

    const asked = [];
    const saved = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before, { confirmPreview: (text) => { asked.push(text); return true; } });
    assert.equal(asked.length, 1);
    assert.match(asked[0], /1 produktkoppling pausas/);
    assert.match(asked[0], /test-shop-a · produkt prod-dev-1 · artikel DEV-TEE-M: en tryckyta som kopplingen trycker på finns inte längre/);
    assert.match(saved.note, /^1 produktkoppling pausades/);
    assert.deepEqual(Object.keys(saved.doc.printAreasMm.tee), ['front']);
  });

  it('without a confirm a save that would pause mappings is not made', async () => {
    const before = (await loadPrinters()).tiers['fake-printer'];
    const form = docToForm(before);
    form.areas.tee.back = { w: '', h: '', top: '' };
    assert.deepEqual(await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before), { cancelled: true });
  });

  it('the floor: the preview lists the products and their new floor; the report reaches the note', async () => {
    useDevApi('admin_dev_fk=floor');
    const before = (await loadPrinters()).tiers['fake-printer'];
    const form = docToForm(before);
    form.print.front = '40';
    const asked = [];
    const saved = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before, { confirmPreview: (text) => asked.push(text) });
    assert.match(asked[0], /2 produkter hamnar under prisgolvet/);
    assert.match(asked[0], /produkt prod-dev-1: pris 249,00 kr, nytt golv 279,00 kr, till salu nu/);
    assert.equal(saved.note, '2 produkter ligger nu under prisgolvet.');
  });

  it('the printer moves after the preview: read again, the preview asked again, then saved', async () => {
    useDevApi('admin_dev_fp=moved');
    const before = (await loadPrinters()).tiers['fake-printer'];
    const form = docToForm(before);
    form.areas.tee.back = { w: '', h: '', top: '' };
    const asked = [];
    const saved = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before, { confirmPreview: (text) => asked.push(text) });
    assert.equal(asked.length, 2);
    assert.doesNotMatch(asked[0], /ändrades av någon annan/);
    assert.match(asked[1], /ändrades av någon annan medan du arbetade/);
    assert.deepEqual(sent.filter((r) => r.method === 'PATCH').map((r) => [r.body.dryRun === true, r.body.expectedRevision]),
      [[true, 3], [false, 3], [true, 4], [false, 4]]);
    assert.equal(saved.doc.revision, 5);
  });

  it('a write whose answer is lost is read back: saved', async () => {
    useDevApi('admin_dev_fp=lost');
    const before = (await loadPrinters()).tiers['fake-printer'];
    const form = docToForm(before);
    form.blank.tee = '53';
    const saved = await savePrinterTier({ id: 'fake-printer' }, payloadOf(form), before, { confirmPreview: () => true });
    assert.match(saved.note, /Svaret kom aldrig fram, men ändringen är sparad/);
    assert.equal(saved.doc.pricing.blankCostSek.tee, 53);
    assert.equal(saved.resync, true);
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

  it('after a save the form follows the stored printer: a second, untouched save sends nothing', async () => {
    // Two garments whose front print prices differ: the field is mixed (empty).
    const view = {
      printerId: 'p1', name: 'P1', type: 'manual', status: 'active', tenantId: null, currency: 'SEK', revision: 3,
      capabilities: {
        models: {
          m_tee: { garment: 'tee', printAreasMm: { front: { w: 250, h: 350 } } },
          m_hood: { garment: 'hoodie', printAreasMm: { front: { w: 250, h: 300 } } },
        },
        skus: { T: { model: 'm_tee' }, H: { model: 'm_hood' } },
      },
      tiers: [
        { sku: 'T', blankCostMinor: 5000, printCostsMinor: { front: 3000 } },
        { sku: 'H', blankCostMinor: 20000, printCostsMinor: { front: 4000 } },
      ],
    };
    const shown = printerDocOf(view);
    assert.deepEqual(shown.mixed.print, ['front']);
    const form = docToForm(shown);
    form.blank.hoodie = ''; // the hoodie is no longer priced: its tier goes
    const first = printerPatchOf(shown, payloadOf(form));
    assert.deepEqual(first.body.tiers, { remove: ['H'] });

    // The server's printer after that save: one tier, so the front price is one value.
    const stored = printerDocOf({ ...view, revision: 4, tiers: [view.tiers[0]] });
    assert.deepEqual(stored.mixed.print, []);
    // The form the page shows after the save (resync): nothing to write.
    assert.equal(printerPatchOf(stored, payloadOf(docToForm(stored))).body, null);
    // The form left as it was would have deleted the tee's untouched front price: why the save asks for the resync.
    const stale = printerPatchOf(stored, payloadOf(form));
    assert.deepEqual(stale.body.tiers.upsert, [{ sku: 'T', blankCostMinor: 5000, printCostsMinor: {} }]);

    const before = (await loadPrinters()).tiers['fake-printer'];
    const edited = docToForm(before);
    edited.blank.tee = '48';
    assert.equal((await savePrinterTier({ id: 'fake-printer' }, payloadOf(edited), before)).resync, true);
    assert.equal((await savePrinterTier({ id: 'fake-printer' }, payloadOf(docToForm(before)), before)).resync, false);
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
