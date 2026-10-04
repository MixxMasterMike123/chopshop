import { env } from "cloudflare:workers";
import { beforeEach, beforeAll, describe, expect, it } from "vitest";

import { runRetentionSweep } from "../src/commerce/crons";
import {
  DAY_MS,
  holdById,
  holdStatement,
  MINUTE_MS,
  nextId,
  nextIntentId,
  seedCode,
  seedDiscountedCheckout,
  seedHeldCheckout,
  usedCountOf,
  buyerKeyOf,
} from "./discount-fixtures";
import { FakeMoneyStripe, moneyEnv, postEvent, seedTenant } from "./money-fixtures";

/**
 * CP8-DC build step 4: what happens to a hold (0055) after the checkout.
 *
 *   payment succeeds   → this checkout's hold becomes used (held or released),
 *                        the buyer's other live holds on the code are
 *                        released, used_count + 1 — all in the order's batch,
 *                        which a hold can never make fail;
 *   intent canceled    → released (the webhook's event, the sweep's cancel);
 *   payment failed     → nothing (DC4: another card may follow).
 */

const TENANT = "tenant-dc-lifecycle";
let stripe: FakeMoneyStripe;

beforeAll(async () => {
  await seedTenant(TENANT);
});

beforeEach(() => {
  stripe = new FakeMoneyStripe();
});

async function succeed(checkoutId: string, paymentIntentId: string, totalMinor: number): Promise<string> {
  const { response } = await postEvent("payment_intent.succeeded", {
    amount: totalMinor,
    currency: "sek",
    id: paymentIntentId,
    metadata: { checkout_id: checkoutId, tenant_id: TENANT },
    object: "payment_intent",
    status: "succeeded",
  });
  expect(response.status).toBe(200);
  const order = await env.DB.prepare("SELECT order_id FROM orders WHERE checkout_id = ?")
    .bind(checkoutId)
    .first<{ order_id: string }>();
  if (order === null) {
    throw new Error("the webhook did not create an order");
  }
  return order.order_id;
}

/** A paid-to-be checkout with a live hold. */
async function heldPayable(codeId: string, email?: string) {
  const paymentIntentId = nextIntentId();
  const held = await seedHeldCheckout(TENANT, codeId, {
    ...(email === undefined ? {} : { email }),
    paymentIntentId,
    withLine: true,
  });
  return { ...held, paymentIntentId };
}

describe("the payment succeeds", () => {
  it("turns the checkout's hold into a use of this order and counts it", async () => {
    const codeId = await seedCode({ code: "LIFEUSE", maxUses: 5, tenantId: TENANT });
    const held = await heldPayable(codeId);

    const orderId = await succeed(held.checkoutId, held.paymentIntentId, held.totalMinor);

    expect(await holdById(held.holdId)).toMatchObject({ order_id: orderId, state: "used" });
    expect(await usedCountOf(codeId)).toBe(1);
  });

  it("counts a late success whose hold was released, past the cap, and makes the order", async () => {
    const codeId = await seedCode({ code: "LIFELATE", maxUses: 1, tenantId: TENANT });
    const held = await heldPayable(codeId);
    await env.DB.prepare("UPDATE discount_code_holds SET state = 'released' WHERE hold_id = ?").bind(held.holdId).run();
    // Someone else took the one use meanwhile.
    await env.DB.prepare("UPDATE discount_codes SET used_count = 1 WHERE discount_code_id = ?").bind(codeId).run();

    const orderId = await succeed(held.checkoutId, held.paymentIntentId, held.totalMinor);

    expect(await holdById(held.holdId)).toMatchObject({ order_id: orderId, state: "used" });
    expect(await usedCountOf(codeId)).toBe(2);
  });

  it("counts a success whose hold expired", async () => {
    const codeId = await seedCode({ code: "LIFEEXPIRED", maxUses: 1, tenantId: TENANT });
    const paymentIntentId = nextIntentId();
    const checkout = await seedDiscountedCheckout({ discountCodeId: codeId, paymentIntentId, tenantId: TENANT, withLine: true });
    const holdId = nextId("hold");
    await holdStatement({
      buyerKey: await buyerKeyOf(TENANT, checkout.email),
      checkoutId: checkout.checkoutId,
      createdAt: Date.now() - 3 * 60 * MINUTE_MS,
      discountCodeId: codeId,
      holdId,
      tenantId: TENANT,
    }).run();

    const orderId = await succeed(checkout.checkoutId, paymentIntentId, checkout.totalMinor);
    expect(await holdById(holdId)).toMatchObject({ order_id: orderId, state: "used" });
    expect(await usedCountOf(codeId)).toBe(1);
  });

  it("releases the same buyer's other live holds on the code, and no one else's", async () => {
    const codeId = await seedCode({ code: "LIFESAME", maxUses: 3, tenantId: TENANT });
    const otherCodeId = await seedCode({ code: "LIFEOTHERCODE", maxUses: 3, tenantId: TENANT });
    const email = `${nextId("same")}@buyer.test`;
    const earlier = await heldPayable(codeId, email);
    const paid = await heldPayable(codeId, email);
    const someoneElse = await heldPayable(codeId);
    const sameBuyerOtherCode = await heldPayable(otherCodeId, email);

    const orderId = await succeed(paid.checkoutId, paid.paymentIntentId, paid.totalMinor);

    expect(await holdById(paid.holdId)).toMatchObject({ order_id: orderId, state: "used" });
    expect(await holdById(earlier.holdId)).toMatchObject({ order_id: null, state: "released" });
    expect((await holdById(someoneElse.holdId))?.state).toBe("held");
    expect((await holdById(sameBuyerOtherCode.holdId))?.state).toBe("held");
    expect(await usedCountOf(codeId)).toBe(1);
    expect(await usedCountOf(otherCodeId)).toBe(0);
  });

  it("burns as before for a checkout made before 0055 (a frozen code, no hold)", async () => {
    const codeId = await seedCode({ code: "LIFEPRE", tenantId: TENANT });
    const paymentIntentId = nextIntentId();
    const checkout = await seedDiscountedCheckout({ discountCodeId: codeId, paymentIntentId, tenantId: TENANT, withLine: true });

    await succeed(checkout.checkoutId, paymentIntentId, checkout.totalMinor);

    expect(await usedCountOf(codeId)).toBe(1);
    const holds = await env.DB.prepare("SELECT COUNT(*) AS n FROM discount_code_holds WHERE discount_code_id = ?")
      .bind(codeId)
      .first<{ n: number }>();
    expect(holds?.n).toBe(0);
  });

  it("never fails the order batch because of a hold, whatever state it is in", async () => {
    // A hold already 'used' by some order (it cannot happen through the
    // routes; the batch must still commit).
    const codeId = await seedCode({ code: "LIFEODD", maxUses: 1, tenantId: TENANT });
    const held = await heldPayable(codeId);
    await env.DB.prepare("UPDATE discount_code_holds SET state = 'used', order_id = 'order-elsewhere' WHERE hold_id = ?")
      .bind(held.holdId)
      .run();

    const orderId = await succeed(held.checkoutId, held.paymentIntentId, held.totalMinor);

    expect(orderId).not.toBe("order-elsewhere");
    expect(await holdById(held.holdId)).toMatchObject({ order_id: "order-elsewhere", state: "used" });
    expect(await usedCountOf(codeId)).toBe(1);
  });
});

