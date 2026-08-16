import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MAX_DISCOUNT_PERCENT_BP,
  percentDiscountMinor,
} from "../src/commerce/discount-codes";

const NOW = 1_787_200_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Window fixtures are anchored to the REAL clock, not to the NOW constant.
 *
 * NOW is a fixed row-timestamp fixture shared with the other suites, and it
 * happens to sit slightly in the future of any given test run. The route reads
 * its own `Date.now()` when it evaluates a validity window, so a window
 * expressed relative to NOW says nothing about whether it is open — a "day
 * before NOW" end date was still comfortably in the future and the supposedly
 * expired code applied. These anchors make the window fixtures mean what their
 * names say.
 */
const REAL_NOW = Date.now();
const PAST = REAL_NOW - DAY_MS;
const FUTURE = REAL_NOW + DAY_MS;

const TENANT_A = "tenant-dc-a";
const TENANT_B = "tenant-dc-b";
const HOST_A = "a.discount.test";
const HOST_B = "b.discount.test";

interface CheckoutBody {
  checkout: {
    checkoutId: string;
    discountCode: string | null;
    discountMinor: number;
    shippingMinor: number;
    subtotalMinor: number;
    totalMinor: number;
    vatMinor: number;
    vatRateBp: number;
  };
}

interface SeedCodeOptions {
  active?: boolean;
  code: string;
  discountCodeId: string;
  endsAt?: number | null;
  maxUses?: number | null;
  minSpendMinor?: number | null;
  percentBp?: number | null;
  productIds?: string[] | null;
  scope?: "all" | "products";
  startsAt?: number | null;
  tenantId: string;
  type: "fixed" | "percent";
  usedCount?: number;
  valueMinor?: number | null;
}

async function seedTenant(tenantId: string, hostname: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, support_email, default_locale,
        default_currency, created_at, updated_at
      ) VALUES (?, 'active', ?, ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, `Shop ${tenantId}`, `ops-${tenantId}@example.test`, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, NOW, NOW),
  ]);
}

async function seedProduct(
  tenantId: string,
  productId: string,
  priceMinor: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO products (
        product_id, tenant_id, status, sku, name, description,
        b2c_price_minor, currency, is_pod, weight_grams,
        allow_shipping, allow_pickup, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, NULL, ?, 'SEK', 0, 0, 1, 1, ?, ?)`,
    ).bind(
      productId,
      tenantId,
      `SKU-${productId}`,
      `Internal ${productId}`,
      priceMinor,
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO product_publications (
        product_id, tenant_id, published, public_name, public_description,
        public_price_minor, currency, projection_version, published_at, updated_at
      ) VALUES (?, ?, 1, ?, NULL, ?, 'SEK', 1, ?, ?)`,
    ).bind(productId, tenantId, `Public ${productId}`, priceMinor, NOW, NOW),
  ]);
}

async function seedCode(options: SeedCodeOptions): Promise<void> {
  const scope = options.scope ?? "all";
  await env.DB.prepare(
    `INSERT INTO discount_codes (
      discount_code_id, tenant_id, code, active, type, value_minor, percent_bp,
      starts_at, ends_at, max_uses, used_count, min_spend_minor, scope,
      product_ids_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      options.discountCodeId,
      options.tenantId,
      options.code,
      (options.active ?? true) ? 1 : 0,
      options.type,
      options.valueMinor ?? null,
      options.percentBp ?? null,
      options.startsAt ?? null,
      options.endsAt ?? null,
      options.maxUses ?? null,
      options.usedCount ?? 0,
      options.minSpendMinor ?? null,
      scope,
      options.productIds == null ? null : JSON.stringify(options.productIds),
      NOW,
      NOW,
    )
    .run();
}

let ipCounter = 0;

/** Per-request client address; the route is rate limited 10/min per IP. */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 256}:${ipCounter}`;
}

let emailCounter = 0;

/**
 * A distinct buyer address per case unless the test pins one.
 *
 * Checkpoint 21 recorded this the hard way: the checkout route also limits 30
 * requests per hour PER EMAIL, so a pricing suite that reuses one address turns
 * its later cases into 429s that look like pricing failures. Every case here
 * that is not specifically about replay gets its own address.
 */
function nextEmail(): string {
  emailCounter += 1;
  return `buyer-${emailCounter.toString().padStart(4, "0")}@example.test`;
}

let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return `dc-key-${keyCounter.toString().padStart(4, "0")}`;
}

async function post(
  hostname: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://${hostname}/v1/checkout`, {
      method: "POST",
      headers: {
        "cf-connecting-ip": nextIp(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deliveryMethod: "pickup",
        email: nextEmail(),
        idempotencyKey: nextKey(),
        ...body,
      }),
    }),
  );
}

/**
 * A collected basket by default, so carriage is zero and every assertion below
 * is about the discount rather than about the shipping engine. The shipping
 * interaction gets its own case, which names the method explicitly.
 */
