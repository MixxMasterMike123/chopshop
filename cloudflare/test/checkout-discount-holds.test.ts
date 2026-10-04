import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { publishAdminProduct } from "../src/catalog/admin-catalog";
import { createCheckout, type CreateCheckoutInput } from "../src/commerce/checkout";
import { DISCOUNT_HOLD_TTL_MS } from "../src/commerce/discount-codes";
import { createMapping } from "../src/pod/pod-mappings";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  buyerKeyOf,
  holdsOfCheckout,
  nextId,
  seedCode,
  seedHeldCheckout,
  seedPlainProduct,
  seedShop,
  setDiscountSwitch,
} from "./discount-fixtures";
import { BUYER_CONSENT, withBuyerRecipient } from "./legal-fixtures";
import { adminOf, seedArtwork, seedPrinter, seedProduct, seedProfile, seedTenant, TEE_S } from "./pod-fixtures";

/**
 * CP8-DC build step 3: the checkout applies a code only while the shop's
 * switch is on (F1), holds the use in its own batch (0055), loses the race to
 * the trigger gracefully (one rerun without the discount), and does not apply
 * a code that would leave the charge under the minimum (R3, F3) or the fee
 * above it (R2, F2). The design's worked examples (§3.3), to the öre.
 */

const TENANT = "tenant-dc-holds";
const HOST = "dc-holds.podtest.test";
const ADMIN = adminOf(TENANT);
const CONTEXT: TenantContext = { domainKind: "storefront", hostname: HOST, tenantId: TENANT };
const OFF_TENANT = "tenant-dc-holds-off";
const OFF_CONTEXT: TenantContext = { domainKind: "storefront", hostname: "dc-holds-off.test", tenantId: OFF_TENANT };
const UNSET_TENANT = "tenant-dc-holds-unset";
const UNSET_CONTEXT: TenantContext = { domainKind: "storefront", hostname: "dc-holds-unset.test", tenantId: UNSET_TENANT };

/** The tee priced exactly at its D41 floor: cost 14 000 + parcel 4 900 → 26 300, W 23 625. */
const FLOOR_TEE = "floor-tee";
const MUG = "mug";

function input(overrides: Partial<CreateCheckoutInput> & Pick<CreateCheckoutInput, "items">): CreateCheckoutInput {
  return {
    deliveryMethod: "pickup",
    discountCode: null,
    email: `${nextId("buyer")}@buyer.test`,
    idempotencyKey: nextId("idem"),
    shippingCountry: null,
    ...overrides,
  };
}

async function checkout(value: CreateCheckoutInput, context: TenantContext = CONTEXT, db: D1Database = env.DB) {
  const result = await createCheckout(db, context, value, Date.now(), { dispatchTarget: "fake-printer" });
  if (result.status !== "ok") {
    throw new Error(`checkout: ${result.status}`);
  }
  return result;
}

async function storedRow(checkoutId: string) {
  return env.DB.prepare(
    `SELECT discount_minor, discount_code_id, subtotal_minor, shipping_minor,
            total_minor, vat_minor, production_snapshot_json
     FROM checkouts WHERE checkout_id = ?`,
  )
    .bind(checkoutId)
    .first<{
      discount_code_id: string | null;
      discount_minor: number;
      production_snapshot_json: string | null;
      shipping_minor: number;
      subtotal_minor: number;
      total_minor: number;
      vat_minor: number;
    }>();
}

