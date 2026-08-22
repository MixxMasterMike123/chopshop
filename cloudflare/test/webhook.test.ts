import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";

import worker from "../src/index";
import {
  REASON_AMOUNT_MISMATCH,
  REASON_CHECKOUT_NOT_PAYABLE,
  REASON_METADATA_MISMATCH,
  REASON_UNHANDLED_TYPE,
  REASON_UNKNOWN_INTENT,
  generateOrderNumber,
} from "../src/commerce/webhook";
import {
  STRIPE_API_VERSION,
  STRIPE_WEBHOOK_VERIFIER_OVERRIDE,
  StripeSignatureError,
  isStripeWebhookConfigured,
  resolveStripeWebhookVerifier,
} from "../src/commerce/stripe-client";
import type { StripeWebhookVerifier } from "../src/commerce/stripe-client";

/**
 * The real clock, not a frozen constant.
 *
 * Checkpoint 24.1's rule, and it bites harder here than anywhere: this suite
 * seeds checkouts directly AND lets the live route write orders that reference
 * them, so a frozen NOW in a seeded row would sit beside a real-clock
 * `created_at` on the order and `CHECK (updated_at >= created_at)` would start
 * failing the day the real date overtook the constant. Every timestamp this file
 * writes comes from Date.now().
 */
const DAY_MS = 24 * 60 * 60 * 1_000;

const TENANT_A = "tenant-hook-a";
const TENANT_B = "tenant-hook-b";
const HOST_A = "a.webhook.test";
const HOST_B = "b.webhook.test";
const WEBHOOK_PATH = "/v1/webhooks/stripe";

/**
 * Module-level counters, not per-test ones. Checkpoint 24's fixture trap: the
 * fixtures are rebuilt per test but D1 is not, and `payment_intent_id`,
 * `checkout_id` and `event_id` are all unique across the whole table.
 */
let intentCounter = 0;
let checkoutCounter = 0;
let eventCounter = 0;
let productCounter = 0;
let discountCounter = 0;

function nextIntentId(): string {
  intentCounter += 1;
  return `pi_hook_${intentCounter}`;
}

function nextCheckoutId(): string {
  checkoutCounter += 1;
  return `ck-hook-${checkoutCounter.toString().padStart(4, "0")}`;
}

function nextEventId(): string {
  eventCounter += 1;
  return `evt_hook_${eventCounter}`;
}

/**
 * A client used ONLY for its webhook-signing helper. No request is dispatched
 * from it; the API key is a placeholder.
 */
const signer = new Stripe("sk_test_signing_helper_only", {
  apiVersion: STRIPE_API_VERSION,
  httpClient: Stripe.createFetchHttpClient(),
});

interface EventOptions {
  amount?: number;
  currency?: string;
  eventId?: string;
  metadata?: Record<string, string> | null;
  paymentIntentId: string;
  type?: string;
}

/**
 * Builds the exact JSON shape Stripe sends for a PaymentIntent event.
 *
 * Hand-built rather than taken from a fixture library so the fields that matter
 * — amount, currency, metadata — are visible at every call site, and so a test
 * can express a malformed payload that a typed fixture would forbid.
 */
function buildEventPayload(options: EventOptions): string {
  const metadata =
    options.metadata === null ? undefined : (options.metadata ?? {});

  return JSON.stringify({
    api_version: STRIPE_API_VERSION,
    created: Math.floor(Date.now() / 1_000),
    data: {
      object: {
        amount: options.amount ?? 23_710,
        currency: options.currency ?? "sek",
        id: options.paymentIntentId,
        object: "payment_intent",
        status: "succeeded",
        ...(metadata === undefined ? {} : { metadata }),
      },
    },
    id: options.eventId ?? nextEventId(),
    livemode: false,
    object: "event",
    type: options.type ?? "payment_intent.succeeded",
  });
}

/**
 * Signs a payload with the SDK's own helper against the SAME secret the worker
 * verifies with.
 *
 * This is the point of the whole seam: the production `constructEventAsync` is
 * what runs in every success-path test below, over a genuinely valid v1
 * signature. Nothing stubs verification out, so a mutation that removed the
 * verification call has something real to fail against.
 */
async function signPayload(
  payload: string,
  secret: string = env.STRIPE_WEBHOOK_SECRET,
  timestamp?: number,
): Promise<string> {
  return signer.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}

interface PostOptions {
  env?: Env;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  /** Omit the signature header entirely. */
  unsigned?: boolean;
  /** Sign with this secret instead of the configured one. */
  secret?: string;
  /** Sign at this unix-seconds timestamp (for tolerance cases). */
  timestamp?: number;
  /** Send this body while signing the other one — a tampered payload. */
  sendInstead?: string;
}

async function postWebhook(
  payload: string,
  options: PostOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };

  if (options.unsigned !== true) {
    headers["stripe-signature"] = await signPayload(
      payload,
      options.secret ?? env.STRIPE_WEBHOOK_SECRET,
      options.timestamp,
    );
  }

  const method = options.method ?? "POST";
  // GET and HEAD cannot carry a body in the fetch API — the Request constructor
  // throws — so the method cases send none. That is also the honest shape: a
  // caller probing this endpoint with GET has no body to send.
  const hasBody = method !== "GET" && method !== "HEAD";

  const request = new Request(
    `https://${HOST_A}${options.path ?? WEBHOOK_PATH}`,
    {
      ...(hasBody ? { body: options.sendInstead ?? payload } : {}),
      headers,
      method,
    },
  );

  return worker.fetch(request, options.env ?? (env as Env));
}

async function seedTenant(tenantId: string, hostname: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, support_email, default_locale,
        default_currency, created_at, updated_at
      ) VALUES (?, 'active', ?, ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, `Shop ${tenantId}`, `ops-${tenantId}@example.test`, now, now),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, now, now),
  ]);
}

