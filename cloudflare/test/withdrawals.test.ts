import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { createApp } from "../src/app";
import {
  isWithdrawalEmailEffectRunnable,
  parseWithdrawalInput,
  readAdminOrderWithdrawal,
  runWithdrawalEmailEffect,
  WITHDRAWAL_ALERT_KIND,
  WITHDRAWAL_EMAIL_EFFECT,
  withdrawalStatement,
} from "../src/commerce/withdrawals";
import { deliveryIdFromKey, hashEmailRecipient, parseAuthEmailJob } from "../src/email/auth-email-job";
import { RESEND_FETCH_OVERRIDE } from "../src/email/email-queue-consumer";
import {
  createWithdrawalEmailJob,
  fingerprintWithdrawalEmailJob,
  parseWithdrawalEmailJob,
  renderWithdrawalEmail,
  type WithdrawalAcknowledgement,
  type WithdrawalEmailContent,
  type WithdrawalEmailJob,
} from "../src/email/withdrawal-email";
import { freezeConsent, WITHDRAWAL_DISCLOSURE_VERSION } from "../src/legal/consent";
import { processOutboxRowById } from "../src/outbox/effects";
import type { EffectContext, OutboxRow } from "../src/outbox/outbox";
import {
  handleStorefrontWithdrawalRoute,
  WITHDRAWAL_BODY_MAX_BYTES,
  WITHDRAWAL_IP_LIMIT,
  WITHDRAWAL_IP_SCOPE,
  WITHDRAWAL_IP_WINDOW_MS,
  withdrawalRateKey,
} from "../src/routes/storefront-withdrawals";
import { quietEnv, recordingQueue } from "./dispatch-fixtures";

/**
 * CP4-G — the withdrawal function (DAL 2 kap. 10 a §; D96; migration 0044):
 * POST /v1/withdrawals, the append-only record, the receipt on screen and by
 * mail, the notice to the shop, and what never happens (money, order state,
 * a second record, a visitor address in the row). Every person here is
 * invented. Real clock, except where a test pins the rate-limit window.
 */

const TENANT_A = "tenant-cp4g-a";
const TENANT_B = "tenant-cp4g-b";
const TENANT_SUSPENDED = "tenant-cp4g-suspended";
const TENANT_CLOSED = "tenant-cp4g-closed";
const TENANT_UNPUBLISHED = "tenant-cp4g-unpublished";
const TENANT_NO_ADDRESS = "tenant-cp4g-noaddress";
const HOST_A = "a.cp4g-withdrawals.test";
const HOST_B = "b.cp4g-withdrawals.test";
const HOST_SUSPENDED = "suspended.cp4g-withdrawals.test";
const HOST_CLOSED = "closed.cp4g-withdrawals.test";
const HOST_UNPUBLISHED = "unpublished.cp4g-withdrawals.test";
const HOST_NO_ADDRESS = "noaddress.cp4g-withdrawals.test";
const HOST_PENDING = "pending.cp4g-withdrawals.test";
const HOST_DISABLED = "disabled.cp4g-withdrawals.test";
const SUPPORT_A = "kundtjanst@butik-a.example.test";
const SHOP_A = "Butik A & <Co>";

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const OPAQUE_404 = { error: { code: "not_found", message: "Route not found" } };
const INVALID_400 = { error: { code: "invalid_request", message: "Request is not valid" } };

const app = createApp({ surface: "public" });

let counter = 0;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

// ── seeding ─────────────────────────────────────────────────────────────────

async function seedTenant(
  tenantId: string,
  host: string,
  options: { published?: 0 | 1; shopName?: string; status?: string; supportEmail?: string | null } = {},
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (tenant_id, status, shop_name, support_email, default_locale,
         default_currency, published, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'sv-SE', 'SEK', ?, ?, ?)`,
    ).bind(
      tenantId,
      options.status ?? "active",
      options.shopName ?? `Shop ${tenantId}`,
      options.supportEmail === undefined ? `support@${host}` : options.supportEmail,
      options.published ?? 1,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO tenant_domains (domain_id, tenant_id, hostname, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, host, now, now),
  ]);
}

interface LineSeed {
  name?: string;
  personalized?: boolean;
  quantity?: number;
  sku?: string;
}

interface SeededOrder {
  email: string;
  orderId: string;
  orderNumber: string;
  tenantId: string;
}

const ORDER_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function orderNumber(): string {
  counter += 1;
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => ORDER_ALPHABET[byte % 32]).join("");
  return `20260928-${random}`;
}

/** A paid order as the webhook writes it, with its frozen consent (0031). */
async function seedOrder(
  tenantId: string,
  options: {
    consentJson?: string | null;
    createdAt?: number;
    email?: string;
    lines?: LineSeed[];
    number?: string;
  } = {},
): Promise<SeededOrder> {
  const now = options.createdAt ?? Date.now();
  const orderId = crypto.randomUUID();
  const number = options.number ?? orderNumber();
  counter += 1;
  const email = options.email ?? `buyer.${counter}@example.test`;
  const lines = options.lines ?? [{ name: "Tröja", quantity: 2, sku: "TR-1" }];
  const personalizedItems = lines.flatMap((line, index) => (line.personalized === true ? [index] : []));
  const frozen =
    options.consentJson !== undefined
      ? { json: options.consentJson, status: "ok" as const }
      : await freezeConsent(
          {
            disclosureVersion: personalizedItems.length > 0 ? WITHDRAWAL_DISCLOSURE_VERSION : null,
            marketing: false,
            terms: true,
            withdrawalWaiver: personalizedItems.length > 0,
          },
          personalizedItems,
          now,
        );
  if (frozen.status !== "ok") {
    throw new Error("consent refused");
  }
  const isPersonalized = options.consentJson !== undefined ? (options.consentJson === null ? 0 : 1) : personalizedItems.length > 0 ? 1 : 0;
  const price = 19_900;
  const subtotal = lines.reduce((sum, line) => sum + (line.quantity ?? 1) * price, 0);
  const checkoutId = `ck-cp4g-${counter}-${orderId.slice(0, 8)}`;
  const intentId = `pi_cp4g_${counter}_${orderId.slice(0, 8)}`;

  const statements: D1PreparedStatement[] = [];
  const productIds: string[] = [];
  for (const [index, line] of lines.entries()) {
    const productId = `prod-cp4g-${counter}-${index}-${orderId.slice(0, 8)}`;
    productIds.push(productId);
    statements.push(
      env.DB.prepare(
        `INSERT INTO products (product_id, tenant_id, status, sku, name, b2c_price_minor,
           currency, is_personalized, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?, 'SEK', ?, ?, ?)`,
      ).bind(productId, tenantId, `sku-${productId}`, line.name ?? "Vara", price, line.personalized === true ? 1 : 0, now, now),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO checkouts (
         checkout_id, tenant_id, status, customer_email, currency,
         delivery_method, shipping_country, subtotal_minor, shipping_minor,
         vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor,
         payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at
       ) VALUES (?, ?, 'completed', ?, 'SEK', 'pickup', NULL, ?, 0, 0, 2500, 0, NULL, ?, ?, ?, ?, ?, ?)`,
    ).bind(checkoutId, tenantId, email.toLowerCase(), subtotal, subtotal, intentId, `hash-${checkoutId}`, now + DAY_MS, now, now),
    env.DB.prepare(
      `INSERT INTO orders (
         order_id, tenant_id, checkout_id, payment_intent_id, order_number,
         status, customer_email, currency, delivery_method, shipping_country,
         subtotal_minor, shipping_minor, vat_minor, vat_rate_bp,
         discount_minor, discount_code_id, total_minor, captured_minor,
         refunded_total_minor, stripe_event_id, paid_at, created_at, updated_at,
         consent_json, is_personalized
       ) VALUES (?, ?, ?, ?, ?, 'paid', ?, 'SEK', 'pickup', NULL, ?, 0, 0, 2500, 0, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      orderId,
      tenantId,
      checkoutId,
      intentId,
      number,
      email,
      subtotal,
      subtotal,
      subtotal,
      `evt_cp4g_${counter}`,
      now,
      now,
      now,
      frozen.json,
      isPersonalized,
    ),
  );
  for (const [index, line] of lines.entries()) {
    const quantity = line.quantity ?? 1;
    statements.push(
      env.DB.prepare(
        `INSERT INTO order_items (
           order_item_id, order_id, tenant_id, item_index, product_id, variant_id,
           sku, name, quantity, unit_price_minor, line_total_minor, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        orderId,
        tenantId,
        index,
        productIds[index],
        line.sku ?? `SKU-${index}`,
        line.name ?? "Vara",
        quantity,
        price,
        quantity * price,
        now,
        now,
      ),
    );
  }
  await env.DB.batch(statements);
  return { email, orderId, orderNumber: number, tenantId };
}

// ── calling ─────────────────────────────────────────────────────────────────

