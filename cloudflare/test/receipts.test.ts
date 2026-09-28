import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";

import worker from "../src/index";
import { STRIPE_API_VERSION } from "../src/commerce/stripe-client";
import {
  RECEIPT_TOKEN_TTL_MS,
  hashReceiptToken,
  maskEmail,
  parseReceiptBearer,
} from "../src/commerce/receipts";
import { ORDER_READ_IP_LIMIT } from "../src/routes/receipts";

/**
 * The guest receipt capability (PLAN §2.1): minted by the webhook with the
 * order, handed to the confirmation poll exactly once, and the only key to the
 * allowlisted buyer view of one order in one shop.
 *
 * Real clock throughout, for the reason webhook.test.ts gives: seeded rows sit
 * beside rows the live route writes.
 */
const TENANT_A = "tenant-receipt-a";
const TENANT_B = "tenant-receipt-b";
const HOST_A = "a.receipt.test";
const HOST_B = "b.receipt.test";
const DAY_MS = 24 * 60 * 60 * 1_000;

let counter = 0;
let ipCounter = 0;

function next(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString().padStart(4, "0")}`;
}

function nextIp(): string {
  ipCounter += 1;
  return `100.64.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

const signer = new Stripe("sk_test_signing_helper_only", {
  apiVersion: STRIPE_API_VERSION,
  httpClient: Stripe.createFetchHttpClient(),
});

async function seedTenant(tenantId: string, hostname: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
      ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, `Shop ${tenantId}`, now, now),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, now, now),
  ]);
}

interface PaidCheckout {
  checkoutId: string;
  email: string;
  paymentIntentId: string;
  tenantId: string;
  totalMinor: number;
}

/** An open checkout with two frozen lines and an intent, ready to be paid. */
async function seedCheckout(
  tenantId: string,
  options: { delivery?: "pickup" | "shipping" } = {},
): Promise<PaidCheckout> {
  const now = Date.now();
  const checkoutId = next("ck-receipt");
  const paymentIntentId = next("pi_receipt");
  const email = `buyer.${checkoutId}@example.test`;
  const pickup = options.delivery === "pickup";
  const shipping = pickup ? 0 : 4_900;
  const lines = [
    { name: "Tee with a print", price: 19_900, qty: 2 },
    { name: "Cap", price: 14_900, qty: 1 },
  ];
  const subtotal = lines.reduce((sum, line) => sum + line.price * line.qty, 0);
  const total = subtotal + shipping;

  const statements: D1PreparedStatement[] = [];
  const productIds: string[] = [];
  for (const [index, line] of lines.entries()) {
    const productId = next("prod-receipt");
    productIds.push(productId);
    statements.push(
      env.DB.prepare(
        `INSERT INTO products (
          product_id, tenant_id, status, sku, name, b2c_price_minor, currency,
          created_at, updated_at
        ) VALUES (?, ?, 'active', ?, ?, ?, 'SEK', ?, ?)`,
      ).bind(productId, tenantId, `SKU-RCPT-${counter}-${index}`, line.name, line.price, now, now),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO checkouts (
        checkout_id, tenant_id, status, customer_email, currency,
        delivery_method, shipping_country, subtotal_minor, shipping_minor,
        vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor,
        payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at
      ) VALUES (?, ?, 'open', ?, 'SEK', ?, ?, ?, ?, 0, 2500, 0, NULL, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      checkoutId,
      tenantId,
      email,
      pickup ? "pickup" : "shipping",
      pickup ? null : "SE",
      subtotal,
      shipping,
      total,
      paymentIntentId,
      `hash-${checkoutId}`,
      now + DAY_MS,
      now,
      now,
    ),
  );
  for (const [index, line] of lines.entries()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO checkout_items (
          checkout_item_id, checkout_id, tenant_id, item_index, product_id,
          variant_id, sku, name, quantity, unit_price_minor,
          line_total_minor, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `ci-${checkoutId}-${index}`,
        checkoutId,
        tenantId,
        index,
        productIds[index],
        `SKU-RCPT-LINE-${index}`,
        line.name,
        line.qty,
        line.price,
        line.price * line.qty,
        now,
        now,
      ),
    );
  }
  await env.DB.batch(statements);

  return { checkoutId, email, paymentIntentId, tenantId, totalMinor: total };
}