async function quote(
  body: Record<string, unknown>,
): Promise<CheckoutBody["checkout"]> {
  const response = await post(HOST_A, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as CheckoutBody).checkout;
}

async function storedRow(checkoutId: string): Promise<{
  discount_code_id: string | null;
  discount_minor: number;
  subtotal_minor: number;
  total_minor: number;
} | null> {
  return env.DB.prepare(
    `SELECT discount_minor, discount_code_id, subtotal_minor, total_minor
     FROM checkouts WHERE checkout_id = ?`,
  )
    .bind(checkoutId)
    .first();
}

beforeAll(async () => {
  await seedTenant(TENANT_A, HOST_A);
  await seedTenant(TENANT_B, HOST_B);

  // 1000 minor each, so a two-unit line is exactly 2000 and every expected
  // number below is checkable by hand.
  await seedProduct(TENANT_A, "dc-a-one", 1_000);
  await seedProduct(TENANT_A, "dc-a-two", 2_000);
  await seedProduct(TENANT_A, "dc-a-three", 3_000);
  // Deliberately not divisible by anything convenient: the percent cases below
  // need a base whose percentage is fractional.
  await seedProduct(TENANT_A, "dc-a-odd", 1_337);
  await seedProduct(TENANT_B, "dc-b-one", 1_000);

  await seedCode({
    code: "ALLTEN",
    discountCodeId: "dc-all-ten",
    percentBp: 1_000,
    tenantId: TENANT_A,
    type: "percent",
  });
  await seedCode({
    code: "FIXED500",
    discountCodeId: "dc-fixed-500",
    tenantId: TENANT_A,
    type: "fixed",
    valueMinor: 500,
  });
  await seedCode({
    code: "FIXEDHUGE",
    discountCodeId: "dc-fixed-huge",
    tenantId: TENANT_A,
    type: "fixed",
    valueMinor: 100_000_000,
  });
  await seedCode({
    code: "INACTIVE",
    active: false,
    discountCodeId: "dc-inactive",
    tenantId: TENANT_A,
    type: "fixed",
    valueMinor: 500,
  });
  await seedCode({
    code: "NOTYET",
    discountCodeId: "dc-not-yet",
    startsAt: FUTURE,
    tenantId: TENANT_A,
    type: "fixed",
    valueMinor: 500,
  });
  await seedCode({
    code: "EXPIRED",
    discountCodeId: "dc-expired",
    endsAt: PAST,
    tenantId: TENANT_A,
    type: "fixed",
    valueMinor: 500,
  });
  await seedCode({
    code: "FILLEDUP",
    discountCodeId: "dc-filled-up",
    maxUses: 5,
    tenantId: TENANT_A,
    type: "fixed",
    usedCount: 5,
    valueMinor: 500,
  });
  await seedCode({
    code: "ONELEFT",
    discountCodeId: "dc-one-left",
    maxUses: 5,
    tenantId: TENANT_A,
    type: "fixed",
    usedCount: 4,
    valueMinor: 500,
  });
  await seedCode({
    code: "MINSPEND",
    discountCodeId: "dc-min-spend",
    minSpendMinor: 3_000,
    tenantId: TENANT_A,
    type: "fixed",
    valueMinor: 500,
  });
  await seedCode({
    code: "SCOPEDONE",
    discountCodeId: "dc-scoped-one",
    percentBp: 5_000,
    productIds: ["dc-a-one"],
    scope: "products",
    tenantId: TENANT_A,
    type: "percent",
  });
  await seedCode({
    code: "SCOPEDSTALE",
    discountCodeId: "dc-scoped-stale",
    percentBp: 5_000,
    productIds: ["dc-a-deleted", "dc-b-one"],
    scope: "products",
    tenantId: TENANT_A,
    type: "percent",
  });
  await seedCode({
    code: "SCOPEDFIXED",
    discountCodeId: "dc-scoped-fixed",
    productIds: ["dc-a-one"],
    scope: "products",
    tenantId: TENANT_A,
    type: "fixed",
    valueMinor: 100_000,
  });
  await seedCode({
    code: "FRACTION",
    discountCodeId: "dc-fraction",
    // 12.5%, the fractional percent the basis-point column exists for.
    percentBp: 1_250,
    tenantId: TENANT_A,
    type: "percent",
  });
  await seedCode({
    code: "FULLHUNDRED",
    discountCodeId: "dc-full-hundred",
    percentBp: 10_000,
    tenantId: TENANT_A,
    type: "percent",
  });
  // Same string on the other tenant, worth something entirely different. Neither
  // storefront may resolve the other's.
  await seedCode({
    code: "ALLTEN",
    discountCodeId: "dc-b-all-ten",
    tenantId: TENANT_B,
    type: "fixed",
    valueMinor: 999,
  });
});

