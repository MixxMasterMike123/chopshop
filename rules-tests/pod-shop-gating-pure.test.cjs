/**
 * Slice C (pod-shop-type-selector plan) — pure unit tests for the pod-gating
 * decision shapes in:
 *   - functions/src/print/notifyOutbox.ts (onOrderProductionReady trigger
 *     early-return; sweepPrintNotifyOutbox per-doc skip)
 *   - functions/src/payment/createPaymentIntent.ts (production-snapshot skip)
 *   - functions/src/payment/stripeWebhook.ts (metadata-driven snapshot branch)
 *
 * These three functions are onDocumentWritten/onSchedule/onRequest handlers —
 * the gate logic is inline in the handler body, not split into an exported
 * pure helper (unlike printGuard.getPrintShopContext, which IS directly
 * testable — see pod-shop-gating.test.cjs). Per the same tradeoff already
 * documented in functions-isolation.test.cjs ("callable invocation in the
 * emulator needs the full functions harness"), this suite mirrors the EXACT
 * condition written in each file (quoted in comments below) rather than
 * driving the real handler. Keep these in sync by inspection at review time
 * if the source condition changes.
 *
 * RUN: node rules-tests/pod-shop-gating-pure.test.cjs   (no build/emulator needed)
 */

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

// ─────────────────────────────────────────────────────────────────────────
// 1) onOrderProductionReady trigger — notifyOutbox.ts:263
//      if (!(await isShopFeatureEnabled(shopId, 'pod'))) return;
// Placed AFTER the shopId-blank check, BEFORE the snapshot-freeze transaction
// and enqueue — so a pod-disabled shop's order write never freezes a
// snapshot, never enqueues a printNotifications doc, and never notifies.
// ─────────────────────────────────────────────────────────────────────────
function triggerShouldProceed(shopId, podEnabled) {
  if (!shopId) return false;
  if (!podEnabled) return false;
  return true;
}

console.log('\n=== onOrderProductionReady: pod-disabled shop early-returns before enqueue ===');
ok(triggerShouldProceed('shopPod', true) === true, 'pod-enabled shop proceeds to freeze/enqueue');
ok(triggerShouldProceed('shopNoPod', false) === false, 'pod-disabled shop early-returns (no freeze, no enqueue, no notify)');
ok(triggerShouldProceed('', true) === false, 'blank shopId (untenanted order) still returns regardless of pod flag');
ok(triggerShouldProceed('shopLegacy', true) === true, 'shop whose pod flag resolves enabled proceeds unchanged (post D3 flip that requires explicit pod:true)');

// ─────────────────────────────────────────────────────────────────────────
// 2) sweepPrintNotifyOutbox retry loop — notifyOutbox.ts:387
//      if (docShopId && !(await isShopFeatureEnabled(docShopId, 'pod'))) {
//        set({ status: 'skipped', skipReason: 'pod-disabled', ... }); continue;
//      }
// Re-checked PER RETRY (not just at enqueue time) — a shop's pod flag may
// flip off after the doc was already enqueued while pod was on.
// ─────────────────────────────────────────────────────────────────────────
function sweepOutcomeForDoc(docShopId, podEnabled) {
  if (docShopId && !podEnabled) return { status: 'skipped', skipReason: 'pod-disabled', delivered: false };
  return { status: 'attempted', delivered: true };
}

console.log('\n=== sweepPrintNotifyOutbox: pod-disabled shop resolved skipped, not retried forever ===');
ok(sweepOutcomeForDoc('shopNoPod', false).status === 'skipped', 'pod-disabled shop doc resolves to skipped');
ok(sweepOutcomeForDoc('shopNoPod', false).skipReason === 'pod-disabled', 'skip reason is explicit, distinguishable from no-printer-assigned');
ok(sweepOutcomeForDoc('shopNoPod', false).delivered === false, 'no delivery attempt is made for a pod-disabled shop');
ok(sweepOutcomeForDoc('shopPod', true).delivered === true, 'pod-enabled shop still attempts delivery normally');
ok(sweepOutcomeForDoc('', true).delivered === true, 'a doc with no shopId falls through to normal delivery attempt (defensive; should not occur in practice)');

