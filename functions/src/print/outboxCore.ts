// P1-15 print-notify outbox — the PURE decision core (no Firebase imports, so
// rules-tests/print-outbox.test.cjs can require the compiled module directly).
//
// The durable-notification contract: a POD order gets exactly ONE outbox event,
// created the FIRST time it enters the paid lifecycle — regardless of which
// writer moved it there (Stripe webhook creating a 'confirmed' B2C order, a shop
// admin marking a B2B invoice 'paid', or any future path). Delivery/retry state
// then lives on the outbox doc, never in a fire-and-forget promise.

// Statuses whose ENTRY should notify the printer: the order is paid and awaits
// production. Mirrors setPrintJobStatus.ALLOWED_FROM['printed'] — the exact set
// a printer is allowed to start producing from.
const NOTIFY_STATUSES = new Set(['confirmed', 'processing', 'paid', 'partially_refunded']);

// The full post-payment lifecycle. A transition BETWEEN two of these is never a
// "first became production-ready" event (e.g. confirmed→processing,
// confirmed→printed, printed→shipped). Coming from OUTSIDE this set (creation,
// pending/invoiced B2B, cancelled being reinstated) is.
const PAID_LIFECYCLE = new Set([
  ...NOTIFY_STATUSES,
  'printed',
  'shipped',
  'delivered',
  'completed',
  'ready_for_pickup',
]);

export function isPaidLifecycleStatus(status: string | null | undefined): boolean {
  return !!status && PAID_LIFECYCLE.has(status);
}

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
export function shouldEnqueuePrintNotify(
  beforeStatus: string | null | undefined,
  afterStatus: string | null | undefined
): boolean {
  if (!afterStatus || !NOTIFY_STATUSES.has(afterStatus)) return false;
  if (beforeStatus == null) return true; // creation
  return !PAID_LIFECYCLE.has(beforeStatus);
}

/** Attempts after which a pending event is marked 'failed' (terminal, visible to ops). */
export const MAX_ATTEMPTS = 10;

// Grace before the sweep considers a freshly enqueued event overdue — the
// trigger's inline attempt normally resolves it well within this window, and
// the gap keeps trigger + sweep from double-sending the same event.
export const INITIAL_SWEEP_DELAY_MS = 5 * 60 * 1000;

// Longer than either outbox function's 120-second timeout. A crashed invocation
// becomes recoverable after this lease instead of leaving the event stuck.
export const DELIVERY_LEASE_MS = 5 * 60 * 1000;

const BASE_RETRY_MS = 10 * 60 * 1000; // one sweep cadence
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * Backoff for the NEXT attempt, given how many attempts have now been made
 * (1-based). 10m, 20m, 40m, … capped at 6h — MAX_ATTEMPTS spans ~27h, riding
 * out any realistic mail-provider outage without retrying forever.
 */
export function retryDelayMs(attemptsMade: number): number {
  const n = Math.max(1, Math.floor(attemptsMade));
  const exp = BASE_RETRY_MS * Math.pow(2, n - 1);
  return Math.min(MAX_RETRY_MS, exp);
}

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
export function isClaimablePrintNotification(input: ClaimablePrintNotification): boolean {
  if (input.status !== 'pending') return false;
  if ((Number(input.attempts) || 0) >= MAX_ATTEMPTS) return false;
  if (!input.ignoreSchedule && Number(input.nextAttemptAtMs || 0) > input.nowMs) return false;
  if (Number(input.leaseUntilMs || 0) > input.nowMs) return false;
  return true;
}