describe("checkout discount eligibility", () => {
  it("applies an eligible percentage code and freezes the resolved code id", async () => {
    const checkout = await quote({
      discountCode: "ALLTEN",
      items: [{ productId: "dc-a-one", quantity: 2 }],
    });

    expect(checkout.subtotalMinor).toBe(2_000);
    expect(checkout.discountMinor).toBe(200);
    expect(checkout.discountCode).toBe("ALLTEN");
    expect(checkout.totalMinor).toBe(1_800);

    const row = await storedRow(checkout.checkoutId);
    expect(row?.discount_minor).toBe(200);
    expect(row?.discount_code_id).toBe("dc-all-ten");
  });

  it("prices a basket without a code at zero and stores no code id", async () => {
    const checkout = await quote({
      items: [{ productId: "dc-a-one", quantity: 1 }],
    });

    expect(checkout.discountMinor).toBe(0);
    expect(checkout.discountCode).toBeNull();
    expect((await storedRow(checkout.checkoutId))?.discount_code_id).toBeNull();
  });

  it.each([
    ["a deactivated code", "INACTIVE"],
    ["a code whose window has not opened", "NOTYET"],
    ["a code whose window has closed", "EXPIRED"],
    ["a code that has been fully used", "FILLEDUP"],
    ["a code whose minimum spend is unmet", "MINSPEND"],
    ["a code that does not exist at all", "NOSUCHCODE"],
  ])("silently discounts nothing for %s", async (_label, discountCode) => {
    const checkout = await quote({
      discountCode,
      items: [{ productId: "dc-a-one", quantity: 2 }],
    });

    // Not a 4xx: production answers zero and the client displays the same zero,
    // with the server's number authoritative. A status difference here would
    // also make the route an oracle for which codes a tenant runs.
    expect(checkout.discountMinor).toBe(0);
    expect(checkout.totalMinor).toBe(checkout.subtotalMinor);
    // The code the buyer typed is still echoed — what is absent is any hint of
    // WHY it was worth nothing.
    expect(checkout.discountCode).toBe(discountCode);
    expect((await storedRow(checkout.checkoutId))?.discount_code_id).toBeNull();
  });

  it("accepts a code whose window opens on this exact millisecond", async () => {
    // Production tests `now >= startsAt`, so the boundary millisecond is inside
    // the window. Seeding with a startsAt in the recent past rather than exactly
    // Date.now() is what makes this assertable: the route reads its own clock.
    await seedCode({
      code: "STARTSNOW",
      discountCodeId: "dc-starts-now",
      startsAt: Date.now(),
      tenantId: TENANT_A,
      type: "fixed",
      valueMinor: 500,
    });

    const checkout = await quote({
      discountCode: "STARTSNOW",
      items: [{ productId: "dc-a-one", quantity: 2 }],
    });

    expect(checkout.discountMinor).toBe(500);
  });

  it("accepts a code whose window has not yet closed", async () => {
    await seedCode({
      code: "ENDSSOON",
      discountCodeId: "dc-ends-soon",
      endsAt: Date.now() + 60_000,
      tenantId: TENANT_A,
      type: "fixed",
      valueMinor: 500,
    });

    const checkout = await quote({
      discountCode: "ENDSSOON",
      items: [{ productId: "dc-a-one", quantity: 2 }],
    });

    expect(checkout.discountMinor).toBe(500);
  });

  it("accepts a code with exactly one use left", async () => {
    // used_count == max_uses - 1. The predicate is `used < max`, so this is the
    // last eligible quote and the next one (after the payment checkpoint
    // increments) will not be.
    const checkout = await quote({
      discountCode: "ONELEFT",
      items: [{ productId: "dc-a-one", quantity: 2 }],
    });

    expect(checkout.discountMinor).toBe(500);
  });

  it("accepts a basket that meets the minimum spend exactly", async () => {
    // subtotal == min_spend. The predicate is `subtotal >= minSpend`, so the
    // exact boundary is eligible.
    const checkout = await quote({
      discountCode: "MINSPEND",
      items: [{ productId: "dc-a-three", quantity: 1 }],
    });

    expect(checkout.subtotalMinor).toBe(3_000);
    expect(checkout.discountMinor).toBe(500);
  });

  it("compares the minimum spend against the FULL subtotal, not the scoped base", async () => {
    // Production compares `subtotal >= minSpend` even for a products-scoped
    // code, and so does its client. A basket whose scoped base is below the
    // minimum but whose subtotal clears it is therefore eligible.
    await seedCode({
      code: "SCOPEDMIN",
      discountCodeId: "dc-scoped-min",
      minSpendMinor: 3_000,
      percentBp: 5_000,
      productIds: ["dc-a-one"],
      scope: "products",
      tenantId: TENANT_A,
      type: "percent",
    });

    const checkout = await quote({
      discountCode: "SCOPEDMIN",
      items: [
        { productId: "dc-a-one", quantity: 1 },
        { productId: "dc-a-three", quantity: 1 },
      ],
    });

    expect(checkout.subtotalMinor).toBe(4_000);
    // Half of the 1 000 scoped line, not half of the 4 000 subtotal.
    expect(checkout.discountMinor).toBe(500);
  });
});

