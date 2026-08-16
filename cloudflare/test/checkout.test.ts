import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MAX_SHIPPING_MINOR,
  MAX_VAT_SAFE_TOTAL_MINOR,
  shippingMinor as shippingMinorFor,
  vatMinor,
} from "../src/commerce/shipping";

const NOW = 1_787_200_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

const TENANT_A = "tenant-ck-a";
const TENANT_B = "tenant-ck-b";
const HOST_A = "a.checkout.test";
const HOST_B = "b.checkout.test";

interface SeedProductOptions {
  allowPickup?: boolean;
  allowShipping?: boolean;
  productId: string;
  publicPriceMinor: number;
  published: boolean;
  shippingRates?: Record<string, { cost: number }> | null;
  sku: string;
  status: "draft" | "active" | "archived";
  tenantId: string;
  weightGrams?: number;
}

interface CheckoutBody {
  checkout: {
    checkoutId: string;
    currency: string;
    deliveryMethod: string;
    discountMinor: number;
    expiresAt: number;
    items: {
      itemIndex: number;
      lineTotalMinor: number;
      name: string;
      productId: string;
      quantity: number;
      sku: string;
      unitPriceMinor: number;
      variantId: string | null;
    }[];
    shippingCountry: string | null;
    shippingMinor: number;
    subtotalMinor: number;
    totalMinor: number;
    vatMinor: number;
    vatRateBp: number;
  };
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

async function seedProduct(options: SeedProductOptions): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO products (
      product_id, tenant_id, status, sku, name, description,
      b2c_price_minor, currency, is_pod, internal_json, weight_grams,
      allow_shipping, allow_pickup, shipping_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'SEK', 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      options.productId,
      options.tenantId,
      options.status,
      options.sku,
      `Internal must-not-leak ${options.productId}`,
      777_777,
      JSON.stringify({ supplierCost: "must-not-leak" }),
      options.weightGrams ?? 0,
      (options.allowShipping ?? true) ? 1 : 0,
      (options.allowPickup ?? false) ? 1 : 0,
      options.shippingRates == null
        ? null
        : JSON.stringify(options.shippingRates),
      NOW,
      NOW,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO product_publications (
      product_id, tenant_id, published, public_name, public_description,
      public_price_minor, currency, projection_version, published_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?, 'SEK', 1, ?, ?)`,
  )
    .bind(
      options.productId,
      options.tenantId,
      options.published ? 1 : 0,
      `Public ${options.productId}`,
      options.publicPriceMinor,
      options.published ? NOW : null,
      NOW,
    )
    .run();
}

async function seedVariant(
  tenantId: string,
  productId: string,
  variantId: string,
  sku: string,
  priceMinor: number,
  active: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO product_variants (
      variant_id, tenant_id, product_id, sku, label, price_minor,
      active, attributes_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      variantId,
      tenantId,
      productId,
      sku,
      `Label ${variantId}`,
      priceMinor,
      active ? 1 : 0,
      NOW,
      NOW,
    )
    .run();
}

let ipCounter = 0;

/**
 * A distinct client address per request unless the caller pins one. The route
 * is rate limited per IP, and these suites fire far more than one window's
 * allowance between them; without this every test after the tenth would be
 * throttled by its predecessors rather than exercising what it names. The
 * limiter itself is proven in rate-limit.test.ts and in the suite below, which
 * pin the address deliberately.
 */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 256}:${ipCounter}`;
}

function checkoutRequest(
  hostname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://${hostname}/v1/checkout`, {
    method: "POST",
    headers: {
      "cf-connecting-ip": nextIp(),
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Posts a body EXACTLY as given. Parser tests use this so an assertion about a
 * missing or malformed field is about the field the test names, not about
 * whatever a helper filled in on its behalf.
 */
async function postRaw(
  hostname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return exports.default.fetch(checkoutRequest(hostname, body, headers));
}

/**
 * Posts a body with the delivery fields filled in when the test did not supply
 * them. Both are required by the contract, and most suites here are about
 * pricing, tenancy or idempotency rather than delivery; making every one of
 * them restate 'shipping'/'SE' would bury what they are actually asserting.
 */
async function post(
  hostname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const filled =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? {
          deliveryMethod: "shipping",
          shippingCountry: "SE",
          ...(body as Record<string, unknown>),
        }
      : body;

  return postRaw(hostname, filled, headers);
}

async function countCheckouts(tenantId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM checkouts WHERE tenant_id = ?",
  )
    .bind(tenantId)
    .first<{ total: number }>();

  return row?.total ?? 0;
}

let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return `idem-key-${keyCounter.toString().padStart(4, "0")}`;
}

beforeAll(async () => {
  await seedTenant(TENANT_A, HOST_A);
  await seedTenant(TENANT_B, HOST_B);

  await seedProduct({
    productId: "ck-a-live",
    publicPriceMinor: 19_900,
    published: true,
    sku: "CK-A-LIVE",
    status: "active",
    tenantId: TENANT_A,
  });
  await seedProduct({
    productId: "ck-a-second",
    publicPriceMinor: 4_950,
    published: true,
    sku: "CK-A-SECOND",
    status: "active",
    tenantId: TENANT_A,
  });
  await seedProduct({
    productId: "ck-a-draft",
    publicPriceMinor: 100,
    published: true,
    sku: "CK-A-DRAFT",
    status: "draft",
    tenantId: TENANT_A,
  });
  await seedProduct({
    productId: "ck-a-archived",
    publicPriceMinor: 100,
    published: true,
    sku: "CK-A-ARCHIVED",
    status: "archived",
    tenantId: TENANT_A,
  });
  await seedProduct({
    productId: "ck-a-unpublished",
    publicPriceMinor: 100,
    published: false,
    sku: "CK-A-UNPUB",
    status: "active",
    tenantId: TENANT_A,
  });
  await seedProduct({
    productId: "ck-b-live",
    publicPriceMinor: 55_000,
    published: true,
    sku: "CK-B-LIVE",
    status: "active",
    tenantId: TENANT_B,
  });

  // Delivery fixtures. The suites above are about pricing/tenancy/idempotency
  // and deliberately use weightless, shipping-only products so their totals are
  // unaffected by carriage; these exist for the delivery and shipping-math
  // suites, which name their own products.
  await seedProduct({
    allowPickup: true,
    productId: "ck-a-pickup",
    publicPriceMinor: 10_000,
    published: true,
    sku: "CK-A-PICKUP",
    status: "active",
    tenantId: TENANT_A,
    weightGrams: 500,
  });
  await seedProduct({
    allowPickup: true,
    allowShipping: false,
    productId: "ck-a-pickup-only",
    publicPriceMinor: 10_000,
    published: true,
    sku: "CK-A-PICKUP-ONLY",
    status: "active",
    tenantId: TENANT_A,
  });
  await seedProduct({
    allowPickup: false,
    productId: "ck-a-ship-only",
    publicPriceMinor: 10_000,
    published: true,
    sku: "CK-A-SHIP-ONLY",
    status: "active",
    tenantId: TENANT_A,
  });
  await seedProduct({
    productId: "ck-a-w1",
    publicPriceMinor: 10_000,
    published: true,
    sku: "CK-A-W1",
    status: "active",
    tenantId: TENANT_A,
    weightGrams: 1,
  });
  await seedProduct({
    productId: "ck-a-w50",
    publicPriceMinor: 10_000,
    published: true,
    sku: "CK-A-W50",
    status: "active",
    tenantId: TENANT_A,
    weightGrams: 50,
  });
  await seedProduct({
    productId: "ck-a-w51",
    publicPriceMinor: 10_000,
    published: true,
    sku: "CK-A-W51",
    status: "active",
    tenantId: TENANT_A,
    weightGrams: 51,
  });
  await seedProduct({
    productId: "ck-a-rates",
    publicPriceMinor: 10_000,
    published: true,
    shippingRates: {
      eu: { cost: 7_700 },
      nordic: { cost: 5_500 },
      sweden: { cost: 1_500 },
      worldwide: { cost: 11_100 },
    },
    sku: "CK-A-RATES",
    status: "active",
    tenantId: TENANT_A,
    weightGrams: 50,
  });
  await seedProduct({
    productId: "ck-a-rates-zero",
    publicPriceMinor: 10_000,
    published: true,
    // A configured cost of zero is treated as absent, exactly as production
    // does: `|| 0` there, `> 0` here. It falls back to the default tariff.
    shippingRates: { sweden: { cost: 0 } },
    sku: "CK-A-RATES-ZERO",
    status: "active",
    tenantId: TENANT_A,
    weightGrams: 50,
  });
  await seedProduct({
    productId: "ck-a-rates-broken",
    publicPriceMinor: 10_000,
    published: true,
    sku: "CK-A-RATES-BROKEN",
    status: "active",
    tenantId: TENANT_A,
    weightGrams: 50,
  });
  // Written directly: a blob the admin parser would have refused, standing in
  // for a row corrupted by some future repair script.
  await env.DB.prepare(
    "UPDATE products SET shipping_json = ? WHERE product_id = ?",
  )
    .bind("{not json", "ck-a-rates-broken")
    .run();

  await seedVariant(TENANT_A, "ck-a-live", "ck-a-live-m", "CK-A-LIVE-M", 21_500, true);
  await seedVariant(TENANT_A, "ck-a-live", "ck-a-live-x", "CK-A-LIVE-X", 9_900, false);
  await seedVariant(
    TENANT_A,
    "ck-a-second",
    "ck-a-second-s",
    "CK-A-SECOND-S",
    6_100,
    true,
  );
  await seedVariant(TENANT_B, "ck-b-live", "ck-b-live-m", "CK-B-LIVE-M", 51_000, true);
});

describe("POST /v1/checkout", () => {
  it("prices the basket from the tenant's own publications and ignores hostile headers", async () => {
    const idempotencyKey = nextKey();
    const before = Date.now();
    const response = await post(
      HOST_A,
      {
        email: "Buyer@Example.TEST",
        idempotencyKey,
        items: [
          { productId: "ck-a-live", quantity: 2 },
          { productId: "ck-a-second", quantity: 3 },
        ],
      },
      { "x-forwarded-host": HOST_B, "x-shop-id": TENANT_B },
    );
    const body = (await response.json()) as CheckoutBody;

    expect(response.status).toBe(201);
    expect(body.checkout.currency).toBe("SEK");
    expect(body.checkout.items).toEqual([
      {
        itemIndex: 0,
        lineTotalMinor: 39_800,
        name: "Public ck-a-live",
        productId: "ck-a-live",
        quantity: 2,
        sku: "CK-A-LIVE",
        unitPriceMinor: 19_900,
        variantId: null,
      },
      {
        itemIndex: 1,
        lineTotalMinor: 14_850,
        name: "Public ck-a-second",
        productId: "ck-a-second",
        quantity: 3,
        sku: "CK-A-SECOND",
        unitPriceMinor: 4_950,
        variantId: null,
      },
    ]);
    expect(body.checkout.subtotalMinor).toBe(54_650);
    // Carriage mirrors production exactly: five units of an unconfigured
    // weight count as 10 g each, plus the 20 g packaging allowance, giving
    // 70 g — two started 50 g tiers of the 2 900 fallback tariff.
    expect(body.checkout.shippingMinor).toBe(5_800);
    expect(body.checkout.totalMinor).toBe(60_450);
    expect(body.checkout.vatMinor).toBe(12_090);
    expect(body.checkout.vatRateBp).toBe(2_500);
    expect(body.checkout.deliveryMethod).toBe("shipping");
    expect(body.checkout.shippingCountry).toBe("SE");
    expect(body.checkout.discountMinor).toBe(0);
    expect(body.checkout.expiresAt).toBeGreaterThanOrEqual(before + DAY_MS);
    // Currency is a checkout-level value; it must not be repeated per line. The
    // per-product weight and delivery flags the engine priced from are merchant
    // configuration and appear nowhere in a buyer-facing response.
    expect(Object.keys(body.checkout).sort()).toEqual([
      "checkoutId",
      "currency",
      "deliveryMethod",
      "discountMinor",
      "expiresAt",
      "items",
      "shippingCountry",
      "shippingMinor",
      "subtotalMinor",
      "totalMinor",
      "vatMinor",
      "vatRateBp",
    ]);
    expect(Object.keys(body.checkout.items[0] as object).sort()).toEqual([
      "itemIndex",
      "lineTotalMinor",
      "name",
      "productId",
      "quantity",
      "sku",
      "unitPriceMinor",
      "variantId",
    ]);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("777777");
    expect(serialized).not.toContain(TENANT_B);

    const stored = await env.DB.prepare(
      `SELECT tenant_id, status, customer_email, currency, delivery_method,
              shipping_country, subtotal_minor, shipping_minor, vat_minor,
              vat_rate_bp, discount_minor, total_minor,
              payment_intent_id, expires_at
       FROM checkouts
       WHERE checkout_id = ?`,
    )
      .bind(body.checkout.checkoutId)
      .first<Record<string, unknown>>();

    expect(stored).toMatchObject({
      currency: "SEK",
      // The address is lowercased before it is stored so a later sign-in or
      // recovery lookup matches what the buyer typed in any casing.
      customer_email: "buyer@example.test",
      delivery_method: "shipping",
      discount_minor: 0,
      payment_intent_id: null,
      shipping_country: "SE",
      shipping_minor: 5_800,
      status: "open",
      subtotal_minor: 54_650,
      tenant_id: TENANT_A,
      total_minor: 60_450,
      // Derived and frozen at quote time, so an auditor can reproduce the VAT
      // even after the tenant changes its rate.
      vat_minor: 12_090,
      vat_rate_bp: 2_500,
    });

    const items = await env.DB.prepare(
      `SELECT item_index, product_id, variant_id, sku, name, quantity,
              unit_price_minor, line_total_minor, tenant_id
       FROM checkout_items
       WHERE checkout_id = ?
       ORDER BY item_index ASC`,
    )
      .bind(body.checkout.checkoutId)
      .all<Record<string, unknown>>();

    expect(items.results).toHaveLength(2);
    expect(items.results[0]).toMatchObject({
      line_total_minor: 39_800,
      product_id: "ck-a-live",
      sku: "CK-A-LIVE",
      tenant_id: TENANT_A,
      unit_price_minor: 19_900,
      variant_id: null,
    });
  });

  it("uses the variant price and sku when a variant is named", async () => {
    const response = await post(HOST_A, {
      email: "variant@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1, variantId: "ck-a-live-m" }],
    });
    const body = (await response.json()) as CheckoutBody;

    expect(response.status).toBe(201);
    expect(body.checkout.items).toEqual([
      {
        itemIndex: 0,
        lineTotalMinor: 21_500,
        // The display name still comes from the publication; only price and
        // sku are variant-specific.
        name: "Public ck-a-live",
        productId: "ck-a-live",
        quantity: 1,
        sku: "CK-A-LIVE-M",
        unitPriceMinor: 21_500,
        variantId: "ck-a-live-m",
      },
    ]);
    // 21 500 for the line plus one tier of the 2 900 fallback: a single unit of
    // unconfigured weight is 10 g, and 10 + 20 g of packaging is 30 g.
    expect(body.checkout.totalMinor).toBe(24_400);
  });

  it("writes one audit event per checkout and never records the buyer's address", async () => {
    const email = "audit-probe@example.test";
    const response = await post(HOST_A, {
      email,
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1 }],
    });
    const body = (await response.json()) as CheckoutBody;

    expect(response.status).toBe(201);

    const events = await env.DB.prepare(
      `SELECT action, tenant_id, actor_user_id, resource_type, metadata_json
       FROM audit_events
       WHERE resource_id = ?`,
    )
      .bind(body.checkout.checkoutId)
      .all<Record<string, unknown>>();

    expect(events.results).toEqual([
      {
        action: "checkout.create",
        actor_user_id: null,
        metadata_json: JSON.stringify({ items: 1 }),
        resource_type: "checkout",
        tenant_id: TENANT_A,
      },
    ]);

    const leaked = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM audit_events WHERE metadata_json LIKE ?",
    )
      .bind(`%${email}%`)
      .first<{ total: number }>();

    expect(leaked?.total).toBe(0);
  });
});