async function pay(checkout: PaidCheckout): Promise<void> {
  const payload = JSON.stringify({
    api_version: STRIPE_API_VERSION,
    created: Math.floor(Date.now() / 1_000),
    data: {
      object: {
        amount: checkout.totalMinor,
        currency: "sek",
        id: checkout.paymentIntentId,
        metadata: {
          checkout_id: checkout.checkoutId,
          tenant_id: checkout.tenantId,
        },
        object: "payment_intent",
        status: "succeeded",
      },
    },
    id: next("evt_receipt"),
    livemode: false,
    object: "event",
    type: "payment_intent.succeeded",
  });
  const signature = await signer.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });

  const response = await worker.fetch(
    new Request(`https://${HOST_A}/v1/webhooks/stripe`, {
      body: payload,
      headers: { "content-type": "application/json", "stripe-signature": signature },
      method: "POST",
    }),
    env,
  );
  expect(response.status).toBe(200);
}

function claim(host: string, checkoutId: string, method = "POST"): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://${host}/v1/checkout/${checkoutId}/receipt`, {
      headers: { "cf-connecting-ip": nextIp() },
      method,
    }),
  );
}

interface ReadyReceipt {
  orderId: string;
  receiptToken: string;
  status: "ready";
}

async function claimReady(checkout: PaidCheckout): Promise<ReadyReceipt> {
  const response = await claim(HOST_A, checkout.checkoutId);
  expect(response.status).toBe(200);
  const body = await response.json<{ receipt: ReadyReceipt }>();
  expect(body.receipt.status).toBe("ready");
  return body.receipt;
}

function readOrder(
  host: string,
  orderId: string,
  authorization: string | null,
  ip: string = nextIp(),
): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (authorization !== null) {
    headers.authorization = authorization;
  }
  return exports.default.fetch(
    new Request(`https://${host}/v1/orders/${orderId}`, { headers }),
  );
}

async function expectOpaque404(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    error: { code: "not_found", message: "Order not found" },
  });
}

beforeAll(async () => {
  await seedTenant(TENANT_A, HOST_A);
  await seedTenant(TENANT_B, HOST_B);
});

describe("minting with the order", () => {
  it("stores only the hash and a 30-day expiry on the order, in the webhook's batch", async () => {
    const checkout = await seedCheckout(TENANT_A);
    const before = Date.now();
    await pay(checkout);
    const after = Date.now();

    const order = await env.DB.prepare(
      `SELECT order_id, receipt_token_hash, receipt_token_expires_at
       FROM orders WHERE checkout_id = ?`,
    )
      .bind(checkout.checkoutId)
      .first<{
        order_id: string;
        receipt_token_expires_at: string;
        receipt_token_hash: string;
      }>();
    expect(order?.receipt_token_hash).toMatch(/^[0-9a-f]{64}$/);
    const expiresAt = Date.parse(order?.receipt_token_expires_at ?? "");
    expect(expiresAt).toBeGreaterThanOrEqual(before + RECEIPT_TOKEN_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + RECEIPT_TOKEN_TTL_MS);

    const handoff = await env.DB.prepare(
      `SELECT order_id, tenant_id, receipt_token FROM order_receipt_handoffs
       WHERE checkout_id = ?`,
    )
      .bind(checkout.checkoutId)
      .first<{ order_id: string; receipt_token: string; tenant_id: string }>();
    expect(handoff?.order_id).toBe(order?.order_id);
    expect(handoff?.tenant_id).toBe(TENANT_A);
    expect(handoff?.receipt_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(hashReceiptToken(handoff?.receipt_token ?? "")).resolves.toBe(
      order?.receipt_token_hash,
    );
  });

  it("mints a different token for every order", async () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const checkout = await seedCheckout(TENANT_A);
      await pay(checkout);
      tokens.add((await claimReady(checkout)).receiptToken);
    }
    expect(tokens.size).toBe(3);
  });
});

