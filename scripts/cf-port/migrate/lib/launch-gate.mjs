/**
 * scripts/cf-port/migrate/lib/launch-gate.mjs — CP7-T2: manifest (e) 19, "every
 * A and B item of docs/SnapWearDocs/LAUNCH_TODO.md ☑ (PLAN §0)", decided the way
 * the preflight decides it (scripts/cf-preflight.sh check 6, `cmd_launch`):
 *
 *   launchRequiredItems(preflightText)  the preflight's own LAUNCH_REQUIRED list,
 *                                       READ from the script (never restated here),
 *                                       so a narrowed gate (decision 1.3) is
 *                                       followed; a list it cannot read throws
 *   launchGateStatus(todoText, required) { notDone, duplicate } with the parse of
 *                                       cmd_launch: a table row whose first cell
 *                                       is A<n>/B<n>, its "Status" column, done
 *                                       only when it starts with ☑; an item that
 *                                       appears twice is `duplicate` (the
 *                                       preflight refuses it)
 *
 * test/launch-gate.test.mjs runs the preflight's own Python helper on the same
 * inputs and requires the same verdict. Reads text it is given; writes nothing.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const PREFLIGHT_FILE = path.join(REPO_ROOT, 'scripts', 'cf-preflight.sh');
export const LAUNCH_TODO_FILE = path.join(REPO_ROOT, 'docs', 'SnapWearDocs', 'LAUNCH_TODO.md');

const DONE = '☑'; // BALLOT BOX WITH CHECK, as cmd_launch

/** One `["X%d" % i for i in <(…) | range(a, b)>]` term of the Python list. */
function termItems(letter, spec) {
  const range = /^range\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(spec);
  if (range) {
    const out = [];
    for (let n = Number(range[1]); n < Number(range[2]); n += 1) out.push(`${letter}${n}`);
    return out;
  }
  const tuple = /^\(\s*(\d+(?:\s*,\s*\d+)*)\s*,?\s*\)$/.exec(spec);
  if (tuple) return tuple[1].split(',').map((n) => `${letter}${Number(n.trim())}`);
  return null;
}

export function launchRequiredItems(preflightText) {
  const line = preflightText.split('\n').find((l) => l.startsWith('LAUNCH_REQUIRED = '));
  if (line === undefined) throw new Error('scripts/cf-preflight.sh has no LAUNCH_REQUIRED line: the launch gate cannot be read');
  const terms = line.slice('LAUNCH_REQUIRED = '.length).split(/\]\s*\+\s*\[/).map((t) => t.replace(/^\[|\]$/g, '').trim());
  const items = [];
  for (const term of terms) {
    const match = /^"([AB])%d"\s*%\s*i\s+for\s+i\s+in\s+(.+)$/.exec(term);
    const listed = match ? termItems(match[1], match[2].trim()) : null;
    if (listed === null) throw new Error('scripts/cf-preflight.sh LAUNCH_REQUIRED has a shape this reader does not know: read it again');
    items.push(...listed);
  }
  return items;
}

export function launchGateStatus(todoText, required) {
  const status = {};
  let duplicate = null;
  let header = null;
  for (const line of todoText.split('\n')) {
    if (!line.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = line.trim().replace(/^\|+|\|+$/g, '').split('|').map((cell) => cell.trim());
    if (header === null) {
      header = cells;
      continue;
    }
    if (cells.join('').replace(/^[-: ]+|[-: ]+$/g, '') === '' || !/^[AB]\d+$/.test(cells[0])) continue;
    const column = header.findIndex((cell) => cell.toLowerCase() === 'status');
    if (Object.hasOwn(status, cells[0]) && duplicate === null) duplicate = cells[0];
    status[cells[0]] = column !== -1 && column < cells.length ? cells[column] : '';
  }
  return { duplicate, notDone: required.filter((item) => !(status[item] ?? '').startsWith(DONE)) };
}
