// The terms versions' adapter under Node (unit CP5-FL).
//   node --test src/admin-app/adapters/termsVersions.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toPagePlatformTerms } from '../../storefront/adapters/legal.js';
import {
  archiveConfirm,
  byteLength,
  composeTermsText,
  newVersionBody,
  parseTermsText,
  publishConfirm,
  suggestedVersionLabel,
  termsRefusalMessage,
  versionRows,
} from './termsVersions.js';

describe('the list', () => {
  it('the current one, the scheduled ones before it, the superseded after it (newest first)', () => {
    const rows = versionRows([
      { version: 'c', publishedAt: '2027-01-01T00:00:00.000Z', sha256: 'x', textArchived: true, current: false },
      { version: 'b', publishedAt: '2026-09-07T00:00:00.000Z', sha256: 'y', textArchived: false, current: true },
      { version: 'a', publishedAt: '2026-06-01T00:00:00.000Z', sha256: 'z', textArchived: true, current: false },
    ]);
    assert.deepEqual(rows.map((r) => [r.version, r.state, r.textArchived]), [['c', 'scheduled', true], ['b', 'current', false], ['a', 'superseded', true]]);
  });

  it('without a current version every listed one is scheduled; junk is left out', () => {
    assert.deepEqual(versionRows([{ version: 'x', current: false }, { version: '' }, null]).map((r) => r.state), ['scheduled']);
    assert.deepEqual(versionRows(null), []);
  });
});

describe('the text format the seller\'s pages read', () => {
  it('composes the seed\'s JSON { version, terms, dpa } and the gate\'s own adapter reads it back', () => {
    const text = composeTermsText({ version: 'v2', terms: '## A\n\n{{last_updated}}', dpa: '## B' });
    assert.equal(text, '{"version":"v2","terms":"## A\\n\\n{{last_updated}}","dpa":"## B"}');
    assert.deepEqual(parseTermsText(text), { terms: '## A\n\n{{last_updated}}', dpa: '## B' });
    const shown = toPagePlatformTerms({ version: 'v2', text }, { render: (md) => md, dpaTitle: 'D' });
    assert.equal(shown.terms.html, '## A\n\nv2');
    assert.equal(shown.dpa.html, '## B');
  });

  it('a text in another format is not one the sellers can read', () => {
    assert.equal(parseTermsText('plain text'), null);
    assert.equal(parseTermsText('{"terms":"x"}'), null);
    assert.equal(parseTermsText(null), null);
  });
});

describe('a new version', () => {
  it('the Worker\'s label grammar, a free label, both documents, at most 256 kB', () => {
    const ok = newVersionBody({ version: ' 2026-10-04 ', terms: 'T', dpa: 'D' }, []);
    assert.deepEqual(ok, { version: '2026-10-04', text: composeTermsText({ version: '2026-10-04', terms: 'T', dpa: 'D' }) });
    assert.match(newVersionBody({ version: 'två ord', terms: 'T', dpa: 'D' }).problem, /bokstäver a–z/);
    assert.match(newVersionBody({ version: 'x'.repeat(33), terms: 'T', dpa: 'D' }).problem, /32 tecken/);
    assert.match(newVersionBody({ version: 'v', terms: 'T', dpa: 'D' }, [{ version: 'v' }]).problem, /redan en version/);
    assert.match(newVersionBody({ version: 'v', terms: ' ', dpa: 'D' }).problem, /Både/);
    assert.match(newVersionBody({ version: 'v', terms: 'å'.repeat(140_000), dpa: 'D' }).problem, /256 kB/);
    assert.equal(byteLength('å'), 2);
  });

  it('suggests the day, then the day with a number when it is taken', () => {
    const day = new Date(2026, 9, 4, 12);
    assert.equal(suggestedVersionLabel(day, []), '2026-10-04');
    assert.equal(suggestedVersionLabel(day, [{ version: '2026-10-04' }, { version: '2026-10-04-2' }]), '2026-10-04-3');
  });

  it('the publish confirm says what it does to every shop before it is done', () => {
    const c = publishConfirm('2026-10-04', '2026-09-07');
    const all = c.lines.join(' ');
    assert.equal(c.title, 'Publicera plattformsvillkoren 2026-10-04?');
    assert.equal(c.tone, 'danger');
    assert.match(all, /ersätter 2026-09-07/);
    assert.match(all, /måste godkänna/);
    assert.match(all, /Bara butikens egen admin/);
    assert.match(all, /godkänt 2026-09-07 kan fortsätta ta betalt i 14 dagar/); // D47
    assert.match(all, /ingen frist: kassan stängs direkt/); // D54
    assert.match(all, /inom sitt dygn/); // D48
    assert.match(all, /aldrig ändras eller tas bort/);
    const first = publishConfirm('v1', null).lines.join(' ');
    assert.match(first, /Ingen version gäller i dag/);
    assert.doesNotMatch(first, /14 dagar/);
    assert.match(archiveConfirm('2026-09-07').lines.join(' '), /exakt den kontrollsumma/);
  });
});

describe('refusals as Swedish sentences', () => {
  it('names each code of the routes', () => {
    assert.match(termsRefusalMessage({ code: 'terms_version_exists' }), /redan en version/);
    assert.match(termsRefusalMessage({ code: 'terms_version_not_latest' }), /efter den senaste/);
    assert.match(termsRefusalMessage({ code: 'terms_text_hash_mismatch' }), /kontrollsumma/);
    assert.match(termsRefusalMessage({ status: 413, code: 'payload_too_large' }), /256 kB/);
    assert.match(termsRefusalMessage({ code: 'invalid_request' }), /32 tecken/);
    assert.match(termsRefusalMessage({ status: 404, code: 'not_found' }), /villkorsarkivet/);
    assert.match(termsRefusalMessage({ status: 500, code: 'x' }, 'Arkiveringen'), /^Arkiveringen gick inte igenom.*HTTP 500/);
  });
});
