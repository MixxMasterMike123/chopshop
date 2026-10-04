import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buyerKeyOf,
  holdById,
  holdStatement,
  MINUTE_MS,
  nextId,
  refusal,
  seedCode,
  seedDiscountedCheckout,
  seedHeldCheckout,
  seedShop,
} from "./discount-fixtures";

/**
 * Migration 0055 on the D1 test instance: every trigger refuses its case and
 * lets the legal cases through (CP8-DC design §2.2, build step 1). The
 * capacity rule is the one resolveDiscount reads (§2.3):
 *
 *   used_count + COUNT(DISTINCT buyer_key of live holds of OTHER buyers) < max_uses
 */

const TENANT = "tenant-holds-schema";
const OTHER = "tenant-holds-schema-b";

beforeAll(async () => {
  await seedShop(TENANT, "holds-schema.test");
  await seedShop(OTHER, "holds-schema-b.test");
});

async function freshCode(options: { maxUses?: number | null; usedCount?: number } = {}): Promise<string> {
  return seedCode({ code: nextId("HS").toUpperCase(), tenantId: TENANT, ...options });
}

describe("0055: a hold is born held and matches its checkout", () => {
  it("accepts a live hold for a checkout that froze this code", async () => {
    const codeId = await freshCode();
    const held = await seedHeldCheckout(TENANT, codeId);
    expect((await holdById(held.holdId))?.state).toBe("held");
  });

  it.each([
    ["released", null],
    ["used", "order-x"],
    ["held", "order-x"],
  ])("refuses a hold born %s (order %s)", async (state, orderId) => {
    const codeId = await freshCode();
    const checkout = await seedDiscountedCheckout({ discountCodeId: codeId, tenantId: TENANT });
    const key = await buyerKeyOf(TENANT, checkout.email);
    expect(
      await refusal(holdStatement({ buyerKey: key, checkoutId: checkout.checkoutId, discountCodeId: codeId, orderId, state, tenantId: TENANT })),
    ).toMatch(/a discount hold is born held|CHECK constraint failed/);
  });

  it("refuses a hold for a checkout of another code, without a discount, of another tenant, or outliving it", async () => {
    const codeId = await freshCode();
    const otherCodeId = await freshCode();
    const foreignCodeId = await seedCode({ code: "FOREIGNHS", tenantId: OTHER });
    const ofOtherCode = await seedDiscountedCheckout({ discountCodeId: otherCodeId, tenantId: TENANT });
    const undiscounted = await seedDiscountedCheckout({ discountCodeId: null, tenantId: TENANT });
    const foreign = await seedDiscountedCheckout({ discountCodeId: foreignCodeId, tenantId: OTHER });
    const shortLived = await seedDiscountedCheckout({
      discountCodeId: codeId,
      expiresAt: Date.now() + 10 * MINUTE_MS,
      tenantId: TENANT,
    });
    const key = await buyerKeyOf(TENANT, "x@buyer.test");
    const match = /discount hold does not match its checkout/;

    expect(await refusal(holdStatement({ buyerKey: key, checkoutId: ofOtherCode.checkoutId, discountCodeId: codeId, tenantId: TENANT }))).toMatch(match);
    expect(await refusal(holdStatement({ buyerKey: key, checkoutId: undiscounted.checkoutId, discountCodeId: codeId, tenantId: TENANT }))).toMatch(match);
    // Another tenant's checkout and code, under this tenant's id; and this
    // tenant's id on the other tenant's own row.
    expect(await refusal(holdStatement({ buyerKey: key, checkoutId: foreign.checkoutId, discountCodeId: foreignCodeId, tenantId: TENANT }))).toMatch(match);
    expect(await refusal(holdStatement({ buyerKey: key, checkoutId: ofOtherCode.checkoutId, discountCodeId: otherCodeId, tenantId: OTHER }))).toMatch(match);
    // A hold may not outlive the checkout (expires_at 60 min > the checkout's 10).
    expect(await refusal(holdStatement({ buyerKey: key, checkoutId: shortLived.checkoutId, discountCodeId: codeId, tenantId: TENANT }))).toMatch(match);
    // The same checkout with a hold that ends with it is accepted.
    expect(
      await refusal(holdStatement({ buyerKey: key, checkoutId: shortLived.checkoutId, discountCodeId: codeId, expiresAt: shortLived.expiresAt, tenantId: TENANT })),
    ).toBeNull();
  });

  it("allows one hold per checkout", async () => {
    const codeId = await freshCode();
    const held = await seedHeldCheckout(TENANT, codeId);
    expect(
      await refusal(holdStatement({ buyerKey: held.buyerKey, checkoutId: held.checkoutId, discountCodeId: codeId, tenantId: TENANT })),
    ).toMatch(/UNIQUE constraint failed/);
  });

  it("states the column CHECKs: the buyer key's shape, expiry after birth", async () => {
    const codeId = await freshCode();
    const checkout = await seedDiscountedCheckout({ discountCodeId: codeId, tenantId: TENANT });
    const base = { checkoutId: checkout.checkoutId, discountCodeId: codeId, tenantId: TENANT };
    expect(await refusal(holdStatement({ ...base, buyerKey: "A".repeat(64) }))).toMatch(/CHECK constraint failed/);
    expect(await refusal(holdStatement({ ...base, buyerKey: "a".repeat(63) }))).toMatch(/CHECK constraint failed/);
    const now = Date.now();
    expect(await refusal(holdStatement({ ...base, buyerKey: "a".repeat(64), createdAt: now, expiresAt: now }))).toMatch(/CHECK constraint failed/);
  });
});