async function holdCountOfCode(codeId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM discount_code_holds WHERE discount_code_id = ?")
    .bind(codeId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

const codes: Record<string, string> = {};

/**
 * env.DB, except that the batch that writes the checkout first lets a
 * competitor commit a hold on the same code: the read above it saw the use
 * free, the trigger then sees it taken. Counts the checkout inserts.
 */
function racingDb(competitor: () => Promise<void>): {
  checkoutInserts: () => number;
  codeReads: () => number;
  db: D1Database;
} {
  let inserts = 0;
  let codeReads = 0;
  let pendingInsert = false;
  let raced = false;
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("INSERT INTO checkouts")) {
            inserts += 1;
            pendingInsert = true;
          }
          if (sql.includes("FROM discount_codes AS d")) {
            codeReads += 1;
          }
          return target.prepare(sql);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (pendingInsert && !raced) {
            raced = true;
            await competitor();
          }
          pendingInsert = false;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { checkoutInserts: () => inserts, codeReads: () => codeReads, db };
}

beforeAll(async () => {
  await seedTenant(TENANT, HOST);
  await setDiscountSwitch(TENANT, true);
  await seedProfile();
  await seedPrinter();
  await seedArtwork(TENANT, { artworkId: "floor-front" });
  // Past D8's first-N (test/screening.test.ts owns that rule).
  await seedProduct(TENANT, { productId: "holds-live-1", published: true });
  await seedProduct(TENANT, { productId: "holds-live-2", published: true });
  await seedProduct(TENANT, { productId: MUG, priceMinor: 20_000, published: true });
  await seedProduct(TENANT, { productId: FLOOR_TEE, priceMinor: 26_300 });
  const mapped = await createMapping(env.DB, ADMIN, {
    artworkId: "floor-front",
    printerId: "fake-printer",
    productId: FLOOR_TEE,
    sku: TEE_S,
    slots: ["front"],
    variantId: null,
  }, Date.now());
  expect(mapped.status).toBe("ok");
  // At its floor exactly: the D41 publish gate admits it.
  expect((await publishAdminProduct(env.DB, ADMIN, FLOOR_TEE, Date.now())).status).toBe("ok");
  await env.DB.prepare("UPDATE products SET allow_pickup = 1 WHERE tenant_id = ?").bind(TENANT).run();

  for (const [code, seed] of Object.entries({
    PCT5: { percentBp: 500 },
    PCT10: { percentBp: 1_000 },
    PCT20: { percentBp: 2_000 },
    PCT35: { percentBp: 3_500 },
    FIXED20000: { valueMinor: 20_000 },
    SCOPEDTEE: { percentBp: 2_000, productIds: [FLOOR_TEE] },
  })) {
    codes[code] = await seedCode({ code, tenantId: TENANT, ...seed });
  }

  await seedShop(OFF_TENANT, "dc-holds-off.test", { discountCodes: false });
  await seedPlainProduct(OFF_TENANT, "off-mug", 20_000);
  codes.OFFCODE = await seedCode({ code: "OFFCODE", percentBp: 2_000, tenantId: OFF_TENANT });
  await seedShop(UNSET_TENANT, "dc-holds-unset.test", { discountCodes: null });
  await seedPlainProduct(UNSET_TENANT, "unset-mug", 20_000);
  codes.UNSETCODE = await seedCode({ code: "UNSETCODE", percentBp: 2_000, tenantId: UNSET_TENANT });
});

describe("the shop's switch (F1, DC2)", () => {
  it.each([
    ["off", OFF_CONTEXT, "off-mug", "OFFCODE"],
    ["unset (the add-on is opt-in)", UNSET_CONTEXT, "unset-mug", "UNSETCODE"],
  ])("switch %s: the code is echoed, worth 0, and holds nothing", async (_label, context, productId, code) => {
    const result = await checkout(input({ discountCode: code, items: [{ productId, quantity: 1 }] }), context);
    expect(result.checkout).toMatchObject({ discountCode: code, discountMinor: 0, totalMinor: 20_000 });
    expect((await storedRow(result.checkout.checkoutId))?.discount_code_id).toBeNull();
    expect(await holdsOfCheckout(result.checkout.checkoutId)).toEqual([]);
  });

  it("switch on: the same code applies (the off shop, turned on)", async () => {
    await setDiscountSwitch(OFF_TENANT, true);
    try {
      const result = await checkout(input({ discountCode: "OFFCODE", items: [{ productId: "off-mug", quantity: 1 }] }), OFF_CONTEXT);
      expect(result.checkout).toMatchObject({ discountMinor: 4_000, totalMinor: 16_000 });
    } finally {
      await setDiscountSwitch(OFF_TENANT, false);
    }
  });
});

describe("the hold (0055)", () => {
  it("freezes one live hold with the buyer's key, for an hour", async () => {
    const value = input({ discountCode: "PCT20", items: [{ productId: MUG, quantity: 1 }] });
    const before = Date.now();
    const result = await checkout(value);
    const after = Date.now();
    expect(result.checkout).toMatchObject({ discountMinor: 4_000, totalMinor: 16_000 });

    const holds = await holdsOfCheckout(result.checkout.checkoutId);
    expect(holds).toHaveLength(1);
    const [hold] = holds;
    expect(hold).toMatchObject({
      buyer_key: await buyerKeyOf(TENANT, value.email),
      discount_code_id: codes.PCT20,
      order_id: null,
      state: "held",
      tenant_id: TENANT,
    });
    expect(hold?.created_at).toBeGreaterThanOrEqual(before);
    expect(hold?.created_at).toBeLessThanOrEqual(after);
    expect(hold?.expires_at).toBe((hold?.created_at ?? 0) + DISCOUNT_HOLD_TTL_MS);
    expect(DISCOUNT_HOLD_TTL_MS).toBe(60 * 60 * 1_000);
  });

  it("gives the last use to the first buyer and nothing to the second", async () => {
    const codeId = await seedCode({ code: "LASTONE", maxUses: 3, tenantId: TENANT, usedCount: 2, valueMinor: 1_000 });
    const first = await checkout(input({ discountCode: "LASTONE", items: [{ productId: MUG, quantity: 1 }] }));
    // Counted: the READ declines the code (other buyers' holds), so the second
    // checkout is made in one attempt; the trigger is only the backstop.
    const counted = racingDb(async () => {});
    const second = await checkout(input({ discountCode: "lastone ", items: [{ productId: MUG, quantity: 1 }] }), CONTEXT, counted.db);
    expect(first.checkout.discountMinor).toBe(1_000);
    expect(second.checkout).toMatchObject({ discountCode: "lastone ", discountMinor: 0, totalMinor: 20_000 });
    expect(counted.checkoutInserts()).toBe(1);
    expect(await holdsOfCheckout(second.checkout.checkoutId)).toEqual([]);
    expect(await holdCountOfCode(codeId)).toBe(1);
  });

  it("lets the same buyer keep the code across their own checkouts", async () => {
    const codeId = await seedCode({ code: "MINEONLY", maxUses: 1, tenantId: TENANT, valueMinor: 1_000 });
    const email = `${nextId("same")}@buyer.test`;
    const first = await checkout(input({ discountCode: "MINEONLY", email, items: [{ productId: MUG, quantity: 1 }] }));
    // A ticked box or a reloaded page is a new checkout under a new key.
    const second = await checkout(input({ discountCode: "MINEONLY", email, items: [{ productId: MUG, quantity: 2 }] }));
    expect([first.checkout.discountMinor, second.checkout.discountMinor]).toEqual([1_000, 1_000]);
    expect(await holdCountOfCode(codeId)).toBe(2);
    const someoneElse = await checkout(input({ discountCode: "MINEONLY", items: [{ productId: MUG, quantity: 1 }] }));
    expect(someoneElse.checkout.discountMinor).toBe(0);
  });

  it("replays the same request without a second hold", async () => {
    const codeId = await seedCode({ code: "REPLAYHOLD", maxUses: 1, tenantId: TENANT, valueMinor: 1_000 });
    const value = input({ discountCode: "REPLAYHOLD", items: [{ productId: MUG, quantity: 1 }] });
    const first = await checkout(value);
    const again = await checkout(value);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.checkout.checkoutId).toBe(first.checkout.checkoutId);
    expect(again.checkout.discountMinor).toBe(1_000);
    expect(await holdCountOfCode(codeId)).toBe(1);
  });

  it("does not count an expired hold of another buyer", async () => {
    const codeId = await seedCode({ code: "STALEHOLD", maxUses: 1, tenantId: TENANT, valueMinor: 1_000 });
    await seedHeldCheckout(TENANT, codeId, { createdAt: Date.now() - 2 * DISCOUNT_HOLD_TTL_MS });
    const result = await checkout(input({ discountCode: "STALEHOLD", items: [{ productId: MUG, quantity: 1 }] }));
    expect(result.checkout.discountMinor).toBe(1_000);
  });

  it("counts a live hold of another buyer", async () => {
    const codeId = await seedCode({ code: "LIVEHOLD", maxUses: 1, tenantId: TENANT, valueMinor: 1_000 });
    await seedHeldCheckout(TENANT, codeId);
    const counted = racingDb(async () => {});
    const result = await checkout(input({ discountCode: "LIVEHOLD", items: [{ productId: MUG, quantity: 1 }] }), CONTEXT, counted.db);
    expect(result.checkout.discountMinor).toBe(0);
    expect(counted.checkoutInserts()).toBe(1);
  });
});

