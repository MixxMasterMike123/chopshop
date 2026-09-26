/**
 * CODEX audit 2026-09-26 (docs/audits/2026-09-26-last-24-hours.md) — the two
 * pure client-side fixes, pinned:
 *
 *   F3  PrinterRow's form → printAreasMm serialization keeps an EXPLICIT {}
 *       for an offered garment whose every frame was cleared. Dropping the key
 *       made "front only" flip into "prints anywhere" (an absent garment =
 *       pre-A3 "no capability data"). Round trip through BOTH capability twins
 *       and the studio's applyPrinterAreas.
 *   F5  OrderPaymentCard's "Utbetalning till butiken" follows refunds: Stripe
 *       reverses the transfer proportionally (reverse_transfer), so the shop
 *       keeps (total − fee) × (charged − refunded) / charged; full refund → 0.
 *
 * RUN: npm --prefix functions run build && node rules-tests/audit-2026-09-26.test.mjs
 */
import { createRequire } from 'node:module';
import { docToForm, formToPrintAreas } from '../src/components/platform/printerTierForm.js';
import { isSlotPrintable as clientIsSlotPrintable } from '../src/wagons/pod-wagon/printRouting.js';
import { applyPrinterAreas } from '../src/config/printerAreas.js';
import { shopPayoutSek } from '../src/utils/shopPayout.js';

const require = createRequire(import.meta.url);
const server = require('../functions/lib/print/printRouting.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n=== F3: clearing the last frame keeps an explicit {} (never drops the garment) ===');
{
  // SnapWear-style tier: tee front only (sleeves NOT printable), hoodie front.
  const TIER = {
    active: true,
    garments: ['tee', 'hoodie'],
    printAreasMm: { tee: { front: { w: 390, h: 490, offsetTopMm: 30 } }, hoodie: { front: { w: 390, h: 280 } } },
  };
  const before = docToForm(TIER);
  ok(eq(formToPrintAreas(before), TIER.printAreasMm), 'doc → form → doc round-trips unchanged');
  ok(clientIsSlotPrintable(TIER, 'tee', 'left_sleeve') === false && server.isSlotPrintable(TIER, 'tee', 'left_sleeve') === false,
    'front-only tee: both twins refuse left_sleeve before the edit');

  // The operator clears the tee's only frame but leaves the tee offered.
  const cleared = { ...before, areas: { ...before.areas, tee: { ...before.areas.tee, front: { w: '', h: '', top: '' } } } };
  const saved = formToPrintAreas(cleared);
  ok(eq(saved, { tee: {}, hoodie: { front: { w: 390, h: 280 } } }), `tee keeps an EXPLICIT empty map: ${JSON.stringify(saved)}`);
  ok(Object.prototype.hasOwnProperty.call(saved, 'tee'), 'the tee key is present (not omitted)');

  const after = { ...TIER, printAreasMm: saved };
  for (const slot of ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve']) {
    const c = clientIsSlotPrintable(after, 'tee', slot);
    const s = server.isSlotPrintable(after, 'tee', slot);
    ok(c === false && s === false, `after clearing: ${slot} refused by client (${c}) and server (${s})`);
  }
  ok(clientIsSlotPrintable(after, 'tee', 'other') === true && server.isSlotPrintable(after, 'tee', 'other') === true,
    "'other' stays ungated (catch-all placement)");
  ok(clientIsSlotPrintable(after, 'hoodie', 'front') === true, 'the untouched hoodie is unaffected');

  // Studio consequence: the derived template has NO slot left → not offered.
  const TEE_TEMPLATE = {
    id: 'tee_bc_e150', garment: 'tee',
    printAreas: { front: { x: 342, y: 411, w: 276, h: 322 }, back: { x: 340, y: 340, w: 280, h: 373 }, left_sleeve: { x: 725, y: 365, w: 74, h: 74 } },
    printAreaMm: { front: { w: 300, h: 350 }, back: { w: 300, h: 400 }, left_sleeve: { w: 80, h: 80 } },
  };
  const derived = applyPrinterAreas(TEE_TEMPLATE, saved.tee);
  ok(Object.keys(derived.printAreas).length === 0, 'applyPrinterAreas(template, {}) leaves zero print slots (studio hides the garment)');
  ok(Object.keys(applyPrinterAreas(TEE_TEMPLATE, undefined).printAreas).length === 3, 'absent garment entry still means "no data" → template untouched (legacy tiers)');

  // Unchecking the garment is the way to drop it entirely — unchanged.
  const unchecked = { ...cleared, garments: new Set(['hoodie']) };
  ok(eq(formToPrintAreas(unchecked), { hoodie: { front: { w: 390, h: 280 } } }), 'an UNCHECKED garment gets no entry (as before)');
  // A brand-new tier with nothing typed: every offered garment explicit-empty.
  const fresh = docToForm({ garments: ['tee', 'cap'] });
  ok(eq(formToPrintAreas(fresh), { tee: {}, cap: {} }), 'a tier with offered garments and no frames serializes to explicit empties');
  // Half-typed cells are still ignored by the serializer (incompleteAreaCells refuses the save upstream).
  const half = { ...fresh, areas: { ...fresh.areas, tee: { ...fresh.areas.tee, back: { w: '390', h: '', top: '' } } } };
  ok(eq(formToPrintAreas(half), { tee: {}, cap: {} }), 'a frame with only a width is not a frame');
}

console.log('\n=== F5: shop payout after refunds (proportional transfer reversal) ===');
{
  const base = { total: 647, feeSek: 310.42, chargedSek: 647 };
  ok(shopPayoutSek({ ...base, refundedSek: 0 }) === 336.58, 'no refund → total − fee (336.58)');
  ok(shopPayoutSek({ ...base, refundedSek: undefined }) === 336.58, 'absent refundedTotalSek → same as 0');
  ok(shopPayoutSek({ ...base, refundedSek: 647 }) === 0, 'FULL refund → 0 (was 336.58 before the fix)');
  ok(shopPayoutSek({ ...base, refundedSek: 299 }) === 181.04, 'partial 299/647 → (647−310.42)×348/647 = 181.04');
  ok(shopPayoutSek({ ...base, refundedSek: 1000 }) === 0, 'over-refund data never goes negative');
  ok(shopPayoutSek({ ...base, refundedSek: -5 }) === 336.58, 'negative refund data is treated as 0');
  ok(shopPayoutSek({ total: 647, feeSek: 310.42, chargedSek: undefined, refundedSek: 647 }) === 0, 'missing payment.amount falls back to total (legacy orders)');
  ok(shopPayoutSek({ total: 647, feeSek: 0, chargedSek: 647, refundedSek: 323.5 }) === 323.5, 'zero fee → the un-refunded half');
  ok(shopPayoutSek({ total: 0, feeSek: 0, chargedSek: 0, refundedSek: 0 }) === 0, 'nothing charged → 0, no division by zero');
  ok(shopPayoutSek({ total: 647, feeSek: 700, chargedSek: 647, refundedSek: 0 }) === 0, 'fee above total clamps at 0 (never a negative payout)');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} audit-2026-09-26: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