describe("checkout discount arithmetic", () => {
  it("clamps a fixed discount to the subtotal it discounts", async () => {
    const checkout = await quote({
      discountCode: "FIXEDHUGE",
      items: [{ productId: "dc-a-one", quantity: 1 }],
    });

    expect(checkout.subtotalMinor).toBe(1_000);
    expect(checkout.discountMinor).toBe(1_000);
    expect(checkout.totalMinor).toBe(0);
  });

  it("clamps a fixed discount to the SCOPED base, not the whole subtotal", async () => {
    // The code is worth 100 000 against a scope containing only the 1 000 line.
    // Clamping to the subtotal instead of the base would discount 4 000.
    const checkout = await quote({
      discountCode: "SCOPEDFIXED",
      items: [
        { productId: "dc-a-one", quantity: 1 },
        { productId: "dc-a-three", quantity: 1 },
      ],
    });

    expect(checkout.subtotalMinor).toBe(4_000);
    expect(checkout.discountMinor).toBe(1_000);
    expect(checkout.totalMinor).toBe(3_000);
  });

  it("rounds a fractional percentage UP, matching production's Math.ceil", async () => {
    // 12.5% of 1 337 is 167.125. Production computes Math.ceil and so does its
    // client; rounding down or to nearest would diverge from the displayed
    // total by one minor unit.
    const checkout = await quote({
      discountCode: "FRACTION",
      items: [{ productId: "dc-a-odd", quantity: 1 }],
    });

    expect(checkout.subtotalMinor).toBe(1_337);
    expect(checkout.discountMinor).toBe(168);
    expect(checkout.totalMinor).toBe(1_169);
  });

  it("rounds an exact division DOWN to itself rather than up", async () => {
    // 12.5% of 2 000 is exactly 250. The ceiling must not add one to a division
    // that had no remainder.
    const checkout = await quote({
      discountCode: "FRACTION",
      items: [{ productId: "dc-a-two", quantity: 1 }],
    });

    expect(checkout.discountMinor).toBe(250);
  });

  it("allows a full-value code to zero the basket", async () => {
    const checkout = await quote({
      discountCode: "FULLHUNDRED",
      items: [{ productId: "dc-a-two", quantity: 1 }],
    });

    expect(checkout.discountMinor).toBe(2_000);
    expect(checkout.totalMinor).toBe(0);
    expect(checkout.vatMinor).toBe(0);
  });

  it("sums only the matching lines for a products-scoped code", async () => {
    const checkout = await quote({
      discountCode: "SCOPEDONE",
      items: [
        { productId: "dc-a-one", quantity: 3 },
        { productId: "dc-a-two", quantity: 2 },
        { productId: "dc-a-three", quantity: 1 },
      ],
    });

    // 3 × 1 000 + 2 × 2 000 + 3 000 = 10 000, of which only the 3 000 first line
    // is in scope. Half of that is 1 500.
    expect(checkout.subtotalMinor).toBe(10_000);
    expect(checkout.discountMinor).toBe(1_500);
  });

  it("treats product ids that match no line as contributing nothing", async () => {
    // The code names a deleted product and a product belonging to the OTHER
    // tenant. Neither is in this basket, so the scoped base is zero and the
    // discount collapses to nothing — production's behaviour with loose ids.
    const checkout = await quote({
      discountCode: "SCOPEDSTALE",
      items: [{ productId: "dc-a-one", quantity: 2 }],
    });

    expect(checkout.discountMinor).toBe(0);
    // A code worth nothing against this basket freezes no id: the payment
    // checkpoint must not burn a use on a discount that never happened.
    expect((await storedRow(checkout.checkoutId))?.discount_code_id).toBeNull();
  });

  it("never lets a discount reach the carriage", async () => {
    // Shipped rather than collected, so carriage is non-zero. A 100% code eats
    // the whole subtotal and not one minor unit of the shipping.
    const response = await post(HOST_A, {
      deliveryMethod: "shipping",
      discountCode: "FULLHUNDRED",
      items: [{ productId: "dc-a-two", quantity: 1 }],
      shippingCountry: "SE",
    });
    const checkout = ((await response.json()) as CheckoutBody).checkout;

    expect(response.status).toBe(201);
    expect(checkout.subtotalMinor).toBe(2_000);
    expect(checkout.discountMinor).toBe(2_000);
    expect(checkout.shippingMinor).toBeGreaterThan(0);
    expect(checkout.totalMinor).toBe(checkout.shippingMinor);
  });

  it("derives VAT from the DISCOUNTED total", async () => {
    // Production derives `vat = total - total/(1+rate)` where total is already
    // net of the discount, so a discount reduces the tax contained in it. The
    // expected value is the checkpoint-21 derivation applied to 1 800, not to
    // the 2 000 subtotal.
    const checkout = await quote({
      discountCode: "ALLTEN",
      items: [{ productId: "dc-a-one", quantity: 2 }],
    });

    expect(checkout.totalMinor).toBe(1_800);
    expect(checkout.vatRateBp).toBe(2_500);
    // 1800 - round(1800 * 10000 / 12500) = 1800 - 1440 = 360.
    expect(checkout.vatMinor).toBe(360);
  });

  it("stores a row that satisfies the totals contract with a real discount", async () => {
    const checkout = await quote({
      discountCode: "ALLTEN",
      items: [
        { productId: "dc-a-one", quantity: 2 },
        { productId: "dc-a-three", quantity: 1 },
      ],
    });
    const row = await storedRow(checkout.checkoutId);

    // The schema's CHECK would have refused the INSERT otherwise; this asserts
    // the numbers the row actually holds rather than trusting the response.
    expect(row?.total_minor).toBe(
      (row?.subtotal_minor ?? 0) - (row?.discount_minor ?? 0),
    );
    expect(row?.discount_minor).toBeLessThanOrEqual(row?.subtotal_minor ?? 0);
  });
});