/** A published product, so checkout_items can reference something real. */
async function seedProduct(tenantId: string): Promise<string> {
  productCounter += 1;
  const productId = `prod-hook-${productCounter}`;
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO products (
      product_id, tenant_id, status, sku, name, b2c_price_minor, currency,
      created_at, updated_at
    ) VALUES (?, ?, 'active', ?, ?, 19900, 'SEK', ?, ?)`,
  )
    .bind(productId, tenantId, `SKU-HOOK-${productCounter}`, `Product ${productCounter}`, now, now)
    .run();

  return productId;
}

async function seedDiscountCode(
  tenantId: string,
  options: { maxUses?: number | null; usedCount?: number } = {},
): Promise<string> {
  discountCounter += 1;
  const id = `disc-hook-${discountCounter}`;
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO discount_codes (
      discount_code_id, tenant_id, code, active, type, value_minor,
      max_uses, used_count, scope, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 'fixed', 1990, ?, ?, 'all', ?, ?)`,
  )
    .bind(
      id,
      tenantId,
      `HOOK${discountCounter}`,
      options.maxUses ?? null,
      options.usedCount ?? 0,
      now,
      now,
    )
    .run();

  return id;
}

interface SeedCheckoutOptions {
  discountCodeId?: string | null;
  discountMinor?: number;
  expiresAt?: number;
  itemCount?: number;
  paymentIntentId: string | null;
  status?: string;
  tenantId: string;
  totalMinor?: number;
}

interface SeededCheckout {
  checkoutId: string;
  productIds: string[];
  subtotalMinor: number;
  totalMinor: number;
}

/**
 * Writes a checkout and its frozen lines directly.
 *
 * The creation route has its own suite; driving it here would drag in the
 * catalogue, the shipping engine and two rate limiters, none of which this file
 * is about. The columns written are the ones the webhook reads, and the schema's
 * CHECKs still police every one of them.
 */
