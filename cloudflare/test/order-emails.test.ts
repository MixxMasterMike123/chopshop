import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { deliveryIdFromKey, formatOrderMoney, parseAuthEmailJob, renderAuthEmail } from "../src/email/auth-email-job";
import { fingerprintAuthEmailJob } from "../src/email/email-delivery-store";
import { RESEND_FETCH_OVERRIDE } from "../src/email/email-queue-consumer";
import { createOrderEmailJob, type OrderEmailJob } from "../src/email/order-emails";
import { processOutboxRowById } from "../src/outbox/effects";
import { alertsFor, outboxRow, recordingQueue, seedOrder } from "./dispatch-fixtures";
import type { Admin } from "./money-fixtures";
import {
  adminRequest,
  FakeMoneyStripe,
  moneyEnv,
  next,
  postEvent,
  seedCheckout,
  seedTenant,
  signUpAdmin,
  snapshotJson,
} from "./money-fixtures";
import { dyingDb, opWrites } from "./slice-harness";

/**
 * CP5-WE — the order mails on the Worker (src/email/order-emails.ts,
 * src/outbox/email-effect.ts, migration 0050):
 *   order_notice_shop    the shop's new-order notice, in the order's batch;
 *   refund_notice        the buyer's, written when a refund SETTLES;
 *   order_status_update  the buyer's, the consumer of CP5-WB's rows.
 * And: a retry never sends twice; no sender configured changes nothing in the
 * money path; shop A's order never mails shop B; the notice carries no
 * platform figure; 0050 keeps every ledger row.
 */

const TENANT_A = "tenant-we-a";
const TENANT_B = "tenant-we-b";
const HOUR_MS = 60 * 60 * 1_000;
const FEE_MINOR = 13_300;
const WITHHELD_MINOR = 12_300;
const CHARGE_MINOR = 20_000;

let accountA: string;
let adminA: Admin;
let stripe: FakeMoneyStripe;

beforeAll(async () => {
  accountA = (await seedTenant(TENANT_A, { shopName: "Melodie <MC> & Co" })) as string;
  await seedTenant(TENANT_B, { shopName: "Butik B" });
  adminA = await signUpAdmin("we-admin-a@example.test", TENANT_A);
  await signUpAdmin("we-admin-b@example.test", TENANT_B);
});

beforeEach(() => {
  stripe = new FakeMoneyStripe();
});

// ── helpers ─────────────────────────────────────────────────────────────────

/** env with recording queues: nothing reaches the pool's own consumers. */
function quiet(overrides: Record<PropertyKey, unknown> = {}) {
  const emails = recordingQueue();
  const nudges = recordingQueue();
  return {
    emails,
    env: {
      ...moneyEnv(stripe),
      EMAIL_QUEUE: emails.queue,
      OUTBOX_QUEUE: nudges.queue,
      ...overrides,
    } as unknown as Env,
    nudges,
  };
}

async function pay(
  tenantId: string,
  options: { accountId?: string; env?: Env } = {},
): Promise<{ checkoutId: string; orderId: string; paymentIntentId: string }> {
  const checkout = await seedCheckout({
    connect: { accountId: options.accountId ?? accountA, feeMinor: FEE_MINOR, withheldMinor: WITHHELD_MINOR },
    snapshot: snapshotJson([
      { lineNo: 1, productionCostMinor: 9_840, quantity: 1, sku: "2500170", withholdMinor: WITHHELD_MINOR },
    ]),
    tenantId,
    unitPriceMinor: CHARGE_MINOR,
  });
  const { response } = await postEvent(
    "payment_intent.succeeded",
    {
      amount: checkout.totalMinor,
      currency: "sek",
      id: checkout.paymentIntentId,
      metadata: { checkout_id: checkout.checkoutId, tenant_id: tenantId },
      object: "payment_intent",
      status: "succeeded",
    },
    { env: options.env ?? quiet().env },
  );
  expect(response.status).toBe(200);
  const order = await env.DB.prepare("SELECT order_id FROM orders WHERE checkout_id = ?")
    .bind(checkout.checkoutId)
    .first<{ order_id: string }>();
  stripe.addIntent({ amount: CHARGE_MINOR, id: checkout.paymentIntentId as string, status: "succeeded" });
  return { checkoutId: checkout.checkoutId, orderId: order!.order_id, paymentIntentId: checkout.paymentIntentId as string };
}

async function rowByKey(dedupeKey: string) {
  return env.DB.prepare(
    "SELECT outbox_id, tenant_id, event_type, aggregate_id, payload_json, status, last_error, frozen_json FROM outbox_events WHERE dedupe_key = ?",
  )
    .bind(dedupeKey)
    .first<{
      aggregate_id: string;
      event_type: string;
      frozen_json: string | null;
      last_error: string | null;
      outbox_id: string;
      payload_json: string;
      status: string;
      tenant_id: string;
    }>();
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? -1;
}

async function ledger(deliveryId: string) {
  return env.DB.prepare("SELECT kind, status, tenant_id FROM email_deliveries WHERE delivery_id = ?")
    .bind(deliveryId)
    .first<{ kind: string; status: string; tenant_id: string }>();
}

interface ResendCall {
  body: { html: string; reply_to?: string; subject: string; text: string; to: string[] };
  idempotencyKey: string | null;
}

