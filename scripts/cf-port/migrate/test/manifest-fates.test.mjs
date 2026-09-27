import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLLECTION_FATES,
  SUBCOLLECTION_FATES,
  SETTINGS_DOC_FATES,
} from '../lib/manifest-fates.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'docs/cf-port/MIGRATION_MANIFEST.md');

/**
 * Parses the 75-row table in MIGRATION_MANIFEST.md §1 out of the markdown,
 * returning { rowNumber, subject, fate } for each row, so this test can
 * compare against manifest-fates.mjs WITHOUT hand-copying the table a second
 * time — the two are checked against a common source, the markdown file
 * itself, so they cannot silently drift apart.
 */
function parseManifestTable(markdown) {
  const lines = markdown.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === '## 1. The manifest (75 rows)');
  assert.ok(startIdx !== -1, 'could not find "## 1. The manifest (75 rows)" heading');
  const rows = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('## ')) break; // next section
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is '' (before the first |); cells[1]=#, cells[2]=Collection/doc, cells[3]=Fate
    const rowNum = cells[1];
    if (!/^\d+$/.test(rowNum)) continue; // header / separator rows
    const subjectCell = cells[2];
    const fateCell = cells[3];
    // Subject is inline-code like `activities` or `shops/{id}/legalAcceptances`.
    const subjectMatch = subjectCell.match(/`([^`]+)`/);
    const subject = subjectMatch ? subjectMatch[1] : subjectCell;
    // Fate cell contains bold markers for carry/drop, e.g. "**carry**" or "archive" or "**carry** (admins)".
    const fateMatch = fateCell.match(/(carry|archive|drop)/);
    const fate = fateMatch ? fateMatch[1] : fateCell;
    rows.push({ row: Number(rowNum), subject, fate });
  }
  return rows;
}

const markdown = readFileSync(MANIFEST_PATH, 'utf8');
const parsedRows = parseManifestTable(markdown);

test('parsed exactly 75 rows from the manifest table', () => {
  assert.equal(parsedRows.length, 75);
});

test('every top-level collection row in the manifest matches manifest-fates.mjs', () => {
  const mismatches = [];
  for (const row of parsedRows) {
    // Skip subcollection rows (contain '/') and skip settings/* doc rows.
    if (row.subject.includes('/')) continue;
    const entry = COLLECTION_FATES[row.subject];
    if (!entry) {
      mismatches.push(`manifest-fates.mjs is missing collection ${row.subject} (manifest row ${row.row})`);
      continue;
    }
    if (entry.row !== row.row) {
      mismatches.push(`${row.subject}: row mismatch (manifest ${row.row}, table ${entry.row})`);
    }
    // productsPublic/printersPublic are "drop" in the manifest table but
    // recorded as "verify-only" here per the brief's explicit instruction
    // (§(c): "go to a transient verify file"); treat that as the expected
    // divergence, not a drift failure.
    const expectedFate = entry.fate === 'verify-only' ? 'drop' : entry.fate;
    if (expectedFate !== row.fate) {
      mismatches.push(`${row.subject}: fate mismatch (manifest '${row.fate}', table '${entry.fate}')`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test('manifest-fates.mjs has no EXTRA top-level collections beyond the manifest', () => {
  const manifestNames = new Set(parsedRows.filter((r) => !r.subject.includes('/')).map((r) => r.subject));
  const extra = Object.keys(COLLECTION_FATES).filter((name) => !manifestNames.has(name));
  assert.deepEqual(extra, []);
});

test('subcollection rows (shops/{id}/legalAcceptances, users/{id}/marketingMaterials) match', () => {
  const subRows = parsedRows.filter((r) => r.subject.includes('/') && !r.subject.startsWith('settings/'));
  assert.equal(subRows.length, 2);
  const legal = subRows.find((r) => r.subject.includes('legalAcceptances'));
  const marketing = subRows.find((r) => r.subject.includes('marketingMaterials'));
  assert.equal(SUBCOLLECTION_FATES['shops__legalAcceptances'].fate, legal.fate);
  assert.equal(SUBCOLLECTION_FATES['shops__legalAcceptances'].row, legal.row);
  assert.equal(SUBCOLLECTION_FATES['users__marketingMaterials'].fate, marketing.fate);
  assert.equal(SUBCOLLECTION_FATES['users__marketingMaterials'].row, marketing.row);
});

test('settings/* document rows (67-75) match SETTINGS_DOC_FATES', () => {
  // Rows 67-75 in the table have subject cells like `settings/platform`.
  const settingsRows = parsedRows.filter((r) => r.row >= 67 && r.row <= 75);
  assert.equal(settingsRows.length, 9);
  for (const row of settingsRows) {
    const docId = row.subject.replace(/^settings\//, '');
    const entry = SETTINGS_DOC_FATES[docId];
    assert.ok(entry, `SETTINGS_DOC_FATES is missing ${docId}`);
    assert.equal(entry.row, row.row, `${docId}: row mismatch`);
    assert.equal(entry.fate, row.fate, `${docId}: fate mismatch`);
  }
});

test('the manifest totals line (75 rows = 64 top-level + 2 sub + 9 settings) matches our table sizes', () => {
  const topLevelCount = Object.keys(COLLECTION_FATES).length;
  const subCount = Object.keys(SUBCOLLECTION_FATES).length;
  const settingsCount = Object.keys(SETTINGS_DOC_FATES).length;
  assert.equal(topLevelCount, 64);
  assert.equal(subCount, 2);
  assert.equal(settingsCount, 9);
  assert.equal(topLevelCount + subCount + settingsCount, 75);
});