describe("the one-time hand-off", () => {
  it("answers pending before the payment lands, then ready once, then issued", async () => {
    const checkout = await seedCheckout(TENANT_A);

    const early = await claim(HOST_A, checkout.checkoutId);
    expect(early.status).toBe(200);
    expect(early.headers.get("cache-control")).toBe("no-store");
    await expect(early.json()).resolves.toEqual({ receipt: { status: "pending" } });

    await pay(checkout);

    const ready = await claimReady(checkout);
    expect(Object.keys(ready).sort()).toEqual(["orderId", "receiptToken", "status"]);

    const again = await claim(HOST_A, checkout.checkoutId);
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual({ receipt: { status: "issued" } });

    // The raw token no longer exists anywhere server-side.
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM order_receipt_handoffs WHERE checkout_id = ?",
    )
      .bind(checkout.checkoutId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("hands the token to exactly one of several concurrent polls", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => claim(HOST_A, checkout.checkoutId)),
    );
    const bodies = await Promise.all(
      responses.map((response) =>
        response.json<{ receipt: { status: string } }>(),
      ),
    );
    const statuses = bodies.map((body) => body.receipt.status).sort();
    expect(statuses).toEqual(["issued", "issued", "issued", "issued", "issued", "ready"]);
  });

  it("does not hand another shop's receipt to this shop's hostname, and does not consume it", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);

    await expectOpaque404(await claim(HOST_B, checkout.checkoutId));
    await expectOpaque404(await claim("unknown.receipt.test", checkout.checkoutId));

    // Still there for the right storefront.
    await claimReady(checkout);
  });

  it.each([
    ["an unknown checkout id", "ck-receipt-nowhere"],
    ["an encoded slash", "a%2Fb"],
  ])("answers the opaque 404 for %s", async (_label, checkoutId) => {
    await expectOpaque404(await claim(HOST_A, checkoutId));
  });

  it("answers the opaque 404 for a GET — a read must never consume the token", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);

    await expectOpaque404(await claim(HOST_A, checkout.checkoutId, "GET"));
    await claimReady(checkout);
  });

  it("sweeps an uncollected hand-off after its hour and reports it issued", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);

    // Re-create the row as if minted two hours ago (rows are write-once, so
    // the test replaces it rather than updating it).
    const row = await env.DB.prepare(
      "SELECT order_id, receipt_token FROM order_receipt_handoffs WHERE checkout_id = ?",
    )
      .bind(checkout.checkoutId)
      .first<{ order_id: string; receipt_token: string }>();
    const past = Date.now() - 2 * 60 * 60 * 1_000;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM order_receipt_handoffs WHERE checkout_id = ?").bind(
        checkout.checkoutId,
      ),
      env.DB.prepare(
        `INSERT INTO order_receipt_handoffs (
          checkout_id, tenant_id, order_id, receipt_token, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        checkout.checkoutId,
        TENANT_A,
        row?.order_id,
        row?.receipt_token,
        new Date(past + 60 * 60 * 1_000).toISOString(),
        new Date(past).toISOString(),
      ),
    ]);

    const response = await claim(HOST_A, checkout.checkoutId);
    await expect(response.json()).resolves.toEqual({ receipt: { status: "issued" } });
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM order_receipt_handoffs WHERE checkout_id = ?",
    )
      .bind(checkout.checkoutId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("reading an order with the receipt token", () => {
  it("answers the allowlisted buyer schema for the right shop and token", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);
    const { orderId, receiptToken } = await claimReady(checkout);

    const response = await readOrder(HOST_A, orderId, `Bearer ${receiptToken}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<{ order: Record<string, unknown> }>();

    expect(Object.keys(body)).toEqual(["order"]);
    expect(Object.keys(body.order).sort()).toEqual([
      "createdAt",
      "currency",
      "delivery",
      "email",
      "items",
      "orderId",
      "orderNumber",
      "recipient",
      "status",
      "totals",
      "withdrawal",
    ]);
    // D98: a checkout seeded without a recipient row (as before 0045) has none.
    expect(body.order.recipient).toBeNull();
    expect(body.order).toMatchObject({
      currency: "SEK",
      delivery: { country: "SE", method: "shipping" },
      email: `b***@example.test`,
      items: [
        { lineTotalMinor: 39_800, name: "Tee with a print", quantity: 2, unitPriceMinor: 19_900 },
        { lineTotalMinor: 14_900, name: "Cap", quantity: 1, unitPriceMinor: 14_900 },
      ],
      orderId,
      status: "paid",
      totals: {
        discountMinor: 0,
        shippingMinor: 4_900,
        subtotalMinor: 54_700,
        totalMinor: 59_600,
        vatMinor: 0,
      },
      // CP2-E: a checkout seeded before consent existed keeps the full right.
      withdrawal: { waived: false },
    });
    expect(body.order.orderNumber).toMatch(/^\d{8}-[0-9A-HJ-NP-TV-Z]{8}$/);
    expect(body.order.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    for (const item of body.order.items as Record<string, unknown>[]) {
      expect(Object.keys(item).sort()).toEqual([
        "lineTotalMinor",
        "name",
        "quantity",
        "unitPriceMinor",
      ]);
    }
  });

  it("never carries an internal key or identifier, at any depth", async () => {
    const checkout = await seedCheckout(TENANT_A, { delivery: "pickup" });
    await pay(checkout);
    const { orderId, receiptToken } = await claimReady(checkout);

    const response = await readOrder(HOST_A, orderId, `Bearer ${receiptToken}`);
    const text = await response.text();
    const body = JSON.parse(text) as unknown;

    const DENYLIST = [
      "cost",
      "printer",
      "connect",
      "snapshot",
      "production",
      "stripe",
      "application_fee",
      "applicationfee",
      "withhold",
    ];
    const seen: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          seen.push(key);
          walk(inner);
        }
      }
    };
    walk(body);

    expect(seen.length).toBeGreaterThan(10);
    for (const key of seen) {
      for (const denied of DENYLIST) {
        expect(key.toLowerCase(), key).not.toContain(denied);
      }
    }
    // Nor do internal identifiers or the raw buyer address leak as values.
    expect(text).not.toContain(checkout.paymentIntentId);
    expect(text).not.toContain(checkout.checkoutId);
    expect(text).not.toContain(checkout.email);
    expect(text).not.toContain(TENANT_A);
    expect(text).not.toContain("SKU-");
    expect(text).not.toContain("prod-receipt");
    expect(text).not.toContain(receiptToken);
    expect((body as { order: { delivery: unknown } }).order.delivery).toEqual({
      country: null,
      method: "pickup",
    });
  });

  it("answers the opaque 404 on another shop's hostname", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);
    const { orderId, receiptToken } = await claimReady(checkout);

    await expectOpaque404(await readOrder(HOST_B, orderId, `Bearer ${receiptToken}`));
    await expectOpaque404(
      await readOrder("unknown.receipt.test", orderId, `Bearer ${receiptToken}`),
    );
  });

  it("does not let one order's token open another order in the same shop", async () => {
    const first = await seedCheckout(TENANT_A);
    const second = await seedCheckout(TENANT_A);
    await pay(first);
    await pay(second);
    const one = await claimReady(first);
    const two = await claimReady(second);

    await expectOpaque404(await readOrder(HOST_A, two.orderId, `Bearer ${one.receiptToken}`));
    expect((await readOrder(HOST_A, two.orderId, `Bearer ${two.receiptToken}`)).status).toBe(200);
  });

  it("answers the opaque 404 once the token has expired", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);
    const { orderId, receiptToken } = await claimReady(checkout);

    await env.DB.prepare(
      "UPDATE orders SET receipt_token_expires_at = ? WHERE order_id = ?",
    )
      .bind(new Date(Date.now() - 1_000).toISOString(), orderId)
      .run();

    await expectOpaque404(await readOrder(HOST_A, orderId, `Bearer ${receiptToken}`));
  });

  it.each([
    ["no Authorization header", null],
    ["a wrong token", `Bearer ${"A".repeat(43)}`],
    ["a lowercase scheme", "bearer TOKEN"],
    ["a Basic credential", "Basic dXNlcjpwYXNz"],
    ["a truncated token", "Bearer abc"],
    ["a doubled space", "Bearer  TOKEN"],
  ])("answers the opaque 404 with %s", async (_label, authorization) => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);
    const { orderId, receiptToken } = await claimReady(checkout);

    await expectOpaque404(
      await readOrder(
        HOST_A,
        orderId,
        authorization?.replace("TOKEN", receiptToken) ?? null,
      ),
    );
  });

  it.each([
    ["a non-UUID order id", "not-a-uuid"],
    ["an unknown order id", "00000000-0000-4000-8000-000000000000"],
  ])("answers the opaque 404 for %s", async (_label, orderId) => {
    await expectOpaque404(await readOrder(HOST_A, orderId, `Bearer ${"B".repeat(43)}`));
  });

  it("answers the opaque 404 for a write method", async () => {
    const response = await exports.default.fetch(
      new Request(`https://${HOST_A}/v1/orders/00000000-0000-4000-8000-000000000000`, {
        method: "DELETE",
      }),
    );
    await expectOpaque404(response);
  });

  it("limits reads per IP, counting tokenless probes too", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);
    const { orderId, receiptToken } = await claimReady(checkout);
    const ip = nextIp();

    for (let attempt = 0; attempt < ORDER_READ_IP_LIMIT - 1; attempt += 1) {
      await expectOpaque404(await readOrder(HOST_A, orderId, null, ip));
    }
    expect((await readOrder(HOST_A, orderId, `Bearer ${receiptToken}`, ip)).status).toBe(200);

    const limited = await readOrder(HOST_A, orderId, `Bearer ${receiptToken}`, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(ORDER_READ_IP_LIMIT).toBe(30);

    // Another address is unaffected.
    expect((await readOrder(HOST_A, orderId, `Bearer ${receiptToken}`)).status).toBe(200);
  });
});

