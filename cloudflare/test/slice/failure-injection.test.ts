import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runReconciliation, runRetentionSweep } from "../../src/commerce/crons";
import { runClaimedOutboxRow } from "../../src/outbox/effects";
import { CLAIM_TTL_MS, claimById, newClaimToken } from "../../src/outbox/outbox";
import { runOutboxSweep } from "../../src/outbox/sweeper";
import { lineRow, outboxRow, printerJobs } from "../dispatch-fixtures";
import { paymentEventRow, postEvent, refundOps } from "../money-fixtures";
import {
  acquireJob,
  adminOrder,
  approveProduct,
  artworkDetail,
  assertLedgerBalanced,
  bootstrapPlatform,
  buyProduct,
  cancelCall,
  claimReceipt,
  completeJob,
  completionBody,
  createArtwork,
  createPlainProduct,
  createPodProduct,
  createTenant,
  cronTick,
  DAY_MS,
  deliverEmails,
  deliverOutbox,
  dyingDb,
  expectJson,
  FakeResend,
  instrumentedDb,
  markIntentSucceeded,
  MINUTE_MS,
  openCheckout,
  opWrites,
  outboxRowsFor,
  payCheckout,
  paymentCall,
  pngBytes,
  type PrinterLog,
  printerWire,
  publishProduct,
  readBuyerOrder,
  refundCall,
  renderReadyArtwork,
  resolveCall,
  seedPrintShop,
  settle,
  SliceWorld,
  succeedPayment,
  type Tenant,
  uploadOriginal,
  uploadOutputs,
} from "../slice-harness";

/**
 * PLAN §10 CP2 — the failure-injection suite, one `describe` per item of the
 * plan's list, plus the exit criteria. Every order here is made through the
 * real routes (checkout → PaymentIntent → signed webhook); failures are
 * injected only through production seams (the Stripe gateway, the printer
 * transport, the Resend fetch) and a D1 handle that dies at a named statement.
 *
 * "Exactly once" is always asserted against the third party's OWN record: the
 * fake Stripe's intents and refunds, the fake printer's `fake_printer_jobs`,
 * the fake Resend's delivered set.
 */

const world = new SliceWorld();
let shopA: Tenant;
let shopB: Tenant;
let teeA = "";
let mugB = "";

const FAILED = ["threw", 500];

beforeAll(async () => {
  await bootstrapPlatform(world);
  shopA = await createTenant(world, { host: "shop-a.fi.slice.test", shopName: "Butik A", tenantId: "fi-shop-a" });
  shopB = await createTenant(world, { host: "shop-b.fi.slice.test", shopName: "Butik B", tenantId: "fi-shop-b" });
  await seedPrintShop(world);

  const artworkId = await renderReadyArtwork(world, shopA, 7);
  ({ productId: teeA } = await createPodProduct(world, shopA, {
    artworkId,
    name: "Tröja A",
    priceMinor: 39_900,
    sku: "FI-TEE-A",
  }));
  expect((await publishProduct(world, shopA, teeA)).product.screeningStatus).toBe("pending");
  await approveProduct(world, teeA);

  mugB = await createPlainProduct(world, shopB, { name: "Mugg B", priceMinor: 14_900, sku: "FI-MUG-B" });
  expect((await publishProduct(world, shopB, mugB)).product.screeningStatus).toBe("pending");
  await approveProduct(world, mugB);
}, 60_000);

beforeEach(() => {
  // A fresh Stripe and fresh queues per test: the crons are global, and a
  // test's Stripe knows only the intents that test made.
  world.reset();
});

/** Delivers every pending outbox row of an order to the real consumer. */
async function drain(orderId: string): Promise<void> {
  const pending = (await outboxRowsFor(orderId)).filter((row) => row.status === "pending");
  if (pending.length > 0) {
    await deliverOutbox(world, pending.map((row) => row.outbox_id));
  }
}

async function checkoutRow(checkoutId: string) {
  return env.DB.prepare(
    `SELECT status, payment_intent_id, payment_intent_status, production_snapshot_json,
            snapshot_purged_at, application_fee_minor
     FROM checkouts WHERE checkout_id = ?`,
  )
    .bind(checkoutId)
    .first<{
      application_fee_minor: number | null;
      payment_intent_id: string | null;
      payment_intent_status: string | null;
      production_snapshot_json: string | null;
      snapshot_purged_at: string | null;
      status: string;
    }>();
}