function body(order: SeededOrder, overrides: { contactEmail?: string; name?: string; orderNumber?: string } = {}) {
  return {
    orderNumber: overrides.orderNumber ?? order.orderNumber,
    statement: { contactEmail: overrides.contactEmail ?? order.email, name: overrides.name ?? "Test Köpare" },
  };
}

function withdrawalRequest(
  host: string,
  payload: unknown,
  options: { headers?: Record<string, string>; ip?: string | null; method?: string } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  if (options.ip !== null) {
    headers.set("cf-connecting-ip", options.ip ?? nextIp());
  }
  const method = options.method ?? "POST";
  return new Request(`https://${host}/v1/withdrawals`, {
    body: method === "GET" || method === "HEAD" ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload),
    headers,
    method,
  });
}

async function withdraw(
  host: string,
  payload: unknown,
  options: { env?: Env; headers?: Record<string, string>; ip?: string | null; method?: string } = {},
): Promise<Response> {
  return app.fetch(withdrawalRequest(host, payload, options), options.env ?? quietEnv().env);
}

interface Answer {
  withdrawal: {
    acknowledgement: WithdrawalAcknowledgement;
    alreadyReceived: boolean;
    eligible: boolean;
    reason: string | null;
  };
}

async function expectOpaque404(response: Response, label: string): Promise<void> {
  expect(response.status, label).toBe(404);
  await expect(response.json(), label).resolves.toEqual(OPAQUE_404);
}

// ── reading ─────────────────────────────────────────────────────────────────

interface StoredWithdrawal {
  consumer_name: string;
  contact_email: string;
  eligible: number;
  exempt_items_json: string;
  order_id: string;
  reason: string | null;
  received_at: string;
  shop_name: string | null;
  shop_notice_email: string | null;
  tenant_id: string;
  withdrawal_id: string;
  withdrawn_items_json: string;
}

async function withdrawalOf(orderId: string): Promise<StoredWithdrawal | null> {
  return env.DB.prepare("SELECT * FROM withdrawals WHERE order_id = ?").bind(orderId).first<StoredWithdrawal>();
}

async function outboxOf(withdrawalId: string): Promise<OutboxRow[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM outbox_events WHERE aggregate_type = 'withdrawal' AND aggregate_id = ? ORDER BY dedupe_key",
  )
    .bind(withdrawalId)
    .all<OutboxRow>();
  return rows.results;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

async function totals(): Promise<{ alerts: number; ledger: number; outbox: number; withdrawals: number }> {
  return {
    alerts: await count("SELECT COUNT(*) AS n FROM alerts"),
    ledger: await count("SELECT COUNT(*) AS n FROM email_deliveries"),
    outbox: await count("SELECT COUNT(*) AS n FROM outbox_events"),
    withdrawals: await count("SELECT COUNT(*) AS n FROM withdrawals"),
  };
}

async function orderRow(orderId: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM orders WHERE order_id = ?").bind(orderId).first<Record<string, unknown>>();
}

/** The consumer claims only the types it runs; the effect's own tests claim by hand. */
async function claimForTest(outboxId: string, now = Date.now()): Promise<OutboxRow> {
  const row = await env.DB.prepare(
    `UPDATE outbox_events
     SET status = 'claimed', claimed_by = ?, claim_expires_at = ?, attempts = attempts + 1,
         last_attempt_at = ?, updated_at = MAX(updated_at, ?)
     WHERE outbox_id = ? AND status IN ('pending', 'unknown')
     RETURNING *`,
  )
    .bind(crypto.randomUUID(), now + 5 * MINUTE_MS, now, now, outboxId)
    .first<OutboxRow>();
  if (row === null) {
    throw new Error(`outbox row ${outboxId} not claimable`);
  }
  return row;
}

function effectContext(row: OutboxRow, effectEnv: Env, clock: () => number = Date.now): EffectContext {
  if (row.claimed_by === null) {
    throw new Error("not claimed");
  }
  return { claim: { claimedBy: row.claimed_by, outboxId: row.outbox_id }, clock, env: effectEnv, row };
}

/**
 * Whether the `-email` consumer can read a withdrawal job, i.e. whether the
 * reviewer's wiring of src/email/ has landed (docs/cf-port/CP4_G_REPORT.md).
 */
function emailConsumerReadsWithdrawalJobs(): boolean {
  const now = Date.now();
  try {
    const job = createWithdrawalEmailJob({
      createdAt: now,
      deliveryId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
      expiresAt: now + HOUR_MS,
      kind: "withdrawal_receipt",
      recipient: "probe@example.test",
      tenantId: "probe",
      withdrawal: {
        acknowledgement: {
          consumerName: "Probe",
          contactEmail: "probe@example.test",
          exemptItems: [],
          orderNumber: "PROBE",
          shopName: null,
          statement: "Probe.",
          submittedAt: new Date(now).toISOString(),
          withdrawnItems: [],
        },
        eligible: true,
        reason: null,
      },
    });
    const parsed: { kind: string } = parseAuthEmailJob(JSON.parse(JSON.stringify(job)), env.AUTH_BASE_URL);
    return parsed.kind === "withdrawal_receipt";
  } catch {
    return false;
  }
}

const EMAIL_WIRED = emailConsumerReadsWithdrawalJobs();

/**
 * A fixed instant in the PREVIOUS hour's first ten-minute window: every call of
 * a rate-limit sequence lands in one window of both limits, and the instant is
 * always in the past.
 */
function pinnedNow(): number {
  return Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS + 5 * MINUTE_MS;
}