describe("0055: the capacity trigger", () => {
  async function tryHold(codeId: string, email: string, createdAt?: number): Promise<string | null> {
    const checkout = await seedDiscountedCheckout({ discountCodeId: codeId, email, tenantId: TENANT });
    return refusal(
      holdStatement({
        buyerKey: await buyerKeyOf(TENANT, email),
        checkoutId: checkout.checkoutId,
        ...(createdAt === undefined ? {} : { createdAt }),
        discountCodeId: codeId,
        tenantId: TENANT,
      }),
    );
  }

  it("lets the last use be held and refuses one past the cap", async () => {
    const codeId = await freshCode({ maxUses: 3, usedCount: 2 });
    expect(await tryHold(codeId, "a@cap.test")).toBeNull();
    expect(await tryHold(codeId, "b@cap.test")).toMatch(/discount code exhausted/);
  });

  it("does not count the same buyer against themself", async () => {
    const codeId = await freshCode({ maxUses: 1 });
    expect(await tryHold(codeId, "same@cap.test")).toBeNull();
    expect(await tryHold(codeId, "same@cap.test")).toBeNull();
    expect(await tryHold(codeId, "other@cap.test")).toMatch(/discount code exhausted/);
  });

  it("counts one buyer's several holds once", async () => {
    const codeId = await freshCode({ maxUses: 3 });
    expect(await tryHold(codeId, "twice@cap.test")).toBeNull();
    expect(await tryHold(codeId, "twice@cap.test")).toBeNull();
    // 0 used + 1 distinct other buyer < 3.
    expect(await tryHold(codeId, "second@cap.test")).toBeNull();
    // 0 + 2 distinct others < 3.
    expect(await tryHold(codeId, "third@cap.test")).toBeNull();
    // 0 + 3 >= 3.
    expect(await tryHold(codeId, "fourth@cap.test")).toMatch(/discount code exhausted/);
  });

  it("does not count an expired hold", async () => {
    const codeId = await freshCode({ maxUses: 1 });
    const longAgo = Date.now() - 2 * 60 * MINUTE_MS;
    expect(await tryHold(codeId, "early@cap.test", longAgo)).toBeNull();
    expect(await tryHold(codeId, "later@cap.test")).toBeNull();
  });

  it("does not count a released hold", async () => {
    const codeId = await freshCode({ maxUses: 1 });
    const held = await seedHeldCheckout(TENANT, codeId);
    await env.DB.prepare("UPDATE discount_code_holds SET state = 'released' WHERE hold_id = ?").bind(held.holdId).run();
    expect(await tryHold(codeId, "after-release@cap.test")).toBeNull();
  });

  it("never refuses a code without a cap", async () => {
    const codeId = await freshCode({ maxUses: null, usedCount: 500 });
    for (const email of ["u1@cap.test", "u2@cap.test", "u3@cap.test"]) {
      expect(await tryHold(codeId, email)).toBeNull();
    }
  });

  it("counts used_count with the holds: one held use of a cap of 2 with 1 used is full", async () => {
    const codeId = await freshCode({ maxUses: 2, usedCount: 1 });
    expect(await tryHold(codeId, "p@cap.test")).toBeNull();
    expect(await tryHold(codeId, "q@cap.test")).toMatch(/discount code exhausted/);
  });
});

