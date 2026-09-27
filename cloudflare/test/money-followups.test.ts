import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import type { TenantAdminPrincipal } from "../src/auth/live-authorization";
import { publishAdminProduct } from "../src/catalog/admin-catalog";
import { runAlertDigest } from "../src/commerce/alert-digest";
import { createCheckout } from "../src/commerce/checkout";
import { runReconciliation, secondWatermark } from "../src/commerce/crons";
import {
  MAX_RELEASE_ATTEMPTS,
  RELEASE_RETRY_CAP_MS,
  releaseRetryDelayMs,
} from "../src/commerce/withholding-release";
import { DISPATCH_HOLD_UNTIL_MS, releaseDispatchHolds } from "../src/commerce/dispatch-hold";
import { computeCommissionMinor } from "../src/commerce/payment";
import { applyRefundFact } from "../src/commerce/refunds";
import type {
  ApplicationFeeRefundView,
  Listing,
  StripeFeeRefundGateway,
} from "../src/commerce/stripe-client";
import { collectPages, StripeGatewayError } from "../src/commerce/stripe-client";
import { cancelOrder } from "../src/dispatch/cancellation";
import type { AlertDigestEmailJob, AuthEmailJob } from "../src/email/auth-email-job";
import { parseAuthEmailJob, renderAuthEmail } from "../src/email/auth-email-job";
import { claimAuthEmailDelivery } from "../src/email/email-delivery-store";
import { processOutboxRowById } from "../src/outbox/effects";
import { runOutboxSweep } from "../src/outbox/sweeper";
import { createMapping } from "../src/pod/pod-mappings";
import { podPriceFloorMinor, priceFloorMinor, withholdMinorFor } from "../src/pod/pod-quote";
import { recordingQueue } from "./dispatch-fixtures";
import type { Admin } from "./money-fixtures";
import {
  adminRequest,
  FakeMoneyStripe,
  moneyEnv,
  next,
  openAlerts,
  orderMoney,
  payCheckout,
  postEvent,
  seedCheckout,
  seedTenant,
  signUpAdmin,
  snapshotJson,
} from "./money-fixtures";
import {
  adminOf,
  seedArtwork,
  seedPrinter,
  seedProduct,
  seedProfile,
  seedTenant as seedPodTenant,
  TEE_S,
} from "./pod-fixtures";

/**
 * CP2-D2 "money follow-ups":
 *   D36  the production withholding is released (an application-fee refund of
 *        exactly withheld_minor) when production is cancelled before
 *        submission — reserve-first, executed once, settled by webhook or API;
 *   D40  the 15-minute platform alert digest email;
 *   D41  the PRISGOLV floor counts the printer's per-order parcel;
 *   P4   Codex review of f5a93e7: a hold found after the claim PARKS the
 *        dispatch (no attempt burnt), and the account resync watermark is
 *        second-aligned.
 */

const TENANT = "tenant-followups";
const MIN = 60 * 1_000;
let accountId: string;
let admin: Admin;

beforeAll(async () => {
  accountId = (await seedTenant(TENANT)) as string;
  admin = await signUpAdmin("followups-admin@example.test", TENANT);
});

// ── a fake Stripe that also refunds application fees ────────────────────────

type Behaviour = "ok" | "reject" | "unavailable";

class FakeFeeStripe extends FakeMoneyStripe implements StripeFeeRefundGateway {
  readonly feeRefundCalls: Array<Parameters<StripeFeeRefundGateway["createApplicationFeeRefund"]>[0]> = [];
  readonly listFeeRefundCalls: string[] = [];
  readonly feeByCharge = new Map<string, string>();
  readonly feeAmount = new Map<string, number>();
  readonly feeRefunds = new Map<string, ApplicationFeeRefundView[]>();
  private readonly feeRefundsByKey = new Map<string, ApplicationFeeRefundView>();
  feeRefundBehaviour: Behaviour = "ok";
  loseFeeRefundResponse = false;
  /** Stripe "makes" the refund with this much more than was asked. */
  feeRefundAmountDelta = 0;

  addFee(chargeId: string, feeId: string, amount: number): void {
    this.feeByCharge.set(chargeId, feeId);
    this.feeAmount.set(feeId, amount);
  }

  /** Charges whose fee lookup fails (an unknown outcome) — forever. */
  readonly brokenCharges = new Set<string>();
  readonly feeLookupCalls: string[] = [];

  async retrieveChargeApplicationFee(params: { chargeId: string | null }): Promise<string | null> {
    this.feeLookupCalls.push(params.chargeId ?? "");
    if (params.chargeId !== null && this.brokenCharges.has(params.chargeId)) {
      throw new StripeGatewayError(false);
    }
    return params.chargeId === null ? null : (this.feeByCharge.get(params.chargeId) ?? null);
  }

  async createApplicationFeeRefund(
    params: Parameters<StripeFeeRefundGateway["createApplicationFeeRefund"]>[0],
  ): Promise<ApplicationFeeRefundView> {
    this.feeRefundCalls.push(params);
    if (this.feeRefundBehaviour === "reject") {
      throw new StripeGatewayError(true);
    }
    if (this.feeRefundBehaviour === "unavailable") {
      throw new StripeGatewayError(false);
    }
    const existing = this.feeRefundsByKey.get(params.idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }
    const fee = this.feeAmount.get(params.applicationFeeId);
    const refunded = (this.feeRefunds.get(params.applicationFeeId) ?? []).reduce((sum, r) => sum + r.amount, 0);
    if (fee === undefined || refunded + params.amount > fee) {
      // Stripe: more than the fee's unrefunded remainder.
      throw new StripeGatewayError(true);
    }
    const refund: ApplicationFeeRefundView = {
      amount: params.amount + this.feeRefundAmountDelta,
      fee: params.applicationFeeId,
      id: `fr_${params.idempotencyKey.replace(/[^A-Za-z0-9]/g, "")}`,
      metadata: params.metadata,
    };
    this.feeRefundsByKey.set(params.idempotencyKey, refund);
    this.feeRefunds.set(params.applicationFeeId, [...(this.feeRefunds.get(params.applicationFeeId) ?? []), refund]);
    if (this.loseFeeRefundResponse) {
      throw new StripeGatewayError(false);
    }
    return refund;
  }

  async listApplicationFeeRefunds(feeId: string): Promise<Listing<ApplicationFeeRefundView>> {
    this.listFeeRefundCalls.push(feeId);
    const all = this.feeRefunds.get(feeId) ?? [];
    return collectPages(async (startingAfter) => {
      const start = startingAfter === null ? 0 : all.findIndex((r) => r.id === startingAfter) + 1;
      return { data: all.slice(start, start + 100), hasMore: start + 100 < all.length };
    });
  }
}

let stripe: FakeFeeStripe;
let nudges: ReturnType<typeof recordingQueue>;

/**
 * The fee refunds requested for ONE order. D1 persists across this file's
 * tests, so a release an earlier test left unsettled is (correctly) executed
 * by a later test's reconciliation; assertions look at their own order only.
 */
function callsFor(orderId: string) {
  return stripe.feeRefundCalls.filter((call) => call.metadata.order_id === orderId);
}

beforeEach(() => {
  stripe = new FakeFeeStripe();
  nudges = recordingQueue();
});

/** The money env with recording queues: no nudge reaches the pool's consumers. */
function quietMoneyEnv(fake: FakeMoneyStripe = stripe, overrides: Partial<Env> = {}): Env {
  return moneyEnv(fake, {
    EMAIL_QUEUE: recordingQueue().queue,
    OUTBOX_QUEUE: nudges.queue,
    ...overrides,
  } as Partial<Env>);
}

const PRICE = 20_000;
const FEE = 13_300;
const WITHHELD = 12_300;
const COMMISSION = FEE - WITHHELD;

