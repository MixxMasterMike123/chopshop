import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  balanceIn,
  commissionBaseMinor,
  commissionMinor,
  readBalances,
} from "../src/affiliate/ledger";
import { createCheckout, type CreateCheckoutInput } from "../src/commerce/checkout";
import { WITHDRAWAL_WINDOW_MS } from "../src/commerce/payouts";
import { applyRefundFact } from "../src/commerce/refunds";
import { guardedAccrual } from "../src/commerce/webhook";
import { MAX_VAT_SAFE_TOTAL_MINOR } from "../src/commerce/shipping";
import { cancelOrder } from "../src/dispatch/cancellation";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  count,
  featureStatement,
  ledgerOfOrder,
  nextId,
  seedAccess,
  seedAffiliate,
  seedUser,
} from "./affiliate-fixtures";
import { seedPlainProduct, seedShop } from "./discount-fixtures";
import { payCheckout, postEvent } from "./money-fixtures";

/**
 * CP13 — the commission ledger (design §4): the accrual in the order batch
 * from frozen facts, the reversal that follows the money (refund transitions
 * of every origin, a lost dispute), and the balances per currency. Every
 * order here is made by the real checkout and paid by the real webhook.
 */

const SHOP = "aff-ledger";
const ZERO = "aff-ledger-zero";
const CONTEXT: TenantContext = { domainKind: "storefront", hostname: "aff-ledger.test", tenantId: SHOP };
const DAY_MS = 24 * 60 * 60 * 1_000;

let affiliateId = "";
let affiliateEmail = "";

function input(overrides: Partial<CreateCheckoutInput> = {}): CreateCheckoutInput {
  return {
    deliveryMethod: "pickup",
    discountCode: null,
    email: `${nextId("buyer")}@buyer.test`,
    idempotencyKey: nextId("idem"),
    items: [{ productId: `${SHOP}-goods`, quantity: 1 }],
    refCode: "LEDGER10",
    shippingCountry: null,
    ...overrides,
  };
}

/** A paid affiliate order (500 kr goods, 10 % off → 450 kr). */
async function paidOrder(
  overrides: Partial<CreateCheckoutInput> = {},
  context: TenantContext = CONTEXT,
): Promise<{ checkoutId: string; intent: string; orderId: string; totalMinor: number }> {
  const created = await createCheckout(env.DB, context, input(overrides), Date.now());
  if (created.status !== "ok") {
    throw new Error(created.status);
  }
  const intent = `pi_ledger_${created.checkout.checkoutId.replaceAll("-", "")}`;
  await env.DB.prepare("UPDATE checkouts SET payment_intent_id = ? WHERE checkout_id = ?")
    .bind(intent, created.checkout.checkoutId)
    .run();
  const orderId = await payCheckout(
    { checkoutId: created.checkout.checkoutId, paymentIntentId: intent, totalMinor: created.checkout.totalMinor },
    context.tenantId,
  );
  return { checkoutId: created.checkout.checkoutId, intent, orderId, totalMinor: created.checkout.totalMinor };
}

/** A Stripe refund id's shape (no hyphen). */
function refundIdOf(prefix: string): string {
  return nextId(prefix).replaceAll("-", "_");
}

async function refund(intent: string, refundId: string, amount: number, status = "succeeded") {
  return applyRefundFact(env.DB, { amount, operationId: null, paymentIntentId: intent, status, stripeRefundId: refundId }, Date.now());
}

function amounts(rows: Array<{ amount_minor: number; kind: string }>): Array<[string, number]> {
  return rows.map((row) => [row.kind, row.amount_minor]);
}

async function sum(orderId: string): Promise<number> {
  return (await ledgerOfOrder(orderId)).reduce((total, row) => total + row.amount_minor, 0);
}

