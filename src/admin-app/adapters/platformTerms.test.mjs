// The platform-terms adapter, under Node:
//   node --test src/admin-app/adapters/platformTerms.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { acceptErrorMessage, acceptanceOf, platformTermsStateOf, renderedTermsOf } from './platformTerms.js';

const render = (md) => `<p>${md}</p>`;
const opts = { render, termsTitle: 'Plattformsvillkor', dpaTitle: 'Personuppgiftsbiträdesavtal' };
const archived = (version) => ({
  version,
  sha256: 'f'.repeat(64),
  publishedAt: '2026-09-07T00:00:00.000Z',
  textArchived: true,
  text: JSON.stringify({ version, terms: 'Villkor {{last_updated}}', dpa: 'PUB' }),
});
const status = (over) => ({
  accepted: false,
  acceptedAt: null,
  acceptedVersion: null,
  currentVersion: 'v2',
  graceDeadline: null,
  inGrace: false,
  readiness: {},
  ...over,
});

describe('renderedTermsOf', () => {
  it('renders the archived text of the version, {{last_updated}} = the version, with both titles', () => {
    assert.deepEqual(renderedTermsOf(archived('v2'), opts), {
      version: 'v2',
      terms: { title: 'Plattformsvillkor', html: '<p>Villkor v2</p>' },
      dpa: { title: 'Personuppgiftsbiträdesavtal', html: '<p>PUB</p>' },
    });
  });

  it('null without a version, without a text, or with a text not in the archived format', () => {
    assert.equal(renderedTermsOf(null, opts), null);
    assert.equal(renderedTermsOf({ version: null, text: null }, opts), null);
    assert.equal(renderedTermsOf({ version: 'v2', text: null, textArchived: false }, opts), null);
    assert.equal(renderedTermsOf({ version: 'v2', text: 'not json' }, opts), null);
    assert.equal(renderedTermsOf({ version: 'v2', text: '{"terms":1}' }, opts), null);
  });
});

describe('acceptanceOf', () => {
  it('the current version\'s acceptance, with its date', () => {
    assert.deepEqual(acceptanceOf(status({ accepted: true, acceptedAt: '2026-10-01T09:00:00.000Z', acceptedVersion: 'v2' })), {
      acceptedAt: '2026-10-01T09:00:00.000Z',
      version: 'v2',
    });
  });

  it('an older version\'s acceptance: its version, no date (the status does not carry it)', () => {
    assert.deepEqual(acceptanceOf(status({ acceptedVersion: 'v1', inGrace: true })), { acceptedAt: null, version: 'v1' });
  });

  it('none', () => {
    assert.equal(acceptanceOf(status({})), null);
    assert.equal(acceptanceOf(null), null);
  });
});

describe('platformTermsStateOf', () => {
  it('not accepted, text at hand: the gate asks', () => {
    const s = platformTermsStateOf(status({}), archived('v2'), opts);
    assert.equal(s.accepted, false);
    assert.equal(s.rendered.version, 'v2');
  });

  it('in grace is still asked (the admin gate asks for the current version; grace is the checkout\'s)', () => {
    assert.equal(platformTermsStateOf(status({ acceptedVersion: 'v1', inGrace: true }), archived('v2'), opts).accepted, false);
  });

  it('accepted: not asked, whether the text was read or not', () => {
    const s = status({ accepted: true, acceptedAt: '2026-10-01T09:00:00.000Z', acceptedVersion: 'v2' });
    assert.equal(platformTermsStateOf(s, null, opts).accepted, true);
    assert.equal(platformTermsStateOf(s, archived('v2'), opts).accepted, true);
  });

  it('nothing to sign: no version published, no text to show, or a text of another version', () => {
    assert.equal(platformTermsStateOf(status({ currentVersion: null }), null, opts).accepted, true);
    assert.equal(platformTermsStateOf(status({}), null, opts).accepted, true);
    assert.equal(platformTermsStateOf(status({}), { version: 'v2', text: null }, opts).accepted, true);
    assert.equal(platformTermsStateOf(status({}), archived('v1'), opts).accepted, true);
  });

  it('a status that says accepted without a current version is not trusted as acceptance of anything', () => {
    const s = platformTermsStateOf(status({ accepted: true, currentVersion: null }), null, opts);
    assert.equal(s.accepted, true); // nothing published: nothing to sign
    assert.equal(s.acceptance, null);
  });
});

describe('acceptErrorMessage', () => {
  it('a Swedish message per refusal, never the raw API text', () => {
    assert.match(acceptErrorMessage({ code: 'terms_version_not_current' }), /uppdaterats/);
    assert.match(acceptErrorMessage({ code: 'network_error' }), /kunde inte nås/);
    assert.match(acceptErrorMessage({ code: 'rate_limited' }), /För många/);
    assert.equal(acceptErrorMessage({ code: 'http_error', message: 'HTTP 500' }), 'Kunde inte spara godkännandet. Försök igen.');
    assert.equal(acceptErrorMessage(undefined), 'Kunde inte spara godkännandet. Försök igen.');
  });
});