interface PaidOrder {
  chargeId: string;
  feeId: string;
  orderId: string;
  paymentIntentId: string;
}

/** A POD order paid through the real webhook: one dispatch row, pending. */
async function paidPodOrder(snapshot = snapshotJson([
  { lineNo: 1, productionCostMinor: 9_840, quantity: 1, sku: "2500170", withholdMinor: WITHHELD },
])): Promise<PaidOrder> {
  const checkout = await seedCheckout({
    connect: { accountId, feeMinor: FEE, withheldMinor: WITHHELD },
    snapshot,
    tenantId: TENANT,
    unitPriceMinor: PRICE,
  });
  const chargeId = next("ch");
  const feeId = next("fee");
  const orderId = await payCheckout(checkout, TENANT, { latestCharge: chargeId });
  const paymentIntentId = checkout.paymentIntentId as string;
  stripe.addIntent({ amount: PRICE, id: paymentIntentId, status: "succeeded" });
  stripe.addFee(chargeId, feeId, FEE);
  return { chargeId, feeId, orderId, paymentIntentId };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A POD order whose print file exists in R2, so the fake printer can take it. */
async function printablePaidOrder(): Promise<PaidOrder> {
  const bytes = new TextEncoder().encode(`print-${next("bytes")}`);
  const r2Key = `pod/${TENANT}/print/${next("file")}.png`;
  await env.PRIVATE_BUCKET.put(r2Key, bytes, { sha256: await crypto.subtle.digest("SHA-256", bytes) });
  return paidPodOrder(
    JSON.stringify({
      lines: [
        {
          lineNo: 1,
          printFiles: [{ heightMm: 350, r2Key, sha256: await sha256Hex(bytes), slot: "front", widthMm: 250 }],
          productionCostMinor: 9_840,
          quantity: 1,
          sku: "2500170",
          withholdMinor: WITHHELD,
        },
      ],
      printer: "fake-printer",
      totals: { productionCostMinor: 9_840, withholdMinor: WITHHELD },
    }),
  );
}

async function refund(orderId: string, amountMinor: number, fake: FakeMoneyStripe = stripe): Promise<Response> {
  return worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}/refunds`, "POST", {
      body: { amountMinor, reason: "buyer cancelled" },
      cookie: admin.cookie,
      shopId: TENANT,
    }),
    quietMoneyEnv(fake),
  );
}

async function dispatchRow(orderId: string) {
  return env.DB.prepare(
    `SELECT outbox_id, status, attempts, next_attempt_at, submitted_at, last_error
     FROM outbox_events WHERE event_type = 'dispatch' AND aggregate_id = ?`,
  )
    .bind(orderId)
    .first<{
      attempts: number;
      last_error: string | null;
      next_attempt_at: number;
      outbox_id: string;
      status: string;
      submitted_at: number | null;
    }>();
}

async function releaseOf(orderId: string) {
  return env.DB.prepare(
    `SELECT id, state, amount_minor, cause, attempts, stripe_application_fee_id,
            stripe_fee_refund_id, last_error, settled_at
     FROM withholding_releases WHERE order_id = ?`,
  )
    .bind(orderId)
    .first<{
      amount_minor: number;
      attempts: number;
      cause: string;
      id: string;
      last_error: string | null;
      settled_at: string | null;
      state: string;
      stripe_application_fee_id: string | null;
      stripe_fee_refund_id: string | null;
    }>();
}

async function readOrder(orderId: string) {
  const response = await worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}`, "GET", { cookie: admin.cookie, origin: null, shopId: TENANT }),
    quietMoneyEnv(),
  );
  expect(response.status).toBe(200);
  return response;
}

function principal(): TenantAdminPrincipal {
  return { accountType: "tenant_admin", role: "admin", tenantId: TENANT, userId: admin.userId };
}

async function printerJobs(orderId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM fake_printer_jobs WHERE order_id = ?")
    .bind(orderId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// D36 — releasing the production withholding
// ═══════════════════════════════════════════════════════════════════════════

describe("D36: a full refund before dispatch releases exactly the withholding", () => {
  it("reserves in the settlement batch, executes once, and the shop no longer pays for production", async () => {
    const order = await paidPodOrder();

    expect((await refund(order.orderId, PRICE)).ok).toBe(true);

    // The settlement batch superseded the dispatch AND reserved the release.
    await expect(dispatchRow(order.orderId)).resolves.toMatchObject({ status: "superseded", submitted_at: null });
    const reserved = await releaseOf(order.orderId);
    expect(reserved).toMatchObject({
      amount_minor: WITHHELD,
      attempts: 0,
      cause: "full_refund",
      state: "reserved",
      stripe_fee_refund_id: null,
    });
    expect(callsFor(order.orderId)).toHaveLength(0);
    // Before the release the shop owes the whole fee.
    const before = await (await readOrder(order.orderId)).json<{ order: { payout: { amountMinor: number } } }>();
    expect(before.order.payout.amountMinor).toBe(-FEE);

    const summary = await runReconciliation(quietMoneyEnv(), Date.now());

    expect(summary.withholding).toMatchObject({ discovered: 0, errors: 0, failed: 0, released: 1, stripe: "configured" });
    expect(callsFor(order.orderId)).toEqual([
      {
        amount: WITHHELD,
        applicationFeeId: order.feeId,
        idempotencyKey: reserved?.id,
        metadata: { order_id: order.orderId, tenant_id: TENANT, withholding_release_id: reserved?.id },
      },
    ]);
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({
      attempts: 1,
      state: "succeeded",
      stripe_application_fee_id: order.feeId,
      stripe_fee_refund_id: expect.stringMatching(/^fr_/) as unknown as string,
    });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({
      application_fee_minor: FEE,
      withheld_minor: WITHHELD,
      withholding_released_minor: WITHHELD,
    } as Record<string, unknown>);

    // Idempotent: the next runs call Stripe for nothing.
    await runReconciliation(quietMoneyEnv(), Date.now());
    await runReconciliation(quietMoneyEnv(), Date.now() + 31 * MIN);
    expect(callsFor(order.orderId)).toHaveLength(1);
    expect(await openAlerts("withholding_release_unsettled_30m")).toHaveLength(0);

    // The payout now carries only the non-refundable commission (D9).
    const after = await (await readOrder(order.orderId)).json<{
      order: { money: { feeMinor: number }; payout: { amountMinor: number } };
    }>();
    expect(after.order.payout.amountMinor).toBe(-COMMISSION);
    expect(after.order.money.feeMinor).toBe(COMMISSION);
  });

  it("the seller-facing order read still shows ONE fee figure (denylist)", async () => {
    const order = await paidPodOrder();
    await refund(order.orderId, PRICE);
    await runReconciliation(quietMoneyEnv(), Date.now());
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({ state: "succeeded" });

    const text = await (await readOrder(order.orderId)).text();
    const body = JSON.parse(text) as { order: { money: Record<string, unknown>; payout: { amountMinor: number } } };

    const DENYLIST = [
      "withh", "release", "production", "cost", "commission", "bps", "snapshot",
      "printer", "connect", "transfer", "stripe", "applicationfee", "application_fee", "fee_refund",
    ];
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key);
          walk(inner);
        }
      }
    };
    walk(body);
    for (const key of keys) {
      for (const denied of DENYLIST) {
        expect(key.toLowerCase()).not.toContain(denied);
      }
    }
    // Exactly one fee-like key, and it is the net deduction.
    expect(keys.filter((key) => key.toLowerCase().includes("fee"))).toEqual(["feeMinor"]);
    expect(body.order.money.feeMinor).toBe(COMMISSION);
    // payout = charged − refunded − fee holds for the figures the seller sees.
    expect(body.order.payout.amountMinor).toBe(PRICE - PRICE - COMMISSION);
    // Neither the withheld production cost nor the gross fee appears anywhere.
    expect(text).not.toContain(String(WITHHELD));
    expect(text).not.toContain(String(FEE));
    expect(text).not.toContain("9840");
    expect(text).not.toContain(order.feeId);
    expect(text).not.toContain("fr_");
  });

  it("an admin cancel (dispatch superseded elsewhere) is found by reconciliation's discovery", async () => {
    const order = await paidPodOrder();
    const cancelled = await cancelOrder(quietMoneyEnv(), principal(), { orderId: order.orderId, reason: "out of stock" }, Date.now());
    expect(cancelled.status).toBe("ok");
    await expect(dispatchRow(order.orderId)).resolves.toMatchObject({ status: "superseded" });
    // CP2-B's cancel batch does not reserve (not this checkpoint's file) …
    await expect(releaseOf(order.orderId)).resolves.toBeNull();

    // … the 15-minute discovery does, and the same run executes it.
    const summary = await runReconciliation(quietMoneyEnv(), Date.now());

    expect(summary.withholding).toMatchObject({ discovered: 1, released: 1 });
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({ cause: "order_cancelled", state: "succeeded" });
    expect(callsFor(order.orderId).map((call) => call.amount)).toEqual([WITHHELD]);
  });
});

