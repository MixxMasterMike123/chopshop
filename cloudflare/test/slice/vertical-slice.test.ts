import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { runReconciliation, runRetentionSweep } from "../../src/commerce/crons";
import { postEvent } from "../money-fixtures";
import { lineRow, outboxRow, printerJobs } from "../dispatch-fixtures";
import { expectNoCostKeys, TEE_S } from "../pod-fixtures";
import {
  acceptPlatformTerms,
  adminOrder,
  approveProduct,
  assertLedgerBalanced,
  bootstrapPlatform,
  claimReceipt,
  completeJob,
  completionBody,
  createArtwork,
  createPodProduct,
  createTenant,
  DAY_MS,
  deliverEmails,
  deliverOutbox,
  expectJson,
  FakeResend,
  instrumentedDb,
  keysOf,
  numbersOf,
  openCheckout,
  opWrites,
  outboxRowsFor,
  payCheckout,
  pngBytes,
  type PrinterLog,
  printerWire,
  publishProduct,
  readBuyerOrder,
  refundCall,
  seedPrintShop,
  SLICE_RECIPIENT,
  SliceWorld,
  storefrontCall,
  succeedPayment,
  termsStatus,
  uploadOriginal,
  uploadOutputs,
  acquireJob,
  artworkDetail,
} from "../slice-harness";

/**
 * PLAN §10 CP2 — THE vertical slice, as ONE end-to-end test through the real
 * routes, in order. Every money step is followed by assertLedgerBalanced
 * (order columns ↔ refund_operations ↔ the fake Stripe's own record).
 *
 * Third parties are fakes behind their production seams (Stripe, the render
 * farm's side of /v1/render, the fake printer's in-process transport, Resend);
 * queues are recorded and delivered to the real consumers explicitly.
 */

const TENANT_ID = "slice-melodie";
const HOST = "melodie.slice.test";
const SHOP_NAME = "Melodie Slice Åre";
const COMMISSION_BPS = 800;
const PRICE_MINOR = 39_900;

/** Keys that must never reach a buyer's or a seller's body (the one-number rule, A-13). */
const DENIED = [
  "withh",
  "commission",
  "production",
  "cost",
  "printer",
  "snapshot",
  "connect",
  "transfer",
  "stripe",
  "applicationfee",
  "application_fee",
  "sku",
  "r2key",
  "tier",
];

function expectNoDeniedKeys(body: unknown, label: string): void {
  for (const key of keysOf(body)) {
    const lowered = key.toLowerCase();
    expect(DENIED.find((part) => lowered.includes(part)), `${label}: key ${key}`).toBeUndefined();
  }
}