beforeAll(async () => {
  await seedShop(SHOP, "aff-ledger.test", { discountCodes: false });
  await seedPlainProduct(SHOP, `${SHOP}-goods`, 50_000);
  await featureStatement(SHOP, "affiliate", true).run();
  affiliateEmail = "ledger-aff@affiliate.test";
  const userId = await seedUser(affiliateEmail);
  await seedAccess(userId, "affiliate");
  affiliateId = (await seedAffiliate({ code: "LEDGER10", tenantId: SHOP, userId })).affiliateId;

  await seedShop(ZERO, "aff-ledger-zero.test", { discountCodes: false });
  await seedPlainProduct(ZERO, `${ZERO}-goods`, 50_000);
  await featureStatement(ZERO, "affiliate", true).run();
  await env.DB.prepare("UPDATE tenants SET vat_rate_bp = 0 WHERE tenant_id = ?").bind(ZERO).run();
  await seedAffiliate({ code: "ZEROVAT", tenantId: ZERO });
});

describe("the formula (design §4.1)", () => {
  it("is the worked example to the öre: 47 900 with 2 900 shipping at 25 % → 5 400", () => {
    expect(commissionBaseMinor(47_900, 2_900, 2_500)).toBe(36_000);
    expect(commissionMinor({ commissionBp: 1_500, shippingMinor: 2_900, totalMinor: 47_900, vatRateBp: 2_500 })).toBe(5_400);
  });

  it("rounds half-up on the öre, uses the order's own VAT rate, never goes negative", () => {
    // 12 % on goods 11 200 → base 10 000; 0,5 öre rounds up.
    expect(commissionMinor({ commissionBp: 1_255, shippingMinor: 0, totalMinor: 400, vatRateBp: 0 })).toBe(50);
    expect(commissionBaseMinor(11_200, 0, 1_200)).toBe(10_000);
    expect(commissionBaseMinor(10_000, 0, 0)).toBe(10_000);
    expect(commissionBaseMinor(2_000, 2_900, 2_500)).toBe(0);
    expect(commissionMinor({ commissionBp: 0, shippingMinor: 0, totalMinor: 10_000, vatRateBp: 2_500 })).toBe(0);
  });

  it("refuses a total outside the exact-arithmetic range rather than answer", () => {
    expect(() =>
      commissionMinor({ commissionBp: 1_500, shippingMinor: 0, totalMinor: MAX_VAT_SAFE_TOTAL_MINOR + 1, vatRateBp: 2_500 }),
    ).toThrow(RangeError);
    expect(commissionMinor({ commissionBp: 10_000, shippingMinor: 0, totalMinor: MAX_VAT_SAFE_TOTAL_MINOR, vatRateBp: 0 })).toBe(
      MAX_VAT_SAFE_TOTAL_MINOR,
    );
  });
});

describe("round 1: an accrual the formula refuses never aborts the order", () => {
  it("out of range: no accrual statement, a critical affiliate_accrual_failed alert instead (in the order batch)", async () => {
    const orderId = `order-out-of-range-${Date.now()}`;
    const facts = {
      affiliateId,
      commissionBp: 1_500,
      orderId,
      paidAt: Date.now(),
      shippingMinor: 0,
      tenantId: SHOP,
      totalMinor: MAX_VAT_SAFE_TOTAL_MINOR + 1,
      vatRateBp: 2_500,
    };
    let result: ReturnType<typeof guardedAccrual> | undefined;
    expect(() => {
      result = guardedAccrual(env.DB, facts, Date.now());
    }).not.toThrow();
    expect(result?.accrual).toBeNull();
    expect(result?.alert).not.toBeNull();
    await result?.alert?.run();
    const alert = await env.DB.prepare("SELECT kind, severity, resource_type, tenant_id FROM alerts WHERE resource_id = ?")
      .bind(orderId)
      .first();
    expect(alert).toEqual({ kind: "affiliate_accrual_failed", resource_type: "order", severity: "critical", tenant_id: SHOP });
    // In range: the ordinary statement, no alert.
    const fine = guardedAccrual(env.DB, { ...facts, totalMinor: 47_900, shippingMinor: 2_900 }, Date.now());
    expect(fine.alert).toBeNull();
    expect(fine.accrual?.amountMinor).toBe(5_400);
  });
});