describe("D36: no release when production may have happened", () => {
  it("a refund after the printer ACCEPTED the job releases nothing", async () => {
    const order = await printablePaidOrder();
    const row = await dispatchRow(order.orderId);
    const ran = await processOutboxRowById(quietMoneyEnv(), row?.outbox_id ?? "");
    expect(ran).toMatchObject({ kind: "ran", outcome: { kind: "done" } });
    expect(await printerJobs(order.orderId)).toBe(1);

    expect((await refund(order.orderId, PRICE)).ok).toBe(true);
    const cancellations = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'printer_cancellation' AND aggregate_id = ?",
    )
      .bind(order.orderId)
      .first<{ n: number }>();
    expect(cancellations?.n).toBe(1);

    const summary = await runReconciliation(quietMoneyEnv(), Date.now());

    await expect(releaseOf(order.orderId)).resolves.toBeNull();
    expect(summary.withholding.discovered).toBe(0);
    expect(callsFor(order.orderId)).toHaveLength(0);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ withholding_released_minor: 0 } as Record<string, unknown>);
  });

  it("a job that was SUBMITTED before its cancellation (even if later superseded) releases nothing", async () => {
    const order = await paidPodOrder();
    const row = await dispatchRow(order.orderId);
    const now = Date.now();
    // claimed → submitting (the call went out) → superseded (the printer
    // refused it after the cancellation): not "before submission" (D36).
    await env.DB.prepare(
      `UPDATE outbox_events SET status = 'claimed', claimed_by = 'claim-token-0123456789', claim_expires_at = ?,
              attempts = attempts + 1, updated_at = MAX(updated_at, ?) WHERE outbox_id = ?`,
    ).bind(now + 5 * MIN, now, row?.outbox_id).run();
    await env.DB.prepare(
      `UPDATE outbox_events SET status = 'submitting', submitted_at = ?, cancel_requested = 1 WHERE outbox_id = ?`,
    ).bind(now, row?.outbox_id).run();
    await env.DB.prepare(
      `UPDATE outbox_events SET status = 'superseded', resolved_at = ?, claimed_by = NULL, claim_expires_at = NULL,
              last_error = 'rejected_400' WHERE outbox_id = ?`,
    ).bind(now, row?.outbox_id).run();

    expect((await refund(order.orderId, PRICE)).ok).toBe(true);
    const summary = await runReconciliation(quietMoneyEnv(), Date.now());

    await expect(releaseOf(order.orderId)).resolves.toBeNull();
    expect(summary.withholding.discovered).toBe(0);
    expect(callsFor(order.orderId)).toHaveLength(0);
  });

  it("a PARTIAL refund releases nothing (production goes ahead)", async () => {
    const order = await paidPodOrder();

    expect((await refund(order.orderId, 5_000)).ok).toBe(true);
    const summary = await runReconciliation(quietMoneyEnv(), Date.now());

    await expect(dispatchRow(order.orderId)).resolves.toMatchObject({ status: "pending" });
    await expect(releaseOf(order.orderId)).resolves.toBeNull();
    expect(summary.withholding.discovered).toBe(0);
    expect(callsFor(order.orderId)).toHaveLength(0);
  });

  it("a non-POD order (nothing withheld) never gets a release", async () => {
    const checkout = await seedCheckout({
      connect: { accountId, feeMinor: 1_000, withheldMinor: 0 },
      tenantId: TENANT,
      unitPriceMinor: PRICE,
    });
    const orderId = await payCheckout(checkout, TENANT);
    stripe.addIntent({ amount: PRICE, id: checkout.paymentIntentId as string, status: "succeeded" });

    expect((await refund(orderId, PRICE)).ok).toBe(true);
    await runReconciliation(quietMoneyEnv(), Date.now());

    await expect(releaseOf(orderId)).resolves.toBeNull();
  });
});

describe("D36: the release's own failure modes", () => {
  it("a lost answer is found by listing the fee's refunds, never repeated", async () => {
    const order = await paidPodOrder();
    await refund(order.orderId, PRICE);
    stripe.loseFeeRefundResponse = true;

    const first = await runReconciliation(quietMoneyEnv(), Date.now());

    expect(first.withholding).toMatchObject({ errors: 1, released: 0 });
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({ attempts: 1, state: "submitted" });

    stripe.loseFeeRefundResponse = false;
    // Backed off (0030): not retried within the same tick …
    await runReconciliation(quietMoneyEnv(), Date.now());
    expect(stripe.listFeeRefundCalls.filter((id) => id === order.feeId)).toHaveLength(0);
    // … but on the next one.
    const second = await runReconciliation(quietMoneyEnv(), Date.now() + 11 * MIN);

    expect(second.withholding).toMatchObject({ released: 1 });
    expect(stripe.listFeeRefundCalls.filter((id) => id === order.feeId)).toHaveLength(1);
    // Found, not created again.
    expect(callsFor(order.orderId)).toHaveLength(1);
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({ attempts: 2, state: "succeeded" });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ withholding_released_minor: WITHHELD } as Record<string, unknown>);
  });

  it("Stripe refusing it ends the release as failed with a critical alert — no automatic retry", async () => {
    const order = await paidPodOrder();
    await refund(order.orderId, PRICE);
    stripe.feeRefundBehaviour = "reject";

    const summary = await runReconciliation(quietMoneyEnv(), Date.now());

    expect(summary.withholding.failed).toBe(1);
    const release = await releaseOf(order.orderId);
    expect(release).toMatchObject({ last_error: "stripe_refused", state: "failed" });
    expect(release?.settled_at).not.toBeNull();
    const alerts = await openAlerts("withholding_release_failed", release?.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("critical");
    expect(alerts[0]?.message).not.toContain(String(WITHHELD));

    stripe.feeRefundBehaviour = "ok";
    await runReconciliation(quietMoneyEnv(), Date.now());
    expect(callsFor(order.orderId)).toHaveLength(1);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ withholding_released_minor: 0 } as Record<string, unknown>);
  });

  it("an unreachable Stripe keeps it reserved, and 30 minutes later a human is told", async () => {
    const order = await paidPodOrder();
    await refund(order.orderId, PRICE);
    stripe.feeRefundBehaviour = "unavailable";

    await runReconciliation(quietMoneyEnv(), Date.now());
    const release = await releaseOf(order.orderId);
    expect(release).toMatchObject({ state: "submitted" });

    const later = await runReconciliation(quietMoneyEnv(), Date.now() + 31 * MIN);
    expect(later.withholding.unsettled).toBeGreaterThanOrEqual(1);
    expect(await openAlerts("withholding_release_unsettled_30m", release?.id)).toHaveLength(1);
  });

  it("a Stripe fake without the fee methods never executes a release", async () => {
    const plain = new FakeMoneyStripe();
    const order = await paidPodOrder();
    plain.addIntent({ amount: PRICE, id: order.paymentIntentId, status: "succeeded" });
    expect((await refund(order.orderId, PRICE, plain)).ok).toBe(true);

    const summary = await runReconciliation(quietMoneyEnv(plain), Date.now());

    expect(summary.withholding.stripe).toBe("unavailable");
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({ state: "reserved" });
  });
});

