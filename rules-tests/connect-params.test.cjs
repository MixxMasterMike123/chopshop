/**
 * Stripe Connect — money-path param unit tests (no Stripe, no network).
 *
 * Asserts the EXACT params the checkout + refund handlers send to Stripe, via
 * the pure builders the handlers actually call (functions/src/payment/
 * connectParams.ts → compiled lib). These are the bugs that would actually
 * hurt: a Connect shop missing transfer_data, a wrong application_fee, a legacy
 * shop accidentally getting Connect params, or a Connect refund missing the
 * transfer reversal (which would make the platform eat the refund).
 *
 * RUN: node rules-tests/connect-params.test.cjs
 */
const path = require('path');
const LIB = path.join(__dirname, '..', 'functions', 'lib', 'payment');
const { buildConnectChargeParams, buildRefundParams, summarizeConnectBalance, validateRefundRequest, refundStateAfter } = require(path.join(LIB, 'connectParams'));

let pass = 0, fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

console.log('\n=== Destination-charge params (createPaymentIntent path) ===');

// Connect-enabled shop → destination charge with the platform cut.
{
  const pay = { chargesEnabled: true, stripeAccountId: 'acct_X', commissionBps: 500 };
  const b = buildConnectChargeParams(pay, 12500, 500);
  ok(b.useConnect === true, 'Connect shop → useConnect true');
  ok(eq(b.params.transfer_data, { destination: 'acct_X' }), 'transfer_data.destination = acct_X');
  ok(b.params.application_fee_amount === 625, 'application_fee_amount = 625 öre (5% of 125.00 kr)');
  ok(b.meta.connectedAccountId === 'acct_X', 'metadata carries connectedAccountId');
  ok(b.meta.applicationFeeAmount === '625', 'metadata applicationFeeAmount = "625"');
  ok(b.meta.commissionBps === '500', 'metadata commissionBps = "500"');
  ok(!('on_behalf_of' in b.params), 'NO on_behalf_of (platform stays VAT merchant of record)');
}

// Per-shop commission overrides the platform default.
{
  const pay = { chargesEnabled: true, stripeAccountId: 'acct_Y', commissionBps: 1000 };
  const b = buildConnectChargeParams(pay, 10000, 500);
  ok(b.params.application_fee_amount === 1000, 'per-shop 10% overrides default 5% → 1000 öre');
}

// Shop with no per-shop rate → platform default applies.
{
  const pay = { chargesEnabled: true, stripeAccountId: 'acct_Z' };
  const b = buildConnectChargeParams(pay, 10000, 700);
  ok(b.params.application_fee_amount === 700, 'no per-shop bps → platform default 7% → 700 öre');
}

// NOT-onboarded shop (connectEnabled but chargesEnabled false) → LEGACY (empty).
{
  const pay = { connectEnabled: true, chargesEnabled: false, stripeAccountId: 'acct_PENDING' };
  const b = buildConnectChargeParams(pay, 12500, 500);
  ok(b.useConnect === false, 'onboarding-incomplete shop → useConnect false');
  ok(eq(b.params, {}), 'legacy: NO transfer_data / application_fee (params empty)');
  ok(eq(b.meta, {}), 'legacy: NO connect metadata');
}

// Shop with no payments map at all → LEGACY.
{
  const b = buildConnectChargeParams(undefined, 12500, 500);
  ok(b.useConnect === false && eq(b.params, {}), 'no payments map → legacy (byte-identical charge)');
}

// chargesEnabled true but no account id (shouldn't happen) → LEGACY, never a broken transfer.
{
  const b = buildConnectChargeParams({ chargesEnabled: true }, 10000, 500);
  ok(b.useConnect === false, 'chargesEnabled without stripeAccountId → legacy (no broken transfer)');
}

console.log('\n=== Refund params (connectRefund path) ===');