/** Hands `jobs` to the REAL -email consumer with a fake Resend. */
async function consume(jobs: unknown[], extra: Record<PropertyKey, unknown> = {}) {
  const calls: ResendCall[] = [];
  const acks: string[] = [];
  const retries: string[] = [];
  const retriedAll: number[] = [];
  const batch = {
    messages: jobs.map((body, index) => ({
      ack: () => acks.push(`m${index}`),
      attempts: 1,
      body: JSON.parse(JSON.stringify(body)) as unknown,
      id: `m${index}`,
      retry: () => retries.push(`m${index}`),
      timestamp: new Date(),
    })),
    queue: "chopshop-test-email",
    retryAll: (options?: { delaySeconds?: number }) => retriedAll.push(options?.delaySeconds ?? 0),
  } as unknown as MessageBatch<unknown>;
  await worker.queue(batch, {
    ...env,
    [RESEND_FETCH_OVERRIDE]: async (request: Request) => {
      calls.push({ body: await request.json(), idempotencyKey: request.headers.get("idempotency-key") });
      return Response.json({ id: `re_${crypto.randomUUID()}` });
    },
    ...extra,
  } as unknown as Env);
  return { acks, calls, retriedAll, retries };
}

function plainOrder(tenantId: string, deliveryMethod: "pickup" | "shipping") {
  return seedOrder(tenantId, { deliveryMethod, lines: [{ name: "Tröja <svart>", production: "none" }] });
}