describe("D36: settlement by webhook (application_fee.refunded / application_fee.refund.updated)", () => {
  function feeRefundObject(id: string, feeId: string, amount: number, metadata: Record<string, string>) {
    return { amount, currency: "sek", fee: feeId, id, metadata, object: "fee_refund" };
  }

  it("application_fee.refunded settles a release whose API answer never arrived; replays change nothing", async () => {
    const order = await paidPodOrder();
    await refund(order.orderId, PRICE);
    const release = await releaseOf(order.orderId);

    const refundedFee = {
      amount: FEE,
      amount_refunded: WITHHELD,
      charge: order.chargeId,
      id: order.feeId,
      object: "application_fee",
      refunded: false,
      refunds: {
        data: [feeRefundObject("fr_webhook_1", order.feeId, WITHHELD, { withholding_release_id: release?.id ?? "" })],
        has_more: false,
        object: "list",
      },
    };
    const first = await postEvent("application_fee.refunded", refundedFee);
    expect(first.response.status).toBe(200);

    await expect(releaseOf(order.orderId)).resolves.toMatchObject({
      state: "succeeded",
      stripe_application_fee_id: order.feeId,
      stripe_fee_refund_id: "fr_webhook_1",
    });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ withholding_released_minor: WITHHELD } as Record<string, unknown>);

    // The same event again, and the refund's own update event: no second effect.
    expect((await postEvent("application_fee.refunded", refundedFee, { eventId: first.eventId })).response.status).toBe(200);
    const updated = await postEvent(
      "application_fee.refund.updated",
      feeRefundObject("fr_webhook_1", order.feeId, WITHHELD, { withholding_release_id: release?.id ?? "" }),
    );
    expect(updated.response.status).toBe(200);
    const ledger = await env.DB.prepare("SELECT outcome, reason_code FROM payment_events WHERE event_id = ?")
      .bind(updated.eventId)
      .first<{ outcome: string; reason_code: string | null }>();
    expect(ledger).toEqual({ outcome: "processed", reason_code: "already_applied" });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ withholding_released_minor: WITHHELD } as Record<string, unknown>);

    // Reconciliation has nothing left to do at Stripe.
    await runReconciliation(quietMoneyEnv(), Date.now());
    expect(callsFor(order.orderId)).toHaveLength(0);
  });

  it("a fee refund with a different amount is not recorded: the release FAILS (amount_mismatch) with a critical alert", async () => {
    const order = await paidPodOrder();
    await refund(order.orderId, PRICE);
    const release = await releaseOf(order.orderId);

    const { eventId } = await postEvent(
      "application_fee.refund.updated",
      feeRefundObject("fr_wrong_amount", order.feeId, WITHHELD - 1, { withholding_release_id: release?.id ?? "" }),
    );

    const ledger = await env.DB.prepare("SELECT outcome, reason_code FROM payment_events WHERE event_id = ?")
      .bind(eventId)
      .first<{ outcome: string; reason_code: string | null }>();
    expect(ledger).toEqual({ outcome: "rejected", reason_code: "refund_amount_mismatch" });
    // Money moved that was not asked for: never executed or retried after this.
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({
      last_error: "amount_mismatch",
      state: "failed",
      stripe_fee_refund_id: null,
    });
    expect(await openAlerts("withholding_release_failed", release?.id)).toHaveLength(1);
    await runReconciliation(quietMoneyEnv(), Date.now());
    expect(callsFor(order.orderId)).toHaveLength(0);
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ withholding_released_minor: 0 } as Record<string, unknown>);
  });

  it("a fee refund nobody here made (the dashboard) on one of our orders raises a warning", async () => {
    const order = await paidPodOrder();

    const { response } = await postEvent("application_fee.refunded", {
      amount: FEE,
      amount_refunded: 500,
      charge: order.chargeId,
      id: order.feeId,
      object: "application_fee",
      refunds: { data: [feeRefundObject(next("fr_dash"), order.feeId, 500, {})], has_more: false, object: "list" },
    });

    expect(response.status).toBe(200);
    const alerts = await openAlerts("withholding_release_unmatched", order.orderId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("warning");
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ withholding_released_minor: 0 } as Record<string, unknown>);
  });

  it("an application fee of another integration is ignored", async () => {
    const { eventId, response } = await postEvent("application_fee.refunded", {
      amount: 100,
      charge: next("ch_foreign"),
      id: next("fee_foreign"),
      object: "application_fee",
      refunds: { data: [feeRefundObject(next("fr_foreign"), "fee_x", 100, {})], has_more: false, object: "list" },
    });
    expect(response.status).toBe(200);
    const ledger = await env.DB.prepare("SELECT outcome FROM payment_events WHERE event_id = ?")
      .bind(eventId)
      .first<{ outcome: string }>();
    expect(ledger?.outcome).toBe("ignored");
  });
});