describe("0055: transitions, frozen facts, no delete", () => {
  const STATES = ["held", "released", "used"] as const;
  const ALLOWED = new Set(["held>held", "held>released", "held>used", "released>released", "released>used", "used>used"]);

  /** A hold put into `state` through the allowed path. */
  async function holdIn(state: (typeof STATES)[number]): Promise<string> {
    const codeId = await freshCode();
    const held = await seedHeldCheckout(TENANT, codeId);
    if (state === "released") {
      await env.DB.prepare("UPDATE discount_code_holds SET state = 'released' WHERE hold_id = ?").bind(held.holdId).run();
    }
    if (state === "used") {
      await env.DB.prepare("UPDATE discount_code_holds SET state = 'used', order_id = 'order-1' WHERE hold_id = ?")
        .bind(held.holdId)
        .run();
    }
    return held.holdId;
  }

  for (const from of STATES) {
    for (const to of STATES) {
      const pair = `${from}>${to}`;
      it(`${ALLOWED.has(pair) ? "allows" : "refuses"} ${from} → ${to}`, async () => {
        const holdId = await holdIn(from);
        const orderId = to === "used" ? "order-1" : null;
        const outcome = await refusal(
          env.DB.prepare("UPDATE discount_code_holds SET state = ?, order_id = ? WHERE hold_id = ?").bind(to, orderId, holdId),
        );
        if (ALLOWED.has(pair)) {
          expect(outcome).toBeNull();
          expect((await holdById(holdId))?.state).toBe(to);
        } else {
          expect(outcome).toMatch(/discount hold transition refused|discount hold facts are immutable/);
          expect((await holdById(holdId))?.state).toBe(from);
        }
      });
    }
  }

  it("refuses 'used' without an order and an order without 'used'", async () => {
    const holdId = await holdIn("held");
    expect(await refusal(env.DB.prepare("UPDATE discount_code_holds SET state = 'used' WHERE hold_id = ?").bind(holdId))).toMatch(
      /CHECK constraint failed/,
    );
    expect(await refusal(env.DB.prepare("UPDATE discount_code_holds SET order_id = 'o' WHERE hold_id = ?").bind(holdId))).toMatch(
      /CHECK constraint failed/,
    );
  });

  it.each([
    ["hold_id", "'other-id'"],
    ["discount_code_id", "'other-code'"],
    ["checkout_id", "'other-checkout'"],
    ["buyer_key", `'${"b".repeat(64)}'`],
    ["expires_at", "expires_at + 1"],
    ["created_at", "created_at - 1"],
  ])("refuses a change of %s", async (column, value) => {
    const holdId = await holdIn("held");
    expect(
      await refusal(env.DB.prepare(`UPDATE discount_code_holds SET ${column} = ${value} WHERE hold_id = ?`).bind(holdId)),
    ).toMatch(/discount hold facts are immutable|FOREIGN KEY constraint failed/);
  });

  it("refuses a new tenant and a new order once one is recorded", async () => {
    const used = await holdIn("used");
    expect(await refusal(env.DB.prepare("UPDATE discount_code_holds SET tenant_id = ? WHERE hold_id = ?").bind(OTHER, used))).toMatch(
      /tenant_id is immutable/,
    );
    expect(await refusal(env.DB.prepare("UPDATE discount_code_holds SET order_id = 'order-2' WHERE hold_id = ?").bind(used))).toMatch(
      /discount hold facts are immutable/,
    );
    // updated_at may move forward.
    expect(
      await refusal(env.DB.prepare("UPDATE discount_code_holds SET updated_at = updated_at + 5 WHERE hold_id = ?").bind(used)),
    ).toBeNull();
  });

  it("refuses to delete a hold in any state", async () => {
    for (const state of STATES) {
      const holdId = await holdIn(state);
      expect(await refusal(env.DB.prepare("DELETE FROM discount_code_holds WHERE hold_id = ?").bind(holdId))).toMatch(
        /discount holds are kept/,
      );
    }
  });
});

describe("0055: a used or held code keeps its name", () => {
  const rename = (codeId: string, code: string) =>
    env.DB.prepare("UPDATE discount_codes SET code = ? WHERE discount_code_id = ?").bind(code, codeId);

  it("allows a rename before any use or hold, and the same name always", async () => {
    const codeId = await freshCode();
    expect(await refusal(rename(codeId, nextId("RENAMED").toUpperCase()))).toBeNull();
    const held = await freshCode();
    await seedHeldCheckout(TENANT, held);
    const name = await env.DB.prepare("SELECT code FROM discount_codes WHERE discount_code_id = ?").bind(held).first<{ code: string }>();
    expect(await refusal(rename(held, name?.code ?? ""))).toBeNull();
  });

  it("refuses a rename after a hold, in any state, and after a counted use", async () => {
    const held = await freshCode();
    const hold = await seedHeldCheckout(TENANT, held);
    expect(await refusal(rename(held, nextId("AFTERHOLD").toUpperCase()))).toMatch(/discount code in use/);
    await env.DB.prepare("UPDATE discount_code_holds SET state = 'released' WHERE hold_id = ?").bind(hold.holdId).run();
    expect(await refusal(rename(held, nextId("AFTERRELEASE").toUpperCase()))).toMatch(/discount code in use/);

    const used = await freshCode({ usedCount: 1 });
    expect(await refusal(rename(used, nextId("AFTERUSE").toUpperCase()))).toMatch(/discount code in use/);
  });

  it("lets the webhook's burn count a use on a code with holds", async () => {
    const codeId = await freshCode({ maxUses: 1 });
    await seedHeldCheckout(TENANT, codeId);
    expect(
      await refusal(
        env.DB.prepare(
          "UPDATE discount_codes SET used_count = used_count + 1, updated_at = ? WHERE discount_code_id = ? AND tenant_id = ?",
        ).bind(Date.now(), codeId, TENANT),
      ),
    ).toBeNull();
    // Past its cap, as a late paid order may take it (§2.3).
    expect(
      await refusal(
        env.DB.prepare("UPDATE discount_codes SET used_count = used_count + 1 WHERE discount_code_id = ?").bind(codeId),
      ),
    ).toBeNull();
  });
});