describe("discount code normalization", () => {
  it("resolves a lowercase code, matching production's uppercase lookup", async () => {
    const checkout = await quote({
      discountCode: "allten",
      items: [{ productId: "dc-a-one", quantity: 2 }],
    });

    expect(checkout.discountMinor).toBe(200);
    // Echoed in the normalized form, not as typed: the stored code and the
    // resolved one are one string.
    expect(checkout.discountCode).toBe("ALLTEN");
  });

  it("resolves a code surrounded by whitespace", async () => {
    const checkout = await quote({
      discountCode: "  AllTen  ",
      items: [{ productId: "dc-a-one", quantity: 2 }],
    });

    expect(checkout.discountMinor).toBe(200);
    expect(checkout.discountCode).toBe("ALLTEN");
  });

  it.each([
    ["a non-string code", 42],
    ["a null code", null],
    ["an empty code", ""],
    ["a whitespace-only code", "   "],
    ["a code containing a newline", "ALL\nTEN"],
    ["a code past the fifty-character bound", "A".repeat(51)],
  ])("rejects %s as a shape failure", async (_label, discountCode) => {
    const response = await post(HOST_A, {
      discountCode,
      items: [{ productId: "dc-a-one", quantity: 1 }],
    });

    // A 400 rather than a silent zero. This is decided without touching the
    // database, so it reveals nothing about which codes exist — unlike an
    // unknown-but-well-formed code, which is silently worth nothing.
    expect(response.status).toBe(400);
  });

  it("accepts a code at exactly the fifty-character bound", async () => {
    await seedCode({
      code: "B".repeat(50),
      discountCodeId: "dc-max-length",
      tenantId: TENANT_A,
      type: "fixed",
      valueMinor: 100,
    });

    const checkout = await quote({
      discountCode: "b".repeat(50),
      items: [{ productId: "dc-a-one", quantity: 1 }],
    });

    expect(checkout.discountMinor).toBe(100);
  });
});

describe("discount code tenancy", () => {
  it("does not resolve tenant A's code on tenant B's storefront", async () => {
    // ALLTEN exists on BOTH tenants, worth 10% on A and 999 fixed on B. B's
    // storefront must resolve B's row and only B's.
    const response = await post(HOST_B, {
      items: [{ productId: "dc-b-one", quantity: 2 }],
      discountCode: "ALLTEN",
    });
    const checkout = ((await response.json()) as CheckoutBody).checkout;

    expect(response.status).toBe(201);
    expect(checkout.discountMinor).toBe(999);
    expect((await storedRow(checkout.checkoutId))?.discount_code_id).toBe(
      "dc-b-all-ten",
    );
  });

  it("silently discounts nothing for a code that exists only on another tenant", async () => {
    const response = await post(HOST_B, {
      items: [{ productId: "dc-b-one", quantity: 2 }],
      discountCode: "FIXED500",
    });
    const checkout = ((await response.json()) as CheckoutBody).checkout;

    expect(checkout.discountMinor).toBe(0);
    expect((await storedRow(checkout.checkoutId))?.discount_code_id).toBeNull();
  });
});

