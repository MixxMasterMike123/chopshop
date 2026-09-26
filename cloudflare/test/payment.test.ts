import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { PAYMENT_IP_LIMIT } from "../src/index";
import { paymentIdempotencyKey } from "../src/commerce/payment";
import type {
  CreatePaymentIntentParams,
  PaymentIntentView,
  StripeGateway,
} from "../src/commerce/stripe-client";
import {
  STRIPE_API_VERSION,
  STRIPE_GATEWAY_OVERRIDE,
  isStripeConfigured,
  resolveStripeGateway,
} from "../src/commerce/stripe-client";

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1_000;

const TENANT_A = "tenant-pay-a";
const TENANT_B = "tenant-pay-b";
const HOST_A = "a.payment.test";
const HOST_B = "b.payment.test";

let intentCounter = 0;

/**
 * A Stripe stand-in with the two behaviours that make the tests below mean
 * anything: create is IDEMPOTENT on the key (a second create with the same key
 * returns the first intent rather than a new one, which is what Stripe actually
 * does), and every call is recorded so a test can assert how many times the
 * gateway was touched. Without the idempotent-create semantics the race test
 * would prove only that the guarded UPDATE works, not that the pair of
 * mechanisms together yields exactly one intent.
 */
class FakeStripe implements StripeGateway {
  createCalls: CreatePaymentIntentParams[] = [];
  retrieveCalls: string[] = [];

  /** Set to make the next create/retrieve throw, simulating an outage. */
  failWith: Error | null = null;

  /** Status handed back by create; retrieve serves whatever is stored. */
  createStatus = "requires_payment_method";

  private readonly byKey = new Map<string, PaymentIntentView>();
  private readonly byId = new Map<string, PaymentIntentView>();

  async createPaymentIntent(
    params: CreatePaymentIntentParams,
  ): Promise<PaymentIntentView> {
    this.createCalls.push(params);
    if (this.failWith !== null) {
      throw this.failWith;
    }

    const existing = this.byKey.get(params.idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }

    // Ids come from a MODULE-level counter, not a per-instance one. The fake is
    // rebuilt per test but D1 is not, and payment_intent_id is UNIQUE across the
    // whole table — a per-instance counter handed every test a fresh 'pi_fake_1'
    // and the second test to attach one hit the constraint. Worth recording:
    // the first version of this suite failed 15 tests for exactly that reason,
    // and the failure was a fixture defect, not a product one.
    intentCounter += 1;
    const intent: PaymentIntentView = {
      amount: params.amount,
      client_secret: `pi_fake_${intentCounter}_secret_abc`,
      currency: params.currency,
      id: `pi_fake_${intentCounter}`,
      status: this.createStatus,
    };

    this.byKey.set(params.idempotencyKey, intent);
    this.byId.set(intent.id, intent);
    return intent;
  }

  async retrievePaymentIntent(
    paymentIntentId: string,
  ): Promise<PaymentIntentView> {
    this.retrieveCalls.push(paymentIntentId);
    if (this.failWith !== null) {
      throw this.failWith;
    }

    const intent = this.byId.get(paymentIntentId);
    if (intent === undefined) {
      throw new Error(`no such payment_intent: ${paymentIntentId}`);
    }

    return intent;
  }

  /** Drives an already-created intent into a terminal state. */
  setStatus(paymentIntentId: string, status: string): void {
    const intent = this.byId.get(paymentIntentId);
    if (intent !== undefined) {
      this.byId.set(paymentIntentId, { ...intent, status });
    }
  }

  get totalCalls(): number {
    return this.createCalls.length + this.retrieveCalls.length;
  }

  /** Every intent this fake actually minted, in creation order. */
  get mintedIntents(): PaymentIntentView[] {
    return [...this.byId.values()];
  }
}

let stripe: FakeStripe;

/** The worker env with the fake gateway injected in place of the real client. */
function paymentEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    ...overrides,
    [STRIPE_GATEWAY_OVERRIDE]: stripe,
  } as unknown as Env;
}

let ipCounter = 0;