describe("the accrual, in the order batch", () => {
  it("lands with the order: 5 400 öre, the order's currency, available 14 days after payment, and its mail", async () => {
    const order = await paidOrder();
    const rows = await ledgerOfOrder(order.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      affiliate_id: affiliateId,
      amount_minor: 5_400,
      created_by: "system",
      currency: "SEK",
      formula_version: 1,
      kind: "accrual",
      order_id: order.orderId,
      ref: order.orderId,
    });
    const paidAt = await env.DB.prepare("SELECT paid_at FROM orders WHERE order_id = ?")
      .bind(order.orderId)
      .first<{ paid_at: number }>();
    expect(rows[0]?.available_at).toBe(new Date((paidAt?.paid_at ?? 0) + WITHDRAWAL_WINDOW_MS).toISOString());
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM outbox_events WHERE dedupe_key = ? AND event_type = 'email' AND aggregate_id = ?",
        `email:affiliate_conversion:${order.orderId}`,
        order.orderId,
      ),
    ).toBe(1);
  });

  it("a replayed delivery inserts nothing", async () => {
    const order = await paidOrder();
    await payCheckout({ checkoutId: order.checkoutId, paymentIntentId: order.intent, totalMinor: order.totalMinor }, SHOP);
    expect(await ledgerOfOrder(order.orderId)).toHaveLength(1);
  });

  it("is computed at the tenant's own rate: a zero-rated shop's base is its goods", async () => {
    const order = await paidOrder(
      { items: [{ productId: `${ZERO}-goods`, quantity: 1 }], refCode: "ZEROVAT" },
      { domainKind: "storefront", hostname: "aff-ledger-zero.test", tenantId: ZERO },
    );
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([["accrual", 6_750]]);
  });

  it("a 0 % affiliate (commission only) earns on the undiscounted base", async () => {
    await seedAffiliate({ code: "NODISC", discountBp: 0, tenantId: SHOP });
    const order = await paidOrder({ refCode: "NODISC" });
    expect(order.totalMinor).toBe(50_000);
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([["accrual", 6_000]]);
  });

  it("a self-referral accrues nothing (the buyer keeps the discount)", async () => {
    const order = await paidOrder({ email: affiliateEmail });
    expect(order.totalMinor).toBe(45_000);
    expect(await ledgerOfOrder(order.orderId)).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM outbox_events WHERE dedupe_key = ?", `email:affiliate_conversion:${order.orderId}`)).toBe(0);
  });

  it("honours the frozen facts: the add-on switched off and the affiliate suspended after the quote still accrue", async () => {
    const created = await createCheckout(env.DB, CONTEXT, input(), Date.now());
    if (created.status !== "ok") {
      throw new Error(created.status);
    }
    await featureStatement(SHOP, "affiliate", false).run();
    await env.DB.prepare("UPDATE affiliates SET status = 'suspended', commission_bp = 9000 WHERE affiliate_id = ?").bind(affiliateId).run();
    const intent = `pi_ledger_${created.checkout.checkoutId.replaceAll("-", "")}`;
    await env.DB.prepare("UPDATE checkouts SET payment_intent_id = ? WHERE checkout_id = ?").bind(intent, created.checkout.checkoutId).run();
    const orderId = await payCheckout({ checkoutId: created.checkout.checkoutId, paymentIntentId: intent, totalMinor: 45_000 }, SHOP);
    expect(amounts(await ledgerOfOrder(orderId))).toEqual([["accrual", 5_400]]);
    await featureStatement(SHOP, "affiliate", true).run();
    await env.DB.prepare("UPDATE affiliates SET status = 'active', commission_bp = 1500 WHERE affiliate_id = ?").bind(affiliateId).run();
  });
});

