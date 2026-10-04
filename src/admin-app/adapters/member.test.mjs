// node --test src/admin-app/adapters/member.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INVITE_MAIL_FAILED, RESEND_UNCLEAR, memberActionMessage, memberRowsOf, isInviteMailFailure,
  resendDoneMessage, resendGoneMessage, resendRefusal,
} from './member.js';

const m = (o) => ({ userId: 'u', email: 'a@example.com', name: 'A', status: 'active', invited: false, joinedAt: '2026-09-01T10:00:00.000Z', self: false, ...o });

describe('memberRowsOf', () => {
  it('maps a member onto the fields the table reads', () => {
    const [row] = memberRowsOf([m({ userId: 'x', name: 'Ada', self: true }), m({ userId: 'y' })]);
    assert.equal(row.id, 'x');
    assert.equal(row.companyName, 'Ada');
    assert.equal(row.contactPerson, '');
    assert.equal(row.role, 'admin');
    assert.equal(row.active, true);
    assert.equal(row.createdAt, '2026-09-01T10:00:00.000Z');
  });
  it('self is blocked, and so is the only admin who counts', () => {
    const rows = memberRowsOf([m({ userId: 'a', self: true }), m({ userId: 'b' })]);
    assert.deepEqual(rows.map((r) => r.revokeBlock), ['self', null]);
    assert.equal(memberRowsOf([m({ userId: 'a' })])[0].revokeBlock, 'last_admin');
  });
  it('a suspended member does not count towards the last admin', () => {
    const rows = memberRowsOf([m({ userId: 'a' }), m({ userId: 'b', status: 'suspended' })]);
    assert.equal(rows[0].revokeBlock, 'last_admin');
    assert.equal(rows[1].suspended, true);
    assert.equal(rows[1].active, false);
    assert.equal(rows[1].revokeBlock, null);
  });
  it('invited only while active; junk rows are dropped', () => {
    const rows = memberRowsOf([m({ userId: 'a', invited: true }), m({ userId: 'b', invited: true, status: 'suspended' }), null, {}]);
    assert.deepEqual(rows.map((r) => r.invited), [true, false]);
    assert.deepEqual(memberRowsOf(undefined), []);
  });
});

describe('memberActionMessage', () => {
  it('says each refusal in Swedish', () => {
    assert.match(memberActionMessage({ status: 409, code: 'already_member' }), /redan administratör/);
    assert.equal(memberActionMessage({ status: 409, code: 'not_addable' }), 'Adressen kan inte läggas till som administratör.');
    assert.match(memberActionMessage({ status: 409, code: 'member_limit' }), /20 administratörer/);
    assert.match(memberActionMessage({ status: 409, code: 'cannot_revoke_self' }), /dig själv/);
    assert.match(memberActionMessage({ status: 409, code: 'last_admin' }), /minst en/);
    assert.match(memberActionMessage({ status: 429, code: 'rate_limited' }), /Försök igen/);
    assert.equal(memberActionMessage({ status: 503, code: 'email_unavailable' }), INVITE_MAIL_FAILED);
    assert.match(memberActionMessage({ status: 404, code: 'not_found' }), /hittades inte/);
    assert.equal(memberActionMessage({ status: 500, code: 'internal_error' }), null);
    assert.equal(memberActionMessage(null), null);
  });
  it('the mail failure is told apart', () => {
    assert.equal(isInviteMailFailure({ status: 503, code: 'email_unavailable' }), true);
    assert.equal(isInviteMailFailure({ status: 503, code: 'x' }), false);
  });
});

describe('"Skicka inbjudan igen" (CP5-FP)', () => {
  it('a new link: the old one stops working', () => {
    assert.match(resendDoneMessage('a@example.com', { expiresAt: '2026-10-07T10:00:00.000Z' }), /ny inbjudningslänk.*a@example\.com.*tidigare länken fungerar inte längre.*gäller till/);
    assert.doesNotMatch(resendDoneMessage('a@example.com', null), /gäller till/);
  });

  it('each refusal: who must reload, and when to try again', () => {
    assert.deepEqual(resendRefusal({ status: 409, code: 'not_invited' }, 'a@example.com'), { message: 'a@example.com har redan valt ett lösenord, så ingen ny inbjudan behövs.', reload: true });
    assert.match(resendRefusal({ status: 409, code: 'not_invitable' }, 'a').message, /spärrat av plattformen/);
    assert.match(resendRefusal({ status: 429, code: 'rate_limited', retryAfterSeconds: 900 }, 'a').message, /om 15 minuter/);
    assert.match(resendRefusal({ status: 429, code: 'rate_limited', retryAfterSeconds: 7200 }, 'a').message, /om 2 timmar/);
    assert.match(resendRefusal({ status: 429, code: 'rate_limited' }, 'a').message, /om en stund/);
    assert.match(resendRefusal({ status: 503, code: 'email_unavailable' }, 'a').message, /kunde inte skickas just nu, och den tidigare länken fungerar inte längre/);
    assert.equal(resendRefusal({ status: 404, code: 'not_found' }, 'a'), null);
    assert.equal(resendRefusal({ status: 502, code: 'bad_gateway' }, 'a'), null);
  });

  it('a 404 after the list was read again: gone, or the route is off here', () => {
    assert.match(resendGoneMessage(false, 'a@example.com'), /inte längre administratör/);
    assert.match(resendGoneMessage(true, 'a@example.com'), /inte påslagen i den här miljön/);
    assert.match(RESEND_UNCLEAR, /oklart.*Du kan skicka igen/);
  });
});
