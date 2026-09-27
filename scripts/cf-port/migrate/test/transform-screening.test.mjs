import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformContentScreening } from '../lib/transform-screening.mjs';

test('transformContentScreening: normalises terms exactly as the Worker matcher does, dedupes by matcher key', () => {
  const doc = {
    data: {
      blocklist: [
        { kind: 'brand', note: '', term: 'Nike' },
        { kind: 'band', note: 'Swedish band', term: 'Kent' },
        { kind: 'other', note: 'trademark', term: '™' },
        { kind: 'other', note: 'empty', term: '   ' },
      ],
      hardBlock: false,
      reviewFirstProducts: 2,
    },
  };
  const { problems, report, rows } = transformContentScreening({ contentScreeningDoc: doc, nowMillis: Date.parse('2026-01-01T00:00:00.000Z') });
  assert.equal(report.termCount, 3);
  assert.equal(report.termsDropped.length, 1);
  assert.ok(problems.some((p) => p.includes('normalises to nothing')));
  const termRows = rows.filter((r) => r.table === 'content_screening_terms');
  assert.equal(termRows.length, 3);
  const nikeRow = termRows.find((r) => r.pk === 'nike');
  assert.ok(nikeRow);
});

test('transformContentScreening: writes hard_block/review_first_products into platform_settings', () => {
  const doc = { data: { blocklist: [], hardBlock: true, reviewFirstProducts: 5 } };
  const { report, rows } = transformContentScreening({ contentScreeningDoc: doc, nowMillis: Date.parse('2026-01-01T00:00:00.000Z') });
  assert.equal(report.hardBlock, true);
  assert.equal(report.reviewFirstProducts, 5);
  const settingsRow = rows.find((r) => r.table === 'platform_settings' && r.pk === '1:screening').statement;
  assert.match(settingsRow, /review_first_products = 5/);
  assert.match(settingsRow, /screening_hard_block = 1/);
});

test('transformContentScreening: bumps screening_terms_version by exactly one via a self-referencing UPDATE', () => {
  const doc = { data: { blocklist: [], hardBlock: false, reviewFirstProducts: 2 } };
  const { rows } = transformContentScreening({ contentScreeningDoc: doc, nowMillis: Date.parse('2026-01-01T00:00:00.000Z') });
  const bumpRow = rows.find((r) => r.pk === '1:terms_version_bump').statement;
  assert.equal(bumpRow, 'UPDATE platform_settings SET screening_terms_version = screening_terms_version + 1 WHERE id = 1;');
});

test('transformContentScreening: absent doc reports a problem and emits no rows', () => {
  const { problems, rows } = transformContentScreening({ contentScreeningDoc: null, nowMillis: Date.parse('2026-01-01T00:00:00.000Z') });
  assert.deepEqual(rows, []);
  assert.ok(problems.length > 0);
});

test('transformContentScreening: two source terms normalising to the same matcher key keep the first, drop the rest', () => {
  const doc = {
    data: {
      blocklist: [
        { kind: 'brand', term: 'Nike' },
        { kind: 'brand', term: 'nike' }, // same matcher key as above
      ],
    },
  };
  const { report, rows } = transformContentScreening({ contentScreeningDoc: doc, nowMillis: Date.parse('2026-01-01T00:00:00.000Z') });
  assert.equal(report.termCount, 1);
  const termRows = rows.filter((r) => r.table === 'content_screening_terms');
  assert.equal(termRows.length, 1);
});
