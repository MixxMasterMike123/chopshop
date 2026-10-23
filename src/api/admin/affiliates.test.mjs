// The affiliate calls, under Node: node --test src/api/admin/affiliates.test.mjs
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AdminApiError, setRequestShopId } from './client.js';
import {
  addAdjustment,
  affiliateRefusalMessage,
  approveApplication,
  denyApplication,
  downloadInvoice,
  getAffiliate,
  getAnalytics,
  getApplication,
  inviteAffiliate,
  listAffiliateOrders,
  listAffiliates,
  listApplications,
  listLedger,
  listPayouts,
  markPayoutPaid,
  recordPayout,
  resendAffiliateInvite,
  revokeAffiliate,
  updateAffiliate,
  voidPayout,
} from './affiliates.js';

const realFetch = globalThis.fetch;
let calls;
const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const stub = (handler) => {
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
};
const sent = (i = 0) => (calls[i].init.body === undefined ? undefined : JSON.parse(calls[i].init.body));
beforeEach(() => { calls = []; setRequestShopId('test-shop-a'); });
afterEach(() => { globalThis.fetch = realFetch; setRequestShopId(null); });

const ID = '11111111-2222-4333-8444-555555555555';

describe('the program routes (gated)', () => {
  it('lists affiliates with the query and X-Shop-Id', async () => {
    stub(() => answer(200, { affiliates: [{ affiliateId: ID }], nextCursor: 'c1' }));
    assert.deepEqual(await listAffiliates({ status: 'active', limit: 100 }), { affiliates: [{ affiliateId: ID }], nextCursor: 'c1' });
    assert.equal(calls[0].url, '/_api/v1/admin/affiliates?status=active&limit=100');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers['x-shop-id'], 'test-shop-a');
  });

  it('an odd answer is an empty page', async () => {
    stub(() => answer(200, {}));
    assert.deepEqual(await listAffiliates(), { affiliates: [], nextCursor: null });
    assert.deepEqual(await listApplications(), { applications: [], nextCursor: null });
  });

  it('invites by POST with the body as given and reads the admission', async () => {
    stub(() => answer(201, { affiliate: { affiliateId: ID }, invited: true, mailConfigured: false }));
    const body = { name: 'Anna', email: 'anna@example.com', code: 'ANNA10', commissionPercent: 15, discountPercent: 10, preferredLang: 'sv' };
    assert.deepEqual(await inviteAffiliate(body), {
      affiliate: { affiliateId: ID }, application: null, invited: true, inviteError: null, mailConfigured: false,
    });
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].url, '/_api/v1/admin/affiliates');
    assert.deepEqual(sent(), body);
  });

  it('a committed admission whose invite failed carries inviteError', async () => {
    stub(() => answer(201, { affiliate: { affiliateId: ID }, invited: false, inviteError: 'email_unavailable', mailConfigured: true }));
    const result = await approveApplication(ID, { code: 'ANNA10' });
    assert.equal(result.inviteError, 'email_unavailable');
    assert.equal(result.invited, false);
    assert.equal(calls[0].url, `/_api/v1/admin/affiliates/applications/${ID}/approve`);
    assert.deepEqual(sent(), { code: 'ANNA10' });
  });

  it('applications: the list query, one by id (null on 404), deny with its reason', async () => {
    stub(() => answer(200, { applications: [{ applicationId: ID }], nextCursor: null }));
    await listApplications({ status: 'pending' });
    assert.equal(calls[0].url, '/_api/v1/admin/affiliates/applications?status=pending');
    stub(() => answer(200, { application: { applicationId: ID } }));
    assert.deepEqual(await getApplication(ID), { applicationId: ID });
    assert.equal(calls[1].url, `/_api/v1/admin/affiliates/applications/${ID}`);
    stub(() => answer(404, { error: { code: 'not_found', message: 'Route not found' } }));
    // The 404 re-reads /v1/me once (the session check); answer it as signed in.
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return url === '/_api/v1/me' ? answer(200, { user: {} }) : answer(404, { error: { code: 'not_found' } });
    };
    assert.equal(await getApplication('gone'), null);
    stub(() => answer(200, { application: { applicationId: ID, status: 'denied' } }));
    await denyApplication(ID, 'Passar inte');
    const deny = calls.at(-1);
    assert.equal(deny.url, `/_api/v1/admin/affiliates/applications/${ID}/deny`);
    assert.deepEqual(JSON.parse(deny.init.body), { reason: 'Passar inte' });
  });

  it('analytics with since; re-send invite reads mailConfigured', async () => {
    stub(() => answer(200, { analytics: { clicks: 4 } }));
    assert.deepEqual(await getAnalytics({ since: '2026-09-23' }), { clicks: 4 });
    assert.equal(calls[0].url, '/_api/v1/admin/affiliates/analytics?since=2026-09-23');
    stub(() => answer(202, { mailConfigured: false }));
    assert.deepEqual(await resendAffiliateInvite(ID), { mailConfigured: false });
    assert.equal(calls[1].url, `/_api/v1/admin/affiliates/${ID}/invite`);
    assert.equal(calls[1].init.method, 'POST');
  });
});

