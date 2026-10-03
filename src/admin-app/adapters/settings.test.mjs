// node --test src/admin-app/adapters/settings.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acceptPagesBody,
  acceptanceFromView,
  customPagesOf,
  gateFieldsOf,
  identityPartOf,
  mergeLikeFirestore,
  readinessFromStatus,
  refusedTextKeys,
  settingsPutBody,
  textsChangedSince,
} from './settings.js';

const TEXTS = { kopvillkor: '<h1>K</h1>', angerratt: '<h1>A</h1>', integritetspolicy: '<h1>I</h1>' };
const NONE = { kopvillkor: false, angerratt: false, integritetspolicy: false };

describe('mergeLikeFirestore', () => {
  it('merges plain objects at every depth and replaces arrays and scalars', () => {
    const base = { a: 1, legal: { custom: { kopvillkor: true }, noWithdrawalNotice: 'x' }, list: [1, 2], keep: 'k' };
    const out = mergeLikeFirestore(base, { a: 2, legal: { custom: { angerratt: true } }, list: [3], skip: undefined });
    assert.deepEqual(out, {
      a: 2,
      keep: 'k',
      legal: { custom: { kopvillkor: true, angerratt: true }, noWithdrawalNotice: 'x' },
      list: [3],
    });
    assert.deepEqual(base.legal.custom, { kopvillkor: true }, 'the base is not changed');
  });

  it('null replaces an object', () => {
    assert.deepEqual(mergeLikeFirestore({ theme: { a: 1 } }, { theme: null }), { theme: null });
  });
});

describe('settingsPutBody (the read-modify-write)', () => {
  const current = {
    storeIdentity: { tagline: 'old', menu: [{ id: 'm' }], logoObjectId: 'obj-1', legal: { customTexts: { kopvillkor: '<p>own</p>' } } },
    returnAddress: 'R', vatRegistered: true, vatNumber: 'SE1', sellerType: 'company', updatedAt: 'x',
  };

  it('keeps every stored key the patch does not name, and replaces those it names', () => {
    const body = settingsPutBody(current, { tagline: 'new', legal: { noWithdrawalNotice: 'n' } });
    assert.deepEqual(body, {
      storeIdentity: {
        tagline: 'new',
        menu: [{ id: 'm' }],
        logoObjectId: 'obj-1',
        legal: { customTexts: { kopvillkor: '<p>own</p>' }, noWithdrawalNotice: 'n' },
      },
    });
  });

  it('never sends the platform keys (D99) and lifts the gate keys to the top level', () => {
    const body = settingsPutBody(current, {
      shopName: 'X', supportEmail: 'a@example.com', vatRate: 0.25, currency: 'SEK', __loaded: true,
      returnAddress: '', vatRegistered: false, vatNumber: '  ', sellerType: '',
      legal: { acceptance: { acceptedAt: 't' }, custom: { kopvillkor: true } },
    });
    for (const key of ['shopName', 'supportEmail', 'vatRate', 'currency', '__loaded', 'returnAddress', 'vatRegistered', 'vatNumber', 'sellerType']) {
      assert.equal(Object.hasOwn(body.storeIdentity, key), false, key);
    }
    assert.equal(Object.hasOwn(body.storeIdentity.legal, 'acceptance'), false);
    assert.deepEqual(body.storeIdentity.legal.custom, { kopvillkor: true });
    assert.equal(body.returnAddress, null);
    assert.equal(body.vatRegistered, false);
    assert.equal(body.vatNumber, null);
    assert.equal(body.sellerType, null);
  });

  it('drops a refused key that the stored identity carries', () => {
    const body = settingsPutBody({ storeIdentity: { shopName: 'stale', payments: {}, legal: { acceptance: {} }, ok: 1 } }, {});
    assert.deepEqual(body, { storeIdentity: { ok: 1, legal: {} } });
  });

  it('a patch without gate keys sends none of them', () => {
    assert.deepEqual(Object.keys(settingsPutBody(current, { legal: { customUpdatedAt: 't' } })), ['storeIdentity']);
  });

  it('works on a shop with no settings yet', () => {
    assert.deepEqual(settingsPutBody(null, { tagline: 't', vatRegistered: true }), { storeIdentity: { tagline: 't' }, vatRegistered: true });
  });

  it('identityPartOf / gateFieldsOf separate the two', () => {
    assert.deepEqual(identityPartOf({ returnAddress: 'r', a: 1 }), { a: 1 });
    assert.deepEqual(gateFieldsOf({ returnAddress: 'r', vatRegistered: 'yes', sellerType: 'individual' }),
      { returnAddress: 'r', vatRegistered: null, sellerType: 'individual' });
  });
});