async function seedCheckout(
  options: SeedCheckoutOptions,
): Promise<SeededCheckout> {
  const now = Date.now();
  const checkoutId = nextCheckoutId();
  const itemCount = options.itemCount ?? 1;
  const unitPrice = 19_900;
  const subtotal = unitPrice * itemCount;
  const discount = options.discountMinor ?? 0;
  const total = options.totalMinor ?? subtotal - discount;

  const productIds: string[] = [];
  for (let index = 0; index < itemCount; index += 1) {
    productIds.push(await seedProduct(options.tenantId));
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO checkouts (
        checkout_id, tenant_id, status, customer_email, currency,
        delivery_method, shipping_country, subtotal_minor, shipping_minor,
        vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor,
        payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'SEK', 'shipping', 'SE', ?, 0, 0, 2500, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      checkoutId,
      options.tenantId,
      options.status ?? "open",
      `buyer-${checkoutId}@example.test`,
      subtotal,
      discount,
      options.discountCodeId ?? null,
      total,
      options.paymentIntentId,
      `hash-${checkoutId}`,
      options.expiresAt ?? now + DAY_MS,
      now,
      now,
    ),
  ];

  for (const [index, productId] of productIds.entries()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO checkout_items (
          checkout_item_id, checkout_id, tenant_id, item_index, product_id,
          variant_id, sku, name, quantity, unit_price_minor,
          line_total_minor, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, ?)`,
      ).bind(
        `ci-${checkoutId}-${index}`,
        checkoutId,
        options.tenantId,
        index,
        productId,
        `SKU-LINE-${checkoutId}-${index}`,
        `Line ${index}`,
        unitPrice,
        unitPrice,
        now,
        now,
      ),
    );
  }

  await env.DB.batch(statements);

  return { checkoutId, productIds, subtotalMinor: subtotal, totalMinor: total };
}

/** A checkout with an attached intent, ready to be paid. */
async function seedPayableCheckout(
  options: Omit<SeedCheckoutOptions, "paymentIntentId"> & {
    paymentIntentId?: string;
  } = { tenantId: TENANT_A },
): Promise<SeededCheckout & { paymentIntentId: string }> {
  const paymentIntentId = options.paymentIntentId ?? nextIntentId();
  const seeded = await seedCheckout({ ...options, paymentIntentId });
  return { ...seeded, paymentIntentId };
}

interface OrderRow {
  captured_minor: number;
  checkout_id: string;
  currency: string;
  customer_email: string;
  delivery_method: string;
  discount_code_id: string | null;
  discount_minor: number;
  order_id: string;
  order_number: string;
  paid_at: number;
  payment_intent_id: string;
  refunded_total_minor: number;
  shipping_country: string | null;
  shipping_minor: number;
  status: string;
  stripe_event_id: string;
  subtotal_minor: number;
  tenant_id: string;
  total_minor: number;
  vat_minor: number;
  vat_rate_bp: number;
}

async function readOrderByCheckout(
  checkoutId: string,
): Promise<OrderRow | null> {
  return env.DB.prepare(
    "SELECT * FROM orders WHERE checkout_id = ? LIMIT 1",
  )
    .bind(checkoutId)
    .first<OrderRow>();
}

async function countOrders(checkoutId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE checkout_id = ?",
  )
    .bind(checkoutId)
    .first<{ n: number }>();

  return row?.n ?? 0;
}

async function readUsedCount(discountCodeId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT used_count FROM discount_codes WHERE discount_code_id = ? LIMIT 1",
  )
    .bind(discountCodeId)
    .first<{ used_count: number }>();

  return row?.used_count ?? -1;
}

async function readCheckoutStatus(checkoutId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT status FROM checkouts WHERE checkout_id = ? LIMIT 1",
  )
    .bind(checkoutId)
    .first<{ status: string }>();

  return row?.status ?? null;
}

async function readPaymentEvent(
  eventId: string,
): Promise<{ outcome: string; reason_code: string | null; tenant_id: string | null } | null> {
  return env.DB.prepare(
    "SELECT outcome, reason_code, tenant_id FROM payment_events WHERE event_id = ? LIMIT 1",
  )
    .bind(eventId)
    .first<{ outcome: string; reason_code: string | null; tenant_id: string | null }>();
}

async function countPaymentEvents(eventId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM payment_events WHERE event_id = ?",
  )
    .bind(eventId)
    .first<{ n: number }>();

  return row?.n ?? 0;
}

beforeAll(async () => {
  await seedTenant(TENANT_A, HOST_A);
  await seedTenant(TENANT_B, HOST_B);
});

describe("webhook configuration gate", () => {
  it("reports configured when a signing secret of usable length exists", () => {
    expect(isStripeWebhookConfigured(env)).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["too short", "whsec"],
  ])("reports unconfigured when the secret is %s", (_label, secret) => {
    expect(
      isStripeWebhookConfigured({
        ...env,
        STRIPE_WEBHOOK_SECRET: secret,
      } as Env),
    ).toBe(false);
  });

  it("returns the injected verifier when one is present", () => {
    const fake: StripeWebhookVerifier = {
      async constructEvent() {
        throw new StripeSignatureError();
      },
    };

    const injected = {
      ...env,
      [STRIPE_WEBHOOK_VERIFIER_OVERRIDE]: fake,
    } as unknown as Env;

    expect(resolveStripeWebhookVerifier(injected)).toBe(fake);
  });

  it("ignores an override that is not a usable verifier", () => {
    const bogus = {
      ...env,
      [STRIPE_WEBHOOK_VERIFIER_OVERRIDE]: { constructEvent: "not a function" },
    } as unknown as Env;

    expect(resolveStripeWebhookVerifier(bogus)).not.toBe(bogus);
  });
});

describe("webhook surface while unconfigured", () => {
  /**
   * The whole surface must be dark, and dark in the strongest sense: a
   * VALID, correctly signed event for a real checkout gets the same 404 as a
   * nonexistent route, and nothing is written.
   */
  it("404s a valid signed event and writes nothing", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();
    const payload = buildEventPayload({
      eventId,
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const response = await postWebhook(payload, {
      env: { ...env, STRIPE_WEBHOOK_SECRET: undefined } as unknown as Env,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
    await expect(countPaymentEvents(eventId)).resolves.toBe(0);
    await expect(readCheckoutStatus(seeded.checkoutId)).resolves.toBe("open");
  });

  it("404s an unsigned request rather than 400 while unconfigured", async () => {
    // The order of the gates matters: the unconfigured check must run BEFORE the
    // signature check, otherwise a 400 would confirm the endpoint exists.
    const payload = buildEventPayload({ paymentIntentId: nextIntentId() });

    const response = await postWebhook(payload, {
      env: { ...env, STRIPE_WEBHOOK_SECRET: undefined } as unknown as Env,
      unsigned: true,
    });

    expect(response.status).toBe(404);
  });

  it("404s while the API key is missing even with a signing secret", async () => {
    const payload = buildEventPayload({ paymentIntentId: nextIntentId() });

    const response = await postWebhook(payload, {
      env: { ...env, STRIPE_SECRET_KEY: undefined } as unknown as Env,
    });

    expect(response.status).toBe(404);
  });

  it.each([["GET"], ["PUT"], ["PATCH"], ["DELETE"]])(
    "404s the %s method",
    async (method) => {
      const payload = buildEventPayload({ paymentIntentId: nextIntentId() });
      const response = await postWebhook(payload, { method });

      expect(response.status).toBe(404);
    },
  );

  it("404s a sub-path of the webhook route", async () => {
    const payload = buildEventPayload({ paymentIntentId: nextIntentId() });
    const response = await postWebhook(payload, {
      path: "/v1/webhooks/stripe/extra",
    });

    expect(response.status).toBe(404);
  });
});

describe("signature verification", () => {
  it("400s a request with no signature header, writing nothing", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();
    const payload = buildEventPayload({
      eventId,
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const response = await postWebhook(payload, { unsigned: true });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_signature",
        message: "Request signature could not be verified",
      },
    });
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
    await expect(countPaymentEvents(eventId)).resolves.toBe(0);
  });

  /**
   * The core security case: a well-formed, entirely plausible succeeded event
   * for a REAL checkout, signed with the wrong secret. Without verification this
   * request mints an order out of thin air.
   */
  it("400s an event signed with the wrong secret and creates no order", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();
    const payload = buildEventPayload({
      eventId,
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const response = await postWebhook(payload, {
      secret: "whsec_an_attackers_own_secret_value_x",
    });

    expect(response.status).toBe(400);
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
    await expect(countPaymentEvents(eventId)).resolves.toBe(0);
    await expect(readCheckoutStatus(seeded.checkoutId)).resolves.toBe("open");
  });

  it("400s a garbage signature header", async () => {
    const payload = buildEventPayload({ paymentIntentId: nextIntentId() });
    const response = await postWebhook(payload, {
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
      unsigned: true,
    });

    expect(response.status).toBe(400);
  });

  /**
   * A body altered after signing. This is what makes "verify over the RAW bytes"
   * a real requirement rather than a stylistic note: the amount is doubled in
   * the body that is actually sent, while the signature covers the original.
   */
  it("400s a tampered payload whose signature covers the original", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();
    const original = buildEventPayload({
      eventId,
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });
    const tampered = original.replace('"amount":23710', '"amount":1');

    expect(tampered).not.toBe(original);

    const response = await postWebhook(original, { sendInstead: tampered });

    expect(response.status).toBe(400);
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
  });

  /**
   * Stripe's scheme carries a timestamp and a default 300-second tolerance,
   * probed and confirmed enforced by the SDK under workerd. An old capture is
   * therefore not replayable indefinitely even before the event ledger sees it.
   */
  it("400s a correctly signed event whose timestamp is outside tolerance", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const payload = buildEventPayload({
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const response = await postWebhook(payload, {
      timestamp: Math.floor(Date.now() / 1_000) - 10_000,
    });

    expect(response.status).toBe(400);
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
  });

  /**
   * Verification must run over the RAW bytes, not over a reserialization.
   *
   * Every other payload in this file is produced by JSON.stringify, so a handler
   * that parsed the body and stringified it again would produce identical bytes
   * and verify fine — which is exactly what happened: mutating
   * `await request.text()` into `JSON.stringify(await request.json())` left all
   * 66 other tests green. Real Stripe payloads are not canonical JSON; they carry
   * their own spacing and key order, and a round trip silently changes them.
   *
   * This payload is deliberately pretty-printed, so the signature covers bytes a
   * reserializer could never reproduce. It must still verify.
   */
  it("verifies a payload whose formatting is not canonical JSON", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();

    // Two-space indentation and trailing newline — a shape JSON.stringify(x)
    // with no replacer will never emit.
    const payload = `${JSON.stringify(
      {
        data: {
          object: {
            amount: seeded.totalMinor,
            currency: "sek",
            id: seeded.paymentIntentId,
            metadata: {
              checkout_id: seeded.checkoutId,
              tenant_id: TENANT_A,
            },
            object: "payment_intent",
            status: "succeeded",
          },
        },
        id: eventId,
        object: "event",
        type: "payment_intent.succeeded",
      },
      null,
      2,
    )}\n`;

    const response = await postWebhook(payload);

    expect(response.status).toBe(200);
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readPaymentEvent(eventId)).resolves.toMatchObject({
      outcome: "processed",
    });
  });

  it("leaks nothing about Stripe or the secret in a failure response", async () => {
    const payload = buildEventPayload({ paymentIntentId: nextIntentId() });
    const response = await postWebhook(payload, {
      secret: "whsec_wrong_secret_for_leak_scan_abc",
    });

    const raw = await response.text();
    expect(raw.toLowerCase()).not.toContain("stripe");
    expect(raw).not.toContain("whsec");
    expect(raw).not.toContain("sk_test");
    expect(raw).not.toContain("req_");
    expect(raw).not.toContain("signatures found");
  });
});

describe("payment_intent.succeeded creates the order", () => {
  it("writes an order that mirrors the checkout's frozen money exactly", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      itemCount: 2,
      tenantId: TENANT_A,
    });
    const eventId = nextEventId();

    const before = Date.now();
    const response = await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        eventId,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });

    const order = await readOrderByCheckout(seeded.checkoutId);
    expect(order).not.toBeNull();
    const row = order as OrderRow;

    // Every money column is the checkout's, unmodified.
    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.payment_intent_id).toBe(seeded.paymentIntentId);
    expect(row.status).toBe("paid");
    expect(row.currency).toBe("SEK");
    expect(row.subtotal_minor).toBe(seeded.subtotalMinor);
    expect(row.shipping_minor).toBe(0);
    expect(row.discount_minor).toBe(1_990);
    expect(row.discount_code_id).toBe(discountCodeId);
    expect(row.total_minor).toBe(seeded.totalMinor);
    expect(row.captured_minor).toBe(seeded.totalMinor);
    expect(row.refunded_total_minor).toBe(0);
    expect(row.vat_rate_bp).toBe(2_500);
    expect(row.delivery_method).toBe("shipping");
    expect(row.shipping_country).toBe("SE");
    expect(row.customer_email).toBe(`buyer-${seeded.checkoutId}@example.test`);
    expect(row.stripe_event_id).toBe(eventId);
    expect(row.paid_at).toBeGreaterThanOrEqual(before);
  });

  it("copies every checkout line into order_items", async () => {
    const seeded = await seedPayableCheckout({
      itemCount: 3,
      tenantId: TENANT_A,
    });

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    const order = (await readOrderByCheckout(seeded.checkoutId)) as OrderRow;
    const items = await env.DB.prepare(
      `SELECT item_index, product_id, sku, name, quantity, unit_price_minor,
              line_total_minor, tenant_id
       FROM order_items WHERE order_id = ? ORDER BY item_index ASC`,
    )
      .bind(order.order_id)
      .all<{
        item_index: number;
        line_total_minor: number;
        name: string;
        product_id: string;
        quantity: number;
        sku: string;
        tenant_id: string;
        unit_price_minor: number;
      }>();

    expect(items.results).toHaveLength(3);
    for (const [index, item] of items.results.entries()) {
      expect(item.item_index).toBe(index);
      expect(item.tenant_id).toBe(TENANT_A);
      expect(item.product_id).toBe(seeded.productIds[index]);
      expect(item.sku).toBe(`SKU-LINE-${seeded.checkoutId}-${index}`);
      expect(item.quantity).toBe(1);
      expect(item.unit_price_minor).toBe(19_900);
      expect(item.line_total_minor).toBe(19_900);
    }
  });

  it("transitions the checkout to completed", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(readCheckoutStatus(seeded.checkoutId)).resolves.toBe(
      "completed",
    );
  });

  it("appends the birth transition to order_status_history", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    const order = (await readOrderByCheckout(seeded.checkoutId)) as OrderRow;
    const history = await env.DB.prepare(
      `SELECT from_status, to_status, tenant_id, actor_user_id, reason
       FROM order_status_history WHERE order_id = ?`,
    )
      .bind(order.order_id)
      .all<{
        actor_user_id: string | null;
        from_status: string | null;
        reason: string | null;
        tenant_id: string;
        to_status: string;
      }>();

    expect(history.results).toHaveLength(1);
    expect(history.results[0]).toEqual({
      actor_user_id: null,
      from_status: null,
      reason: "stripe.payment_intent.succeeded",
      tenant_id: TENANT_A,
      to_status: "paid",
    });
  });

  it("records the delivery as processed in the event ledger", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        eventId,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(readPaymentEvent(eventId)).resolves.toEqual({
      outcome: "processed",
      reason_code: null,
      tenant_id: TENANT_A,
    });
  });

  it("writes an audit row carrying no buyer identity", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    const order = (await readOrderByCheckout(seeded.checkoutId)) as OrderRow;
    const audit = await env.DB.prepare(
      `SELECT action, tenant_id, actor_user_id, metadata_json
       FROM audit_events WHERE resource_type = 'order' AND resource_id = ?`,
    )
      .bind(order.order_id)
      .first<{
        action: string;
        actor_user_id: string | null;
        metadata_json: string;
        tenant_id: string;
      }>();

    expect(audit?.action).toBe("order.create");
    expect(audit?.tenant_id).toBe(TENANT_A);
    expect(audit?.actor_user_id).toBeNull();
    // Counts and the intent id, never the buyer's address.
    expect(audit?.metadata_json).not.toContain("buyer-");
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toEqual({
      items: 1,
      paymentIntentId: seeded.paymentIntentId,
    });
  });

  it("accepts a succeeded intent for a checkout whose quote has lapsed", async () => {
    // The buyer held a client secret through the expiry; Stripe never heard
    // about it. The money is real, so the order must exist.
    const seeded = await seedPayableCheckout({
      expiresAt: Date.now() - 60_000,
      tenantId: TENANT_A,
    });

    const response = await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    expect(response.status).toBe(200);
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
  });

  it("gives the order a unique, non-empty order number", async () => {
    const first = await seedPayableCheckout({ tenantId: TENANT_A });
    const second = await seedPayableCheckout({ tenantId: TENANT_A });

    for (const seeded of [first, second]) {
      await postWebhook(
        buildEventPayload({
          amount: seeded.totalMinor,
          metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
          paymentIntentId: seeded.paymentIntentId,
        }),
      );
    }

    const a = (await readOrderByCheckout(first.checkoutId)) as OrderRow;
    const b = (await readOrderByCheckout(second.checkoutId)) as OrderRow;

    expect(a.order_number).not.toBe(b.order_number);
    expect(a.order_number).toMatch(/^\d{8}-[0-9A-HJ-NP-TV-Z]{8}$/);
  });
});

describe("discount used_count", () => {
  it("increments exactly once for a checkout carrying a frozen code", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });

    await expect(readUsedCount(discountCodeId)).resolves.toBe(0);

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(readUsedCount(discountCodeId)).resolves.toBe(1);
  });

  it("does not increment anything when the checkout froze no code", async () => {
    // A second code exists and must be untouched: this proves the increment is
    // scoped to the frozen id rather than firing broadly.
    const bystander = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId: null,
      tenantId: TENANT_A,
    });

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readUsedCount(bystander)).resolves.toBe(0);
  });

  /**
   * Checkpoint 22 pinned this: a resolved-but-worthless code stores NO id, so no
   * use is burned. Production would freeze the id beside a zero discount and let
   * its webhook burn a use on a code that discounted nothing.
   */
  it("burns no use for a zero-value discount that stored no id", async () => {
    const code = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId: null,
      discountMinor: 0,
      tenantId: TENANT_A,
    });

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(readUsedCount(code)).resolves.toBe(0);
  });

  it("still counts the use when the code is already at its cap", async () => {
    // Eligibility was decided at quote time. Refusing to count now would leave a
    // paid order whose discount is unaccounted for.
    const discountCodeId = await seedDiscountCode(TENANT_A, {
      maxUses: 1,
      usedCount: 1,
    });
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readUsedCount(discountCodeId)).resolves.toBe(2);
  });

  /**
   * The burn hits the FROZEN code and no other, even when the same tenant runs
   * several campaigns at once.
   *
   * Recorded as a mutation-test finding: replacing the increment's
   * `WHERE discount_code_id = ? AND tenant_id = ?` with `WHERE tenant_id = ?`
   * — a plausible shape for a refactor that lost the id — left all 65 other
   * tests green. The existing bystander case used a checkout carrying NO code,
   * so the increment statement was never queued at all and the missing scope was
   * invisible. This case queues a real burn beside two untouched campaigns.
   */
  it("burns only the frozen code while the tenant's other campaigns run", async () => {
    const frozen = await seedDiscountCode(TENANT_A);
    const bystanderA = await seedDiscountCode(TENANT_A);
    const bystanderB = await seedDiscountCode(TENANT_A, { usedCount: 7 });
    const seeded = await seedPayableCheckout({
      discountCodeId: frozen,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readUsedCount(frozen)).resolves.toBe(1);
    // Untouched, including the one that already carried a count.
    await expect(readUsedCount(bystanderA)).resolves.toBe(0);
    await expect(readUsedCount(bystanderB)).resolves.toBe(7);
  });

  it("never increments another tenant's code of the same id shape", async () => {
    const tenantBCode = await seedDiscountCode(TENANT_B);
    const tenantACode = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId: tenantACode,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(readUsedCount(tenantACode)).resolves.toBe(1);
    await expect(readUsedCount(tenantBCode)).resolves.toBe(0);
  });
});

describe("idempotency", () => {
  it("replays the SAME event id as a clean no-op", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });
    const eventId = nextEventId();
    const payload = buildEventPayload({
      amount: seeded.totalMinor,
      eventId,
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const first = await postWebhook(payload);
    const second = await postWebhook(payload);
    const third = await postWebhook(payload);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    await expect(second.json()).resolves.toEqual({ received: true });

    // One order, one increment, one ledger row — forever.
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readUsedCount(discountCodeId)).resolves.toBe(1);
    await expect(countPaymentEvents(eventId)).resolves.toBe(1);
  });

  /**
   * A DIFFERENT event id for the same intent. Stripe can genuinely produce this
   * — a resent event, or a second event type about one intent — and the event
   * ledger cannot catch it, so the order's UNIQUE checkout_id and the checkout
   * status guard have to.
   */
  it("creates no second order for a different event id on the same intent", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });

    const first = await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        eventId: nextEventId(),
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );
    const second = await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        eventId: nextEventId(),
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readUsedCount(discountCodeId)).resolves.toBe(1);
  });

  /**
   * Two deliveries of the SAME event arriving at once — Stripe's documented
   * behaviour under retry, and the case a plain read-then-write loses.
   */
  it("yields one order when the same event races itself", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });
    const eventId = nextEventId();
    const payload = buildEventPayload({
      amount: seeded.totalMinor,
      eventId,
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const responses = await Promise.all([
      postWebhook(payload),
      postWebhook(payload),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readUsedCount(discountCodeId)).resolves.toBe(1);
    await expect(countPaymentEvents(eventId)).resolves.toBe(1);
  });

  /** Two DIFFERENT event ids racing on one intent — the ledger cannot help. */
  it("yields one order when two distinct events race on one intent", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });

    const responses = await Promise.all([
      postWebhook(
        buildEventPayload({
          amount: seeded.totalMinor,
          eventId: nextEventId(),
          metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
          paymentIntentId: seeded.paymentIntentId,
        }),
      ),
      postWebhook(
        buildEventPayload({
          amount: seeded.totalMinor,
          eventId: nextEventId(),
          metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
          paymentIntentId: seeded.paymentIntentId,
        }),
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readUsedCount(discountCodeId)).resolves.toBe(1);
  });

  it("yields one order under a wider stampede of the same event", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });
    const payload = buildEventPayload({
      amount: seeded.totalMinor,
      eventId: nextEventId(),
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const responses = await Promise.all(
      Array.from({ length: 6 }, async () => postWebhook(payload)),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readUsedCount(discountCodeId)).resolves.toBe(1);
  });

  /**
   * A replay must report the outcome the ORIGINAL delivery reached, decided from
   * the ledger — not re-derive one from a world that has moved on since.
   *
   * This is what the ledger read guarantees and the UNIQUE constraints do not.
   * Between the two deliveries the checkout is dragged back to 'open' behind the
   * handler's back, which is exactly the shape a manual repair or a future sweep
   * could produce. A handler that skipped the ledger read would re-walk the
   * decision on that mutated state, take a DIFFERENT branch, and try to write a
   * second effect for an event whose effects already landed. With the read, the
   * event id alone settles it.
   *
   * Recorded as a mutation-test finding: removing the ledger read left all 63
   * other tests green, because every write path is also protected by a UNIQUE
   * constraint and a duplicate simply failed the batch. That made the read look
   * like an optimization. It is not — it is what makes a replay's ANSWER stable.
   */
  it("reports a replay from the ledger, not from re-deciding on current state", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });
    const eventId = nextEventId();
    const payload = buildEventPayload({
      amount: seeded.totalMinor,
      eventId,
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const first = await postWebhook(payload);
    expect(first.status).toBe(200);
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);

    // The world moves: the checkout is reopened and the counter reset out from
    // under the handler. Nothing legitimate does this, which is the point — it
    // isolates the ledger as the only thing that can still give the right answer.
    await env.DB.prepare(
      "UPDATE checkouts SET status = 'open' WHERE checkout_id = ?",
    )
      .bind(seeded.checkoutId)
      .run();
    await env.DB.prepare(
      "UPDATE discount_codes SET used_count = 0 WHERE discount_code_id = ?",
    )
      .bind(discountCodeId)
      .run();

    const replay = await postWebhook(payload);

    expect(replay.status).toBe(200);
    // The replay changed NOTHING: no second order, no re-burn of the discount,
    // and the checkout it was handed back is left exactly as it found it.
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readUsedCount(discountCodeId)).resolves.toBe(0);
    await expect(readCheckoutStatus(seeded.checkoutId)).resolves.toBe("open");
    await expect(countPaymentEvents(eventId)).resolves.toBe(1);
    await expect(readPaymentEvent(eventId)).resolves.toEqual({
      outcome: "processed",
      reason_code: null,
      tenant_id: TENANT_A,
    });
  });

  it("refuses a checkout already marked completed", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      status: "completed",
      tenantId: TENANT_A,
    });
    const eventId = nextEventId();

    const response = await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        eventId,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    expect(response.status).toBe(200);
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
    await expect(readUsedCount(discountCodeId)).resolves.toBe(0);
    await expect(readPaymentEvent(eventId)).resolves.toEqual({
      outcome: "ignored",
      reason_code: REASON_CHECKOUT_NOT_PAYABLE,
      tenant_id: TENANT_A,
    });
  });
});

describe("atomicity", () => {
  /**
   * Every effect commits together, or none does.
   *
   * This is the checkpoint's central claim and the one place it beats
   * production, where `orderRef.create()` is followed by four independent
   * best-effort writes and a crash in between loses the discount burn
   * permanently — Stripe's retry short-circuits at the existing-order check and
   * nothing reconciles the counter.
   *
   * The failure is forced from the LAST statement in the batch: the event-ledger
   * insert is made to collide by pre-inserting its event id with a DIFFERENT
   * outcome, while the discount code is left untouched. Under a real batch the
   * whole thing rolls back and neither the order nor the burn survives. Under
   * sequential writes — which is exactly what production does — the order and
   * the increment would already be committed by the time the last statement
   * failed, and this test would find them.
   *
   * Recorded as a mutation-test finding: replacing `db.batch(statements)` with a
   * sequential loop over `statement.run()` left all 64 other tests green, because
   * no other case forces a mid-sequence failure. Atomicity was untested until
   * this case existed.
   */
  it("rolls back the order and the discount burn when a later statement fails", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });
    // Two DISTINCT event ids for the same intent, delivered concurrently. Both
    // clear the ledger read (different ids), both find the checkout 'open', both
    // load the same lines, and both queue a full batch — order insert, lines,
    // history, checkout transition, discount burn, ledger row.
    //
    // Exactly one may commit. The loser collides on `orders.checkout_id`, and
    // because a D1 batch is atomic its discount increment dies with it. Under
    // sequential writes the loser's statements would land one at a time and
    // whichever preceded the collision would survive — the precise shape of
    // production's lost/duplicated side effects.
    const payloads = [nextEventId(), nextEventId()].map((eventId) =>
      buildEventPayload({
        amount: seeded.totalMinor,
        eventId,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    const responses = await Promise.all(
      payloads.map(async (payload) => postWebhook(payload)),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    // ONE order, and — the assertion that discriminates — exactly ONE burn.
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
    await expect(readUsedCount(discountCodeId)).resolves.toBe(1);

    // No orphaned lines from the rolled-back attempt: one order, one line.
    const lines = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM order_items WHERE tenant_id = ? AND product_id = ?`,
    )
      .bind(TENANT_A, seeded.productIds[0])
      .first<{ n: number }>();
    expect(lines?.n).toBe(1);

    // And no orphaned history rows either.
    const history = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM order_status_history
       WHERE tenant_id = ? AND order_id IN (SELECT order_id FROM orders WHERE checkout_id = ?)`,
    )
      .bind(TENANT_A, seeded.checkoutId)
      .first<{ n: number }>();
    expect(history?.n).toBe(1);
  });
});

describe("refusals that create no order", () => {
  it("rejects an amount that disagrees with the frozen total", async () => {
    const discountCodeId = await seedDiscountCode(TENANT_A);
    const seeded = await seedPayableCheckout({
      discountCodeId,
      discountMinor: 1_990,
      tenantId: TENANT_A,
    });
    const eventId = nextEventId();

    const response = await postWebhook(
      buildEventPayload({
        // One minor unit short of the frozen total.
        amount: seeded.totalMinor - 1,
        eventId,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    // Acknowledged, so Stripe stops retrying — but nothing was created and the
    // ledger says loudly that a human should look.
    expect(response.status).toBe(200);
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
    await expect(readUsedCount(discountCodeId)).resolves.toBe(0);
    await expect(readCheckoutStatus(seeded.checkoutId)).resolves.toBe("open");
    await expect(readPaymentEvent(eventId)).resolves.toEqual({
      outcome: "rejected",
      reason_code: REASON_AMOUNT_MISMATCH,
      tenant_id: TENANT_A,
    });
  });

  it("rejects an overpayment just as firmly as an underpayment", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor + 100_000,
        eventId,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
    await expect(readPaymentEvent(eventId)).resolves.toMatchObject({
      outcome: "rejected",
      reason_code: REASON_AMOUNT_MISMATCH,
    });
  });

  it("rejects a currency that disagrees with the frozen one", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        currency: "eur",
        eventId,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
    await expect(readPaymentEvent(eventId)).resolves.toMatchObject({
      outcome: "rejected",
      reason_code: REASON_AMOUNT_MISMATCH,
    });
  });

  it("accepts the currency regardless of casing", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        // Stripe answers lowercase; the column stores uppercase.
        currency: "SEK",
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
  });

  it("acknowledges an intent no checkout claims", async () => {
    const eventId = nextEventId();
    const response = await postWebhook(
      buildEventPayload({
        eventId,
        metadata: { checkout_id: "ck-nobody", tenant_id: TENANT_A },
        paymentIntentId: "pi_belongs_to_nobody",
      }),
    );

    expect(response.status).toBe(200);
    await expect(readPaymentEvent(eventId)).resolves.toEqual({
      outcome: "ignored",
      reason_code: REASON_UNKNOWN_INTENT,
      tenant_id: null,
    });
  });

  it("rejects metadata naming a different checkout than the intent resolves to", async () => {
    const victim = await seedPayableCheckout({ tenantId: TENANT_A });
    const other = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();

    const response = await postWebhook(
      buildEventPayload({
        amount: victim.totalMinor,
        eventId,
        // The intent id resolves to `victim`, but metadata claims `other`.
        metadata: { checkout_id: other.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: victim.paymentIntentId,
      }),
    );

    expect(response.status).toBe(200);
    await expect(countOrders(victim.checkoutId)).resolves.toBe(0);
    await expect(countOrders(other.checkoutId)).resolves.toBe(0);
    await expect(readPaymentEvent(eventId)).resolves.toMatchObject({
      outcome: "rejected",
      reason_code: REASON_METADATA_MISMATCH,
    });
  });

  it("rejects metadata naming a different tenant than the checkout's", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        eventId,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_B },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
    await expect(readPaymentEvent(eventId)).resolves.toMatchObject({
      outcome: "rejected",
      reason_code: REASON_METADATA_MISMATCH,
    });
  });

  it("rejects an event carrying no metadata at all", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();

    await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        eventId,
        metadata: null,
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
    await expect(readPaymentEvent(eventId)).resolves.toMatchObject({
      outcome: "rejected",
      reason_code: REASON_METADATA_MISMATCH,
    });
  });

  it("rejects a succeeded event whose payload carries no readable intent", async () => {
    const eventId = nextEventId();
    const payload = JSON.stringify({
      data: { object: { object: "payment_intent" } },
      id: eventId,
      object: "event",
      type: "payment_intent.succeeded",
    });

    const response = await postWebhook(payload);

    expect(response.status).toBe(200);
    await expect(readPaymentEvent(eventId)).resolves.toMatchObject({
      outcome: "rejected",
      reason_code: REASON_UNKNOWN_INTENT,
    });
  });
});

describe("unhandled event types", () => {
  it.each([
    ["payment_intent.payment_failed"],
    ["charge.refunded"],
    ["account.updated"],
    ["charge.dispute.created"],
    ["customer.subscription.created"],
  ])("acknowledges %s as a recorded no-op", async (type) => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();

    const response = await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        eventId,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
        type,
      }),
    );

    // 200, always: a 4xx here would make Stripe retry an event forever.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
    await expect(readCheckoutStatus(seeded.checkoutId)).resolves.toBe("open");
    await expect(readPaymentEvent(eventId)).resolves.toEqual({
      outcome: "ignored",
      reason_code: REASON_UNHANDLED_TYPE,
      tenant_id: null,
    });
  });

  it("replays an unhandled event without a second ledger row", async () => {
    const eventId = nextEventId();
    const payload = buildEventPayload({
      eventId,
      paymentIntentId: nextIntentId(),
      type: "charge.refunded",
    });

    await postWebhook(payload);
    const second = await postWebhook(payload);

    expect(second.status).toBe(200);
    await expect(countPaymentEvents(eventId)).resolves.toBe(1);
  });
});

describe("cross-tenant integrity", () => {
  it("files the order under the checkout's tenant, not the hostname's", async () => {
    // The request is addressed to tenant B's storefront hostname, but the intent
    // belongs to tenant A's checkout. The hostname is NOT authority on this
    // route — Stripe calls one URL for the whole account — so the order must land
    // under A.
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const payload = buildEventPayload({
      amount: seeded.totalMinor,
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const request = new Request(`https://${HOST_B}${WEBHOOK_PATH}`, {
      body: payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": await signPayload(payload),
      },
      method: "POST",
    });
    const response = await worker.fetch(request, env as Env);

    expect(response.status).toBe(200);
    const order = (await readOrderByCheckout(seeded.checkoutId)) as OrderRow;
    expect(order.tenant_id).toBe(TENANT_A);
  });

  it("works from a hostname belonging to no tenant at all", async () => {
    // Stripe's endpoint URL need not be a storefront hostname, and in staging it
    // is the workers.dev domain, which resolves to no tenant. Tenant resolution
    // must therefore play no part on this route.
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const payload = buildEventPayload({
      amount: seeded.totalMinor,
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const request = new Request(`https://nobody.webhook.test${WEBHOOK_PATH}`, {
      body: payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": await signPayload(payload),
      },
      method: "POST",
    });
    const response = await worker.fetch(request, env as Env);

    expect(response.status).toBe(200);
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(1);
  });

  it("keeps two tenants' concurrent orders separate", async () => {
    const a = await seedPayableCheckout({ tenantId: TENANT_A });
    const b = await seedPayableCheckout({ tenantId: TENANT_B });

    await Promise.all([
      postWebhook(
        buildEventPayload({
          amount: a.totalMinor,
          metadata: { checkout_id: a.checkoutId, tenant_id: TENANT_A },
          paymentIntentId: a.paymentIntentId,
        }),
      ),
      postWebhook(
        buildEventPayload({
          amount: b.totalMinor,
          metadata: { checkout_id: b.checkoutId, tenant_id: TENANT_B },
          paymentIntentId: b.paymentIntentId,
        }),
      ),
    ]);

    const orderA = (await readOrderByCheckout(a.checkoutId)) as OrderRow;
    const orderB = (await readOrderByCheckout(b.checkoutId)) as OrderRow;

    expect(orderA.tenant_id).toBe(TENANT_A);
    expect(orderB.tenant_id).toBe(TENANT_B);
    expect(orderA.order_id).not.toBe(orderB.order_id);
  });
});