beforeAll(async () => {
  await seedTenant(TENANT_A, HOST_A, { shopName: SHOP_A, supportEmail: SUPPORT_A });
  await seedTenant(TENANT_B, HOST_B);
  await seedTenant(TENANT_SUSPENDED, HOST_SUSPENDED, { status: "suspended" });
  await seedTenant(TENANT_CLOSED, HOST_CLOSED, { status: "closed" });
  await seedTenant(TENANT_UNPUBLISHED, HOST_UNPUBLISHED, { published: 0 });
  await seedTenant(TENANT_NO_ADDRESS, HOST_NO_ADDRESS, { supportEmail: null });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenant_domains (domain_id, tenant_id, hostname, kind, status, created_at, updated_at)
       VALUES ('domain-cp4g-pending', ?, ?, 'storefront', 'pending', ?, ?)`,
    ).bind(TENANT_A, HOST_PENDING, now, now),
    env.DB.prepare(
      `INSERT INTO tenant_domains (domain_id, tenant_id, hostname, kind, status, created_at, updated_at)
       VALUES ('domain-cp4g-disabled', ?, ?, 'storefront', 'disabled', ?, ?)`,
    ).bind(TENANT_A, HOST_DISABLED, now, now),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("POST /v1/withdrawals — the refusals", () => {
  it("answers only POST: every other method is the opaque 404 and writes nothing", async () => {
    const order = await seedOrder(TENANT_A);
    const before = await totals();
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      await expectOpaque404(await withdraw(HOST_A, body(order), { method }), method);
    }
    expect((await withdraw(HOST_A, body(order), { method: "HEAD" })).status).toBe(404);
    expect(await totals()).toEqual(before);
    expect(await withdrawalOf(order.orderId)).toBeNull();
  });

  it("an unknown, a pending and a disabled hostname are the opaque 404", async () => {
    const order = await seedOrder(TENANT_A);
    for (const host of ["nobody.cp4g-withdrawals.test", HOST_PENDING, HOST_DISABLED]) {
      await expectOpaque404(await withdraw(host, body(order)), host);
    }
    expect(await withdrawalOf(order.orderId)).toBeNull();
  });

  it("obeys the public-entrypoint rule of every storefront route", async () => {
    const order = await seedOrder(TENANT_A);
    const closedPublic = createApp({ publicStorefrontAllowed: false, surface: "public" });
    expect((await closedPublic.fetch(withdrawalRequest(HOST_A, body(order)), quietEnv().env)).status).toBe(404);
    expect(await withdrawalOf(order.orderId)).toBeNull();
    const closedInternal = createApp({ publicStorefrontAllowed: false, surface: "internal" });
    expect((await closedInternal.fetch(withdrawalRequest(HOST_A, body(order)), quietEnv().env)).status).toBe(201);
  });

  it("takes no tenant from the caller: a tenant header is the opaque 404, a shop id in the body a 400", async () => {
    const order = await seedOrder(TENANT_B);
    await expectOpaque404(
      await withdraw(HOST_A, body(order), { headers: { "x-tenant-id": TENANT_B } }),
      "tenant header",
    );
    const withShop = await withdraw(HOST_A, { ...body(order), shopId: TENANT_B });
    expect(withShop.status).toBe(400);
    await expect(withShop.json()).resolves.toEqual(INVALID_400);
    expect(await withdrawalOf(order.orderId)).toBeNull();
  });

  it.each([
    ["not JSON", "not json"],
    ["an array", [1]],
    ["no statement", { orderNumber: "20260928-AAAAAAAA" }],
    ["a statement that is a string", { orderNumber: "20260928-AAAAAAAA", statement: "x" }],
    ["no order number", { statement: { contactEmail: "a@example.test", name: "N" } }],
    ["an empty order number", { orderNumber: " # ", statement: { contactEmail: "a@example.test", name: "N" } }],
    ["an order number over 64 characters", { orderNumber: "A".repeat(65), statement: { contactEmail: "a@example.test", name: "N" } }],
    ["an order number with a line break", { orderNumber: "2026\n0928", statement: { contactEmail: "a@example.test", name: "N" } }],
    ["a numeric order number", { orderNumber: 20260928, statement: { contactEmail: "a@example.test", name: "N" } }],
    ["no name", { orderNumber: "X", statement: { contactEmail: "a@example.test" } }],
    ["a blank name", { orderNumber: "X", statement: { contactEmail: "a@example.test", name: "   " } }],
    ["a name over 200 characters", { orderNumber: "X", statement: { contactEmail: "a@example.test", name: "n".repeat(201) } }],
    ["a name with a control character", { orderNumber: "X", statement: { contactEmail: "a@example.test", name: "Ann\u0000a" } }],
    ["no address", { orderNumber: "X", statement: { name: "N" } }],
    ["an invalid address", { orderNumber: "X", statement: { contactEmail: "not-an-address", name: "N" } }],
    ["an unknown key", { orderNumber: "X", phone: "070", statement: { contactEmail: "a@example.test", name: "N" } }],
    ["an unknown statement key", { orderNumber: "X", statement: { contactEmail: "a@example.test", name: "N", receiptEmail: "b@example.test" } }],
    ["a client time", { orderNumber: "X", statement: { contactEmail: "a@example.test", name: "N", submittedAt: "2026-01-01T00:00:00.000Z" } }],
    ["a client time at the top", { orderNumber: "X", receivedAt: "2026-01-01T00:00:00.000Z", statement: { contactEmail: "a@example.test", name: "N" } }],
  ])("refuses %s with the one 400 and writes nothing", async (_label, payload) => {
    const before = await totals();
    const response = await withdraw(HOST_A, payload);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(INVALID_400);
    expect(await totals()).toEqual(before);
  });

  it(`refuses a body over ${WITHDRAWAL_BODY_MAX_BYTES} bytes, however valid its JSON`, async () => {
    const order = await seedOrder(TENANT_A);
    const padded = JSON.stringify(body(order)) + " ".repeat(WITHDRAWAL_BODY_MAX_BYTES);
    expect((await withdraw(HOST_A, padded)).status).toBe(400);
    expect(await withdrawalOf(order.orderId)).toBeNull();
    expect((await withdraw(HOST_A, JSON.stringify(body(order)))).status).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("one answer for 'no such order' and 'the address does not match'", () => {
  it("unknown number, wrong address, another shop's order and a twin number are byte-identical 404s that write nothing", async () => {
    const mine = await seedOrder(TENANT_A);
    const theirs = await seedOrder(TENANT_B);
    // The same number in both shops (UNIQUE is per shop): host A finds only A's.
    const twinNumber = orderNumber();
    await seedOrder(TENANT_A, { email: "twin.a@example.test", number: twinNumber });
    const twinB = await seedOrder(TENANT_B, { email: "twin.b@example.test", number: twinNumber });
    const before = await totals();

    const answers = [
      await withdraw(HOST_A, body(mine, { orderNumber: orderNumber() })),
      await withdraw(HOST_A, body(mine, { contactEmail: "someone.else@example.test" })),
      await withdraw(HOST_A, body(theirs)),
      await withdraw(HOST_A, body(twinB)),
    ];
    const texts = await Promise.all(answers.map((response) => response.text()));
    expect(answers.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(new Set(texts).size).toBe(1);
    expect(JSON.parse(texts[0] ?? "")).toEqual(OPAQUE_404);
    const headerSets = answers.map((response) =>
      [...response.headers.entries()].filter(([name]) => name !== "date").sort().join("|"),
    );
    expect(new Set(headerSets).size).toBe(1);
    expect(await totals()).toEqual(before);
    expect(await withdrawalOf(theirs.orderId)).toBeNull();
    expect(await withdrawalOf(twinB.orderId)).toBeNull();
  });

  it("an unknown number and a wrong address run the very same statements (no path, and no timing, of their own)", async () => {
    const order = await seedOrder(TENANT_A);
    const now = pinnedNow();
    const trace = (log: string[]): Env => {
      const db = new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare") {
            return (sql: string) => {
              log.push(sql.replace(/\s+/g, " ").trim());
              return target.prepare(sql);
            };
          }
          if (property === "batch") {
            return (statements: D1PreparedStatement[]) => {
              log.push(`batch(${statements.length})`);
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
      return { ...quietEnv().env, DB: db } as unknown as Env;
    };

    // Every SHA-256 counts: the limiter's key and the address comparison's two
    // digests run on BOTH misses (no early return before the comparison).
    const digest = vi.spyOn(crypto.subtle, "digest");
    const unknownLog: string[] = [];
    const wrongLog: string[] = [];
    const unknown = await handleStorefrontWithdrawalRoute(
      trace(unknownLog),
      withdrawalRequest(HOST_A, body(order, { orderNumber: orderNumber() })),
      { now },
    );
    const unknownDigests = digest.mock.calls.length;
    const wrong = await handleStorefrontWithdrawalRoute(
      trace(wrongLog),
      withdrawalRequest(HOST_A, body(order, { contactEmail: "wrong@example.test" })),
      { now },
    );
    const wrongDigests = digest.mock.calls.length - unknownDigests;

    expect(unknown.status).toBe(404);
    expect(wrong.status).toBe(404);
    expect(await unknown.text()).toBe(await wrong.text());
    expect(wrongLog).toEqual(unknownLog);
    expect(unknownDigests).toBe(3);
    expect(wrongDigests).toBe(unknownDigests);
    expect(unknownLog.some((sql) => sql.startsWith("batch"))).toBe(false);
    expect(unknownLog.filter((sql) => sql.includes("FROM orders"))).toHaveLength(1);
  });

  it("compares the address normalised (case, surrounding space), on both sides", async () => {
    const lower = await seedOrder(TENANT_A, { email: "buyer.norm@example.test" });
    expect((await withdraw(HOST_A, body(lower, { contactEmail: "  Buyer.Norm@EXAMPLE.test " }))).status).toBe(201);
    // An imported order may hold the address as the buyer once typed it.
    const mixed = await seedOrder(TENANT_A, { email: "Imported.Buyer@Example.TEST" });
    const response = await withdraw(HOST_A, body(mixed, { contactEmail: "imported.buyer@example.test" }));
    expect(response.status).toBe(201);
    expect((await withdrawalOf(mixed.orderId))?.contact_email).toBe("imported.buyer@example.test");
  });

  it("finds the order number as a buyer types it: '#', lower case, spaces", async () => {
    const order = await seedOrder(TENANT_A);
    const typed = `  #${order.orderNumber.toLowerCase()} `;
    const response = await withdraw(HOST_A, body(order, { orderNumber: typed }));
    expect(response.status).toBe(201);
    const answer = await response.json<Answer>();
    expect(answer.withdrawal.acknowledgement.orderNumber).toBe(order.orderNumber);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the rate limits", () => {
  it(`limits one IP to ${WITHDRAWAL_IP_LIMIT} per ten minutes, refused attempts included; another IP is unaffected`, async () => {
    const now = pinnedNow();
    const ip = "203.0.113.71";
    const order = await seedOrder(TENANT_A);
    const statuses: number[] = [];
    for (let index = 0; index < WITHDRAWAL_IP_LIMIT; index += 1) {
      const payload = index % 2 === 0 ? "not json" : body(order, { orderNumber: orderNumber() });
      statuses.push((await handleStorefrontWithdrawalRoute(quietEnv().env, withdrawalRequest(HOST_A, payload, { ip }), { now })).status);
    }
    expect(statuses).toEqual([400, 404, 400, 404, 400, 404, 400, 404, 400, 404]);

    const limited = await handleStorefrontWithdrawalRoute(quietEnv().env, withdrawalRequest(HOST_A, body(order), { ip }), { now });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(limited.json()).resolves.toEqual({ error: { code: "rate_limited", message: "Too many requests" } });
    // The limit is decided before the body: even the right order and address wait.
    expect(await withdrawalOf(order.orderId)).toBeNull();

    // X-Forwarded-For is the caller's to write and is never consulted.
    const spoofed = await handleStorefrontWithdrawalRoute(
      quietEnv().env,
      withdrawalRequest(HOST_A, body(order), { headers: { "x-forwarded-for": "192.0.2.99" }, ip }),
      { now },
    );
    expect(spoofed.status).toBe(429);

    const other = await handleStorefrontWithdrawalRoute(quietEnv().env, withdrawalRequest(HOST_A, body(order), { ip: "203.0.113.72" }), { now });
    expect(other.status).toBe(201);
  });

  it("puts every request without an edge address into ONE shared bucket", async () => {
    const now = pinnedNow() + 10 * MINUTE_MS;
    const statuses: number[] = [];
    for (let index = 0; index <= WITHDRAWAL_IP_LIMIT; index += 1) {
      statuses.push((await handleStorefrontWithdrawalRoute(quietEnv().env, withdrawalRequest(HOST_A, "x", { ip: null }), { now })).status);
    }
    expect(statuses.slice(0, WITHDRAWAL_IP_LIMIT).every((status) => status === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("counts an IPv6 visitor by its /64: rotating addresses inside it buys nothing; another /64 is unaffected", async () => {
    const now = pinnedNow() + 20 * MINUTE_MS;
    const order = await seedOrder(TENANT_A);
    const statuses: number[] = [];
    for (let index = 0; index < WITHDRAWAL_IP_LIMIT; index += 1) {
      // Ten different addresses (and spellings) of ONE network.
      const ip = index % 2 === 0 ? `2001:db8:77:1::${(index + 1).toString(16)}` : `2001:0DB8:0077:0001:0:0:${index}:1`;
      statuses.push(
        (await handleStorefrontWithdrawalRoute(quietEnv().env, withdrawalRequest(HOST_A, body(order, { orderNumber: orderNumber() }), { ip }), { now })).status,
      );
    }
    expect(statuses.every((status) => status === 404)).toBe(true);
    const rotated = await handleStorefrontWithdrawalRoute(
      quietEnv().env,
      withdrawalRequest(HOST_A, body(order), { ip: "2001:db8:77:1:ffff:ffff:ffff:fffe" }),
      { now },
    );
    expect(rotated.status).toBe(429);
    const neighbour = await handleStorefrontWithdrawalRoute(
      quietEnv().env,
      withdrawalRequest(HOST_A, body(order), { ip: "2001:db8:77:2::1" }),
      { now },
    );
    expect(neighbour.status).toBe(201);
  });

  it("keys a visitor address canonically: IPv4 as it is, IPv4-mapped as IPv4, IPv6 by its /64", () => {
    expect(withdrawalRateKey("203.0.113.9")).toBe("203.0.113.9");
    expect(withdrawalRateKey("unknown")).toBe("unknown");
    expect(withdrawalRateKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(withdrawalRateKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(withdrawalRateKey("2001:0DB8:0000:0000:abcd:ef01:2345:6789")).toBe("2001:db8:0:0::/64");
    expect(withdrawalRateKey("2001:db8:0:0:1::")).toBe("2001:db8:0:0::/64");
    expect(withdrawalRateKey("2001:db8:1:2:3:4:1.2.3.4")).toBe("2001:db8:1:2::/64");
    expect(withdrawalRateKey("::1")).toBe("0:0:0:0::/64");
    // Not IPv6: keyed as it is (a strict bucket of its own).
    expect(withdrawalRateKey("1:2:3")).toBe("1:2:3");
    expect(withdrawalRateKey("1::2::3")).toBe("1::2::3");
    expect(withdrawalRateKey("zz:1:2:3:4:5:6:7")).toBe("zz:1:2:3:4:5:6:7");
  });

  it("keeps NO limit per order number: a flood of wrong guesses from many addresses never keeps the buyer out", async () => {
    const now = pinnedNow();
    const order = await seedOrder(TENANT_A);
    const spellings = [order.orderNumber, `#${order.orderNumber}`, order.orderNumber.toLowerCase()];
    for (let index = 0; index < 3 * WITHDRAWAL_IP_LIMIT; index += 1) {
      const response = await handleStorefrontWithdrawalRoute(
        quietEnv().env,
        withdrawalRequest(HOST_A, body(order, { contactEmail: `guess${index}@example.test`, orderNumber: spellings[index % spellings.length] })),
        { now },
      );
      expect(response.status).toBe(404);
    }
    const buyer = await handleStorefrontWithdrawalRoute(quietEnv().env, withdrawalRequest(HOST_A, body(order)), { now });
    expect(buyer.status).toBe(201);
  });

  it("is enforced on the mounted route, and keeps no raw address in D1", async () => {
    const ip = "203.0.113.73";
    const now = Date.now();
    const windowStart = now - (now % WITHDRAWAL_IP_WINDOW_MS);
    const keyHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${WITHDRAWAL_IP_SCOPE}:${ip}`))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await env.DB.prepare(
      `INSERT INTO rate_limit_windows (scope, key_hash, window_start, count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(WITHDRAWAL_IP_SCOPE, keyHash, windowStart, WITHDRAWAL_IP_LIMIT, now, now)
      .run();
    const order = await seedOrder(TENANT_A);
    expect((await withdraw(HOST_A, body(order), { ip })).status).toBe(429);

    const windows = await env.DB.prepare("SELECT * FROM rate_limit_windows WHERE scope = ?")
      .bind(WITHDRAWAL_IP_SCOPE)
      .all();
    expect(windows.results.length).toBeGreaterThan(0);
    const text = JSON.stringify(windows.results);
    expect(text).not.toContain(ip);
    expect(text).not.toContain(order.orderNumber);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a withdrawal", () => {
  it("is recorded with the server's time and answered with its receipt (201)", async () => {
    const order = await seedOrder(TENANT_A, {
      lines: [
        { name: "Tröja", quantity: 2, sku: "TR-1" },
        { name: "Keps", quantity: 1, sku: "" },
      ],
    });
    const ip = nextIp();
    const orderBefore = await orderRow(order.orderId);
    const before = await totals();
    const quiet = quietEnv();
    const sentAt = Date.now();

    const response = await withdraw(HOST_A, body(order, { name: "  Test Köpare " }), { env: quiet.env, ip });

    expect(response.status).toBe(201);
    const answer = await response.json<Answer>();
    const stored = await withdrawalOf(order.orderId);
    if (stored === null) {
      throw new Error("no withdrawal row");
    }
    // THE time: the server's, written once, the one the receipt shows.
    expect(Date.parse(stored.received_at)).toBeGreaterThanOrEqual(sentAt - 1_000);
    expect(Date.parse(stored.received_at)).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(answer).toEqual({
      withdrawal: {
        acknowledgement: {
          consumerName: "Test Köpare",
          contactEmail: order.email,
          exemptItems: [],
          orderNumber: order.orderNumber,
          shopName: SHOP_A,
          statement: `Jag, Test Köpare, ångrar härmed mitt köp av order ${order.orderNumber}. Detta meddelande togs emot ${stored.received_at}.`,
          submittedAt: stored.received_at,
          withdrawnItems: [
            { name: "Tröja", quantity: 2, sku: "TR-1" },
            { name: "Keps", quantity: 1, sku: "" },
          ],
        },
        alreadyReceived: false,
        eligible: true,
        reason: null,
      },
    });
    expect(stored).toMatchObject({
      consumer_name: "Test Köpare",
      contact_email: order.email,
      eligible: 1,
      exempt_items_json: "[]",
      reason: null,
      shop_name: SHOP_A,
      shop_notice_email: SUPPORT_A,
      tenant_id: TENANT_A,
      withdrawn_items_json: "[0,1]",
    });
    // No visitor address in the row.
    expect(JSON.stringify(stored)).not.toContain(ip);

    // The two mails wait in the outbox, ids only; the shop is not alerted.
    const outbox = await outboxOf(stored.withdrawal_id);
    expect(outbox.map((row) => [row.event_type, row.status, JSON.parse(row.payload_json)])).toEqual([
      [WITHDRAWAL_EMAIL_EFFECT, "pending", { kind: "withdrawal_notice", withdrawalId: stored.withdrawal_id }],
      [WITHDRAWAL_EMAIL_EFFECT, "pending", { kind: "withdrawal_receipt", withdrawalId: stored.withdrawal_id }],
    ]);
    for (const row of outbox) {
      expect(row.payload_json).not.toContain(order.email);
      expect(row.payload_json).not.toContain("Köpare");
      expect(row.created_at).toBe(Date.parse(stored.received_at));
    }
    expect(await totals()).toEqual({ ...before, outbox: before.outbox + 2, withdrawals: before.withdrawals + 1 });
    // The outbox is nudged exactly when its consumer runs the effect (wiring).
    expect(quiet.nudges.sent).toEqual(
      isWithdrawalEmailEffectRunnable() ? outbox.map((row) => ({ outboxId: row.outbox_id })).reverse() : [],
    );

    // No money moves and no order state changes.
    expect(await orderRow(order.orderId)).toEqual(orderBefore);
    expect(await count("SELECT COUNT(*) AS n FROM refund_operations WHERE order_id = ?", order.orderId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ?", order.orderId)).toBe(0);
  });

  it("a second message writes nothing and answers the first one's receipt, byte for byte (200)", async () => {
    const order = await seedOrder(TENANT_A);
    const first = await withdraw(HOST_A, body(order, { name: "Första Namnet" }));
    expect(first.status).toBe(201);
    const firstAnswer = await first.json<Answer>();
    const stored = await withdrawalOf(order.orderId);
    const before = await totals();
    const quiet = quietEnv();

    const second = await withdraw(HOST_A, body(order, { contactEmail: ` ${order.email.toUpperCase()}`, name: "Ett Annat Namn" }), { env: quiet.env });

    expect(second.status).toBe(200);
    const secondAnswer = await second.json<Answer>();
    expect(JSON.stringify(secondAnswer.withdrawal.acknowledgement)).toBe(JSON.stringify(firstAnswer.withdrawal.acknowledgement));
    expect(secondAnswer.withdrawal).toEqual({ ...firstAnswer.withdrawal, alreadyReceived: true });
    expect(await withdrawalOf(order.orderId)).toEqual(stored);
    expect(await totals()).toEqual(before);
    expect(quiet.nudges.sent).toEqual([]);
  });

  it("two first messages at once: one record, one 201, the other gets its receipt (200)", async () => {
    const order = await seedOrder(TENANT_A);
    const [one, two] = await Promise.all([
      withdraw(HOST_A, body(order, { name: "Samtidig Ett" })),
      withdraw(HOST_A, body(order, { name: "Samtidig Två" })),
    ]);
    expect([one?.status, two?.status].sort()).toEqual([200, 201]);
    const answers = await Promise.all([one, two].map((response) => response?.json<Answer>()));
    expect(answers[0]?.withdrawal.acknowledgement).toEqual(answers[1]?.withdrawal.acknowledgement);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawals WHERE order_id = ?", order.orderId)).toBe(1);
    const stored = await withdrawalOf(order.orderId);
    expect(await outboxOf(stored?.withdrawal_id ?? "")).toHaveLength(2);
    expect(await count("SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_type = 'withdrawal' AND aggregate_id NOT IN (SELECT withdrawal_id FROM withdrawals)")).toBe(0);
  });

  it("a mail path that is down never fails the withdrawal", async () => {
    const order = await seedOrder(TENANT_A);
    const down = quietEnv({
      EMAIL_QUEUE: recordingQueue({ fail: true }).queue,
      OUTBOX_QUEUE: recordingQueue({ fail: true }).queue,
    });
    expect((await withdraw(HOST_A, body(order), { env: down.env })).status).toBe(201);
    expect(await withdrawalOf(order.orderId)).not.toBeNull();

    const unbound = await seedOrder(TENANT_A);
    const none = quietEnv({ EMAIL_QUEUE: undefined, OUTBOX_QUEUE: undefined });
    expect((await withdraw(HOST_A, body(unbound), { env: none.env })).status).toBe(201);
    expect(await withdrawalOf(unbound.orderId)).not.toBeNull();
  });

  it("a shop with no support address: the receipt still goes, the platform is alerted by ids only", async () => {
    const order = await seedOrder(TENANT_NO_ADDRESS);
    const response = await withdraw(HOST_NO_ADDRESS, body(order, { name: "Utan Adress" }));
    expect(response.status).toBe(201);
    const stored = await withdrawalOf(order.orderId);
    expect(stored?.shop_notice_email).toBeNull();
    const outbox = await outboxOf(stored?.withdrawal_id ?? "");
    expect(outbox.map((row) => JSON.parse(row.payload_json).kind)).toEqual(["withdrawal_receipt"]);
    const alert = await env.DB.prepare("SELECT * FROM alerts WHERE resource_type = 'withdrawal' AND resource_id = ?")
      .bind(stored?.withdrawal_id ?? "")
      .first<{ kind: string; message: string; severity: string; tenant_id: string }>();
    expect(alert).toMatchObject({ kind: WITHDRAWAL_ALERT_KIND, severity: "warning", tenant_id: TENANT_NO_ADDRESS });
    expect(alert?.message).toContain(stored?.withdrawal_id ?? "?");
    expect(alert?.message).not.toContain(order.email);
    expect(alert?.message).not.toContain("Utan Adress");
  });

  it("rule 10: a suspended, a closed and an unpublished shop's buyer can still withdraw on the shop's address", async () => {
    for (const [tenantId, host] of [
      [TENANT_SUSPENDED, HOST_SUSPENDED],
      [TENANT_CLOSED, HOST_CLOSED],
      [TENANT_UNPUBLISHED, HOST_UNPUBLISHED],
    ] as const) {
      const order = await seedOrder(tenantId);
      const response = await withdraw(host, body(order));
      expect(response.status, tenantId).toBe(201);
      expect((await withdrawalOf(order.orderId))?.tenant_id).toBe(tenantId);
    }
    // …and never another shop's order through that address.
    const foreign = await seedOrder(TENANT_A);
    await expectOpaque404(await withdraw(HOST_SUSPENDED, body(foreign)), "A's order via the suspended host");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("what the function answers", () => {
  it("a wholly personalised order: not eligible, with the reason — recorded, with its receipt", async () => {
    const order = await seedOrder(TENANT_A, {
      lines: [{ name: "Tavla med ditt foto", personalized: true, quantity: 1, sku: "ART-1" }],
    });
    const response = await withdraw(HOST_A, body(order));
    expect(response.status).toBe(201);
    const answer = await response.json<Answer>();
    expect(answer.withdrawal).toMatchObject({ alreadyReceived: false, eligible: false, reason: "personalized_exempt" });
    expect(answer.withdrawal.acknowledgement).toMatchObject({
      exemptItems: [{ name: "Tavla med ditt foto", quantity: 1, sku: "ART-1" }],
      withdrawnItems: [],
    });
    expect(await withdrawalOf(order.orderId)).toMatchObject({
      eligible: 0,
      exempt_items_json: "[0]",
      reason: "personalized_exempt",
      withdrawn_items_json: "[]",
    });
    const again = await withdraw(HOST_A, body(order));
    expect(again.status).toBe(200);
    expect((await again.json<Answer>()).withdrawal).toEqual({ ...answer.withdrawal, alreadyReceived: true });
  });

  it("a MIXED order: the catalogue lines are withdrawn, the personalised line is listed apart", async () => {
    const order = await seedOrder(TENANT_A, {
      lines: [
        { name: "Mugg", quantity: 1, sku: "MUG" },
        { name: "Tröja med ditt namn", personalized: true, quantity: 1, sku: "NAME-1" },
      ],
    });
    const answer = await (await withdraw(HOST_A, body(order))).json<Answer>();
    expect(answer.withdrawal).toMatchObject({ eligible: true, reason: null });
    expect(answer.withdrawal.acknowledgement.withdrawnItems).toEqual([{ name: "Mugg", quantity: 1, sku: "MUG" }]);
    expect(answer.withdrawal.acknowledgement.exemptItems).toEqual([{ name: "Tröja med ditt namn", quantity: 1, sku: "NAME-1" }]);
    expect(await withdrawalOf(order.orderId)).toMatchObject({ exempt_items_json: "[1]", withdrawn_items_json: "[0]" });
  });

  it("a personalised flag whose consent cannot be read: the consumer-safe reading, every line withdrawn", async () => {
    const order = await seedOrder(TENANT_A, { consentJson: '{"v":99}' });
    const answer = await (await withdraw(HOST_A, body(order))).json<Answer>();
    expect(answer.withdrawal).toMatchObject({ eligible: true, reason: null });
    expect(answer.withdrawal.acknowledgement.withdrawnItems).toHaveLength(1);
  });

  it("the 450-day cap is the only age limit: 449 days is received, 451 days is 'window_passed' (recorded too)", async () => {
    const young = await seedOrder(TENANT_A, { createdAt: Date.now() - 449 * DAY_MS });
    expect((await (await withdraw(HOST_A, body(young))).json<Answer>()).withdrawal).toMatchObject({ eligible: true });

    const old = await seedOrder(TENANT_A, { createdAt: Date.now() - 451 * DAY_MS });
    const response = await withdraw(HOST_A, body(old));
    expect(response.status).toBe(201);
    const answer = await response.json<Answer>();
    expect(answer.withdrawal).toMatchObject({ eligible: false, reason: "window_passed" });
    expect(answer.withdrawal.acknowledgement.withdrawnItems).toEqual([]);
    expect(await withdrawalOf(old.orderId)).toMatchObject({ eligible: 0, reason: "window_passed", withdrawn_items_json: "[]" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the record is append-only (0044)", () => {
  async function recorded(): Promise<StoredWithdrawal> {
    const order = await seedOrder(TENANT_A);
    expect((await withdraw(HOST_A, body(order))).status).toBe(201);
    const stored = await withdrawalOf(order.orderId);
    if (stored === null) {
      throw new Error("no row");
    }
    return stored;
  }

  function insert(verb: string, row: StoredWithdrawal, overrides: Partial<StoredWithdrawal> = {}) {
    const values = { ...row, ...overrides };
    return env.DB.prepare(
      `${verb} INTO withdrawals (withdrawal_id, tenant_id, order_id, eligible, reason, withdrawn_items_json,
         exempt_items_json, consumer_name, contact_email, shop_name, shop_notice_email, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        values.withdrawal_id,
        values.tenant_id,
        values.order_id,
        values.eligible,
        values.reason,
        values.withdrawn_items_json,
        values.exempt_items_json,
        values.consumer_name,
        values.contact_email,
        values.shop_name,
        values.shop_notice_email,
        values.received_at,
      )
      .run();
  }

  it("refuses every UPDATE and DELETE — the time of receipt can never be rewritten", async () => {
    const row = await recorded();
    await expect(
      env.DB.prepare("UPDATE withdrawals SET received_at = ? WHERE withdrawal_id = ?")
        .bind("2099-01-01T00:00:00.000Z", row.withdrawal_id)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("UPDATE withdrawals SET consumer_name = 'x' WHERE withdrawal_id = ?").bind(row.withdrawal_id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM withdrawals WHERE withdrawal_id = ?").bind(row.withdrawal_id).run(),
    ).rejects.toThrow(/append-only/);
    expect(await withdrawalOf(row.order_id)).toEqual(row);
  });

  it("refuses a second row for the order or the id — INSERT, OR IGNORE and OR REPLACE alike", async () => {
    const row = await recorded();
    const later = { received_at: "2099-01-01T00:00:00.000Z" };
    for (const verb of ["INSERT", "INSERT OR IGNORE", "INSERT OR REPLACE", "REPLACE"]) {
      await expect(insert(verb, row, { ...later, withdrawal_id: crypto.randomUUID() }), `${verb} same order`).rejects.toThrow(/append-only/);
      const other = await seedOrder(TENANT_A);
      await expect(insert(verb, row, { ...later, order_id: other.orderId }), `${verb} same id`).rejects.toThrow(/append-only/);
    }
    expect(await withdrawalOf(row.order_id)).toEqual(row);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawals WHERE order_id = ?", row.order_id)).toBe(1);
  });

  it("refuses a row that files one shop's order under another shop", async () => {
    const row = await recorded();
    const foreign = await seedOrder(TENANT_B);
    await expect(
      insert("INSERT", row, { order_id: foreign.orderId, withdrawal_id: crypto.randomUUID() }),
    ).rejects.toThrow(/must match order tenant_id/);
  });

  it.each([
    ["an eligible row with a reason", { eligible: 1, reason: "window_passed" }],
    ["a refusal without a reason", { eligible: 0, reason: null, withdrawn_items_json: "[]" }],
    ["a refusal that withdraws lines", { eligible: 0, reason: "window_passed", withdrawn_items_json: "[0]" }],
    ["an unknown reason", { eligible: 0, reason: "changed_mind", withdrawn_items_json: "[]" }],
    ["a time not in the canonical shape", { received_at: "2026-09-28 10:00:00" }],
    ["items that are not an array", { withdrawn_items_json: '{"0":1}' }],
    ["a malformed id", { withdrawal_id: "not-a-uuid" }],
    ["an empty name", { consumer_name: "" }],
    ["an address without an @", { contact_email: "nobody" }],
  ])("refuses %s (CHECK)", async (_label, overrides) => {
    const order = await seedOrder(TENANT_A);
    const base: StoredWithdrawal = {
      consumer_name: "N",
      contact_email: order.email,
      eligible: 1,
      exempt_items_json: "[]",
      order_id: order.orderId,
      reason: null,
      received_at: new Date().toISOString(),
      shop_name: null,
      shop_notice_email: null,
      tenant_id: TENANT_A,
      withdrawal_id: crypto.randomUUID(),
      withdrawn_items_json: "[0]",
    };
    await expect(insert("INSERT", base, overrides as Partial<StoredWithdrawal>)).rejects.toThrow(/CHECK|malformed/);
    // …and the same row without the fault is admitted: the CHECK named the fault.
    await expect(insert("INSERT", base)).resolves.toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the two mails (the withdrawal_email outbox effect)", () => {
  async function received(tenantId = TENANT_A, host = HOST_A, name = "Mejl Köpare") {
    const order = await seedOrder(tenantId, {
      lines: [
        { name: "Tröja <svart>", quantity: 1, sku: "TR-2" },
        { name: "Namnskylt", personalized: true, quantity: 1, sku: "SIGN" },
      ],
    });
    const response = await withdraw(host, body(order, { name }));
    expect(response.status).toBe(201);
    const answer = await response.json<Answer>();
    const stored = await withdrawalOf(order.orderId);
    if (stored === null) {
      throw new Error("no row");
    }
    const outbox = await outboxOf(stored.withdrawal_id);
    const byKind = (kind: string) => {
      const row = outbox.find((entry) => JSON.parse(entry.payload_json).kind === kind);
      if (row === undefined) {
        throw new Error(`no ${kind} row`);
      }
      return row;
    };
    return { answer, notice: byKind("withdrawal_notice"), order, receipt: byKind("withdrawal_receipt"), stored };
  }

  async function ledger(deliveryId: string) {
    return env.DB.prepare("SELECT * FROM email_deliveries WHERE delivery_id = ?")
      .bind(deliveryId)
      .first<{ job_fingerprint: string; kind: string; recipient_hash: string; status: string; tenant_id: string }>();
  }

  it("the receipt: ONE deterministic job to the purchase address, ledgered, with the receipt the page showed", async () => {
    const { answer, order, receipt, stored } = await received();
    const quiet = quietEnv();
    const claimed = await claimForTest(receipt.outbox_id);

    const outcome = await runWithdrawalEmailEffect(effectContext(claimed, quiet.env));

    expect(outcome).toEqual({ kind: "done" });
    expect(quiet.emails.sent).toHaveLength(1);
    const job = quiet.emails.sent[0] as WithdrawalEmailJob;
    const deliveryId = await deliveryIdFromKey(receipt.dedupe_key);
    expect(job).toEqual({
      actionUrl: "",
      createdAt: receipt.created_at,
      deliveryId,
      expiresAt: receipt.created_at + 24 * HOUR_MS,
      kind: "withdrawal_receipt",
      locale: "sv",
      recipient: order.email,
      tenantId: TENANT_A,
      version: 1,
      withdrawal: {
        acknowledgement: answer.withdrawal.acknowledgement,
        eligible: true,
        reason: null,
      },
    });
    expect(receipt.dedupe_key).toBe(`${WITHDRAWAL_EMAIL_EFFECT}:withdrawal_receipt:${stored.withdrawal_id}`);
    // The ledger row: the kind 0044 admits, the recipient hashed, the fingerprint over the content.
    expect(await ledger(deliveryId)).toMatchObject({
      job_fingerprint: await fingerprintWithdrawalEmailJob(job),
      kind: "withdrawal_receipt",
      recipient_hash: await hashEmailRecipient(order.email),
      status: "pending",
      tenant_id: TENANT_A,
    });
    // The consumer-side parse (after wiring) takes it back unchanged.
    expect(parseWithdrawalEmailJob(JSON.parse(JSON.stringify(job)))).toEqual(job);
    expect(await env.DB.prepare("SELECT status, result_ref FROM outbox_events WHERE outbox_id = ?").bind(receipt.outbox_id).first()).toEqual({
      result_ref: deliveryId,
      status: "done",
    });

    const message = renderWithdrawalEmail(job);
    expect(message.subject).toBe(`Mottagningsbevis – ångrat köp, order ${order.orderNumber}`);
    expect(message.text).toContain(`Mottaget: ${stored.received_at} (UTC)`);
    expect(message.text).toContain(`Butik: ${SHOP_A}`);
    expect(message.text).toContain(`Order: ${order.orderNumber}`);
    expect(message.text).toContain("Namn: Mejl Köpare");
    expect(message.text).toContain("Varor som ångras:\n- Tröja <svart> (TR-2) × 1");
    expect(message.text).toContain("Följande varor är specialtillverkade och omfattas inte av ångerrätten:\n- Namnskylt (SIGN) × 1");
    expect(message.text).toContain(`Ditt meddelande: ${withdrawalStatement("Mejl Köpare", order.orderNumber, stored.received_at)}`);
    expect(message.text).toContain("Spara detta mottagningsbevis.");
    expect(message.html).toContain("Tröja &lt;svart&gt;");
    expect(message.html).toContain("Butik A &amp; &lt;Co&gt;");
    expect(message.html).not.toContain("<svart>");
  });

  it("the notice: to the shop's support address as it was when the message arrived; says that no money moved", async () => {
    const { notice, order, stored } = await received();
    // The shop changes its address afterwards: the notice still goes where the row says.
    await env.DB.prepare("UPDATE tenants SET support_email = 'ny@butik-a.example.test' WHERE tenant_id = ?").bind(TENANT_A).run();
    try {
      const quiet = quietEnv();
      expect(await runWithdrawalEmailEffect(effectContext(await claimForTest(notice.outbox_id), quiet.env))).toEqual({ kind: "done" });
      const job = quiet.emails.sent[0] as WithdrawalEmailJob;
      expect(job).toMatchObject({ kind: "withdrawal_notice", recipient: SUPPORT_A, tenantId: TENANT_A });
      expect(stored.shop_notice_email).toBe(SUPPORT_A);
      const message = renderWithdrawalEmail(job);
      expect(message.subject).toBe(`Ångrat köp: order ${order.orderNumber}`);
      expect(message.text).toContain(`Kundens e-post: ${order.email}`);
      expect(message.text).toContain("Inga pengar har flyttats.");
      expect(message.text).toContain("ångerfristen är 14 dagar från den dag kunden tog emot varan");
    } finally {
      await env.DB.prepare("UPDATE tenants SET support_email = ? WHERE tenant_id = ?").bind(SUPPORT_A, TENANT_A).run();
    }
  });

  it("a retry after a failed enqueue builds the identical job; the ledger keeps one row and its fingerprint matches", async () => {
    const { receipt } = await received();
    const first = await runWithdrawalEmailEffect(
      effectContext(await claimForTest(receipt.outbox_id), quietEnv({ EMAIL_QUEUE: recordingQueue({ fail: true }).queue }).env),
    );
    expect(first).toMatchObject({ kind: "retry" });
    expect(await env.DB.prepare("SELECT status, last_error FROM outbox_events WHERE outbox_id = ?").bind(receipt.outbox_id).first()).toEqual({
      last_error: "email_queue_error",
      status: "pending",
    });
    const deliveryId = await deliveryIdFromKey(receipt.dedupe_key);
    const recorded = await ledger(deliveryId);
    expect(recorded?.status).toBe("pending");

    const quiet = quietEnv();
    expect(await runWithdrawalEmailEffect(effectContext(await claimForTest(receipt.outbox_id), quiet.env))).toEqual({ kind: "done" });
    const job = quiet.emails.sent[0] as WithdrawalEmailJob;
    expect(await fingerprintWithdrawalEmailJob(job)).toBe(recorded?.job_fingerprint);
    expect(await count("SELECT COUNT(*) AS n FROM email_deliveries WHERE delivery_id = ?", deliveryId)).toBe(1);
  });

  it("holds (retries) while the email queue is not bound; the withdrawal is untouched", async () => {
    const { receipt, stored } = await received();
    const outcome = await runWithdrawalEmailEffect(
      effectContext(await claimForTest(receipt.outbox_id), quietEnv({ EMAIL_QUEUE: undefined }).env),
    );
    expect(outcome).toMatchObject({ kind: "retry" });
    expect(await withdrawalOf(stored.order_id)).toEqual(stored);
  });

  it("gives up with an alert (ids only) rather than mail outside the ledger's 24 hours; the withdrawal stands", async () => {
    const order = await seedOrder(TENANT_A);
    const then = Date.now() - 25 * HOUR_MS;
    const response = await handleStorefrontWithdrawalRoute(quietEnv().env, withdrawalRequest(HOST_A, body(order, { name: "Sen Köpare" })), { now: then });
    expect(response.status).toBe(201);
    const stored = await withdrawalOf(order.orderId);
    expect(stored?.received_at).toBe(new Date(then).toISOString());
    const receipt = (await outboxOf(stored?.withdrawal_id ?? "")).find((row) => row.dedupe_key.includes("withdrawal_receipt"));
    if (receipt === undefined) {
      throw new Error("no receipt row");
    }
    const quiet = quietEnv();
    const outcome = await runWithdrawalEmailEffect(effectContext(await claimForTest(receipt.outbox_id), quiet.env));
    expect(outcome).toEqual({ kind: "failed" });
    expect(quiet.emails.sent).toHaveLength(0);
    const alert = await env.DB.prepare("SELECT kind, message FROM alerts WHERE resource_id = ?").bind(receipt.outbox_id).first<{ kind: string; message: string }>();
    expect(alert?.kind).toBe("outbox_failed");
    expect(alert?.message).toContain("email_expired");
    expect(alert?.message).not.toContain(order.email);
    expect(alert?.message).not.toContain("Sen Köpare");
    expect(await withdrawalOf(order.orderId)).toEqual(stored);
  });

  it("fails a row whose payload is not one of its own, without touching any withdrawal", async () => {
    const { stored } = await received();
    const now = Date.now();
    const outboxId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO outbox_events (outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
         dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, 'withdrawal', ?, ?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(outboxId, TENANT_A, WITHDRAWAL_EMAIL_EFFECT, stored.withdrawal_id, `bad:${outboxId}`, JSON.stringify({ kind: "newsletter", withdrawalId: stored.withdrawal_id }), now, now, now)
      .run();
    expect(await runWithdrawalEmailEffect(effectContext(await claimForTest(outboxId), quietEnv().env))).toEqual({ kind: "failed" });
    expect(await withdrawalOf(stored.order_id)).toEqual(stored);
  });

  it("before the wiring the email consumer leaves the rows untouched; after it, it runs them", async () => {
    const { receipt } = await received();
    const quiet = quietEnv();
    const result = await processOutboxRowById(quiet.env, receipt.outbox_id);
    const row = await env.DB.prepare("SELECT status, attempts, last_error FROM outbox_events WHERE outbox_id = ?")
      .bind(receipt.outbox_id)
      .first<{ attempts: number; last_error: string | null; status: string }>();
    if (isWithdrawalEmailEffectRunnable()) {
      expect(result).toEqual({ kind: "ran", outcome: { kind: "done" } });
      expect(row?.status).toBe("done");
    } else {
      // Never claimed, never failed by the order-confirmation effect.
      expect(result.kind).not.toBe("ran");
      expect(row).toEqual({ attempts: 0, last_error: null, status: "pending" });
      expect(quiet.emails.sent).toHaveLength(0);
    }
  });

  it("is wired on both sides or on neither: the outbox runs the effect exactly when the -email consumer reads its jobs", () => {
    // A half wiring would enqueue jobs the consumer drops as malformed while
    // the outbox row goes `done` — a receipt lost in silence. This trips first.
    expect(isWithdrawalEmailEffectRunnable()).toBe(EMAIL_WIRED);
  });

  it.runIf(EMAIL_WIRED)("after the wiring, the -email consumer sends each mail once, however often it is delivered", async () => {
    const { notice, order, receipt } = await received();
    const quiet = quietEnv();
    for (const row of [receipt, notice]) {
      expect(await runWithdrawalEmailEffect(effectContext(await claimForTest(row.outbox_id), quiet.env))).toEqual({ kind: "done" });
    }
    const jobs = (quiet.emails.sent as WithdrawalEmailJob[]).map((job) => JSON.parse(JSON.stringify(job)) as unknown);
    const acks: string[] = [];
    const calls: Request[] = [];
    const batch = {
      messages: [...jobs, ...jobs].map((messageBody, index) => ({
        ack: () => acks.push(`m${index}`),
        attempts: 1,
        body: messageBody,
        id: `m${index}`,
        retry: () => {
          throw new Error("no retry expected");
        },
        timestamp: new Date(),
      })),
      queue: "chopshop-test-email",
      retryAll: () => {
        throw new Error("no retryAll expected");
      },
    } as unknown as MessageBatch<unknown>;
    const resend = async (request: Request) => {
      calls.push(request);
      return Response.json({ id: `re_${crypto.randomUUID()}` });
    };

    await worker.queue(batch, { ...env, [RESEND_FETCH_OVERRIDE]: resend } as unknown as Env);

    expect(acks).toHaveLength(4);
    expect(calls).toHaveLength(2);
    const sent = await Promise.all(calls.map((call) => call.json<{ subject: string; to: string[] }>()));
    expect(sent.map((mail) => mail.to[0]).sort()).toEqual([order.email, SUPPORT_A].sort());
    for (const job of quiet.emails.sent as WithdrawalEmailJob[]) {
      expect((await ledger(job.deliveryId))?.status).toBe("sent");
    }
  });

  it("renders the refusals in their own words", async () => {
    const base = {
      createdAt: Date.now(),
      deliveryId: await deliveryIdFromKey("withdrawal_email:test:render"),
      expiresAt: Date.now() + HOUR_MS,
      recipient: "kund@example.test",
      tenantId: TENANT_A,
    };
    const acknowledgement: WithdrawalAcknowledgement = {
      consumerName: "Ann <b>",
      contactEmail: "kund@example.test",
      exemptItems: [{ name: "Tavla", quantity: 1, sku: "ART" }],
      orderNumber: "20260928-TESTTEST",
      shopName: null,
      statement: withdrawalStatement("Ann <b>", "20260928-TESTTEST", "2026-09-28T10:00:00.000Z"),
      submittedAt: "2026-09-28T10:00:00.000Z",
      withdrawnItems: [],
    };
    const personalised = renderWithdrawalEmail(
      createWithdrawalEmailJob({ ...base, kind: "withdrawal_receipt", withdrawal: { acknowledgement, eligible: false, reason: "personalized_exempt" } }),
    );
    expect(personalised.subject).toBe("Mottagningsbevis – meddelande om ångrat köp, order 20260928-TESTTEST");
    expect(personalised.text).toContain("vill ångra ditt köp");
    expect(personalised.text).toContain("bara specialtillverkade varor");
    expect(personalised.text).toContain("Reklamationsrätten vid fel på varan gäller alltid.");
    expect(personalised.text).not.toContain("Butik:");
    expect(personalised.html).toContain("Ann &lt;b&gt;");
    expect(personalised.html).not.toContain("<b>");

    const late = renderWithdrawalEmail(
      createWithdrawalEmailJob({ ...base, kind: "withdrawal_receipt", withdrawal: { acknowledgement: { ...acknowledgement, exemptItems: [] }, eligible: false, reason: "window_passed" } }),
    );
    expect(late.text).toContain("mer än 450 dagar sedan");

    const notice = renderWithdrawalEmail(
      createWithdrawalEmailJob({ ...base, kind: "withdrawal_notice", recipient: SUPPORT_A, withdrawal: { acknowledgement, eligible: false, reason: "personalized_exempt" } }),
    );
    expect(notice.subject).toBe("Meddelande om ångrat köp: order 20260928-TESTTEST");
    expect(notice.text).toContain("Funktionen svarade kunden att ångerrätten inte gäller");
    expect(notice.text).toContain("Inga pengar har flyttats.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the withdrawal job and its ledger", () => {
  const content: WithdrawalEmailContent = {
    acknowledgement: {
      consumerName: "Test Köpare",
      contactEmail: "kund@example.test",
      exemptItems: [],
      orderNumber: "20260928-AAAABBBB",
      shopName: "Butik",
      statement: withdrawalStatement("Test Köpare", "20260928-AAAABBBB", "2026-09-28T10:00:00.000Z"),
      submittedAt: "2026-09-28T10:00:00.000Z",
      withdrawnItems: [{ name: "Tröja", quantity: 1, sku: "TR" }],
    },
    eligible: true,
    reason: null,
  };

  async function job(overrides: Partial<WithdrawalEmailContent["acknowledgement"]> = {}, top: Partial<WithdrawalEmailContent> = {}) {
    return createWithdrawalEmailJob({
      createdAt: 1_790_000_000_000,
      deliveryId: await deliveryIdFromKey("withdrawal_email:withdrawal_receipt:fixed"),
      expiresAt: 1_790_000_000_000 + HOUR_MS,
      kind: "withdrawal_receipt",
      recipient: "Kund@Example.test",
      tenantId: TENANT_A,
      withdrawal: { ...content, ...top, acknowledgement: { ...content.acknowledgement, ...overrides } },
    });
  }

  it("parses only a link-less, Swedish, tenant-bound, well-formed job", async () => {
    const valid = JSON.parse(JSON.stringify(await job())) as Record<string, unknown>;
    expect(parseWithdrawalEmailJob(valid)).toMatchObject({ kind: "withdrawal_receipt", recipient: "kund@example.test" });
    const withdrawal = valid.withdrawal as Record<string, unknown>;
    const ack = withdrawal.acknowledgement as Record<string, unknown>;
    for (const tampered of [
      { ...valid, actionUrl: `${env.AUTH_BASE_URL}/api/auth/verify-email` },
      { ...valid, locale: "en" },
      { ...valid, tenantId: undefined },
      { ...valid, kind: "order_confirmation" },
      { ...valid, deliveryId: "not-a-uuid" },
      { ...valid, expiresAt: (valid.createdAt as number) + 25 * HOUR_MS },
      { ...valid, withdrawal: { ...withdrawal, reason: "window_passed" } },
      { ...valid, withdrawal: { ...withdrawal, eligible: false, reason: "window_passed" } },
      { ...valid, withdrawal: { ...withdrawal, acknowledgement: { ...ack, consumerName: "a\nb" } } },
      { ...valid, withdrawal: { ...withdrawal, acknowledgement: { ...ack, submittedAt: "yesterday" } } },
      { ...valid, withdrawal: { ...withdrawal, acknowledgement: { ...ack, withdrawnItems: [{ name: "", quantity: 1, sku: "" }] } } },
    ]) {
      expect(() => parseWithdrawalEmailJob(tampered)).toThrow();
    }
  });

  it("fingerprints the content: a changed time, name, line or verdict is a different job", async () => {
    const base = await fingerprintWithdrawalEmailJob(await job());
    const variants = await Promise.all([
      job({ submittedAt: "2026-09-28T10:00:00.001Z" }),
      job({ consumerName: "Annan Köpare" }),
      job({ withdrawnItems: [{ name: "Tröja", quantity: 2, sku: "TR" }] }),
      job({ withdrawnItems: [] }, { eligible: false, reason: "window_passed" }),
      job({ shopName: null }),
    ]);
    const prints = await Promise.all(variants.map(fingerprintWithdrawalEmailJob));
    expect(new Set([base, ...prints]).size).toBe(variants.length + 1);
    expect(await fingerprintWithdrawalEmailJob(await job())).toBe(base);
  });

  it("0044 admits the two withdrawal kinds in the ledger, still refuses unknown kinds, and keeps its triggers", async () => {
    const insert = (kind: string, fingerprint: string | null) =>
      env.DB.prepare(
        `INSERT INTO email_deliveries (delivery_id, tenant_id, kind, recipient_hash, status,
           attempts, max_attempts, next_attempt_at, expires_at, created_at, updated_at, job_fingerprint)
         VALUES (?, NULL, ?, ?, 'pending', 0, 8, 1, 2, 1, 1, ?)`,
      )
        .bind(crypto.randomUUID(), kind, "a".repeat(64), fingerprint)
        .run();
    for (const kind of ["withdrawal_receipt", "withdrawal_notice", "order_confirmation", "alert_digest", "password_reset", "email_verification"]) {
      await expect(insert(kind, "b".repeat(64)), kind).resolves.toBeDefined();
    }
    await expect(insert("newsletter", "b".repeat(64))).rejects.toThrow(/CHECK/);
    await expect(insert("withdrawal_receipt", null)).rejects.toThrow(/fingerprint is required/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the shop's admin order read (readAdminOrderWithdrawal, for the reviewer's wiring)", () => {
  it("shows the withdrawal with its time to the order's own shop, and to no other", async () => {
    const order = await seedOrder(TENANT_A, { createdAt: Date.now() - 3 * DAY_MS });
    const answer = await (await withdraw(HOST_A, body(order, { name: "Admin Läsare" }))).json<Answer>();
    const stored = await withdrawalOf(order.orderId);

    const view = await readAdminOrderWithdrawal(env.DB, TENANT_A, order.orderId);
    expect(view).toEqual({
      consumerName: "Admin Läsare",
      contactEmail: order.email,
      eligible: true,
      exemptItems: [],
      orderAgeDays: 3,
      reason: null,
      receivedAt: stored?.received_at,
      shopNotified: true,
      statement: answer.withdrawal.acknowledgement.statement,
      withdrawalId: stored?.withdrawal_id,
      withdrawnItems: answer.withdrawal.acknowledgement.withdrawnItems,
    });
    expect(await readAdminOrderWithdrawal(env.DB, TENANT_B, order.orderId)).toBeNull();
    const untouched = await seedOrder(TENANT_A);
    expect(await readAdminOrderWithdrawal(env.DB, TENANT_A, untouched.orderId)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("personal data", () => {
  it("no log line carries the buyer's name or address, on the intake or in the mail effect", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const order = await seedOrder(TENANT_A, { email: "private.person@example.test" });
    const response = await withdraw(HOST_A, body(order, { name: "Privat Person" }), {
      env: quietEnv({ OUTBOX_QUEUE: recordingQueue({ fail: true }).queue }).env,
    });
    expect(response.status).toBe(201);
    const stored = await withdrawalOf(order.orderId);
    for (const row of await outboxOf(stored?.withdrawal_id ?? "")) {
      await runWithdrawalEmailEffect(effectContext(await claimForTest(row.outbox_id), quietEnv().env));
    }
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain("private.person");
    expect(logged).not.toContain("Privat Person");
  });

  it("parseWithdrawalInput keeps exactly the three stated facts", () => {
    expect(
      parseWithdrawalInput({ orderNumber: " #20260928-abc ", statement: { contactEmail: " A@B.se ", name: " Namn " } }),
    ).toEqual({ contactEmail: "a@b.se", name: "Namn", orderNumber: "20260928-abc" });
  });
});