describe("the reversal follows the money (design §4.2)", () => {
  it("partial ×2 then full: the reversals sum exactly to the accrual", async () => {
    const order = await paidOrder();
    await refund(order.intent, refundIdOf("re"), 10_000);
    await refund(order.intent, refundIdOf("re"), 15_000);
    await refund(order.intent, refundIdOf("re"), 20_000);
    // 45 000 charged: 10 000 → 2 222 bp → 1 200; 25 000 → 5 555 → 3 000; 45 000 → 10 000 → 5 400.
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([
      ["accrual", 5_400],
      ["reversal", -1_200],
      ["reversal", -1_800],
      ["reversal", -2_400],
    ]);
    expect(await sum(order.orderId)).toBe(0);
    // Each reversal is keyed on its refund TRANSITION, with its mail.
    const reversals = (await ledgerOfOrder(order.orderId)).filter((row) => row.kind === "reversal");
    const transitions = await env.DB.prepare("SELECT transition_id FROM refund_operations WHERE order_id = ? ORDER BY created_at, id")
      .bind(order.orderId)
      .all<{ transition_id: string }>();
    expect(reversals.map((row) => row.ref).sort()).toEqual(transitions.results.map((row) => row.transition_id).sort());
    for (const row of reversals) {
      expect(await count("SELECT COUNT(*) AS n FROM outbox_events WHERE dedupe_key = ?", `email:affiliate_reversal:${row.entry_id}`)).toBe(1);
    }
  });

  it("a dashboard refund (a fact this worker never asked for) reverses, and its replay reverses nothing more", async () => {
    const order = await paidOrder();
    const refundId = refundIdOf("re_dash");
    expect((await refund(order.intent, refundId, 45_000)).result).toBe("applied");
    expect((await refund(order.intent, refundId, 45_000)).result).toBe("unchanged");
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([
      ["accrual", 5_400],
      ["reversal", -5_400],
    ]);
  });

  it("a pending refund reverses nothing until it settles", async () => {
    const order = await paidOrder();
    const refundId = refundIdOf("re_pend");
    await refund(order.intent, refundId, 22_500, "pending");
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([["accrual", 5_400]]);
    await refund(order.intent, refundId, 22_500, "succeeded");
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([
      ["accrual", 5_400],
      ["reversal", -2_700],
    ]);
  });

  it("succeeded → failed restores the commission with a POSITIVE reversal, and the refund batch commits", async () => {
    const order = await paidOrder();
    const refundId = refundIdOf("re_fail");
    await refund(order.intent, refundId, 45_000);
    expect((await refund(order.intent, refundId, 45_000, "failed")).result).toBe("applied");
    const money = await env.DB.prepare("SELECT refund_succeeded_minor FROM orders WHERE order_id = ?")
      .bind(order.orderId)
      .first<{ refund_succeeded_minor: number }>();
    expect(money?.refund_succeeded_minor).toBe(0);
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([
      ["accrual", 5_400],
      ["reversal", -5_400],
      ["reversal", 5_400],
    ]);
  });

  it("a lost dispute after a partial refund reverses the rest; a late refund failure keeps the full reversal", async () => {
    const order = await paidOrder();
    const refundId = refundIdOf("re_part");
    await refund(order.intent, refundId, 9_000);
    const dispute = (status: string) => ({
      amount: 36_000,
      currency: "sek",
      id: `dp_${order.orderId.replaceAll("-", "").slice(0, 12)}`,
      object: "dispute",
      payment_intent: order.intent,
      reason: "fraudulent",
      status,
    });
    await postEvent("charge.dispute.created", dispute("needs_response"));
    // Open: nothing more is reversed.
    expect(await sum(order.orderId)).toBe(5_400 - 1_080);
    await postEvent("charge.dispute.closed", dispute("lost"));
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([
      ["accrual", 5_400],
      ["reversal", -1_080],
      ["reversal", -4_320],
    ]);
    // The same lost fact again (a redelivered event) writes nothing.
    await postEvent("charge.dispute.closed", dispute("lost"));
    // The partial refund fails late: the lost dispute still dominates.
    await refund(order.intent, refundId, 9_000, "failed");
    expect(await sum(order.orderId)).toBe(0);
    expect((await ledgerOfOrder(order.orderId)).filter((row) => row.kind === "reversal")).toHaveLength(2);
  });

  it("a refund submitted before a lost dispute that succeeds after it reverses nothing more", async () => {
    const order = await paidOrder();
    const refundId = refundIdOf("re_before");
    await refund(order.intent, refundId, 9_000, "pending");
    const dispute = (status: string) => ({
      amount: 45_000,
      currency: "sek",
      id: `dp_b_${order.orderId.replaceAll("-", "").slice(0, 12)}`,
      object: "dispute",
      payment_intent: order.intent,
      status,
    });
    await postEvent("charge.dispute.created", dispute("needs_response"));
    await postEvent("charge.dispute.closed", dispute("lost"));
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([
      ["accrual", 5_400],
      ["reversal", -5_400],
    ]);
    await refund(order.intent, refundId, 9_000, "succeeded");
    expect(await sum(order.orderId)).toBe(0);
    expect(await ledgerOfOrder(order.orderId)).toHaveLength(2);
  });

  it("pending_outcome → lost writes exactly one reversal; won reverses nothing", async () => {
    const order = await paidOrder();
    const id = `dp_p_${order.orderId.replaceAll("-", "").slice(0, 12)}`;
    const dispute = (status: string) => ({ amount: 45_000, currency: "sek", id, object: "dispute", payment_intent: order.intent, status });
    await postEvent("charge.dispute.created", dispute("needs_response"));
    await env.DB.prepare("UPDATE orders SET dispute_recovery = 'pending_outcome' WHERE order_id = ?").bind(order.orderId).run();
    await postEvent("charge.dispute.closed", dispute("lost"));
    await postEvent("charge.dispute.updated", dispute("lost"));
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([
      ["accrual", 5_400],
      ["reversal", -5_400],
    ]);
    const won = await paidOrder();
    const wonDispute = (status: string) => ({
      amount: 45_000,
      currency: "sek",
      id: `dp_w_${won.orderId.replaceAll("-", "").slice(0, 12)}`,
      object: "dispute",
      payment_intent: won.intent,
      status,
    });
    await postEvent("charge.dispute.created", wonDispute("needs_response"));
    await postEvent("charge.dispute.closed", wonDispute("won"));
    expect(amounts(await ledgerOfOrder(won.orderId))).toEqual([["accrual", 5_400]]);
  });

  it("a cancel alone reverses nothing (CANCELLING MOVES NO MONEY)", async () => {
    const order = await paidOrder();
    const principal = { accountType: "tenant_admin" as const, role: "admin" as const, tenantId: SHOP, userId: "admin-ledger" };
    const result = await cancelOrder(env, principal, { orderId: order.orderId, reason: "Kunden ångrade sig" }, Date.now());
    expect(result.status).toBe("ok");
    expect(amounts(await ledgerOfOrder(order.orderId))).toEqual([["accrual", 5_400]]);
  });

  it("an order without an affiliate writes no ledger row on a refund", async () => {
    const order = await paidOrder({ refCode: null });
    await refund(order.intent, refundIdOf("re_plain"), order.totalMinor);
    expect(await ledgerOfOrder(order.orderId)).toEqual([]);
  });
});