describe('one affiliate (open while OFF)', () => {
  it('reads, edits with PATCH, revokes', async () => {
    stub(() => answer(200, { affiliate: { affiliateId: ID, code: 'ANNA10' } }));
    assert.equal((await getAffiliate(ID)).code, 'ANNA10');
    await updateAffiliate(ID, { status: 'suspended' });
    assert.equal(calls[1].init.method, 'PATCH');
    assert.equal(calls[1].url, `/_api/v1/admin/affiliates/${ID}`);
    assert.deepEqual(sent(1), { status: 'suspended' });
    await revokeAffiliate(ID);
    assert.equal(calls[2].url, `/_api/v1/admin/affiliates/${ID}/revoke`);
    assert.equal(calls[2].init.method, 'POST');
  });

  it('adjustment, ledger, orders, payouts with their pages', async () => {
    stub(() => answer(201, { entry: { entryId: 'e1', amountMinor: -500 } }));
    assert.deepEqual(await addAdjustment(ID, { amountMinor: -500, reason: 'Fel order' }), { entryId: 'e1', amountMinor: -500 });
    assert.deepEqual(sent(), { amountMinor: -500, reason: 'Fel order' });
    stub(() => answer(200, { entries: [{ entryId: 'e1' }], nextCursor: 'n' }));
    assert.deepEqual(await listLedger(ID, { cursor: 'c', limit: 20 }), { entries: [{ entryId: 'e1' }], nextCursor: 'n' });
    assert.equal(calls[1].url, `/_api/v1/admin/affiliates/${ID}/ledger?cursor=c&limit=20`);
    stub(() => answer(200, { orders: [{ orderId: 'o1' }], nextCursor: null }));
    assert.deepEqual(await listAffiliateOrders(ID), { orders: [{ orderId: 'o1' }], nextCursor: null });
    assert.equal(calls[2].url, `/_api/v1/admin/affiliates/${ID}/orders`);
    stub(() => answer(200, { balances: [{ currency: 'SEK' }], payouts: [{ payoutId: 'p1' }], nextCursor: null }));
    assert.deepEqual(await listPayouts(ID), { balances: [{ currency: 'SEK' }], payouts: [{ payoutId: 'p1' }], nextCursor: null });
  });

  it('records, marks paid and voids a payout', async () => {
    stub(() => answer(201, { payout: { payoutId: 'p1', status: 'paid' } }));
    await recordPayout(ID, { amountMinor: 5400, invoiceNumber: 'F-1' });
    assert.equal(calls[0].url, `/_api/v1/admin/affiliates/${ID}/payouts`);
    assert.deepEqual(sent(), { amountMinor: 5400, invoiceNumber: 'F-1' });
    stub(() => answer(200, { payout: { payoutId: 'p1', status: 'paid' } }));
    await markPayoutPaid('p1', { reference: 'Swish 123', notes: '' });
    assert.equal(calls[1].url, '/_api/v1/admin/affiliates/payouts/p1/paid');
    assert.deepEqual(sent(1), { reference: 'Swish 123' });
    await markPayoutPaid('p1');
    assert.deepEqual(sent(2), {});
    await voidPayout('p1', 'Fel belopp');
    assert.equal(calls[3].url, '/_api/v1/admin/affiliates/payouts/p1/void');
    assert.deepEqual(sent(3), { reason: 'Fel belopp' });
  });

  it('a 409 rejects with its code, said in Swedish', async () => {
    stub(() => answer(409, { error: { code: 'payout_open', message: 'x' } }));
    await assert.rejects(recordPayout(ID, { amountMinor: 1 }), (e) => {
      assert.ok(e instanceof AdminApiError);
      assert.equal(e.code, 'payout_open');
      assert.match(affiliateRefusalMessage(e), /öppen utbetalningsbegäran/);
      return true;
    });
  });
});

describe('affiliateRefusalMessage', () => {
  it('the reason wins over the code, then the status', () => {
    assert.match(affiliateRefusalMessage({ status: 400, code: 'invalid_request', reason: 'code_reserved' }), /reserverad/);
    assert.match(affiliateRefusalMessage({ status: 409, code: 'code_taken' }), /används redan/);
    assert.match(affiliateRefusalMessage({ status: 409, code: 'not_addable' }), /annat konto/);
    assert.match(affiliateRefusalMessage({ status: 404, code: 'not_found' }), /avstängt/);
    assert.match(affiliateRefusalMessage({ status: 400, code: 'invalid_request' }), /Kontrollera fälten/);
    assert.equal(affiliateRefusalMessage({ status: 500, code: 'http_error' }), null);
    assert.equal(affiliateRefusalMessage({ status: 429, code: 'rate_limited' }), 'För många försök, vänta en stund.');
    assert.match(affiliateRefusalMessage({ status: 429, code: 'rate_limited' }, { invite: true }), /inbjudningar/);
    assert.equal(affiliateRefusalMessage(null), null);
  });
});

describe('downloadInvoice', () => {
  it('reads the private object with X-Shop-Id and hands it to the browser', async () => {
    const seen = [];
    const clicked = [];
    const saved = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    globalThis.document = {
      createElement: () => ({ click() { clicked.push(this.download); }, remove() {} }),
      body: { appendChild() {} },
    };
    URL.createObjectURL = () => 'blob:invoice';
    URL.revokeObjectURL = () => {};
    try {
      await downloadInvoice('obj/1', 'F-1.pdf', {
        fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response('%PDF-1.4', { status: 200 }); },
      });
      assert.equal(seen[0].url, '/_api/v1/admin/objects/obj%2F1/content');
      assert.equal(seen[0].init.headers['x-shop-id'], 'test-shop-a');
      assert.equal(seen[0].init.credentials, 'same-origin');
      assert.deepEqual(clicked, ['F-1.pdf']);
      await assert.rejects(
        downloadInvoice('gone', 'x.pdf', { fetchImpl: async () => new Response('', { status: 404 }) }),
        (e) => e.status === 404 && e.code === 'not_found',
      );
    } finally {
      globalThis.document = saved.document;
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    }
  });
});
