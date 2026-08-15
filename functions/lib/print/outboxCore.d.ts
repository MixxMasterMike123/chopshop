export declare function isPaidLifecycleStatus(status: string | null | undefined): boolean;
/**
 * Should this orders/{id} write enqueue a print notification?
 * beforeStatus === null means the document was just created.
 *
 * Deliberately requires the AFTER status to be a production-ready status (not
 * merely inside the paid lifecycle): an order that first appears already
 * 'shipped'/'delivered' was produced elsewhere — notifying the printer then
 * would be wrong. Re-entry (cancelled→confirmed) passes here and is absorbed
 * by the doc-id dedupe on the outbox create.
 */
export declare function shouldEnqueuePrintNotify(beforeStatus: string | null | undefined, afterStatus: string | null | undefined): boolean;
/** Attempts after which a pending event is marked 'failed' (terminal, visible to ops). */
export declare const MAX_ATTEMPTS = 10;
export declare const INITIAL_SWEEP_DELAY_MS: number;
export declare const DELIVERY_LEASE_MS: number;
/**
 * Backoff for the NEXT attempt, given how many attempts have now been made
 * (1-based). 10m, 20m, 40m, … capped at 6h — MAX_ATTEMPTS spans ~27h, riding
 * out any realistic mail-provider outage without retrying forever.
 */
export declare function retryDelayMs(attemptsMade: number): number;
type ClaimablePrintNotification = {
    status: string | null | undefined;
    attempts: number | null | undefined;
    nextAttemptAtMs: number | null | undefined;
    leaseUntilMs: number | null | undefined;
    nowMs: number;
    ignoreSchedule?: boolean;
};
/**
 * Pure claim predicate shared by the transaction and its unit tests. Delivery
 * is allowed only for a due pending event whose previous lease has expired.
 * The trigger's inline first attempt may ignore the initial sweep grace, but it
 * must still respect an active lease.
 */
export declare function isClaimablePrintNotification(input: ClaimablePrintNotification): boolean;
export {};
