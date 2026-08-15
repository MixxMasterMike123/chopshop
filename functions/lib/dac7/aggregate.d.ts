/**
 * DAC7 per-seller per-calendar-year aggregation (pure, unit-tested).
 *
 * DAC7 (EU Council Directive 2021/514) requires a platform to report, per
 * reportable seller per calendar year: the GROSS consideration and the NUMBER
 * of relevant transactions (activities). A seller is EXCLUDED from reporting
 * under the de-minimis test when they had FEWER THAN 30 sales AND received
 * ≤ EUR 2,000 in the year — but the figures are still computed (the platform
 * must apply the test, not assume exclusion).
 *
 * This module is the pure decision logic: given a seller's orders for a year,
 * it returns the gross + count + the de-minimis verdict. No I/O — the caller
 * loads orders (Admin SDK) and supplies a SEK→EUR rate (documented source;
 * orders are priced in SEK, the threshold is in EUR).
 */
export declare const DAC7_MIN_TRANSACTIONS = 30;
export declare const DAC7_MAX_CONSIDERATION_EUR = 2000;
export interface Dac7Order {
    total?: number;
    status?: string;
    createdAt?: any;
    source?: string;
    refundedTotalSek?: number;
}
export interface Dac7YearAggregate {
    year: number;
    transactionCount: number;
    grossConsiderationSek: number;
    grossConsiderationEur: number;
    sekToEurRate: number;
    belowDeMinimis: boolean;
    reportable: boolean;
}
/** Normalise a variety of timestamp shapes to a JS Date (or null). */
export declare function toDate(ts: any): Date | null;
/**
 * Aggregate a seller's orders for one calendar year.
 *
 * @param orders      the seller's orders (any year; filtered here by createdAt)
 * @param year        the calendar year (e.g. 2026)
 * @param sekToEurRate  SEK→EUR conversion (e.g. 0.087). Documented rate source;
 *                    used only to apply the EUR de-minimis threshold.
 */
export declare function aggregateSellerYear(orders: Dac7Order[], year: number, sekToEurRate: number): Dac7YearAggregate;
/**
 * Merge a per-year "reported" transparency entry into a seller's existing list:
 * replace any entry for the same year (re-filing) and keep it sorted by year —
 * so re-running the finalise never duplicates a year. Pure (no I/O).
 *
 * @param existing  the seller's current reported[] (may be undefined)
 * @param entry     the new entry (must carry a numeric `year`)
 */
export declare function mergeReportedRecord(existing: any[] | undefined, entry: any): any[];