describe("POST /v1/checkout delivery method", () => {
  it("quotes a collected basket with no carriage and no destination", async () => {
    const response = await postRaw(HOST_A, {
      deliveryMethod: "pickup",
      email: "pickup@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-pickup", quantity: 1 }],
    });
    const body = (await response.json()) as CheckoutBody;

    expect(response.status).toBe(201);
    expect(body.checkout.deliveryMethod).toBe("pickup");
    expect(body.checkout.shippingCountry).toBeNull();
    // 500 g would be ten carriage tiers if this basket were shipped. It is not.
    expect(body.checkout.shippingMinor).toBe(0);
    expect(body.checkout.totalMinor).toBe(10_000);
    expect(body.checkout.vatMinor).toBe(2_000);
  });

  it("refuses to collect a basket the merchant never offered for collection", async () => {
    // P1-06 mirrored: pickup zeroes carriage, so eligibility is the SERVER's
    // decision. A client asking to collect a shipping-only product is asking to
    // skip the carriage the merchant charges for it.
    const before = await countCheckouts(TENANT_A);
    const response = await postRaw(HOST_A, {
      deliveryMethod: "pickup",
      email: "pickup-denied@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-ship-only", quantity: 1 }],
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "unprocessable", message: "Request could not be processed" },
    });
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it("refuses to collect a basket where only one line forbids it", async () => {
    // One ineligible line makes the basket ineligible: a basket is handed over
    // as one shipment, so 'every' is the only defensible quantifier.
    const before = await countCheckouts(TENANT_A);
    const response = await postRaw(HOST_A, {
      deliveryMethod: "pickup",
      email: "pickup-mixed@example.test",
      idempotencyKey: nextKey(),
      items: [
        { productId: "ck-a-pickup", quantity: 1 },
        { productId: "ck-a-ship-only", quantity: 1 },
      ],
    });

    expect(response.status).toBe(422);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it("refuses to ship a basket the merchant marked collect-only", async () => {
    const before = await countCheckouts(TENANT_A);
    const response = await postRaw(HOST_A, {
      deliveryMethod: "shipping",
      email: "ship-denied@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-pickup-only", quantity: 1 }],
      shippingCountry: "SE",
    });

    expect(response.status).toBe(422);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it("refuses to ship a basket where only one line forbids it", async () => {
    const before = await countCheckouts(TENANT_A);
    const response = await postRaw(HOST_A, {
      deliveryMethod: "shipping",
      email: "ship-mixed@example.test",
      idempotencyKey: nextKey(),
      items: [
        { productId: "ck-a-live", quantity: 1 },
        { productId: "ck-a-pickup-only", quantity: 1 },
      ],
      shippingCountry: "SE",
    });

    expect(response.status).toBe(422);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });
});