describe("the intent is canceled, or the card declined", () => {
  it("payment_intent.canceled releases the hold", async () => {
    const codeId = await seedCode({ code: "LIFECANCEL", maxUses: 1, tenantId: TENANT });
    const held = await heldPayable(codeId);

    const { response } = await postEvent("payment_intent.canceled", { id: held.paymentIntentId, status: "canceled" });

    expect(response.status).toBe(200);
    expect(await holdById(held.holdId)).toMatchObject({ order_id: null, state: "released" });
    expect(await usedCountOf(codeId)).toBe(0);
  });

  it("payment_intent.payment_failed keeps the hold (DC4)", async () => {
    const codeId = await seedCode({ code: "LIFEFAILED", maxUses: 1, tenantId: TENANT });
    const held = await heldPayable(codeId);

    const { response } = await postEvent("payment_intent.payment_failed", {
      id: held.paymentIntentId,
      status: "requires_payment_method",
    });

    expect(response.status).toBe(200);
    expect((await holdById(held.holdId))?.state).toBe("held");
  });

  it("a late canceled after the success changes nothing", async () => {
    const codeId = await seedCode({ code: "LIFEAFTER", tenantId: TENANT });
    const held = await heldPayable(codeId);
    const orderId = await succeed(held.checkoutId, held.paymentIntentId, held.totalMinor);

    await postEvent("payment_intent.canceled", { id: held.paymentIntentId, status: "canceled" });

    expect(await holdById(held.holdId)).toMatchObject({ order_id: orderId, state: "used" });
  });
});

describe("the retention sweep", () => {
  /** An expired checkout whose intent last moved `ageMs` ago, with its hold from then. */
  async function staleHeld(codeId: string, intentStatus: string) {
    const at = Date.now() - 8 * DAY_MS;
    const paymentIntentId = nextIntentId();
    const checkout = await seedDiscountedCheckout({
      createdAt: at,
      discountCodeId: codeId,
      expiresAt: at + DAY_MS,
      paymentIntentId,
      paymentIntentStatus: "requires_payment_method",
      paymentIntentStatusAt: at,
      tenantId: TENANT,
      withLine: true,
    });
    const holdId = nextId("hold");
    await holdStatement({
      buyerKey: await buyerKeyOf(TENANT, checkout.email),
      checkoutId: checkout.checkoutId,
      createdAt: at,
      discountCodeId: codeId,
      holdId,
      tenantId: TENANT,
    }).run();
    stripe.addIntent({
      amount: checkout.totalMinor,
      id: paymentIntentId,
      metadata: { checkout_id: checkout.checkoutId, tenant_id: TENANT },
      status: intentStatus,
    });
    return { ...checkout, holdId, paymentIntentId };
  }

  it("releases the hold of a checkout whose intent it canceled", async () => {
    const codeId = await seedCode({ code: "LIFESWEEP", tenantId: TENANT });
    const stale = await staleHeld(codeId, "requires_payment_method");

    await runRetentionSweep(moneyEnv(stripe), Date.now());

    expect(stripe.cancelCalls).toContain(stale.paymentIntentId);
    expect((await holdById(stale.holdId))?.state).toBe("released");
  });

  it("leaves the hold to the webhook when Stripe refuses the cancel of an intent that succeeded", async () => {
    const codeId = await seedCode({ code: "LIFESWEEPLATE", tenantId: TENANT });
    const stale = await staleHeld(codeId, "succeeded");

    await runRetentionSweep(moneyEnv(stripe), Date.now());
    expect((await holdById(stale.holdId))?.state).toBe("held");

    const orderId = await succeed(stale.checkoutId, stale.paymentIntentId, stale.totalMinor);
    expect(await holdById(stale.holdId)).toMatchObject({ order_id: orderId, state: "used" });
    expect(await usedCountOf(codeId)).toBe(1);
  });
});