describe("D36: the schema guards the release", () => {
  it("a release is born reserved, for exactly the withheld amount, once per order, and never deleted", async () => {
    const order = await paidPodOrder();
    const insert = (amount: number, state = "reserved") =>
      env.DB.prepare(
        `INSERT INTO withholding_releases (id, tenant_id, order_id, amount_minor, state, cause, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'full_refund', 0, ?, ?)`,
      )
        .bind(crypto.randomUUID(), TENANT, order.orderId, amount, state, new Date().toISOString(), new Date().toISOString())
        .run();

    await expect(insert(WITHHELD + 1)).rejects.toThrow(/born reserved/);
    await expect(insert(WITHHELD, "succeeded")).rejects.toThrow();
    await insert(WITHHELD);
    await expect(insert(WITHHELD)).rejects.toThrow(/UNIQUE/);
    await expect(
      env.DB.prepare("DELETE FROM withholding_releases WHERE order_id = ?").bind(order.orderId).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("UPDATE orders SET withholding_released_minor = ? WHERE order_id = ?")
        .bind(WITHHELD + 1, order.orderId)
        .run(),
    ).rejects.toThrow(/bounds/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D40 — the alert digest email
// ═══════════════════════════════════════════════════════════════════════════

describe("D40: the 15-minute alert digest", () => {
  const PLATFORM_EMAIL = "ops@platform.test";
  const BUCKET = 15 * MIN;
  // Every tick runs in the (recent) past, in buckets of its own, so the jobs'
  // createdAt stay within what the ledger and the consumer accept.
  const base = Math.floor((Date.now() - 3 * 60 * MIN) / BUCKET) * BUCKET;
  const at = (minutes: number) => base + minutes * MIN;

  function digestEnv(emails: ReturnType<typeof recordingQueue>, overrides: Record<string, unknown> = {}): Env {
    return { ...env, EMAIL_QUEUE: emails.queue, PLATFORM_ALERT_EMAIL: PLATFORM_EMAIL, ...overrides } as unknown as Env;
  }

  async function alert(kind: string, severity: string, resourceId: string, createdAt: number, message = "ids only") {
    await env.DB.prepare(
      `INSERT INTO alerts (id, tenant_id, kind, severity, message, resource_type, resource_id, created_at)
       VALUES (?, NULL, ?, ?, ?, 'order', ?, ?)`,
    )
      .bind(`${kind}:${crypto.randomUUID()}`, kind, severity, message, resourceId, new Date(createdAt).toISOString())
      .run();
  }

  async function digestRows() {
    const rows = await env.DB.prepare(
      "SELECT delivery_id, tenant_id, kind, status FROM email_deliveries WHERE kind = 'alert_digest' ORDER BY created_at",
    ).all<{ delivery_id: string; kind: string; status: string; tenant_id: string | null }>();
    return rows.results;
  }

  beforeAll(async () => {
    // A clean slate: only this suite's alerts are open.
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE alerts SET resolved_at = CASE WHEN created_at > ? THEN created_at ELSE ? END WHERE resolved_at IS NULL",
    )
      .bind(now, now)
      .run();
  });

  it("PLATFORM_ALERT_EMAIL absent ⇒ no digest (one log line), nothing enqueued", async () => {
    await alert("refund_unsettled_30m", "warning", "op-absent", at(0));
    const emails = recordingQueue();

    const result = await runAlertDigest(digestEnv(emails, { PLATFORM_ALERT_EMAIL: undefined }), at(1));

    expect(result).toEqual({ status: "unconfigured" });
    expect(emails.sent).toHaveLength(0);
    expect(await digestRows()).toHaveLength(0);
  });

  it("open alerts ⇒ ONE job: kinds, counts, oldest, resource ids — no amounts, no messages", async () => {
    await alert("dispatch_stranded_30m", "critical", "outbox-1", at(2), "SECRET-MESSAGE-TEXT 12300");
    await alert("refund_unsettled_30m", "warning", "op-2", at(3));
    const emails = recordingQueue();

    const result = await runAlertDigest(digestEnv(emails), at(16));

    expect(result).toMatchObject({ newAlerts: 3, status: "enqueued" });
    expect(emails.sent).toHaveLength(1);
    const job = emails.sent[0] as AlertDigestEmailJob;
    expect(job).toMatchObject({
      actionUrl: "",
      kind: "alert_digest",
      locale: "sv",
      recipient: PLATFORM_EMAIL,
      version: 1,
    });
    expect(job.tenantId).toBeUndefined();
    expect(job.digest).toEqual({
      bucketStart: new Date(at(15)).toISOString(),
      kinds: [
        {
          count: 1,
          kind: "dispatch_stranded_30m",
          newCount: 1,
          oldestAt: new Date(at(2)).toISOString(),
          resourceIds: ["outbox-1"],
          severity: "critical",
        },
        {
          count: 2,
          kind: "refund_unsettled_30m",
          newCount: 2,
          oldestAt: new Date(at(0)).toISOString(),
          resourceIds: ["op-absent", "op-2"],
          severity: "warning",
        },
      ],
      newCount: 3,
      omittedKinds: 0,
      openCount: 3,
    });
    expect(JSON.stringify(job)).not.toContain("SECRET-MESSAGE-TEXT");
    expect(JSON.stringify(job)).not.toContain("12300");
    // Ledgered BEFORE the queue, as a platform mail (no tenant).
    await expect(digestRows()).resolves.toEqual([
      { delivery_id: job.deliveryId, kind: "alert_digest", status: "pending", tenant_id: null },
    ]);

    // The consumer's half: it parses and renders (Swedish) exactly this job.
    const parsed = parseAuthEmailJob(JSON.parse(JSON.stringify(job)), env.AUTH_BASE_URL);
    expect(parsed).toEqual(job);
    const message = renderAuthEmail(parsed);
    expect(message.subject).toBe("Plattformslarm: 3 nya, 3 öppna");
    expect(message.text).toContain("dispatch_stranded_30m (kritisk): 1 öppna, 1 nya");
    expect(message.text).toContain("Resurser: op-absent, op-2");
    expect(message.text).toContain("inga belopp eller kunduppgifter");
    expect(message.html).not.toContain("SECRET-MESSAGE-TEXT");
  });

  it("a retried tick of the same bucket sends nothing more; nothing new ⇒ no digest", async () => {
    const emails = recordingQueue();

    await expect(runAlertDigest(digestEnv(emails), at(16))).resolves.toEqual({ status: "already_sent" });
    await expect(runAlertDigest(digestEnv(emails), at(29))).resolves.toEqual({ status: "already_sent" });
    // Next bucket, no alert raised since the last digest.
    await expect(runAlertDigest(digestEnv(emails), at(31))).resolves.toEqual({ status: "nothing_new" });

    expect(emails.sent).toHaveLength(0);
    expect(await digestRows()).toHaveLength(1);
  });

  it("a failed enqueue is retried with the IDENTICAL frozen job, ledgered once", async () => {
    await alert("payout_blocked_dispute", "warning", "order-9", at(40));
    const broken = recordingQueue({ fail: true });

    const failed = await runAlertDigest(digestEnv(broken), at(46));
    expect(failed).toMatchObject({ status: "enqueue_failed" });

    // An alert raised after the freeze does not change this bucket's digest.
    await alert("dispatch_stranded_30m", "critical", "outbox-late", at(50));
    const emails = recordingQueue();
    const retried = await runAlertDigest(digestEnv(emails), at(52));

    expect(retried).toMatchObject({ deliveryId: failed.deliveryId, status: "enqueued" });
    expect(emails.sent).toHaveLength(1);
    const job = emails.sent[0] as AlertDigestEmailJob;
    expect(job.deliveryId).toBe(failed.deliveryId);
    expect(job.digest.newCount).toBe(1);
    expect(job.digest.kinds.map((entry) => entry.resourceIds).flat()).not.toContain("outbox-late");
    expect(await digestRows()).toHaveLength(2);

    // The late alert is NEW for the next bucket's digest.
    const nextEmails = recordingQueue();
    await expect(runAlertDigest(digestEnv(nextEmails), at(61))).resolves.toMatchObject({
      newAlerts: 1,
      status: "enqueued",
    });
    expect((nextEmails.sent[0] as AlertDigestEmailJob).digest.newCount).toBe(1);
  });

  it("the ledger fingerprint covers the digest content: a different body under the same id is refused", async () => {
    const rows = await digestRows();
    const last = rows[rows.length - 1];
    const emails = recordingQueue();
    // Rebuild the last job exactly (same bucket ⇒ same frozen content) …
    await env.DB.prepare("UPDATE platform_state SET last_digest_at = last_digest_at").run();
    const state = await env.DB.prepare("SELECT digest_json, digest_computed_at FROM platform_state WHERE id = 1")
      .first<{ digest_computed_at: string; digest_json: string }>();
    const createdAt = Date.parse(state?.digest_computed_at ?? "");
    const job: AuthEmailJob = {
      actionUrl: "",
      createdAt,
      deliveryId: last?.delivery_id ?? "",
      digest: JSON.parse(state?.digest_json ?? "{}") as AlertDigestEmailJob["digest"],
      expiresAt: createdAt + 6 * 60 * MIN,
      kind: "alert_digest",
      locale: "sv",
      recipient: PLATFORM_EMAIL,
      version: 1,
    };
    // … the genuine job claims; a tampered copy is a conflict, never a send.
    const tampered: AuthEmailJob = { ...job, digest: { ...job.digest, openCount: job.digest.openCount + 1 } };
    await expect(claimAuthEmailDelivery(env.DB, tampered, Date.now())).resolves.toEqual({ status: "conflict" });
    await expect(claimAuthEmailDelivery(env.DB, job, Date.now())).resolves.toMatchObject({ status: "claimed" });
    expect(emails.sent).toHaveLength(0);
  });

  it("the ledger accepts the new kind and platform_state is one permanent row", async () => {
    await expect(env.DB.prepare("DELETE FROM platform_state").run()).rejects.toThrow(/single permanent row/);
    await expect(
      env.DB.prepare("UPDATE platform_state SET last_digest_at = '2000-01-01T00:00:00.000Z' WHERE id = 1").run(),
    ).rejects.toThrow(/only moves forward/);
    await expect(
      env.DB.prepare("INSERT INTO platform_state (id, updated_at) VALUES (2, '2026-01-01T00:00:00.000Z')").run(),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D41 — the price floor counts the printer's per-order parcel
// ═══════════════════════════════════════════════════════════════════════════

describe("D41: PRISGOLV includes the parcel, so a one-item order at the floor clears its withholding", () => {
  it("the floor over (cost + parcel), at max(tenant VAT, 25 %) — Firebase's per-item formula unchanged", () => {
    // Firebase parity is untouched: 140 kr ex → 196 kr.
    expect(priceFloorMinor(14_000, 2_500)).toBe(19_600);
    // D41: (140 + 49) kr ex → 263 kr; a VAT-exempt shop gets the same floor.
    expect(podPriceFloorMinor({ parcelMinor: 4_900, productionCostMinor: 14_000 }, 2_500)).toBe(26_300);
    expect(podPriceFloorMinor({ parcelMinor: 4_900, productionCostMinor: 14_000 }, 0)).toBe(26_300);
    expect(podPriceFloorMinor({ parcelMinor: 0, productionCostMinor: 14_000 }, 2_500)).toBe(19_600);
    // A quote without its printer's parcel is not floor-able (fail closed).
    expect(podPriceFloorMinor({ parcelMinor: null, productionCostMinor: 14_000 }, 2_500)).toBeNull();
    expect(podPriceFloorMinor({ parcelMinor: -1, productionCostMinor: 14_000 }, 2_500)).toBeNull();
  });

  it("for every cost and parcel, at the floor: withholding ≤ price and commission (≤ 8 %) + withholding < price", () => {
    for (const vat of [0, 600, 1_200, 2_500]) {
      for (let cost = 0; cost <= 60_000; cost += 137) {
        for (const parcel of [0, 1, 2_900, 4_900, 9_999]) {
          const floor = podPriceFloorMinor({ parcelMinor: parcel, productionCostMinor: cost }, vat) as number;
          const withhold = withholdMinorFor(cost + parcel);
          expect(withhold).toBeLessThanOrEqual(floor);
          for (const bps of [500, 800]) {
            expect(computeCommissionMinor(floor, bps) + withhold).toBeLessThan(floor);
          }
        }
      }
    }
  });

  it("a product priced EXACTLY at the new floor publishes and checks out with quantity 1", async () => {
    const podTenant = "tenant-followups-floor";
    const host = "floor.followups.test";
    await seedPodTenant(podTenant, host);
    await seedProfile();
    await seedPrinter();
    await seedArtwork(podTenant, { artworkId: "art-floor" });
    const podAdmin = adminOf(podTenant);
    // Past D8's first-N review: two live products first.
    await seedProduct(podTenant, { productId: "floor-live-1", published: true });
    await seedProduct(podTenant, { productId: "floor-live-2", published: true });

    // front only: 60 + 40 + 40 = 140 kr ex; the fake printer's parcel 49 kr.
    await seedProduct(podTenant, { productId: "floor-tee", priceMinor: 26_300 });
    const mapped = await createMapping(env.DB, podAdmin, {
      artworkId: "art-floor",
      printerId: "fake-printer",
      productId: "floor-tee",
      sku: TEE_S,
      slots: ["front"],
      variantId: null,
    }, Date.now());
    expect(mapped).toMatchObject({ quote: { priceFloorMinor: 26_300 }, status: "ok" });
    expect((await publishAdminProduct(env.DB, podAdmin, "floor-tee", Date.now())).status).toBe("ok");

    const result = await createCheckout(
      env.DB,
      { domainKind: "storefront", hostname: host, tenantId: podTenant },
      {
        deliveryMethod: "shipping",
        discountCode: null,
        email: "buyer@followups.test",
        idempotencyKey: `idem-${crypto.randomUUID()}`,
        items: [{ productId: "floor-tee", quantity: 1 }],
        shippingCountry: "SE",
      },
      Date.now(),
    );

    expect(result.status).toBe("ok");
    const row = await env.DB.prepare(
      "SELECT production_snapshot_json, total_minor FROM checkouts WHERE checkout_id = ?",
    )
      .bind(result.status === "ok" ? result.checkout.checkoutId : "")
      .first<{ production_snapshot_json: string; total_minor: number }>();
    const snapshot = JSON.parse(row?.production_snapshot_json ?? "{}") as {
      totals: { productionCostMinor: number; withholdMinor: number };
    };
    // (140 + 49) kr × 1.25 = 236,25 kr withheld — within the item's own
    // 263 kr, whatever the buyer's shipping adds on top.
    expect(snapshot.totals).toEqual({ productionCostMinor: 18_900, withholdMinor: 23_625 });
    expect(snapshot.totals.withholdMinor).toBeLessThanOrEqual(26_300);
    expect(snapshot.totals.withholdMinor).toBeLessThanOrEqual(row?.total_minor ?? 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 4 — Codex review of f5a93e7
// ═══════════════════════════════════════════════════════════════════════════

describe("P4-1: a hold found AFTER the claim parks the dispatch without burning attempts", () => {
  it("claim → hold → release ⇒ attempts unchanged while held, job dispatched once", async () => {
    const order = await printablePaidOrder();
    const row = await dispatchRow(order.orderId);
    // Stripe reports a refund no refund event has explained yet — but the
    // row was never held (the hold statement ran before, or not at all):
    // the effect's own check is what finds it, after claiming.
    await env.DB.prepare("UPDATE orders SET stripe_amount_refunded_minor = 5000 WHERE order_id = ?")
      .bind(order.orderId)
      .run();

    const first = await processOutboxRowById(quietMoneyEnv(), row?.outbox_id ?? "");

    expect(first).toMatchObject({ kind: "ran", outcome: { kind: "retry" } });
    await expect(dispatchRow(order.orderId)).resolves.toMatchObject({
      attempts: 1,
      last_error: "payment_facts_pending",
      next_attempt_at: DISPATCH_HOLD_UNTIL_MS,
      status: "pending",
      submitted_at: null,
    });
    expect(await printerJobs(order.orderId)).toBe(0);

    // However long it stays held, nothing claims it: no attempt is spent.
    for (let tick = 1; tick <= 12; tick += 1) {
      await runOutboxSweep(quietMoneyEnv(), Date.now() + tick * 60 * MIN);
      await expect(processOutboxRowById(quietMoneyEnv(), row?.outbox_id ?? "")).resolves.toMatchObject({ kind: "later" });
    }
    await expect(dispatchRow(order.orderId)).resolves.toMatchObject({ attempts: 1, status: "pending" });

    // The refund settles (a partial one: production goes ahead) and the
    // existing release un-parks the row.
    await applyRefundFact(env.DB, {
      amount: 5_000,
      operationId: null,
      paymentIntentId: order.paymentIntentId,
      status: "succeeded",
      stripeRefundId: next("re_dash"),
    }, Date.now());
    const released = await releaseDispatchHolds(env.DB, { now: Date.now(), paymentIntentId: order.paymentIntentId });
    expect(released).toEqual([row?.outbox_id]);
    await expect(dispatchRow(order.orderId)).resolves.toMatchObject({ attempts: 1, status: "pending" });

    const second = await processOutboxRowById(quietMoneyEnv(), row?.outbox_id ?? "");

    expect(second).toMatchObject({ kind: "ran", outcome: { kind: "done" } });
    await expect(dispatchRow(order.orderId)).resolves.toMatchObject({ attempts: 2, status: "done" });
    expect(await printerJobs(order.orderId)).toBe(1);
  });

  it("a row claimed on its LAST attempt is not parked (it could never be claimed again): it fails with its alert", async () => {
    const order = await printablePaidOrder();
    const row = await dispatchRow(order.orderId);
    await env.DB.prepare("UPDATE outbox_events SET attempts = max_attempts - 1 WHERE outbox_id = ?")
      .bind(row?.outbox_id)
      .run();
    await env.DB.prepare("UPDATE orders SET stripe_amount_refunded_minor = 5000 WHERE order_id = ?")
      .bind(order.orderId)
      .run();

    const ran = await processOutboxRowById(quietMoneyEnv(), row?.outbox_id ?? "");

    expect(ran).toMatchObject({ kind: "ran", outcome: { kind: "failed" } });
    await expect(dispatchRow(order.orderId)).resolves.toMatchObject({ status: "failed" });
    expect(await printerJobs(order.orderId)).toBe(0);
  });

  it("a hold released between the check and the park falls back to an ordinary short retry", async () => {
    // parkForHold re-checks the hold atomically; without one it parks nothing.
    const order = await printablePaidOrder();
    const row = await dispatchRow(order.orderId);
    await env.DB.prepare("UPDATE orders SET stripe_amount_refunded_minor = 5000 WHERE order_id = ?")
      .bind(order.orderId)
      .run();
    const { parkForHold } = await import("../src/commerce/dispatch-hold");
    const { claimById } = await import("../src/outbox/outbox");
    const now = Date.now();
    const claimed = await claimById(env.DB, { claimedBy: "claim-token-park-0123456789", now, outboxId: row?.outbox_id ?? "" });
    expect(claimed).not.toBeNull();
    // The hold ends before the park runs.
    await env.DB.prepare("UPDATE orders SET stripe_amount_refunded_minor = 0 WHERE order_id = ?")
      .bind(order.orderId)
      .run();
    const line = await env.DB.prepare("SELECT order_item_id FROM order_items WHERE order_id = ? LIMIT 1")
      .bind(order.orderId)
      .first<{ order_item_id: string }>();

    const parked = await parkForHold(
      {
        claim: { claimedBy: "claim-token-park-0123456789", outboxId: row?.outbox_id ?? "" },
        clock: () => now,
        env: quietMoneyEnv(),
        row: claimed!,
      },
      { orderItemId: line?.order_item_id ?? "", tenantId: TENANT },
    );

    expect(parked).toBeNull();
    await expect(dispatchRow(order.orderId)).resolves.toMatchObject({ status: "claimed" });
  });
});

describe("P4-2: the account resync watermark is second-aligned", () => {
  it("a restriction created in the SAME second as a resync is applied (tie, fail-closed), never dropped", async () => {
    const tenantId = next("tenant-watermark").toLowerCase().replace(/_/g, "-");
    const account = (await seedTenant(tenantId, { chargesEnabled: false, payoutsEnabled: false })) as string;
    const s0 = Math.floor(Date.now() / 1_000) - 600;
    // An onboarding tie marks the shop for a resync.
    await postEvent("account.updated", { charges_enabled: false, id: account, payouts_enabled: false }, { created: s0 });
    await postEvent("account.updated", { charges_enabled: true, id: account, payouts_enabled: true }, { created: s0 });
    stripe.accounts.set(account, { charges_enabled: true, details_submitted: true, id: account, payouts_enabled: true });

    // The resync runs at S + 100 ms …
    const s = s0 + 60;
    await runReconciliation(quietMoneyEnv(), s * 1_000 + 100);
    const synced = await env.DB.prepare(
      `SELECT stripe_charges_enabled AS c, stripe_account_resync_needed AS r,
              stripe_account_synced_at AS at FROM tenants WHERE tenant_id = ?`,
    )
      .bind(tenantId)
      .first<{ at: number; c: number; r: number }>();
    expect(synced).toEqual({ at: s * 1_000, c: 1, r: 0 });
    expect(secondWatermark(s * 1_000 + 999)).toBe(s * 1_000);

    // … and Stripe restricts the account at S + 500 ms (event.created = S).
    await postEvent("account.updated", { charges_enabled: false, id: account, payouts_enabled: true }, { created: s });

    const after = await env.DB.prepare(
      "SELECT stripe_charges_enabled AS c, stripe_account_resync_needed AS r FROM tenants WHERE tenant_id = ?",
    )
      .bind(tenantId)
      .first<{ c: number; r: number }>();
    // Applied fail-closed and marked for an authoritative re-read.
    expect(after).toEqual({ c: 0, r: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Codex CP2-D2 P2 — the release executor cannot starve (0030)
// ═══════════════════════════════════════════════════════════════════════════

describe("Codex P2: releases that keep failing never starve the others (0030)", () => {
  it("backs off 10, 20, 40 … minutes up to 6 hours", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(releaseRetryDelayMs)).toEqual([
      10 * MIN, 20 * MIN, 40 * MIN, 80 * MIN, 160 * MIN, 320 * MIN, RELEASE_RETRY_CAP_MS, RELEASE_RETRY_CAP_MS,
    ]);
  });

  it("51 releases, the 50 oldest failing the fee lookup forever: the 51st is executed by the 2nd run; the 50 end failed + one alert each", async () => {
    const orders: PaidOrder[] = [];
    for (let index = 0; index < 51; index += 1) {
      orders.push(await paidPodOrder());
    }
    const failing = orders.slice(0, 50);
    const newest = orders[50] as PaidOrder;
    for (const order of failing) {
      stripe.brokenCharges.add(order.chargeId);
    }
    // Full refunds (a Stripe fact each) in age order: each settlement batch
    // supersedes the dispatch and reserves the release — the 51st youngest.
    const t0 = Date.now();
    for (const [index, order] of orders.entries()) {
      await applyRefundFact(env.DB, {
        amount: PRICE,
        operationId: null,
        paymentIntentId: order.paymentIntentId,
        status: "succeeded",
        stripeRefundId: next("re_starve"),
      }, t0 + index);
    }
    for (const order of orders) {
      await expect(releaseOf(order.orderId)).resolves.toMatchObject({ attempts: 0, state: "reserved" });
    }

    // Run 1: the batch is full of the oldest — which all fail early …
    const t1 = t0 + 1_000;
    await runReconciliation(quietMoneyEnv(), t1);
    // … and are STAMPED even so: attempts, last attempt, a backed-off due time.
    const oldest = await env.DB.prepare(
      "SELECT attempts, last_attempt_at, next_attempt_at, state FROM withholding_releases WHERE order_id = ?",
    )
      .bind(failing[0]?.orderId)
      .first<{ attempts: number; last_attempt_at: string; next_attempt_at: string; state: string }>();
    expect(oldest).toEqual({
      attempts: 1,
      last_attempt_at: new Date(t1).toISOString(),
      next_attempt_at: new Date(t1 + 10 * MIN).toISOString(),
      state: "reserved",
    });

    // Run 2 (the next tick): the never-attempted 51st sorts first.
    await runReconciliation(quietMoneyEnv(), t1 + 15 * MIN);
    await expect(releaseOf(newest.orderId)).resolves.toMatchObject({ state: "succeeded" });
    expect(callsFor(newest.orderId).map((call) => call.amount)).toEqual([WITHHELD]);

    // The 50 keep failing: after MAX_RELEASE_ATTEMPTS each is given up —
    // failed with ONE critical alert, never silently dropped.
    let at = t1 + 15 * MIN;
    for (let run = 0; run < MAX_RELEASE_ATTEMPTS + 5; run += 1) {
      at += RELEASE_RETRY_CAP_MS + MIN;
      await runReconciliation(quietMoneyEnv(), at);
      const open = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM withholding_releases
         WHERE state IN ('reserved', 'submitted') AND order_id IN (${failing.map(() => "?").join(", ")})`,
      )
        .bind(...failing.map((order) => order.orderId))
        .first<{ n: number }>();
      if (open?.n === 0) {
        break;
      }
    }
    // One more run changes nothing for them.
    await runReconciliation(quietMoneyEnv(), at + RELEASE_RETRY_CAP_MS + MIN);

    for (const order of failing) {
      const release = await releaseOf(order.orderId);
      expect(release).toMatchObject({
        attempts: MAX_RELEASE_ATTEMPTS,
        last_error: "attempts_exhausted",
        state: "failed",
        stripe_fee_refund_id: null,
      });
      expect(stripe.feeLookupCalls.filter((charge) => charge === order.chargeId)).toHaveLength(MAX_RELEASE_ATTEMPTS);
      const alerts = await openAlerts("withholding_release_failed", release?.id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ resource_type: "withholding_release", severity: "critical" });
      expect(alerts[0]?.message).toContain(`given up after ${MAX_RELEASE_ATTEMPTS} attempts (last: fee_lookup_failed)`);
      expect(alerts[0]?.message).not.toContain(String(WITHHELD));
      await expect(orderMoney(order.orderId)).resolves.toMatchObject({ withholding_released_minor: 0 } as Record<string, unknown>);
    }
    expect(callsFor(newest.orderId)).toHaveLength(1);
  }, 120_000);

  it("a late Stripe fact for a release given up on is alerted separately, never hidden or recorded", async () => {
    const order = await paidPodOrder();
    await refund(order.orderId, PRICE);
    stripe.feeRefundBehaviour = "reject";
    await runReconciliation(quietMoneyEnv(), Date.now());
    const release = await releaseOf(order.orderId);
    expect(release).toMatchObject({ state: "failed" });

    await postEvent("application_fee.refund.updated", {
      amount: WITHHELD,
      fee: order.feeId,
      id: next("fr_late"),
      metadata: { withholding_release_id: release?.id ?? "" },
      object: "fee_refund",
    });

    expect(await openAlerts("withholding_release_failed", release?.id)).toHaveLength(1);
    const late = await openAlerts("withholding_release_unmatched", release?.id);
    expect(late).toHaveLength(1);
    expect(late[0]?.message).toContain("HAS received it");
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({ state: "failed" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Codex CP2-D2 P2 (round 2) — uncertainty on the final attempt; mismatches
// ═══════════════════════════════════════════════════════════════════════════

describe("Codex P2: the final attempt's uncertainty is reported, and a mismatch is never retried", () => {
  async function releaseOnLastAttempt(): Promise<{ order: PaidOrder; releaseId: string }> {
    const order = await paidPodOrder();
    await refund(order.orderId, PRICE);
    const release = await releaseOf(order.orderId);
    await env.DB.prepare("UPDATE withholding_releases SET attempts = ? WHERE id = ?")
      .bind(MAX_RELEASE_ATTEMPTS - 1, release?.id)
      .run();
    return { order, releaseId: release?.id ?? "" };
  }

  it("a RESERVED row whose final create loses its answer: failed as UNCERTAIN, the alert says list the fee's refunds first", async () => {
    const { order, releaseId } = await releaseOnLastAttempt();
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({ state: "reserved" });
    stripe.loseFeeRefundResponse = true;

    const summary = await runReconciliation(quietMoneyEnv(), Date.now());

    expect(summary.withholding).toMatchObject({ gaveUp: 1 });
    // Stripe DID make it — which is exactly why the text matters.
    expect(stripe.feeRefunds.get(order.feeId)?.map((r) => r.amount)).toEqual([WITHHELD]);
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({
      attempts: MAX_RELEASE_ATTEMPTS,
      last_error: "attempts_exhausted_uncertain",
      state: "failed",
      stripe_application_fee_id: order.feeId,
    });
    const alerts = await openAlerts("withholding_release_failed", releaseId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("critical");
    expect(alerts[0]?.message).toContain("result is UNKNOWN");
    expect(alerts[0]?.message).toContain(`list the refunds of application fee ${order.feeId}`);
    expect(alerts[0]?.message).toContain(`withholding_release_id=${releaseId}`);
    expect(alerts[0]?.message).not.toContain("has not received");
    expect(alerts[0]?.message).not.toContain(String(WITHHELD));

    // When Stripe's own fact arrives, the human is told the shop HAS it.
    const made = stripe.feeRefunds.get(order.feeId)?.[0];
    await postEvent("application_fee.refund.updated", {
      amount: made?.amount,
      fee: order.feeId,
      id: made?.id,
      metadata: made?.metadata,
      object: "fee_refund",
    });
    const late = await openAlerts("withholding_release_unmatched", releaseId);
    expect(late).toHaveLength(1);
    expect(late[0]?.message).toContain("HAS received it");
  });

  it("a RESERVED row whose final attempt never reached a create: failed as certain (no Stripe warning)", async () => {
    const { order, releaseId } = await releaseOnLastAttempt();
    stripe.brokenCharges.add(order.chargeId);

    await runReconciliation(quietMoneyEnv(), Date.now());

    expect(callsFor(order.orderId)).toHaveLength(0);
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({
      last_error: "attempts_exhausted",
      state: "failed",
    });
    const alerts = await openAlerts("withholding_release_failed", releaseId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.message).toContain("no create call ever reached Stripe");
    expect(alerts[0]?.message).not.toContain("UNKNOWN");
  });

  it("a listed refund with this release's id but a DIFFERENT amount fails the release once — never listed or created again", async () => {
    const order = await paidPodOrder();
    await refund(order.orderId, PRICE);
    const release = await releaseOf(order.orderId);
    // An earlier create whose answer was lost; Stripe holds a refund with
    // our id and another amount.
    await env.DB.prepare("UPDATE withholding_releases SET state = 'submitted' WHERE id = ?")
      .bind(release?.id)
      .run();
    stripe.feeRefunds.set(order.feeId, [
      { amount: WITHHELD - 100, fee: order.feeId, id: next("fr_odd"), metadata: { withholding_release_id: release?.id ?? "" } },
    ]);

    const summary = await runReconciliation(quietMoneyEnv(), Date.now());

    expect(summary.withholding).toMatchObject({ failed: 1, released: 0 });
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({
      attempts: 1,
      last_error: "amount_mismatch",
      state: "failed",
      stripe_fee_refund_id: null,
    });
    const alerts = await openAlerts("withholding_release_failed", release?.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("critical");

    for (let run = 1; run <= 3; run += 1) {
      await runReconciliation(quietMoneyEnv(), Date.now() + run * (RELEASE_RETRY_CAP_MS + MIN));
    }
    expect(stripe.listFeeRefundCalls.filter((id) => id === order.feeId)).toHaveLength(1);
    expect(callsFor(order.orderId)).toHaveLength(0);
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({ attempts: 1, state: "failed" });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ withholding_released_minor: 0 } as Record<string, unknown>);
    expect(await openAlerts("withholding_release_failed", release?.id)).toHaveLength(1);
  });

  it("a create RESPONSE with a different amount fails the release once — never created again", async () => {
    const order = await paidPodOrder();
    await refund(order.orderId, PRICE);
    const release = await releaseOf(order.orderId);
    stripe.feeRefundAmountDelta = -1;

    await runReconciliation(quietMoneyEnv(), Date.now());

    await expect(releaseOf(order.orderId)).resolves.toMatchObject({ last_error: "amount_mismatch", state: "failed" });
    expect(await openAlerts("withholding_release_failed", release?.id)).toHaveLength(1);
    for (let run = 1; run <= 3; run += 1) {
      await runReconciliation(quietMoneyEnv(), Date.now() + run * (RELEASE_RETRY_CAP_MS + MIN));
    }
    expect(callsFor(order.orderId)).toHaveLength(1);
    await expect(releaseOf(order.orderId)).resolves.toMatchObject({ attempts: 1, state: "failed" });
    await expect(orderMoney(order.orderId)).resolves.toMatchObject({ withholding_released_minor: 0 } as Record<string, unknown>);
  });
});