/**
 * A distinct client address per request unless the caller pins one — same
 * reason as the checkout suite: this route is rate limited per IP and these
 * suites fire far more than one window's allowance between them.
 */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 256}:${ipCounter}`;
}

interface PostOptions {
  body?: BodyInit;
  headers?: Record<string, string>;
  env?: Env;
  method?: string;
  path?: string;
}

async function postPayment(
  hostname: string,
  checkoutId: string,
  options: PostOptions = {},
): Promise<Response> {
  const path = options.path ?? `/v1/checkout/${checkoutId}/payment`;
  const request = new Request(`https://${hostname}${path}`, {
    method: options.method ?? "POST",
    headers: {
      "cf-connecting-ip": nextIp(),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });

  return worker.fetch(request, options.env ?? paymentEnv());
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

interface SeedCheckoutOptions {
  checkoutId: string;
  currency?: string;
  expiresAt?: number;
  paymentIntentId?: string | null;
  status?: string;
  tenantId: string;
  totalMinor?: number;
}

/**
 * Writes a checkout row directly rather than going through POST /v1/checkout.
 *
 * The creation route is proven in its own suite, and driving it here would make
 * every case in this file depend on a live product catalogue, the shipping
 * engine, and two other rate limiters — noise that would obscure what these
 * tests are actually about. The columns written are exactly the ones the
 * payment path reads, and the schema's own CHECKs still police the money.
 */
