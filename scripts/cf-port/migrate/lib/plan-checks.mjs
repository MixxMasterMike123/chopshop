/**
 * scripts/cf-port/migrate/lib/plan-checks.mjs — the checks a finished plan
 * must pass before it is written, shared by import.mjs and
 * restore-archive.mjs so the two can never differ:
 *
 *   1. only INSERT / UPDATE / SELECT, every statement on one line;
 *   2. no statement over D1's length limit;
 *   3. no Firebase Storage host anywhere in the text;
 *   4. staging only: no source address anywhere in the text (exceptions: an
 *      address mapped to itself, the texts snapshot of a legal acceptance).
 *
 * A problem names a table, a column list or a line number. It never quotes
 * the plan: the text is shop data and can hold an address.
 */

import { scanForbiddenStatements, MAX_STATEMENT_BYTES } from './sql.mjs';
import { FIREBASE_STORAGE_HOSTS } from './scrub.mjs';
import { collectSourceAddresses, scanPlanForSourceAddresses } from './scan-source-addresses.mjs';

/**
 * @param {object} args
 * @param {string} args.env            'staging' | 'production'
 * @param {string} args.planText       the finished plan.sql text
 * @param {object[]} args.rows         every carried row of the plan
 * @param {object} args.sourceDocs     { shops, users, authUsers, legalAcceptances, auditLogs } as read from the bundle
 * @param {object} args.emailMap       the run's email map
 * @param {string[]} args.exemptLiterals  SQL literals left out of the address scan
 * @returns {{ problems: string[], legalTextsAddressCount: number }}
 */
export function planSafetyProblems({ emailMap, env, exemptLiterals = [], planText, rows, sourceDocs = {} }) {
  const problems = [];

  const forbidden = scanForbiddenStatements(planText);
  if (forbidden.length > 0) {
    problems.push(`INTERNAL: generated plan contains a forbidden statement at line ${forbidden[0].line}`);
  }

  for (const row of rows) {
    const bytes = Buffer.byteLength(row.statement, 'utf8');
    if (bytes > MAX_STATEMENT_BYTES) {
      problems.push(`REFUSED: a statement for ${row.table} is ${bytes} bytes, over D1's limit of ${MAX_STATEMENT_BYTES}`);
    }
  }

  const storageHost = FIREBASE_STORAGE_HOSTS.find((host) => planText.includes(host));
  if (storageHost) {
    const tables = [...new Set(rows.filter((row) => row.statement.includes(storageHost)).map((row) => row.table))];
    problems.push(`INTERNAL: plan.sql text contains the Firebase Storage host ${storageHost} (in: ${tables.join(', ') || 'unknown'})`);
  }

  let legalTextsAddressCount = 0;
  if (env === 'staging') {
    const collected = collectSourceAddresses(sourceDocs);
    legalTextsAddressCount = collected.legalTextsAddressCount;
    for (const v of scanPlanForSourceAddresses(planText, collected.addresses, emailMap, { exemptLiterals })) {
      problems.push(`REFUSED: a source address (not mapped to itself) was found in the plan at ${v.table}(${v.column})`);
    }
  }

  return { legalTextsAddressCount, problems };
}