describe("the balances (design §4.4)", () => {
  it("hold every order inside 14 days, a disputed, a refunding and a cancelled-unrefunded order; release the last after 44 days", async () => {
    const tenant = "aff-ledger-bal";
    await seedShop(tenant, "aff-ledger-bal.test", { discountCodes: false });
    await seedPlainProduct(tenant, `${tenant}-goods`, 50_000);
    await featureStatement(tenant, "affiliate", true).run();
    const { affiliateId: owner } = await seedAffiliate({ code: "BAL10", tenantId: tenant });
    const context: TenantContext = { domainKind: "storefront", hostname: "aff-ledger-bal.test", tenantId: tenant };
    const order = () => paidOrder({ items: [{ productId: `${tenant}-goods`, quantity: 1 }], refCode: "BAL10" }, context);
    const plain = await order();
    const disputed = await order();
    const refunding = await order();
    const cancelled = await order();
    const partly = await order();

    const now = Date.now();
    let balance = balanceIn(await readBalances(env.DB, tenant, owner, "SEK", now), "SEK");
    expect(balance).toMatchObject({ balanceMinor: 5 * 5_400, heldMinor: 5 * 5_400, payableMinor: 0 });

    // A partial refund: the order's NET is held (counted once).
    await refund(partly.intent, refundIdOf("re_bal"), 22_500);
    balance = balanceIn(await readBalances(env.DB, tenant, owner, "SEK", now), "SEK");
    expect(balance).toMatchObject({ balanceMinor: 4 * 5_400 + 2_700, heldMinor: 4 * 5_400 + 2_700 });

    await env.DB.prepare("UPDATE orders SET dispute_status = 'needs_response', dispute_id = 'dp_bal_hold' WHERE order_id = ?")
      .bind(disputed.orderId)
      .run();
    await env.DB.prepare(
      `INSERT INTO refund_operations (id, tenant_id, order_id, amount_minor, state, origin, reason, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 1000, 'reserved', 'admin', 'Halv', 'admin-x', ?, ?)`,
    )
      .bind(crypto.randomUUID(), tenant, refunding.orderId, new Date(now).toISOString(), new Date(now).toISOString())
      .run();
    const cancelledAt = now;
    await env.DB.prepare("UPDATE orders SET cancelled_at = ?, cancel_reason = 'x' WHERE order_id = ?")
      .bind(new Date(cancelledAt).toISOString(), cancelled.orderId)
      .run();

    // 15 days later: only `plain` and `partly` (net 2 700) are payable.
    const later = now + 15 * DAY_MS;
    balance = balanceIn(await readBalances(env.DB, tenant, owner, "SEK", later), "SEK");
    expect(balance).toMatchObject({ heldMinor: 3 * 5_400, payableMinor: 5_400 + 2_700 });

    // 45 days after the cancellation, the cancelled-unrefunded order is released.
    balance = balanceIn(await readBalances(env.DB, tenant, owner, "SEK", cancelledAt + 45 * DAY_MS), "SEK");
    expect(balance).toMatchObject({ heldMinor: 2 * 5_400, payableMinor: 2 * 5_400 + 2_700 });

    // A dispute closed in the shop's favour releases its order too.
    await env.DB.prepare("UPDATE orders SET dispute_status = 'won' WHERE order_id = ?").bind(disputed.orderId).run();
    balance = balanceIn(await readBalances(env.DB, tenant, owner, "SEK", later), "SEK");
    expect(balance.payableMinor).toBe(2 * 5_400 + 2_700);
    expect(plain.orderId).not.toBe(disputed.orderId);
  });

  it("an affiliate with no row answers one zero balance in its own currency", async () => {
    const { affiliateId: fresh } = await seedAffiliate({ code: "FRESH1", currency: "EUR", tenantId: SHOP });
    expect(await readBalances(env.DB, SHOP, fresh, "EUR", Date.now())).toEqual([
      { balanceMinor: 0, currency: "EUR", earnedMinor: 0, heldMinor: 0, paidMinor: 0, payableMinor: 0, requestedMinor: 0 },
    ]);
  });
});
