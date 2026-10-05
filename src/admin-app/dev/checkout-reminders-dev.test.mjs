// node --test src/admin-app/dev/checkout-reminders-dev.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createState, route } from './dev-api.mjs';

function signedIn(email = 'admin@example.com', password = 'dev-password-1', extraCookie = '') {
  const state = createState();
  const r = route(state, 'POST', new URL('http://x/_api/api/auth/sign-in/email'), {}, { email, password });
  const cookie = `${r.setCookie.split(';')[0]}${extraCookie}`;
  const call = (method, path, body = null, shop = 'test-shop-a') =>
    route(state, method, new URL(`http://x/_api${path}`), { cookie, 'x-shop-id': shop }, body);
  return { call };
}

const PATH = '/v1/admin/checkout-reminders';

describe('the seller\'s switch, dev rows (CP9-AC)', () => {
  it('starts off, turns on with a date, keeps the date while on and off', () => {
    const { call } = signedIn();
    const first = call('GET', PATH);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.checkoutReminders, {
      delayHours: 1, enabled: false, enabledAt: null, mailConfigured: true, queuedLast30Days: 3, updatedAt: null,
    });
    const on = call('PUT', PATH, { delayHours: 4, enabled: true }).body.checkoutReminders;
    assert.equal(on.enabled, true);
    assert.match(on.enabledAt, /^\d{4}-\d{2}-\d{2}T/);
    const off = call('PUT', PATH, { delayHours: 4, enabled: false }).body.checkoutReminders;
    assert.equal(off.enabledAt, on.enabledAt);
  });

  it('refuses any other body, as the Worker does', () => {
    const { call } = signedIn();
    for (const body of [{ enabled: true }, { delayHours: 0, enabled: true }, { delayHours: 25, enabled: true }, { delayHours: 1, enabled: 'ja' }, { delayHours: 1, enabled: true, x: 1 }]) {
      assert.equal(call('PUT', PATH, body).status, 400, JSON.stringify(body));
    }
  });

  it('is the opaque 404 while the add-on is off, and says when no mail can leave', () => {
    const { call } = signedIn('admin-multi@example.com', 'dev-password-5');
    assert.equal(call('GET', PATH, null, 'test-shop-c').status, 404);
    const noMail = signedIn('admin@example.com', 'dev-password-1', '; admin_dev_mail=off');
    assert.equal(noMail.call('GET', PATH).body.checkoutReminders.mailConfigured, false);
  });
});