describe("discount replay fingerprint", () => {
  /**
   * These cases pin one idempotency key and one email deliberately, because
   * replay is what they are about. The per-email hourly limit is 30, and each
   * case here spends two.
   */
  async function attempt(
    idempotencyKey: string,
    email: string,
    discountCode: string,
  ): Promise<Response> {
    return exports.default.fetch(
      new Request(`https://${HOST_A}/v1/checkout`, {
        method: "POST",
        headers: {
          "cf-connecting-ip": nextIp(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deliveryMethod: "pickup",
          discountCode,
          email,
          idempotencyKey,
          items: [{ productId: "dc-a-one", quantity: 2 }],
        }),
      }),
    );
  }

  it("replays an identical request unchanged", async () => {
    const key = nextKey();
    const email = nextEmail();

    const first = await attempt(key, email, "ALLTEN");
    const second = await attempt(key, email, "ALLTEN");
    const firstBody = (await first.json()) as CheckoutBody;
    const secondBody = (await second.json()) as CheckoutBody;

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondBody.checkout.checkoutId).toBe(firstBody.checkout.checkoutId);
    expect(secondBody.checkout.discountMinor).toBe(200);
    expect(secondBody.checkout.discountCode).toBe("ALLTEN");
  });

  it("conflicts when the code was deactivated between attempts", async () => {
    await seedCode({
      code: "REPLAYOFF",
      discountCodeId: "dc-replay-off",
      percentBp: 1_000,
      tenantId: TENANT_A,
      type: "percent",
    });

    const key = nextKey();
    const email = nextEmail();
    expect((await attempt(key, email, "REPLAYOFF")).status).toBe(201);

    await env.DB.prepare(
      "UPDATE discount_codes SET active = 0 WHERE discount_code_id = 'dc-replay-off'",
    ).run();

    // The stored checkout is now worth a discount the merchant has withdrawn.
    // Replaying it would silently honour those terms; a new checkout under the
    // same key would break idempotency. A conflict is the only honest answer.
    expect((await attempt(key, email, "REPLAYOFF")).status).toBe(409);
  });

  it("conflicts when the code's value was edited between attempts", async () => {
    await seedCode({
      code: "REPLAYVALUE",
      discountCodeId: "dc-replay-value",
      percentBp: 1_000,
      tenantId: TENANT_A,
      type: "percent",
    });

    const key = nextKey();
    const email = nextEmail();
    expect((await attempt(key, email, "REPLAYVALUE")).status).toBe(201);

    await env.DB.prepare(
      "UPDATE discount_codes SET percent_bp = 2000 WHERE discount_code_id = 'dc-replay-value'",
    ).run();

    expect((await attempt(key, email, "REPLAYVALUE")).status).toBe(409);
  });

  it("conflicts when the code's window closed between attempts", async () => {
    await seedCode({
      code: "REPLAYWINDOW",
      discountCodeId: "dc-replay-window",
      percentBp: 1_000,
      tenantId: TENANT_A,
      type: "percent",
    });

    const key = nextKey();
    const email = nextEmail();
    expect((await attempt(key, email, "REPLAYWINDOW")).status).toBe(201);

    await env.DB.prepare(
      "UPDATE discount_codes SET ends_at = ? WHERE discount_code_id = 'dc-replay-window'",
    )
      .bind(Date.now() - 1_000)
      .run();

    expect((await attempt(key, email, "REPLAYWINDOW")).status).toBe(409);
  });

  it("conflicts when the code filled up between attempts", async () => {
    await seedCode({
      code: "REPLAYUSES",
      discountCodeId: "dc-replay-uses",
      maxUses: 1,
      percentBp: 1_000,
      tenantId: TENANT_A,
      type: "percent",
    });

    const key = nextKey();
    const email = nextEmail();
    expect((await attempt(key, email, "REPLAYUSES")).status).toBe(201);

    // Standing in for what the PAYMENT checkpoint will do on a paid order.
    await env.DB.prepare(
      "UPDATE discount_codes SET used_count = 1 WHERE discount_code_id = 'dc-replay-uses'",
    ).run();

    expect((await attempt(key, email, "REPLAYUSES")).status).toBe(409);
  });

  it("conflicts when a replay presents a DIFFERENT code worth the same money", async () => {
    // Two codes, both 500 minor off a 2 000 basket. Comparing only the amount
    // would call this a replay and hand back a checkout attributed to the wrong
    // campaign — which the payment checkpoint would then burn a use against.
    await seedCode({
      code: "TWINONE",
      discountCodeId: "dc-twin-one",
      tenantId: TENANT_A,
      type: "fixed",
      valueMinor: 500,
    });
    await seedCode({
      code: "TWINTWO",
      discountCodeId: "dc-twin-two",
      tenantId: TENANT_A,
      type: "fixed",
      valueMinor: 500,
    });

    const key = nextKey();
    const email = nextEmail();
    expect((await attempt(key, email, "TWINONE")).status).toBe(201);
    expect((await attempt(key, email, "TWINTWO")).status).toBe(409);
  });

  it("accepts a NEW key while the code is ineligible", async () => {
    // The conflict above is about a REUSED key, not about the code. A fresh key
    // quoting the same ineligible code is an ordinary zero-discount checkout.
    const response = await attempt(nextKey(), nextEmail(), "EXPIRED");
    const checkout = ((await response.json()) as CheckoutBody).checkout;

    expect(response.status).toBe(201);
    expect(checkout.discountMinor).toBe(0);
  });
});