describe("POST /v1/checkout shipping engine", () => {
  let quoteCounter = 0;

  async function quote(
    items: { productId: string; quantity: number }[],
    shippingCountry: string,
  ): Promise<CheckoutBody["checkout"]> {
    // A fresh buyer address per quote. The route carries a 30-per-hour limit
    // keyed on the address, and this suite makes more quotes than that; sharing
    // one address would throttle the later cases into 429s that look like
    // pricing failures. The limiter itself is proven in its own suite.
    quoteCounter += 1;
    const response = await postRaw(HOST_A, {
      deliveryMethod: "shipping",
      email: `ship-math-${quoteCounter}@example.test`,
      idempotencyKey: nextKey(),
      items,
      shippingCountry,
    });
    const body = (await response.json()) as CheckoutBody;

    expect(response.status).toBe(201);
    return body.checkout;
  }

  it.each([
    ["Sweden", "SE", 3_000],
    ["a Nordic neighbour", "NO", 11_000],
    ["Denmark, which is Nordic before it is EU", "DK", 11_000],
    ["Finland, likewise", "FI", 11_000],
    ["an EU member", "DE", 15_400],
    ["Spain", "ES", 15_400],
    ["a country outside all three", "US", 22_200],
    ["an unassigned code, which is worldwide", "ZZ", 22_200],
  ])(
    "prices %s from the product's own carriage table",
    async (_label, country, expected) => {
      // 50 g of product plus 20 g of packaging is 70 g: two tiers, so the quote
      // is twice the region's base rate.
      const checkout = await quote(
        [{ productId: "ck-a-rates", quantity: 1 }],
        country,
      );

      expect(checkout.shippingMinor).toBe(expected);
    },
  );

  it.each([
    ["Sweden", "SE", 5_800],
    ["a Nordic neighbour", "NO", 9_800],
    ["an EU member", "DE", 9_800],
    ["the rest of the world", "US", 9_800],
  ])(
    "falls back to the default tariff for %s when no table is configured",
    async (_label, country, expected) => {
      const checkout = await quote(
        [{ productId: "ck-a-w50", quantity: 1 }],
        country,
      );

      expect(checkout.shippingMinor).toBe(expected);
    },
  );

  it("treats a configured zero as no rate at all and falls back", async () => {
    const checkout = await quote(
      [{ productId: "ck-a-rates-zero", quantity: 1 }],
      "SE",
    );

    expect(checkout.shippingMinor).toBe(5_800);
  });

  it("treats a malformed carriage table as absent rather than trusting it", async () => {
    // A corrupt row degrades to the default tariff. It must never price
    // carriage from a blob nothing validated, and must never fail the request:
    // the buyer did nothing wrong.
    const checkout = await quote(
      [{ productId: "ck-a-rates-broken", quantity: 1 }],
      "SE",
    );

    expect(checkout.shippingMinor).toBe(5_800);
  });

  it.each([
    ["1 g plus packaging, which is one tier", "ck-a-w1", 1, 2_900],
    ["50 g plus packaging, which starts a second tier", "ck-a-w50", 1, 5_800],
    ["51 g plus packaging, still two tiers", "ck-a-w51", 1, 5_800],
    ["100 g plus packaging, three tiers", "ck-a-w50", 2, 8_700],
    ["150 g plus packaging, four tiers", "ck-a-w50", 3, 11_600],
    ["102 g plus packaging, three tiers", "ck-a-w51", 2, 8_700],
  ])("charges one tariff per started 50 g: %s", async (
    _label,
    productId,
    quantity,
    expected,
  ) => {
    const checkout = await quote([{ productId, quantity }], "SE");

    expect(checkout.shippingMinor).toBe(expected);
  });

  it("never ships a basket free, even with no weight configured", async () => {
    // Production parity, and the reason it matters: `weight_grams` defaults to
    // 0, and production's `|| 10` treats that as 10 g per unit. With the 20 g
    // packaging allowance the floor is 30 g, which is always one started tier.
    // An earlier version of this engine quoted 0 here, which was a systematic
    // carriage undersell on every unconfigured product.
    const checkout = await quote(
      [{ productId: "ck-a-live", quantity: 3 }],
      "SE",
    );

    // 3 × 10 g + 20 g = 50 g: exactly one tier.
    expect(checkout.shippingMinor).toBe(2_900);
    expect(checkout.totalMinor).toBe(checkout.subtotalMinor + 2_900);
  });

  it("aggregates weight across every line, not only the first", async () => {
    // 50 + 51 g over two lines, plus 20 g packaging, is 121 g: three started
    // tiers. If only the first line counted this would be two tiers, and if
    // only the last, two as well.
    const checkout = await quote(
      [
        { productId: "ck-a-w50", quantity: 1 },
        { productId: "ck-a-w51", quantity: 1 },
      ],
      "SE",
    );

    expect(checkout.shippingMinor).toBe(8_700);
  });

  it("takes the base tariff from the first line's product only", async () => {
    // Mirrors production's cart: a mixed basket is charged the first product's
    // tariff for the whole parcel. Same two products, opposite order, different
    // base rate — that asymmetry is the behaviour being pinned.
    const rateFirst = await quote(
      [
        { productId: "ck-a-rates", quantity: 1 },
        { productId: "ck-a-w50", quantity: 1 },
      ],
      "SE",
    );
    const rateSecond = await quote(
      [
        { productId: "ck-a-w50", quantity: 1 },
        { productId: "ck-a-rates", quantity: 1 },
      ],
      "SE",
    );

    // 100 g of product plus 20 g packaging either way: three tiers. Only the
    // base rate differs — 1 500 configured versus the 2 900 fallback.
    expect(rateFirst.shippingMinor).toBe(4_500);
    expect(rateSecond.shippingMinor).toBe(8_700);
  });

  it("adds carriage to the total and to the VAT contained in it", async () => {
    const checkout = await quote(
      [{ productId: "ck-a-rates", quantity: 1 }],
      "SE",
    );

    expect(checkout.subtotalMinor).toBe(10_000);
    expect(checkout.shippingMinor).toBe(3_000);
    expect(checkout.totalMinor).toBe(13_000);
    // 13 000 inc-VAT at 25%: net 10 400, VAT 2 600.
    expect(checkout.vatMinor).toBe(2_600);
  });

  it.each([
    // Each expectation is prod's formula evaluated by hand:
    //   cost = base × ceil((Σ (w || 10) × q + 20) / 50)
    // against functions/src/payment/createPaymentIntent.ts:306-312.
    ["a single unconfigured unit: 10 + 20 = 30 g", "ck-a-live", 1, 2_900],
    ["two unconfigured units: 20 + 20 = 40 g", "ck-a-live", 2, 2_900],
    ["three unconfigured units: 30 + 20 = 50 g", "ck-a-live", 3, 2_900],
    ["four unconfigured units: 40 + 20 = 60 g", "ck-a-live", 4, 5_800],
    ["one 1 g unit: 1 + 20 = 21 g", "ck-a-w1", 1, 2_900],
    ["thirty 1 g units: 30 + 20 = 50 g", "ck-a-w1", 30, 2_900],
    ["thirty-one 1 g units: 31 + 20 = 51 g", "ck-a-w1", 31, 5_800],
  ])("matches production's tier arithmetic for %s", async (
    _label,
    productId,
    quantity,
    expected,
  ) => {
    const checkout = await quote([{ productId, quantity }], "SE");

    expect(checkout.shippingMinor).toBe(expected);
  });

  it("treats a configured zero weight as the 10 g substitute, like production", async () => {
    // Production's `product.weight?.value || 10` is a FALSY test, so an
    // explicit 0 and a missing weight are indistinguishable there. The schema
    // defaults weight_grams to 0, so this is the common case, not an edge one:
    // four such units are 40 + 20 = 60 g, two tiers — NOT the one tier a
    // literal reading of "0 g" would give, and not the zero an earlier version
    // of this engine quoted.
    const oneUnit = await quote([{ productId: "ck-a-live", quantity: 1 }], "SE");
    const fourUnits = await quote(
      [{ productId: "ck-a-live", quantity: 4 }],
      "SE",
    );

    expect(oneUnit.shippingMinor).toBe(2_900);
    expect(fourUnits.shippingMinor).toBe(5_800);
  });

  it("adds the packaging allowance once per basket, not once per line", async () => {
    // Three lines of one unconfigured unit each: 30 g of product plus ONE 20 g
    // allowance is 50 g, a single tier. Were the allowance added per line the
    // basket would weigh 90 g and cost two tiers.
    const checkout = await quote(
      [
        { productId: "ck-a-live", quantity: 1 },
        { productId: "ck-a-second", quantity: 1 },
        { productId: "ck-a-ship-only", quantity: 1 },
      ],
      "SE",
    );

    expect(checkout.shippingMinor).toBe(2_900);
  });

  it("normalizes a lowercase country before pricing it", async () => {
    // 'se' must price as Sweden, not fall through to 'worldwide'. The schema
    // stores uppercase, so a value that skipped normalization would also be
    // unstorable — this proves the parser, not the database, catches it.
    const checkout = await quote(
      [{ productId: "ck-a-rates", quantity: 1 }],
      "se",
    );

    expect(checkout.shippingCountry).toBe("SE");
    expect(checkout.shippingMinor).toBe(3_000);
  });
});

