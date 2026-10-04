// The data modules of unit CP5-FP, end to end against the dev API under
// Node: fetch is routed into dev-api.mjs's route(), with the dev scenarios
// (cookie admin_dev_fp, fp-dev.mjs) for a lost answer, a write not done, an
// unclear outcome, a conflict and a refusal.
//   node --test src/admin-app/pages/new/fpData.test.mjs

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from '../../../api/admin/client.js';
import { getConnectBalance } from '../../../api/admin/payments.js';
import { STORE } from '../../../config/store.js';
import { createState, route } from '../../dev/dev-api.mjs';
import { balanceFailure, balanceView } from '../../adapters/payments.js';
import { DEFAULT_FILTERS, actionBody, exceptionActions, nextStates, statusBody } from '../../adapters/printJobs.js';
import { loadShopConfig, saveShopConfig } from '../../replacements/shopConfig.js';
import { loadMenuBuilder, saveMenu } from '../../replacements/adminMenuData.js';
import { loadBranding, saveBranding } from '../../replacements/adminStorefrontData.js';
import { getTenantDetail, readAllTenants } from '../../../api/admin/platform.js';
import { countsOf, toListShops } from '../../adapters/platformShops.js';
import { resendInvite } from '../../replacements/memberResendData.js';
import { loadFilterChoices, loadJobs, readJob, recordStatus } from './printJobsData.js';

const realFetch = globalThis.fetch;
let state;
let session;
let cookie;
let sent;

function scenario(name = '', other = '') {
  cookie = [session, name ? `admin_dev_fp=${name}` : '', other].filter(Boolean).join('; ');
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
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: answer.headers ?? {} });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});

