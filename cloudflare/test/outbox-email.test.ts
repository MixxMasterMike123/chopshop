import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import {
  createOrderConfirmationEmailJob,
  deliveryIdFromKey,
  formatOrderMoney,
  type OrderConfirmationEmailJob,
  parseAuthEmailJob,
  renderAuthEmail,
} from "../src/email/auth-email-job";
import {
  claimAuthEmailDelivery,
  fingerprintAuthEmailJob,
  recordAuthEmailDelivery,
} from "../src/email/email-delivery-store";
import type { AuthEmailJob } from "../src/email/auth-email-job";
import { RESEND_FETCH_OVERRIDE } from "../src/email/email-queue-consumer";
import { processOutboxRowById } from "../src/outbox/effects";
import {
  alertsFor,
  outboxRow,
  quietEnv,
  recordingQueue,
  seedOrder,
  seedTenant,
} from "./dispatch-fixtures";

/**
 * The `email` outbox effect: the order confirmation (PLAN §2.3 `outbox(email)`),
 * handed to the existing `-email` consumer through the delivery ledger — and
 * sent at most once however often the effect runs.
 */

const TENANT = "tenant-outbox-email";
const SHOP_NAME = "Melodie <MC> & Co";
const HOUR_MS = 60 * 60 * 1_000;

