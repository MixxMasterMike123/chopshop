/**
 * DAC7 per-seller per-year aggregation — pure unit tests (Slice E).
 *
 * Pins the reporting math: which orders count, the gross/count, the SEK→EUR
 * threshold, and the de-minimis boundary (< 30 sales AND ≤ EUR 2,000 → excluded
 * but still computed). These are the figures the platform files, so the
 * boundaries (exactly 30, exactly EUR 2,000) must be exact.
 *
 * RUN: node rules-tests/dac7-aggregation.test.cjs
 */
const path = require('path');
const LIB = path.join(__dirname, '..', 'functions', 'lib', 'dac7');
const { aggregateSellerYear, toDate, mergeReportedRecord, DAC7_MIN_TRANSACTIONS, DAC7_MAX_CONSIDERATION_EUR } = require(path.join(LIB, 'aggregate'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

const order = (total, year, status = 'confirmed') => ({ total, status, createdAt: new Date(Date.UTC(year, 5, 15)) });

console.log('\n=== Gross + count, year filtering ===');
{
  const orders = [order(100, 2026), order(200, 2026), order(999, 2025) /* other year */];
  const a = aggregateSellerYear(orders, 2026, 0.1);
  ok(a.transactionCount === 2, 'counts only this-year orders (2)');
  ok(a.grossConsiderationSek === 300, 'gross SEK = 300 (excludes the 2025 order)');
  ok(a.grossConsiderationEur === 30, 'gross EUR = 30 (300 * 0.1)');
}

console.log('\n=== Refunded / cancelled / garbage excluded ===');
{
  const orders = [order(100, 2026), order(100, 2026, 'refunded'), order(100, 2026, 'cancelled'), { total: -50, status: 'confirmed', createdAt: new Date(Date.UTC(2026, 1, 1)) }, { total: 'x', status: 'confirmed', createdAt: new Date(Date.UTC(2026, 1, 1)) }];
  const a = aggregateSellerYear(orders, 2026, 0.1);
  ok(a.transactionCount === 1, 'refunded/cancelled/negative/garbage all excluded → count 1');
  ok(a.grossConsiderationSek === 100, 'gross only the one valid sale (100)');
}

console.log('\n=== De-minimis boundary: transaction count (< 30) ===');
{
  // 29 small sales, well under EUR 2000 → BELOW de-minimis (excluded).
  const small = Array.from({ length: 29 }, () => order(10, 2026));
  const a = aggregateSellerYear(small, 2026, 0.1); // 290 SEK → 29 EUR
  ok(a.transactionCount === 29, '29 sales');
  ok(a.belowDeMinimis === true, '29 sales (<30) AND ≤EUR2000 → below de-minimis (excluded)');
  ok(a.reportable === false, 'not reportable');
}
{
  // Exactly 30 sales → NOT fewer than 30 → REPORTABLE regardless of amount.
  const thirty = Array.from({ length: 30 }, () => order(10, 2026));
  const a = aggregateSellerYear(thirty, 2026, 0.1); // 300 SEK → 30 EUR
  ok(a.transactionCount === 30, '30 sales');
  ok(a.belowDeMinimis === false, 'exactly 30 sales → NOT below de-minimis (30 is not <30)');
  ok(a.reportable === true, 'reportable');
}

console.log('\n=== De-minimis boundary: consideration (≤ EUR 2000) ===');
{
  // 5 sales but EUR 2000.01 → ABOVE the EUR threshold → REPORTABLE.
  // 20000.10 SEK * 0.1 = 2000.01 EUR
  const a = aggregateSellerYear([order(20000.10, 2026)], 2026, 0.1);
  ok(a.grossConsiderationEur === 2000.01, 'gross EUR = 2000.01');
  ok(a.belowDeMinimis === false, '> EUR 2000 → NOT below de-minimis even with 1 sale');
  ok(a.reportable === true, 'reportable (over the EUR threshold)');
}
{
  // Exactly EUR 2000 with few sales → ≤ threshold AND <30 → BELOW (excluded).
  const a = aggregateSellerYear([order(20000, 2026)], 2026, 0.1); // 2000 EUR
  ok(a.grossConsiderationEur === 2000, 'gross EUR = 2000 exactly');
  ok(a.belowDeMinimis === true, 'exactly EUR 2000 (≤) AND <30 sales → below de-minimis');
}

console.log('\n=== Constants + edge inputs ===');
{
  ok(DAC7_MIN_TRANSACTIONS === 30, 'min transactions constant = 30');
  ok(DAC7_MAX_CONSIDERATION_EUR === 2000, 'max consideration constant = EUR 2000');
  const a = aggregateSellerYear([], 2026, 0.1);
  ok(a.transactionCount === 0 && a.grossConsiderationSek === 0 && a.belowDeMinimis === true, 'no orders → zeros, below de-minimis');
  const a2 = aggregateSellerYear(null, 2026, 0.1);
  ok(a2.transactionCount === 0, 'null orders → zeros (no throw)');
  const a3 = aggregateSellerYear([order(100, 2026)], 2026, NaN);
  ok(a3.grossConsiderationEur === 0 && a3.sekToEurRate === 0, 'invalid rate → EUR 0, rate clamped to 0 (no NaN)');
}

console.log('\n=== toDate normalisation ===');
{
  ok(toDate(new Date(Date.UTC(2026, 0, 1)))?.getUTCFullYear() === 2026, 'Date passthrough');
  ok(toDate({ toDate: () => new Date(Date.UTC(2026, 0, 1)) })?.getUTCFullYear() === 2026, 'Firestore Timestamp.toDate()');
  ok(toDate({ seconds: Math.floor(Date.UTC(2026, 0, 1) / 1000) })?.getUTCFullYear() === 2026, '{seconds} shape');
  ok(toDate('2026-03-15')?.getUTCFullYear() === 2026, 'ISO string');
  ok(toDate(null) === null && toDate(undefined) === null && toDate('garbage') === null, 'null/undefined/garbage → null');
}

console.log('\n=== mergeReportedRecord (transparency, replace-by-year, no dupes) ===');
{
  const a = mergeReportedRecord(undefined, { year: 2025, txCountReported: 5 });
  ok(a.length === 1 && a[0].year === 2025, 'undefined existing → single entry');
}
{
  const a = mergeReportedRecord([{ year: 2024, txCountReported: 1 }], { year: 2025, txCountReported: 5 });
  ok(a.length === 2 && a[0].year === 2024 && a[1].year === 2025, 'different year → appended + sorted');
}
{
  // Re-filing the SAME year replaces, never duplicates.
  const a = mergeReportedRecord([{ year: 2025, txCountReported: 5 }], { year: 2025, txCountReported: 9 });
  ok(a.length === 1 && a[0].txCountReported === 9, 're-file same year → replaced (no duplicate)');
}
{
  const a = mergeReportedRecord([{ year: 2026 }, { year: 2024 }], { year: 2025 });
  ok(a.map((e) => e.year).join(',') === '2024,2025,2026', 'always sorted ascending by year');
}

console.log('\n=== Partial refunds — consideration RETAINED (P1-08, 2026-08-15) ===');
{
  const partial = { ...order(500, 2026, 'partially_refunded'), refundedTotalSek: 490 };
  const a = aggregateSellerYear([partial], 2026, 0.1);
  ok(a.grossConsiderationSek === 10, 'partially refunded order counts only the RETAINED amount (500-490=10)');
  ok(a.transactionCount === 1, 'partially refunded order still counts as a transaction');
}
{
  const fullViaPartialField = { ...order(500, 2026, 'confirmed'), refundedTotalSek: 500 };
  const a = aggregateSellerYear([fullViaPartialField], 2026, 0.1);
  ok(a.transactionCount === 0 && a.grossConsiderationSek === 0, 'fully-refunded-by-amount order (retained 0) is excluded entirely');
}
{
  const a = aggregateSellerYear([{ ...order(500, 2026), refundedTotalSek: undefined }], 2026, 0.1);
  ok(a.grossConsiderationSek === 500, 'absent refundedTotalSek → full total counts (legacy orders unchanged)');
}
{
  const a = aggregateSellerYear([order(500, 2026, 'refunded')], 2026, 0.1);
  ok(a.transactionCount === 0, 'status refunded still excluded by status (unchanged)');
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
