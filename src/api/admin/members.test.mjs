// The members calls, under Node: node --test src/api/admin/members.test.mjs
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AdminApiError, setRequestShopId } from './client.js';
import { inviteMember, listMembers, revokeMember } from './members.js';

const realFetch = globalThis.fetch;
let calls;
const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const stub = (handler) => {
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
};
beforeEach(() => { calls = []; setRequestShopId('test-shop-a'); });
afterEach(() => { globalThis.fetch = realFetch; setRequestShopId(null); });

describe('members', () => {
  it('lists with X-Shop-Id', async () => {
    stub(() => answer(200, { members: [{ userId: 'u1' }] }));
    assert.deepEqual(await listMembers(), [{ userId: 'u1' }]);
    assert.equal(calls[0].url, '/_api/v1/admin/members');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers['x-shop-id'], 'test-shop-a');
  });
  it('invites with the two fields only', async () => {
    stub(() => answer(201, { member: { userId: 'u2' } }));
    assert.deepEqual(await inviteMember({ email: 'a@example.com', name: 'Ada' }), { userId: 'u2' });
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'a@example.com', name: 'Ada' });
  });
  it('a refusal carries the code and status', async () => {
    stub(() => answer(409, { error: { code: 'member_limit', message: 'x' } }));
    await assert.rejects(inviteMember({ email: 'a@example.com', name: 'A' }), (e) => e instanceof AdminApiError && e.status === 409 && e.code === 'member_limit');
  });
  it('revokes by an escaped id', async () => {
    stub(() => answer(200, { revoked: { userId: 'u/3' } }));
    await revokeMember({ userId: 'u/3' });
    assert.equal(calls[0].url, '/_api/v1/admin/members/u%2F3/revoke');
    assert.equal(calls[0].init.method, 'POST');
  });
});
