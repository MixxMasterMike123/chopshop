import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { replayDeferred, runReconciliation } from "../src/commerce/crons";
import {
  DISPATCH_HOLD_UNTIL_MS,
  dispatchHeldForPayment,
  noUnappliedDeferredEventsGuard,
} from "../src/commerce/dispatch-hold";
import { collectPages } from "../src/commerce/stripe-client";
import { handleStripeWebhookEvent } from "../src/commerce/webhook";
import { handleScheduled, OUTBOX_SWEEP_CRON } from "../src/outbox/scheduled";
import type { Admin } from "./money-fixtures";
import {
  adminRequest,
  FakeMoneyStripe,
  moneyEnv,
  next,
  openAlerts,
  orderMoney,
  payCheckout,
  paymentEventRow,
  postEvent,
  seedCheckout,
  seedTenant,
  signUpAdmin,
  snapshotJson,
} from "./money-fixtures";

/**
 * Regression tests for the CP2-A review round (report "Codex fixes", round 2):
 *   P2-1  a deferred full refund whose post-order replay failed can no longer
 *         be printed by the next sweep (dispatch HOLD, recorded-path replay,
 *         exported replayDeferred)                     ← reviewer's scratch test
 *   P2-2  a same-second account.updated tie is repaired from Stripe
 *                                                      ← reviewer's scratch test
 *   P3-3  replayDeferred isolates a failing intent
 *   P3-4  re-transfers: v2 idempotency key, found by metadata when group-less
 *   P3-5  0027 clears stripe_account_synced_at
 *   P3-6  collectPages: has_more with an empty page is NOT complete
 *   P3-7  printer cancellations and released holds are nudged
 *   DESIGN  the Connect endpoint's second signing secret
 */

const TENANT = "tenant-review";
const MIN = 60 * 1_000;
const CONNECT_SECRET = "whsec_connect-endpoint-secret-for-tests-only";
let accountId: string;
let admin: Admin;
let stripe: FakeMoneyStripe;

beforeAll(async () => {
  accountId = (await seedTenant(TENANT)) as string;
  admin = await signUpAdmin("review-admin@example.test", TENANT);
});

beforeEach(() => {
  stripe = new FakeMoneyStripe();
});

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A POD checkout whose print file really exists in R2 with the right sha256,
 * so that a dispatch the sweep claimed WOULD reach the fake printer — the
 * failure the hold must make impossible.
 */
async function printableCheckout() {
  const bytes = new TextEncoder().encode(`print-${next("bytes")}`);
  const r2Key = `pod/${TENANT}/print/${next("file")}.png`;
  await env.PRIVATE_BUCKET.put(r2Key, bytes, {
    sha256: await crypto.subtle.digest("SHA-256", bytes),
  });
  const snapshot = JSON.stringify({
    lines: [
      {
        lineNo: 1,
        printFiles: [{ heightMm: 350, r2Key, sha256: await sha256Hex(bytes), slot: "front", widthMm: 250 }],
        productionCostMinor: 9_840,
        quantity: 1,
        sku: "2500170",
        withholdMinor: 12_300,
      },
    ],
    printer: "fake-printer",
    totals: { productionCostMinor: 9_840, withholdMinor: 12_300 },
  });
  const checkout = await seedCheckout({
    connect: { accountId, feeMinor: 13_300, withheldMinor: 12_300 },
    snapshot,
    tenantId: TENANT,
    unitPriceMinor: 20_000,
  });
  stripe.addIntent({ amount: 20_000, id: checkout.paymentIntentId as string, status: "succeeded" });
  return checkout;
}

/** env.DB, except the FIRST read of unapplied parked facts fails. */
function flakyReplayDb(): D1Database {
  let failed = false;
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (!failed && sql.includes("FROM deferred_payment_events") && sql.includes("applied_at IS NULL")
            && sql.includes("ORDER BY created_at")) {
            failed = true;
            throw new Error("D1_ERROR: transient");
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as Function).bind(target) : value;
    },
  }) as D1Database;
}

function refundObject(id: string, amount: number, paymentIntentId: string, status = "succeeded") {
  return { amount, currency: "sek", id, metadata: {}, object: "refund", payment_intent: paymentIntentId, status };
}