// Connect order → must reverse the transfer AND refund the application fee.
{
  const order = { payment: { paymentIntentId: 'pi_1' }, connect: { isDestinationCharge: true } };
  const p = buildRefundParams(order);
  ok(p.payment_intent === 'pi_1', 'refund targets the payment intent');
  ok(p.reverse_transfer === true, 'Connect refund: reverse_transfer = true (claw back from shop)');
  ok(p.refund_application_fee === true, 'Connect refund: refund_application_fee = true (return our fee)');
  ok(!('amount' in p), 'full refund: no amount');
}

// Connect partial refund → amount in öre + still reverses.
{
  const order = { payment: { paymentIntentId: 'pi_2' }, connect: { isDestinationCharge: true } };
  const p = buildRefundParams(order, 50); // 50.00 kr partial
  ok(p.amount === 5000, 'partial refund amount = 5000 öre (50.00 kr)');
  ok(p.reverse_transfer === true && p.refund_application_fee === true, 'partial Connect refund still reverses + refunds fee');
}

// LEGACY order (no connect) → plain refund, NO reversal params.
{
  const order = { payment: { paymentIntentId: 'pi_3' } };
  const p = buildRefundParams(order);
  ok(p.payment_intent === 'pi_3', 'legacy refund targets the payment intent');
  ok(!('reverse_transfer' in p), 'legacy refund: NO reverse_transfer');
  ok(!('refund_application_fee' in p), 'legacy refund: NO refund_application_fee');
}

console.log('\n=== Refund: platform-fee-on-refund config flag (Slice C / decision 2) ===');

// Default (flag omitted) = CURRENT behaviour: Connect refund returns the fee.
{
  const order = { payment: { paymentIntentId: 'pi_4' }, connect: { isDestinationCharge: true } };
  const p = buildRefundParams(order, undefined /* full */);
  ok(p.reverse_transfer === true, 'default: Connect refund still reverses the transfer');
  ok(p.refund_application_fee === true, 'default: refund_application_fee = true (unchanged behaviour)');
}

// Flag TRUE explicitly → fee returned (same as default).
{
  const order = { payment: { paymentIntentId: 'pi_5' }, connect: { isDestinationCharge: true } };
  const p = buildRefundParams(order, undefined, true);
  ok(p.refund_application_fee === true, 'flag true: platform fee returned to buyer');
}

// Flag FALSE → platform KEEPS the fee (non-refundable service fee) but STILL
// claws the principal back from the shop.
{
  const order = { payment: { paymentIntentId: 'pi_6' }, connect: { isDestinationCharge: true } };
  const p = buildRefundParams(order, undefined, false);
  ok(p.reverse_transfer === true, 'flag false: principal STILL clawed back from the shop (reverse_transfer)');
  ok(p.refund_application_fee === false, 'flag false: refund_application_fee = false (platform keeps its fee)');
}

// Flag never leaks onto a LEGACY refund regardless of value.
{
  const order = { payment: { paymentIntentId: 'pi_7' } };
  const pTrue = buildRefundParams(order, undefined, true);
  const pFalse = buildRefundParams(order, undefined, false);
  ok(!('refund_application_fee' in pTrue) && !('reverse_transfer' in pTrue), 'legacy + flag true → still plain refund');
  ok(!('refund_application_fee' in pFalse) && !('reverse_transfer' in pFalse), 'legacy + flag false → still plain refund');
}

// Partial refund + fee-retain → amount AND reverse but no fee return.
{
  const order = { payment: { paymentIntentId: 'pi_8' }, connect: { isDestinationCharge: true } };
  const p = buildRefundParams(order, 40, false);
  ok(p.amount === 4000, 'partial fee-retain: amount = 4000 öre');
  ok(p.reverse_transfer === true && p.refund_application_fee === false, 'partial fee-retain: reverses principal, keeps fee');
}

console.log('\n=== Connected-account balance summary (Slice B / payout risk) ===');

// Positive balance → not negative; sums the matching-currency entries.
{
  const balance = {
    available: [{ amount: 12500, currency: 'sek' }, { amount: 9999, currency: 'eur' }],
    pending: [{ amount: 3000, currency: 'sek' }],
  };
  const s = summarizeConnectBalance(balance, 'sek');
  ok(s.availableOre === 12500, 'available sums only the SEK entry (12500)');
  ok(s.pendingOre === 3000, 'pending sums the SEK entry (3000)');
  ok(s.negative === false, 'positive available → not negative');
  ok(s.currency === 'sek', 'currency echoed lowercase');
}

