/**
 * Print-notify outbox (P1-15, 2026-08-15 audit) — pure unit tests.
 *
 * Runs the exported decision core from the COMPILED functions bundle
 * (functions/lib/print/outboxCore.js):
 *
 *   • shouldEnqueuePrintNotify(beforeStatus, afterStatus)
 *       — the "first became production-ready" predicate driving the
 *         orders/{id} trigger: B2C creation at 'confirmed' fires, B2B
 *         pending/invoiced → 'paid' fires, transitions WITHIN the paid
 *         lifecycle (confirmed→processing, confirmed→printed, printed→shipped)
 *         never re-fire, and an order first appearing already-fulfilled
 *         (shipped/delivered) never notifies the printer at all.
 *   • retryDelayMs(attemptsMade) — capped exponential backoff.
 *
 * RUN: node rules-tests/print-outbox.test.cjs   (needs functions/lib built)
 */

const {
  shouldEnqueuePrintNotify,
  isPaidLifecycleStatus,
  isClaimablePrintNotification,
  retryDelayMs,
  MAX_ATTEMPTS,
  INITIAL_SWEEP_DELAY_MS,
  DELIVERY_LEASE_MS,
} =
  require('../functions/lib/print/outboxCore.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

console.log('\n— shouldEnqueuePrintNotify: MUST fire (first entry into production-ready) —');
ok(shouldEnqueuePrintNotify(null, 'confirmed') === true, 'B2C webhook CREATE at confirmed fires');
ok(shouldEnqueuePrintNotify(null, 'paid') === true, 'create directly at paid fires');
ok(shouldEnqueuePrintNotify('pending', 'paid') === true, 'B2B invoice pending → paid fires');
ok(shouldEnqueuePrintNotify('invoiced', 'paid') === true, 'B2B invoiced → paid fires');
ok(shouldEnqueuePrintNotify('pending', 'confirmed') === true, 'pending → confirmed fires');
ok(shouldEnqueuePrintNotify('pending', 'processing') === true, 'pending → processing fires');
ok(shouldEnqueuePrintNotify('cancelled', 'confirmed') === true,
  'cancelled reinstated → confirmed fires (outbox doc-id dedupe absorbs the duplicate)');

console.log('\n— isPaidLifecycleStatus: snapshot lifetime is broader than notification —');
ok(isPaidLifecycleStatus('paid') === true, 'paid order still needs an immutable production snapshot');
ok(isPaidLifecycleStatus('printed') === true, 'already-printed order still freezes history without notifying');
ok(isPaidLifecycleStatus('shipped') === true, 'already-shipped order still freezes history without notifying');
ok(isPaidLifecycleStatus('pending') === false, 'unpaid pending order does not freeze yet');
ok(isPaidLifecycleStatus('cancelled') === false, 'cancelled order does not freeze');

console.log('\n— shouldEnqueuePrintNotify: must NOT fire —');
ok(shouldEnqueuePrintNotify(null, 'pending') === false, 'B2B CREATE at pending (unpaid) silent');
ok(shouldEnqueuePrintNotify(null, 'invoiced') === false, 'create at invoiced (unpaid) silent');
ok(shouldEnqueuePrintNotify('pending', 'invoiced') === false, 'pending → invoiced (still unpaid) silent');
ok(shouldEnqueuePrintNotify('confirmed', 'processing') === false, 'confirmed → processing (within lifecycle) silent');
ok(shouldEnqueuePrintNotify('confirmed', 'partially_refunded') === false, 'confirmed → partially_refunded silent');
ok(shouldEnqueuePrintNotify('paid', 'confirmed') === false, 'paid → confirmed (within lifecycle) silent');
ok(shouldEnqueuePrintNotify('printed', 'paid') === false, 'printed → paid-ish regression silent');
ok(shouldEnqueuePrintNotify('confirmed', 'printed') === false, 'confirmed → printed (production milestone) silent');
ok(shouldEnqueuePrintNotify('printed', 'shipped') === false, 'printed → shipped silent');
ok(shouldEnqueuePrintNotify('confirmed', 'cancelled') === false, 'cancellation silent');
ok(shouldEnqueuePrintNotify('confirmed', 'refunded') === false, 'full refund silent');
ok(shouldEnqueuePrintNotify(null, 'shipped') === false, 'order first appearing SHIPPED never notifies printer');
ok(shouldEnqueuePrintNotify(null, 'delivered') === false, 'order first appearing DELIVERED never notifies');
ok(shouldEnqueuePrintNotify('pending', 'shipped') === false, 'pending → shipped (produced elsewhere) never notifies');
ok(shouldEnqueuePrintNotify(null, '') === false, 'empty after-status silent');
ok(shouldEnqueuePrintNotify(null, null) === false, 'missing after-status silent');
ok(shouldEnqueuePrintNotify('weird_unknown', 'confirmed') === true,
  'unknown before-status treated as outside lifecycle (fires; dedupe protects)');
ok(shouldEnqueuePrintNotify(null, 'weird_unknown') === false, 'unknown after-status silent');

console.log('\n— retryDelayMs: capped exponential backoff —');
ok(retryDelayMs(1) === 10 * 60 * 1000, 'attempt 1 → 10 min');
ok(retryDelayMs(2) === 20 * 60 * 1000, 'attempt 2 → 20 min');
ok(retryDelayMs(3) === 40 * 60 * 1000, 'attempt 3 → 40 min');
ok(retryDelayMs(6) === 320 * 60 * 1000, 'attempt 6 → 320 min (under cap)');
ok(retryDelayMs(7) === 6 * 60 * 60 * 1000, 'attempt 7 → capped at 6 h');
ok(retryDelayMs(100) === 6 * 60 * 60 * 1000, 'attempt 100 → still capped at 6 h');
ok(retryDelayMs(0) === 10 * 60 * 1000, 'attempt 0 clamps to base delay (defensive)');
ok(retryDelayMs(-5) === 10 * 60 * 1000, 'negative clamps to base delay (defensive)');

console.log('\n— policy constants sane —');
ok(Number.isInteger(MAX_ATTEMPTS) && MAX_ATTEMPTS >= 5 && MAX_ATTEMPTS <= 20,
  `MAX_ATTEMPTS bounded (${MAX_ATTEMPTS})`);
ok(INITIAL_SWEEP_DELAY_MS >= 60 * 1000 && INITIAL_SWEEP_DELAY_MS <= 30 * 60 * 1000,
  'initial sweep grace between 1 and 30 min (blocks trigger/sweep double-send)');
// Total retry horizon must ride out a serious provider outage (> 12 h).
let horizon = 0;
for (let a = 1; a < MAX_ATTEMPTS; a++) horizon += retryDelayMs(a);
ok(horizon > 12 * 60 * 60 * 1000, `retry horizon > 12 h (${Math.round(horizon / 3600000)} h)`);

console.log('\n— isClaimablePrintNotification: one active delivery lease —');
const now = 1_000_000;
ok(isClaimablePrintNotification({
  status: 'pending', attempts: 0, nextAttemptAtMs: now, leaseUntilMs: null, nowMs: now,
}) === true, 'due pending event with no lease is claimable');
ok(isClaimablePrintNotification({
  status: 'pending', attempts: 0, nextAttemptAtMs: now + 1, leaseUntilMs: null, nowMs: now,
}) === false, 'future event is not claimable by the sweep');
ok(isClaimablePrintNotification({
  status: 'pending', attempts: 0, nextAttemptAtMs: now + INITIAL_SWEEP_DELAY_MS,
  leaseUntilMs: null, nowMs: now, ignoreSchedule: true,
}) === true, 'inline first attempt may ignore the initial sweep grace');
ok(isClaimablePrintNotification({
  status: 'pending', attempts: 0, nextAttemptAtMs: now, leaseUntilMs: now + DELIVERY_LEASE_MS, nowMs: now,
}) === false, 'active lease blocks a concurrent delivery');
ok(isClaimablePrintNotification({
  status: 'pending', attempts: 1, nextAttemptAtMs: now, leaseUntilMs: now, nowMs: now,
}) === true, 'expired lease is recoverable');
ok(isClaimablePrintNotification({
  status: 'sent', attempts: 1, nextAttemptAtMs: now, leaseUntilMs: null, nowMs: now,
}) === false, 'terminal sent event is never claimable');
ok(isClaimablePrintNotification({
  status: 'pending', attempts: MAX_ATTEMPTS, nextAttemptAtMs: now, leaseUntilMs: null, nowMs: now,
}) === false, 'attempt-exhausted event is never claimed again');
ok(DELIVERY_LEASE_MS > 2 * 60 * 1000 && DELIVERY_LEASE_MS <= 15 * 60 * 1000,
  'delivery lease outlives function timeout without stalling retries too long');

console.log(`\n=== print-outbox: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