describe('readinessFromStatus', () => {
  const ready = { returnAddress: true, vatAnswered: true, legalPagesAccepted: true, ready: true };

  it('ready when the terms gate is open and the three hold', () => {
    assert.deepEqual(readinessFromStatus({ accepted: true, inGrace: false, readiness: ready }), { ready: true, blockers: [] });
    assert.equal(readinessFromStatus({ accepted: false, inGrace: true, readiness: ready }).ready, true);
  });

  it('lists every blocker with the labels of legalPageReadiness.js', () => {
    const r = readinessFromStatus({ accepted: false, inGrace: false, readiness: { returnAddress: false, vatAnswered: false, legalPagesAccepted: false, ready: false } });
    assert.equal(r.ready, false);
    assert.deepEqual(r.blockers.map((b) => b.key), ['platformTerms', 'returnAddress', 'vatRegistered', 'acceptance']);
    assert.equal(r.blockers[1].label, 'Returadress saknas');
  });

  it('null for an answer without readiness', () => {
    assert.equal(readinessFromStatus(null), null);
    assert.equal(readinessFromStatus({ accepted: true }), null);
  });
});

describe('acceptanceFromView', () => {
  it('the pointer the page reads; no person in it', () => {
    assert.deepEqual(acceptanceFromView({ acceptanceId: 'a1', acceptedAt: '2026-10-03T10:00:00.000Z', templateVersion: '2026-09-07', textsSha256: 'x' }),
      { acceptedAt: '2026-10-03T10:00:00.000Z', templateVersion: '2026-09-07', acceptanceId: 'a1' });
  });
  it('an imported row with only `version`', () => {
    assert.equal(acceptanceFromView({ acceptedAt: 't', templateVersion: null, version: 'v1' }).templateVersion, 'v1');
  });
  it('null for nothing adopted', () => {
    assert.equal(acceptanceFromView(null), null);
  });
});

describe('acceptPagesBody (the exact body of accept-pages)', () => {
  it('exactly the four keys, the texts unchanged, the per-page custom map', () => {
    const body = acceptPagesBody({ templateVersion: '2026-09-07', texts: TEXTS, pod: true, customPages: { ...NONE, angerratt: true } });
    assert.deepEqual(Object.keys(body).sort(), ['custom', 'pod', 'templateVersion', 'texts']);
    assert.deepEqual(body.texts, TEXTS);
    assert.deepEqual(body.custom, { kopvillkor: false, angerratt: true, integritetspolicy: false });
    assert.equal(body.pod, true);
  });

  it('refuses before sending: an empty or missing text, an extra page, a bad version, a non-boolean', () => {
    assert.throws(() => acceptPagesBody({ templateVersion: 'v', texts: { ...TEXTS, angerratt: '' }, pod: false, customPages: NONE }));
    assert.throws(() => acceptPagesBody({ templateVersion: 'v', texts: { kopvillkor: 'a', angerratt: 'b' }, pod: false, customPages: NONE }));
    assert.throws(() => acceptPagesBody({ templateVersion: 'v', texts: { ...TEXTS, extra: 'x' }, pod: false, customPages: NONE }));
    assert.throws(() => acceptPagesBody({ templateVersion: 'v 1', texts: TEXTS, pod: false, customPages: NONE }));
    assert.throws(() => acceptPagesBody({ templateVersion: 'v', texts: TEXTS, pod: 'yes', customPages: NONE }));
    assert.throws(() => acceptPagesBody({ templateVersion: 'v', texts: TEXTS, pod: false, customPages: { kopvillkor: true } }));
  });

  it('customPagesOf / refusedTextKeys', () => {
    assert.deepEqual(customPagesOf({ kopvillkor: true, angerratt: 'x' }), { kopvillkor: true, angerratt: false, integritetspolicy: false });
    assert.deepEqual(refusedTextKeys({ kopvillkor: true, angerratt: false, integritetspolicy: true }), ['kopvillkor', 'integritetspolicy']);
    assert.deepEqual(refusedTextKeys(NONE), []);
  });
});

describe('textsChangedSince', () => {
  const adopted = { templateVersion: '2026-09-07', customPages: { ...NONE, angerratt: true }, pageSha256: { angerratt: 'sha-a', kopvillkor: 't', integritetspolicy: 't' } };
  const now = { templateVersion: '2026-09-07', customPages: { ...NONE, angerratt: true }, shas: { angerratt: 'sha-a' } };

  it('nothing adopted → null; the same → false', () => {
    assert.equal(textsChangedSince(null, now), null);
    assert.equal(textsChangedSince(adopted, now), false);
  });
  it('a newer template, an edited own text, a page switched either way → true', () => {
    assert.equal(textsChangedSince(adopted, { ...now, templateVersion: '2027-01-01' }), true);
    assert.equal(textsChangedSince(adopted, { ...now, shas: { angerratt: 'other' } }), true);
    assert.equal(textsChangedSince(adopted, { ...now, customPages: NONE, shas: {} }), true);
    assert.equal(textsChangedSince(adopted, { ...now, customPages: { ...now.customPages, kopvillkor: true }, shas: { angerratt: 'sha-a', kopvillkor: 'new' } }), true);
  });
  it('an imported summary-only adoption', () => {
    assert.equal(textsChangedSince({ version: 'v', custom: true, customPages: null, pageSha256: {} }, { templateVersion: 'v', customPages: NONE }), true);
    assert.equal(textsChangedSince({ version: 'v', custom: false, customPages: null }, { templateVersion: 'v', customPages: NONE }), false);
  });
});
