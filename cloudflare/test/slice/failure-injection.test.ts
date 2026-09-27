import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runReconciliation, runRetentionSweep } from "../../src/commerce/crons";
import { runClaimedOutboxRow } from "../../src/outbox/effects";
import { CLAIM_TTL_MS, claimById, newClaimToken } from "../../src/outbox/outbox";
import { runOutboxSweep } from "../../src/outbox/sweeper";
import { lineRow, outboxRow, printerJobs, recordingQueue } from "../dispatch-fixtures";
import { paymentEventRow, postEvent, refundOps } from "../money-fixtures";
import {
  ADMIN,
  acquireJob,
  adminOrder,
  approveProduct,
  artworkDetail,
  assertLedgerBalanced,
  bootstrapPlatform,
  buyProduct,
  call,
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
  PLATFORM,
  platformCall,
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
// CP2-E additions (CP2-D1 findings 2–5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The CP2-E cases stand 31+ minutes in the future to see alerts, and the
 * alerts they leave open are FUTURE-dated: the digest counts an open alert as
 * "new" until the wall clock passes it, so the exit criteria's own digest clock
 * (which starts at the real now) would see them at every tick. Resolved after
 * each such case — the cases assert their alerts before this runs.
 */
async function resolveFutureAlerts(): Promise<void> {
  await env.DB.prepare(
    "UPDATE alerts SET resolved_at = created_at WHERE resolved_at IS NULL AND created_at > ?",
  )
    .bind(new Date().toISOString())
    .run();
}

describe("4b. a refund retried after a lost response (Idempotency-Key)", () => {
  afterEach(resolveFutureAlerts);

  it("the admin never saw the answer and retries with the same key → the SAME operation; ONE refund at Stripe", async () => {
    const order = await buyProduct(world, shopA, teeA);
    await drain(order.orderId);
    const key = crypto.randomUUID();

    const first = await refundCall(world, shopA, order.orderId, 4_000, undefined, key);
    expect(first.status).toBe(201);
    await first.body?.cancel(); // lost on the way back
    const retry = await refundCall(world, shopA, order.orderId, 4_000, undefined, key);

    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    const ops = await refundOps(order.orderId);
    expect(ops).toHaveLength(1);
    expect(await retry.json()).toEqual({
      refund: { amountMinor: 4_000, refundId: ops[0]?.id, state: "succeeded" },
    });
    expect(world.stripe.refundCalls, "Stripe was asked once").toHaveLength(1);
    const ledger = await assertLedgerBalanced(env.DB, order.orderId, { stripe: world.stripe });
    expect(ledger.refundedMinor).toBe(4_000);
  });

  it("Stripe refunded, the worker died before the settlement, the admin retries → the held reservation (202), never a second refund", async () => {
    const order = await buyProduct(world, shopA, teeA);
    await drain(order.orderId);
    const key = crypto.randomUUID();
    const dying = dyingDb(
      () => world.stripe.refunds.size > 0,
      (op) => op.kind === "batch" && opWrites(op, /UPDATE refund_operations/),
    );

    expect(FAILED).toContain(
      await settle(refundCall(world, shopA, order.orderId, 5_000, world.with({ DB: dying.db }), key)),
    );
    const [op] = await refundOps(order.orderId);
    const retry = await refundCall(world, shopA, order.orderId, 5_000, undefined, key);
    expect(retry.status, "still reserved: Stripe's outcome is not recorded yet").toBe(202);
    expect(await retry.json()).toEqual({ refund: { amountMinor: 5_000, refundId: op?.id, state: "reserved" } });
    expect(world.stripe.refundCalls).toHaveLength(1);

    await runReconciliation(world.env, Date.now() + 31 * MINUTE_MS);
    const settled = await refundCall(world, shopA, order.orderId, 5_000, undefined, key);
    expect(await expectJson(settled, 201, "after reconciliation")).toEqual({
      refund: { amountMinor: 5_000, refundId: op?.id, state: "succeeded" },
    });
    expect(world.stripe.refundCalls).toHaveLength(1);
    await assertLedgerBalanced(env.DB, order.orderId, { stripe: world.stripe });
  });

  it("a double click (two requests, one key, at once) → one reservation, one Stripe refund, both answers name it", async () => {
    const order = await buyProduct(world, shopA, teeA);
    await drain(order.orderId);
    const key = crypto.randomUUID();

    const answers = await Promise.all([
      refundCall(world, shopA, order.orderId, 3_000, undefined, key),
      refundCall(world, shopA, order.orderId, 3_000, undefined, key),
    ]);

    expect(answers.map((response) => response.status).every((status) => status === 201 || status === 202)).toBe(true);
    const bodies = await Promise.all(answers.map((response) => response.json<{ refund: { refundId: string } }>()));
    const ops = await refundOps(order.orderId);
    expect(ops).toHaveLength(1);
    expect(bodies.map((body) => body.refund.refundId)).toEqual([ops[0]?.id, ops[0]?.id]);
    expect(world.stripe.refundCalls).toHaveLength(1);
    await assertLedgerBalanced(env.DB, order.orderId, { stripe: world.stripe });
  });

  it("a key reused for a different amount → 409; no key or a malformed one → 400; nothing reserved", async () => {
    const order = await buyProduct(world, shopA, teeA);
    await drain(order.orderId);
    const key = crypto.randomUUID();
    await expectJson(await refundCall(world, shopA, order.orderId, 2_000, undefined, key), 201, "first");

    expect(await expectJson(await refundCall(world, shopA, order.orderId, 2_500, undefined, key), 409, "other amount")).toEqual({
      error: { code: "conflict", message: "Idempotency key was already used for a different request" },
    });
    const badHeaders: Array<Record<string, string>> = [{}, { "idempotency-key": "not-a-uuid" }, { "idempotency-key": "" }];
    for (const headers of badHeaders) {
      const response = await call(world, "POST", `${ADMIN}/v1/admin/orders/${order.orderId}/refunds`, {
        body: { amountMinor: 1_000, reason: "Kunden ångrade köpet" },
        cookie: shopA.adminCookie,
        headers,
        shopId: shopA.tenantId,
      });
      expect(await expectJson(response, 400, JSON.stringify(headers))).toMatchObject({
        error: { code: "idempotency_key_required" },
      });
    }
    // The same UUID in another shop is another key (UNIQUE per tenant).
    const mug = await buyProduct(world, shopB, mugB);
    await expectJson(await refundCall(world, shopB, mug.orderId, 1_000, undefined, key), 201, "other shop, same key");
    expect(await refundOps(order.orderId)).toHaveLength(1);
    expect(world.stripe.refundCalls).toHaveLength(2);
    await assertLedgerBalanced(env.DB, order.orderId, { stripe: world.stripe });
  });
});

describe("the webhook nudges the outbox after its batch commits", () => {
  it("dispatch + email are nudged once the order exists; the batch dying nudges nothing; Stripe's retry nudges once", async () => {
    const checkout = await openCheckout(world, shopA, [{ productId: teeA, quantity: 1 }]);
    const paymentIntentId = await payCheckout(world, shopA, checkout.checkoutId);
    markIntentSucceeded(world, paymentIntentId);
    const object = {
      amount: checkout.totalMinor,
      currency: "sek",
      id: paymentIntentId,
      latest_charge: `ch_${paymentIntentId.replace(/^pi_/, "")}`,
      metadata: { checkout_id: checkout.checkoutId, tenant_id: shopA.tenantId },
      object: "payment_intent",
      status: "succeeded",
    };
    const dying = dyingDb(() => true, (op) => op.kind === "batch" && opWrites(op, /INSERT INTO orders\b/));

    const died = await settle(
      postEvent("payment_intent.succeeded", object, { env: world.with({ DB: dying.db }) }).then((r) => r.response),
    );
    expect(FAILED).toContain(died);
    expect(await ordersForCheckout(checkout.checkoutId)).toBe(0);
    expect(world.nudges.sent, "no order, no nudge").toEqual([]);

    const retried = await postEvent("payment_intent.succeeded", object, { env: world.env });
    expect(retried.response.status).toBe(200);
    const order = await env.DB.prepare("SELECT order_id FROM orders WHERE checkout_id = ?")
      .bind(checkout.checkoutId)
      .first<{ order_id: string }>();
    const rows = await outboxRowsFor(order?.order_id ?? "");
    expect(rows.map((row) => row.event_type)).toEqual(["dispatch", "email"]);
    expect(world.nudges.sent).toEqual(rows.map((row) => ({ outboxId: row.outbox_id })));

    // A replay of the event commits nothing and nudges nothing more.
    await postEvent("payment_intent.succeeded", object, { env: world.env, eventId: retried.eventId });
    expect(world.nudges.sent).toHaveLength(2);
    await drain(order?.order_id ?? "");
    expect(await printerJobs(order?.order_id ?? "")).toHaveLength(1);
  });

  it("the queue is down: the webhook still answers 200 with the order committed; the sweeper delivers it", async () => {
    const down = recordingQueue({ fail: true });
    const checkout = await openCheckout(world, shopB, [{ productId: mugB, quantity: 1 }]);
    const paymentIntentId = await payCheckout(world, shopB, checkout.checkoutId);
    const { orderId } = await succeedPayment(
      world,
      shopB,
      { checkoutId: checkout.checkoutId, paymentIntentId, totalMinor: checkout.totalMinor },
      { env: world.with({ OUTBOX_QUEUE: down.queue }) },
    );
    expect(orderId).not.toBeNull();
    expect(down.sent).toEqual([]);
    const [email] = await outboxRowsFor(orderId ?? "");
    expect(email).toMatchObject({ event_type: "email", status: "pending" });

    await runOutboxSweep(world.env, Date.now());
    expect((await outboxRowsFor(orderId ?? ""))[0]?.status).toBe("done");
  });
});

describe("resolved or moot dispatch is not stranded (reconciliation)", () => {
  afterEach(resolveFutureAlerts);

  it("a failure an operator resolved, and a line whose order was fully refunded, raise no dispatch_stranded_30m", async () => {
    // (a) never reached the printer → unknown → resolved FAILED by a human.
    const resolved = await buyProduct(world, shopA, teeA);
    const resolvedDispatch = resolved.dispatchIds[0]!;
    await deliverOutbox(world, [resolvedDispatch], world.with(printerWire(() => "unreachable")));
    await expectJson(
      await resolveCall(world, resolvedDispatch, { note: "Aldrig mottagen, kunden kontaktad", outcome: "failed" }),
      200,
      "resolve failed",
    );
    expect(await outboxRow(resolvedDispatch)).toMatchObject({ last_error: "resolved_failed", status: "failed" });

    // (b) unknown at the printer, then the whole order refunded.
    const refunded = await buyProduct(world, shopA, teeA);
    const refundedDispatch = refunded.dispatchIds[0]!;
    await deliverOutbox(world, [refundedDispatch], world.with(printerWire(() => "unreachable")));
    await expectJson(await refundCall(world, shopA, refunded.orderId, refunded.totalMinor), 201, "full refund");
    expect((await adminOrder(world, shopA, refunded.orderId)).status).toBe("refunded");

    // (c) the control: a paid order whose printer is still unreachable IS stranded.
    const stuck = await buyProduct(world, shopA, teeA);
    const stuckDispatch = stuck.dispatchIds[0]!;
    await deliverOutbox(world, [stuckDispatch], world.with(printerWire(() => "unreachable")));

    // Twice: a resolved failure is never re-raised, however often it is seen.
    await runReconciliation(world.env, Date.now() + 31 * MINUTE_MS);
    await runReconciliation(world.env, Date.now() + 32 * MINUTE_MS);
    const stranded = async (resourceId: string) =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM alerts WHERE kind = 'dispatch_stranded_30m' AND resource_id = ?",
        )
          .bind(resourceId)
          .first<{ n: number }>()
      )?.n ?? 0;
    expect(await stranded(resolvedDispatch), "resolved by a human").toBe(0);
    expect(await stranded(refundedDispatch), "nothing owed to the printer").toBe(0);
    expect(await stranded(stuckDispatch), "the control still alerts, once").toBe(1);
  });
});