async function seedCheckout(options: SeedCheckoutOptions): Promise<void> {
  const total = options.totalMinor ?? 23_710;

  await env.DB.prepare(
    `INSERT INTO checkouts (
      checkout_id, tenant_id, status, customer_email, currency,
      delivery_method, shipping_country, subtotal_minor, shipping_minor,
      vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor,
      payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'shipping', 'SE', ?, 0, 0, 2500, 0, NULL, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      options.checkoutId,
      options.tenantId,
      options.status ?? "open",
      `buyer-${options.checkoutId}@example.test`,
      options.currency ?? "SEK",
      total,
      total,
      options.paymentIntentId ?? null,
      `hash-${options.checkoutId}`,
      options.expiresAt ?? NOW + DAY_MS,
      NOW,
      NOW,
    )
    .run();
}

async function readPaymentIntentId(
  checkoutId: string,
): Promise<string | null | undefined> {
  const row = await env.DB.prepare(
    "SELECT payment_intent_id FROM checkouts WHERE checkout_id = ? LIMIT 1",
  )
    .bind(checkoutId)
    .first<{ payment_intent_id: string | null }>();

  return row === null ? undefined : row.payment_intent_id;
}

let checkoutCounter = 0;

function nextCheckoutId(): string {
  checkoutCounter += 1;
  return `ck-pay-${checkoutCounter.toString().padStart(4, "0")}`;
}

beforeAll(async () => {
  await seedTenant(TENANT_A, HOST_A);
  await seedTenant(TENANT_B, HOST_B);
});

beforeEach(() => {
  stripe = new FakeStripe();
});

describe("stripe configuration gate", () => {
  it("reports configured when a key of usable length exists", () => {
    expect(isStripeConfigured(env)).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["too short", "sk_a"],
  ])("reports unconfigured when the key is %s", (_label, key) => {
    expect(isStripeConfigured({ ...env, STRIPE_SECRET_KEY: key } as Env)).toBe(
      false,
    );
  });

  it("pins the API version the worker speaks", () => {
    // A bare equality check on purpose: this constant is the wire contract, and
    // an SDK upgrade that moves it must fail here rather than in production.
    expect(STRIPE_API_VERSION).toBe("2026-07-29.dahlia");
  });

  it("returns the injected gateway when one is present", () => {
    expect(resolveStripeGateway(paymentEnv())).toBe(stripe);
  });

  it("ignores an override that is not a usable gateway", () => {
    const bogus = {
      ...env,
      [STRIPE_GATEWAY_OVERRIDE]: { createPaymentIntent: "not a function" },
    } as unknown as Env;

    // Falls through to the real client rather than trusting the shape.
    expect(resolveStripeGateway(bogus)).not.toBe(stripe);
  });
});

describe("payment surface while STRIPE_SECRET_KEY is unconfigured", () => {
  it("404s a valid checkout and leaves the row untouched", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const response = await postPayment(HOST_A, checkoutId, {
      env: paymentEnv({ STRIPE_SECRET_KEY: undefined }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Checkout not found" },
    });
    await expect(readPaymentIntentId(checkoutId)).resolves.toBeNull();
    expect(stripe.totalCalls).toBe(0);
  });

  it("404s before the rate limiter can even count the request", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });
    const ip = "198.51.100.240";

    // Far past the limit. Every one is a 404 rather than a 429, because the
    // unconfigured gate runs first and an unconfigured surface must look
    // exactly like a surface that was never built.
    for (let attempt = 0; attempt < PAYMENT_IP_LIMIT + 5; attempt += 1) {
      const response = await postPayment(HOST_A, checkoutId, {
        env: paymentEnv({ STRIPE_SECRET_KEY: undefined }),
        headers: { "cf-connecting-ip": ip },
      });
      expect(response.status).toBe(404);
    }
  });
});

describe("payment intent creation", () => {
  it("creates one intent for the checkout's frozen total", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A, totalMinor: 23_710 });

    const response = await postPayment(HOST_A, checkoutId);

    expect(response.status).toBe(201);
    const body = await response.json<{
      payment: { clientSecret: string; paymentIntentId: string };
    }>();
    // Relative to what the fake actually minted: ids come from a module-level
    // counter shared with every other case in this file.
    const minted = stripe.mintedIntents[0] as PaymentIntentView;
    expect(body.payment.paymentIntentId).toBe(minted.id);
    expect(body.payment.clientSecret).toBe(minted.client_secret);

    // The amount is the row's total, the currency is the row's, and metadata is
    // exactly the two join keys — no email, no lines, nothing else.
    expect(stripe.createCalls).toHaveLength(1);
    expect(stripe.createCalls[0]).toEqual({
      amount: 23_710,
      currency: "sek",
      idempotencyKey: paymentIdempotencyKey(checkoutId),
      metadata: { checkout_id: checkoutId, tenant_id: TENANT_A },
    });

    await expect(readPaymentIntentId(checkoutId)).resolves.toBe(minted.id);
  });

  it("sends metadata with exactly two keys", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    await postPayment(HOST_A, checkoutId);

    const metadata = stripe.createCalls[0]?.metadata ?? {};
    expect(Object.keys(metadata).sort()).toEqual(["checkout_id", "tenant_id"]);
  });

  it("never stores the client secret in D1", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const response = await postPayment(HOST_A, checkoutId);
    const body = await response.json<{ payment: { clientSecret: string } }>();

    const row = await env.DB.prepare(
      "SELECT * FROM checkouts WHERE checkout_id = ? LIMIT 1",
    )
      .bind(checkoutId)
      .first<Record<string, unknown>>();

    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(body.payment.clientSecret);
    // The intent ID, however, IS stored — that is the join key the webhook needs.
    expect(serialized).toContain(
      (stripe.mintedIntents[0] as PaymentIntentView).id,
    );
  });

  it("answers with no-store cache headers", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const response = await postPayment(HOST_A, checkoutId);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("lowercases the currency for Stripe while D1 keeps its own casing", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({
      checkoutId,
      currency: "SEK",
      tenantId: TENANT_A,
    });

    await postPayment(HOST_A, checkoutId);

    expect(stripe.createCalls[0]?.currency).toBe("sek");
  });
});

describe("idempotent repeat calls", () => {
  it("re-serves the same intent without a second create", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const first = await postPayment(HOST_A, checkoutId);
    const second = await postPayment(HOST_A, checkoutId);

    expect(first.status).toBe(201);
    // 200 rather than 201: nothing was minted this time.
    expect(second.status).toBe(200);

    const firstBody = await first.json<{
      payment: { clientSecret: string; paymentIntentId: string };
    }>();
    const secondBody = await second.json<{
      payment: { clientSecret: string; paymentIntentId: string };
    }>();

    expect(secondBody.payment.paymentIntentId).toBe(
      firstBody.payment.paymentIntentId,
    );
    // Retrieve returns the secret — it is never read from D1.
    expect(secondBody.payment.clientSecret).toBe(
      firstBody.payment.clientSecret,
    );

    expect(stripe.createCalls).toHaveLength(1);
    expect(stripe.retrieveCalls).toEqual([firstBody.payment.paymentIntentId]);
  });

  it("stays on one intent across many repeats", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const ids = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postPayment(HOST_A, checkoutId);
      const body = await response.json<{
        payment: { paymentIntentId: string };
      }>();
      ids.add(body.payment.paymentIntentId);
    }

    expect(ids.size).toBe(1);
    expect(stripe.createCalls).toHaveLength(1);
  });
});

describe("concurrent calls", () => {
  it("yields exactly one intent for two racing callers", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const [first, second] = await Promise.all([
      postPayment(HOST_A, checkoutId),
      postPayment(HOST_A, checkoutId),
    ]);

    expect([first.status, second.status].every((s) => s === 200 || s === 201))
      .toBe(true);

    const bodies = await Promise.all([
      first.json<{ payment: { paymentIntentId: string } }>(),
      second.json<{ payment: { paymentIntentId: string } }>(),
    ]);

    // Both callers got the SAME intent: Stripe's idempotency key collapsed the
    // two creates, and the guarded UPDATE let exactly one of them attach.
    expect(bodies[0].payment.paymentIntentId).toBe(
      bodies[1].payment.paymentIntentId,
    );

    // One distinct intent exists at the gateway, whatever the create count.
    const createdIds = new Set(
      stripe.createCalls.map((call) => call.idempotencyKey),
    );
    expect(createdIds.size).toBe(1);

    await expect(readPaymentIntentId(checkoutId)).resolves.toBe(
      bodies[0].payment.paymentIntentId,
    );
  });

  /**
   * The guarded UPDATE, isolated from Stripe's idempotency.
   *
   * Every other race case here uses a gateway that honours the idempotency key,
   * so both callers receive the SAME intent and an unguarded write would put
   * back a value identical to the one already there — invisible. That made the
   * suite blind: dropping `AND payment_intent_id IS NULL` left all tests green.
   *
   * This case removes the gateway's help. The fake mints a DISTINCT intent per
   * create, which is what a Stripe outage-and-retry, a key collision, or simply
   * a future caller that forgot the deterministic key would produce. Now the
   * guard is the only thing standing between the second caller and an overwrite
   * of an intent that may already be confirming — the exact money-state fork
   * the UNIQUE column and the NULL predicate exist to prevent.
   */
  it("refuses to overwrite an attached intent when the gateway is not idempotent", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    // Mints a fresh intent on EVERY create, ignoring the idempotency key.
    let minted = 0;
    const created = new Map<string, PaymentIntentView>();
    const nonIdempotent: StripeGateway = {
      async createPaymentIntent(params) {
        minted += 1;
        intentCounter += 1;
        const intent: PaymentIntentView = {
          amount: params.amount,
          client_secret: `pi_ni_${intentCounter}_secret`,
          currency: params.currency,
          id: `pi_ni_${intentCounter}`,
          status: "requires_payment_method",
        };
        created.set(intent.id, intent);
        return intent;
      },
      async retrievePaymentIntent(paymentIntentId) {
        const intent = created.get(paymentIntentId);
        if (intent === undefined) {
          throw new Error("no such payment_intent");
        }
        return intent;
      },
    };

    const nonIdempotentEnv = {
      ...env,
      [STRIPE_GATEWAY_OVERRIDE]: nonIdempotent,
    } as unknown as Env;

    const first = await postPayment(HOST_A, checkoutId, {
      env: nonIdempotentEnv,
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json<{
      payment: { paymentIntentId: string };
    }>();
    const attachedId = firstBody.payment.paymentIntentId;

    // Force the create path a second time on a checkout that already has an
    // intent, which is what the guard must survive.
    await env.DB.prepare(
      "UPDATE checkouts SET payment_intent_id = NULL WHERE checkout_id = ?",
    )
      .bind(checkoutId)
      .run();
    await env.DB.prepare(
      "UPDATE checkouts SET payment_intent_id = ? WHERE checkout_id = ?",
    )
      .bind(attachedId, checkoutId)
      .run();

    const second = await postPayment(HOST_A, checkoutId, {
      env: nonIdempotentEnv,
    });

    // The second call retrieves the attached intent; it does not create.
    expect(second.status).toBe(200);
    const secondBody = await second.json<{
      payment: { paymentIntentId: string };
    }>();
    expect(secondBody.payment.paymentIntentId).toBe(attachedId);
    expect(minted).toBe(1);
    await expect(readPaymentIntentId(checkoutId)).resolves.toBe(attachedId);
  });

  /**
   * The same guard under a genuine race, again without the gateway's help.
   *
   * Both callers pass the "no intent attached" read, both create a DISTINCT
   * intent, and both try to attach. Exactly one write may win, and the loser
   * must serve the WINNER's intent — read back from the row — rather than the
   * orphan it is holding. Without the NULL predicate the second write would
   * clobber the first, and the two callers would walk away holding client
   * secrets for two different intents against one checkout.
   */
  it("keeps one attached intent when non-idempotent creates race", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const created = new Map<string, PaymentIntentView>();
    const nonIdempotent: StripeGateway = {
      async createPaymentIntent(params) {
        intentCounter += 1;
        const intent: PaymentIntentView = {
          amount: params.amount,
          client_secret: `pi_race_${intentCounter}_secret`,
          currency: params.currency,
          id: `pi_race_${intentCounter}`,
          status: "requires_payment_method",
        };
        created.set(intent.id, intent);
        return intent;
      },
      async retrievePaymentIntent(paymentIntentId) {
        const intent = created.get(paymentIntentId);
        if (intent === undefined) {
          throw new Error("no such payment_intent");
        }
        return intent;
      },
    };

    const raceEnv = {
      ...env,
      [STRIPE_GATEWAY_OVERRIDE]: nonIdempotent,
    } as unknown as Env;

    const responses = await Promise.all([
      postPayment(HOST_A, checkoutId, { env: raceEnv }),
      postPayment(HOST_A, checkoutId, { env: raceEnv }),
    ]);

    const ids = new Set<string>();
    for (const response of responses) {
      expect([200, 201]).toContain(response.status);
      const body = await response.json<{
        payment: { paymentIntentId: string };
      }>();
      ids.add(body.payment.paymentIntentId);
    }

    // Both callers agree, and they agree with the row.
    expect(ids.size).toBe(1);
    await expect(readPaymentIntentId(checkoutId)).resolves.toBe(
      [...ids][0] as string,
    );
  });

  it("yields one intent under a wider stampede", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const responses = await Promise.all(
      Array.from({ length: 6 }, async () => postPayment(HOST_A, checkoutId)),
    );

    const ids = new Set<string>();
    for (const response of responses) {
      expect([200, 201]).toContain(response.status);
      const body = await response.json<{
        payment: { paymentIntentId: string };
      }>();
      ids.add(body.payment.paymentIntentId);
    }

    expect(ids.size).toBe(1);
    await expect(readPaymentIntentId(checkoutId)).resolves.toBe(
      [...ids][0] as string,
    );
  });
});

describe("denials", () => {
  it("404s an unknown checkout id", async () => {
    const response = await postPayment(HOST_A, "ck-does-not-exist");

    expect(response.status).toBe(404);
    expect(stripe.totalCalls).toBe(0);
  });

  it("404s a checkout belonging to another tenant", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    // The id is real and open — it simply is not this storefront's.
    const response = await postPayment(HOST_B, checkoutId);

    expect(response.status).toBe(404);
    await expect(readPaymentIntentId(checkoutId)).resolves.toBeNull();
    expect(stripe.totalCalls).toBe(0);
  });

  it("404s an expired checkout before touching Stripe", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({
      checkoutId,
      expiresAt: NOW - 1_000,
      tenantId: TENANT_A,
    });

    const response = await postPayment(HOST_A, checkoutId);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Checkout not found" },
    });
    await expect(readPaymentIntentId(checkoutId)).resolves.toBeNull();
    expect(stripe.totalCalls).toBe(0);
  });

  it.each([["completed"], ["abandoned"], ["expired"]])(
    "404s a checkout in %s status",
    async (status) => {
      const checkoutId = nextCheckoutId();
      await seedCheckout({ checkoutId, status, tenantId: TENANT_A });

      const response = await postPayment(HOST_A, checkoutId);

      expect(response.status).toBe(404);
      await expect(readPaymentIntentId(checkoutId)).resolves.toBeNull();
      expect(stripe.totalCalls).toBe(0);
    },
  );

  it("404s an unknown host", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const response = await postPayment("nobody.payment.test", checkoutId);

    expect(response.status).toBe(404);
    expect(stripe.totalCalls).toBe(0);
  });

  it.each([["GET"], ["PUT"], ["PATCH"], ["DELETE"]])(
    "404s the %s method",
    async (method) => {
      const checkoutId = nextCheckoutId();
      await seedCheckout({ checkoutId, tenantId: TENANT_A });

      const response = await postPayment(HOST_A, checkoutId, { method });

      expect(response.status).toBe(404);
      await expect(readPaymentIntentId(checkoutId)).resolves.toBeNull();
      expect(stripe.totalCalls).toBe(0);
    },
  );

  it("rejects a non-empty body", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    // A body that, if it were read, would be a plausible attempt to move money.
    const response = await postPayment(HOST_A, checkoutId, {
      body: JSON.stringify({ amount: 1, currency: "usd" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(404);
    await expect(readPaymentIntentId(checkoutId)).resolves.toBeNull();
    expect(stripe.totalCalls).toBe(0);
  });

  /**
   * The edge-normalized shapes of "no body" are ACCEPTED. Cloudflare's edge
   * stamps `content-length: 0` onto ordinary bodyless POSTs (curl, fetch over
   * HTTP/2) before the worker sees them, and workerd synthesizes the same
   * header for a zero-byte body — both are byte-identical on the wire to a
   * bodyless request, so treating either as a body violation would 404 every
   * legitimate live caller. The first deployed version of this route did
   * exactly that: every local test built Requests without edge normalization
   * and stayed green while live smoke 404'd. These two cases pin the fix.
   */
  it("accepts the edge-normalized bodyless POST (content-length: 0)", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const response = await postPayment(HOST_A, checkoutId, {
      headers: { "content-length": "0" },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      payment: { paymentIntentId: string };
    };
    await expect(readPaymentIntentId(checkoutId)).resolves.toBe(
      body.payment.paymentIntentId,
    );
  });

  it("accepts a zero-byte body that declares its emptiness", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    // An empty stream under a declared zero length — the other shape the edge
    // can present for "no body".
    const response = await postPayment(HOST_A, checkoutId, {
      body: "",
      headers: { "content-length": "0" },
    });

    expect(response.status).toBe(201);
  });

  it("refuses an undeclared stream even when it happens to be empty", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    // No declared length + a present stream reads as a chunked body. Its
    // emptiness cannot be verified without consuming it, and the live edge
    // always declares emptiness explicitly, so refusing costs no real caller.
    const response = await postPayment(HOST_A, checkoutId, { body: "" });

    expect(response.status).toBe(404);
    expect(stripe.totalCalls).toBe(0);
  });

  it.each([
    ["a trailing extra segment", "/v1/checkout/ck-x/payment/extra"],
    ["a missing action", "/v1/checkout/ck-x"],
    ["an unknown action", "/v1/checkout/ck-x/confirm"],
    ["an empty id", "/v1/checkout//payment"],
  ])("404s %s", async (_label, path) => {
    const response = await postPayment(HOST_A, "unused", { path });

    expect(response.status).toBe(404);
    expect(stripe.totalCalls).toBe(0);
  });
});

describe("terminal payment intents", () => {
  it.each([["canceled"], ["succeeded"]])(
    "refuses a repeat call on a %s intent without minting a second",
    async (status) => {
      const checkoutId = nextCheckoutId();
      await seedCheckout({ checkoutId, tenantId: TENANT_A });

      const first = await postPayment(HOST_A, checkoutId);
      const body = await first.json<{
        payment: { paymentIntentId: string };
      }>();
      stripe.setStatus(body.payment.paymentIntentId, status);

      const second = await postPayment(HOST_A, checkoutId);

      // The same opaque answer an expired checkout gets: the buyer needs a NEW
      // checkout, and a money-state fork is worse than a dead one.
      expect(second.status).toBe(404);
      await expect(second.json()).resolves.toEqual({
        error: { code: "not_found", message: "Checkout not found" },
      });

      // No second create, and the row still names the original intent.
      expect(stripe.createCalls).toHaveLength(1);
      await expect(readPaymentIntentId(checkoutId)).resolves.toBe(
        body.payment.paymentIntentId,
      );
    },
  );

  it("refuses an intent that carries no client secret", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const first = await postPayment(HOST_A, checkoutId);
    const body = await first.json<{ payment: { paymentIntentId: string } }>();

    // Simulate Stripe returning an intent whose secret is null — unusable to a
    // buyer, so it must be refused rather than serialized as null under a 200.
    const id = body.payment.paymentIntentId;
    stripe.retrievePaymentIntent = async () => ({
      amount: 23_710,
      client_secret: null,
      currency: "sek",
      id,
      status: "requires_payment_method",
    });

    const second = await postPayment(HOST_A, checkoutId);
    expect(second.status).toBe(404);
  });
});

describe("gateway failures", () => {
  it("answers an opaque 502 and leaves payment_intent_id NULL", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    stripe.failWith = new Error(
      "Invalid API Key provided: sk_test_****leak; request req_deadbeef",
    );

    const response = await postPayment(HOST_A, checkoutId);

    expect(response.status).toBe(502);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({
      error: {
        code: "payment_unavailable",
        message: "Payment could not be prepared",
      },
    });

    // Nothing of Stripe's error text survives into the response.
    expect(raw).not.toContain("sk_test");
    expect(raw).not.toContain("API Key");
    expect(raw).not.toContain("req_deadbeef");
    expect(raw.toLowerCase()).not.toContain("stripe");

    await expect(readPaymentIntentId(checkoutId)).resolves.toBeNull();
  });

  it("recovers on retry once the gateway is healthy", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    stripe.failWith = new Error("network down");
    const failed = await postPayment(HOST_A, checkoutId);
    expect(failed.status).toBe(502);
    await expect(readPaymentIntentId(checkoutId)).resolves.toBeNull();

    stripe.failWith = null;
    const recovered = await postPayment(HOST_A, checkoutId);
    expect(recovered.status).toBe(201);

    const body = await recovered.json<{
      payment: { paymentIntentId: string };
    }>();
    await expect(readPaymentIntentId(checkoutId)).resolves.toBe(
      body.payment.paymentIntentId,
    );
  });

  it("answers 502 when a retrieve fails on a repeat call", async () => {
    const checkoutId = nextCheckoutId();
    await seedCheckout({ checkoutId, tenantId: TENANT_A });

    const first = await postPayment(HOST_A, checkoutId);
    expect(first.status).toBe(201);
    const body = await first.json<{ payment: { paymentIntentId: string } }>();

    stripe.failWith = new Error("gateway timeout");
    const second = await postPayment(HOST_A, checkoutId);

    expect(second.status).toBe(502);
    // The attachment survives the outage: the intent still exists at Stripe.
    await expect(readPaymentIntentId(checkoutId)).resolves.toBe(
      body.payment.paymentIntentId,
    );
  });
});

describe("rate limiting", () => {
  it("429s past the limit with Retry-After, before Stripe is touched", async () => {
    const ip = "198.51.100.201";
    const checkoutIds: string[] = [];

    for (let index = 0; index < PAYMENT_IP_LIMIT; index += 1) {
      const checkoutId = nextCheckoutId();
      checkoutIds.push(checkoutId);
      await seedCheckout({ checkoutId, tenantId: TENANT_A });
    }

    for (const checkoutId of checkoutIds) {
      const response = await postPayment(HOST_A, checkoutId, {
        headers: { "cf-connecting-ip": ip },
      });
      expect(response.status).toBe(201);
    }

    expect(stripe.createCalls).toHaveLength(PAYMENT_IP_LIMIT);
    const callsBefore = stripe.totalCalls;

    const overLimitId = nextCheckoutId();
    await seedCheckout({ checkoutId: overLimitId, tenantId: TENANT_A });
    const denied = await postPayment(HOST_A, overLimitId, {
      headers: { "cf-connecting-ip": ip },
    });

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
    await expect(denied.json()).resolves.toEqual({
      error: { code: "rate_limited", message: "Too many requests" },
    });

    // The gateway saw nothing: the limiter sits in front of the outbound call.
    expect(stripe.totalCalls).toBe(callsBefore);
    await expect(readPaymentIntentId(overLimitId)).resolves.toBeNull();
  });

  it("counts a denied caller without letting an unknown id become an oracle", async () => {
    const ip = "198.51.100.202";

    for (let index = 0; index < PAYMENT_IP_LIMIT; index += 1) {
      await postPayment(HOST_A, "ck-nonexistent", {
        headers: { "cf-connecting-ip": ip },
      });
    }

    const denied = await postPayment(HOST_A, "ck-nonexistent", {
      headers: { "cf-connecting-ip": ip },
    });

    expect(denied.status).toBe(429);
    expect(stripe.totalCalls).toBe(0);
  });
});