describe("percentDiscountMinor exactness", () => {
  /**
   * The naive form `Math.ceil(base * bp / 10000)` is exact only while
   * `base * bp` stays inside the safe-integer range. Below that ceiling the two
   * must agree on every input; above it the naive form is the one that is
   * wrong, which is why this function does not use it.
   */
  it("agrees with the naive form everywhere the naive form is still exact", () => {
    for (let i = 0; i < 20_000; i += 1) {
      const base = Math.floor(Math.random() * 1e9);
      const bp = 1 + Math.floor(Math.random() * MAX_DISCOUNT_PERCENT_BP);
      expect(percentDiscountMinor(base, bp)).toBe(
        Math.ceil((base * bp) / 10_000),
      );
    }
  });

  it("stays exact at the subtotal ceiling, where the naive product overflows", () => {
    // 50 lines × 999 units × the 100 000 000 price ceiling is 4.995e12, the
    // largest subtotal the schema admits. Multiplied by 10 000 bp that is
    // 4.995e16 — past Number.MAX_SAFE_INTEGER, so the naive product is no
    // longer an integer at all.
    const maxSubtotal = 50 * 999 * 100_000_000;
    expect(Number.isSafeInteger(maxSubtotal * MAX_DISCOUNT_PERCENT_BP)).toBe(
      false,
    );

    // 100% of the ceiling is the ceiling, exactly.
    expect(percentDiscountMinor(maxSubtotal, MAX_DISCOUNT_PERCENT_BP)).toBe(
      maxSubtotal,
    );
    // 50% of it is exactly half, with no rounding at all.
    expect(percentDiscountMinor(maxSubtotal, 5_000)).toBe(maxSubtotal / 2);
  });

  it("keeps the ceiling honest one minor unit either side of an exact division", () => {
    // 10 000 bp/10 000 divides 40 000 exactly at 1 bp: 40 000 × 1 / 10 000 = 4.
    expect(percentDiscountMinor(40_000, 1)).toBe(4);
    // One unit more leaves a remainder, so the ceiling adds one.
    expect(percentDiscountMinor(40_001, 1)).toBe(5);
    // One unit less likewise.
    expect(percentDiscountMinor(39_999, 1)).toBe(4);
  });

  it("returns zero for a zero base rather than rounding up to one", () => {
    expect(percentDiscountMinor(0, MAX_DISCOUNT_PERCENT_BP)).toBe(0);
    expect(percentDiscountMinor(0, 1)).toBe(0);
  });

  it("refuses a base outside the exact-arithmetic range", () => {
    expect(() => percentDiscountMinor(Number.MAX_SAFE_INTEGER + 2, 1)).toThrow(
      RangeError,
    );
    expect(() => percentDiscountMinor(-1, 1)).toThrow(RangeError);
    expect(() => percentDiscountMinor(1_000, 10_001)).toThrow(RangeError);
  });
});

