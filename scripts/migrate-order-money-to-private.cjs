/**
 * Move the money breakdown off existing orders into orderProduction/{orderId}
 * (A13 "seller sees ONE number", Mikael 2026-09-25).
 *
 * WHY: orders/{id} is readable by the seller (list) and by anyone holding the
 * order id (allow get: if true). From the A13 deploy on, the Stripe webhook and
 * the B2B snapshot freeze write the per-line production costs and the Connect
 * fee breakdown to the server-only orderProduction/{id} instead. Orders created
 * BEFORE that still carry them; this moves them:
 *
 *   orderProduction/{id} ← { shopId, paymentIntentId, snapshot: FULL,
 *                            connect: { commissionBps, productionWithheldOre,
 *                            productionVatRate }, createdAt, migratedAt }
 *   orders/{id}          ← productionSnapshot = STRIPPED (routing kept),
 *                          connect.<those three> deleted field by field
 *                          (dispute/refund fields on connect are untouched).
 *
 * Both writes per order in ONE batch. Uses the COMPILED helpers from
 * functions/lib (payment/orderMoney.js) so the strip is byte-identical to the
 * webhook's (run `cd functions && npm run build` first). Idempotent: an order
 * with no money left is skipped; an existing orderProduction doc is never
 * overwritten (reported instead).
 *
 * Beta data: expect few or zero orders. Run order: AFTER the A13 functions
 * deploy (so no new order can re-introduce money on the order doc), then dry
 * run, then --commit.
 *
 *   node scripts/migrate-order-money-to-private.cjs            # dry run (default)
 *   node scripts/migrate-order-money-to-private.cjs --commit   # apply
 *
 * Named DB b8s-reseller-db; needs micke ADC (NOT the merchant SA).
 */
const { createRequire } = require('module');
const path = require('path');
const req = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { Firestore, FieldValue } = req('@google-cloud/firestore');
const {
  stripSnapshotMoney, splitConnect, orderCarriesMoney, findMoneyKeys, CONNECT_PRIVATE,
} = require(path.join(__dirname, '..', 'functions', 'lib', 'payment', 'orderMoney.js'));

const COMMIT = process.argv.includes('--commit');
const db = new Firestore({ projectId: 'b8shield-reseller-app', databaseId: 'b8s-reseller-db' });

// The keys that must be gone from the order afterwards (the post-strip check).
const ORDER_MUST_NOT_CARRY = ['itemCostSek', 'printCostSek', 'printerShippingSek', ...CONNECT_PRIVATE];

(async () => {
  const snap = await db.collection('orders').get();
  const todo = snap.docs.filter((d) => orderCarriesMoney(d.data()));
  console.log(`Scanned ${snap.size} orders; ${todo.length} still carry money on the order doc.`);

  const plans = [];
  for (const d of todo) {
    const order = d.data();
    const prodRef = db.collection('orderProduction').doc(d.id);
    const existing = await prodRef.get();
    const snapshot = order.productionSnapshot || null;
    const priv = splitConnect(order.connect).private;
    const orderAfter = {
      ...order,
      ...(snapshot ? { productionSnapshot: stripSnapshotMoney(snapshot) } : {}),
      ...(order.connect ? { connect: Object.fromEntries(Object.entries(order.connect).filter(([k]) => !CONNECT_PRIVATE.includes(k))) } : {}),
    };
    const leftover = findMoneyKeys(orderAfter, ORDER_MUST_NOT_CARRY);
    if (leftover.length) throw new Error(`order ${d.id}: strip would leave ${leftover.join(', ')}`);
    plans.push({ id: d.id, order, prodRef, existing: existing.exists, snapshot, priv });
    console.log(`  ${order.shopId || '∅'}  ${d.id}  lines=${snapshot?.lines?.length ?? 0}  connect-private=${Object.keys(priv).join(',') || '—'}${existing.exists ? '  ⚠ orderProduction EXISTS — money doc kept, only the order is stripped' : ''}`);
  }

  if (!COMMIT) { console.log('\nDRY RUN — re-run with --commit to apply.'); return; }

  for (const p of plans) {
    const batch = db.batch();
    if (!p.existing) {
      batch.create(p.prodRef, {
        shopId: p.order.shopId || null,
        paymentIntentId: p.order.source === 'b2c' ? p.id : null,
        snapshot: p.snapshot,
        connect: p.priv,
        createdAt: p.order.createdAt || new Date(),
        migratedAt: new Date(),
      });
    }
    const patch = {};
    if (p.snapshot) patch.productionSnapshot = stripSnapshotMoney(p.snapshot);
    for (const k of CONNECT_PRIVATE) {
      if (p.order.connect && k in p.order.connect) patch[`connect.${k}`] = FieldValue.delete();
    }
    batch.update(db.collection('orders').doc(p.id), patch);
    await batch.commit();
    console.log(`  ✔ ${p.id}`);
  }
  console.log(`Done. ${plans.length} order(s) migrated.`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