beforeAll(async () => {
  await seedTenant(TENANT, SHOP_NAME);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM outbox_events").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function ledger(deliveryId: string) {
  return env.DB.prepare(
    "SELECT kind, status, tenant_id, attempts FROM email_deliveries WHERE delivery_id = ?",
  )
    .bind(deliveryId)
    .first<{ attempts: number; kind: string; status: string; tenant_id: string }>();
}

function emailBatch(jobs: unknown[]) {
  const acks: string[] = [];
  const retries: string[] = [];
  const batch = {
    messages: jobs.map((body, index) => ({
      ack: () => acks.push(`m${index}`),
      attempts: 1,
      body,
      id: `m${index}`,
      retry: () => retries.push(`m${index}`),
      timestamp: new Date(),
    })),
    queue: "chopshop-test-email",
    retryAll: () => {
      throw new Error("never retries a whole batch");
    },
  } as unknown as MessageBatch<unknown>;
  return { acks, batch, retries };
}

function fakeResend() {
  const calls: Request[] = [];
  return {
    calls,
    fetch: async (request: Request) => {
      calls.push(request);
      // Unique across the file: provider_message_id is UNIQUE in the ledger.
      return Response.json({ id: `re_${crypto.randomUUID()}` });
    },
  };
}

describe("the order confirmation effect", () => {
  it("queues ONE deterministic order_confirmation job, ledgered, from the order's own rows", async () => {
    const order = await seedOrder(TENANT, {
      customerEmail: "Buyer.One@Example.TEST",
      deliveryMethod: "shipping",
      discountMinor: 5_000,
      lines: [{ name: "Tröja <svart>", quantity: 2, unitPriceMinor: 29_900 }, { production: "none", unitPriceMinor: 9_900 }],
    });
    const { emails, env: quiet } = quietEnv();

    const result = await processOutboxRowById(quiet, order.emailId);

    expect(result).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(emails.sent).toHaveLength(1);
    const job = emails.sent[0] as OrderConfirmationEmailJob;
    const row = await outboxRow(order.emailId);
    const deliveryId = await deliveryIdFromKey(`email:order_confirmation:${order.orderId}`);
    expect(job).toEqual({
      actionUrl: "",
      createdAt: row.created_at,
      deliveryId,
      expiresAt: row.created_at + 24 * HOUR_MS,
      kind: "order_confirmation",
      locale: "sv",
      order: {
        currency: "SEK",
        deliveryMethod: "shipping",
        discountMinor: 5_000,
        items: [
          { lineTotalMinor: 59_800, name: "Tröja <svart>", quantity: 2 },
          { lineTotalMinor: 9_900, name: "Tröja 2", quantity: 1 },
        ],
        orderNumber: order.orderNumber,
        shippingCountry: "SE",
        shippingMinor: 4_900,
        shopName: SHOP_NAME,
        subtotalMinor: 69_700,
        totalMinor: 69_600,
        vatMinor: expect.any(Number),
      },
      recipient: "buyer.one@example.test",
      tenantId: TENANT,
      version: 1,
    });
    expect(row).toMatchObject({ result_ref: deliveryId, status: "done" });
    expect(await ledger(deliveryId)).toMatchObject({
      kind: "order_confirmation",
      status: "pending",
      tenant_id: TENANT,
    });
    // The -email consumer's own parser accepts it unchanged.
    expect(parseAuthEmailJob(JSON.parse(JSON.stringify(job)), env.AUTH_BASE_URL)).toEqual(job);
  });

  it("sends at most one email when the effect runs twice (crash after enqueue, before the commit)", async () => {
    const order = await seedOrder(TENANT);
    const emails = recordingQueue();
    const { env: quiet } = quietEnv({ EMAIL_QUEUE: emails.queue });
    let crashed = false;
    const dyingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch" && crashed) {
          return () => Promise.reject(new Error("worker died"));
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const crashing = {
      ...quiet,
      DB: dyingDb,
      EMAIL_QUEUE: {
        async send(body: unknown) {
          await emails.queue.send(body);
          crashed = true;
        },
      },
    } as unknown as Env;

    await expect(processOutboxRowById(crashing, order.emailId)).rejects.toThrow("worker died");
    expect((await outboxRow(order.emailId)).status).toBe("submitting");

    // Re-claimed after the claim expires: the identical job is queued again.
    await processOutboxRowById(quiet, order.emailId, () => Date.now() + 6 * 60_000);
    expect((await outboxRow(order.emailId)).status).toBe("done");
    expect(emails.sent).toHaveLength(2);
    expect(emails.sent[1]).toEqual(emails.sent[0]);

    // The -email consumer, given both copies, sends ONE email.
    const resend = fakeResend();
    const { acks, batch } = emailBatch(emails.sent);
    await worker.queue(batch, { ...env, [RESEND_FETCH_OVERRIDE]: resend.fetch } as unknown as Env);

    expect(acks).toEqual(["m0", "m1"]);
    expect(resend.calls).toHaveLength(1);
    const job = emails.sent[0] as OrderConfirmationEmailJob;
    const sent = resend.calls[0]!;
    expect(sent.headers.get("idempotency-key")).toBe(job.deliveryId);
    const payload = await sent.json<{ subject: string; text: string; to: string[] }>();
    expect(payload.to).toEqual([job.recipient]);
    expect(payload.subject).toBe(`Orderbekräftelse ${order.orderNumber}`);
    expect(payload.text).toContain(`Ordernummer: ${order.orderNumber}`);
    expect((await ledger(job.deliveryId))?.status).toBe("sent");
  });

  it("holds (retries) when the email queue is not bound", async () => {
    const order = await seedOrder(TENANT);

    const result = await processOutboxRowById(quietEnv({ EMAIL_QUEUE: undefined }).env, order.emailId);

    expect(result).toMatchObject({ kind: "ran", outcome: { kind: "retry" } });
    expect(await outboxRow(order.emailId)).toMatchObject({
      last_error: "email_queue_not_configured",
      status: "pending",
    });
  });

  it("retries a queue failure; the ledger row is kept for the retry", async () => {
    const order = await seedOrder(TENANT);

    const result = await processOutboxRowById(
      quietEnv({ EMAIL_QUEUE: recordingQueue({ fail: true }).queue }).env,
      order.emailId,
    );

    expect(result).toMatchObject({ kind: "ran", outcome: { kind: "retry" } });
    expect((await outboxRow(order.emailId)).last_error).toBe("email_queue_error");
    const deliveryId = await deliveryIdFromKey(`email:order_confirmation:${order.orderId}`);
    expect((await ledger(deliveryId))?.status).toBe("pending");
  });

  it("gives up with an alert rather than mail a confirmation outside the ledger's 24-hour window", async () => {
    const order = await seedOrder(TENANT, { createdAt: Date.now() - 25 * HOUR_MS });
    const { emails, env: quiet } = quietEnv();

    const result = await processOutboxRowById(quiet, order.emailId);

    expect(result).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    expect((await outboxRow(order.emailId)).last_error).toBe("email_expired");
    expect((await alertsFor(order.emailId)).map((alert) => alert.kind)).toEqual(["outbox_failed"]);
    expect(emails.sent).toHaveLength(0);
  });

  it("fails a payload that is not an order confirmation", async () => {
    const order = await seedOrder(TENANT, { withOutbox: false });
    await env.DB.prepare(
      `INSERT INTO outbox_events (outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
         dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at)
       VALUES ('email-bad', ?, 'email', 'order', ?, 'email:bad', '{"orderId":"x","kind":"newsletter"}', 'pending', ?, ?, ?)`,
    )
      .bind(TENANT, order.orderId, Date.now(), Date.now(), Date.now())
      .run();

    await processOutboxRowById(quietEnv().env, "email-bad");

    expect(await outboxRow("email-bad")).toMatchObject({ last_error: "invalid_payload", status: "failed" });
  });
});

describe("the order_confirmation job and its Swedish template", () => {
  async function job(overrides: Partial<Parameters<typeof createOrderConfirmationEmailJob>[0]["order"]> = {}) {
    const createdAt = Date.now();
    return createOrderConfirmationEmailJob({
      createdAt,
      deliveryId: await deliveryIdFromKey("email:order_confirmation:test"),
      expiresAt: createdAt + HOUR_MS,
      order: {
        currency: "SEK",
        deliveryMethod: "pickup",
        discountMinor: 0,
        items: [{ lineTotalMinor: 59_800, name: "Tröja <b>fet</b>", quantity: 2 }],
        orderNumber: "MC-1001",
        shippingCountry: null,
        shippingMinor: 0,
        shopName: "Melodie MC",
        subtotalMinor: 59_800,
        totalMinor: 59_800,
        vatMinor: 11_960,
        ...overrides,
      },
      recipient: "Kund@Example.test",
      tenantId: TENANT,
    });
  }

  it("renders order number, lines, totals and pickup in Swedish, escaping HTML", async () => {
    const message = renderAuthEmail(await job());

    expect(message.subject).toBe("Orderbekräftelse MC-1001");
    expect(message.text).toContain("Tack för din beställning hos Melodie MC!");
    expect(message.text).toContain("Ordernummer: MC-1001");
    expect(message.text).toContain("Leverans: Upphämtning i butiken");
    expect(message.text).toContain(`2 st Tröja <b>fet</b>: ${formatOrderMoney(59_800, "SEK")}`);
    expect(message.text).toContain(`Upphämtning: ${formatOrderMoney(0, "SEK")}`);
    expect(message.text).toContain(`Totalt: ${formatOrderMoney(59_800, "SEK")}`);
    expect(message.text).toContain(`varav moms: ${formatOrderMoney(11_960, "SEK")}`);
    expect(message.text).not.toContain("Rabatt");
    expect(message.html).toContain("Tröja &lt;b&gt;fet&lt;/b&gt;");
    expect(message.html).not.toContain("<b>fet");
    expect(formatOrderMoney(59_800, "SEK")).toMatch(/^598,00\skr$/);
  });

  it("renders shipping and a discount", async () => {
    const message = renderAuthEmail(
      await job({
        deliveryMethod: "shipping",
        discountMinor: 5_000,
        shippingCountry: "SE",
        shippingMinor: 4_900,
        totalMinor: 59_700,
      }),
    );

    expect(message.text).toContain("Leverans: Leverans till Sverige");
    expect(message.text).toContain(`Frakt: ${formatOrderMoney(4_900, "SEK")}`);
    expect(message.text).toContain(`Rabatt: -${formatOrderMoney(5_000, "SEK")}`);
  });

  it("refuses content the order could not have produced", async () => {
    await expect(job({ totalMinor: 1 })).rejects.toThrow();
    await expect(job({ items: [] })).rejects.toThrow();
    await expect(job({ deliveryMethod: "pickup", shippingCountry: "SE" })).rejects.toThrow();
    await expect(job({ orderNumber: "a\nb" })).rejects.toThrow();
    await expect(job({ vatMinor: 99_999_999 })).rejects.toThrow();
  });

  it("parses only a link-less, Swedish, tenant-bound job", async () => {
    const valid = JSON.parse(JSON.stringify(await job())) as Record<string, unknown>;
    expect(parseAuthEmailJob(valid, env.AUTH_BASE_URL)).toMatchObject({ kind: "order_confirmation" });
    for (const tampered of [
      { ...valid, actionUrl: `${env.AUTH_BASE_URL}/api/auth/verify-email` },
      { ...valid, locale: "en" },
      { ...valid, tenantId: undefined },
      { ...valid, deliveryId: "not-a-uuid" },
      { ...valid, order: { ...(valid.order as object), subtotalMinor: -1 } },
    ]) {
      expect(() => parseAuthEmailJob(tampered, env.AUTH_BASE_URL)).toThrow();
    }
  });

  it("derives a stable v4-shaped delivery id from the dedupe key", async () => {
    const one = await deliveryIdFromKey("email:order_confirmation:a");
    expect(await deliveryIdFromKey("email:order_confirmation:a")).toBe(one);
    expect(await deliveryIdFromKey("email:order_confirmation:b")).not.toBe(one);
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("the email ledger (0022)", () => {
  it("admits the order_confirmation kind, still refuses unknown kinds, and keeps its triggers", async () => {
    const insert = (id: string, kind: string, fingerprint: string | null) =>
      env.DB.prepare(
        `INSERT INTO email_deliveries (delivery_id, tenant_id, kind, recipient_hash, status,
           attempts, max_attempts, next_attempt_at, expires_at, created_at, updated_at, job_fingerprint)
         VALUES (?, NULL, ?, ?, 'pending', 0, 8, 1, 2, 1, 1, ?)`,
      )
        .bind(id, kind, "a".repeat(64), fingerprint)
        .run();

    await expect(insert(crypto.randomUUID(), "order_confirmation", "b".repeat(64))).resolves.toBeDefined();
    await expect(insert(crypto.randomUUID(), "newsletter", "b".repeat(64))).rejects.toThrow(/CHECK/);
    await expect(insert(crypto.randomUUID(), "password_reset", null)).rejects.toThrow(/fingerprint is required/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the ledger fingerprint covers the order content (Codex P2)", () => {
  // Pinned with the fingerprint algorithm as it was BEFORE order content was
  // added: every auth job already in a ledger or on a queue must keep matching.
  const GOLDEN: Array<[AuthEmailJob, string]> = [
    [
      {
        actionUrl: `${env.AUTH_BASE_URL}/api/auth/reset-password/golden-token?callbackURL=https%3A%2F%2Fweb.test.invalid%2Freset-password`,
        createdAt: 1_790_000_000_000,
        deliveryId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
        expiresAt: 1_790_003_600_000,
        kind: "password_reset",
        locale: "sv",
        recipient: "golden@example.test",
        version: 1,
      },
      "7f096b83a07b922932421624754f78c952ea42438731e8b3983517350c9a2ef3",
    ],
    [
      {
        actionUrl: `${env.AUTH_BASE_URL}/api/auth/verify-email?token=golden&callbackURL=%2F`,
        createdAt: 1_790_000_000_000,
        deliveryId: "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b",
        expiresAt: 1_790_003_600_000,
        kind: "email_verification",
        locale: "en",
        recipient: "golden@example.test",
        tenantId: "tenant-golden",
        version: 1,
      },
      "ce5167592b004c180b3efd653f37c6517a8d5f7b8530d3ad0ebba031b323dc32",
    ],
  ];

  async function confirmation(
    overrides: Partial<Parameters<typeof createOrderConfirmationEmailJob>[0]["order"]> = {},
    deliveryKey = "email:order_confirmation:fingerprint",
  ) {
    return createOrderConfirmationEmailJob({
      createdAt: 1_790_000_000_000,
      deliveryId: await deliveryIdFromKey(deliveryKey),
      expiresAt: 1_790_000_000_000 + HOUR_MS,
      order: {
        currency: "SEK",
        deliveryMethod: "pickup",
        discountMinor: 0,
        items: [{ lineTotalMinor: 29_900, name: "Tröja", quantity: 1 }],
        orderNumber: "MC-2001",
        shippingCountry: null,
        shippingMinor: 0,
        shopName: "Melodie MC",
        subtotalMinor: 29_900,
        totalMinor: 29_900,
        vatMinor: 5_980,
        ...overrides,
      },
      recipient: "kund@example.test",
      tenantId: TENANT,
    });
  }

  it("leaves every auth job's fingerprint byte-identical", async () => {
    for (const [job, fingerprint] of GOLDEN) {
      expect(await fingerprintAuthEmailJob(job)).toBe(fingerprint);
    }
  });

  it("gives confirmations that differ only in totals, lines or order number different fingerprints", async () => {
    const base = await fingerprintAuthEmailJob(await confirmation());
    const variants = [
      await confirmation({ vatMinor: 5_979 }),
      await confirmation({ discountMinor: 900, totalMinor: 29_000 }),
      await confirmation({ items: [{ lineTotalMinor: 29_900, name: "Tröja XL", quantity: 1 }] }),
      await confirmation({ orderNumber: "MC-2002" }),
      await confirmation({ shopName: null }),
    ];
    const fingerprints = await Promise.all(variants.map(fingerprintAuthEmailJob));
    expect(new Set([base, ...fingerprints]).size).toBe(variants.length + 1);
    // …and is still deterministic for the same content.
    expect(await fingerprintAuthEmailJob(await confirmation())).toBe(base);
  });

  it("refuses a tampered confirmation as a fingerprint conflict, and the consumer never sends it", async () => {
    const deliveryKey = `email:order_confirmation:tamper-${crypto.randomUUID()}`;
    const createdAt = Date.now();
    const original = createOrderConfirmationEmailJob({
      ...(await confirmation({}, deliveryKey)),
      createdAt,
      expiresAt: createdAt + HOUR_MS,
    });
    const tampered: OrderConfirmationEmailJob = {
      ...original,
      order: { ...original.order, discountMinor: 29_900, totalMinor: 0, vatMinor: 0 },
    };
    await recordAuthEmailDelivery(env.DB, original, createdAt);

    expect(await claimAuthEmailDelivery(env.DB, tampered, createdAt)).toEqual({ status: "conflict" });

    const resend = fakeResend();
    const { acks, batch } = emailBatch([
      JSON.parse(JSON.stringify(tampered)),
      JSON.parse(JSON.stringify(original)),
    ]);
    await worker.queue(batch, { ...env, [RESEND_FETCH_OVERRIDE]: resend.fetch } as unknown as Env);

    expect(acks).toEqual(["m0", "m1"]);
    expect(resend.calls).toHaveLength(1);
    const sent = await resend.calls[0]!.json<{ text: string }>();
    expect(sent.text).toContain(`Totalt: ${formatOrderMoney(29_900, "SEK")}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a confirmation is frozen at its first build (Codex P2)", () => {
  it("record → rename the shop → retry ⇒ sent exactly once, with the original name", async () => {
    const tenant = `tenant-outbox-email-rename-${crypto.randomUUID().slice(0, 8)}`;
    await seedTenant(tenant, "Gamla Butiken");
    const order = await seedOrder(tenant);
    const deliveryId = await deliveryIdFromKey(`email:order_confirmation:${order.orderId}`);

    // First attempt: the ledger row is recorded, then enqueueing fails.
    const first = await processOutboxRowById(
      quietEnv({ EMAIL_QUEUE: recordingQueue({ fail: true }).queue }).env,
      order.emailId,
    );
    expect(first).toMatchObject({ kind: "ran", outcome: { kind: "retry" } });
    expect((await ledger(deliveryId))?.status).toBe("pending");

    await env.DB.prepare("UPDATE tenants SET shop_name = 'Nya Butiken' WHERE tenant_id = ?")
      .bind(tenant)
      .run();

    const emails = recordingQueue();
    const retry = await processOutboxRowById(
      quietEnv({ EMAIL_QUEUE: emails.queue }).env,
      order.emailId,
      () => Date.now() + 2 * 60_000,
    );
    expect(retry).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(emails.sent).toHaveLength(1);
    const job = emails.sent[0] as OrderConfirmationEmailJob;
    expect(job.order.shopName).toBe("Gamla Butiken");

    // The -email consumer accepts it (same fingerprint as the ledger row) and
    // sends it once.
    const resend = fakeResend();
    const { acks, batch } = emailBatch([JSON.parse(JSON.stringify(job))]);
    await worker.queue(batch, { ...env, [RESEND_FETCH_OVERRIDE]: resend.fetch } as unknown as Env);

    expect(acks).toEqual(["m0"]);
    expect(resend.calls).toHaveLength(1);
    const sent = await resend.calls[0]!.json<{ text: string }>();
    expect(sent.text).toContain("Tack för din beställning hos Gamla Butiken!");
    expect((await ledger(deliveryId))?.status).toBe("sent");
  });

  it("freezes exactly what the job renders, once, on the first build", async () => {
    const order = await seedOrder(TENANT);
    const emails = recordingQueue();

    await processOutboxRowById(quietEnv({ EMAIL_QUEUE: emails.queue }).env, order.emailId);

    const row = await env.DB.prepare("SELECT frozen_json FROM outbox_events WHERE outbox_id = ?")
      .bind(order.emailId)
      .first<{ frozen_json: string }>();
    const job = emails.sent[0] as OrderConfirmationEmailJob;
    expect(JSON.parse(row!.frozen_json)).toEqual({ confirmation: job.order });
    // The recipient is not copied into the outbox: it is the order's own,
    // immutable customer_email.
    expect(row!.frozen_json).not.toContain(job.recipient);
  });

  it("keeps the frozen payload write-once and well-formed (0022)", async () => {
    const order = await seedOrder(TENANT);
    const update = (value: string | null) =>
      env.DB.prepare("UPDATE outbox_events SET frozen_json = ? WHERE outbox_id = ?")
        .bind(value, order.emailId)
        .run();

    await expect(update("[1]")).rejects.toThrow(/CHECK/);
    await expect(update("not json")).rejects.toThrow(/CHECK/);
    await update('{"confirmation":{}}');
    await expect(update('{"confirmation":{"shopName":"other"}}')).rejects.toThrow(/write-once/);
    await expect(update(null)).rejects.toThrow(/write-once/);
  });
});