describe("POST /v1/checkout VAT derivation", () => {
  // The VAT cases below are about the derivation, not about carriage, so each
  // basket is quoted for COLLECTION. That zeroes shipping by contract, making
  // the total exactly the subtotal and letting each expectation name the total
  // it is deriving VAT from. Shipped baskets always carry at least one tier now
  // (10 g substitute + 20 g packaging), which would otherwise add an
  // unrelated 2 900 to every case here.
  async function vatFor(
    tenantId: string,
    hostname: string,
    vatRateBp: number,
    priceMinor: number,
  ): Promise<CheckoutBody["checkout"]> {
    await env.DB.prepare("UPDATE tenants SET vat_rate_bp = ? WHERE tenant_id = ?")
      .bind(vatRateBp, tenantId)
      .run();

    const productId = `ck-vat-${tenantId}-${vatRateBp}-${priceMinor}`;
    await seedProduct({
      allowPickup: true,
      productId,
      publicPriceMinor: priceMinor,
      published: true,
      sku: productId.toUpperCase(),
      status: "active",
      tenantId,
    });

    const response = await postRaw(hostname, {
      deliveryMethod: "pickup",
      // A fresh address per case: the route limits to 30 per hour per address
      // and this suite makes more quotes than that.
      email: `vat-${vatRateBp}-${priceMinor}@example.test`,
      idempotencyKey: nextKey(),
      items: [{ productId, quantity: 1 }],
    });
    const body = (await response.json()) as CheckoutBody;

    expect(response.status).toBe(201);
    return body.checkout;
  }

  // Every expectation below is the round-half-up of total × 10000 / (10000+bp)
  // subtracted from the total, computed by hand — not by re-running the
  // implementation's own formula, which would assert nothing.
  it.each([
    ["the worked example from the contract", 2_500, 10_000, 2_000],
    ["a price with no exact net", 2_500, 12_345, 2_469],
    ["one minor unit", 2_500, 1, 0],
    ["four minor units, which rounds the net down", 2_500, 4, 1],
    ["five minor units, the half-up boundary", 2_500, 5, 1],
    ["nine minor units", 2_500, 9, 2],
    ["a large total", 2_500, 999_999, 200_000],
    ["the reduced Swedish food rate", 1_200, 11_200, 1_200],
    ["the reduced Swedish culture rate", 600, 10_600, 600],
    ["a zero-rated tenant", 0, 10_000, 0],
    ["a zero-rated tenant on an odd total", 0, 7, 0],
    ["a hypothetical 100 percent rate", 10_000, 10_000, 5_000],
  ])("derives VAT for %s", async (_label, vatRateBp, priceMinor, expected) => {
    const checkout = await vatFor(TENANT_B, HOST_B, vatRateBp, priceMinor);

    expect(checkout.vatRateBp).toBe(vatRateBp);
    // Collected, so no carriage: the total IS the price under test.
    expect(checkout.shippingMinor).toBe(0);
    expect(checkout.totalMinor).toBe(priceMinor);
    expect(checkout.vatMinor).toBe(expected);
    // The containment invariant the schema also enforces: VAT is inside the
    // total, never added to it.
    expect(checkout.vatMinor).toBeLessThanOrEqual(checkout.totalMinor);
  });

  it.each([
    // Totals large enough that the naive `2 × total × 10000` intermediate
    // leaves the safe-integer range and rounds the net the wrong way. Each of
    // these was found by differential testing against exact rational
    // arithmetic; the expectation is the exact answer, computed independently.
    ["a total that overflows the naive intermediate", 1_291, 862_307_396_362, 98_595_239_457],
    ["another such total", 2_039, 669_154_083_142, 113_332_101_963],
    ["a third such total", 3_927, 487_656_261_353, 137_504_569_422],
  ])("derives VAT exactly for %s", (_label, vatRateBp, totalMinor, expected) => {
    // Called directly: these totals are far past what a basket can reach
    // through the route, and the point is the arithmetic, not the plumbing.
    expect(vatMinor(totalMinor, vatRateBp)).toBe(expected);
  });

  it("refuses to derive VAT for a total past the exact range", () => {
    // A hard failure rather than a clamp: a total this large is a corrupt
    // catalogue, and an imprecise tax on it would be worse than no answer.
    expect(() => vatMinor(MAX_VAT_SAFE_TOTAL_MINOR + 1, 2_500)).toThrow(
      RangeError,
    );
    expect(() => vatMinor(-1, 2_500)).toThrow(RangeError);
    expect(vatMinor(MAX_VAT_SAFE_TOTAL_MINOR, 2_500)).toBeLessThanOrEqual(
      MAX_VAT_SAFE_TOTAL_MINOR,
    );
  });

  it("never derives a VAT outside the total that contains it", () => {
    // The invariant the schema's containment CHECK also states. Asserted over a
    // spread of rates and magnitudes so the derivation can never be the thing
    // that trips that CHECK at runtime.
    for (const vatRateBp of [0, 1, 600, 1_200, 2_500, 9_999, 10_000]) {
      for (const totalMinor of [
        0, 1, 2, 7, 99, 100, 12_345, 999_999, 1_000_000_000,
        MAX_VAT_SAFE_TOTAL_MINOR,
      ]) {
        const vat = vatMinor(totalMinor, vatRateBp);
        expect(vat).toBeGreaterThanOrEqual(0);
        expect(vat).toBeLessThanOrEqual(totalMinor);
      }
    }
  });

  it("caps carriage so an absurd weight cannot outrun exact arithmetic", () => {
    // Column ceilings permit ~1e16 of carriage. The cap is what keeps a
    // six-orders-of-magnitude weight typo from producing a quote whose VAT
    // cannot be derived exactly.
    const capped = shippingMinorFor(
      "worldwide",
      { worldwide: 10_000_000 },
      [{ quantity: 999, weightGrams: 1_000_000 }],
    );

    expect(capped).toBe(MAX_SHIPPING_MINOR);
    // The packaging allowance adds at most one tier, so it cannot lift an
    // already-capped quote past the cap, nor push an uncapped one over the
    // safe-integer boundary the cap exists to protect.
    expect(capped).toBeLessThanOrEqual(MAX_VAT_SAFE_TOTAL_MINOR);
  });

  it("restores the standard rate for the remaining suites", async () => {
    await env.DB.prepare("UPDATE tenants SET vat_rate_bp = 2500 WHERE tenant_id = ?")
      .bind(TENANT_B)
      .run();

    const row = await env.DB.prepare(
      "SELECT vat_rate_bp FROM tenants WHERE tenant_id = ?",
    )
      .bind(TENANT_B)
      .first<{ vat_rate_bp: number }>();

    expect(row?.vat_rate_bp).toBe(2_500);
  });
});