/** The order webhook, through a DB whose post-order replay fails once. */
async function payWithFailedReplay(checkout: Awaited<ReturnType<typeof printableCheckout>>, now = Date.now()) {
  const pi = checkout.paymentIntentId as string;
  const result = await handleStripeWebhookEvent(
    flakyReplayDb(),
    {
      created: Math.floor(now / 1_000),
      data: {
        object: {
          amount: checkout.totalMinor,
          currency: "sek",
          id: pi,
          metadata: { checkout_id: checkout.checkoutId, tenant_id: TENANT },
          object: "payment_intent",
          status: "succeeded",
        },
      },
      id: next("evt_pay"),
      type: "payment_intent.succeeded",
    },
    now,
  );
  expect(result.outcome).toBe("processed");
  const row = await env.DB.prepare("SELECT order_id FROM orders WHERE payment_intent_id = ?")
    .bind(pi)
    .first<{ order_id: string }>();
  return row!.order_id;
}

async function dispatchOf(orderId: string) {
  return env.DB.prepare(
    `SELECT outbox_id, status, cancel_requested, next_attempt_at, attempts
     FROM outbox_events WHERE event_type = 'dispatch' AND aggregate_id = ?`,
  )
    .bind(orderId)
    .first<{ attempts: number; cancel_requested: number; next_attempt_at: number; outbox_id: string; status: string }>();
}