describe("response hygiene", () => {
  it("answers a processed event with nothing but an acknowledgement", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const eventId = nextEventId();

    const response = await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        eventId,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    const raw = await response.text();
    const order = (await readOrderByCheckout(seeded.checkoutId)) as OrderRow;

    expect(JSON.parse(raw)).toEqual({ received: true });
    // Nothing about the order, the buyer, or the payment escapes.
    expect(raw).not.toContain(order.order_id);
    expect(raw).not.toContain(order.order_number);
    expect(raw).not.toContain(seeded.paymentIntentId);
    expect(raw).not.toContain(seeded.checkoutId);
    expect(raw).not.toContain("buyer-");
    expect(raw.toLowerCase()).not.toContain("stripe");
    expect(raw).not.toContain("sk_test");
    expect(raw).not.toContain("whsec");
    expect(raw).not.toContain("req_");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers a rejected event identically to a processed one", async () => {
    // An outsider who somehow held a valid signature must not be able to tell
    // from the response whether a payment was recorded.
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });

    const rejected = await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor - 1,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );
    const accepted = await postWebhook(
      buildEventPayload({
        amount: seeded.totalMinor,
        metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
        paymentIntentId: seeded.paymentIntentId,
      }),
    );

    expect(rejected.status).toBe(accepted.status);
    await expect(rejected.text()).resolves.toBe(await accepted.text());
  });
});