describe("discount_codes schema", () => {
  async function insertCode(columns: Record<string, unknown>): Promise<unknown> {
    const merged = {
      active: 1,
      code: "SCHEMA",
      created_at: NOW,
      discount_code_id: crypto.randomUUID(),
      ends_at: null,
      max_uses: null,
      min_spend_minor: null,
      percent_bp: null,
      product_ids_json: null,
      scope: "all",
      starts_at: null,
      tenant_id: TENANT_A,
      type: "fixed",
      updated_at: NOW,
      used_count: 0,
      value_minor: 500,
      ...columns,
    };

    return env.DB.prepare(
      `INSERT INTO discount_codes (
        discount_code_id, tenant_id, code, active, type, value_minor,
        percent_bp, starts_at, ends_at, max_uses, used_count, min_spend_minor,
        scope, product_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        merged.discount_code_id,
        merged.tenant_id,
        merged.code,
        merged.active,
        merged.type,
        merged.value_minor,
        merged.percent_bp,
        merged.starts_at,
        merged.ends_at,
        merged.max_uses,
        merged.used_count,
        merged.min_spend_minor,
        merged.scope,
        merged.product_ids_json,
        merged.created_at,
        merged.updated_at,
      )
      .run();
  }

  it.each([
    [
      "a fixed code carrying a percentage",
      { code: "X1", percent_bp: 1_000, type: "fixed", value_minor: 500 },
    ],
    [
      "a fixed code carrying no value",
      { code: "X2", type: "fixed", value_minor: null },
    ],
    [
      "a percent code carrying a fixed value",
      { code: "X3", percent_bp: 1_000, type: "percent", value_minor: 500 },
    ],
    [
      "a percent code carrying no percentage",
      { code: "X4", percent_bp: null, type: "percent", value_minor: null },
    ],
  ])("rejects %s", async (_label, columns) => {
    await expect(insertCode(columns)).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects a window that ends before it starts", async () => {
    await expect(
      insertCode({ code: "X5", ends_at: NOW, starts_at: NOW + 1 }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("accepts a window that starts and ends on the same instant", async () => {
    await expect(
      insertCode({ code: "X6", ends_at: NOW, starts_at: NOW }),
    ).resolves.toBeDefined();
  });

  it("rejects a products-scoped code carrying no product list", async () => {
    await expect(
      insertCode({ code: "X7", product_ids_json: null, scope: "products" }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects an all-scoped code carrying a product list", async () => {
    await expect(
      insertCode({ code: "X8", product_ids_json: '["p"]', scope: "all" }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects a product list that is not a JSON array", async () => {
    await expect(
      insertCode({ code: "X9", product_ids_json: "{not json", scope: "products" }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertCode({ code: "X10", product_ids_json: '{"a":1}', scope: "products" }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects a lowercase stored code", async () => {
    // The checkout uppercases before looking up, so a lowercase row would be
    // unreachable by any buyer — a code the merchant believes is live and that
    // nobody can spend.
    await expect(insertCode({ code: "lower" })).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it.each([
    ["a negative usage count", { code: "X11", used_count: -1 }],
    ["a usage cap of zero", { code: "X12", max_uses: 0 }],
    ["a negative minimum spend", { code: "X13", min_spend_minor: -1 }],
    ["a percentage above one hundred", {
      code: "X14",
      percent_bp: 10_001,
      type: "percent",
      value_minor: null,
    }],
    ["a percentage of zero", {
      code: "X15",
      percent_bp: 0,
      type: "percent",
      value_minor: null,
    }],
    ["an unknown type", { code: "X16", type: "bogus" }],
    ["an unknown scope", { code: "X17", scope: "bogus" }],
  ])("rejects %s", async (_label, columns) => {
    await expect(insertCode(columns)).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects a duplicate code within one tenant", async () => {
    await insertCode({ code: "DUPE" });
    await expect(insertCode({ code: "DUPE" })).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("allows the same code string on two different tenants", async () => {
    await insertCode({ code: "SHARED", tenant_id: TENANT_A });
    await expect(
      insertCode({ code: "SHARED", tenant_id: TENANT_B }),
    ).resolves.toBeDefined();
  });

  it("refuses to re-home a code to another tenant", async () => {
    await insertCode({ code: "IMMUTABLE", discount_code_id: "dc-immutable" });

    await expect(
      env.DB.prepare(
        "UPDATE discount_codes SET tenant_id = ? WHERE discount_code_id = 'dc-immutable'",
      )
        .bind(TENANT_B)
        .run(),
    ).rejects.toThrow(/tenant_id is immutable/);
  });

  it("carries the discount_code_id column on checkouts", async () => {
    const columns = await env.DB.prepare(
      "PRAGMA table_info(checkouts)",
    ).all<{ name: string }>();

    expect(columns.results.map((row) => row.name)).toContain(
      "discount_code_id",
    );
  });

  it("refuses a stored discount that no code authorized", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO checkouts (
          checkout_id, tenant_id, status, customer_email, currency,
          delivery_method, shipping_country, subtotal_minor, shipping_minor,
          vat_minor, vat_rate_bp, discount_minor, discount_code_id,
          total_minor, idempotency_key_hash, expires_at, created_at, updated_at
        ) VALUES ('dc-orphan', ?, 'open', 'x@example.test', 'SEK', 'pickup',
          NULL, 1000, 0, 0, 2500, 100, NULL, 900, 'hash-dc-orphan', ?, ?, ?)`,
      )
        .bind(TENANT_A, NOW + DAY_MS, NOW, NOW)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("refuses a stored discount larger than the subtotal it discounts", async () => {
    // 0009's totals CHECK alone would ALLOW this: total = 1000 + 500 - 1200 =
    // 300 is non-negative and internally consistent, so without the tighter
    // bound a code could eat 200 minor units of carriage.
    await expect(
      env.DB.prepare(
        `INSERT INTO checkouts (
          checkout_id, tenant_id, status, customer_email, currency,
          delivery_method, shipping_country, subtotal_minor, shipping_minor,
          vat_minor, vat_rate_bp, discount_minor, discount_code_id,
          total_minor, idempotency_key_hash, expires_at, created_at, updated_at
        ) VALUES ('dc-over-subtotal', ?, 'open', 'x@example.test', 'SEK',
          'shipping', 'SE', 1000, 500, 0, 2500, 1200, 'some-code', 300,
          'hash-dc-over', ?, ?, ?)`,
      )
        .bind(TENANT_A, NOW + DAY_MS, NOW, NOW)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