describe("platform reads: orders and alerts (what reconcile-staging.mjs reads)", () => {
  afterEach(resolveFutureAlerts);

  interface PlatformOrder {
    createdAt: string;
    dispatch: Array<{ lineNo: number | null; outboxId: string; state: string }>;
    isPersonalized: boolean;
    money: { applicationFeeMinor: number; chargedMinor: number; refundedMinor: number; withheldMinor: number };
    orderId: string;
    paymentIntentId: string;
    payout: { amountMinor: number };
    production: { printer: string | null; productionCostMinor: number | null } | null;
    tenantId: string;
  }

  async function allOrders(tenantId: string, extra = ""): Promise<PlatformOrder[]> {
    const all: PlatformOrder[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const qs = `tenantId=${tenantId}&limit=2${extra}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const body: { nextCursor: string | null; orders: PlatformOrder[] } = await expectJson(
        await platformCall(world, "GET", `/v1/platform/orders?${qs}`),
        200,
        "platform orders",
      );
      all.push(...body.orders);
      cursor = body.nextCursor;
      if (cursor === null) {
        return all;
      }
    }
    throw new Error("the order list never ended");
  }

  it("GET /v1/platform/orders pages a shop's orders to exhaustion, with the money facts, the intent and the dispatch states", async () => {
    const made = [
      await buyProduct(world, shopB, mugB),
      await buyProduct(world, shopB, mugB),
      await buyProduct(world, shopB, mugB),
    ];
    const listed = await allOrders(shopB.tenantId);
    const mine = listed.filter((order) => made.some((m) => m.orderId === order.orderId));
    expect(mine.map((order) => order.orderId)).toEqual(made.map((m) => m.orderId));
    expect(new Set(listed.map((order) => order.orderId)).size, "no page repeats a row").toBe(listed.length);
    expect(listed.every((order) => order.tenantId === shopB.tenantId)).toBe(true);
    const first = mine[0]!;
    expect(first).toMatchObject({
      dispatch: [],
      isPersonalized: false,
      money: { chargedMinor: made[0]!.totalMinor, refundedMinor: 0, withheldMinor: 0 },
      paymentIntentId: made[0]!.paymentIntentId,
      production: null,
    });
    const since = await allOrders(shopB.tenantId, `&since=${encodeURIComponent(mine[2]!.createdAt)}`);
    expect(since.map((order) => order.orderId)).toContain(made[2]!.orderId);
    expect(since.every((order) => order.createdAt >= mine[2]!.createdAt)).toBe(true);

    // A POD order: platform-only production facts and the dispatch state machine.
    const tee = await buyProduct(world, shopA, teeA);
    await drain(tee.orderId);
    const pod = (await allOrders(shopA.tenantId)).find((order) => order.orderId === tee.orderId);
    expect(pod).toMatchObject({
      dispatch: [{ lineNo: 1, outboxId: tee.dispatchIds[0], state: "done" }],
      production: { printer: "fake-printer", productionCostMinor: expect.any(Number) },
    });
    expect(pod?.money.withheldMinor).toBeGreaterThan(0);
    const ledger = await assertLedgerBalanced(env.DB, tee.orderId, { stripe: world.stripe });
    expect(pod?.payout.amountMinor).toBe(ledger.payoutMinor);
  });

  it("the orders list is platform-only and strict about its query", async () => {
    const asAdmin = await call(world, "GET", `${ADMIN}/v1/platform/orders?tenantId=${shopA.tenantId}`, {
      cookie: shopA.adminCookie,
    });
    expect(asAdmin.status).toBe(404);
    expect((await call(world, "GET", `${PLATFORM}/v1/platform/orders?tenantId=${shopA.tenantId}`)).status).toBe(404);
    for (const qs of ["", "tenantId=Bad_Id", `tenantId=${shopA.tenantId}&limit=101`, `tenantId=${shopA.tenantId}&since=yesterday`, `tenantId=${shopA.tenantId}&cursor=x`, `tenantId=${shopA.tenantId}&email=a`]) {
      expect((await platformCall(world, "GET", `/v1/platform/orders?${qs}`)).status, qs).toBe(400);
    }
    expect((await platformCall(world, "POST", `/v1/platform/orders?tenantId=${shopA.tenantId}`, {})).status).toBe(404);
  });

  it("GET /v1/platform/alerts + POST …/resolve: an audited, final resolution; a still-true condition raises a fresh alert", async () => {
    const stuck = await buyProduct(world, shopA, teeA);
    const dispatchId = stuck.dispatchIds[0]!;
    await deliverOutbox(world, [dispatchId], world.with(printerWire(() => "unreachable")));
    await runReconciliation(world.env, Date.now() + 31 * MINUTE_MS);

    const open: Array<{ alertId: string; kind: string; resolution: unknown; resourceId: string | null }> = [];
    let cursor: string | null = null;
    do {
      const body: { alerts: typeof open; nextCursor: string | null } = await expectJson(
        await platformCall(
          world,
          "GET",
          `/v1/platform/alerts?state=open&kind=dispatch_stranded_30m&tenantId=${shopA.tenantId}&limit=1${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        ),
        200,
        "open alerts",
      );
      open.push(...body.alerts);
      cursor = body.nextCursor;
    } while (cursor !== null);
    const alert = open.find((entry) => entry.resourceId === dispatchId);
    expect(alert).toMatchObject({ kind: "dispatch_stranded_30m", resolution: null });

    const resolved = await expectJson<{ alert: { resolution: { at: string; byUserId: string; note: string } } }>(
      await platformCall(world, "POST", `/v1/platform/alerts/${encodeURIComponent(alert?.alertId ?? "")}/resolve`, {
        note: "Skrivaren nere, SnapWear kontaktad",
      }),
      200,
      "resolve",
    );
    expect(resolved.alert.resolution).toEqual({
      at: expect.any(String),
      byUserId: world.platformUserId,
      note: "Skrivaren nere, SnapWear kontaktad",
    });
    const again = await platformCall(world, "POST", `/v1/platform/alerts/${encodeURIComponent(alert?.alertId ?? "")}/resolve`, {
      note: "igen",
    });
    expect(again.status, "resolution is final").toBe(409);
    const audit = await env.DB.prepare(
      "SELECT actor_user_id, reason FROM audit_events WHERE action = 'alert.resolve' AND resource_id = ?",
    )
      .bind(alert?.alertId ?? "")
      .all();
    expect(audit.results).toEqual([{ actor_user_id: world.platformUserId, reason: "Skrivaren nere, SnapWear kontaktad" }]);

    const resolvedList = await expectJson<{ alerts: Array<{ alertId: string }> }>(
      await platformCall(world, "GET", `/v1/platform/alerts?state=resolved&tenantId=${shopA.tenantId}&limit=100`),
      200,
      "resolved alerts",
    );
    expect(resolvedList.alerts.map((entry) => entry.alertId)).toContain(alert?.alertId);

    // The printer is still down: the next run raises a FRESH alert for it.
    await runReconciliation(world.env, Date.now() + 32 * MINUTE_MS);
    const fresh = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM alerts WHERE kind = 'dispatch_stranded_30m' AND resource_id = ? AND resolved_at IS NULL",
    )
      .bind(dispatchId)
      .first<{ n: number }>();
    expect(fresh?.n).toBe(1);

    // Refusals: unknown id, cross-origin, a shop admin, a bad body, a bad query.
    expect((await platformCall(world, "POST", "/v1/platform/alerts/no-such-alert/resolve", { note: "x" })).status).toBe(404);
    const crossOrigin = await call(world, "POST", `${PLATFORM}/v1/platform/alerts/${encodeURIComponent(alert?.alertId ?? "")}/resolve`, {
      body: { note: "x" },
      cookie: world.platformCookie,
      origin: "https://evil.test",
    });
    expect(crossOrigin.status).toBe(404);
    const asAdmin = await call(world, "GET", `${ADMIN}/v1/platform/alerts`, { cookie: shopA.adminCookie });
    expect(asAdmin.status).toBe(404);
    expect((await platformCall(world, "POST", "/v1/platform/alerts/x/resolve", { note: "" })).status).toBe(400);
    expect((await platformCall(world, "GET", "/v1/platform/alerts?state=closed")).status).toBe(400);
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