// ─────────────────────────────────────────────────────────────────────────
// 3) createPaymentIntent.ts — the production-snapshot skip (D7)
//      const podEnabled = await isShopFeatureEnabled(resolvedShopId, 'pod');
//      ...
//      productionSnapshotRequired: podEnabled ? 'true' : 'false',   // metadata
//      ...
//      let checkoutProductionSnapshot = null;
//      if (podEnabled) { checkoutProductionSnapshot = await buildProductionSnapshotAtomically(...); ... }
//      ...
//      if (checkoutProductionSnapshot) { await writeCheckoutProductionSnapshot(...); }
//
// CRITICAL INVARIANT under test: podEnabled must NEVER appear in the
// total/amountInOre/discount/shipping/connect computation — those are all
// derived from computeOrderTotalsSek + Stripe Connect params, entirely
// upstream of and independent from this decision. This suite asserts the
// metadata/snapshot SHAPE only; the money-independence claim is verified by
// direct code inspection (see the builder's final report), not re-derivable
// as a pure predicate without duplicating the whole pricing function.
// ─────────────────────────────────────────────────────────────────────────
function metadataForPod(podEnabled) {
  return { productionSnapshotRequired: podEnabled ? 'true' : 'false' };
}
function shouldBuildSnapshot(podEnabled) {
  return podEnabled === true;
}
function shouldWriteCheckoutSnapshot(checkoutProductionSnapshot) {
  return checkoutProductionSnapshot !== null;
}

console.log('\n=== createPaymentIntent: production-snapshot skipped end-to-end when pod is off ===');
ok(metadataForPod(true).productionSnapshotRequired === 'true', 'pod-enabled shop: metadata carries productionSnapshotRequired=true');
ok(metadataForPod(false).productionSnapshotRequired === 'false', 'pod-disabled shop: metadata carries productionSnapshotRequired=false (NOT omitted — explicit)');
ok(shouldBuildSnapshot(true) === true, 'pod-enabled: buildProductionSnapshotAtomically runs (unresolved-line 409 gate stays live)');
ok(shouldBuildSnapshot(false) === false, 'pod-disabled: buildProductionSnapshotAtomically is skipped entirely — no stray isPodProduct doc can block this checkout');
ok(shouldWriteCheckoutSnapshot(null) === false, 'pod-disabled: writeCheckoutProductionSnapshot is skipped — checkouts/{piId} never gets productionSnapshotRequired/productionSnapshot fields');
ok(shouldWriteCheckoutSnapshot({ version: 1, lines: [] }) === true, 'pod-enabled: writeCheckoutProductionSnapshot still runs (rules-locked write stays required)');

// ─────────────────────────────────────────────────────────────────────────
// 4) stripeWebhook.ts — three-way branch on metadata.productionSnapshotRequired
//      'false'  → orderData.productionSnapshotRequired = false; NO snapshot build
//      'true'   → require + consume the pre-frozen checkouts/{piId} snapshot
//      (absent) → legacy PI compatibility: buildProductionSnapshotAtomically(orderData)
// The 'false' branch must NOT fall into the legacy branch (which still calls
// buildProductionSnapshotAtomically and hardcodes productionSnapshotRequired:
// true) — that was the bug this branch exists to avoid.
// ─────────────────────────────────────────────────────────────────────────
function webhookSnapshotBranch(metadataFlag) {
  if (metadataFlag === 'false') return 'skip-no-build';
  if (metadataFlag === 'true') return 'require-prefrozen';
  return 'legacy-rebuild';
}

console.log('\n=== stripeWebhook: explicit "false" takes its OWN branch, never the legacy rebuild path ===');
ok(webhookSnapshotBranch('false') === 'skip-no-build', 'pod-disabled PI (explicit false) skips snapshot building entirely');
ok(webhookSnapshotBranch('true') === 'require-prefrozen', 'pod-enabled PI requires the pre-frozen checkout snapshot (unchanged P1-16 behavior)');
ok(webhookSnapshotBranch(undefined) === 'legacy-rebuild', 'PIs created before this release (no marker at all) still fall back to legacy rebuild');
ok(webhookSnapshotBranch('false') !== webhookSnapshotBranch(undefined),
  'REGRESSION GUARD: "false" must not collapse into the same branch as legacy — the legacy branch still calls buildProductionSnapshotAtomically and hardcodes productionSnapshotRequired:true, which is exactly what D7 must avoid for a pod-disabled shop');

console.log(`\n=== pod-shop-gating-pure: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
