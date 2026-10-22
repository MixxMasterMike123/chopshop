import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createCheckout, type CreateCheckoutInput, parseCreateCheckoutInput } from "../src/commerce/checkout";
import { parseDiscountPreviewInput, previewDiscount } from "../src/commerce/discount-preview";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import { featureStatement, nextId, seedAccess, seedAffiliate, seedUser } from "./affiliate-fixtures";
import { holdsOfCheckout, seedCode, seedPlainProduct, seedShop, usedCountOf } from "./discount-fixtures";
import { payCheckout } from "./money-fixtures";

/**
 * CP13 — the seam (design §2.2–§2.3): which code wins, what is frozen, the
 * hold and the burn for the campaign authority only, the preview's parity
 * with the checkout, replay parity. The ledger half is
 * test/affiliate-ledger.test.ts.
 */

const SHOP = "aff-seam";
const SHOP_B = "aff-seam-b";
const ONLY = "aff-seam-only";
const OFF = "aff-seam-off";
const CONTEXT: TenantContext = { domainKind: "storefront", hostname: "aff-seam.test", tenantId: SHOP };
const CONTEXT_B: TenantContext = { domainKind: "storefront", hostname: "aff-seam-b.test", tenantId: SHOP_B };
const ONLY_CONTEXT: TenantContext = { domainKind: "storefront", hostname: "aff-seam-only.test", tenantId: ONLY };
const OFF_CONTEXT: TenantContext = { domainKind: "storefront", hostname: "aff-seam-off.test", tenantId: OFF };
const MUG = "seam-mug";
const PRICE = 50_000;

let anna = "";
let annaUser = "";
let bo = "";
let campaign = "";

/** Product ids are global: each shop's mug has its own. */
function mugOf(tenant: string): string {
  return `${tenant}-${MUG}`;
}

/** An engine-level body (no consent, no recipient: both optional there). */
function input(overrides: Partial<CreateCheckoutInput> = {}): CreateCheckoutInput {
  return {
    deliveryMethod: "pickup",
    discountCode: null,
    email: `${nextId("buyer")}@buyer.test`,
    idempotencyKey: nextId("idem"),
    items: [{ productId: MUG, quantity: 1 }],
    shippingCountry: null,
    ...overrides,
  };
}

async function checkout(value: CreateCheckoutInput, context: TenantContext = CONTEXT) {
  const items = value.items.map((item) =>
    item.productId === MUG ? { ...item, productId: mugOf(context.tenantId) } : item,
  );
  const result = await createCheckout(env.DB, context, { ...value, items }, Date.now());
  if (result.status !== "ok") {
    throw new Error(`checkout: ${result.status}`);
  }
  return result;
}

interface FrozenRow {
  affiliate_attribution: string | null;
  affiliate_code: string | null;
  affiliate_commission_bp: number | null;
  affiliate_discount_bp: number | null;
  affiliate_id: string | null;
  affiliate_self_referral: number | null;
  discount_authority: string | null;
  discount_code_id: string | null;
  discount_minor: number;
  total_minor: number;
}

async function frozen(checkoutId: string): Promise<FrozenRow> {
  const row = await env.DB.prepare(
    `SELECT discount_authority, discount_code_id, discount_minor, total_minor, affiliate_id, affiliate_code,
            affiliate_attribution, affiliate_commission_bp, affiliate_discount_bp, affiliate_self_referral
     FROM checkouts WHERE checkout_id = ?`,
  )
    .bind(checkoutId)
    .first<FrozenRow>();
  if (row === null) {
    throw new Error("no checkout");
  }
  return row;
}

beforeAll(async () => {
  for (const [tenant, host, discountCodes] of [
    [SHOP, "aff-seam.test", true],
    [SHOP_B, "aff-seam-b.test", true],
    [ONLY, "aff-seam-only.test", false],
    [OFF, "aff-seam-off.test", true],
  ] as const) {
    await seedShop(tenant, host, { discountCodes });
    await seedPlainProduct(tenant, mugOf(tenant), PRICE);
  }
  await env.DB.batch([
    featureStatement(SHOP, "affiliate", true),
    featureStatement(SHOP_B, "affiliate", true),
    featureStatement(ONLY, "affiliate", true),
    featureStatement(OFF, "affiliate", false),
  ]);
  annaUser = await seedUser("anna@seam.test");
  await seedAccess(annaUser, "affiliate");
  anna = (await seedAffiliate({ code: "ANNA10", tenantId: SHOP, userId: annaUser })).affiliateId;
  bo = (await seedAffiliate({ code: "BO15", discountBp: 1_500, tenantId: SHOP })).affiliateId;
  await seedAffiliate({ code: "SLEEPER", status: "inactive", tenantId: SHOP });
  await seedAffiliate({ code: "ONLY10", tenantId: ONLY });
  await seedAffiliate({ code: "OFF10", tenantId: OFF });
  // The same code string in another shop is that shop's (never crosses).
  await seedAffiliate({ code: "SHARED", discountBp: 2_000, tenantId: SHOP_B });
  campaign = await seedCode({ code: "SOMMAR20", percentBp: 2_000, tenantId: SHOP });
});