// Negative available → flagged negative (the payout-risk signal).
{
  const balance = { available: [{ amount: -4200, currency: 'sek' }], pending: [] };
  const s = summarizeConnectBalance(balance, 'SEK');
  ok(s.availableOre === -4200, 'negative available preserved');
  ok(s.negative === true, 'negative available → negative flag true');
}

// connect_reserved surfaces as reservedOre.
{
  const balance = { available: [{ amount: 0, currency: 'sek' }], pending: [], connect_reserved: [{ amount: 5000, currency: 'sek' }] };
  const s = summarizeConnectBalance(balance, 'sek');
  ok(s.reservedOre === 5000, 'connect_reserved summed into reservedOre');
}

// Missing/empty arrays → zeros, never throws.
{
  const s = summarizeConnectBalance({}, 'sek');
  ok(s.availableOre === 0 && s.pendingOre === 0 && s.reservedOre === 0 && s.negative === false, 'empty balance → all zero, not negative');
  const s2 = summarizeConnectBalance(null, 'sek');
  ok(s2.availableOre === 0 && s2.negative === false, 'null balance → safe zeros (no throw)');
}

// Multiple SEK entries (different source_types) all sum.
{
  const balance = { available: [{ amount: 1000, currency: 'sek' }, { amount: 500, currency: 'sek' }], pending: [] };
  const s = summarizeConnectBalance(balance, 'sek');
  ok(s.availableOre === 1500, 'multiple same-currency available entries sum (1500)');
}

console.log('\n=== Cumulative partial refunds (P1-08, 2026-08-15 audit) ===');

// validateRefundRequest — refunds may only cover what REMAINS.
{
  const v = validateRefundRequest(500, 0, 100);
  ok(v.ok === true && v.remainingSek === 500, 'first partial 100 of 500 → ok, remaining 500');
}
{
  const v = validateRefundRequest(500, 400, 100);
  ok(v.ok === true && v.remainingSek === 100, 'final partial exactly covers remainder → ok');
}
{
  const v = validateRefundRequest(500, 400, 200);
  ok(v.ok === false, 'partial LARGER than remainder (200 > 100 left) → rejected');
}
{
  const v = validateRefundRequest(500, 500, 100);
  ok(v.ok === false && v.remainingSek === 0, 'already fully refunded → any further refund rejected');
}
{
  const v = validateRefundRequest(500, 200, null);
  ok(v.ok === true && v.remainingSek === 300, 'absent amount after a partial → ok (refund the remainder)');
}
{
  const v = validateRefundRequest(500, 0, -5);
  ok(v.ok === false, 'negative amount → rejected');
  const v2 = validateRefundRequest(500, 0, NaN);
  ok(v2.ok === false, 'NaN amount → rejected');
}

// refundStateAfter — 'refunded' ONLY when the cumulative total covers the charge.
{
  const s = refundStateAfter(500, 0, 100);
  ok(s.status === 'partially_refunded' && s.isFull === false, 'partial 100/500 → partially_refunded (NOT refunded)');
  ok(s.refundedTotalSek === 100, 'cumulative total tracked (100)');
}
{
  const s = refundStateAfter(500, 400, 100);
  ok(s.status === 'refunded' && s.isFull === true, 'second refund completing the total → refunded');
  ok(s.refundedTotalSek === 500, 'cumulative total = 500');
}
{
  const s = refundStateAfter(500, 0, 500);
  ok(s.status === 'refunded', 'single full refund → refunded');
}
{
  const s = refundStateAfter(500, 0, 499.999);
  ok(s.status === 'refunded', 'öre-rounding tolerance: 499.999 of 500 counts as full');
}
{
  const s = refundStateAfter(0, 0, 100);
  ok(s.status === 'refunded', 'unknown/zero charged amount + successful refund → full (never stranded partial)');
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
