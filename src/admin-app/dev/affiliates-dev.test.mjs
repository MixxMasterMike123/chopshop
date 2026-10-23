// node --test src/admin-app/dev/affiliates-dev.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createState, route } from './dev-api.mjs';

function signedIn(email = 'admin@example.com', password = 'dev-password-1') {
  const state = createState();
  const r = route(state, 'POST', new URL('http://x/_api/api/auth/sign-in/email'), {}, { email, password });
  const cookie = r.setCookie.split(';')[0];
  const call = (method, path, body = null, shop = 'test-shop-a') =>
    route(state, method, new URL(`http://x/_api${path}`), { cookie, 'x-shop-id': shop }, body);
  return { call };
}

const ANNA = 'af000000-0000-4000-8000-000000000001';
const ERIK = 'af000000-0000-4000-8000-000000000002';

describe('affiliate dev rows (CP13 A2)', () => {
  it('lists the affiliates, the pending applications first, the analytics', () => {
    const { call } = signedIn();
    const list = call('GET', '/v1/admin/affiliates');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.affiliates.map((a) => a.code), ['ANNA10', 'ERIK-YT', 'SARA']);
    assert.equal(list.body.affiliates[0].payableMinor, 10800);
    const apps = call('GET', '/v1/admin/affiliates/applications?status=pending&limit=100');
    assert.deepEqual(apps.body.applications.map((a) => a.name), ['Maja Ek', 'Leo Holm']);
    const analytics = call('GET', `/v1/admin/affiliates/analytics?since=${new Date(Date.now() - 30 * 86_400_000).toISOString()}`);
    assert.equal(analytics.body.analytics.activeAffiliates, 2);
    assert.equal(analytics.body.analytics.unpaidMinor, 24200);
  });

  it('the gated routes are the opaque 404 with the add-on off; one affiliate is not', () => {
    const { call } = signedIn('admin-multi@example.com', 'dev-password-5');
    for (const [method, path] of [['GET', '/v1/admin/affiliates'], ['POST', '/v1/admin/affiliates'], ['GET', '/v1/admin/affiliates/analytics'], ['GET', '/v1/admin/affiliates/applications']]) {
      assert.equal(call(method, path, {}, 'test-shop-c').status, 404, `${method} ${path}`);
    }
  });

  it('approves an application into an invited affiliate, refuses a second decision', () => {
    const { call } = signedIn();
    const id = 'aa000000-0000-4000-8000-000000000001';
    const approved = call('POST', `/v1/admin/affiliates/applications/${id}/approve`, { code: 'MAJA10', commissionPercent: 15, discountPercent: 10 });
    assert.equal(approved.status, 201);
    assert.equal(approved.body.affiliate.code, 'MAJA10');
    assert.equal(approved.body.affiliate.account.invited, true);
    assert.equal(approved.body.mailConfigured, false);
    assert.equal(call('POST', `/v1/admin/affiliates/applications/${id}/deny`, { reason: 'x' }).body.error.code, 'already_decided');
    assert.equal(call('POST', '/v1/admin/affiliates', { name: 'X', email: 'x@example.com', code: 'MAJA10' }).body.error.code, 'code_taken');
    assert.equal(call('POST', '/v1/admin/affiliates', { name: 'X', email: 'x@example.com', code: 'TEST' }).body.error.reason, 'code_reserved');
  });

  it('records a payout within the payable, refuses one while a request is open, marks paid', () => {
    const { call } = signedIn();
    assert.equal(call('POST', `/v1/admin/affiliates/${ANNA}/payouts`, { amountMinor: 10801 }).body.error.code, 'insufficient_balance');
    assert.equal(call('POST', `/v1/admin/affiliates/${ANNA}/payouts`, { amountMinor: 10800, invoiceNumber: 'F-2' }).status, 201);
    assert.equal(call('GET', `/v1/admin/affiliates/${ANNA}/payouts`).body.balances[0].payableMinor, 0);
    assert.equal(call('POST', `/v1/admin/affiliates/${ERIK}/payouts`, { amountMinor: 100 }).body.error.code, 'payout_open');
    const open = call('GET', `/v1/admin/affiliates/${ERIK}/payouts`).body.payouts[0];
    assert.equal(call('POST', `/v1/admin/affiliates/payouts/${open.payoutId}/paid`, { reference: 'Swish 1' }).body.payout.status, 'paid');
    assert.equal(call('POST', `/v1/admin/affiliates/payouts/${open.payoutId}/void`, { reason: 'x' }).body.error.code, 'payout_not_open');
  });

  it('an adjustment is a ledger row; revoke makes the affiliate inactive and keeps it', () => {
    const { call } = signedIn();
    assert.equal(call('POST', `/v1/admin/affiliates/${ANNA}/adjustments`, { amountMinor: -500, reason: 'Fel' }).status, 201);
    assert.equal(call('GET', `/v1/admin/affiliates/${ANNA}/ledger`).body.entries[0].kind, 'adjustment');
    const revoked = call('POST', `/v1/admin/affiliates/${ANNA}/revoke`);
    assert.equal(revoked.body.affiliate.status, 'inactive');
    assert.equal(revoked.body.affiliate.account.membership, 'revoked');
    assert.equal(call('GET', `/v1/admin/affiliates/${ANNA}`).status, 200);
  });

  it('the order detail carries the affiliate member on the overlaid orders only', () => {
    const { call } = signedIn();
    const one = call('GET', '/v1/admin/orders/0a000000-0000-4000-8000-000000000001');
    assert.equal(one.status, 200);
    assert.deepEqual(one.body.order.affiliate, { affiliateId: ANNA, attribution: 'link', code: 'ANNA10', affiliateCommissionMinor: 5400, ledgerState: 'held', selfReferral: false });
    assert.equal(call('GET', '/v1/admin/orders/0a000000-0000-4000-8000-000000000002').body.order.affiliate.selfReferral, true);
    const other = call('GET', '/v1/admin/orders/0a000000-0000-4000-8000-000000000003');
    if (other.status === 200) assert.equal(other.body.order.affiliate, null);
  });

  it('refuses what the Worker refuses: a line break in a one-line text, a malformed query', () => {
    const { call } = signedIn();
    assert.equal(call('POST', `/v1/admin/affiliates/${ANNA}/payouts`, { amountMinor: 100, notes: 'rad ett\nrad två' }).status, 400);
    const open = call('GET', `/v1/admin/affiliates/${ERIK}/payouts`).body.payouts[0];
    assert.equal(call('POST', `/v1/admin/affiliates/payouts/${open.payoutId}/void`, { reason: 'a\nb' }).status, 400);
    for (const path of [
      '/v1/admin/affiliates?limit=0', '/v1/admin/affiliates?status=gone', '/v1/admin/affiliates?cursor=x',
      '/v1/admin/affiliates/applications?status=active', '/v1/admin/affiliates/analytics?since=yesterday',
      `/v1/admin/affiliates/analytics?since=${new Date(Date.now() + 86_400_000).toISOString()}`,
      `/v1/admin/affiliates/${ANNA}/ledger?limit=101`, `/v1/admin/affiliates/${ANNA}/orders?bogus=1`,
    ]) assert.equal(call('GET', path).status, 400, path);
    // A denial may span lines (parseMessage).
    assert.equal(call('POST', '/v1/admin/affiliates/applications/aa000000-0000-4000-8000-000000000002/deny', { reason: 'Rad ett\nrad två' }).status, 200);
  });

  it('conversions30d counts the accruals of the last 30 days, not all time', () => {
    const { call } = signedIn();
    const anna = call('GET', '/v1/admin/affiliates').body.affiliates.find((a) => a.code === 'ANNA10');
    const recent = call('GET', `/v1/admin/affiliates/${ANNA}/ledger`).body.entries
      .filter((e) => e.kind === 'accrual' && Date.parse(e.createdAt) >= Date.now() - 30 * 86_400_000).length;
    assert.equal(anna.conversions30d, recent);
  });
});