describe("POST /v1/checkout request rejection", () => {
  it.each([
    ["unitPriceMinor on an item", { productId: "ck-a-live", quantity: 1, unitPriceMinor: 1 }],
    ["price on an item", { productId: "ck-a-live", quantity: 1, price: 1 }],
    ["sku on an item", { productId: "ck-a-live", quantity: 1, sku: "CK-A-LIVE" }],
    ["name on an item", { productId: "ck-a-live", quantity: 1, name: "Free" }],
  ])("rejects a body carrying %s", async (_label, item) => {
    const response = await post(HOST_A, {
      email: "tamper@example.test",
      idempotencyKey: nextKey(),
      items: [item],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Request is not valid" },
    });
  });

  it.each([
    ["a currency override", { currency: "USD" }],
    ["a totals override", { totalMinor: 0 }],
    ["a tenant override", { tenantId: TENANT_B }],
    ["a status override", { status: "completed" }],
  ])("rejects an envelope carrying %s", async (_label, extra) => {
    const response = await post(HOST_A, {
      email: "tamper@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1 }],
      ...extra,
    });

    expect(response.status).toBe(400);
  });

  it.each([
    ["quantity 0", 0],
    ["quantity 1000", 1_000],
    ["a fractional quantity", 1.5],
    ["a negative quantity", -1],
    ["a string quantity", "2"],
  ])("rejects %s", async (_label, quantity) => {
    const response = await post(HOST_A, {
      email: "quantity@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity }],
    });

    expect(response.status).toBe(400);
  });

  it("rejects an empty basket", async () => {
    const response = await post(HOST_A, {
      email: "empty@example.test",
      idempotencyKey: nextKey(),
      items: [],
    });

    expect(response.status).toBe(400);
  });

  it("rejects a basket of 51 items", async () => {
    const before = await countCheckouts(TENANT_A);
    const response = await post(HOST_A, {
      email: "toomany@example.test",
      idempotencyKey: nextKey(),
      items: Array.from({ length: 51 }, () => ({
        productId: "ck-a-live",
        quantity: 1,
      })),
    });

    expect(response.status).toBe(400);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it.each([
    ["a missing email", { idempotencyKey: "abcdefgh", items: [{ productId: "ck-a-live", quantity: 1 }] }],
    ["an email with no domain", { email: "buyer@", idempotencyKey: "abcdefgh", items: [{ productId: "ck-a-live", quantity: 1 }] }],
    ["an email with two at signs", { email: "a@b@c.test", idempotencyKey: "abcdefgh", items: [{ productId: "ck-a-live", quantity: 1 }] }],
    ["a short idempotency key", { email: "b@example.test", idempotencyKey: "short", items: [{ productId: "ck-a-live", quantity: 1 }] }],
    ["an idempotency key with a forbidden character", { email: "b@example.test", idempotencyKey: "key with space", items: [{ productId: "ck-a-live", quantity: 1 }] }],
    ["a missing items array", { email: "b@example.test", idempotencyKey: "abcdefgh" }],
    ["items as an object", { email: "b@example.test", idempotencyKey: "abcdefgh", items: { productId: "ck-a-live" } }],
  ])("rejects %s", async (_label, body) => {
    const response = await post(HOST_A, body);

    expect(response.status).toBe(400);
  });

  it("rejects a non-object body", async () => {
    const response = await post(HOST_A, ["ck-a-live"]);

    expect(response.status).toBe(400);
  });

  it("rejects a body that never says how the basket leaves the shop", async () => {
    // Not defaulted. The two branches price differently, so an omitted method
    // would make the cheaper one reachable by silence.
    const before = await countCheckouts(TENANT_A);
    const response = await postRaw(HOST_A, {
      email: "no-method@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1 }],
      shippingCountry: "SE",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Request is not valid" },
    });
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it.each([
    ["an unknown delivery method", "courier-pigeon"],
    ["production's own spelling for home delivery", "home"],
    ["a delivery method in the wrong case", "Shipping"],
    ["a numeric delivery method", 1],
    ["a null delivery method", null],
  ])("rejects %s", async (_label, deliveryMethod) => {
    const response = await postRaw(HOST_A, {
      deliveryMethod,
      email: "bad-method@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1 }],
      shippingCountry: "SE",
    });

    expect(response.status).toBe(400);
  });

  it("rejects a collected basket that also names a destination", async () => {
    // Self-contradictory rather than merely redundant: the schema stores NULL
    // there, so accepting this would silently discard a field the caller
    // believed mattered.
    const response = await postRaw(HOST_A, {
      deliveryMethod: "pickup",
      email: "pickup-country@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-pickup", quantity: 1 }],
      shippingCountry: "SE",
    });

    expect(response.status).toBe(400);
  });

  it("rejects a collected basket naming a null destination", async () => {
    // `shippingCountry: null` is still the key being PRESENT. Accepting it
    // because the value happens to match what would be stored would make the
    // allowlist depend on values rather than on keys.
    const response = await postRaw(HOST_A, {
      deliveryMethod: "pickup",
      email: "pickup-null-country@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-pickup", quantity: 1 }],
      shippingCountry: null,
    });

    expect(response.status).toBe(400);
  });

  it.each([
    ["a missing destination", undefined],
    ["a null destination", null],
    ["an empty destination", ""],
    ["a one-letter destination", "S"],
    ["a three-letter destination", "SWE"],
    ["a numeric destination", "12"],
    ["a destination with a digit", "S1"],
    ["a destination with a space", "S "],
    ["a non-ASCII destination", "SÉ"],
    ["a destination as a number", 46],
    ["a destination as an object", { country: "SE" }],
  ])("rejects a shipped basket with %s", async (_label, shippingCountry) => {
    const before = await countCheckouts(TENANT_A);
    const body: Record<string, unknown> = {
      deliveryMethod: "shipping",
      email: "bad-country@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1 }],
    };
    if (shippingCountry !== undefined) {
      body.shippingCountry = shippingCountry;
    }

    const response = await postRaw(HOST_A, body);

    expect(response.status).toBe(400);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it.each([
    ["a shipping cost override", { shippingMinor: 0 }],
    ["a vat override", { vatMinor: 0 }],
    ["a vat rate override", { vatRateBp: 0 }],
    ["a discount override", { discountMinor: 10_000 }],
    ["a subtotal override", { subtotalMinor: 1 }],
    ["production's delivery envelope", { deliveryInfo: { method: "pickup" } }],
    ["a shipping envelope", { shippingInfo: { cost: 0 } }],
  ])("rejects an envelope carrying %s", async (_label, extra) => {
    // The new money fields join the existing allowlist rather than opening a
    // seam beside it: anything the server computes is refused on the way in.
    const before = await countCheckouts(TENANT_A);
    const response = await post(HOST_A, {
      email: "tamper-shipping@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1 }],
      ...extra,
    });

    expect(response.status).toBe(400);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it.each([
    ["a weight on an item", { productId: "ck-a-live", quantity: 1, weightGrams: 0 }],
    ["a shipping table on an item", { productId: "ck-a-live", quantity: 1, shippingRates: {} }],
    ["a pickup flag on an item", { productId: "ck-a-live", quantity: 1, allowPickup: true }],
  ])("rejects %s", async (_label, item) => {
    const response = await post(HOST_A, {
      email: "tamper-item@example.test",
      idempotencyKey: nextKey(),
      items: [item],
    });

    expect(response.status).toBe(400);
  });

  it("fails closed for an unknown hostname before the body is judged", async () => {
    const response = await post("unknown.checkout.test", {
      email: "buyer@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1 }],
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Checkout not found" },
    });
  });

  it("does not expose the surface through another method", async () => {
    const response = await exports.default.fetch(
      new Request(`https://${HOST_A}/v1/checkout`),
    );

    expect(response.status).toBe(404);
  });
});

describe("POST /v1/checkout item resolution", () => {
  it.each([
    ["another tenant's product", { productId: "ck-b-live", quantity: 1 }],
    [
      "another tenant's product and variant",
      { productId: "ck-b-live", quantity: 1, variantId: "ck-b-live-m" },
    ],
    [
      "this tenant's product with another tenant's variant",
      { productId: "ck-a-live", quantity: 1, variantId: "ck-b-live-m" },
    ],
    ["a draft product", { productId: "ck-a-draft", quantity: 1 }],
    ["an archived product", { productId: "ck-a-archived", quantity: 1 }],
    ["an unpublished product", { productId: "ck-a-unpublished", quantity: 1 }],
    ["an unknown product", { productId: "ck-a-nonexistent", quantity: 1 }],
    [
      "an inactive variant",
      { productId: "ck-a-live", quantity: 1, variantId: "ck-a-live-x" },
    ],
    [
      "a variant belonging to another product",
      { productId: "ck-a-live", quantity: 1, variantId: "ck-a-second-s" },
    ],
    [
      "an unknown variant",
      { productId: "ck-a-live", quantity: 1, variantId: "ck-a-nonexistent" },
    ],
  ])("returns an opaque 422 for %s and writes nothing", async (_label, item) => {
    const before = await countCheckouts(TENANT_A);
    const response = await post(HOST_A, {
      email: "resolve@example.test",
      idempotencyKey: nextKey(),
      items: [item],
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({
      error: { code: "unprocessable", message: "Request could not be processed" },
    });
    // The error must not name the item, or the route becomes a catalogue oracle.
    expect(JSON.stringify(body)).not.toContain(item.productId);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it("rejects the whole basket when only one line is unresolvable", async () => {
    const before = await countCheckouts(TENANT_A);
    const response = await post(HOST_A, {
      email: "partial@example.test",
      idempotencyKey: nextKey(),
      items: [
        { productId: "ck-a-live", quantity: 1 },
        { productId: "ck-b-live", quantity: 1 },
      ],
    });

    expect(response.status).toBe(422);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM checkout_items WHERE product_id = ?",
      )
        .bind("ck-b-live")
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
  });

  it.each([
    [
      "the same product twice",
      [
        { productId: "ck-a-live", quantity: 1 },
        { productId: "ck-a-live", quantity: 2 },
      ],
    ],
    [
      "the same product and variant twice",
      [
        { productId: "ck-a-live", quantity: 1, variantId: "ck-a-live-m" },
        { productId: "ck-a-live", quantity: 4, variantId: "ck-a-live-m" },
      ],
    ],
  ])("rejects a basket naming %s", async (_label, items) => {
    const before = await countCheckouts(TENANT_A);
    const response = await post(HOST_A, {
      email: "dupe@example.test",
      idempotencyKey: nextKey(),
      items,
    });

    expect(response.status).toBe(422);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it("rejects a basket that mixes currencies", async () => {
    await env.DB.prepare(
      `INSERT INTO products (
        product_id, tenant_id, status, sku, name, b2c_price_minor,
        currency, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, ?, 'EUR', ?, ?)`,
    )
      .bind("ck-a-eur", TENANT_A, "CK-A-EUR", "Euro product", 1_000, NOW, NOW)
      .run();
    await env.DB.prepare(
      `INSERT INTO product_publications (
        product_id, tenant_id, published, public_name,
        public_price_minor, currency, published_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, 'EUR', ?, ?)`,
    )
      .bind("ck-a-eur", TENANT_A, "Public ck-a-eur", 1_000, NOW, NOW)
      .run();

    const before = await countCheckouts(TENANT_A);
    const response = await post(HOST_A, {
      email: "mixed@example.test",
      idempotencyKey: nextKey(),
      items: [
        { productId: "ck-a-live", quantity: 1 },
        { productId: "ck-a-eur", quantity: 1 },
      ],
    });

    expect(response.status).toBe(422);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it("accepts the same product under two different variants", async () => {
    const response = await post(HOST_A, {
      email: "twovariants@example.test",
      idempotencyKey: nextKey(),
      items: [
        { productId: "ck-a-live", quantity: 1 },
        { productId: "ck-a-live", quantity: 1, variantId: "ck-a-live-m" },
      ],
    });
    const body = (await response.json()) as CheckoutBody;

    expect(response.status).toBe(201);
    expect(body.checkout.subtotalMinor).toBe(19_900 + 21_500);
    // Two units at the 10 g substitute plus 20 g packaging is 40 g: one tier.
    expect(body.checkout.shippingMinor).toBe(2_900);
  });
});

describe("POST /v1/checkout idempotency", () => {
  it("replays the same checkout for the same key and payload", async () => {
    const idempotencyKey = nextKey();
    const payload = {
      email: "replay@example.test",
      idempotencyKey,
      items: [{ productId: "ck-a-live", quantity: 2 }],
    };

    const first = await post(HOST_A, payload);
    const firstBody = (await first.json()) as CheckoutBody;
    expect(first.status).toBe(201);

    const second = await post(HOST_A, payload);
    const secondBody = (await second.json()) as CheckoutBody;

    expect(second.status).toBe(200);
    expect(secondBody.checkout).toEqual(firstBody.checkout);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM checkouts
       WHERE tenant_id = ? AND customer_email = ?`,
    )
      .bind(TENANT_A, "replay@example.test")
      .first<{ total: number }>();
    expect(rows?.total).toBe(1);

    const items = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM checkout_items WHERE checkout_id = ?",
    )
      .bind(firstBody.checkout.checkoutId)
      .first<{ total: number }>();
    expect(items?.total).toBe(1);
  });

  it.each([
    [
      "a different quantity",
      { email: "reuse@example.test", items: [{ productId: "ck-a-live", quantity: 5 }] },
    ],
    [
      "a different product",
      { email: "reuse@example.test", items: [{ productId: "ck-a-second", quantity: 1 }] },
    ],
    [
      "an extra line",
      {
        email: "reuse@example.test",
        items: [
          { productId: "ck-a-live", quantity: 1 },
          { productId: "ck-a-second", quantity: 1 },
        ],
      },
    ],
    [
      "a different email",
      { email: "other@example.test", items: [{ productId: "ck-a-live", quantity: 1 }] },
    ],
    [
      "a variant where the first had none",
      {
        email: "reuse@example.test",
        items: [{ productId: "ck-a-live", quantity: 1, variantId: "ck-a-live-m" }],
      },
    ],
  ])("conflicts when the same key is reused with %s", async (_label, changed) => {
    const idempotencyKey = nextKey();
    const first = await post(HOST_A, {
      email: "reuse@example.test",
      idempotencyKey,
      items: [{ productId: "ck-a-live", quantity: 1 }],
    });
    expect(first.status).toBe(201);

    const before = await countCheckouts(TENANT_A);
    const second = await post(HOST_A, { ...changed, idempotencyKey });

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it("scopes idempotency keys per tenant", async () => {
    const idempotencyKey = nextKey();

    const a = await post(HOST_A, {
      email: "shared-key@example.test",
      idempotencyKey,
      items: [{ productId: "ck-a-live", quantity: 1 }],
    });
    const b = await post(HOST_B, {
      email: "shared-key@example.test",
      idempotencyKey,
      items: [{ productId: "ck-b-live", quantity: 1 }],
    });

    const aBody = (await a.json()) as CheckoutBody;
    const bBody = (await b.json()) as CheckoutBody;

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(aBody.checkout.checkoutId).not.toBe(bBody.checkout.checkoutId);
    // One unit each, unconfigured weight: 10 + 20 g = one 2 900 fallback tier.
    expect(aBody.checkout.totalMinor).toBe(19_900 + 2_900);
    expect(bBody.checkout.totalMinor).toBe(55_000 + 2_900);

    // The stored hashes differ even though the caller key is byte-identical,
    // so neither tenant's row can be probed with the other's key.
    const hashes = await env.DB.prepare(
      "SELECT DISTINCT idempotency_key_hash FROM checkouts WHERE checkout_id IN (?, ?)",
    )
      .bind(aBody.checkout.checkoutId, bBody.checkout.checkoutId)
      .all<{ idempotency_key_hash: string }>();
    expect(hashes.results).toHaveLength(2);
  });

  it("replays a collected checkout identically", async () => {
    const payload = {
      deliveryMethod: "pickup",
      email: "pickup-replay@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-pickup", quantity: 2 }],
    };

    const first = await postRaw(HOST_A, payload);
    const firstBody = (await first.json()) as CheckoutBody;
    expect(first.status).toBe(201);

    const second = await postRaw(HOST_A, payload);
    const secondBody = (await second.json()) as CheckoutBody;

    expect(second.status).toBe(200);
    expect(secondBody.checkout).toEqual(firstBody.checkout);
    expect(secondBody.checkout.deliveryMethod).toBe("pickup");
    expect(secondBody.checkout.shippingCountry).toBeNull();
  });

  it("conflicts when the same key is replayed with the delivery method switched", async () => {
    // The delivery decision is priced, so reusing the key for the other method
    // is reusing it for a different purchase. Returning the stored checkout
    // would hand back a quote the caller did not just describe; returning a new
    // one would break the key.
    const idempotencyKey = nextKey();
    const first = await postRaw(HOST_A, {
      deliveryMethod: "pickup",
      email: "method-switch@example.test",
      idempotencyKey,
      items: [{ productId: "ck-a-pickup", quantity: 1 }],
    });
    expect(first.status).toBe(201);

    const before = await countCheckouts(TENANT_A);
    const second = await postRaw(HOST_A, {
      deliveryMethod: "shipping",
      email: "method-switch@example.test",
      idempotencyKey,
      items: [{ productId: "ck-a-pickup", quantity: 1 }],
      shippingCountry: "SE",
    });

    expect(second.status).toBe(409);
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);
  });

  it("conflicts when the same key is replayed against a different destination", async () => {
    // SE and NO are different regions and therefore different carriage, even
    // though nothing about the basket changed.
    const idempotencyKey = nextKey();
    const payload = {
      deliveryMethod: "shipping",
      email: "country-switch@example.test",
      idempotencyKey,
      items: [{ productId: "ck-a-rates", quantity: 1 }],
    };

    const first = await postRaw(HOST_A, { ...payload, shippingCountry: "SE" });
    expect(first.status).toBe(201);

    const second = await postRaw(HOST_A, { ...payload, shippingCountry: "NO" });
    expect(second.status).toBe(409);
  });

  it("conflicts on replay after the merchant edited the carriage table", async () => {
    // The case only the server can see: the client sends a byte-identical body
    // both times, and the stored carriage quote has silently gone stale.
    await seedProduct({
      productId: "ck-a-retariffed",
      publicPriceMinor: 10_000,
      published: true,
      shippingRates: { sweden: { cost: 1_000 } },
      sku: "CK-A-RETARIFFED",
      status: "active",
      tenantId: TENANT_A,
      weightGrams: 50,
    });

    const payload = {
      deliveryMethod: "shipping",
      email: "retariffed@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-retariffed", quantity: 1 }],
      shippingCountry: "SE",
    };

    const first = await postRaw(HOST_A, payload);
    const firstBody = (await first.json()) as CheckoutBody;
    // 50 g plus 20 g packaging is two tiers of the configured 1 000.
    expect(first.status).toBe(201);
    expect(firstBody.checkout.shippingMinor).toBe(2_000);

    await env.DB.prepare(
      "UPDATE products SET shipping_json = ?, updated_at = ? WHERE product_id = ?",
    )
      .bind(
        JSON.stringify({ sweden: { cost: 9_000 } }),
        NOW + 1,
        "ck-a-retariffed",
      )
      .run();

    const second = await postRaw(HOST_A, payload);
    expect(second.status).toBe(409);
  });

  it("conflicts on replay after the merchant edited a product's weight", async () => {
    // Weight moves the tier count, which moves the carriage, which moves the
    // total. Nothing in the request changed; the quote still must not be reused.
    await seedProduct({
      productId: "ck-a-reweighed",
      publicPriceMinor: 10_000,
      published: true,
      sku: "CK-A-REWEIGHED",
      status: "active",
      tenantId: TENANT_A,
      weightGrams: 50,
    });

    const payload = {
      deliveryMethod: "shipping",
      email: "reweighed@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-reweighed", quantity: 1 }],
      shippingCountry: "SE",
    };

    const first = await postRaw(HOST_A, payload);
    const firstBody = (await first.json()) as CheckoutBody;
    expect(first.status).toBe(201);
    // 50 + 20 g = 70 g: two tiers.
    expect(firstBody.checkout.shippingMinor).toBe(5_800);

    // 90 + 20 g = 110 g: three tiers. The edit must cross a tier boundary for
    // the carriage to move at all — 51 g would still be two tiers and this
    // test would then pass for the wrong reason.
    await env.DB.prepare(
      "UPDATE products SET weight_grams = ?, updated_at = ? WHERE product_id = ?",
    )
      .bind(90, NOW + 1, "ck-a-reweighed")
      .run();

    const second = await postRaw(HOST_A, payload);
    expect(second.status).toBe(409);
  });

  it("conflicts on replay after the tenant changed its VAT rate", async () => {
    // The frozen rate is part of the fingerprint, so a replay cannot hand back
    // an invoice line computed under a rate that no longer applies.
    await seedProduct({
      productId: "ck-a-revatted",
      publicPriceMinor: 10_000,
      published: true,
      sku: "CK-A-REVATTED",
      status: "active",
      tenantId: TENANT_A,
    });

    const payload = {
      deliveryMethod: "shipping",
      email: "revatted@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-revatted", quantity: 1 }],
      shippingCountry: "SE",
    };

    const first = await postRaw(HOST_A, payload);
    const firstBody = (await first.json()) as CheckoutBody;
    expect(first.status).toBe(201);
    expect(firstBody.checkout.vatRateBp).toBe(2_500);

    await env.DB.prepare("UPDATE tenants SET vat_rate_bp = 1200 WHERE tenant_id = ?")
      .bind(TENANT_A)
      .run();

    try {
      const second = await postRaw(HOST_A, payload);
      expect(second.status).toBe(409);
    } finally {
      await env.DB.prepare(
        "UPDATE tenants SET vat_rate_bp = 2500 WHERE tenant_id = ?",
      )
        .bind(TENANT_A)
        .run();
    }
  });

  it("conflicts on replay after the catalogue price moved", async () => {
    await seedProduct({
      productId: "ck-a-repriced",
      publicPriceMinor: 1_000,
      published: true,
      sku: "CK-A-REPRICED",
      status: "active",
      tenantId: TENANT_A,
    });

    const idempotencyKey = nextKey();
    const payload = {
      email: "repriced@example.test",
      idempotencyKey,
      items: [{ productId: "ck-a-repriced", quantity: 1 }],
    };

    const first = await post(HOST_A, payload);
    expect(first.status).toBe(201);

    await env.DB.prepare(
      `UPDATE product_publications
       SET public_price_minor = ?, projection_version = projection_version + 1,
           updated_at = ?
       WHERE product_id = ?`,
    )
      .bind(2_000, NOW + 1, "ck-a-repriced")
      .run();

    // Neither answer would be honest: the stored checkout quotes a price that
    // no longer exists, and a fresh one would break the key's idempotency.
    // The client must retry under a new key.
    const second = await post(HOST_A, payload);
    expect(second.status).toBe(409);
  });

  it("conflicts on replay after the catalogue name moved", async () => {
    await seedProduct({
      productId: "ck-a-renamed",
      publicPriceMinor: 3_000,
      published: true,
      sku: "CK-A-RENAMED",
      status: "active",
      tenantId: TENANT_A,
    });

    const idempotencyKey = nextKey();
    const payload = {
      email: "renamed@example.test",
      idempotencyKey,
      items: [{ productId: "ck-a-renamed", quantity: 1 }],
    };

    const first = await post(HOST_A, payload);
    expect(first.status).toBe(201);

    // A rename with the price untouched: the stored snapshot now describes a
    // product the catalogue no longer names that way, so replaying it would
    // hand the client a description matching neither request nor catalogue.
    await env.DB.prepare(
      `UPDATE product_publications
       SET public_name = ?, projection_version = projection_version + 1,
           updated_at = ?
       WHERE product_id = ?`,
    )
      .bind("Public ck-a-renamed (no warranty)", NOW + 1, "ck-a-renamed")
      .run();

    const second = await post(HOST_A, payload);
    expect(second.status).toBe(409);
  });
});

describe("POST /v1/checkout rate limiting", () => {
  it("throttles the eleventh request from one address and frees the next", async () => {
    const ip = "198.51.100.201";
    const other = "198.51.100.202";

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const allowed = await post(
        HOST_A,
        {
          email: `flood-${attempt}@example.test`,
          idempotencyKey: nextKey(),
          items: [{ productId: "ck-a-live", quantity: 1 }],
        },
        { "cf-connecting-ip": ip },
      );

      expect(allowed.status).toBe(201);
    }

    const before = await countCheckouts(TENANT_A);
    const denied = await post(
      HOST_A,
      {
        email: "flood-11@example.test",
        idempotencyKey: nextKey(),
        items: [{ productId: "ck-a-live", quantity: 1 }],
      },
      { "cf-connecting-ip": ip },
    );

    expect(denied.status).toBe(429);
    await expect(denied.json()).resolves.toEqual({
      error: { code: "rate_limited", message: "Too many requests" },
    });

    const retryAfter = Number(denied.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // Refused before createCheckout ran, so the throttled request wrote nothing.
    await expect(countCheckouts(TENANT_A)).resolves.toBe(before);

    // The limit is per address, not global: an unrelated buyer is unaffected.
    const unaffected = await post(
      HOST_A,
      {
        email: "unaffected@example.test",
        idempotencyKey: nextKey(),
        items: [{ productId: "ck-a-live", quantity: 1 }],
      },
      { "cf-connecting-ip": other },
    );

    expect(unaffected.status).toBe(201);
  });

  it("throttles a malformed body flood before the body is judged", async () => {
    const ip = "198.51.100.203";

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const rejected = await post(
        HOST_A,
        { email: "not-an-email", idempotencyKey: "x", items: [] },
        { "cf-connecting-ip": ip },
      );

      expect(rejected.status).toBe(400);
    }

    // The IP limit runs BEFORE parsing, so a caller cannot spend an unlimited
    // number of cheap 400s: the eleventh is throttled like any other request.
    const denied = await post(
      HOST_A,
      { email: "not-an-email", idempotencyKey: "x", items: [] },
      { "cf-connecting-ip": ip },
    );

    expect(denied.status).toBe(429);
  });

  it("throttles one address across many client addresses", async () => {
    const email = "distributed@example.test";

    // Thirty allowed, spread two per address so the per-IP limit of ten never
    // fires and the per-email limit is unambiguously the thing under test.
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const allowed = await post(
        HOST_A,
        {
          email,
          idempotencyKey: nextKey(),
          items: [{ productId: "ck-a-live", quantity: 1 }],
        },
        { "cf-connecting-ip": `198.51.101.${attempt}` },
      );

      expect(allowed.status).toBe(201);
    }

    const denied = await post(
      HOST_A,
      {
        email,
        idempotencyKey: nextKey(),
        items: [{ productId: "ck-a-live", quantity: 1 }],
      },
      // A fresh address with its own untouched per-IP allowance: only the
      // per-email limit can be what refuses this.
      { "cf-connecting-ip": "198.51.102.1" },
    );

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

    // Casing cannot mint a fresh bucket: the address is lowercased before the
    // limit keys on it.
    const recased = await post(
      HOST_A,
      {
        email: "Distributed@Example.TEST",
        idempotencyKey: nextKey(),
        items: [{ productId: "ck-a-live", quantity: 1 }],
      },
      { "cf-connecting-ip": "198.51.102.2" },
    );

    expect(recased.status).toBe(429);
  });

  it("counts replays against the limit without breaking idempotency", async () => {
    const ip = "198.51.100.204";
    const payload = {
      email: "replay-limited@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1 }],
    };

    const first = await post(HOST_A, payload, { "cf-connecting-ip": ip });
    const firstBody = (await first.json()) as CheckoutBody;
    expect(first.status).toBe(201);

    // Replays are ordinary requests to the limiter — they still cost an
    // allowance — but the ones that get through must still replay correctly.
    for (let attempt = 2; attempt <= 10; attempt += 1) {
      const replayed = await post(HOST_A, payload, { "cf-connecting-ip": ip });
      const replayedBody = (await replayed.json()) as CheckoutBody;

      expect(replayed.status).toBe(200);
      expect(replayedBody.checkout).toEqual(firstBody.checkout);
    }

    await expect(
      post(HOST_A, payload, { "cf-connecting-ip": ip }),
    ).resolves.toMatchObject({ status: 429 });

    // Still exactly one checkout: nothing the limiter did duplicated a row.
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS total FROM checkouts
         WHERE tenant_id = ? AND customer_email = ?`,
      )
        .bind(TENANT_A, "replay-limited@example.test")
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 1 });
  });

  it("stores no raw address for a throttled caller", async () => {
    const ip = "198.51.100.205";
    const email = "traceable-buyer@example.test";

    for (let attempt = 1; attempt <= 11; attempt += 1) {
      await post(
        HOST_A,
        {
          email,
          idempotencyKey: nextKey(),
          items: [{ productId: "ck-a-live", quantity: 1 }],
        },
        { "cf-connecting-ip": ip },
      );
    }

    const dumped = JSON.stringify(
      (
        await env.DB.prepare("SELECT * FROM rate_limit_windows").all<
          Record<string, unknown>
        >()
      ).results,
    );

    expect(dumped).not.toContain(ip);
    expect(dumped).not.toContain(email);
    expect(dumped).not.toContain("traceable-buyer");
  });
});

describe("checkout database invariants", () => {
  async function insertCheckout(
    checkoutId: string,
    columns: {
      country?: string | null;
      deliveryMethod?: string;
      discount?: number;
      shipping?: number;
      subtotal: number;
      total: number;
      vat?: number;
      vatRateBp?: number;
    },
  ): Promise<D1Result> {
    const deliveryMethod = columns.deliveryMethod ?? "shipping";

    return env.DB.prepare(
      `INSERT INTO checkouts (
        checkout_id, tenant_id, status, customer_email, currency,
        delivery_method, shipping_country, subtotal_minor, shipping_minor,
        vat_minor, vat_rate_bp, discount_minor,
        total_minor, idempotency_key_hash, expires_at, created_at, updated_at
      ) VALUES (?, ?, 'open', 'invariant@example.test', 'SEK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        checkoutId,
        TENANT_A,
        deliveryMethod,
        columns.country === undefined
          ? deliveryMethod === "pickup"
            ? null
            : "SE"
          : columns.country,
        columns.subtotal,
        columns.shipping ?? 0,
        columns.vat ?? 0,
        columns.vatRateBp ?? 2_500,
        columns.discount ?? 0,
        columns.total,
        `hash-${checkoutId}`,
        NOW + DAY_MS,
        NOW,
        NOW,
      )
      .run();
  }

  it("rejects a total that disagrees with its components", async () => {
    await expect(
      insertCheckout("ck-bad-total", { subtotal: 1_000, total: 1 }),
    ).rejects.toThrow();
  });

  it("rejects a total that ignores shipping", async () => {
    await expect(
      insertCheckout("ck-bad-total-parts", {
        shipping: 500,
        subtotal: 1_000,
        total: 1_000,
      }),
    ).rejects.toThrow();
  });

  it("rejects a total that adds vat on top of its components", async () => {
    // The v1 contract. Prices are VAT-inclusive, so a total that ADDS vat has
    // charged the tax twice; the schema must refuse it outright rather than
    // leave the double-charge to be caught in review.
    await expect(
      insertCheckout("ck-vat-added", {
        shipping: 500,
        subtotal: 1_000,
        total: 1_750,
        vat: 250,
      }),
    ).rejects.toThrow();
  });

  it("rejects vat that exceeds the total it is contained in", async () => {
    await expect(
      insertCheckout("ck-vat-over", {
        subtotal: 1_000,
        total: 1_000,
        vat: 1_001,
      }),
    ).rejects.toThrow();
  });

  it("rejects a negative vat", async () => {
    await expect(
      insertCheckout("ck-vat-negative", {
        subtotal: 1_000,
        total: 1_000,
        vat: -1,
      }),
    ).rejects.toThrow();
  });

  it("accepts a total that honours every component with vat contained in it", async () => {
    await expect(
      insertCheckout("ck-good-total", {
        discount: 200,
        shipping: 500,
        subtotal: 1_000,
        total: 1_300,
        vat: 260,
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ["a rate below zero", -1],
    ["a rate above 100 percent", 10_001],
  ])("rejects %s", async (label, vatRateBp) => {
    await expect(
      insertCheckout(`ck-rate-${label.replace(/[^a-z]/g, "")}`, {
        subtotal: 0,
        total: 0,
        vatRateBp,
      }),
    ).rejects.toThrow();
  });

  it("rejects a collected checkout that was still charged carriage", async () => {
    // The worker enforces this too. The schema is what makes it true for every
    // writer, including a repair script that never read the worker.
    await expect(
      insertCheckout("ck-pickup-shipped", {
        deliveryMethod: "pickup",
        shipping: 500,
        subtotal: 1_000,
        total: 1_500,
      }),
    ).rejects.toThrow();
  });

  it("rejects an unknown delivery method", async () => {
    await expect(
      insertCheckout("ck-bad-method", {
        deliveryMethod: "teleport",
        subtotal: 0,
        total: 0,
      }),
    ).rejects.toThrow();
  });

  it.each([
    ["a collected checkout carrying a destination", "pickup", "SE"],
    ["a shipped checkout with no destination", "shipping", null],
    ["a lowercase country", "shipping", "se"],
    ["a three-letter country", "shipping", "SWE"],
    ["a one-letter country", "shipping", "S"],
    ["a digit country", "shipping", "12"],
  ])("rejects %s", async (label, deliveryMethod, country) => {
    await expect(
      insertCheckout(`ck-country-${label.replace(/[^a-z]/g, "")}`, {
        country,
        deliveryMethod,
        subtotal: 0,
        total: 0,
      }),
    ).rejects.toThrow();
  });

  it("accepts a collected checkout with no destination and no carriage", async () => {
    await expect(
      insertCheckout("ck-pickup-ok", {
        deliveryMethod: "pickup",
        subtotal: 1_000,
        total: 1_000,
        vat: 200,
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ["a negative subtotal", { subtotal: -1, total: -1 }],
    ["a negative total", { subtotal: 0, total: -1 }],
  ])("rejects %s", async (label, columns) => {
    await expect(
      insertCheckout(`ck-negative-${label.replace(/[^a-z]/g, "")}`, columns),
    ).rejects.toThrow();
  });

  it("rejects an unknown status", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO checkouts (
          checkout_id, tenant_id, status, customer_email, currency,
          delivery_method, shipping_country, subtotal_minor, total_minor,
          vat_rate_bp, idempotency_key_hash,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, 'paid', 'x@example.test', 'SEK', 'shipping', 'SE', 0, 0, 2500, ?, ?, ?, ?)`,
      )
        .bind("ck-bad-status", TENANT_A, "hash-bad-status", NOW, NOW, NOW)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a second checkout on the same payment intent", async () => {
    await insertCheckout("ck-intent-one", { subtotal: 0, total: 0 });
    await insertCheckout("ck-intent-two", { subtotal: 0, total: 0 });

    await env.DB.prepare(
      "UPDATE checkouts SET payment_intent_id = ?, updated_at = ? WHERE checkout_id = ?",
    )
      .bind("pi_shared", NOW + 1, "ck-intent-one")
      .run();

    await expect(
      env.DB.prepare(
        "UPDATE checkouts SET payment_intent_id = ?, updated_at = ? WHERE checkout_id = ?",
      )
        .bind("pi_shared", NOW + 1, "ck-intent-two")
        .run(),
    ).rejects.toThrow();
  });

  it("blocks checkout re-homing at the database boundary", async () => {
    await insertCheckout("ck-rehome", { subtotal: 0, total: 0 });

    await expect(
      env.DB.prepare(
        "UPDATE checkouts SET tenant_id = ?, updated_at = ? WHERE checkout_id = ?",
      )
        .bind(TENANT_B, NOW + 1, "ck-rehome")
        .run(),
    ).rejects.toThrow("tenant_id is immutable");
  });

  it("rejects an item referencing another tenant's product", async () => {
    await insertCheckout("ck-item-foreign-product", { subtotal: 0, total: 0 });

    // The FK alone is satisfied — products.product_id is a global primary key —
    // so only the tenant-match trigger stands between a tenant A line and a
    // tenant B product.
    await expect(
      env.DB.prepare(
        `INSERT INTO checkout_items (
          checkout_item_id, checkout_id, tenant_id, item_index, product_id,
          variant_id, sku, name, quantity, unit_price_minor,
          line_total_minor, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, NULL, ?, ?, 1, 100, 100, ?, ?)`,
      )
        .bind(
          "ck-item-foreign-product-row",
          "ck-item-foreign-product",
          TENANT_A,
          "ck-b-live",
          "FOREIGN",
          "Foreign",
          NOW,
          NOW,
        )
        .run(),
    ).rejects.toThrow("checkout item tenant_id must match product tenant_id");
  });

  it.each([
    ["another tenant's variant", "ck-b-live-m"],
    ["a variant of another product", "ck-a-second-s"],
  ])("rejects an item referencing %s", async (label, variantId) => {
    const checkoutId = `ck-item-var-${label.replace(/[^a-z]/g, "")}`;
    await insertCheckout(checkoutId, { subtotal: 0, total: 0 });

    await expect(
      env.DB.prepare(
        `INSERT INTO checkout_items (
          checkout_item_id, checkout_id, tenant_id, item_index, product_id,
          variant_id, sku, name, quantity, unit_price_minor,
          line_total_minor, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, 100, 100, ?, ?)`,
      )
        .bind(
          `${checkoutId}-row`,
          checkoutId,
          TENANT_A,
          "ck-a-live",
          variantId,
          "VAR",
          "Var",
          NOW,
          NOW,
        )
        .run(),
    ).rejects.toThrow(
      "checkout item variant must belong to the same tenant and product",
    );
  });

  it("rejects an item whose tenant differs from its checkout", async () => {
    await insertCheckout("ck-item-parent", { subtotal: 0, total: 0 });

    await expect(
      env.DB.prepare(
        `INSERT INTO checkout_items (
          checkout_item_id, checkout_id, tenant_id, item_index, product_id,
          variant_id, sku, name, quantity, unit_price_minor,
          line_total_minor, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, NULL, ?, ?, 1, 100, 100, ?, ?)`,
      )
        .bind(
          "ck-item-cross",
          "ck-item-parent",
          TENANT_B,
          "ck-b-live",
          "CROSS",
          "Cross",
          NOW,
          NOW,
        )
        .run(),
    ).rejects.toThrow("checkout item tenant_id must match checkout tenant_id");
  });

  it("rejects a line total that disagrees with quantity times price", async () => {
    await insertCheckout("ck-item-math", { subtotal: 0, total: 0 });

    await expect(
      env.DB.prepare(
        `INSERT INTO checkout_items (
          checkout_item_id, checkout_id, tenant_id, item_index, product_id,
          variant_id, sku, name, quantity, unit_price_minor,
          line_total_minor, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, NULL, ?, ?, 3, 100, 100, ?, ?)`,
      )
        .bind(
          "ck-item-bad-math",
          "ck-item-math",
          TENANT_A,
          "ck-a-live",
          "MATH",
          "Math",
          NOW,
          NOW,
        )
        .run(),
    ).rejects.toThrow();
  });

  it.each([
    ["quantity 0", 0],
    ["quantity 1000", 1_000],
  ])("rejects an item with %s", async (label, quantity) => {
    await insertCheckout(`ck-item-q-${quantity}`, { subtotal: 0, total: 0 });

    await expect(
      env.DB.prepare(
        `INSERT INTO checkout_items (
          checkout_item_id, checkout_id, tenant_id, item_index, product_id,
          variant_id, sku, name, quantity, unit_price_minor,
          line_total_minor, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
      )
        .bind(
          `ck-item-bad-q-${quantity}`,
          `ck-item-q-${quantity}`,
          TENANT_A,
          "ck-a-live",
          `Q${label}`,
          "Quantity",
          quantity,
          NOW,
          NOW,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a duplicate item index inside one checkout", async () => {
    await insertCheckout("ck-item-index", { subtotal: 0, total: 0 });

    const insertItem = (itemId: string): Promise<D1Result> =>
      env.DB.prepare(
        `INSERT INTO checkout_items (
          checkout_item_id, checkout_id, tenant_id, item_index, product_id,
          variant_id, sku, name, quantity, unit_price_minor,
          line_total_minor, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, NULL, ?, ?, 1, 100, 100, ?, ?)`,
      )
        .bind(
          itemId,
          "ck-item-index",
          TENANT_A,
          "ck-a-live",
          itemId,
          "Index",
          NOW,
          NOW,
        )
        .run();

    await expect(insertItem("ck-item-index-one")).resolves.toBeDefined();
    await expect(insertItem("ck-item-index-two")).rejects.toThrow();
  });

  it.each([
    ["unit_price_minor", "unit_price_minor = 1"],
    ["quantity", "quantity = 2"],
    ["line_total_minor", "line_total_minor = 1"],
    ["sku", "sku = 'REWRITTEN'"],
    ["name", "name = 'Rewritten'"],
    ["product_id", "product_id = 'ck-a-second'"],
    ["variant_id", "variant_id = 'ck-a-live-m'"],
  ])("freezes the item snapshot against a %s edit", async (_label, assignment) => {
    const response = await post(HOST_A, {
      email: "frozen@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1 }],
    });
    const body = (await response.json()) as CheckoutBody;
    expect(response.status).toBe(201);

    await expect(
      env.DB.prepare(
        `UPDATE checkout_items SET ${assignment}, updated_at = ? WHERE checkout_id = ?`,
      )
        .bind(NOW + 1, body.checkout.checkoutId)
        .run(),
    ).rejects.toThrow("checkout item snapshots are immutable");
  });

  it("blocks item re-homing at the database boundary", async () => {
    const response = await post(HOST_A, {
      email: "item-rehome@example.test",
      idempotencyKey: nextKey(),
      items: [{ productId: "ck-a-live", quantity: 1 }],
    });
    const body = (await response.json()) as CheckoutBody;

    // Re-homing trips both the parent-checkout and the product guard; either
    // one is sufficient, so the assertion accepts whichever fires first.
    await expect(
      env.DB.prepare(
        "UPDATE checkout_items SET tenant_id = ?, updated_at = ? WHERE checkout_id = ?",
      )
        .bind(TENANT_B, NOW + 1, body.checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/checkout item tenant_id must match (checkout|product) tenant_id/);
  });
});

/**
 * Migration 0009 recreated `checkouts` in order to replace its totals CHECK,
 * and recreating a table drops every trigger and index attached to it. The
 * suite above already re-proves each guard through the live surface; this one
 * asserts the schema objects themselves exist, so a future migration that
 * quietly loses one fails HERE, with a name, rather than surfacing later as a
 * behavioural test that mysteriously stops covering anything.
 */
describe("migration 0009 schema survival", () => {
  it("kept every checkout trigger through the table recreate", async () => {
    const triggers = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger'
         AND tbl_name IN ('checkouts', 'checkout_items')
       ORDER BY name`,
    ).all<{ name: string }>();

    expect(triggers.results.map((row) => row.name)).toEqual([
      "checkout_items_snapshot_immutable",
      "checkout_items_tenant_immutable",
      "checkout_items_tenant_matches_checkout_insert",
      "checkout_items_tenant_matches_checkout_update",
      "checkout_items_tenant_matches_product_insert",
      "checkout_items_tenant_matches_product_update",
      "checkout_items_variant_matches_product_insert",
      "checkout_items_variant_matches_product_update",
      "checkouts_tenant_immutable",
    ]);
  });

  it("kept every checkout index through the table recreate", async () => {
    const indexes = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND tbl_name IN ('checkouts', 'checkout_items')
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all<{ name: string }>();

    expect(indexes.results.map((row) => row.name)).toEqual([
      "checkout_items_checkout_idx",
      "checkouts_tenant_email_idx",
      "checkouts_tenant_status_idx",
    ]);
  });

  it("left the child's foreign key pointing at the live parent", async () => {
    // The specific trap this migration was written around: with
    // legacy_alter_table off, ALTER TABLE RENAME rewrites a child's REFERENCES
    // clause to name the renamed table. Had the migration renamed rather than
    // rebuilt, this would read `checkouts_migration_0009` or similar and the FK
    // would guard nothing.
    const schema = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'checkout_items'",
    ).first<{ sql: string }>();

    expect(schema?.sql).toContain("REFERENCES checkouts(checkout_id)");
    expect(schema?.sql).not.toContain("migration_0009");
  });

  it("left no staging tables behind", async () => {
    const leftovers = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE '%migration_0009%'`,
    ).all<{ name: string }>();

    expect(leftovers.results).toEqual([]);
  });

  it("reports no orphaned foreign keys anywhere in the database", async () => {
    const violations = await env.DB.prepare("PRAGMA foreign_key_check").all();

    expect(violations.results).toEqual([]);
  });

  it("gave every tenant the standard VAT rate", async () => {
    // ADD COLUMN with a constant default: existing tenants were all quoted at
    // 25%, so the backfill states what was already true rather than inventing
    // a number.
    const rows = await env.DB.prepare(
      "SELECT DISTINCT vat_rate_bp FROM tenants WHERE tenant_id IN (?, ?)",
    )
      .bind(TENANT_A, TENANT_B)
      .all<{ vat_rate_bp: number }>();

    expect(rows.results).toEqual([{ vat_rate_bp: 2_500 }]);
  });

  it("reproduces the historical row mapping the migration would have applied", async () => {
    // Staging holds no checkouts, so the copy path moved zero rows and cannot
    // be observed directly. What CAN be checked is the claim the mapping rests
    // on: a 0007-shaped row (shipping = vat = discount = 0, so total =
    // subtotal) satisfies the v2 contract unchanged, and the SQL VAT
    // expression agrees with the worker's TypeScript one on the same input.
    const legacyTotal = 54_650;

    await env.DB.prepare(
      `INSERT INTO checkouts (
        checkout_id, tenant_id, status, customer_email, currency,
        delivery_method, shipping_country, subtotal_minor, shipping_minor,
        vat_minor, vat_rate_bp, discount_minor, total_minor,
        idempotency_key_hash, expires_at, created_at, updated_at
      )
      SELECT
        'ck-0009-mapped', ?, 'open', 'legacy@example.test', 'SEK',
        'shipping', 'SE', ?, 0,
        CAST(? AS INTEGER) - ((2 * CAST(? AS INTEGER) * 10000 + 12500) / 25000),
        2500, 0, ?,
        'hash-ck-0009-mapped', ?, ?, ?`,
    )
      .bind(
        TENANT_A,
        legacyTotal,
        legacyTotal,
        legacyTotal,
        legacyTotal,
        NOW + DAY_MS,
        NOW,
        NOW,
      )
      .run();

    const row = await env.DB.prepare(
      `SELECT subtotal_minor, shipping_minor, vat_minor, vat_rate_bp,
              discount_minor, total_minor, delivery_method, shipping_country
       FROM checkouts WHERE checkout_id = 'ck-0009-mapped'`,
    ).first<Record<string, unknown>>();

    expect(row).toEqual({
      delivery_method: "shipping",
      discount_minor: 0,
      shipping_country: "SE",
      shipping_minor: 0,
      subtotal_minor: legacyTotal,
      total_minor: legacyTotal,
      // The same number the live route derived for this total earlier in this
      // file, proving the SQL and TypeScript formulas have not diverged.
      vat_minor: 10_930,
      vat_rate_bp: 2_500,
    });
  });
});