describe("the race: two buyers read the last use before either writes", () => {
  it("answers 201 without the discount and without a hold, exactly once more", async () => {
    const codeId = await seedCode({ code: "CAP3", maxUses: 3, tenantId: TENANT, usedCount: 2, valueMinor: 1_000 });
    let competitorHold = "";
    const race = racingDb(async () => {
      competitorHold = (await seedHeldCheckout(TENANT, codeId)).holdId;
    });

    const result = await checkout(input({ discountCode: "CAP3", items: [{ productId: MUG, quantity: 1 }] }), CONTEXT, race.db);

    expect(result.replayed).toBe(false);
    expect(result.checkout).toMatchObject({ discountCode: "CAP3", discountMinor: 0, totalMinor: 20_000, vatMinor: 4_000 });
    expect(await storedRow(result.checkout.checkoutId)).toMatchObject({ discount_code_id: null, discount_minor: 0 });
    expect(await holdsOfCheckout(result.checkout.checkoutId)).toEqual([]);
    // The competitor's hold is the only one: the refused batch left nothing.
    expect(competitorHold).not.toBe("");
    expect(await holdCountOfCode(codeId)).toBe(1);
    // One refused attempt, one rerun, and the rerun has the discount OFF: it
    // does not read the code again (whatever a second read would say).
    expect(race.checkoutInserts()).toBe(2);
    expect(race.codeReads()).toBe(1);
  });

  it("does not rerun when the race was lost by nobody", async () => {
    const codeId = await seedCode({ code: "NORACE", maxUses: 3, tenantId: TENANT, valueMinor: 1_000 });
    const race = racingDb(async () => {
      await seedHeldCheckout(TENANT, codeId);
    });
    const result = await checkout(input({ discountCode: "NORACE", items: [{ productId: MUG, quantity: 1 }] }), CONTEXT, race.db);
    expect(result.checkout.discountMinor).toBe(1_000);
    expect(race.checkoutInserts()).toBe(1);
  });
});

