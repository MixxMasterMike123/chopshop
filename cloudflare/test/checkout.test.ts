import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const NOW = 1_787_200_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

const TENANT_A = "tenant-ck-a";
const TENANT_B = "tenant-ck-b";
const HOST_A = "a.checkout.test";
const HOST_B = "b.checkout.test";

interface SeedProductOptions {
  productId: string;
  publicPriceMinor: number;
  published: boolean;
  sku: string;
  status: "draft" | "active" | "archived";
  tenantId: string;
}

interface CheckoutBody {
  checkout: {
    checkoutId: string;
    currency: string;
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
    subtotalMinor: number;
    totalMinor: number;
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
      b2c_price_minor, currency, is_pod, internal_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'SEK', 0, ?, ?, ?)`,
  )
    .bind(
      options.productId,
      options.tenantId,
      options.status,
      options.sku,
      `Internal must-not-leak ${options.productId}`,
      777_777,
      JSON.stringify({ supplierCost: "must-not-leak" }),
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

function checkoutRequest(
  hostname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://${hostname}/v1/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function post(
  hostname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return exports.default.fetch(checkoutRequest(hostname, body, headers));
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
    expect(body.checkout.totalMinor).toBe(54_650);
    expect(body.checkout.expiresAt).toBeGreaterThanOrEqual(before + DAY_MS);
    // Currency is a checkout-level value; it must not be repeated per line.
    expect(Object.keys(body.checkout).sort()).toEqual([
      "checkoutId",
      "currency",
      "expiresAt",
      "items",
      "subtotalMinor",
      "totalMinor",
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
      `SELECT tenant_id, status, customer_email, currency, subtotal_minor,
              shipping_minor, vat_minor, discount_minor, total_minor,
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
      discount_minor: 0,
      payment_intent_id: null,
      shipping_minor: 0,
      status: "open",
      subtotal_minor: 54_650,
      tenant_id: TENANT_A,
      total_minor: 54_650,
      vat_minor: 0,
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
    expect(body.checkout.totalMinor).toBe(21_500);
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
    expect(aBody.checkout.totalMinor).toBe(19_900);
    expect(bBody.checkout.totalMinor).toBe(55_000);

    // The stored hashes differ even though the caller key is byte-identical,
    // so neither tenant's row can be probed with the other's key.
    const hashes = await env.DB.prepare(
      "SELECT DISTINCT idempotency_key_hash FROM checkouts WHERE checkout_id IN (?, ?)",
    )
      .bind(aBody.checkout.checkoutId, bBody.checkout.checkoutId)
      .all<{ idempotency_key_hash: string }>();
    expect(hashes.results).toHaveLength(2);
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

describe("checkout database invariants", () => {
  async function insertCheckout(
    checkoutId: string,
    columns: {
      discount?: number;
      shipping?: number;
      subtotal: number;
      total: number;
      vat?: number;
    },
  ): Promise<D1Result> {
    return env.DB.prepare(
      `INSERT INTO checkouts (
        checkout_id, tenant_id, status, customer_email, currency,
        subtotal_minor, shipping_minor, vat_minor, discount_minor,
        total_minor, idempotency_key_hash, expires_at, created_at, updated_at
      ) VALUES (?, ?, 'open', 'invariant@example.test', 'SEK', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        checkoutId,
        TENANT_A,
        columns.subtotal,
        columns.shipping ?? 0,
        columns.vat ?? 0,
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

  it("rejects a total that ignores shipping and vat", async () => {
    await expect(
      insertCheckout("ck-bad-total-parts", {
        shipping: 500,
        subtotal: 1_000,
        total: 1_000,
        vat: 250,
      }),
    ).rejects.toThrow();
  });

  it("accepts a total that honours every component", async () => {
    await expect(
      insertCheckout("ck-good-total", {
        discount: 200,
        shipping: 500,
        subtotal: 1_000,
        total: 1_550,
        vat: 250,
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
          subtotal_minor, total_minor, idempotency_key_hash,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, 'paid', 'x@example.test', 'SEK', 0, 0, ?, ?, ?, ?)`,
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