describe("CP2 vertical slice", () => {
  it(
    "artwork → render → mapping → quote → publish → PDP → checkout → PaymentIntent → webhook → dispatch → receipt → refunds → cancellation → retention → reconciliation",
    async () => {
      const world = new SliceWorld();

      // ── 1. platform bootstrap ───────────────────────────────────────────
      await bootstrapPlatform(world);
      expect(world.platformCookie).not.toBe("");

      // ── 2. tenant + Connect account (charges + payouts enabled) ─────────
      // The admin does NOT accept the platform terms yet: step 12a proves the gate.
      const tenant = await createTenant(world, {
        acceptTerms: false,
        commissionBps: COMMISSION_BPS,
        host: HOST,
        shopName: SHOP_NAME,
        tenantId: TENANT_ID,
      });
      const connect = await env.DB.prepare(
        `SELECT stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled
         FROM tenants WHERE tenant_id = ?`,
      )
        .bind(TENANT_ID)
        .first();
      expect(connect).toEqual({
        stripe_account_id: tenant.accountId,
        stripe_charges_enabled: 1,
        stripe_payouts_enabled: 1,
      });

      // ── 3. printers + 4. profiles ───────────────────────────────────────
      await seedPrintShop(world);

      // ── 5. artwork upload: reserve + Worker-streamed content ────────────
      const objectId = await uploadOriginal(world, tenant, pngBytes(1));

      // ── 6. artwork create: 202, processing, one queued job ──────────────
      const artworkId = await createArtwork(world, tenant, objectId);
      const queued = await env.DB.prepare(
        "SELECT id, state, attempt FROM render_jobs WHERE artwork_id = ?",
      )
        .bind(artworkId)
        .all<{ attempt: number; id: string; state: string }>();
      expect(queued.results).toEqual([{ attempt: 0, id: expect.any(String), state: "queued" }]);
      expect(world.renders.sent).toEqual([{ renderJobId: queued.results[0]?.id }]);

      // ── 7. render job: acquire → outputs → complete ─────────────────────
      const lease = await acquireJob(world);
      expect(lease).not.toBeNull();
      if (lease === null) {
        return;
      }
      expect(lease).toMatchObject({ attempt: 1, jobId: queued.results[0]?.id });
      const outputs = await uploadOutputs(lease, 42);
      await expectJson(await completeJob(world, lease.jobId, completionBody(lease, outputs)), 200, "complete");
      const detail = await artworkDetail(world, tenant, artworkId);
      expect(detail.artwork).toMatchObject({ printSha256: outputs.print.sha256, status: "ready" });
      const canonicalPrint = await env.PRIVATE_BUCKET.head(`pod/${TENANT_ID}/print/${artworkId}.png`);
      expect(canonicalPrint?.size).toBe(outputs.print.bytes);

      // ── 8. mapping + 9. quote: ONE number (plus the floor) ──────────────
      const { productId, quote } = await createPodProduct(world, tenant, {
        artworkId,
        name: "Slice-tröja",
        priceMinor: PRICE_MINOR,
        sku: "SLICE-TEE-1",
      });
      expect(Object.keys(quote).sort()).toEqual(["currency", "inkopMinor", "priceFloorMinor"]);
      expect(quote.currency).toBe("SEK");
      expect(quote.inkopMinor).toBeGreaterThan(0);
      expect(quote.priceFloorMinor).toBeGreaterThan(quote.inkopMinor);
      expect(quote.priceFloorMinor).toBeLessThanOrEqual(PRICE_MINOR);
      expectNoCostKeys(quote);

      // ── 10. publish: the shop's first product waits for the platform ───
      const published = await publishProduct(world, tenant, productId);
      expect(published.product.screeningStatus).toBe("pending");
      const hidden = await storefrontCall(world, tenant, "GET", `/v1/products/${productId}`);
      expect(hidden.status, "a pending product is not public").toBe(404);
      await hidden.body?.cancel();
      const approved = await approveProduct(world, productId);
      expect(approved.screening.status).toBe("approved");

      // ── 11. storefront PDP (ETag / 304) ─────────────────────────────────
      const pdp = await storefrontCall(world, tenant, "GET", `/v1/products/${productId}`);
      const etag = pdp.headers.get("etag");
      const pdpBody = await expectJson<{ product: { pod: unknown; priceMinor?: number } }>(pdp, 200, "PDP");
      expect(etag).toMatch(/^"\d+"$/);
      expect(pdpBody.product.pod).toMatchObject({
        printAreas: [expect.objectContaining({ slot: "front" })],
        previewUrls: [`/v1/storefront/pod-previews/${productId}/${artworkId}`],
      });
      expectNoCostKeys(pdpBody);
      const revalidated = await storefrontCall(world, tenant, "GET", `/v1/products/${productId}`, {
        headers: { "if-none-match": etag ?? "" },
      });
      expect(revalidated.status).toBe(304);

      // ── 12a. THE LEGAL GATE: no checkout before the seller accepts the terms.
      // The shop is legally READY (the harness made it so), which makes the
      // terms gate the only thing between this shop and a checkout.
      const legallyReady = {
        legalPagesAccepted: true,
        ready: true,
        returnAddress: true,
        vatAnswered: true,
      };
      expect(await termsStatus(world, tenant)).toEqual({
        accepted: false,
        acceptedAt: null,
        acceptedVersion: null,
        currentVersion: "2026-09-07",
        graceDeadline: null,
        inGrace: false,
        readiness: legallyReady,
      });
      const gated = await storefrontCall(world, tenant, "POST", "/v1/checkout", {
        body: {
          consent: { terms: true },
          deliveryMethod: "pickup",
          email: "early@buyers.slice.test",
          idempotencyKey: "idem-slice-gated",
          items: [{ productId, quantity: 1 }],
          recipient: SLICE_RECIPIENT,
        },
        origin: null,
      });
      expect(await expectJson(gated, 404, "gated checkout"), "the same answer as an unknown shop").toEqual({
        error: { code: "not_found", message: "Checkout not found" },
      });
      const noCheckout = await env.DB.prepare("SELECT COUNT(*) AS n FROM checkouts WHERE tenant_id = ?")
        .bind(TENANT_ID)
        .first<{ n: number }>();
      expect(noCheckout?.n, "a gated shop writes nothing").toBe(0);
      const acceptedAt = await acceptPlatformTerms(world, tenant);
      expect(await termsStatus(world, tenant)).toEqual({
        accepted: true,
        acceptedAt,
        acceptedVersion: "2026-09-07",
        currentVersion: "2026-09-07",
        graceDeadline: null,
        inGrace: false,
        readiness: legallyReady,
      });
      const evidence = await env.DB.prepare(
        `SELECT user_id, terms_version, accepted_at, ip, evidence_json
         FROM platform_terms_acceptances WHERE tenant_id = ?`,
      )
        .bind(TENANT_ID)
        .all<{ accepted_at: string; evidence_json: string; ip: string | null; terms_version: string; user_id: string }>();
      expect(evidence.results).toEqual([
        {
          accepted_at: acceptedAt,
          evidence_json: expect.stringContaining('"termsSha256":"ca1f708f'),
          ip: expect.stringMatching(/^203\.0\./),
          terms_version: "2026-09-07",
          user_id: tenant.adminUserId,
        },
      ]);

      // ── 12. checkout (pickup): the production snapshot is frozen ────────
      // The buyer ticks the terms and (separately) marketing. The POD tee is a
      // CATALOGUE product (the seller's own design), so no waiver is asked for
      // and the full right of withdrawal stays (the legal firewall).
      const buyerEmail = "kund@buyers.slice.test";
      const checkout = await openCheckout(world, tenant, [{ productId, quantity: 1 }], {
        consent: { marketing: true, terms: true },
        email: buyerEmail,
      });
      expect(checkout).toMatchObject({ deliveryMethod: "pickup", totalMinor: PRICE_MINOR });
      const frozen = await env.DB.prepare(
        "SELECT production_snapshot_json, consent_json FROM checkouts WHERE checkout_id = ?",
      )
        .bind(checkout.checkoutId)
        .first<{ consent_json: string; production_snapshot_json: string }>();
      expect(JSON.parse(frozen?.consent_json ?? "null")).toEqual({
        marketing: true,
        recordedAt: expect.any(String),
        terms: true,
        v: 1,
        withdrawal: { disclosureSha256: null, disclosureVersion: null, personalizedItems: [], waived: false },
      });
      const snapshot = JSON.parse(frozen?.production_snapshot_json ?? "null") as {
        lines: Array<{ lineNo: number; printFiles: Array<{ r2Key: string; sha256: string; slot: string }>; quantity: number; sku: string }>;
        printer: string;
        totals: { withholdMinor: number };
      };
      expect(snapshot.printer).toBe("fake-printer");
      expect(snapshot.lines).toEqual([
        expect.objectContaining({
          lineNo: 1,
          printFiles: [
            expect.objectContaining({
              r2Key: `pod/${TENANT_ID}/print/${artworkId}.png`,
              sha256: outputs.print.sha256,
              slot: "front",
            }),
          ],
          quantity: 1,
          sku: TEE_S,
        }),
      ]);
      const withheld = snapshot.totals.withholdMinor;
      const commission = Math.floor((PRICE_MINOR * COMMISSION_BPS) / 10_000);
      const fee = commission + withheld;
      expect(withheld).toBeGreaterThan(0);
      expect(fee).toBeLessThan(PRICE_MINOR);

      // ── 13. PaymentIntent: destination charge, fee, descriptor ──────────
      const paymentIntentId = await payCheckout(world, tenant, checkout.checkoutId);
      expect(world.stripe.createCalls).toHaveLength(1);
      expect(world.stripe.createCalls[0]).toEqual({
        amount: PRICE_MINOR,
        applicationFeeAmount: fee,
        currency: "sek",
        idempotencyKey: expect.any(String),
        metadata: { checkout_id: checkout.checkoutId, tenant_id: TENANT_ID },
        onBehalfOf: null,
        statementDescriptorSuffix: "MELODIE SLIC",
        transferDestination: tenant.accountId,
      });
      const attached = await env.DB.prepare(
        `SELECT payment_intent_id, connect_account_id, application_fee_minor, withheld_minor
         FROM checkouts WHERE checkout_id = ?`,
      )
        .bind(checkout.checkoutId)
        .first();
      expect(attached).toEqual({
        application_fee_minor: fee,
        connect_account_id: tenant.accountId,
        payment_intent_id: paymentIntentId,
        withheld_minor: withheld,
      });

      // ── 14. the signed webhook: order + lines + snapshot + outbox, ONE batch
      const recorder = instrumentedDb(() => undefined);
      const { orderId } = await succeedPayment(
        world,
        tenant,
        { checkoutId: checkout.checkoutId, paymentIntentId, totalMinor: PRICE_MINOR },
        { env: world.with({ DB: recorder.db }) },
      );
      expect(orderId).not.toBeNull();
      if (orderId === null) {
        return;
      }
      const orderBatches = recorder.ops.filter(
        (op) => op.kind === "batch" && opWrites(op, /INSERT INTO orders\b/),
      );
      expect(orderBatches, "exactly one batch wrote the order").toHaveLength(1);
      const orderBatch = orderBatches[0]!;
      const count = (pattern: RegExp) => orderBatch.sql.filter((sql) => pattern.test(sql)).length;
      expect(count(/INSERT INTO order_items\b/), "the line").toBe(1);
      expect(count(/INSERT INTO outbox_events\b/), "dispatch + email").toBe(2);
      expect(count(/INSERT INTO order_receipt_handoffs\b/), "the receipt capability").toBe(1);
      expect(count(/INSERT INTO payment_events\b/), "the event ledger").toBe(1);
      expect(count(/UPDATE checkouts\b/), "the checkout spent").toBe(1);
      expect(
        recorder.ops.filter(
          (op) => op !== orderBatch && opWrites(op, /INSERT INTO (orders|order_items|outbox_events)\b/),
        ),
        "nothing else wrote an order, a line or an outbox row",
      ).toHaveLength(0);

      const order = await env.DB.prepare(
        `SELECT status, charged_minor, application_fee_minor, withheld_minor, connect_account_id,
                production_snapshot_json, payout_state, consent_json, is_personalized
         FROM orders WHERE order_id = ?`,
      )
        .bind(orderId)
        .first<Record<string, unknown>>();
      expect(order).toEqual({
        application_fee_minor: fee,
        charged_minor: PRICE_MINOR,
        connect_account_id: tenant.accountId,
        // The consent, copied in the order batch (CP2-E).
        consent_json: frozen?.consent_json,
        is_personalized: 0,
        payout_state: "pending",
        production_snapshot_json: frozen?.production_snapshot_json,
        status: "paid",
        withheld_minor: withheld,
      });
      const line = await env.DB.prepare("SELECT production_json FROM order_items WHERE order_id = ?")
        .bind(orderId)
        .first<{ production_json: string }>();
      expect(JSON.parse(line?.production_json ?? "null")).toEqual(snapshot.lines[0]);
      const outbox = await outboxRowsFor(orderId);
      expect(outbox.map((row) => [row.event_type, row.status])).toEqual([
        ["dispatch", "pending"],
        ["email", "pending"],
      ]);
      const dispatchId = outbox[0]!.outbox_id;
      const emailId = outbox[1]!.outbox_id;
      // The webhook nudged both rows once the batch committed (CP2-E): the
      // printer hears within seconds, not at the next 15-minute sweep.
      expect(world.nudges.sent).toEqual(
        expect.arrayContaining([{ outboxId: dispatchId }, { outboxId: emailId }]),
      );
      expect(JSON.parse((await outboxRow(dispatchId)).payload_json)).toEqual({
        jobId: `${orderId}-1`,
        lineNo: 1,
        orderId,
      });
      let ledger = await assertLedgerBalanced(env.DB, orderId, { stripe: world.stripe });
      expect(ledger).toMatchObject({ chargedMinor: PRICE_MINOR, feeMinor: fee, payoutMinor: PRICE_MINOR - fee });

      // ── 15. outbox consumer → 16. the fake printer accepted ONE job ─────
      const wire: PrinterLog = [];
      const delivered = await deliverOutbox(
        world,
        [dispatchId, emailId],
        world.with(printerWire(() => "deliver", undefined, wire)),
      );
      expect(delivered).toEqual({ acks: ["m0", "m1"], retries: [] });
      expect(wire, "one submission on the printer's wire").toEqual([{ fault: "deliver", jobId: `${orderId}-1` }]);
      const jobs = await printerJobs(orderId);
      expect(jobs.map((job) => job.job_id)).toEqual([`${orderId}-1`]);
      const submitted = JSON.parse(jobs[0]!.payload_json) as {
        artworks: Array<{ url: string }>;
        items: Array<{ quantity: number; sku: string }>;
        layouts: Array<{ location: string }>;
      };
      expect(submitted.items).toEqual([{ quantity: 1, sku: TEE_S }]);
      expect(submitted.layouts).toEqual([{ location: "front" }]);
      expect(submitted.artworks[0]?.url).toContain(`/pod/${TENANT_ID}/print/${artworkId}.png`);
      expect(await lineRow(orderId)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: jobs[0]!.id });
      expect(await outboxRow(dispatchId)).toMatchObject({ result_ref: jobs[0]!.id, status: "done" });

      // The order confirmation, through the real -email consumer: ONE email.
      const resend = new FakeResend();
      await deliverEmails(world, resend);
      expect(resend.delivered.size).toBe(1);
      const email = [...resend.delivered.values()][0]!;
      expect(email.payload.to).toEqual([buyerEmail]);
      expect(email.payload.subject).toMatch(/^Orderbekräftelse /);

      // ── 17. receipt hand-off (once) + the buyer's allowlisted read ──────
      const claimed = await expectJson<{ receipt: { orderId: string; receiptToken: string; status: string } }>(
        await claimReceipt(world, tenant, checkout.checkoutId),
        200,
        "receipt claim",
      );
      expect(claimed.receipt).toMatchObject({ orderId, status: "ready" });
      const again = await expectJson<{ receipt: unknown }>(
        await claimReceipt(world, tenant, checkout.checkoutId),
        200,
        "receipt claim again",
      );
      expect(again.receipt).toEqual({ status: "issued" });
      const buyer = await expectJson<{ order: Record<string, unknown> }>(
        await readBuyerOrder(world, tenant, orderId, claimed.receipt.receiptToken),
        200,
        "buyer read",
      );
      expect(Object.keys(buyer.order).sort()).toEqual([
        "createdAt",
        "currency",
        "delivery",
        "email",
        "items",
        "orderId",
        "orderNumber",
        "recipient",
        "status",
        "totals",
        "withdrawal",
      ]);
      expect(buyer.order).toMatchObject({
        delivery: { country: null, method: "pickup" },
        // D98: the harness's default recipient, collected at the shop's place.
        recipient: { deliveryMethod: "pickup", name: SLICE_RECIPIENT.name, pickupLocationId: SLICE_RECIPIENT.pickupLocationId },
        email: "k***@buyers.slice.test",
        items: [{ lineTotalMinor: PRICE_MINOR, name: "Slice-tröja", quantity: 1, unitPriceMinor: PRICE_MINOR }],
        status: "paid",
        // A catalogue POD product: the 14-day right of withdrawal applies.
        withdrawal: { waived: false },
      });
      expectNoDeniedKeys(buyer, "buyer read");
      expect(numbersOf(buyer)).not.toContain(fee);
      expect(numbersOf(buyer)).not.toContain(withheld);

      // ── 18. admin order read: the seller sees ONE fee figure ────────────
      const read = await adminOrder(world, tenant, orderId);
      expect(read.money).toEqual({
        chargedMinor: PRICE_MINOR,
        dispute: null,
        feeMinor: fee,
        refundableMinor: PRICE_MINOR,
        refundedMinor: 0,
        refundPendingMinor: 0,
      });
      expect(read.payout).toMatchObject({ amountMinor: PRICE_MINOR - fee, state: "pending" });
      // …and what the buyer consented to (CP2-E): terms, marketing separately, no waiver.
      expect(read.consent).toEqual({
        marketing: true,
        recordedAt: expect.any(String),
        terms: true,
        withdrawal: { disclosureVersion: null, personalizedItems: [], waived: false },
      });
      expect(read.withdrawal).toEqual({ waived: false });
      expectNoDeniedKeys(read, "admin read");
      expect(numbersOf(read), "neither half of the fee is shown").not.toContain(withheld);
      expect(numbersOf(read)).not.toContain(commission);
      await assertLedgerBalanced(env.DB, orderId, { payoutMinor: read.payout.amountMinor, stripe: world.stripe });

      // ── 19. partial refund, reserve-first; Stripe says "pending" ────────
      const PARTIAL = 10_000;
      world.stripe.refundStatus = "pending";
      const partialKey = crypto.randomUUID();
      const partial = await expectJson<{ refund: { refundId: string; state: string } }>(
        await refundCall(world, tenant, orderId, PARTIAL, undefined, partialKey),
        201,
        "partial refund",
      );
      expect(partial.refund.state).toBe("submitted");
      // The admin's retry with the same Idempotency-Key (CP2-E) is the SAME
      // operation: no second reservation, no second call to Stripe.
      const retried = await refundCall(world, tenant, orderId, PARTIAL, undefined, partialKey);
      expect(retried.headers.get("idempotent-replayed")).toBe("true");
      expect((await expectJson<{ refund: { refundId: string } }>(retried, 201, "refund retry")).refund.refundId).toBe(
        partial.refund.refundId,
      );
      expect(world.stripe.refundCalls).toEqual([
        expect.objectContaining({
          amount: PARTIAL,
          idempotencyKey: partial.refund.refundId,
          refundApplicationFee: false,
          reverseTransfer: true,
        }),
      ]);
      ledger = await assertLedgerBalanced(env.DB, orderId, { stripe: world.stripe });
      expect(ledger).toMatchObject({ refundedMinor: 0, refundHeldMinor: PARTIAL });
      expect((await adminOrder(world, tenant, orderId)).money).toMatchObject({
        refundableMinor: PRICE_MINOR - PARTIAL,
        refundPendingMinor: PARTIAL,
      });

      // ── 20. the settlement webhook (refund.updated → succeeded) ─────────
      const op = await env.DB.prepare("SELECT stripe_refund_id FROM refund_operations WHERE id = ?")
        .bind(partial.refund.refundId)
        .first<{ stripe_refund_id: string }>();
      const settled = world.stripe.setRefundStatus(op?.stripe_refund_id ?? "", "succeeded");
      const settlement = await postEvent("refund.updated", { ...settled, object: "refund" }, { env: world.env });
      expect(settlement.response.status).toBe(200);
      // A replay of the same event moves nothing.
      await postEvent("refund.updated", { ...settled, object: "refund" }, { env: world.env, eventId: settlement.eventId });
      ledger = await assertLedgerBalanced(env.DB, orderId, { stripe: world.stripe });
      expect(ledger).toMatchObject({ refundedMinor: PARTIAL, refundHeldMinor: 0 });

      // ── 21. payout facts ────────────────────────────────────────────────
      const afterPartial = await adminOrder(world, tenant, orderId);
      expect(afterPartial.status).toBe("partially_refunded");
      expect(afterPartial.payout).toMatchObject({ amountMinor: PRICE_MINOR - PARTIAL - fee, state: "pending" });
      await assertLedgerBalanced(env.DB, orderId, { payoutMinor: afterPartial.payout.amountMinor, stripe: world.stripe });

      // ── 22. full refund of the rest → the accepted job gets a printer cancellation
      world.stripe.refundStatus = "succeeded";
      const rest = PRICE_MINOR - PARTIAL;
      const full = await expectJson<{ refund: { state: string } }>(
        await refundCall(world, tenant, orderId, rest),
        201,
        "full refund",
      );
      expect(full.refund.state).toBe("succeeded");
      const afterFull = await adminOrder(world, tenant, orderId);
      expect(afterFull.status).toBe("refunded");
      // D9: the fee is not refunded, so the shop owes it (PLAN D9; D36 covers only pre-production).
      expect(afterFull.payout.amountMinor).toBe(-fee);
      await assertLedgerBalanced(env.DB, orderId, { payoutMinor: afterFull.payout.amountMinor, stripe: world.stripe });

      // ── 23. dispatch cancellation: the job was already accepted (§2.3 path 3)
      const cancellations = (await outboxRowsFor(orderId)).filter((row) => row.event_type === "printer_cancellation");
      expect(cancellations).toHaveLength(1);
      expect(world.nudges.sent).toContainEqual({ outboxId: cancellations[0]!.outbox_id });
      await deliverOutbox(world, [cancellations[0]!.outbox_id]);
      expect((await outboxRow(cancellations[0]!.outbox_id)).status).toBe("done");
      const openNow = await env.DB.prepare(
        "SELECT kind FROM alerts WHERE resolved_at IS NULL ORDER BY kind",
      ).all<{ kind: string }>();
      expect(openNow.results.map((row) => row.kind), "the one human action: tell the printer").toEqual([
        "printer_cancellation_needed",
      ]);
      expect(await printerJobs(orderId), "still exactly one printer job").toHaveLength(1);

      // ── 24. retention sweep + reconciliation: clean ─────────────────────
      const reconciledNow = await runReconciliation(world.env, Date.now());
      expect(reconciledNow.alertsRaised).toBe(0);
      expect(reconciledNow.retention.snapshotsWithoutTerminalIntent).toBe(0);

      const later = Date.now() + 8 * DAY_MS;
      const retention = await runRetentionSweep(world.env, later);
      expect(retention).toMatchObject({ canceled: 0, errors: 0, purged: 1, stripe: "configured" });
      const purged = await env.DB.prepare(
        "SELECT production_snapshot_json, snapshot_purged_at FROM checkouts WHERE checkout_id = ?",
      )
        .bind(checkout.checkoutId)
        .first<{ production_snapshot_json: string | null; snapshot_purged_at: string | null }>();
      expect(purged?.production_snapshot_json).toBeNull();
      expect(purged?.snapshot_purged_at).not.toBeNull();
      const kept = await env.DB.prepare("SELECT production_snapshot_json FROM orders WHERE order_id = ?")
        .bind(orderId)
        .first<{ production_snapshot_json: string }>();
      expect(kept?.production_snapshot_json, "the order keeps its copy").toBe(frozen?.production_snapshot_json);

      const reconciledLater = await runReconciliation(world.env, later);
      expect(reconciledLater.alertsRaised).toBe(0);
      expect(reconciledLater.refunds).toMatchObject({ unsettled: 0 });
      expect(reconciledLater.dispatch.stranded).toBe(0);
      const finalLedger = await assertLedgerBalanced(env.DB, orderId, { stripe: world.stripe });
      expect(finalLedger).toMatchObject({
        chargedMinor: PRICE_MINOR,
        payoutMinor: -fee,
        refundedMinor: PRICE_MINOR,
        stripe: { refundedMinor: PRICE_MINOR, shopNetMinor: -fee },
      });
    },
    120_000,
  );
});