async function ordersForCheckout(checkoutId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE checkout_id = ?")
    .bind(checkoutId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function openAlertKinds(resourceId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT kind FROM alerts WHERE resource_id = ? AND resolved_at IS NULL ORDER BY kind",
  )
    .bind(resourceId)
    .all<{ kind: string }>();
  return rows.results.map((row) => row.kind);
}

// ═══════════════════════════════════════════════════════════════════════════
describe("1. crash after each external success, before the local commit", () => {
  it("PaymentIntent create: Stripe made it, the attach died → the retry re-serves the SAME intent (one at Stripe)", async () => {
    const checkout = await openCheckout(world, shopA, [{ productId: teeA, quantity: 1 }]);
    const dying = dyingDb(
      () => world.stripe.createCalls.length > 0,
      (op) => op.kind === "run" && opWrites(op, /UPDATE checkouts[\s\S]*SET payment_intent_id/),
    );

    const first = await settle(paymentCall(world, shopA, checkout.checkoutId, world.with({ DB: dying.db })));

    expect(FAILED, "the D1 fault is a failed invocation, never a false 2xx").toContain(first);
    expect(world.stripe.intents.size, "Stripe made the intent").toBe(1);
    const [intentId] = [...world.stripe.intents.keys()];
    expect((await checkoutRow(checkout.checkoutId))?.payment_intent_id, "…D1 never recorded it").toBeNull();

    // The buyer's page retries: same idempotency key → the same intent, attached now.
    const retried = await expectJson<{ payment: { paymentIntentId: string } }>(
      await paymentCall(world, shopA, checkout.checkoutId),
      201,
      "retry",
    );
    expect(retried.payment.paymentIntentId).toBe(intentId);
    const reserved = await expectJson<{ payment: { paymentIntentId: string } }>(
      await paymentCall(world, shopA, checkout.checkoutId),
      200,
      "re-serve",
    );
    expect(reserved.payment.paymentIntentId).toBe(intentId);
    expect(world.stripe.createCalls).toHaveLength(2);
    expect(new Set(world.stripe.createCalls.map((params) => params.idempotencyKey)).size).toBe(1);
    expect(world.stripe.intents.size, "exactly ONE intent at Stripe").toBe(1);
    expect((await checkoutRow(checkout.checkoutId))?.application_fee_minor).toBe(
      world.stripe.createCalls[0]?.applicationFeeAmount,
    );

    // …and it pays through to exactly one order.
    const { orderId } = await succeedPayment(world, shopA, {
      checkoutId: checkout.checkoutId,
      paymentIntentId: intentId ?? "",
      totalMinor: checkout.totalMinor,
    });
    expect(orderId).not.toBeNull();
    await drain(orderId ?? "");
    await assertLedgerBalanced(env.DB, orderId ?? "", { stripe: world.stripe });
    expect(await printerJobs(orderId ?? "")).toHaveLength(1);
  });

  it("refund create: Stripe refunded, the settlement died → Stripe's refund.created settles it; ONE refund, money moved once", async () => {
    const order = await buyProduct(world, shopA, teeA);
    await drain(order.orderId);
    const dying = dyingDb(
      () => world.stripe.refunds.size > 0,
      (op) => op.kind === "batch" && opWrites(op, /UPDATE refund_operations/),
    );

    const outcome = await settle(refundCall(world, shopA, order.orderId, 5_000, world.with({ DB: dying.db })));

    expect(FAILED).toContain(outcome);
    const [op] = await refundOps(order.orderId);
    expect(op, "the reservation holds; the op never heard back").toMatchObject({
      amount_minor: 5_000,
      state: "reserved",
      stripe_refund_id: null,
    });
    await assertLedgerBalanced(env.DB, order.orderId);
    expect(world.stripe.refunds.size).toBe(1);
    const refund = [...world.stripe.refunds.values()][0]!;
    expect(refund.metadata.refund_operation_id).toBe(op?.id);

    const created = await postEvent("refund.created", { ...refund, object: "refund" }, { env: world.env });
    expect(created.response.status).toBe(200);
    // The same fact again, under another type and as a replay: nothing moves.
    await postEvent("refund.updated", { ...refund, object: "refund" }, { env: world.env });
    await postEvent("refund.created", { ...refund, object: "refund" }, { env: world.env, eventId: created.eventId });

    expect(await refundOps(order.orderId)).toEqual([
      expect.objectContaining({ id: op?.id, state: "succeeded", stripe_refund_id: refund.id }),
    ]);
    expect(world.stripe.refundCalls, "Stripe was asked once").toHaveLength(1);
    const read = await adminOrder(world, shopA, order.orderId);
    const ledger = await assertLedgerBalanced(env.DB, order.orderId, {
      payoutMinor: read.payout.amountMinor,
      stripe: world.stripe,
    });
    expect(ledger).toMatchObject({ refundedMinor: 5_000, refundHeldMinor: 0 });
  });

  it("refund create: Stripe refunded, the settlement died, no webhook → reconciliation (31 min later) finds and settles it", async () => {
    const order = await buyProduct(world, shopA, teeA);
    await drain(order.orderId);
    const dying = dyingDb(
      () => world.stripe.refunds.size > 0,
      (op) => op.kind === "batch" && opWrites(op, /UPDATE refund_operations/),
    );
    expect(FAILED).toContain(
      await settle(refundCall(world, shopA, order.orderId, 6_000, world.with({ DB: dying.db }))),
    );
    const [op] = await refundOps(order.orderId);

    const summary = await runReconciliation(world.env, Date.now() + 31 * MINUTE_MS);

    expect(summary.refunds.settled).toBeGreaterThanOrEqual(1);
    expect(await refundOps(order.orderId)).toEqual([
      expect.objectContaining({ id: op?.id, state: "succeeded" }),
    ]);
    expect(await openAlertKinds(op?.id ?? ""), "settled, so nothing to alert").toEqual([]);
    expect(world.stripe.refundCalls).toHaveLength(1);
    await assertLedgerBalanced(env.DB, order.orderId, { stripe: world.stripe });
  });

  it("printer submit: the printer accepted, the commit died → re-claimed after the claim TTL, answered duplicate → ONE job", async () => {
    const order = await buyProduct(world, shopA, teeA);
    const dispatchId = order.dispatchIds[0]!;
    const wire: PrinterLog = [];
    let delivered = false;
    const dying = dyingDb(() => delivered);

    const first = await deliverOutbox(
      world,
      [dispatchId],
      world.with({ DB: dying.db, ...printerWire(() => "deliver", async () => { delivered = true; }, wire) }),
    );

    expect(first.retries, "the consumer retries the nudge").toHaveLength(1);
    expect(await outboxRow(dispatchId)).toMatchObject({ status: "submitting" });
    expect(await printerJobs(order.orderId)).toHaveLength(1);

    await runOutboxSweep(world.with(printerWire(() => "deliver", undefined, wire)), Date.now() + CLAIM_TTL_MS + 1_000);

    expect(await outboxRow(dispatchId)).toMatchObject({ attempts: 2, status: "done" });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("accepted");
    // Re-submitted once under the SAME job id; the printer answered "duplicate".
    expect(wire.map((entry) => entry.jobId)).toEqual([`${order.orderId}-1`, `${order.orderId}-1`]);
    expect(await printerJobs(order.orderId), "exactly ONE job at the printer").toHaveLength(1);
  });

  it("render complete: the promotion landed, the commit died → the farm's resent completion is accepted; one ready verdict, one audit", async () => {
    const objectId = await uploadOriginal(world, shopA, pngBytes(21));
    const artworkId = await createArtwork(world, shopA, objectId);
    const lease = await acquireJob(world);
    expect(lease?.attempt).toBe(1);
    if (lease === null) {
      return;
    }
    const outputs = await uploadOutputs(lease, 77);
    const body = completionBody(lease, outputs);
    const dying = dyingDb(
      () => true,
      (op) => op.kind === "batch" && opWrites(op, /UPDATE render_jobs[\s\S]*SET state = 'completed'/),
    );

    expect(FAILED).toContain(await settle(completeJob(world, lease.jobId, body, world.with({ DB: dying.db }))));
    const canonical = `pod/${shopA.tenantId}/print/${artworkId}.png`;
    expect((await env.PRIVATE_BUCKET.head(canonical))?.size, "promoted before the commit").toBe(outputs.print.bytes);
    expect((await artworkDetail(world, shopA, artworkId)).artwork.status).toBe("processing");

    // The farm got no answer and resends the same completion.
    await expectJson(await completeJob(world, lease.jobId, body), 200, "resent completion");

    expect((await artworkDetail(world, shopA, artworkId)).artwork).toMatchObject({
      printSha256: outputs.print.sha256,
      status: "ready",
    });
    const job = await env.DB.prepare("SELECT state, attempt FROM render_jobs WHERE id = ?")
      .bind(lease.jobId)
      .first();
    expect(job).toEqual({ attempt: 1, state: "completed" });
    const audits = await env.DB.prepare(
      "SELECT event_id FROM audit_events WHERE resource_id = ? AND action = 'pod.artwork.ready'",
    )
      .bind(artworkId)
      .all<{ event_id: string }>();
    expect(audits.results.map((row) => row.event_id)).toEqual([`render-job-completed:${lease.jobId}`]);
    const leftovers = await env.PRIVATE_BUCKET.list({ prefix: lease.outputPrefix });
    expect(leftovers.objects, "the attempt's outputs were swept after promotion").toHaveLength(0);
  });

  it("email (outbox effect): enqueued, then the worker died before its commit → identical job re-queued, the -email consumer sends ONE", async () => {
    const order = await buyProduct(world, shopA, teeA, { deliverEmail: false });
    await deliverOutbox(world, order.dispatchIds);
    let enqueued = false;
    const emails = world.emails;
    const crashingQueue = {
      async send(body: unknown) {
        await emails.queue.send(body);
        enqueued = true;
      },
      async sendBatch(messages: Iterable<MessageSendRequest>) {
        await emails.queue.sendBatch(messages);
        enqueued = true;
      },
    };
    const dying = dyingDb(() => enqueued);

    const first = await deliverOutbox(world, [order.emailId], world.with({ DB: dying.db, EMAIL_QUEUE: crashingQueue }));

    expect(first.retries).toHaveLength(1);
    expect((await outboxRow(order.emailId)).status).toBe("submitting");
    await runOutboxSweep(world.env, Date.now() + CLAIM_TTL_MS + 1_000);
    expect((await outboxRow(order.emailId)).status).toBe("done");
    expect(world.emails.sent).toHaveLength(2);
    expect(world.emails.sent[1], "the re-run built the identical job").toEqual(world.emails.sent[0]);

    const resend = new FakeResend();
    const delivered = await deliverEmails(world, resend);
    expect(delivered.acks).toEqual(["m0", "m1"]);
    expect(resend.calls, "Resend was called once").toHaveLength(1);
    expect(resend.delivered.size).toBe(1);
  });

  it("email (-email consumer): Resend accepted, the ledger write died → the redelivery repeats the Idempotency-Key; the buyer gets ONE email", async () => {
    const order = await buyProduct(world, shopA, teeA, { deliverEmail: false });
    await drain(order.orderId);
    const jobs = world.emails.sent.splice(0);
    expect(jobs).toHaveLength(1);
    const deliveryId = (jobs[0] as { deliveryId: string }).deliveryId;
    const resend = new FakeResend();
    const dying = dyingDb(
      () => resend.calls.length > 0,
      (op) => op.kind === "run" && opWrites(op, /UPDATE email_deliveries[\s\S]*status = 'sent'/),
    );

    const first = await deliverEmails(world, resend, { env: world.with({ DB: dying.db }), jobs });

    expect(first.retries).toHaveLength(1);
    expect(resend.calls).toHaveLength(1);
    // The claim's lease runs out (the clock, advanced on the row itself).
    await env.DB.prepare("UPDATE email_deliveries SET lease_until = ? WHERE delivery_id = ?")
      .bind(Date.now() - 1, deliveryId)
      .run();

    const second = await deliverEmails(world, resend, { jobs });

    expect(second.acks).toEqual(["m0"]);
    expect(resend.calls).toHaveLength(2);
    expect(new Set(resend.calls.map((call) => call.idempotencyKey))).toEqual(
      new Set([deliveryId]),
    );
    expect(resend.delivered.size, "ONE email reaches the buyer").toBe(1);
    const ledger = await env.DB.prepare("SELECT status FROM email_deliveries WHERE delivery_id = ?")
      .bind(deliveryId)
      .first<{ status: string }>();
    expect(ledger?.status).toBe("sent");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2. duplicate webhook replay", () => {
  it("the same payment_intent.succeeded twice, then a new event id for the same intent → ONE order, one set of outbox rows", async () => {
    const checkout = await openCheckout(world, shopA, [{ productId: teeA, quantity: 1 }]);
    const paymentIntentId = await payCheckout(world, shopA, checkout.checkoutId);
    const payment = { checkoutId: checkout.checkoutId, paymentIntentId, totalMinor: checkout.totalMinor };

    const first = await succeedPayment(world, shopA, payment);
    const replay = await succeedPayment(world, shopA, payment, { eventId: first.eventId });
    const other = await succeedPayment(world, shopA, payment);

    expect(first.orderId).not.toBeNull();
    expect(replay.orderId).toBe(first.orderId);
    expect(other.orderId).toBe(first.orderId);
    expect(await ordersForCheckout(checkout.checkoutId)).toBe(1);
    const rows = await outboxRowsFor(first.orderId ?? "");
    expect(rows.map((row) => row.event_type)).toEqual(["dispatch", "email"]);
    const ledgerRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_events WHERE event_id = ?")
      .bind(first.eventId)
      .first<{ n: number }>();
    expect(ledgerRows?.n).toBe(1);
    expect(await paymentEventRow(other.eventId)).toMatchObject({ outcome: "ignored" });

    await drain(first.orderId ?? "");
    expect(await printerJobs(first.orderId ?? "")).toHaveLength(1);
    await assertLedgerBalanced(env.DB, first.orderId ?? "", { stripe: world.stripe });
  });

  it("a dashboard refund seen as refund.created, charge.refunded (embedded), refund.updated and a replay → money moves ONCE", async () => {
    const order = await buyProduct(world, shopA, teeA);
    await drain(order.orderId);
    const refund = world.stripe.addDashboardRefund(order.paymentIntentId, 7_000);
    const asObject = { ...refund, object: "refund" };

    const created = await postEvent("refund.created", asObject, { env: world.env });
    await postEvent(
      "charge.refunded",
      {
        amount_refunded: 7_000,
        id: `ch_${order.paymentIntentId.replace(/^pi_/, "")}`,
        object: "charge",
        payment_intent: order.paymentIntentId,
        refunds: { data: [asObject] },
      },
      { env: world.env },
    );
    await postEvent("refund.updated", asObject, { env: world.env });
    await postEvent("refund.created", asObject, { env: world.env, eventId: created.eventId });

    expect(await refundOps(order.orderId)).toEqual([
      expect.objectContaining({ amount_minor: 7_000, origin: "stripe", state: "succeeded", stripe_refund_id: refund.id }),
    ]);
    const ledger = await assertLedgerBalanced(env.DB, order.orderId, { stripe: world.stripe });
    expect(ledger.refundedMinor).toBe(7_000);
  });

  it("an admin refund settled by its API answer, then echoed by refund.updated and charge.refunded → no second movement", async () => {
    const order = await buyProduct(world, shopA, teeA);
    await drain(order.orderId);
    const refunded = await expectJson<{ refund: { refundId: string; state: string } }>(
      await refundCall(world, shopA, order.orderId, 4_000),
      201,
      "admin refund",
    );
    expect(refunded.refund.state).toBe("succeeded");
    const refund = [...world.stripe.refunds.values()][0]!;

    await postEvent("refund.updated", { ...refund, object: "refund" }, { env: world.env });
    await postEvent(
      "charge.refunded",
      {
        amount_refunded: 4_000,
        id: `ch_${order.paymentIntentId.replace(/^pi_/, "")}`,
        object: "charge",
        payment_intent: order.paymentIntentId,
        refunds: { data: [{ ...refund, object: "refund" }] },
      },
      { env: world.env },
    );

    expect((await refundOps(order.orderId)).map((op) => [op.state, op.amount_minor])).toEqual([["succeeded", 4_000]]);
    const ledger = await assertLedgerBalanced(env.DB, order.orderId, { stripe: world.stripe });
    expect(ledger.refundedMinor).toBe(4_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("3. delayed success vs the retention sweep", () => {
  it("a live abandoned intent is canceled at Stripe FIRST; its snapshot is purged only 7 days after the cancel", async () => {
    const checkout = await openCheckout(world, shopA, [{ productId: teeA, quantity: 1 }]);
    const paymentIntentId = await payCheckout(world, shopA, checkout.checkoutId);
    const t0 = Date.now();

    await runRetentionSweep(world.env, t0 + 8 * DAY_MS);

    expect(world.stripe.cancelCalls).toContain(paymentIntentId);
    expect(world.stripe.intents.get(paymentIntentId)?.status).toBe("canceled");
    const canceled = await checkoutRow(checkout.checkoutId);
    expect(canceled).toMatchObject({ payment_intent_status: "canceled", status: "abandoned" });
    expect(canceled?.production_snapshot_json, "the cancel is a state change: kept 7 more days").not.toBeNull();

    await runRetentionSweep(world.env, t0 + 14 * DAY_MS);
    expect((await checkoutRow(checkout.checkoutId))?.production_snapshot_json).not.toBeNull();

    await runRetentionSweep(world.env, t0 + 16 * DAY_MS);
    const purged = await checkoutRow(checkout.checkoutId);
    expect(purged?.production_snapshot_json).toBeNull();
    expect(purged?.snapshot_purged_at).not.toBeNull();
    expect(await ordersForCheckout(checkout.checkoutId)).toBe(0);
  });

  it("an intent that already SUCCEEDED: the sweep's cancel is refused, the snapshot survives, the late webhook makes the order and ONE print job", async () => {
    const checkout = await openCheckout(world, shopA, [{ productId: teeA, quantity: 1 }]);
    const paymentIntentId = await payCheckout(world, shopA, checkout.checkoutId);
    markIntentSucceeded(world, paymentIntentId); // Stripe charged it; the webhook is late
    const snapshotBefore = (await checkoutRow(checkout.checkoutId))?.production_snapshot_json;
    const t0 = Date.now();

    const swept = await runRetentionSweep(world.env, t0 + 8 * DAY_MS);

    expect(world.stripe.cancelCalls, "cancel is tried first…").toContain(paymentIntentId);
    expect(swept.skippedSucceeded, "…refused, and Stripe's answer recorded").toBeGreaterThanOrEqual(1);
    const survived = await checkoutRow(checkout.checkoutId);
    expect(survived).toMatchObject({ payment_intent_status: "succeeded", status: "open" });
    expect(survived?.production_snapshot_json, "the snapshot survives").toBe(snapshotBefore);

    const { orderId } = await succeedPayment(world, shopA, {
      checkoutId: checkout.checkoutId,
      paymentIntentId,
      totalMinor: checkout.totalMinor,
    });
    expect(orderId).not.toBeNull();
    const order = await env.DB.prepare("SELECT production_snapshot_json FROM orders WHERE order_id = ?")
      .bind(orderId)
      .first<{ production_snapshot_json: string }>();
    expect(order?.production_snapshot_json).toBe(snapshotBefore);
    await drain(orderId ?? "");
    expect(await printerJobs(orderId ?? "")).toHaveLength(1);
    await assertLedgerBalanced(env.DB, orderId ?? "", { stripe: world.stripe });

    // Only once the order holds it does the checkout's copy go.
    await runRetentionSweep(world.env, t0 + 16 * DAY_MS);
    expect((await checkoutRow(checkout.checkoutId))?.production_snapshot_json).toBeNull();
    const kept = await env.DB.prepare("SELECT production_snapshot_json FROM orders WHERE order_id = ?")
      .bind(orderId)
      .first<{ production_snapshot_json: string }>();
    expect(kept?.production_snapshot_json).toBe(snapshotBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("4. two concurrent partial refunds", () => {
  /** An env whose FIRST reservation batch waits until `interleave` has run to completion. */
  function reservationRacedBy(interleave: () => Promise<unknown>): Env {
    let raced = false;
    const racing = instrumentedDb(async (op) => {
      if (!raced && op.kind === "batch" && opWrites(op, /refund_reserved_minor = refund_reserved_minor \+/)) {
        raced = true;
        await interleave();
      }
    });
    return world.with({ DB: racing.db });
  }

  it("both read the same version; the loser re-reads and is refused — never over-refunded", async () => {
    const order = await buyProduct(world, shopA, teeA);
    await drain(order.orderId);
    const share = Math.floor(order.totalMinor * 0.6);
    let winner = 0;

    const loser = await refundCall(
      world,
      shopA,
      order.orderId,
      share,
      reservationRacedBy(async () => {
        winner = (await refundCall(world, shopA, order.orderId, share)).status;
      }),
    );

    expect(winner).toBe(201);
    expect(loser.status).toBe(409);
    expect(await loser.json()).toMatchObject({ error: { code: "refund_not_allowed" } });
    expect(world.stripe.refundCalls, "only the reserved one reached Stripe").toHaveLength(1);
    const ledger = await assertLedgerBalanced(env.DB, order.orderId, { stripe: world.stripe });
    expect(ledger.refundedMinor).toBe(share);
    expect((await lineRow(order.orderId)).dispatch_state, "a partial refund never stops production").toBe("accepted");
  });

  it("five refunds racing for real (Promise.all): Σ refunded ≤ charged, Stripe never asked beyond it", async () => {
    const order = await buyProduct(world, shopA, teeA);
    await drain(order.orderId);
    const share = Math.floor(order.totalMinor * 0.3);

    const statuses = (
      await Promise.all(
        Array.from({ length: 5 }, () => refundCall(world, shopA, order.orderId, share)),
      )
    ).map((response) => response.status);

    const granted = statuses.filter((status) => status === 201).length;
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);
    expect(granted).toBeLessThanOrEqual(3);
    expect(granted).toBeGreaterThanOrEqual(1);
    const stripeTotal = world.stripe.refundCalls.reduce((sum, params) => sum + params.amount, 0);
    expect(stripeTotal).toBe(granted * share);
    expect(stripeTotal).toBeLessThanOrEqual(order.totalMinor);
    await assertLedgerBalanced(env.DB, order.orderId, { stripe: world.stripe });
  });

  it("two interleaved refunds that together cover the charge stop dispatch before any claim: ZERO printer jobs", async () => {
    const order = await buyProduct(world, shopA, teeA);
    const first = Math.floor(order.totalMinor / 2);
    const second = order.totalMinor - first;
    let inner = 0;

    const outer = await refundCall(
      world,
      shopA,
      order.orderId,
      second,
      reservationRacedBy(async () => {
        inner = (await refundCall(world, shopA, order.orderId, first)).status;
      }),
    );

    expect(inner).toBe(201);
    expect(outer.status, "the loser re-reads, still fits, and completes the charge").toBe(201);
    const dispatchId = order.dispatchIds[0]!;
    expect(await outboxRow(dispatchId)).toMatchObject({ status: "superseded", submitted_at: null });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("cancelled");
    await runOutboxSweep(world.env, Date.now() + 60 * MINUTE_MS);
    expect(await printerJobs(order.orderId), "a fully refunded order never reaches the printer").toHaveLength(0);
    const read = await adminOrder(world, shopA, order.orderId);
    expect(read.status).toBe("refunded");
    await assertLedgerBalanced(env.DB, order.orderId, { payoutMinor: read.payout.amountMinor, stripe: world.stripe });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("5. duplicate dispatch delivery", () => {
  it("the same row nudged twice in one batch, then redelivered → ONE printer job", async () => {
    const order = await buyProduct(world, shopA, teeA);
    const dispatchId = order.dispatchIds[0]!;
    const wire: PrinterLog = [];
    const counted = world.with(printerWire(() => "deliver", undefined, wire));

    const twice = await deliverOutbox(world, [dispatchId, dispatchId], counted);
    const again = await deliverOutbox(world, [dispatchId], counted);

    expect(twice).toEqual({ acks: ["m0", "m1"], retries: [] });
    expect(again).toEqual({ acks: ["m0"], retries: [] });
    expect(await outboxRow(dispatchId)).toMatchObject({ attempts: 1, status: "done" });
    expect(wire, "ONE submission on the wire, not merely one accepted row").toHaveLength(1);
    expect(await printerJobs(order.orderId)).toHaveLength(1);
  });

  it("three consumers delivered the same nudge at once → one claim, ONE printer job", async () => {
    const order = await buyProduct(world, shopA, teeA);
    const dispatchId = order.dispatchIds[0]!;
    const wire: PrinterLog = [];
    const counted = world.with(printerWire(() => "deliver", undefined, wire));

    const results = await Promise.all([
      deliverOutbox(world, [dispatchId], counted),
      deliverOutbox(world, [dispatchId], counted),
      deliverOutbox(world, [dispatchId], counted),
    ]);

    expect(await outboxRow(dispatchId)).toMatchObject({ attempts: 1, status: "done" });
    expect(wire, "ONE submission: the claim is atomic").toHaveLength(1);
    expect(await printerJobs(order.orderId)).toHaveLength(1);
    // The losers were told to come back later (or found it settled): nothing dropped, nothing doubled.
    expect(results.flatMap((result) => [...result.acks, ...result.retries.map((retry) => retry.id)])).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("6. lost printer response → unknown → manual resolution", () => {
  it("delivered but the answer was lost → unknown → an operator resolves ACCEPTED; who/when recorded, ONE job", async () => {
    const order = await buyProduct(world, shopA, teeA);
    const dispatchId = order.dispatchIds[0]!;

    const wire: PrinterLog = [];
    await deliverOutbox(world, [dispatchId], world.with(printerWire(() => "lose_answer", undefined, wire)));

    expect(await outboxRow(dispatchId)).toMatchObject({ status: "unknown" });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("unknown");
    const jobs = await printerJobs(order.orderId);
    expect(jobs, "the job did reach the printer").toHaveLength(1);

    const resolved = await expectJson<{ dispatch: { printerJobRef: string; state: string } }>(
      await resolveCall(world, dispatchId, {
        note: "Hittad i skrivarens panel",
        outcome: "accepted",
        printerJobRef: jobs[0]!.id,
      }),
      200,
      "resolve accepted",
    );

    expect(resolved.dispatch).toMatchObject({ printerJobRef: jobs[0]!.id, state: "done" });
    expect(await lineRow(order.orderId)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: jobs[0]!.id });
    const audit = await env.DB.prepare(
      "SELECT actor_user_id, reason FROM audit_events WHERE resource_id = ? AND action = 'dispatch.resolve'",
    )
      .bind(dispatchId)
      .first();
    expect(audit).toEqual({ actor_user_id: world.platformUserId, reason: "Hittad i skrivarens panel" });
    await runOutboxSweep(world.with(printerWire(() => "deliver", undefined, wire)), Date.now() + 60 * MINUTE_MS);
    expect(wire, "no automatic re-submit after a resolution").toHaveLength(1);
    expect(await printerJobs(order.orderId)).toHaveLength(1);
  });

  it("the printer was never reached, the answer lost → unknown → an operator resolves FAILED; ZERO jobs, nothing re-submitted", async () => {
    const order = await buyProduct(world, shopA, teeA);
    const dispatchId = order.dispatchIds[0]!;

    const wire: PrinterLog = [];
    await deliverOutbox(world, [dispatchId], world.with(printerWire(() => "unreachable", undefined, wire)));

    expect(await outboxRow(dispatchId)).toMatchObject({ status: "unknown" });
    expect(await printerJobs(order.orderId)).toHaveLength(0);

    const resolved = await expectJson<{ dispatch: { state: string } }>(
      await resolveCall(world, dispatchId, { note: "Finns inte hos skrivaren", outcome: "failed" }),
      200,
      "resolve failed",
    );

    expect(resolved.dispatch.state).toBe("failed");
    expect((await lineRow(order.orderId)).dispatch_state).toBe("failed");
    await runOutboxSweep(world.with(printerWire(() => "deliver", undefined, wire)), Date.now() + 60 * MINUTE_MS);
    expect(await outboxRow(dispatchId)).toMatchObject({ status: "failed" });
    expect(wire.map((entry) => entry.fault), "one attempt, never re-submitted once resolved").toEqual(["unreachable"]);
    expect(await printerJobs(order.orderId)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("7. cancel during submitting", () => {
  it("cancel_requested lands after the claim, before the HTTP call → superseded at the re-check, ZERO jobs", async () => {
    const order = await buyProduct(world, shopA, teeA);
    const dispatchId = order.dispatchIds[0]!;
    const claimed = await claimById(env.DB, { claimedBy: newClaimToken(), now: Date.now(), outboxId: dispatchId });
    expect(claimed).not.toBeNull();

    const cancelled = await expectJson<{ cancellation: { lines: Array<{ outcome: string }> } }>(
      await cancelCall(world, shopA, order.orderId),
      200,
      "cancel",
    );
    expect(cancelled.cancellation.lines[0]?.outcome).toBe("cancel_requested");

    const wire: PrinterLog = [];
    const outcome = await runClaimedOutboxRow(world.with(printerWire(() => "deliver", undefined, wire)), claimed!, Date.now);

    expect(outcome).toEqual({ kind: "superseded" });
    expect(wire, "nothing went on the wire").toHaveLength(0);
    expect(await outboxRow(dispatchId)).toMatchObject({ status: "superseded", submitted_at: null });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("cancelled");
    expect(await printerJobs(order.orderId)).toHaveLength(0);
  });

  it("the cancel lands while the request is on the wire → accepted, one printer_cancellation effect, one human-action alert", async () => {
    const order = await buyProduct(world, shopA, teeA);
    const dispatchId = order.dispatchIds[0]!;
    const outcomes: string[] = [];

    await deliverOutbox(
      world,
      [dispatchId],
      world.with(
        printerWire(
          () => "deliver",
          async () => {
            // The row is 'submitting' — the cancel lands mid-call.
            outcomes.push(`row:${(await outboxRow(dispatchId)).status}`);
            const body = await (await cancelCall(world, shopA, order.orderId)).json<{
              cancellation: { lines: Array<{ outcome: string }> };
            }>();
            outcomes.push(body.cancellation.lines[0]?.outcome ?? "");
          },
        ),
      ),
    );

    expect(outcomes).toEqual(["row:submitting", "cancel_requested"]);
    expect(await outboxRow(dispatchId)).toMatchObject({ status: "done" });
    expect(await printerJobs(order.orderId)).toHaveLength(1);
    const followUps = (await outboxRowsFor(order.orderId)).filter((row) => row.event_type === "printer_cancellation");
    expect(followUps).toHaveLength(1);
    await deliverOutbox(world, [followUps[0]!.outbox_id]);
    await deliverOutbox(world, [followUps[0]!.outbox_id]);
    expect(await openAlertKinds(followUps[0]!.outbox_id)).toEqual(["printer_cancellation_needed"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("8. expired render lease with a late completion", () => {
  it("attempt 1's lease expires and attempt 2 is leased; attempt 1's late completion → 409, its outputs swept; attempt 2 wins", async () => {
    const objectId = await uploadOriginal(world, shopA, pngBytes(31));
    const artworkId = await createArtwork(world, shopA, objectId);
    const first = await acquireJob(world);
    expect(first?.attempt).toBe(1);
    if (first === null) {
      return;
    }
    await env.DB.prepare("UPDATE render_jobs SET lease_until = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1_000).toISOString(), first.jobId)
      .run();
    const second = await acquireJob(world);
    expect(second).toMatchObject({ attempt: 2, jobId: first.jobId });
    if (second === null) {
      return;
    }

    // The stalled farm wakes up, uploads and reports attempt 1.
    const stale = await uploadOutputs(first, 11);
    const late = await completeJob(world, first.jobId, completionBody(first, stale));
    expect(late.status, "a late completion is rejected").toBe(409);
    expect(await late.json()).toMatchObject({ error: { code: "lease_lost" } });
    expect((await env.PRIVATE_BUCKET.list({ prefix: first.outputPrefix })).objects, "attempt 1 swept").toHaveLength(0);
    expect((await artworkDetail(world, shopA, artworkId)).artwork.status).toBe("processing");

    const fresh = await uploadOutputs(second, 12);
    await expectJson(await completeJob(world, second.jobId, completionBody(second, fresh)), 200, "attempt 2");
    expect((await artworkDetail(world, shopA, artworkId)).artwork).toMatchObject({
      printSha256: fresh.print.sha256,
      status: "ready",
    });

    // Even after attempt 2 completed, attempt 1 stays rejected and the print is attempt 2's.
    const later = await completeJob(world, first.jobId, completionBody(first, stale));
    expect(later.status).toBe(409);
    await later.body?.cancel();
    const canonical = await env.PRIVATE_BUCKET.get(`pod/${shopA.tenantId}/print/${artworkId}.png`);
    const bytes = new Uint8Array(await (canonical?.arrayBuffer() ?? Promise.resolve(new ArrayBuffer(0))));
    expect(bytes.length).toBe(fresh.print.bytes);
    expect(bytes[0]).toBe(12);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("exit criteria", () => {
  it("a guest receipt cannot read another shop's order", async () => {
    const orderA = await buyProduct(world, shopA, teeA);
    await drain(orderA.orderId);
    const orderB = await buyProduct(world, shopB, mugB);

    const crossClaim = await claimReceipt(world, shopB, orderA.checkoutId);
    expect(crossClaim.status, "B's storefront cannot claim A's receipt").toBe(404);
    const opaque = await crossClaim.json();

    const tokenA = (
      await expectJson<{ receipt: { receiptToken: string } }>(
        await claimReceipt(world, shopA, orderA.checkoutId),
        200,
        "claim A",
      )
    ).receipt.receiptToken;
    const tokenB = (
      await expectJson<{ receipt: { receiptToken: string } }>(
        await claimReceipt(world, shopB, orderB.checkoutId),
        200,
        "claim B",
      )
    ).receipt.receiptToken;

    const denied: Array<[Tenant, string, string, string]> = [
      [shopB, orderA.orderId, tokenA, "A's order + A's token on B's storefront"],
      [shopA, orderA.orderId, tokenB, "A's order + B's token"],
      [shopB, orderB.orderId, tokenA, "B's order + A's token"],
      [shopA, orderB.orderId, tokenB, "B's order + B's token on A's storefront"],
    ];
    for (const [tenant, orderId, token, label] of denied) {
      const response = await readBuyerOrder(world, tenant, orderId, token);
      expect(response.status, label).toBe(404);
      expect(await response.json(), `${label}: the same opaque body`).toEqual(opaque);
    }
    expect((await readBuyerOrder(world, shopA, orderA.orderId, tokenA)).status).toBe(200);
    expect((await readBuyerOrder(world, shopB, orderB.orderId, tokenB)).status).toBe(200);
  });

  it("stranded work alerts within 30 minutes: nothing at +15 and +29 min, every kind by +31 (+46 for a 30-min-old unknown), once each", async () => {
    // Nothing left due from earlier tests may consume this tick's drain budget.
    for (let round = 0; round < 5; round += 1) {
      if ((await runOutboxSweep(world.env, Date.now())).processed === 0) {
        break;
      }
    }
    const t0 = Date.now();

    // (a) a paid order whose printer is down: dispatch never settles.
    const stuck = await buyProduct(world, shopA, teeA);
    const stuckDispatch = stuck.dispatchIds[0]!;
    const stuckJob = `${stuck.orderId}-1`;
    // (b) a refund Stripe keeps pending.
    const pending = await buyProduct(world, shopA, teeA);
    await drain(pending.orderId);
    world.stripe.refundStatus = "pending";
    const pendingRefund = await expectJson<{ refund: { refundId: string; state: string } }>(
      await refundCall(world, shopA, pending.orderId, 3_000),
      201,
      "pending refund",
    );
    expect(pendingRefund.refund.state).toBe("submitted");
    // (c) an intent Stripe charged whose success webhook never came, (d) and a
    //     refund of it that did (parked until the order exists — which never happens).
    const lost = await openCheckout(world, shopA, [{ productId: teeA, quantity: 1 }]);
    const lostIntent = await payCheckout(world, shopA, lost.checkoutId);
    markIntentSucceeded(world, lostIntent, t0);
    const orphanRefund = world.stripe.addDashboardRefund(lostIntent, 1_000);
    await postEvent("refund.created", { ...orphanRefund, object: "refund" }, { env: world.env });

    const tickEnv = world.with({
      PLATFORM_ALERT_EMAIL: "ops@platform.slice.test",
      ...printerWire((jobId) => (jobId === stuckJob ? "unreachable" : "deliver")),
    });
    const watched: Array<[string, string]> = [
      ["dispatch_stranded_30m", stuckDispatch],
      ["dispatch_unknown_30m", stuckDispatch],
      ["refund_unsettled_30m", pendingRefund.refund.refundId],
      ["order_missing_for_succeeded_pi", lostIntent],
      ["payment_event_deferred_30m", lostIntent],
    ];
    const raised = async () => {
      const kinds: string[] = [];
      for (const [kind, resourceId] of watched) {
        const rows = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM alerts WHERE kind = ? AND resource_id = ?",
        )
          .bind(kind, resourceId)
          .first<{ n: number }>();
        for (let index = 0; index < (rows?.n ?? 0); index += 1) {
          kinds.push(kind);
        }
      }
      return kinds.sort();
    };

    await cronTick(tickEnv, t0 + 15 * MINUTE_MS);
    expect(await outboxRow(stuckDispatch)).toMatchObject({ status: "unknown" });
    expect(await raised(), "+15 min").toEqual([]);
    await cronTick(tickEnv, t0 + 29 * MINUTE_MS);
    expect(await raised(), "+29 min").toEqual([]);

    world.emails.sent.length = 0;
    const tick31 = await cronTick(tickEnv, t0 + 31 * MINUTE_MS);
    expect(await raised(), "+31 min").toEqual([
      "dispatch_stranded_30m",
      "order_missing_for_succeeded_pi",
      "payment_event_deferred_30m",
      "refund_unsettled_30m",
    ]);
    // …and the same tick mails them to the platform (PLAN §2.2 "alerts (+ email)", D40).
    expect(tick31.digest.status).toBe("enqueued");
    const digest = world.emails.sent.find(
      (job): job is { digest: { kinds: Array<{ kind: string }> }; kind: string; recipient: string } =>
        (job as { kind?: string }).kind === "alert_digest",
    );
    expect(digest?.recipient).toBe("ops@platform.slice.test");
    expect(digest?.digest.kinds.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "dispatch_stranded_30m",
        "order_missing_for_succeeded_pi",
        "payment_event_deferred_30m",
        "refund_unsettled_30m",
      ]),
    );

    // The sweeper's own clock starts when the answer was first lost (+15).
    await cronTick(tickEnv, t0 + 46 * MINUTE_MS);
    expect(await raised(), "+46 min: once each, never duplicated").toEqual([
      "dispatch_stranded_30m",
      "dispatch_unknown_30m",
      "order_missing_for_succeeded_pi",
      "payment_event_deferred_30m",
      "refund_unsettled_30m",
    ]);
    expect(await printerJobs(stuck.orderId), "an unreachable printer has nothing").toHaveLength(0);
  });

  it("one accepted printer job per eligible order line, zero for pre-dispatch cancellations — over every order this file made", async () => {
    // Its own cases first, so the invariant is never vacuous (even run alone):
    // two eligible orders, one cancelled and one fully refunded before dispatch.
    for (let index = 0; index < 2; index += 1) {
      await drain((await buyProduct(world, shopA, teeA)).orderId);
    }
    const cancelled = await buyProduct(world, shopA, teeA);
    await expectJson(await cancelCall(world, shopA, cancelled.orderId), 200, "cancel before dispatch");
    const refunded = await buyProduct(world, shopA, teeA);
    await expectJson(await refundCall(world, shopA, refunded.orderId, refunded.totalMinor), 201, "full refund before dispatch");
    await runOutboxSweep(world.env, Date.now() + 60 * MINUTE_MS);

    const lines = await env.DB.prepare(
      `SELECT i.order_id, i.item_index, i.dispatch_state, o.status AS order_status,
              ob.status AS outbox_status, ob.submitted_at,
              (SELECT COUNT(*) FROM fake_printer_jobs AS j
                WHERE j.job_id = i.order_id || '-' || (i.item_index + 1)) AS jobs
       FROM order_items AS i
       JOIN orders AS o ON o.order_id = i.order_id
       LEFT JOIN outbox_events AS ob
         ON ob.event_type = 'dispatch' AND ob.aggregate_id = i.order_id
        AND json_extract(ob.payload_json, '$.lineNo') = i.item_index + 1
       WHERE i.production_json IS NOT NULL`,
    ).all<{
      dispatch_state: string | null;
      item_index: number;
      jobs: number;
      order_id: string;
      order_status: string;
      outbox_status: string | null;
      submitted_at: number | null;
    }>();

    let accepted = 0;
    let preDispatchCancelled = 0;
    for (const line of lines.results) {
      const label = `${line.order_id}-${line.item_index + 1} (${line.dispatch_state}/${line.outbox_status})`;
      expect(line.jobs, `${label}: never two jobs`).toBeLessThanOrEqual(1);
      if (line.dispatch_state === "accepted") {
        accepted += 1;
        expect(line.jobs, `${label}: accepted ⇒ exactly one job`).toBe(1);
      } else if (line.outbox_status === "superseded" && line.submitted_at === null) {
        preDispatchCancelled += 1;
        expect(line.jobs, `${label}: cancelled before dispatch ⇒ zero jobs`).toBe(0);
        expect(line.dispatch_state).toBe("cancelled");
      } else if (line.dispatch_state === "failed") {
        expect(line.jobs, `${label}: failed (never reached) ⇒ zero jobs`).toBe(0);
      } else {
        // Only the stranded test's line is left in flight, by design.
        expect(line.dispatch_state, label).toBe("unknown");
        expect(line.jobs).toBe(0);
      }
    }
    expect(accepted, "the invariant was exercised on accepted lines").toBeGreaterThanOrEqual(2);
    expect(preDispatchCancelled, "…and on pre-dispatch cancellations").toBeGreaterThanOrEqual(2);
    expect(await printerJobs(cancelled.orderId)).toHaveLength(0);
    expect(await printerJobs(refunded.orderId)).toHaveLength(0);
  });
});