async function addRecipient(orderId: string, tenantId: string, deliveryMethod: "pickup" | "shipping") {
  await env.DB.prepare(
    `INSERT INTO order_recipients (
       order_id, tenant_id, delivery_method, name, address_line1, postal_code, city, country,
       pickup_location_id, pickup_location_name, pickup_location_address, created_at
     ) VALUES (?, ?, ?, 'Kim <Kund>', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      orderId,
      tenantId,
      deliveryMethod,
      deliveryMethod === "shipping" ? "Gatan 1" : null,
      deliveryMethod === "shipping" ? "123 45" : null,
      deliveryMethod === "shipping" ? "Malmö" : null,
      deliveryMethod === "shipping" ? "SE" : null,
      deliveryMethod === "pickup" ? "place-1" : null,
      deliveryMethod === "pickup" ? "Butiken <Söder>" : null,
      deliveryMethod === "pickup" ? "Götgatan 1, Stockholm" : null,
      new Date().toISOString(),
    )
    .run();
}

async function fulfil(orderId: string, body: Record<string, unknown>, envOverride?: Env): Promise<string> {
  const response = await worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}/fulfilment`, "POST", {
      body,
      cookie: adminA.cookie,
      idempotencyKey: crypto.randomUUID(),
      shopId: TENANT_A,
    }),
    envOverride ?? quiet().env,
  );
  expect(response.status, JSON.stringify(body)).toBe(200);
  const row = await env.DB.prepare(
    `SELECT outbox_id FROM outbox_events
     WHERE event_type = 'email.order_status' AND aggregate_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(orderId)
    .first<{ outbox_id: string }>();
  return row!.outbox_id;
}

/** Runs one outbox row with recording queues; returns the jobs it queued. */
async function runRow(outboxId: string, overrides: Record<PropertyKey, unknown> = {}, clock?: () => number) {
  const q = quiet(overrides);
  const result = await processOutboxRowById(q.env, outboxId, clock);
  return { jobs: q.emails.sent as OrderEmailJob[], result };
}

async function refund(orderId: string, amountMinor: number, envOverride?: Env): Promise<Response> {
  return worker.fetch(
    adminRequest(`/v1/admin/orders/${orderId}/refunds`, "POST", {
      body: { amountMinor, reason: "kund" },
      cookie: adminA.cookie,
      shopId: TENANT_A,
    }),
    envOverride ?? quiet().env,
  );
}

function refundObject(refundView: { amount: number; id: string; metadata?: Record<string, string> }, paymentIntentId: string, status: string) {
  return {
    amount: refundView.amount,
    currency: "sek",
    id: refundView.id,
    metadata: refundView.metadata ?? {},
    object: "refund",
    payment_intent: paymentIntentId,
    status,
  };
}

const money = (minor: number) => formatOrderMoney(minor, "SEK");

// ═══════════════════════════════════════════════════════════════════════════
describe("migration 0050 keeps every ledger row (a staged rebuild)", () => {
  it("rebuilds 0044's email_deliveries with rows of every kind in it, and reads every row back unchanged", async () => {
    const migrations = env.TEST_MIGRATIONS;
    const m0044 = migrations.find((m) => m.name === "0044_withdrawals.sql");
    const m0050 = migrations.find((m) => m.name === "0050_email_kinds.sql");
    expect(m0044).toBeDefined();
    expect(m0050).toBeDefined();
    // Nothing between 0044 and 0050 touches the table, so 0044's rebuild IS
    // the shape 0050 meets on a deployed database.
    for (const m of migrations.filter((m) => m.name > "0045" && m.name < "0050")) {
      expect(m.queries.some((q) => q.includes("email_deliveries")), m.name).toBe(false);
    }
    const exec = (queries: string[]) => env.DB.batch(queries.map((q) => env.DB.prepare(q)));

    // 1. Back to the 0044 shape (its own statements; rows carried).
    await exec(m0044!.queries.filter((q) => q.includes("email_deliveries")));
    const insert = (row: Record<string, unknown>) =>
      env.DB.prepare(
        `INSERT INTO email_deliveries (delivery_id, tenant_id, kind, recipient_hash, status, attempts,
           max_attempts, next_attempt_at, lease_token, lease_until, provider_message_id, expires_at,
           last_error_code, resolved_at, created_at, updated_at, job_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, 8, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          row.delivery_id,
          row.tenant_id,
          row.kind,
          "a".repeat(64),
          row.status,
          row.attempts,
          100,
          row.lease_token ?? null,
          row.lease_until ?? null,
          row.provider_message_id ?? null,
          10_000,
          row.last_error_code ?? null,
          row.resolved_at ?? null,
          50,
          60,
          "b".repeat(64),
        )
        .run();
    // The old shape refuses the new kinds: this really is the 0044 table.
    await expect(
      insert({ attempts: 0, delivery_id: crypto.randomUUID(), kind: "order_status_update", status: "pending", tenant_id: TENANT_A }),
    ).rejects.toThrow(/CHECK/);

    const rows = [
      { attempts: 0, kind: "email_verification", status: "pending", tenant_id: TENANT_A },
      { attempts: 1, kind: "password_reset", lease_token: "lease-1", lease_until: 200, status: "processing", tenant_id: null },
      { attempts: 1, kind: "order_confirmation", provider_message_id: `re_${crypto.randomUUID()}`, resolved_at: 70, status: "sent", tenant_id: TENANT_A },
      { attempts: 8, kind: "alert_digest", last_error_code: "E_PROVIDER_500", resolved_at: 80, status: "failed", tenant_id: null },
      { attempts: 2, kind: "withdrawal_receipt", resolved_at: 90, status: "expired", tenant_id: TENANT_B },
      { attempts: 0, kind: "withdrawal_notice", status: "pending", tenant_id: TENANT_B },
    ].map((row) => ({ ...row, delivery_id: crypto.randomUUID() }));
    for (const row of rows) {
      await insert(row);
    }
    const ids = rows.map((row) => row.delivery_id);
    const read = () =>
      env.DB.prepare(
        `SELECT * FROM email_deliveries WHERE delivery_id IN (${ids.map(() => "?").join(", ")}) ORDER BY delivery_id`,
      )
        .bind(...ids)
        .all();
    const before = (await read()).results;
    const totalBefore = await count("SELECT COUNT(*) AS n FROM email_deliveries");
    expect(before).toHaveLength(6);

    // 2. 0050, as wrangler applies it.
    await exec(m0050!.queries);

    expect((await read()).results).toEqual(before);
    expect(await count("SELECT COUNT(*) AS n FROM email_deliveries")).toBe(totalBefore);
    for (const kind of ["order_status_update", "order_notice_shop", "refund_notice"]) {
      await expect(
        insert({ attempts: 0, delivery_id: crypto.randomUUID(), kind, status: "pending", tenant_id: TENANT_A }),
      ).resolves.toBeDefined();
    }
    await expect(
      insert({ attempts: 0, delivery_id: crypto.randomUUID(), kind: "newsletter", status: "pending", tenant_id: TENANT_A }),
    ).rejects.toThrow(/CHECK/);
    // Triggers and indexes, re-declared.
    await expect(
      env.DB.prepare("UPDATE email_deliveries SET tenant_id = ? WHERE delivery_id = ?").bind(TENANT_B, ids[0]).run(),
    ).rejects.toThrow(/tenant_id is immutable/);
    await expect(
      env.DB.prepare(
        `INSERT INTO email_deliveries (delivery_id, tenant_id, kind, recipient_hash, status, attempts,
           max_attempts, next_attempt_at, expires_at, created_at, updated_at, job_fingerprint)
         VALUES (?, NULL, 'refund_notice', ?, 'pending', 0, 8, 1, 2, 1, 1, NULL)`,
      )
        .bind(crypto.randomUUID(), "a".repeat(64))
        .run(),
    ).rejects.toThrow(/fingerprint is required/);
    const schema = await env.DB.prepare(
      "SELECT type, name FROM sqlite_master WHERE tbl_name = 'email_deliveries' AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all<{ name: string; type: string }>();
    expect(schema.results).toEqual([
      { name: "email_deliveries_due_idx", type: "index" },
      { name: "email_deliveries_lease_idx", type: "index" },
      { name: "email_deliveries_tenant_created_idx", type: "index" },
      { name: "email_deliveries", type: "table" },
      { name: "email_deliveries_fingerprint_required", type: "trigger" },
      { name: "email_deliveries_tenant_immutable", type: "trigger" },
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'email_deliveries_migration_%'")).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("order_notice_shop: in the order's batch", () => {
  it("is written with the order — ids only — and a batch that dies leaves neither", async () => {
    const checkout = await seedCheckout({ tenantId: TENANT_A, unitPriceMinor: 15_000 });
    const object = {
      amount: checkout.totalMinor,
      currency: "sek",
      id: checkout.paymentIntentId,
      metadata: { checkout_id: checkout.checkoutId, tenant_id: TENANT_A },
      object: "payment_intent",
      status: "succeeded",
    };
    const notices = () => count("SELECT COUNT(*) AS n FROM outbox_events WHERE dedupe_key LIKE 'email:order_notice_shop:%'");
    const before = await notices();
    const dying = dyingDb(() => true, (op) => op.kind === "batch" && opWrites(op, /INSERT INTO orders\b/));

    const died = await postEvent("payment_intent.succeeded", object, { env: { ...quiet().env, DB: dying.db } as Env }).then(
      ({ response }) => response.status,
      () => "threw",
    );

    expect(["threw", 500]).toContain(died);
    expect(await count("SELECT COUNT(*) AS n FROM orders WHERE checkout_id = ?", checkout.checkoutId)).toBe(0);
    expect(await notices(), "no notice without its order").toBe(before);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id NOT IN (SELECT order_id FROM orders)",
      ),
    ).toBe(0);

    // Stripe retries: the order and its notice, together, in ONE batch.
    const recorder = dyingDb(() => false);
    const retried = await postEvent("payment_intent.succeeded", object, { env: { ...quiet().env, DB: recorder.db } as Env });
    expect(retried.response.status).toBe(200);
    const orderBatch = recorder.ops.filter((op) => op.kind === "batch" && opWrites(op, /INSERT INTO orders\b/));
    expect(orderBatch).toHaveLength(1);
    expect(orderBatch[0]!.sql.filter((sql) => /INSERT INTO outbox_events\b/.test(sql))).toHaveLength(2);
    expect(
      recorder.ops.filter((op) => op !== orderBatch[0] && opWrites(op, /INSERT INTO outbox_events\b/)),
      "no outbox row outside the order batch",
    ).toHaveLength(0);

    const order = await env.DB.prepare("SELECT order_id FROM orders WHERE checkout_id = ?")
      .bind(checkout.checkoutId)
      .first<{ order_id: string }>();
    const row = await rowByKey(`email:order_notice_shop:${order!.order_id}`);
    expect(row).toMatchObject({ event_type: "email", status: "pending", tenant_id: TENANT_A });
    expect(JSON.parse(row!.payload_json)).toEqual({ kind: "order_notice_shop", orderId: order!.order_id });
    expect(await notices()).toBe(before + 1);
  });
});