describe("the body (design §2.2)", () => {
  it("parses refCode like discountCode: normalized, the same grammar", () => {
    const base = {
      consent: { terms: true },
      deliveryMethod: "pickup",
      email: "a@b.test",
      idempotencyKey: "idem-12345678",
      items: [{ productId: "p", quantity: 1 }],
      recipient: { name: "A B", pickupLocationId: "x" },
    };
    expect(parseCreateCheckoutInput({ ...base, refCode: "  anna10 " })?.refCode).toBe("ANNA10");
    expect(parseCreateCheckoutInput(base)?.refCode).toBeNull();
    expect(parseCreateCheckoutInput({ ...base, refCode: 5 })).toBeNull();
    expect(parseCreateCheckoutInput({ ...base, refCode: "   " })).toBeNull();
    expect(parseDiscountPreviewInput({ items: [{ productId: "p", quantity: 1 }], refCode: "anna10" })).toEqual({
      code: null,
      items: [{ productId: "p", quantity: 1 }],
      refCode: "ANNA10",
    });
    expect(parseDiscountPreviewInput({ items: [{ productId: "p", quantity: 1 }] })).toBeNull();
  });
});

describe("which code wins", () => {
  it("a link code (lower case, as a landing carries it) freezes the affiliate: 10 % off, attribution 'link'", async () => {
    const result = await checkout(input({ refCode: "ANNA10" }));
    expect(result.checkout).toMatchObject({ discountCode: "ANNA10", discountMinor: 5_000, totalMinor: 45_000 });
    expect(result.checkout.overriddenBy).toBeUndefined();
    expect(await frozen(result.checkout.checkoutId)).toEqual({
      affiliate_attribution: "link",
      affiliate_code: "ANNA10",
      affiliate_commission_bp: 1_500,
      affiliate_discount_bp: 1_000,
      affiliate_id: anna,
      affiliate_self_referral: 0,
      discount_authority: "affiliate",
      discount_code_id: anna,
      discount_minor: 5_000,
      total_minor: 45_000,
    });
  });

  it("the link wins over a typed code and says so (overriddenBy 'link')", async () => {
    const result = await checkout(input({ discountCode: "SOMMAR20", refCode: "ANNA10" }));
    expect(result.checkout).toMatchObject({ discountCode: "ANNA10", discountMinor: 5_000, overriddenBy: "link" });
    expect((await frozen(result.checkout.checkoutId)).affiliate_id).toBe(anna);
    const typedAffiliate = await checkout(input({ discountCode: "BO15", refCode: "ANNA10" }));
    expect(typedAffiliate.checkout.overriddenBy).toBe("link");
    expect((await frozen(typedAffiliate.checkout.checkoutId)).affiliate_id).toBe(anna);
  });

  it("a typed affiliate code earns too: attribution 'code'", async () => {
    const result = await checkout(input({ discountCode: "BO15" }));
    expect(result.checkout).toMatchObject({ discountCode: "BO15", discountMinor: 7_500 });
    expect(await frozen(result.checkout.checkoutId)).toMatchObject({
      affiliate_attribution: "code",
      affiliate_id: bo,
      discount_authority: "affiliate",
    });
  });

  it("an inactive affiliate's link falls through to the typed campaign code, which holds its use", async () => {
    const result = await checkout(input({ discountCode: "SOMMAR20", refCode: "SLEEPER" }));
    expect(result.checkout).toMatchObject({ discountCode: "SOMMAR20", discountMinor: 10_000 });
    expect(result.checkout.overriddenBy).toBeUndefined();
    expect(await frozen(result.checkout.checkoutId)).toMatchObject({
      affiliate_id: null,
      discount_authority: "campaign",
      discount_code_id: campaign,
    });
    expect(await holdsOfCheckout(result.checkout.checkoutId)).toHaveLength(1);
  });

  it("a campaign code in ?ref= applies nothing (R2-24); an unknown link code is worth 0, silently", async () => {
    const viaLink = await checkout(input({ refCode: "SOMMAR20" }));
    expect(viaLink.checkout).toMatchObject({ discountCode: null, discountMinor: 0 });
    expect((await frozen(viaLink.checkout.checkoutId)).discount_authority).toBeNull();
    const unknown = await checkout(input({ refCode: "NOBODY" }));
    expect(unknown.checkout).toMatchObject({ discountCode: null, discountMinor: 0, totalMinor: PRICE });
  });

  it("the same code in another shop never crosses", async () => {
    const here = await checkout(input({ refCode: "SHARED" }));
    expect(here.checkout.discountMinor).toBe(0);
    const there = await checkout(input({ refCode: "SHARED" }), CONTEXT_B);
    expect(there.checkout.discountMinor).toBe(10_000);
    const foreign = await checkout(input({ refCode: "ANNA10" }), CONTEXT_B);
    expect(foreign.checkout.discountMinor).toBe(0);
  });

  it("an affiliate-only shop (Rabattkoder off) gets its affiliate's discount", async () => {
    const result = await checkout(input({ refCode: "ONLY10" }), ONLY_CONTEXT);
    expect(result.checkout).toMatchObject({ discountCode: "ONLY10", discountMinor: 5_000 });
    expect((await frozen(result.checkout.checkoutId)).discount_authority).toBe("affiliate");
    // A typed affiliate code too.
    expect((await checkout(input({ discountCode: "ONLY10" }), ONLY_CONTEXT)).checkout.discountMinor).toBe(5_000);
  });

  it("with the add-on OFF no affiliate quote is made; campaign codes still work", async () => {
    expect((await checkout(input({ refCode: "OFF10" }), OFF_CONTEXT)).checkout.discountMinor).toBe(0);
    expect((await checkout(input({ discountCode: "OFF10" }), OFF_CONTEXT)).checkout.discountMinor).toBe(0);
    await seedCode({ code: "OFFCAMP", percentBp: 1_000, tenantId: OFF });
    expect((await checkout(input({ discountCode: "OFFCAMP", refCode: "OFF10" }), OFF_CONTEXT)).checkout.discountMinor).toBe(5_000);
  });
});