describe("receipt helpers and schema", () => {
  it("masks an address down to its first character and domain", () => {
    expect(maskEmail("jane.doe@example.test")).toBe("j***@example.test");
    expect(maskEmail("x@y.test")).toBe("x***@y.test");
    expect(maskEmail("broken")).toBe("***");
  });

  it("parses only a well-formed bearer credential", () => {
    const token = "a".repeat(43);
    expect(parseReceiptBearer(`Bearer ${token}`)).toBe(token);
    expect(parseReceiptBearer(null)).toBeNull();
    expect(parseReceiptBearer(`Bearer ${token}=`)).toBeNull();
    expect(parseReceiptBearer(`Bearer ${"a".repeat(44)}`)).toBeNull();
  });

  it("refuses an order row with a hash but no expiry", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);
    await expect(
      env.DB.prepare(
        "UPDATE orders SET receipt_token_expires_at = NULL WHERE checkout_id = ?",
      )
        .bind(checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/set together/);
  });

  it("refuses rewriting a hand-off in place", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);
    await expect(
      env.DB.prepare(
        "UPDATE order_receipt_handoffs SET receipt_token = ? WHERE checkout_id = ?",
      )
        .bind("b".repeat(43), checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/write-once/);
  });

  it("refuses a hand-off filed under another tenant", async () => {
    const checkout = await seedCheckout(TENANT_A);
    await pay(checkout);
    const row = await env.DB.prepare(
      "SELECT order_id FROM orders WHERE checkout_id = ?",
    )
      .bind(checkout.checkoutId)
      .first<{ order_id: string }>();
    await env.DB.prepare("DELETE FROM order_receipt_handoffs WHERE checkout_id = ?")
      .bind(checkout.checkoutId)
      .run();

    const now = Date.now();
    await expect(
      env.DB.prepare(
        `INSERT INTO order_receipt_handoffs (
          checkout_id, tenant_id, order_id, receipt_token, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          checkout.checkoutId,
          TENANT_B,
          row?.order_id,
          "c".repeat(43),
          new Date(now + 60_000).toISOString(),
          new Date(now).toISOString(),
        )
        .run(),
    ).rejects.toThrow(/must match its order/);
  });
});
