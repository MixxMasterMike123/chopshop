// The dev API's rows for a shop's own admins (unit FH, D100): list, invite,
// revoke, in the Worker's shapes and refusals (cloudflare/src/routes/
// admin-members.ts, docs/cf-port/CP5_WC_REPORT.md). INVENTED DATA ONLY
// (members-fixtures.json); changes are held in memory per dev server.
//
// The Worker's rules, small: at most 20 active admins (409 member_limit); the
// address of a platform user or any non-shop-admin account is 409 not_addable
// (the same answer for all of them); an address that is already an active
// member is 409 already_member; revoking yourself is 409 cannot_revoke_self;
// revoking the last admin who counts is 409 last_admin; an unknown or already
// revoked id is the opaque 404.
//
// Scenarios, by the cookie `admin_dev_fh` (document.cookie =
// 'admin_dev_fh=full; path=/'; remove with Max-Age=0):
//   full        the cap is the number of active admins now (the next invite: member_limit)
//   error       every read answers 500
//   noinvite    the invite answers 503 email_unavailable (the person is added)
//   ratelimit   the invite answers 429 rate_limited

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'members-fixtures.json');
const CAP = 20;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Route not found' } });
const refused = (status, code, message) => json(status, { error: { code, message } });

function scenario(headers) {
  for (const part of (headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 'admin_dev_fh') return rest.join('=');
  }
  return '';
}

function held(state, shopId) {
  state.fh ??= new Map();
  if (!state.fh.has(shopId)) {
    const seed = JSON.parse(readFileSync(FIXTURES, 'utf8')).members[shopId] ?? [];
    state.fh.set(shopId, structuredClone(seed));
  }
  return state.fh.get(shopId);
}

const shopIdOf = (shop) => shop.shop.tenantId;
const viewOf = (m, entry) => ({ ...m, self: entry.user.id === m.userId });
const counting = (list) => list.filter((m) => m.status === 'active');

export const MEMBER_ROUTES = [
  ['GET', '/v1/admin/members', (state, { shop, entry, headers }) => {
    if (scenario(headers) === 'error') return refused(500, 'internal_error', 'Something went wrong');
    return json(200, { members: held(state, shopIdOf(shop)).map((m) => viewOf(m, entry)) });
  }],

  ['POST', '/v1/admin/members', (state, { shop, entry, headers, body }) => {
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join() : '';
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const name = typeof body?.name === 'string' ? body.name : '';
    const nameOk = name.length >= 1 && name.length <= 100 && name === name.trim();
    if (keys !== 'email,name' || !EMAIL.test(email) || email.length > 254 || !nameOk) {
      return refused(400, 'invalid_request', 'Request is not valid');
    }
    const mode = scenario(headers);
    if (mode === 'ratelimit') return refused(429, 'rate_limited', 'Too many requests');
    const list = held(state, shopIdOf(shop));
    // A known account that cannot be a shop admin: one answer for every case.
    const known = state.fixtures.users.find((u) => u.user.email === email);
    if (known && known.accountType !== 'tenant_admin') return refused(409, 'not_addable', 'The address cannot be added to this shop');
    if (counting(list).some((m) => m.email === email)) return refused(409, 'already_member', 'Already a member');
    const cap = mode === 'full' ? counting(list).length : CAP;
    if (counting(list).length >= cap) return refused(409, 'member_limit', 'A shop has at most 20 active admins');
    const member = {
      userId: known?.user.id ?? `user-${randomBytes(6).toString('hex')}`,
      email, name: name,
      status: 'active', invited: true, joinedAt: new Date().toISOString(),
    };
    // A revoked person coming back is the same row again; the dev API just appends.
    list.push(known ? { ...member, name: known.user.name, invited: false } : member);
    if (mode === 'noinvite') return refused(503, 'email_unavailable', 'The invite email could not be queued');
    return json(201, { member: viewOf({ ...member, userId: member.userId }, entry) });
  }],

  ['POST', /^\/v1\/admin\/members\/([^/]+)\/revoke$/, (state, { shop, entry, segments }) => {
    const list = held(state, shopIdOf(shop));
    const userId = decodeURIComponent(segments[0]);
    const index = list.findIndex((m) => m.userId === userId);
    if (index === -1) return notFound();
    if (userId === entry.user.id) return refused(409, 'cannot_revoke_self', 'You cannot revoke yourself');
    if (list[index].status === 'active' && counting(list).length <= 1) return refused(409, 'last_admin', 'The shop needs at least one admin');
    list.splice(index, 1);
    return json(200, { revoked: { userId } });
  }],
];