describe("the defensive precedence (a collision the triggers would refuse)", () => {
  it("an active affiliate wins over a Rabattkod of the same string; the Rabattkod resolves when the affiliate is inactive or the add-on OFF", async () => {
    const tenant = "aff-seam-collide";
    await seedShop(tenant, "aff-seam-collide.test", { discountCodes: true });
    await seedPlainProduct(tenant, mugOf(tenant), PRICE);
    await featureStatement(tenant, "affiliate", true).run();
    const context: TenantContext = { domainKind: "storefront", hostname: "aff-seam-collide.test", tenantId: tenant };
    // Only by dropping the guard can both families hold one string (this
    // file's database only).
    await env.DB.prepare("DROP TRIGGER affiliates_code_free_insert").run();
    const { affiliateId } = await seedAffiliate({ code: "TWIN10", tenantId: tenant });
    await env.DB.prepare("DROP TRIGGER discount_codes_code_free_insert").run();
    const twin = await seedCode({ code: "TWIN10", percentBp: 3_000, tenantId: tenant });

    const typed = await checkout(input({ discountCode: "TWIN10" }), context);
    expect(typed.checkout.discountMinor).toBe(5_000);
    expect((await frozen(typed.checkout.checkoutId)).affiliate_id).toBe(affiliateId);

    await env.DB.prepare("UPDATE affiliates SET status = 'inactive' WHERE affiliate_id = ?").bind(affiliateId).run();
    const inactive = await checkout(input({ discountCode: "TWIN10" }), context);
    expect(inactive.checkout.discountMinor).toBe(15_000);
    expect((await frozen(inactive.checkout.checkoutId)).discount_code_id).toBe(twin);

    await env.DB.prepare("UPDATE affiliates SET status = 'active' WHERE affiliate_id = ?").bind(affiliateId).run();
    await featureStatement(tenant, "affiliate", false).run();
    const off = await checkout(input({ discountCode: "TWIN10" }), context);
    expect(off.checkout.discountMinor).toBe(15_000);
  });
});

