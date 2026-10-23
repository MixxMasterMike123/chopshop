// The affiliate pages' data module (admin build), under Node:
//   node --test src/admin-app/replacements/adminAffiliateData.test.mjs
// fetch is stubbed per test; nothing leaves the process.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setRequestShopId } from '../../api/admin/client.js';
import { approveApplication, recordPayout, voidPayout } from './adminAffiliateData.js';

const realFetch = globalThis.fetch;
const AFF = '11111111-2222-4333-8444-555555555555';
const OBJ = '22222222-3333-4444-8555-666666666666';
let calls;
const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const stub = (handler) => { globalThis.fetch = async (url, init) => { calls.push({ url, method: init?.method, body: init?.body }); return handler(url, init); }; };
const pdf = () => new File(['%PDF-1.4 x'], 'faktura.pdf', { type: 'application/pdf' });

beforeEach(() => { calls = []; setRequestShopId('test-shop-a'); });
afterEach(() => { globalThis.fetch = realFetch; setRequestShopId(null); });

function uploads(url, init) {
  if (url === '/_api/v1/admin/objects' && init.method === 'POST') return answer(201, { object: { objectId: OBJ, objectKey: 'k' } });
  if (url === `/_api/v1/admin/objects/${OBJ}/content`) return answer(200, { object: { objectId: OBJ, status: 'active' } });
  if (url === `/_api/v1/admin/objects/${OBJ}` && init.method === 'DELETE') return answer(204);
  return null;
}

describe('recordPayout and its uploaded invoice', () => {
  it('a refused record deletes the invoice it uploaded, and says why in Swedish', async () => {
    stub((url, init) => uploads(url, init) ?? answer(409, { error: { code: 'insufficient_balance' } }));
    await assert.rejects(
      recordPayout('test-shop-a', AFF, { amount: '54,00', invoiceFile: pdf() }, 5400),
      (e) => e.code === 'insufficient_balance' && /större än/.test(e.message),
    );
    const record = calls.find((c) => c.url === `/_api/v1/admin/affiliates/${AFF}/payouts`);
    assert.equal(JSON.parse(record.body).invoiceObjectId, OBJ);
    assert.ok(calls.some((c) => c.url === `/_api/v1/admin/objects/${OBJ}` && c.method === 'DELETE'), 'the loose invoice is deleted');
  });

  it('a recorded payout keeps its invoice', async () => {
    stub((url, init) => uploads(url, init) ?? answer(201, { payout: { payoutId: 'p1', status: 'paid' } }));
    assert.equal((await recordPayout('test-shop-a', AFF, { amount: '54', invoiceFile: pdf() }, 5400)).status, 'paid');
    assert.equal(calls.some((c) => c.method === 'DELETE'), false);
  });

  it('without an invoice nothing is uploaded or deleted', async () => {
    stub(() => answer(409, { error: { code: 'payout_open' } }));
    await assert.rejects(recordPayout('test-shop-a', AFF, { amount: '1' }, 5400), (e) => e.code === 'payout_open');
    assert.deepEqual(calls.map((c) => c.method), ['POST']);
  });
});

describe('one line where the server takes one line', () => {
  it('the void reason\'s line breaks become spaces', async () => {
    stub(() => answer(200, { payout: { payoutId: 'p1', status: 'void' } }));
    await voidPayout('test-shop-a', 'p1', 'Fel belopp.\nSkicka en ny faktura.');
    assert.deepEqual(JSON.parse(calls[0].body), { reason: 'Fel belopp. Skicka en ny faktura.' });
  });
});

describe('an invite\'s 429 names the invites; another 429 does not', () => {
  it('approve: the invite buckets', async () => {
    stub(() => answer(429, { error: { code: 'rate_limited' } }));
    await assert.rejects(
      approveApplication('test-shop-a', { applicationId: AFF, email: 'a@b.se' }, { commissionPercent: '15', discountPercent: '10' }),
      (e) => /inbjudningar/.test(e.message),
    );
  });
});