describe("R2 and R3: a code that would leave the fee above the charge, or less than 3 kr, does not apply", () => {
  async function snapshotWithoutCode(items: CreateCheckoutInput["items"]): Promise<string | null> {
    const plain = await checkout(input({ items }));
    return (await storedRow(plain.checkout.checkoutId))?.production_snapshot_json ?? null;
  }

  it("C at 10 %: 201, nothing off, the full 26 300, the snapshot of the same basket without a code", async () => {
    const items = [{ productId: FLOOR_TEE, quantity: 1 }];
    const result = await checkout(input({ discountCode: "PCT10", items }));
    expect(result.checkout).toMatchObject({ discountCode: "PCT10", discountMinor: 0, subtotalMinor: 26_300, totalMinor: 26_300 });
    const row = await storedRow(result.checkout.checkoutId);
    expect(row?.discount_code_id).toBeNull();
    expect(row?.production_snapshot_json).toBe(await snapshotWithoutCode(items));
    expect(JSON.parse(row?.production_snapshot_json ?? "{}").totals.withholdMinor).toBe(23_625);
    expect(await holdsOfCheckout(result.checkout.checkoutId)).toEqual([]);
  });

  it("C at 20 %: 201 rather than the old 422, nothing off", async () => {
    const result = await checkout(input({ discountCode: "PCT20", items: [{ productId: FLOOR_TEE, quantity: 1 }] }));
    expect(result.checkout).toMatchObject({ discountMinor: 0, totalMinor: 26_300 });
  });

  it("C at 5 %: applies, 1 315 off, 24 985 to pay, with its hold", async () => {
    const result = await checkout(input({ discountCode: "PCT5", items: [{ productId: FLOOR_TEE, quantity: 1 }] }));
    expect(result.checkout).toMatchObject({ discountMinor: 1_315, totalMinor: 24_985, vatMinor: 4_997 });
    expect(await holdsOfCheckout(result.checkout.checkoutId)).toHaveLength(1);
  });

  it("D, mixed at pickup: 20 % on the whole cart applies (9 260 off, 37 040, VAT 7 408)", async () => {
    const result = await checkout(input({
      discountCode: "PCT20",
      items: [
        { productId: MUG, quantity: 1 },
        { productId: FLOOR_TEE, quantity: 1 },
      ],
    }));
    expect(result.checkout).toMatchObject({ discountMinor: 9_260, subtotalMinor: 46_300, totalMinor: 37_040, vatMinor: 7_408 });
  });

  it("D scoped to the tee: 5 260 off, 41 040", async () => {
    const result = await checkout(input({
      discountCode: "SCOPEDTEE",
      items: [
        { productId: MUG, quantity: 1 },
        { productId: FLOOR_TEE, quantity: 1 },
      ],
    }));
    expect(result.checkout).toMatchObject({ discountMinor: 5_260, totalMinor: 41_040 });
  });

  it("a commission of 0 lets C at 10 % apply: the rule reads the shop's own rate", async () => {
    await env.DB.prepare("UPDATE tenants SET commission_bps = 0 WHERE tenant_id = ?").bind(TENANT).run();
    try {
      const result = await checkout(input({ discountCode: "PCT10", items: [{ productId: FLOOR_TEE, quantity: 1 }] }));
      expect(result.checkout).toMatchObject({ discountMinor: 2_630, totalMinor: 23_670 });
    } finally {
      await env.DB.prepare("UPDATE tenants SET commission_bps = NULL WHERE tenant_id = ?").bind(TENANT).run();
    }
  });

  it("E: a 200 kr code on a 200 kr mug collected does not apply; shipped it does, never the carriage", async () => {
    const collected = await checkout(input({ discountCode: "FIXED20000", items: [{ productId: MUG, quantity: 1 }] }));
    expect(collected.checkout).toMatchObject({ discountMinor: 0, totalMinor: 20_000 });
    expect(await holdsOfCheckout(collected.checkout.checkoutId)).toEqual([]);

    const shipped = await checkout(input({
      deliveryMethod: "shipping",
      discountCode: "FIXED20000",
      items: [{ productId: MUG, quantity: 1 }],
      shippingCountry: "SE",
    }));
    expect(shipped.checkout.discountMinor).toBe(20_000);
    expect(shipped.checkout.totalMinor).toBe(shipped.checkout.shippingMinor);
    expect(shipped.checkout.shippingMinor).toBeGreaterThanOrEqual(300);
  });

  it("B at 35 % on a shipped tee does not apply", async () => {
    await seedProduct(TENANT, { productId: "b-tee", priceMinor: 29_900 });
    const mapped = await createMapping(env.DB, ADMIN, {
      artworkId: "floor-front",
      printerId: "fake-printer",
      productId: "b-tee",
      sku: TEE_S,
      slots: ["front"],
      variantId: null,
    }, Date.now());
    expect(mapped.status).toBe("ok");
    expect((await publishAdminProduct(env.DB, ADMIN, "b-tee", Date.now())).status).toBe("ok");
    const shipped = (code: string) =>
      checkout(input({ deliveryMethod: "shipping", discountCode: code, items: [{ productId: "b-tee", quantity: 1 }], shippingCountry: "SE" }));
    // 29 900 + 2 900 carriage: 35 % is 10 465 off, 22 335 to pay, fee 1 116 + 23 625 > it.
    expect((await shipped("PCT35")).checkout).toMatchObject({ discountMinor: 0, totalMinor: 32_800 });
    // 20 %: 5 980 off, 26 820 to pay, fee 1 341 + 23 625 = 24 966 ≤ it.
    expect((await shipped("PCT20")).checkout).toMatchObject({ discountMinor: 5_980, totalMinor: 26_820 });
  });
});