describe("holds and burns: the campaign authority only", () => {
  it("an affiliate code holds nothing, and the webhook burns no campaign use and copies the facts", async () => {
    const result = await checkout(input({ refCode: "ANNA10" }));
    expect(await holdsOfCheckout(result.checkout.checkoutId)).toEqual([]);
    const intent = `pi_seam_${result.checkout.checkoutId.replaceAll("-", "")}`;
    await env.DB.prepare("UPDATE checkouts SET payment_intent_id = ? WHERE checkout_id = ?")
      .bind(intent, result.checkout.checkoutId)
      .run();
    const before = await usedCountOf(campaign);
    const orderId = await payCheckout(
      { checkoutId: result.checkout.checkoutId, paymentIntentId: intent, totalMinor: result.checkout.totalMinor },
      SHOP,
    );
    expect(await usedCountOf(campaign)).toBe(before);
    const order = await env.DB.prepare(
      `SELECT discount_authority, discount_code_id, affiliate_id, affiliate_code, affiliate_attribution,
              affiliate_commission_bp, affiliate_discount_bp, affiliate_self_referral
       FROM orders WHERE order_id = ?`,
    )
      .bind(orderId)
      .first();
    expect(order).toEqual({
      affiliate_attribution: "link",
      affiliate_code: "ANNA10",
      affiliate_commission_bp: 1_500,
      affiliate_discount_bp: 1_000,
      affiliate_id: anna,
      affiliate_self_referral: 0,
      discount_authority: "affiliate",
      discount_code_id: anna,
    });
  });

  it("a campaign checkout still holds and burns exactly as before", async () => {
    const result = await checkout(input({ discountCode: "SOMMAR20" }));
    expect(await holdsOfCheckout(result.checkout.checkoutId)).toHaveLength(1);
    const intent = `pi_seam_${result.checkout.checkoutId.replaceAll("-", "")}`;
    await env.DB.prepare("UPDATE checkouts SET payment_intent_id = ? WHERE checkout_id = ?")
      .bind(intent, result.checkout.checkoutId)
      .run();
    const before = await usedCountOf(campaign);
    await payCheckout({ checkoutId: result.checkout.checkoutId, paymentIntentId: intent, totalMinor: result.checkout.totalMinor }, SHOP);
    expect(await usedCountOf(campaign)).toBe(before + 1);
    expect((await holdsOfCheckout(result.checkout.checkoutId))[0]?.state).toBe("used");
  });
});

describe("attribution never depends on the amount (R2-8)", () => {
  it("a 0 % affiliate is frozen beside a zero discount", async () => {
    const tenant = "aff-seam-zero";
    await seedShop(tenant, "aff-seam-zero.test", { discountCodes: false });
    await seedPlainProduct(tenant, mugOf(tenant), PRICE);
    await featureStatement(tenant, "affiliate", true).run();
    const { affiliateId } = await seedAffiliate({ code: "ZERO0", discountBp: 0, tenantId: tenant });
    const result = await checkout(input({ refCode: "ZERO0" }), {
      domainKind: "storefront",
      hostname: "aff-seam-zero.test",
      tenantId: tenant,
    });
    expect(result.checkout.discountMinor).toBe(0);
    expect(await frozen(result.checkout.checkoutId)).toMatchObject({
      affiliate_discount_bp: 0,
      affiliate_id: affiliateId,
      discount_authority: "affiliate",
      discount_minor: 0,
    });
  });

  it("a discount the minimum-charge rule discards keeps the affiliate frozen with 0 off", async () => {
    const tenant = "aff-seam-tiny";
    await seedShop(tenant, "aff-seam-tiny.test", { discountCodes: false });
    // 3,20 kr: 10 % off would leave 2,88 kr, under the 3 kr minimum (DC6).
    await seedPlainProduct(tenant, "aff-seam-tiny-mug", 320);
    await featureStatement(tenant, "affiliate", true).run();
    const { affiliateId } = await seedAffiliate({ code: "TINY10", tenantId: tenant });
    const result = await checkout(
      input({ items: [{ productId: "aff-seam-tiny-mug", quantity: 1 }], refCode: "TINY10" }),
      { domainKind: "storefront", hostname: "aff-seam-tiny.test", tenantId: tenant },
    );
    expect(result.checkout).toMatchObject({ discountMinor: 0, totalMinor: 320 });
    expect(await frozen(result.checkout.checkoutId)).toMatchObject({
      affiliate_id: affiliateId,
      discount_authority: "affiliate",
      discount_minor: 0,
    });
  });
});