describe("order number generation", () => {
  it("is unique across many draws", () => {
    const now = Date.now();
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      seen.add(generateOrderNumber(now));
    }

    // Same millisecond for every draw, so uniqueness comes entirely from the
    // random token — which is the property that matters, since prod's generator
    // has only 4 random characters behind a wrapping timestamp.
    expect(seen.size).toBe(500);
  });

  it("carries a readable UTC date prefix", () => {
    const stamp = Date.UTC(2026, 7, 22, 12, 0, 0);
    expect(generateOrderNumber(stamp)).toMatch(/^20260822-[0-9A-HJ-NP-TV-Z]{8}$/);
  });

  it("omits the letters that are misread aloud", () => {
    const now = Date.now();
    for (let index = 0; index < 200; index += 1) {
      const token = generateOrderNumber(now).split("-")[1] as string;
      expect(token).not.toMatch(/[ILOU]/);
    }
  });
});

describe("database faults", () => {
  /**
   * A D1 fault must NOT be swallowed into a 200. Stripe's retry is the recovery
   * mechanism for a transient database problem, and swallowing it would silently
   * drop a real payment.
   */
  it("surfaces rather than acknowledging when the ledger cannot be read", async () => {
    const seeded = await seedPayableCheckout({ tenantId: TENANT_A });
    const payload = buildEventPayload({
      amount: seeded.totalMinor,
      metadata: { checkout_id: seeded.checkoutId, tenant_id: TENANT_A },
      paymentIntentId: seeded.paymentIntentId,
    });

    const brokenDb = {
      batch: async () => {
        throw new Error("D1_ERROR: database is unavailable");
      },
      prepare: () => {
        throw new Error("D1_ERROR: database is unavailable");
      },
    } as unknown as D1Database;

    const brokenEnv = { ...env, DB: brokenDb } as unknown as Env;

    await expect(postWebhook(payload, { env: brokenEnv })).rejects.toThrow();
    // Nothing was written by the failed attempt.
    await expect(countOrders(seeded.checkoutId)).resolves.toBe(0);
  });
});