describe("the attempt limit (DC16): 20 code-carrying checkouts per visitor per 10 minutes", () => {
  let address = 0;
  /** Each request from its own address, all in one /64: the checkout's own per-IP limit never binds. */
  async function post(body: Record<string, unknown>): Promise<Response> {
    address += 1;
    return exports.default.fetch(
      new Request(`https://${HOST}/v1/checkout`, {
        body: JSON.stringify(
          withBuyerRecipient({
            consent: BUYER_CONSENT,
            deliveryMethod: "pickup",
            email: `${nextId("attempt")}@buyer.test`,
            idempotencyKey: nextId("attempt-key"),
            items: [{ productId: MUG, quantity: 1 }],
            ...body,
          }),
        ),
        headers: { "cf-connecting-ip": `2001:db8:dc:16::${address.toString(16)}`, "content-type": "application/json" },
        method: "POST",
      }),
    );
  }

  it("refuses the 21st code-carrying checkout and never counts one without a code", async () => {
    for (let index = 0; index < 20; index += 1) {
      if (index % 4 === 0) {
        expect((await post({})).status, `code-less ${index}`).toBe(201);
      }
      expect((await post({ discountCode: index % 2 === 0 ? "PCT20" : "NOSUCH" })).status, `attempt ${index + 1}`).toBe(201);
    }
    const refused = await post({ discountCode: "PCT20" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect((await post({})).status).toBe(201);
  });
});
