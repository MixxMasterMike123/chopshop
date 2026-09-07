#!/usr/bin/env node
/**
 * READ-ONLY report: which shops would the legal checkout gate block today?
 *
 * The gate (functions/src/payment/createPaymentIntent.ts legalCheckoutBlockReason,
 * mirrored in src/utils/legalPageReadiness.js) refuses a PaymentIntent unless
 * the shop has: returnAddress, vatRegistered (boolean), and a seller acceptance
 * (storeIdentity.legal.acceptance). Run this BEFORE deploying the gate so no
 * live shop is closed by surprise, and again after sellers accept.
 *
 *   node scripts/report-legal-readiness.cjs
 *
 * Never writes. Reads prod (named DB b8s-reseller-db via ADC), same idiom as
 * scripts/backfill-shop-type.cjs.
 */

const path = require('path');
const { createRequire } = require('module');
const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const admin = functionsRequire('firebase-admin');
const { getFirestore } = functionsRequire('firebase-admin/firestore');

admin.initializeApp();
const db = getFirestore('b8s-reseller-db');

// Same logic as legalCheckoutBlockReason — duplicated on purpose so this report
// has no build dependency; keep in sync.
function blockReasons(shop) {
  const id = shop?.storeIdentity || {};
  const out = [];
  if (!String(id.returnAddress || '').trim()) out.push('returadress saknas');
  if (typeof id.vatRegistered !== 'boolean') out.push('momsstatus ej angiven');
  const a = id.legal?.acceptance;
  if (!a || !String(a.acceptedAt || '').trim()) out.push('villkor ej godkända av säljaren');
  return out;
}

(async () => {
  const snap = await db.collection('shops').get();
  const rows = [];
  for (const d of snap.docs) {
    const s = d.data();
    const reasons = blockReasons(s);
    rows.push({
      shop: d.id,
      status: s.status || '-',
      published: s.published === false ? 'false' : 'live',
      charges: s.payments?.chargesEnabled === true ? 'yes' : 'no',
      platformTerms: s.platformTerms?.version || '-',
      gate: reasons.length ? 'BLOCKED' : 'ok',
      reasons: reasons.join(', '),
    });
  }
  rows.sort((a, b) => (a.gate === b.gate ? a.shop.localeCompare(b.shop) : a.gate === 'BLOCKED' ? -1 : 1));
  console.table(rows);
  const blockedLive = rows.filter((r) => r.gate === 'BLOCKED' && r.charges === 'yes' && r.status !== 'disabled' && r.published === 'live');
  console.log(`\n${rows.length} shops · ${rows.filter((r) => r.gate === 'BLOCKED').length} would be blocked · ${blockedLive.length} of those currently take card payments (chargesEnabled):`);
  for (const r of blockedLive) console.log(`  ⚠️  ${r.shop}: ${r.reasons}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
