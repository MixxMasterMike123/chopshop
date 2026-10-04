/**
 * CP7-T2: lib/launch-gate.mjs decides manifest (e) 19 as the preflight does.
 * The preflight's own Python helper (`cmd_launch`, cut out of
 * scripts/cf-preflight.sh, run with python3 on local files only) gives the
 * verdict each case is compared with.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { LAUNCH_TODO_FILE, PREFLIGHT_FILE, launchGateStatus, launchRequiredItems } from '../lib/launch-gate.mjs';
import { rmDir, tmpDir } from './fixtures.mjs';

const PREFLIGHT = readFileSync(PREFLIGHT_FILE, 'utf8');
const REQUIRED = launchRequiredItems(PREFLIGHT);

/** The preflight's Python helper, verbatim: the heredoc `PY` of scripts/cf-preflight.sh. */
function preflightHelper() {
  const lines = PREFLIGHT.split('\n');
  const start = lines.findIndex((l) => l.startsWith("IFS= read -r -d '' PY <<'PY'"));
  const end = lines.findIndex((l, i) => i > start && l === 'PY');
  assert.ok(start !== -1 && end > start, 'the helper heredoc is where the preflight keeps it');
  return lines.slice(start + 1, end).join('\n');
}

/** The preflight's verdict on a checklist: null (passes) or its refusal line. */
function preflightVerdict(todoText) {
  const base = tmpDir();
  try {
    writeFileSync(path.join(base, 'helper.py'), preflightHelper());
    writeFileSync(path.join(base, 'LAUNCH_TODO.md'), todoText);
    const run = spawnSync('python3', [path.join(base, 'helper.py'), 'launch', path.join(base, 'LAUNCH_TODO.md')], { encoding: 'utf8' });
    return run.status === 0 ? null : `${run.stdout}${run.stderr}`.trim();
  } finally {
    rmDir(base);
  }
}

function checklist(statusOf, extra = '') {
  const rows = REQUIRED.map((item) => `| ${item} | item | K | ${statusOf(item)} | note |`);
  return ['# Launch', '', '| # | Item | Owner | Status | Notes |', '|---|---|---|---|---|', ...rows, '| A8 | not gated | — | ☐ | |', extra, ''].join('\n');
}

test('the required list is the preflight\'s own (A1–A7, A9–A11, A13–A14, B1–B10 today)', () => {
  assert.deepEqual(REQUIRED, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A9', 'A10', 'A11', 'A13', 'A14', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10']);
  assert.throws(() => launchRequiredItems('LAUNCH_REQUIRED = sorted(ITEMS)\n'), /a shape this reader does not know/);
  assert.throws(() => launchRequiredItems('# no list here\n'), /has no LAUNCH_REQUIRED line/);
});

test('every case gets the preflight\'s verdict: all done passes; one open, a missing item, a duplicate and the real checklist refuse', () => {
  const cases = [
    ['all done', checklist(() => '☑')],
    ['B10 open', checklist((item) => (item === 'B10' ? '☐' : '☑'))],
    ['A6 waiting', checklist((item) => (item === 'A6' ? '⏸' : '☑ done'))],
    ['A1 missing', checklist(() => '☑').replace(/^\| A1 \|.*$/m, '')],
    ['B3 twice', checklist(() => '☑', '| B3 | again | K | ☑ | |')],
    ['the real LAUNCH_TODO.md', readFileSync(LAUNCH_TODO_FILE, 'utf8')],
  ];
  for (const [name, text] of cases) {
    const ours = launchGateStatus(text, REQUIRED);
    const theirs = preflightVerdict(text);
    const oursPasses = ours.duplicate === null && ours.notDone.length === 0;
    assert.equal(oursPasses, theirs === null, `${name}: ours ${JSON.stringify(ours)}, the preflight ${theirs}`);
    if (theirs !== null && ours.duplicate === null) {
      assert.ok(theirs.endsWith(`items not marked done: ${ours.notDone.join(', ')}`), `${name}: the same items (${theirs})`);
    }
    if (ours.duplicate !== null) assert.match(theirs, new RegExp(`launch item ${ours.duplicate} appears twice`));
  }
});
