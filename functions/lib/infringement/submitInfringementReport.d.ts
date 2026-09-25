/**
 * submitInfringementReport — public callable behind the storefront page
 * "Rapportera intrång" (/:shopId/rapportera-intrang, linked from every shop's
 * footer). A rights holder (or someone acting for one) reports a product that
 * infringes a trademark/copyright. Notice & takedown (SnapWear A10): the report
 * lands in the PLATFORM's queue (PlatformReports → Anmälningar), never the
 * shop's — the seller is the party being reported.
 *
 * Mirrors leads/submitLead.ts in shape: no auth, trim + length caps, hidden
 * `website` honeypot, durable per-IP rate limit, write the doc FIRST (a report
 * must never be lost), then a best-effort platform email.
 *
 * Privacy: the reporter's IP is used only as the rate-limit key (the shared
 * durable limiter, TTL-expired counters) and is NOT stored on the report.
 *
 * Firestore rules: `infringementReports` is platform-read-only and never
 * client-creatable — this Admin SDK write is the only way in.
 */
interface SubmitInfringementReportRequest {
    shopId?: string;
    productId?: string;
    productUrl?: string;
    reporterName?: string;
    reporterOrg?: string;
    reporterEmail?: string;
    rightType?: string;
    description?: string;
    attestation?: boolean;
    /** Honeypot — visually hidden in the form; any value = bot. */
    website?: string;
}
export declare const RIGHT_TYPES: readonly ["trademark", "copyright", "other"];
export declare const submitInfringementReport: import("firebase-functions/v2/https").CallableFunction<SubmitInfringementReportRequest, any, unknown>;
export {};