describe("order_notice_shop: the effect and the mail", () => {
  it("mails the shop's support address the lines and what the buyer paid — no platform figure", async () => {
    const { orderId } = await pay(TENANT_A);
    const row = await rowByKey(`email:order_notice_shop:${orderId}`);

    const { jobs, result } = await runRow(row!.outbox_id);

    expect(result).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job).toMatchObject({
      deliveryId: await deliveryIdFromKey(`email:order_notice_shop:${orderId}`),
      kind: "order_notice_shop",
      recipient: `ops-${TENANT_A}@example.test`,
      tenantId: TENANT_A,
    });
    expect(job.content).toMatchObject({
      adminUrl: `https://admin.test.invalid/admin/orders/${orderId}`,
      deliveryMethod: "pickup",
      items: [{ lineTotalMinor: CHARGE_MINOR, name: "Tee 0", quantity: 1 }],
      shopName: "Melodie <MC> & Co",
      totalMinor: CHARGE_MINOR,
    });
    // The content carries no key a platform figure could hide in.
    expect(Object.keys(job.content).sort()).toEqual([
      "adminUrl", "currency", "deliveryMethod", "discountMinor", "items", "orderNumber",
      "pickupPlaceName", "shippingCountry", "shippingMinor", "shopName", "subtotalMinor",
      "totalMinor", "vatMinor",
    ]);
    expect(await ledger(job.deliveryId)).toMatchObject({ kind: "order_notice_shop", status: "pending", tenant_id: TENANT_A });

    const { calls } = await consume(jobs);
    expect(calls).toHaveLength(1);
    const mail = calls[0]!.body;
    expect(mail.to).toEqual([`ops-${TENANT_A}@example.test`]);
    expect(mail.reply_to).toBeUndefined();
    expect(mail.subject).toMatch(/^Ny beställning: /);
    expect(mail.text).toContain(`1 st Tee 0: ${money(CHARGE_MINOR)}`);
    expect(mail.text).toContain(`Totalt: ${money(CHARGE_MINOR)}`);
    for (const hidden of [FEE_MINOR, WITHHELD_MINOR, CHARGE_MINOR - FEE_MINOR, 9_840]) {
      expect(mail.text).not.toContain(money(hidden));
      expect(mail.html).not.toContain(money(hidden));
    }
    expect(mail.text).not.toMatch(/avgift|provision|utbetal|tryck|inköp/i);
    expect(mail.html).toContain("Melodie &lt;MC&gt; &amp; Co");
    expect(mail.html).not.toContain("<MC>");
    expect(mail.html).toContain(`<a href="https://admin.test.invalid/admin/orders/${orderId}">Hantera order</a>`);
  });

  it("falls back to the shop's oldest active admin when it has no support address", async () => {
    const tenant = `tenant-we-noaddr-${crypto.randomUUID().slice(0, 8)}`;
    const account = (await seedTenant(tenant)) as string;
    await env.DB.prepare("UPDATE tenants SET support_email = NULL WHERE tenant_id = ?").bind(tenant).run();
    await signUpAdmin(`first-${tenant}@example.test`, tenant);
    await signUpAdmin(`second-${tenant}@example.test`, tenant);
    const { orderId } = await pay(tenant, { accountId: account });

    const { jobs } = await runRow((await rowByKey(`email:order_notice_shop:${orderId}`))!.outbox_id);

    expect(jobs.map((job) => job.recipient)).toEqual([`first-${tenant}@example.test`]);
  });

  it("fails visibly (outbox failed + alert) when the shop has no address at all", async () => {
    const tenant = `tenant-we-none-${crypto.randomUUID().slice(0, 8)}`;
    const account = (await seedTenant(tenant)) as string;
    await env.DB.prepare("UPDATE tenants SET support_email = 'hello@example.com' WHERE tenant_id = ?").bind(tenant).run();
    const { orderId } = await pay(tenant, { accountId: account });
    const row = await rowByKey(`email:order_notice_shop:${orderId}`);

    const { jobs, result } = await runRow(row!.outbox_id);

    expect(result).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    expect(jobs).toHaveLength(0);
    expect(await outboxRow(row!.outbox_id)).toMatchObject({ last_error: "no_shop_address", status: "failed" });
    expect((await alertsFor(row!.outbox_id)).map((alert) => alert.kind)).toEqual(["outbox_failed"]);
  });

  it("never mails another shop: a row filed under shop B naming shop A's order finds nothing", async () => {
    const { orderId } = await pay(TENANT_A);
    const forged = `forged-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO outbox_events (outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
         dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'email', 'order', ?, ?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(forged, TENANT_B, orderId, `forged:${forged}`, JSON.stringify({ kind: "order_notice_shop", orderId }), Date.now(), Date.now(), Date.now())
      .run();

    const { jobs, result } = await runRow(forged);

    expect(result).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    expect(jobs).toHaveLength(0);
    expect((await outboxRow(forged)).last_error).toBe("order_not_found");

    // And shop A's own notice goes to shop A's address, never to B's.
    const own = await runRow((await rowByKey(`email:order_notice_shop:${orderId}`))!.outbox_id);
    expect(own.jobs.map((job) => [job.recipient, job.tenantId])).toEqual([[`ops-${TENANT_A}@example.test`, TENANT_A]]);
  });

  it("freezes its recipient: an address changed between a recorded attempt and its retry still mails once, to the first", async () => {
    const tenant = `tenant-we-freeze-${crypto.randomUUID().slice(0, 8)}`;
    const account = (await seedTenant(tenant)) as string;
    const { orderId } = await pay(tenant, { accountId: account });
    const row = await rowByKey(`email:order_notice_shop:${orderId}`);

    const first = await processOutboxRowById(
      quiet({ EMAIL_QUEUE: recordingQueue({ fail: true }).queue }).env,
      row!.outbox_id,
    );
    expect(first).toMatchObject({ kind: "ran", outcome: { kind: "retry" } });
    await env.DB.prepare("UPDATE tenants SET support_email = 'new@shop.test' WHERE tenant_id = ?").bind(tenant).run();

    const retry = await runRow(row!.outbox_id, {}, () => Date.now() + 2 * 60_000);

    expect(retry.jobs.map((job) => job.recipient)).toEqual([`ops-${tenant}@example.test`]);
    const { calls } = await consume(retry.jobs);
    expect(calls.map((call) => call.body.to)).toEqual([[`ops-${tenant}@example.test`]]);
    expect((await ledger(retry.jobs[0]!.deliveryId))?.status).toBe("sent");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("refund_notice: written when the refund SETTLES, never on a reservation", () => {
  const notices = (orderId: string) =>
    count("SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ? AND dedupe_key LIKE 'email:refund_notice:%'", orderId);

  it("a settled full refund writes ONE notice in its batch; the buyer is mailed the server's amount", async () => {
    const order = await pay(TENANT_A);

    const response = await refund(order.orderId, CHARGE_MINOR);

    expect(response.status).toBe(201);
    const { refund: settled } = await response.json<{ refund: { refundId: string; state: string } }>();
    expect(settled.state).toBe("succeeded");
    expect(await notices(order.orderId)).toBe(1);
    const row = await rowByKey(`email:refund_notice:${settled.refundId}`);
    expect(row).toMatchObject({ outbox_id: `email-refund-notice:${settled.refundId}`, status: "pending", tenant_id: TENANT_A });
    expect(JSON.parse(row!.payload_json)).toEqual({
      full: true,
      kind: "refund_notice",
      operationId: settled.refundId,
      orderId: order.orderId,
    });

    const { jobs } = await runRow(row!.outbox_id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      content: { amountMinor: CHARGE_MINOR, currency: "SEK", full: true, supportEmail: `ops-${TENANT_A}@example.test` },
      kind: "refund_notice",
    });
    const { calls } = await consume(jobs);
    const mail = calls[0]!.body;
    expect(mail.to).toEqual([jobs[0]!.recipient]);
    expect(mail.reply_to).toBe(`ops-${TENANT_A}@example.test`);
    expect(mail.subject).toMatch(/^Återbetalning – order /);
    expect(mail.text).toContain(`Återbetalat belopp: ${money(CHARGE_MINOR)}`);
    expect(mail.text).toContain("full återbetalning");
  });

  it("a partial refund says partial; the one that completes the charge says full", async () => {
    const order = await pay(TENANT_A);

    await refund(order.orderId, 7_000);
    await refund(order.orderId, CHARGE_MINOR - 7_000);

    const rows = await env.DB.prepare(
      "SELECT payload_json FROM outbox_events WHERE aggregate_id = ? AND dedupe_key LIKE 'email:refund_notice:%' ORDER BY created_at, rowid",
    )
      .bind(order.orderId)
      .all<{ payload_json: string }>();
    expect(rows.results.map((r) => (JSON.parse(r.payload_json) as { full: boolean }).full)).toEqual([false, true]);
  });

  it("a reserved (202) refund writes nothing; its settlement writes one; replays write no more", async () => {
    const order = await pay(TENANT_A);
    stripe.loseRefundResponse = true;

    const response = await refund(order.orderId, 6_000);

    expect(response.status).toBe(202);
    expect(await notices(order.orderId), "a reservation is not a refund").toBe(0);

    const atStripe = [...stripe.refunds.values()][0]!;
    const object = refundObject(atStripe, order.paymentIntentId, "succeeded");
    const hook = await postEvent("refund.created", object, { env: quiet().env });
    expect(hook.response.status).toBe(200);
    expect(await notices(order.orderId)).toBe(1);
    await postEvent("refund.created", object, { env: quiet().env, eventId: hook.eventId });
    await postEvent("refund.updated", object, { env: quiet().env });
    expect(await notices(order.orderId), "settled once, noticed once").toBe(1);
  });

  it("a pending refund writes nothing until it succeeds; a failed one never does", async () => {
    const order = await pay(TENANT_A);
    stripe.refundStatus = "pending";

    expect((await refund(order.orderId, 5_000)).status).toBe(201);
    expect((await refund(order.orderId, 4_000)).status).toBe(201);
    expect(await notices(order.orderId)).toBe(0);

    const [first, second] = [...stripe.refunds.keys()];
    await postEvent("refund.updated", refundObject(stripe.setRefundStatus(first!, "failed"), order.paymentIntentId, "failed"), { env: quiet().env });
    expect(await notices(order.orderId)).toBe(0);
    await postEvent("refund.updated", refundObject(stripe.setRefundStatus(second!, "succeeded"), order.paymentIntentId, "succeeded"), { env: quiet().env });
    expect(await notices(order.orderId)).toBe(1);
  });

  it("a dashboard refund that arrives succeeded is noticed once", async () => {
    const order = await pay(TENANT_A);
    const object = refundObject({ amount: 3_000, id: next("re") }, order.paymentIntentId, "succeeded");

    await postEvent("refund.created", object, { env: quiet().env });
    await postEvent("charge.refunded", {
      amount: CHARGE_MINOR,
      amount_refunded: 3_000,
      id: next("ch"),
      object: "charge",
      payment_intent: order.paymentIntentId,
      refunds: { data: [object], object: "list" },
    }, { env: quiet().env });

    expect(await notices(order.orderId)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("order_status_update: the consumer of CP5-WB's rows", () => {
  it("the routes nudge their mail at once: the status mail after a fulfilment step, the notice after a settled refund", async () => {
    const order = await plainOrder(TENANT_A, "shipping");
    await addRecipient(order.orderId, TENANT_A, "shipping");
    const first = quiet();
    const outboxId = await fulfil(order.orderId, { to: "processing" }, first.env);
    expect(first.nudges.sent).toContainEqual({ outboxId });

    const paid = await pay(TENANT_A);
    const second = quiet();
    const response = await refund(paid.orderId, CHARGE_MINOR, second.env);
    expect(response.status).toBe(201);
    const { refund: settled } = await response.json<{ refund: { refundId: string } }>();
    expect(second.nudges.sent).toContainEqual({ outboxId: `email-refund-notice:${settled.refundId}` });
    // Only this order's rows: the other order's status mail is not nudged again.
    expect(second.nudges.sent).not.toContainEqual({ outboxId });
  });

  it("mails processing, shipped (tracking + carrier), a further parcel and delivered; completed mails nothing", async () => {
    const order = await plainOrder(TENANT_A, "shipping");
    await addRecipient(order.orderId, TENANT_A, "shipping");

    const steps: Array<[Record<string, unknown>, RegExp | null]> = [
      [{ to: "processing" }, /Status: Behandlas/],
      [{ carrier: "<b>PostNord</b>", to: "shipped", trackingNumber: "TRK-1" }, /Spårningsnummer: TRK-1\nFraktbolag: <b>PostNord<\/b>/],
      [{ to: "shipped", trackingNumber: "TRK-2" }, /Ytterligare ett paket/],
      [{ to: "delivered" }, /Status: Levererad/],
      [{ to: "completed" }, null],
    ];
    for (const [body, expected] of steps) {
      const outboxId = await fulfil(order.orderId, body);
      const { jobs, result } = await runRow(outboxId);
      expect(result, String(body.to)).toEqual({ kind: "ran", outcome: { kind: "done" } });
      if (expected === null) {
        expect(jobs, "completed sends nothing").toHaveLength(0);
        expect((await outboxRow(outboxId)).result_ref).toBeNull();
        continue;
      }
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      expect(job.kind).toBe("order_status_update");
      expect(job.recipient).toBe((await env.DB.prepare("SELECT customer_email FROM orders WHERE order_id = ?").bind(order.orderId).first<{ customer_email: string }>())!.customer_email);
      const rendered = renderAuthEmail(job);
      expect(rendered.text).toMatch(expected);
      expect(rendered.text).toContain("Hej Kim <Kund>,");
      expect(rendered.html).toContain("Hej Kim &lt;Kund&gt;,");
      expect(rendered.html).not.toContain("<b>PostNord");
      expect(rendered.subject).toContain(order.orderNumber);
      // The buyer's name and address are never frozen on the outbox row.
      const frozen = (await outboxRow(outboxId)).frozen_json ?? "";
      expect(frozen).not.toContain("Kim");
      expect(frozen).not.toContain(job.recipient);
    }
  });

  it("ready for pickup names the place", async () => {
    const order = await plainOrder(TENANT_A, "pickup");
    await addRecipient(order.orderId, TENANT_A, "pickup");

    const { jobs } = await runRow(await fulfil(order.orderId, { to: "ready_for_pickup" }));

    const rendered = renderAuthEmail(jobs[0]!);
    expect(rendered.subject).toBe(`Orderuppdatering: ${order.orderNumber} – Redo att hämtas`);
    expect(rendered.text).toContain("Upphämtningsställe: Butiken <Söder>");
    expect(rendered.text).toContain("Adress: Götgatan 1, Stockholm");
    expect(rendered.html).toContain("Butiken &lt;Söder&gt;");
  });

  it("answers to the shop: Reply-To is its support address", async () => {
    const order = await plainOrder(TENANT_A, "shipping");
    const { jobs } = await runRow(await fulfil(order.orderId, { to: "processing" }));

    const { calls } = await consume(jobs);

    expect(calls[0]!.body.reply_to).toBe(`ops-${TENANT_A}@example.test`);
    expect(calls[0]!.body.text).toContain("Hej,");
  });

  it("a retry after a crash re-queues the identical job and the consumer sends ONE email", async () => {
    const order = await plainOrder(TENANT_A, "shipping");
    const outboxId = await fulfil(order.orderId, { to: "processing" });
    const emails = recordingQueue();
    let crashed = false;
    const dyingDbProxy = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch" && crashed) {
          return () => Promise.reject(new Error("worker died"));
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const crashing = {
      ...quiet().env,
      DB: dyingDbProxy,
      EMAIL_QUEUE: {
        async send(body: unknown) {
          await emails.queue.send(body);
          crashed = true;
        },
      },
    } as unknown as Env;

    await expect(processOutboxRowById(crashing, outboxId)).rejects.toThrow("worker died");
    expect((await outboxRow(outboxId)).status).toBe("submitting");
    await processOutboxRowById(quiet({ EMAIL_QUEUE: emails.queue }).env, outboxId, () => Date.now() + 6 * 60_000);
    expect((await outboxRow(outboxId)).status).toBe("done");
    expect(emails.sent).toHaveLength(2);
    expect(emails.sent[1]).toEqual(emails.sent[0]);

    const { acks, calls } = await consume(emails.sent);
    expect(acks).toEqual(["m0", "m1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.idempotencyKey).toBe((emails.sent[0] as OrderEmailJob).deliveryId);
    // A done row is not run again.
    expect(await processOutboxRowById(quiet().env, outboxId)).toEqual({ kind: "settled" });
  });

  it("never reads another shop's history: a row filed under shop B fails, nothing is queued", async () => {
    const order = await plainOrder(TENANT_A, "shipping");
    const outboxId = await fulfil(order.orderId, { to: "processing" });
    const payload = (await outboxRow(outboxId)).payload_json;
    const forged = `forged-status-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO outbox_events (outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
         dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'email.order_status', 'order', ?, ?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(forged, TENANT_B, order.orderId, `forged:${forged}`, payload, Date.now(), Date.now(), Date.now())
      .run();

    const { jobs, result } = await runRow(forged);

    expect(result).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    expect(jobs).toHaveLength(0);
    expect((await outboxRow(forged)).last_error).toBe("history_not_found");
  });

  it("refuses a payload that is not exactly { historyId, orderId }", async () => {
    const order = await plainOrder(TENANT_A, "shipping");
    const outboxId = `bad-status-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO outbox_events (outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
         dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'email.order_status', 'order', ?, ?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(outboxId, TENANT_A, order.orderId, `bad:${outboxId}`, JSON.stringify({ historyId: "h", orderId: order.orderId, to: "x" }), Date.now(), Date.now(), Date.now())
      .run();

    await runRow(outboxId);

    expect(await outboxRow(outboxId)).toMatchObject({ last_error: "invalid_payload", status: "failed" });
  });

  it("gives up with an alert rather than mail a status outside the ledger's 24 hours", async () => {
    const order = await plainOrder(TENANT_A, "shipping");
    const outboxId = await fulfil(order.orderId, { to: "processing" });

    const { jobs, result } = await runRow(outboxId, {}, () => Date.now() + 25 * HOUR_MS);

    expect(result).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    expect(jobs).toHaveLength(0);
    expect((await outboxRow(outboxId)).last_error).toBe("email_expired");
    expect((await alertsFor(outboxId)).map((alert) => alert.kind)).toEqual(["outbox_failed"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("no mail sender configured (staging): the money path is unchanged", () => {
  const unconfigured = { EMAIL_FROM: undefined, RESEND_API_KEY: undefined };

  it("the webhook, the refund and the fulfilment answer as always and write their rows; the effects hold", async () => {
    const noQueue = quiet({ ...unconfigured, EMAIL_QUEUE: undefined }).env;
    const order = await pay(TENANT_A, { env: noQueue });
    const notice = await rowByKey(`email:order_notice_shop:${order.orderId}`);
    expect(notice?.status).toBe("pending");

    const response = await refund(order.orderId, 4_000, noQueue);
    expect(response.status).toBe(201);
    const { refund: settled } = await response.json<{ refund: { refundId: string } }>();
    const refundRow = await rowByKey(`email:refund_notice:${settled.refundId}`);
    expect(refundRow?.status).toBe("pending");

    const plain = await plainOrder(TENANT_A, "shipping");
    const statusId = await fulfil(plain.orderId, { to: "processing" }, noQueue);

    for (const outboxId of [notice!.outbox_id, refundRow!.outbox_id, statusId]) {
      const result = await processOutboxRowById(noQueue, outboxId);
      expect(result).toMatchObject({ kind: "ran", outcome: { kind: "retry" } });
      expect(await outboxRow(outboxId)).toMatchObject({ last_error: "email_queue_not_configured", status: "pending" });
    }
  });

  it("with a queue but no Resend key, the job is recorded pending and the consumer holds it, as it holds an auth mail", async () => {
    const order = await plainOrder(TENANT_A, "shipping");
    const { jobs } = await runRow(await fulfil(order.orderId, { to: "processing" }));
    expect(jobs).toHaveLength(1);

    const held = await consume(jobs, unconfigured);

    expect(held.calls).toHaveLength(0);
    expect(held.retriedAll).toEqual([300]);
    expect(held.acks).toEqual([]);
    expect(await ledger(jobs[0]!.deliveryId)).toMatchObject({ kind: "order_status_update", status: "pending" });

    // Configured later: delivered once.
    const sent = await consume(jobs);
    expect(sent.calls).toHaveLength(1);
    expect((await ledger(jobs[0]!.deliveryId))?.status).toBe("sent");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the jobs and their templates", () => {
  const frame = async (key: string) => {
    const createdAt = Date.now();
    return { createdAt, deliveryId: await deliveryIdFromKey(key), expiresAt: createdAt + HOUR_MS, tenantId: TENANT_A };
  };

  it("parse round-trips through the consumer's parser and refuses tampering", async () => {
    const job = createOrderEmailJob({
      ...(await frame("email:refund_notice:t1")),
      content: {
        amountMinor: 5_000,
        currency: "SEK",
        full: false,
        orderNumber: "MC-1",
        recipientName: null,
        shopName: "Butik",
        supportEmail: "hej@butik.test",
      },
      kind: "refund_notice",
      recipient: "Kund@Example.TEST",
    });
    expect(job.recipient).toBe("kund@example.test");
    const wire = JSON.parse(JSON.stringify(job)) as Record<string, unknown>;
    expect(parseAuthEmailJob(wire, env.AUTH_BASE_URL)).toEqual(job);
    for (const tampered of [
      { ...wire, locale: "en" },
      { ...wire, actionUrl: "https://x.test" },
      { ...wire, tenantId: "" },
      { ...wire, content: { ...(wire.content as object), amountMinor: 0 } },
      { ...wire, content: { ...(wire.content as object), supportEmail: "Not An Address" } },
      { ...wire, content: { ...(wire.content as object), orderNumber: "a\nb" } },
    ]) {
      expect(() => parseAuthEmailJob(tampered, env.AUTH_BASE_URL)).toThrow();
    }
  });

  it("a status mail carries shipment facts only when shipped, a place only when ready for pickup", async () => {
    const base = {
      additionalParcel: false,
      carrier: null,
      orderNumber: "MC-2",
      pickupPlaceAddress: null,
      pickupPlaceName: null,
      recipientName: null,
      shopName: null,
      status: "processing" as const,
      supportEmail: null,
      trackingNumber: null,
    };
    const make = async (content: Record<string, unknown>) =>
      createOrderEmailJob({
        ...(await frame("email.order_status:t2")),
        content: content as never,
        kind: "order_status_update",
        recipient: "kund@example.test",
      });
    await expect(make(base)).resolves.toBeDefined();
    await expect(make({ ...base, trackingNumber: "T" })).rejects.toThrow();
    await expect(make({ ...base, pickupPlaceName: "P" })).rejects.toThrow();
    await expect(make({ ...base, status: "completed" })).rejects.toThrow();
    await expect(make({ ...base, status: "shipped", trackingNumber: "T" })).resolves.toBeDefined();
  });

  it("a notice's admin link must be the admin's own order page", async () => {
    const content = {
      adminUrl: "https://admin.test.invalid/admin/orders/abc",
      currency: "SEK",
      deliveryMethod: "pickup" as const,
      discountMinor: 0,
      items: [{ lineTotalMinor: 100, name: "x", quantity: 1 }],
      orderNumber: "MC-3",
      pickupPlaceName: null,
      shippingCountry: null,
      shippingMinor: 0,
      shopName: null,
      subtotalMinor: 100,
      totalMinor: 100,
      vatMinor: 20,
    };
    const make = async (adminUrl: string | null) =>
      createOrderEmailJob({
        ...(await frame("email:order_notice_shop:t3")),
        content: { ...content, adminUrl },
        kind: "order_notice_shop",
        recipient: "shop@example.test",
      });
    await expect(make(null)).resolves.toBeDefined();
    for (const bad of [
      "javascript:alert(1)",
      "http://admin.test.invalid/admin/orders/abc",
      "https://admin.test.invalid/admin/orders/abc?x=1",
      'https://admin.test.invalid/admin/orders/"><script>',
    ]) {
      await expect(make(bad), bad).rejects.toThrow();
    }
  });

  it("the fingerprint covers the content: a changed amount is a different job", async () => {
    const make = async (amountMinor: number) =>
      createOrderEmailJob({
        ...(await frame("email:refund_notice:t4")),
        createdAt: 1_790_000_000_000,
        content: {
          amountMinor,
          currency: "SEK",
          full: false,
          orderNumber: "MC-4",
          recipientName: null,
          shopName: null,
          supportEmail: null,
        },
        expiresAt: 1_790_000_000_000 + HOUR_MS,
        kind: "refund_notice",
        recipient: "kund@example.test",
      });
    const one = await fingerprintAuthEmailJob(await make(100));
    expect(await fingerprintAuthEmailJob(await make(100))).toBe(one);
    expect(await fingerprintAuthEmailJob(await make(101))).not.toBe(one);
  });
});