describe("self-referral, decided at quote time (design §4.3)", () => {
  it("is 1 when the buyer is the affiliate, or an active admin of the shop; 0 otherwise", async () => {
    const own = await checkout(input({ email: "anna@seam.test", refCode: "ANNA10" }));
    expect(own.checkout.discountMinor).toBe(5_000);
    expect((await frozen(own.checkout.checkoutId)).affiliate_self_referral).toBe(1);

    const adminUser = await seedUser("owner@seam.test");
    await seedAccess(adminUser, "tenant_admin");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO tenant_memberships (membership_id, tenant_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
    )
      .bind(nextId("m"), SHOP, adminUser, now, now)
      .run();
    const admin = await checkout(input({ email: "owner@seam.test", refCode: "ANNA10" }));
    expect((await frozen(admin.checkout.checkoutId)).affiliate_self_referral).toBe(1);

    const stranger = await checkout(input({ refCode: "ANNA10" }));
    expect((await frozen(stranger.checkout.checkoutId)).affiliate_self_referral).toBe(0);
  });
});

describe("replay parity and the preview", () => {
  it("replays the same request, and conflicts once the affiliate's rate changed", async () => {
    const value = input({ items: [{ productId: mugOf(SHOP), quantity: 1 }], refCode: "BO15" });
    const first = await checkout(value);
    const again = await createCheckout(env.DB, CONTEXT, value, Date.now());
    expect(again).toMatchObject({ replayed: true, status: "ok" });
    expect(again.status === "ok" ? again.checkout.checkoutId : "").toBe(first.checkout.checkoutId);

    await env.DB.prepare("UPDATE affiliates SET commission_bp = 2000 WHERE affiliate_id = ?").bind(bo).run();
    expect(await createCheckout(env.DB, CONTEXT, value, Date.now())).toEqual({ status: "conflict" });
    await env.DB.prepare("UPDATE affiliates SET commission_bp = 1500 WHERE affiliate_id = ?").bind(bo).run();

    // Another affiliate with the SAME discount is not interchangeable either.
    const twinUser = await seedUser("twin@seam.test");
    await seedAccess(twinUser, "affiliate");
    await seedAffiliate({ code: "TWINBO", discountBp: 1_500, tenantId: SHOP, userId: twinUser });
    expect(await createCheckout(env.DB, CONTEXT, { ...value, refCode: "TWINBO" }, Date.now())).toEqual({ status: "conflict" });
  });

  it("the preview answers what the checkout charges, and nothing of the affiliate", async () => {
    for (const body of [
      { refCode: "ANNA10" },
      { code: "BO15" },
      { code: "SOMMAR20", refCode: "ANNA10" },
      { code: "SOMMAR20", refCode: "SLEEPER" },
      { refCode: "NOBODY" },
      { code: "sommar20" },
    ]) {
      const parsed = parseDiscountPreviewInput({ ...body, items: [{ productId: mugOf(SHOP), quantity: 1 }] });
      expect(parsed, JSON.stringify(body)).not.toBeNull();
      const preview = await previewDiscount(env.DB, CONTEXT, parsed!, Date.now(), false);
      const result = await checkout(
        input({
          discountCode: parsed!.code,
          refCode: parsed!.refCode,
        }),
      );
      expect(preview.status).toBe("ok");
      const discount = preview.status === "ok" ? preview.discount : null;
      expect(discount?.discountMinor, JSON.stringify(body)).toBe(result.checkout.discountMinor);
      expect(Object.keys(discount ?? {}).sort()).toEqual(["applies", "code", "discountMinor"]);
      if ((discount?.discountMinor ?? 0) > 0) {
        expect(discount?.code).toBe(result.checkout.discountCode);
      }
    }
    // An affiliate-only shop previews its affiliate code.
    const only = parseDiscountPreviewInput({ code: "ONLY10", items: [{ productId: mugOf(ONLY), quantity: 1 }] });
    expect(await previewDiscount(env.DB, ONLY_CONTEXT, only!, Date.now(), false)).toEqual({
      discount: { applies: true, code: "ONLY10", discountMinor: 5_000 },
      status: "ok",
    });
  });
});