const patches = () => sent.filter((s) => s.method === 'PATCH');
const storedIdentity = () => route(state, 'GET', new URL('http://dev.invalid/_api/v1/admin/settings'), { cookie: session, 'x-shop-id': 'test-shop-a' }).body.settings.storeIdentity;
// AdminSettings' own rule from flat settings to its form.
const formFromSaved = (saved) => ({ ...STORE, ...Object.fromEntries(Object.entries(saved || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')) });

describe('the settings: the fenced partial write', () => {
  beforeEach(() => {
    signIn('admin@example.com', 'dev-password-1');
    setRequestShopId('test-shop-a');
  });

  it('a page\'s whole form sends only what changed, fenced on its read; the form follows the answer', async () => {
    const form = formFromSaved(await loadShopConfig('test-shop-a'));
    const outcome = await saveShopConfig({ ...form, address: 'Ny gata 1', returnAddress: ' Retur 1 ' }, 'test-shop-a');
    assert.equal(patches().length, 1);
    assert.deepEqual(patches()[0].body, { expectedUpdatedAt: '2026-10-01T09:00:00.000Z', storeIdentity: { address: 'Ny gata 1' }, returnAddress: 'Retur 1' });
    assert.equal(outcome.follow({ ...form, address: 'Ny gata 1', returnAddress: ' Retur 1 ' }, formFromSaved).value.returnAddress, 'Retur 1');
    assert.equal(storedIdentity().tagline, 'Invented goods for testing.', 'another key stays');
  });

  it('someone else wrote meanwhile: nothing saved; the form keeps edits the other change left alone and names the lost one', async () => {
    const loaded = formFromSaved(await loadShopConfig('test-shop-a'));
    const mine = { ...loaded, tagline: 'Min slogan', address: 'Min adress' };
    scenario('conflict'); // another admin changes the slogan first
    let refusal;
    await assert.rejects(saveShopConfig(mine, 'test-shop-a'), (e) => { refusal = e; return e.code === 'settings_conflict'; });
    assert.equal(storedIdentity().address, undefined, 'nothing of this save was written');
    const { value, message } = refusal.follow(mine, formFromSaved);
    assert.equal(value.tagline, 'Ändrad av en annan administratör');
    assert.equal(value.address, 'Min adress');
    assert.match(message, /sparades inte.*Din ändring av Slogan gick förlorad.*Det du ändrat i andra fält finns kvar/);
    // The next save starts from what is stored now, and goes through.
    await saveShopConfig(value, 'test-shop-a');
    assert.equal(storedIdentity().address, 'Min adress');
    assert.equal(storedIdentity().tagline, 'Ändrad av en annan administratör');
  });

  it('a lost answer is read back: done', async () => {
    await loadShopConfig('test-shop-a');
    scenario('lost');
    const outcome = await saveShopConfig({ tagline: 'Sparad ändå' }, 'test-shop-a');
    assert.equal(outcome.readBack, true);
    assert.equal(storedIdentity().tagline, 'Sparad ändå');
  });

  it('a lost answer is read back: not done, and unclear when the read fails too', async () => {
    await loadShopConfig('test-shop-a');
    scenario('drop');
    await assert.rejects(saveShopConfig({ tagline: 'x' }, 'test-shop-a'), (e) => /sparades inte\. Försök igen/.test(e.userMessage));
    scenario('unclear');
    await assert.rejects(saveShopConfig({ tagline: 'x' }, 'test-shop-a'), (e) => /oklart om ändringen sparades/.test(e.userMessage));
    assert.equal(storedIdentity().tagline, 'Invented goods for testing.');
  });

  it('a load that fails after an earlier page loaded leaves NO baseline: its form of defaults saves nothing', async () => {
    await loadShopConfig('test-shop-a'); // an earlier page of this tab
    const before = JSON.stringify(storedIdentity());
    const routed = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => (String(url).includes('/v1/admin/settings') && (init.method || 'GET') === 'GET'
      ? new Response(JSON.stringify({ error: { code: 'internal_error', message: 'x' } }), { status: 500 })
      : routed(url, init));
    await assert.rejects(loadShopConfig('test-shop-a')); // this page's load fails: it shows defaults
    globalThis.fetch = routed;
    await assert.rejects(saveShopConfig(formFromSaved(null), 'test-shop-a'), (e) => /kunde inte läsas när sidan öppnades/.test(e.userMessage));
    assert.equal(patches().length, 0);
    assert.equal(JSON.stringify(storedIdentity()), before);
    // A load that succeeds gives the page its baseline again.
    const form = formFromSaved(await loadShopConfig('test-shop-a'));
    assert.equal((await saveShopConfig({ ...form, tagline: 'Efter omladdning' }, 'test-shop-a')).saved.tagline, 'Efter omladdning');
  });

  it('a refusal is passed on as it is, and the next save still goes through', async () => {
    await loadShopConfig('test-shop-a');
    await assert.rejects(saveShopConfig({ tagline: 'x'.repeat(70_000) }, 'test-shop-a'), (e) => e.code === 'invalid_request');
    await saveShopConfig({ tagline: 'kort' }, 'test-shop-a');
    assert.equal(storedIdentity().tagline, 'kort');
  });

  it('an answer that arrives after the tab moved to another shop is dropped (the write itself stands)', async () => {
    await loadShopConfig('test-shop-a');
    const save = saveShopConfig({ tagline: 'medan bytet' }, 'test-shop-a');
    setRequestShopId('test-shop-c');
    const outcome = await Promise.race([save.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('dropped'), 30))]);
    assert.equal(outcome, 'dropped');
    assert.equal(storedIdentity().tagline, 'medan bytet');
  });

  it('the storefront: a conflict keeps the seller\'s branding edits and takes the other change', async () => {
    const loaded = await loadBranding('test-shop-a');
    // The page sends its branding keys only (AdminStorefront's pickBranding).
    const mine = { accent: '#123456', heroHeadline: 'Ny rubrik', templateId: loaded.templateId ?? STORE.templateId, logoUrl: STORE.logoUrl, faviconUrl: '', heroImageUrl: '' };
    scenario('conflict'); // another admin changes the slogan (not a branding key) first
    await assert.rejects(saveBranding(mine, 'test-shop-a'), (e) => {
      assert.equal(e.branding.accent, '#123456');
      assert.equal(e.branding.heroHeadline, 'Ny rubrik');
      assert.equal(e.branding.tagline, 'Ändrad av en annan administratör');
      assert.match(e.userMessage, /sparades inte.*finns kvar/);
      return true;
    });
    await saveBranding(mine, 'test-shop-a'); // the page's form after it followed (the branding keys are its own)
    assert.equal(storedIdentity().accent, '#123456');
    assert.equal(storedIdentity().tagline, 'Ändrad av en annan administratör');
    assert.deepEqual(Object.keys(patches().at(-1).body.storeIdentity).sort(), ['accent', 'heroHeadline']);
  });

  it('the menu: a conflict on other settings keeps the seller\'s menu; one on the menu shows the stored one', async () => {
    await loadMenuBuilder('test-shop-a');
    const menu = [{ type: 'home', target: '', label: 'Hem' }];
    scenario('conflict');
    await assert.rejects(saveMenu(menu, 'test-shop-a'), (e) => {
      assert.deepEqual(e.menu, menu);
      assert.match(e.userMessage, /finns kvar/);
      return true;
    });
    await saveMenu(menu, 'test-shop-a'); // goes through on what is stored now
    await loadMenuBuilder('test-shop-a');
    scenario('conflict-menu');
    await assert.rejects(saveMenu([{ type: 'home', target: '', label: 'Start' }], 'test-shop-a'), (e) => {
      assert.match(e.menu[0].label, /ändrat av en annan administratör/);
      assert.match(e.userMessage, /Din ändring av Menyn gick förlorad/);
      return true;
    });
    assert.ok(patches().every((p) => Object.keys(p.body.storeIdentity).join() === 'menu'), 'a menu save writes only the menu');
  });
});

describe('the Connect balance', () => {
  beforeEach(() => {
    signIn('admin@example.com', 'dev-password-1');
    setRequestShopId('test-shop-a');
  });
  const read = async (connect, fp = '') => {
    scenario(fp, `admin_dev_connect=${connect}`);
    try {
      return { view: balanceView(await getConnectBalance({ shopId: 'test-shop-a' })) };
    } catch (error) {
      return balanceFailure(error);
    }
  };

  it('per currency with the schedule; no panel without an account or without Connect', async () => {
    const ok = await read('active');
    assert.deepEqual(ok.view.rows.map((r) => r.currency), ['sek', 'eur']);
    assert.match(ok.view.schedule, /varje vecka, på fredagar/);
    assert.equal((await read('none')).state, 'none'); // 409 connect_account_missing
    assert.equal((await read('notfound')).state, 'none'); // 404
    assert.equal((await read('disabled')).state, 'none'); // 404: Connect not enabled
  });

  it('429 is quiet and says when; 502 says Stripe', async () => {
    const limited = await read('active', 'limited');
    assert.equal(limited.state, 'limited');
    assert.match(limited.message, /om 60 sekunder/);
    assert.equal((await read('active', 'stripe')).state, 'unavailable');
    assert.ok(sent.every((s) => s.headers['x-shop-id'] === 'test-shop-a'));
  });
});

describe('the platform\'s shop counts', () => {
  beforeEach(() => signIn('platform@example.com', 'dev-password-2'));

  it('the directory with ?counts=1 and the detail\'s counts; no customer count', async () => {
    // What the shop pages' data modules read (they import the build's urls,
    // which Node cannot load): loadShops = toListShops(readAllTenants({ counts: true })),
    // loadShop's counts = countsOf(the detail's).
    const shops = toListShops(await readAllTenants({ counts: true }));
    assert.deepEqual(shops.find((s) => s.id === 'test-shop-a').counts, { products: 24, publishedProducts: 18, orders: 57 });
    assert.ok(sent.some((s) => s.url.includes('counts=1')));
    assert.deepEqual(countsOf((await getTenantDetail('test-shop-c')).counts), { products: 6, publishedProducts: 0, orders: 2 });
  });
});

describe('a member\'s new invite link', () => {
  const OSKAR = { id: 'user-member-a3', email: 'oskar.berg@example.com' }; // invited, no password yet
  beforeEach(() => {
    signIn('admin@example.com', 'dev-password-1');
    setRequestShopId('test-shop-a');
  });

  it('202: a new link, the old one dead', async () => {
    const done = await resendInvite('test-shop-a', OSKAR);
    assert.match(done.message, /ny inbjudningslänk.*oskar\.berg@example\.com.*tidigare länken fungerar inte längre/);
    assert.equal(sent.at(-1).url, '/_api/v1/admin/members/user-member-a3/resend-invite');
  });

  it('the refusals, each in words, the list re-read where the row is wrong', async () => {
    scenario('password');
    await assert.rejects(resendInvite('test-shop-a', OSKAR), (e) => /redan valt ett lösenord/.test(e.message) && e.reload === true);
    scenario('');
    await assert.rejects(resendInvite('test-shop-a', OSKAR), (e) => /redan valt ett lösenord/.test(e.message)); // and it stays so
    state = createState(); // a fresh server: Oskar invited again
    signIn('admin@example.com', 'dev-password-1');
    scenario('limited');
    await assert.rejects(resendInvite('test-shop-a', OSKAR), (e) => /om 15 minuter/.test(e.message) && !e.reload);
    scenario('suspended');
    await assert.rejects(resendInvite('test-shop-a', OSKAR), (e) => /spärrat av plattformen/.test(e.message));
    scenario('nomail');
    await assert.rejects(resendInvite('test-shop-a', OSKAR), (e) => /kunde inte skickas just nu/.test(e.message));
    scenario('lost');
    await assert.rejects(resendInvite('test-shop-a', OSKAR), (e) => /oklart om en ny inbjudan skickades/.test(e.message));
  });

  it('404: the route off here (still listed) and someone no longer a member (gone from the list) are told apart', async () => {
    scenario('dark');
    await assert.rejects(resendInvite('test-shop-a', OSKAR), (e) => /inte påslagen i den här miljön/.test(e.message) && !e.reload);
    scenario('');
    await assert.rejects(resendInvite('test-shop-a', { id: 'user-gone', email: 'borta@example.com' }),
      (e) => /borta@example\.com är inte längre administratör/.test(e.message) && e.reload === true);
  });
});

describe('the print jobs', () => {
  beforeEach(() => {
    signIn('platform@example.com', 'dev-password-2');
    setRequestShopId('test-shop-a'); // a shop active in the tab: never sent on a platform route
  });
  const job = (jobs, number, line = 1) => jobs.find((j) => j.orderNumber === number && j.lineNo === line);

  it('the default view: accepted and not shipped, asked with one value per filter', async () => {
    const { jobs, nextCursor } = await loadJobs(DEFAULT_FILTERS);
    assert.deepEqual(jobs.map((j) => `${j.orderNumber}-${j.lineNo}`), ['1042-1', '1042-2', '1043-2', '1044-1', '1045-1', '2001-1', '1049-1', '1051-1', '1053-1', '2002-1']);
    assert.equal(nextCursor, null);
    assert.equal(new URL(sent[0].url, 'http://x').search, '?dispatchState=accepted&limit=50');
    assert.ok(sent.every((s) => !('x-shop-id' in s.headers)));
    // No cost and no buyer in a row.
    assert.deepEqual(Object.keys(jobs[0]).sort(), ['carrier', 'createdAt', 'dispatchState', 'dispatchedAt', 'exception', 'exceptionResolvedAt', 'jobId', 'lineNo', 'name', 'orderId', 'orderNumber',
      'orderStatus', 'printerId', 'printerJobRef', 'quantity', 'shopName', 'sku', 'state', 'tenantId', 'trackingNumber', 'trackingUrl', 'updatedAt', 'variantLabel']);
  });

  it('the default view past its read-ahead: no job to show AND a cursor, so the page can go on to the open job behind', async () => {
    const order = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const job = (n, jobState) => ({ jobId: `${order(n)}-1`, orderId: order(n), lineNo: 1, tenantId: 'test-shop-a', state: jobState, dispatchState: 'accepted', orderStatus: 'paid' });
    const routed = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const at = new URL(url, 'http://dev.invalid');
      if (!at.pathname.endsWith('/v1/platform/print-jobs')) return routed(url, init);
      sent.push({ url, method: 'GET' });
      const cursor = at.searchParams.get('cursor');
      const page = cursor === null ? 0 : Number(cursor.slice(24, 36)) / 50; // 50 shipped jobs a page
      const jobs = page < 5
        ? Array.from({ length: 50 }, (_, i) => job(page * 50 + i + 1, 'shipped'))
        : [job(251, 'in_production')];
      return new Response(JSON.stringify({ jobs, nextCursor: page < 5 ? jobs.at(-1).jobId : null }), { status: 200 });
    };
    const first = await loadJobs(DEFAULT_FILTERS);
    assert.deepEqual([first.jobs.length, first.nextCursor], [0, `${order(250)}-1`]); // five pages read, all shipped
    assert.equal(sent.filter((s) => String(s.url).includes('print-jobs')).length, 5);
    const more = await loadJobs(DEFAULT_FILTERS, first.nextCursor);
    assert.deepEqual([more.jobs.map((j) => j.jobId), more.nextCursor], [[`${order(251)}-1`], null]);
  });

  it('filters and "Visa fler"', async () => {
    const shipped = await loadJobs({ ...DEFAULT_FILTERS, state: 'shipped' });
    assert.deepEqual(shipped.jobs.map((j) => j.orderNumber), ['1048', '1051', '1052']);
    const shopC = await loadJobs({ ...DEFAULT_FILTERS, tenantId: 'test-shop-c' });
    assert.deepEqual(shopC.jobs.map((j) => j.orderNumber), ['2001', '2002']);
    const unknown = await loadJobs({ ...DEFAULT_FILTERS, dispatchState: 'unknown', state: 'all' });
    assert.deepEqual(unknown.jobs.map((j) => j.orderNumber), ['1046']);
    scenario('many');
    const first = await loadJobs(DEFAULT_FILTERS);
    assert.ok(first.nextCursor);
    const more = await loadJobs(DEFAULT_FILTERS, first.nextCursor);
    assert.equal(new Set([...first.jobs, ...more.jobs].map((j) => j.jobId)).size, first.jobs.length + more.jobs.length);
    assert.ok([...first.jobs, ...more.jobs].every((j) => j.state !== 'shipped'));
  });

  it('one job read back through the list (a first line and a later line)', async () => {
    const { jobs } = await loadJobs(DEFAULT_FILTERS);
    for (const j of [job(jobs, '1042', 1), job(jobs, '1042', 2), job(jobs, '2001', 1)]) {
      assert.equal((await readJob(j)).jobId, j.jobId);
    }
  });

  it('forward steps; the last printer line of an all-printer parcel order ships the order', async () => {
    const { jobs } = await loadJobs(DEFAULT_FILTERS);
    const one = job(jobs, '1042', 1);
    const two = job(jobs, '1042', 2);
    const first = await recordStatus(two, statusBody('shipped', { trackingNumber: 'SE1' }).body);
    assert.deepEqual([first.job.state, first.job.trackingNumber, first.orderShipped], ['shipped', 'SE1', false]);
    const last = await recordStatus(one, statusBody('shipped', {}).body);
    assert.equal(last.orderShipped, true);
    const again = await recordStatus(last.job, statusBody('shipped', {}).body);
    assert.equal(again.changed, false);
  });

  it('refusals in words, with the job as it is now', async () => {
    const { jobs } = await loadJobs(DEFAULT_FILTERS);
    const produced = job(jobs, '1043', 2);
    await assert.rejects(recordStatus(produced, { state: 'in_production' }), (e) => /senare status/.test(e.userMessage) && e.fresh.state === 'produced');
    await assert.rejects(recordStatus(job(jobs, '1044'), { state: 'produced' }), (e) => /avbruten/.test(e.userMessage));
    scenario('conflict');
    await assert.rejects(recordStatus(produced, { state: 'shipped' }), (e) => /ändrades samtidigt/.test(e.userMessage));
  });

  it('a lost answer is read back: done, not done, unclear', async () => {
    const { jobs } = await loadJobs(DEFAULT_FILTERS);
    scenario('lost');
    const done = await recordStatus(job(jobs, '2001'), { state: 'in_production' });
    assert.deepEqual([done.readBack, done.job.state, done.orderShipped], [true, 'in_production', null]);
    scenario('drop');
    await assert.rejects(recordStatus(job(jobs, '1049'), { state: 'produced' }), (e) => /sparades inte\. Försök igen/.test(e.userMessage));
    scenario('unclear');
    await assert.rejects(recordStatus(job(jobs, '1049'), { state: 'produced' }), (e) => /oklart om statusen sparades/.test(e.userMessage));
  });

  it('the exception filter: the open ones only, asked as exception=out_of_stock; and none', async () => {
    const open = await loadJobs({ ...DEFAULT_FILTERS, state: 'all', dispatchState: 'all', exception: 'open' });
    assert.deepEqual(open.jobs.map((j) => `${j.orderNumber}-${j.lineNo}`), ['1051-1', '2002-1']);
    assert.equal(new URL(sent.at(-1).url, 'http://x').search, '?exception=out_of_stock&limit=50');
    const none = await loadJobs({ ...DEFAULT_FILTERS, exception: 'none' });
    assert.ok(none.jobs.every((j) => j.exception === null));
    assert.ok(none.jobs.some((j) => j.orderNumber === '1042'));
  });

  it('record it: held, then only "skickad" or a close; the refusals of what no longer fits in words', async () => {
    const { jobs } = await loadJobs(DEFAULT_FILTERS);
    const line = job(jobs, '1042', 2); // in production
    assert.deepEqual(exceptionActions(line), ['out_of_stock']);
    const done = await recordStatus(line, actionBody('out_of_stock').body);
    assert.deepEqual([done.changed, done.job.exception, done.job.exceptionResolvedAt, done.job.state], [true, 'out_of_stock', null, 'in_production']);
    assert.deepEqual(sent.at(-1).body, { exception: 'out_of_stock' });
    assert.deepEqual([nextStates(done.job), exceptionActions(done.job)], [['shipped'], ['resolved']]);
    assert.equal((await recordStatus(done.job, { exception: 'out_of_stock' })).changed, false);
    await assert.rejects(recordStatus(done.job, { state: 'produced' }), (e) => /bara rapporteras som skickad/.test(e.userMessage) && e.fresh.exception === 'out_of_stock');
    await assert.rejects(recordStatus(job(jobs, '1043', 2), { exception: 'out_of_stock' }), (e) => /plagget fanns i lager/.test(e.userMessage));
    await assert.rejects(recordStatus(job(jobs, '1044', 1), { exception: 'out_of_stock' }), (e) => /avbruten/.test(e.userMessage));
    await assert.rejects(recordStatus(job(jobs, '1042', 1), { exception: 'resolved' }), (e) => /inget undantag att stänga/.test(e.userMessage));
  });

  it('close it: the order\'s last unsent line ships the order; nothing follows; a closed order is only noted', async () => {
    const { jobs } = await loadJobs(DEFAULT_FILTERS);
    const closed = await recordStatus(job(jobs, '1051', 1), actionBody('resolved').body);
    assert.deepEqual([closed.changed, closed.orderShipped, Boolean(closed.job.exceptionResolvedAt)], [true, true, true]);
    assert.deepEqual([nextStates(closed.job), exceptionActions(closed.job)], [[], []]);
    assert.equal((await recordStatus(closed.job, { exception: 'resolved' })).changed, false);
    await assert.rejects(recordStatus(closed.job, { state: 'shipped' }), (e) => /Undantaget för raden är stängt/.test(e.userMessage));
    const cancelled = await recordStatus(job(jobs, '2002', 1), { exception: 'resolved' });
    assert.deepEqual([cancelled.changed, cancelled.orderShipped], [true, false]);
    const shipped = await loadJobs({ ...DEFAULT_FILTERS, state: 'shipped' });
    await assert.rejects(recordStatus(job(shipped.jobs, '1052', 1), { exception: 'resolved' }), (e) => /redan skickad, så det finns inget undantag/.test(e.userMessage));
  });

  it('a lost answer of an exception body is read back: done, not done, unclear', async () => {
    const { jobs } = await loadJobs(DEFAULT_FILTERS);
    scenario('lost');
    const done = await recordStatus(job(jobs, '2001'), { exception: 'out_of_stock' });
    assert.deepEqual([done.readBack, done.job.exception, done.orderShipped], [true, 'out_of_stock', null]);
    const closed = await recordStatus(done.job, { exception: 'resolved' });
    assert.deepEqual([closed.readBack, Boolean(closed.job.exceptionResolvedAt)], [true, true]);
    scenario('drop');
    await assert.rejects(recordStatus(job(jobs, '1049'), { exception: 'out_of_stock' }), (e) => /sparades inte\. Försök igen/.test(e.userMessage));
    // Not saved is said on the facts the body moves: a state that moved meanwhile does not make it unclear.
    const moved = { ...job(jobs, '1042', 2), state: 'produced' }; // the server holds it in production
    await assert.rejects(recordStatus(moved, { exception: 'out_of_stock' }), (e) => /sparades inte\. Försök igen/.test(e.userMessage));
    scenario('unclear');
    await assert.rejects(recordStatus(job(jobs, '1049'), { exception: 'out_of_stock' }), (e) => /oklart om statusen sparades/.test(e.userMessage));
  });

  it('the filters\' choices: the shops and the printers by name', async () => {
    const choices = await loadFilterChoices();
    assert.deepEqual(choices.shops.map((s) => s.id), ['test-shop-a', 'test-shop-b', 'test-shop-c']);
    assert.ok(choices.printers.some((p) => p.id === 'fake-printer'));
  });
});