async function printerJobs(orderId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM fake_printer_jobs WHERE order_id = ?")
    .bind(orderId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A queue that records what was sent. */
function recordingQueue() {
  const sent: string[] = [];
  const queue = {
    async send(body: { outboxId: string }) {
      sent.push(body.outboxId);
    },
    async sendBatch(messages: Array<{ body: { outboxId: string } }>) {
      for (const message of messages) {
        sent.push(message.body.outboxId);
      }
    },
  } as unknown as Queue;
  return { queue, sent };
}

// ═══════════════════════════════════════════════════════════════════════════
// P2-1
// ═══════════════════════════════════════════════════════════════════════════

describe("P2-1: a deferred full refund can never be printed by the next sweep", () => {
  it("THE REVIEWER'S CASE: failed post-order replay, then a scheduled tick (sweep first)", async () => {
    const checkout = await printableCheckout();
    const pi = checkout.paymentIntentId as string;
    expect((await postEvent("refund.created", refundObject(next("re"), 20_000, pi))).response.status).toBe(200);

    const now = Date.now();
    const orderId = await payWithFailedReplay(checkout, now);

    // The replay failed: the refund is not applied — and the job is HELD.
    await expect(orderMoney(orderId)).resolves.toMatchObject({ refund_succeeded_minor: 0, status: "paid" });
    await expect(dispatchOf(orderId)).resolves.toMatchObject({
      next_attempt_at: DISPATCH_HOLD_UNTIL_MS,
      status: "pending",
    });
    await expect(dispatchHeldForPayment(env.DB, orderId)).resolves.toBe(true);

    // The tick: CP2-B's sweep runs FIRST, then reconciliation.
    await handleScheduled({ cron: OUTBOX_SWEEP_CRON, scheduledTime: now + MIN }, moneyEnv(stripe));

    await expect(orderMoney(orderId)).resolves.toMatchObject({
      refund_succeeded_minor: 20_000,
      status: "refunded",
    });
    await expect(dispatchOf(orderId)).resolves.toMatchObject({ attempts: 0, status: "superseded" });
    expect(await printerJobs(orderId)).toBe(0);
    const cancellations = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox_events WHERE event_type = 'printer_cancellation' AND aggregate_id = ?",
    )
      .bind(orderId)
      .first<{ n: number }>();
    expect(cancellations?.n).toBe(0);
  });

  it("a redelivered parked refund event replays on the recorded path", async () => {
    const checkout = await printableCheckout();
    const pi = checkout.paymentIntentId as string;
    const refund = refundObject(next("re"), 20_000, pi);
    const early = await postEvent("refund.created", refund);
    const orderId = await payWithFailedReplay(checkout);

    const again = await postEvent("refund.created", refund, { eventId: early.eventId });

    expect(again.response.status).toBe(200);
    await expect(orderMoney(orderId)).resolves.toMatchObject({ refund_succeeded_minor: 20_000 });
    await expect(dispatchOf(orderId)).resolves.toMatchObject({ status: "superseded" });
  });

  it("replayDeferred (for scheduled(), before the sweep) applies and supersedes", async () => {
    const checkout = await printableCheckout();
    await postEvent("refund.created", refundObject(next("re"), 20_000, checkout.paymentIntentId as string));
    const orderId = await payWithFailedReplay(checkout);

    const summary = await replayDeferred(moneyEnv(stripe), Date.now());

    expect(summary).toMatchObject({ errors: 0 });
    expect(summary.replayed).toBeGreaterThanOrEqual(1);
    await expect(orderMoney(orderId)).resolves.toMatchObject({ status: "refunded" });
    await expect(dispatchOf(orderId)).resolves.toMatchObject({ status: "superseded" });
  });

  it("a PARTIAL parked refund releases the hold once applied, and the release is nudged", async () => {
    const checkout = await printableCheckout();
    await postEvent("refund.created", refundObject(next("re"), 5_000, checkout.paymentIntentId as string));
    const orderId = await payWithFailedReplay(checkout);
    await expect(dispatchOf(orderId)).resolves.toMatchObject({ next_attempt_at: DISPATCH_HOLD_UNTIL_MS });

    const { queue, sent } = recordingQueue();
    const now = Date.now();
    await replayDeferred(moneyEnv(stripe, { OUTBOX_QUEUE: queue }), now);

    const dispatch = await dispatchOf(orderId);
    expect(dispatch).toMatchObject({ next_attempt_at: now, status: "pending" });
    expect(sent).toContain(dispatch?.outbox_id);
    await expect(dispatchHeldForPayment(env.DB, orderId)).resolves.toBe(false);
  });

  it("an order committed between the deferral's read and write is held by the deferral itself", async () => {
    const checkout = await printableCheckout();
    const pi = checkout.paymentIntentId as string;
    let orderId: string | null = null;
    let firstBatch = true;
    let replayRead = false;
    // Before the deferral batch: the whole order webhook commits (its replay
    // finds nothing parked yet). After it: the deferral's own replay fails.
    const racing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (firstBatch) {
              firstBatch = false;
              orderId = await payCheckout(checkout, TENANT);
            }
            return target.batch(statements);
          };
        }
        if (property === "prepare") {
          return (sql: string) => {
            if (!firstBatch && !replayRead && sql.includes("ORDER BY created_at")) {
              replayRead = true;
              throw new Error("D1_ERROR: transient");
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as Function).bind(target) : value;
      },
    }) as D1Database;

    await expect(
      handleStripeWebhookEvent(
        racing,
        {
          created: Math.floor(Date.now() / 1_000),
          data: { object: refundObject(next("re_race"), 20_000, pi) },
          id: next("evt_race"),
          type: "refund.created",
        },
        Date.now(),
      ),
    ).rejects.toThrow(/transient/);

    await expect(dispatchOf(orderId as unknown as string)).resolves.toMatchObject({
      next_attempt_at: DISPATCH_HOLD_UNTIL_MS,
      status: "pending",
    });
  });

  it("charge.refunded with unexplained refunds holds the job; the refund that explains it releases", async () => {
    const checkout = await printableCheckout();
    const pi = checkout.paymentIntentId as string;
    const orderId = await payCheckout(checkout, TENANT);
    await expect(dispatchOf(orderId)).resolves.toMatchObject({ status: "pending" });

    await postEvent("charge.refunded", { amount: 20_000, amount_refunded: 6_000, id: next("ch"), payment_intent: pi });
    await expect(dispatchOf(orderId)).resolves.toMatchObject({ next_attempt_at: DISPATCH_HOLD_UNTIL_MS });

    await postEvent("refund.created", refundObject(next("re"), 6_000, pi));
    const dispatch = await dispatchOf(orderId);
    expect(dispatch?.status).toBe("pending");
    expect(dispatch?.next_attempt_at).toBeLessThan(DISPATCH_HOLD_UNTIL_MS);
  });

  it("the exported guard is the same condition, as SQL", async () => {
    const checkout = await printableCheckout();
    await postEvent("refund.created", refundObject(next("re"), 1_000, checkout.paymentIntentId as string));
    const orderId = await payWithFailedReplay(checkout);
    const guard = noUnappliedDeferredEventsGuard(orderId);
    const check = async () =>
      (await env.DB.prepare(`SELECT ${guard.sql} AS ok`).bind(...guard.binds).first<{ ok: number }>())?.ok;

    expect(await check()).toBe(0);
    await replayDeferred(moneyEnv(stripe), Date.now());
    expect(await check()).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2-2
// ═══════════════════════════════════════════════════════════════════════════

describe("P2-2: a same-second account.updated tie is repaired from Stripe", () => {
  async function freshShop() {
    const tenantId = next("tenant-tie").toLowerCase().replace(/_/g, "-");
    const account = (await seedTenant(tenantId, { chargesEnabled: false, payoutsEnabled: false })) as string;
    return { account, tenantId };
  }

  async function state(tenantId: string) {
    return env.DB.prepare(
      `SELECT stripe_charges_enabled AS c, stripe_payouts_enabled AS p,
              stripe_account_resync_needed AS r FROM tenants WHERE tenant_id = ?`,
    )
      .bind(tenantId)
      .first<{ c: number; p: number; r: number }>();
  }

  it("THE REVIEWER'S CASE: onboarding burst in one second, then reconciliation", async () => {
    const { account, tenantId } = await freshShop();
    const s = Math.floor(Date.now() / 1_000);
    await postEvent("account.updated", { charges_enabled: false, id: account, payouts_enabled: false }, { created: s });
    await postEvent(
      "account.updated",
      { charges_enabled: true, details_submitted: true, id: account, payouts_enabled: true },
      { created: s },
    );

    // Fail-closed now, but marked.
    await expect(state(tenantId)).resolves.toEqual({ c: 0, p: 0, r: 1 });

    stripe.accounts.set(account, { charges_enabled: true, details_submitted: true, id: account, payouts_enabled: true });
    const summary = await runReconciliation(moneyEnv(stripe), Date.now());

    expect(summary.accounts).toEqual({ errors: 0, resynced: 1 });
    await expect(state(tenantId)).resolves.toEqual({ c: 1, p: 1, r: 0 });
    // Nothing left to do next run.
    await runReconciliation(moneyEnv(stripe), Date.now());
    expect(stripe.retrieveAccountCalls.filter((id) => id === account)).toHaveLength(1);
  });

  it("alerts when the account cannot be re-read, and keeps trying", async () => {
    const { account, tenantId } = await freshShop();
    const s = Math.floor(Date.now() / 1_000);
    await postEvent("account.updated", { charges_enabled: true, id: account, payouts_enabled: true }, { created: s });
    await postEvent("account.updated", { charges_enabled: false, id: account, payouts_enabled: true }, { created: s });
    stripe.accountBehaviour = "unavailable";

    const summary = await runReconciliation(moneyEnv(stripe), Date.now());

    expect(summary.accounts.errors).toBe(1);
    expect(await openAlerts("connect_account_resync_failed", tenantId)).toHaveLength(1);
    await expect(state(tenantId)).resolves.toMatchObject({ r: 1 });
  });

  it("an identical same-second duplicate needs no resync", async () => {
    const { account, tenantId } = await freshShop();
    const s = Math.floor(Date.now() / 1_000);
    const body = { charges_enabled: true, id: account, payouts_enabled: true };
    await postEvent("account.updated", body, { created: s });
    await postEvent("account.updated", body, { created: s });

    await expect(state(tenantId)).resolves.toEqual({ c: 1, p: 1, r: 0 });
  });

  it("a newer ordered event clears a pending resync, and the resync never overwrites it", async () => {
    const { account, tenantId } = await freshShop();
    const s = Math.floor(Date.now() / 1_000);
    await postEvent("account.updated", { charges_enabled: true, id: account, payouts_enabled: true }, { created: s });
    await postEvent("account.updated", { charges_enabled: false, id: account, payouts_enabled: true }, { created: s });
    await expect(state(tenantId)).resolves.toMatchObject({ r: 1 });

    await postEvent("account.updated", { charges_enabled: true, id: account, payouts_enabled: false }, { created: s + 5 });
    await expect(state(tenantId)).resolves.toEqual({ c: 1, p: 0, r: 0 });

    stripe.accounts.set(account, { charges_enabled: false, details_submitted: false, id: account, payouts_enabled: false });
    await runReconciliation(moneyEnv(stripe), Date.now());
    expect(stripe.retrieveAccountCalls).not.toContain(account);
    await expect(state(tenantId)).resolves.toEqual({ c: 1, p: 0, r: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P3-3 … P3-7
// ═══════════════════════════════════════════════════════════════════════════

describe("P3-3: replayDeferred isolates a failing intent", () => {
  it("counts the failure and still replays the others", async () => {
    const bad = await printableCheckout();
    const good = await printableCheckout();
    await postEvent("refund.created", refundObject(next("re"), 1_000, bad.paymentIntentId as string));
    await postEvent("refund.created", refundObject(next("re"), 2_000, good.paymentIntentId as string));
    const badOrder = await payWithFailedReplay(bad);
    const goodOrder = await payWithFailedReplay(good);

    const badPi = bad.paymentIntentId as string;
    const selective = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("ORDER BY created_at")) {
              return statement;
            }
            return new Proxy(statement, {
              get(inner, key) {
                if (key === "bind") {
                  return (...binds: unknown[]) => {
                    if (binds[0] === badPi) {
                      throw new Error("D1_ERROR: this intent is broken");
                    }
                    return inner.bind(...binds);
                  };
                }
                const value = Reflect.get(inner, key) as unknown;
                return typeof value === "function" ? (value as Function).bind(inner) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as Function).bind(target) : value;
      },
    }) as D1Database;

    const summary = await replayDeferred({ ...moneyEnv(stripe), DB: selective } as Env, Date.now());

    expect(summary.errors).toBe(1);
    await expect(orderMoney(goodOrder)).resolves.toMatchObject({ refund_succeeded_minor: 2_000 });
    await expect(orderMoney(badOrder)).resolves.toMatchObject({ refund_succeeded_minor: 0 });
  });
});

describe("P3-4: re-transfers use a v2 key and are found by metadata when group-less", () => {
  it("finds an earlier group-less re-transfer among the transfers to the shop", async () => {
    const checkout = await seedCheckout({
      connect: { accountId, feeMinor: 1_000, withheldMinor: 0 },
      tenantId: TENANT,
      unitPriceMinor: 20_000,
    });
    const chargeId = next("ch");
    const orderId = await payCheckout(checkout, TENANT, { latestCharge: chargeId });
    const pi = checkout.paymentIntentId as string;
    stripe.addCharge({ id: chargeId, payment_intent: pi, transfer: next("tr_src") }, 20_000);
    const dispute = (status: string) => ({ amount: 20_000, charge: chargeId, id: "dp_review_v1", payment_intent: pi, status });
    await postEvent("charge.dispute.created", dispute("needs_response"));
    await runReconciliation(moneyEnv(stripe), Date.now());
    await postEvent("charge.dispute.closed", dispute("won"));
    // What an older version sent before transfers carried a group.
    stripe.addTransfer(accountId, {
      amount: 20_000,
      id: next("tr_old"),
      metadata: { dispute_id: "dp_review_v1", order_id: orderId, reason: "dispute_won_retransfer" },
    });

    await runReconciliation(moneyEnv(stripe), Date.now());

    expect(stripe.transferCalls).toHaveLength(0);
    await expect(orderMoney(orderId)).resolves.toMatchObject({
      dispute_recovery: "returned_won",
      dispute_retransferred_minor: 20_000,
    });
  });
});

describe("P3-5: 0027 clears stripe_account_synced_at", () => {
  it("the migration resets the column whose meaning changed", () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0027"));
    expect(migration?.queries.join("\n")).toMatch(/UPDATE tenants SET stripe_account_synced_at = NULL/);
  });
});

describe("P3-6: collectPages", () => {
  it("has_more with an empty page is NOT complete", async () => {
    await expect(
      collectPages(async () => ({ data: [] as Array<{ id: string }>, hasMore: true }), 5),
    ).resolves.toEqual({ complete: false, data: [] });
  });
});

describe("P3-7: printer cancellations are nudged", () => {
  it("a full refund of an accepted job nudges its printer_cancellation from the refund route", async () => {
    const checkout = await printableCheckout();
    const orderId = await payCheckout(checkout, TENANT);
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE outbox_events SET status = 'claimed', claimed_by = 'claim-token-0123456789',
         claim_expires_at = ?, attempts = 1, updated_at = ?
       WHERE event_type = 'dispatch' AND aggregate_id = ?`,
    )
      .bind(now + MIN, now, orderId)
      .run();
    await env.DB.prepare(
      `UPDATE outbox_events SET status = 'done', submitted_at = ?, resolved_at = ?, result_ref = 'job',
         claimed_by = NULL, claim_expires_at = NULL, updated_at = ?
       WHERE event_type = 'dispatch' AND aggregate_id = ?`,
    )
      .bind(now, now, now, orderId)
      .run();
    const { queue, sent } = recordingQueue();

    const response = await worker.fetch(
      adminRequest(`/v1/admin/orders/${orderId}/refunds`, "POST", {
        body: { amountMinor: 20_000, reason: "printed by mistake" },
        cookie: admin.cookie,
        shopId: TENANT,
      }),
      moneyEnv(stripe, { OUTBOX_QUEUE: queue }),
    );

    expect(response.status).toBe(201);
    const cancellation = await env.DB.prepare(
      "SELECT outbox_id FROM outbox_events WHERE event_type = 'printer_cancellation' AND aggregate_id = ?",
    )
      .bind(orderId)
      .first<{ outbox_id: string }>();
    expect(cancellation).not.toBeNull();
    expect(sent).toContain(cancellation?.outbox_id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DESIGN
// ═══════════════════════════════════════════════════════════════════════════

describe("DESIGN: the Connect endpoint's signing secret on the same route", () => {
  const connectEnv = () => moneyEnv(stripe, { STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_SECRET });

  async function shopWithFlags() {
    const tenantId = next("tenant-connect").toLowerCase().replace(/_/g, "-");
    const account = (await seedTenant(tenantId, { chargesEnabled: false, payoutsEnabled: false })) as string;
    return { account, tenantId };
  }

  it("verifies and applies account.updated signed by the Connect secret", async () => {
    const { account, tenantId } = await shopWithFlags();

    const { eventId, response } = await postEvent(
      "account.updated",
      { charges_enabled: true, id: account, payouts_enabled: true },
      { account, env: connectEnv(), secret: CONNECT_SECRET },
    );

    expect(response.status).toBe(200);
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({ outcome: "processed", tenant_id: tenantId });
    const row = await env.DB.prepare("SELECT stripe_charges_enabled AS c FROM tenants WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
  });

  it("ignores a platform event signed by the Connect secret (200, ledger ignored_wrong_endpoint)", async () => {
    const checkout = await printableCheckout();
    const orderId = await payCheckout(checkout, TENANT);

    const { eventId, response } = await postEvent(
      "refund.created",
      refundObject(next("re"), 20_000, checkout.paymentIntentId as string),
      { account: accountId, env: connectEnv(), secret: CONNECT_SECRET },
    );

    expect(response.status).toBe(200);
    await expect(paymentEventRow(eventId)).resolves.toMatchObject({
      outcome: "ignored",
      reason_code: "ignored_wrong_endpoint",
    });
    await expect(orderMoney(orderId)).resolves.toMatchObject({ refund_succeeded_minor: 0 });
  });

  it("rejects a Connect account.updated whose event.account is not the account it describes", async () => {
    const { account, tenantId } = await shopWithFlags();

    const { eventId } = await postEvent(
      "account.updated",
      { charges_enabled: true, id: account, payouts_enabled: true },
      { account: "acct_someoneelse", env: connectEnv(), secret: CONNECT_SECRET },
    );

    await expect(paymentEventRow(eventId)).resolves.toMatchObject({ outcome: "rejected" });
    const row = await env.DB.prepare("SELECT stripe_charges_enabled AS c FROM tenants WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it("refuses a Connect-signed event with 400 when no Connect secret is configured", async () => {
    const { account } = await shopWithFlags();
    const { response } = await postEvent(
      "account.updated",
      { charges_enabled: true, id: account },
      { account, env: moneyEnv(stripe), secret: CONNECT_SECRET },
    );
    expect(response.status).toBe(400);
  });

  it("still accepts platform-signed events, and refuses an unknown secret, with both configured", async () => {
    const checkout = await printableCheckout();
    const orderId = await payCheckout(checkout, TENANT);
    const platform = await postEvent(
      "refund.created",
      refundObject(next("re"), 4_000, checkout.paymentIntentId as string),
      { env: connectEnv() },
    );
    expect(platform.response.status).toBe(200);
    await expect(orderMoney(orderId)).resolves.toMatchObject({ refund_succeeded_minor: 4_000 });

    const forged = await postEvent("account.updated", { id: accountId }, {
      env: connectEnv(),
      secret: "whsec_nobody-holds-this-secret-value",
    });
    expect(forged.response.status).toBe(400);
  });
});
