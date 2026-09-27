/**
 * scripts/cf-port/migrate/lib/scan-source-addresses.mjs — review round 1,
 * fix 5: a whole-plan check for source addresses, independent of the
 * field-level scrub (which cannot see an address embedded inside a longer
 * text — a description, a note, a legal snapshot).
 *
 * Staging, before the plan is accepted: collect every email-shaped string
 * found ANYWHERE in the documents the importer read (users, Auth users,
 * shops, legal acceptances, audit logs), and refuse if any of them occurs
 * anywhere in plan.sql, compared case-insensitively.
 *
 * TWO EXCEPTIONS, both explicit:
 *   1. an address the email map maps to ITSELF (an operator's deliberate
 *      choice — e.g. a shared support inbox already safe to keep);
 *   2. the `texts_json` snapshot of a legal acceptance, which is IMMUTABLE
 *      EVIDENCE (0037: append-only, facts never rewritten) and must not be
 *      altered — the count of addresses found there is reported instead,
 *      without printing them.
 *
 * The refusal names the TARGET table and column the match was found in
 * (from plan.sql's own structure — the nearest preceding `INSERT ... INTO
 * <table> (...)` on the same or an earlier line), never the address itself.
 */

import { looksLikeEmail } from './scrub.mjs';

const EMAIL_LOOSE_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Recursively finds every email-shaped string anywhere in a JSON-like value. */
function findEmailsDeep(value, out) {
  if (typeof value === 'string') {
    const matches = value.match(EMAIL_LOOSE_PATTERN);
    if (matches) {
      for (const m of matches) out.push(m);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) findEmailsDeep(entry, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) findEmailsDeep(v, out);
  }
}

/**
 * Collects every distinct email-shaped string across the given documents.
 * `docs` is `{ users, authUsers, shops, legalAcceptances, auditLogs }` where
 * each is the array of decoded bundle documents (or, for authUsers, the
 * plain Auth records) this importer actually read. `legalAcceptances`'
 * `texts_json`-equivalent field (the source `texts` object) is EXCLUDED from
 * the scan set here — its own count is reported separately by the caller —
 * per exception 2.
 *
 * Returns { addresses: Set<lowercased address>, legalTextsAddressCount }.
 */
export function collectSourceAddresses({ auditLogs = [], authUsers = [], legalAcceptances = [], shops = [], users = [] }) {
  const found = [];
  for (const doc of shops) findEmailsDeep(doc.data ?? doc, found);
  for (const doc of users) findEmailsDeep(doc.data ?? doc, found);
  for (const user of authUsers) findEmailsDeep(user, found);
  for (const doc of auditLogs) findEmailsDeep(doc.data ?? doc, found);

  let legalTextsAddressCount = 0;
  for (const doc of legalAcceptances) {
    const data = doc.data ?? doc;
    const { texts, ...rest } = data;
    findEmailsDeep(rest, found);
    if (texts !== undefined) {
      const textsFound = [];
      findEmailsDeep(texts, textsFound);
      legalTextsAddressCount += textsFound.length;
    }
  }

  const addresses = new Set(found.filter((a) => looksLikeEmail(a)).map((a) => a.toLowerCase()));
  return { addresses, legalTextsAddressCount };
}

/**
 * Checks `planText` for any occurrence (case-insensitive) of a collected
 * source address, EXCEPT an address the email map maps to itself (exception
 * 1) and EXCEPT inside `exemptLiterals` (exception 2: the exact SQL literals
 * of the legal texts snapshots, as the transform wrote them).
 * Returns an array of violation descriptions (empty = clean); each
 * violation names the nearest preceding `INSERT ... INTO <table> (<cols>)`
 * before the match (target table + column list), never the address.
 */
export function scanPlanForSourceAddresses(planText, addresses, emailMap, { exemptLiterals = [] } = {}) {
  const violations = [];
  // Exception 2 on the PLAN side: the texts_json literal of a legal
  // acceptance is taken out before the search. Without this, a shop whose
  // legal text names its own support address would refuse every plan, since
  // that address is also a field of the shop.
  let scanned = planText;
  for (const literal of exemptLiterals) {
    if (typeof literal === 'string' && literal.length > 0) scanned = scanned.split(literal).join("''");
  }
  planText = scanned;
  const lowerPlan = planText.toLowerCase();
  const insertHeaderPattern = /INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+(\S+)\s*\(([^)]*)\)/gi;
  const headers = [];
  let headerMatch;
  while ((headerMatch = insertHeaderPattern.exec(planText)) !== null) {
    headers.push({ columns: headerMatch[2], index: headerMatch.index, table: headerMatch[1] });
  }

  function nearestHeaderBefore(index) {
    let best = null;
    for (const h of headers) {
      if (h.index <= index && (best === null || h.index > best.index)) best = h;
    }
    return best;
  }

  for (const address of addresses) {
    const lower = address.toLowerCase();
    const mapped = emailMap?.[lower];
    if (typeof mapped === 'string' && mapped.toLowerCase() === lower) {
      continue; // exception 1: mapped to itself, a deliberate operator choice
    }
    // Inside a SQL literal an apostrophe is written twice, so an address that
    // holds one is searched for in both spellings. One record per address is
    // enough to refuse.
    const spellings = lower.includes("'") ? [lower, lower.replaceAll("'", "''")] : [lower];
    const idx = spellings.map((s) => lowerPlan.indexOf(s)).find((i) => i !== -1);
    if (idx === undefined) continue;
    const header = nearestHeaderBefore(idx);
    violations.push({
      column: header ? header.columns.trim() : '(unknown)',
      table: header ? header.table : '(unknown)',
    });
  }
  return violations;
}
