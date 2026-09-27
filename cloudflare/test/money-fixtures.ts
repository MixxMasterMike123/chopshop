import { env } from "cloudflare:workers";
import { expect } from "vitest";
import Stripe from "stripe";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";
import type {
  ChargeView,
  CreatePaymentIntentParams,
  CreateRefundParams,
  Listing,
  PaymentIntentPage,
  PaymentIntentSummary,
  PaymentIntentView,
  RefundView,
  StripeMoneyGateway,
  TransferReversalView,
  TransferView,
} from "../src/commerce/stripe-client";
import {
  collectPages,
  STRIPE_API_VERSION,
  STRIPE_GATEWAY_OVERRIDE,
  StripeGatewayError,
} from "../src/commerce/stripe-client";

/**
 * Shared fixtures for the CP2-A money suites. Not a test file (no `.test.`),
 * so vitest never runs it on its own; every suite imports what it needs.
 *
 * The clock is REAL (Date.now()), for the reason webhook.test.ts gives: rows
 * seeded here sit beside rows the live routes write, and the schema's
 * `updated_at >= created_at` CHECKs compare them. Suites that need "7 days
 * later" pass a later `now` to the cron functions instead of freezing time.
 */

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
export const WEBHOOK_PATH = "/v1/webhooks/stripe";

let counter = 0;
/** Unique across a file's whole run: D1 persists between the tests of a file. */
export function next(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}_${Math.floor(Math.random() * 1e6)}`;
}

// ── The fake Stripe ─────────────────────────────────────────────────────────

type Behaviour = "ok" | "reject" | "unavailable";

interface FakeIntent extends PaymentIntentView {
  chargeCreated: number | null;
  created: number;
  metadata: Record<string, string>;
}

/**
 * A Stripe stand-in with the semantics the money paths rely on:
 *  - every create is IDEMPOTENT on its key (same key ⇒ same object, no
 *    second effect), as Stripe's idempotency keys are;
 *  - refunds respect Stripe's own ceiling (Σ refunds ≤ the intent's amount)
 *    and refuse with a 400-class error beyond it;
 *  - cancel refuses an intent that already succeeded;
 *  - every call is recorded, so a suite can assert exactly what reached
 *    "Stripe".
 * Knobs make any call refuse (a 4xx: `rejected`) or fail with an unknown
 * outcome (`unavailable`).
 */
export class FakeMoneyStripe implements StripeMoneyGateway {
  readonly cancelCalls: string[] = [];
  readonly createCalls: CreatePaymentIntentParams[] = [];
  readonly refundCalls: CreateRefundParams[] = [];
  readonly reversalCalls: Array<Parameters<StripeMoneyGateway["createTransferReversal"]>[0]> = [];
  readonly transferCalls: Array<Parameters<StripeMoneyGateway["createTransfer"]>[0]> = [];

  readonly charges = new Map<string, ChargeView>();
  readonly intents = new Map<string, FakeIntent>();
  readonly refunds = new Map<string, RefundView>();
  private readonly refundsByKey = new Map<string, RefundView>();
  private readonly reversalsByKey = new Map<string, TransferReversalView>();
  private readonly transfersByKey = new Map<string, TransferView>();
  /** Every reversal made, per transfer (what listTransferReversals shows). */
  readonly reversalsByTransfer = new Map<string, TransferReversalView[]>();
  /** Every transfer made, per transfer_group. */
  readonly transfersByGroup = new Map<string, TransferView[]>();
  /** Create the reversal / transfer at "Stripe", then lose the answer. */
  loseReversalResponse = false;
  loseTransferResponse = false;
  /** Listing page size and bound — lets a suite force an incomplete listing. */
  listPageSize = 100;
  listMaxPages = 20;
  readonly listRefundCalls: string[] = [];
  /** Remaining reversible amount per transfer. */
  readonly transferRemaining = new Map<string, number>();

  refundBehaviour: Behaviour = "ok";
  /** Create the refund at "Stripe", then lose the answer. */
  loseRefundResponse = false;
  refundStatus = "succeeded";
  reversalBehaviour: Behaviour = "ok";
  transferBehaviour: Behaviour = "ok";
  listBehaviour: Behaviour = "ok";
  /** Runs inside createRefund BEFORE Stripe "acts" — an interleaving hook. */
  beforeRefund: ((params: CreateRefundParams) => Promise<void>) | null = null;

  private fail(behaviour: Behaviour): void {
    if (behaviour === "reject") {
      throw new StripeGatewayError(true);
    }
    if (behaviour === "unavailable") {
      throw new StripeGatewayError(false);
    }
  }

  /** Registers an intent this fake "created" (e.g. for a seeded checkout). */
  addIntent(intent: Partial<FakeIntent> & { amount: number; id: string }): FakeIntent {
    const full: FakeIntent = {
      chargeCreated: null,
      client_secret: `${intent.id}_secret`,
      created: Math.floor(Date.now() / 1_000),
      currency: "sek",
      metadata: {},
      status: "requires_payment_method",
      ...intent,
    };
    this.intents.set(full.id, full);
    return full;
  }

  setIntentStatus(id: string, status: string): void {
    const intent = this.intents.get(id);
    if (intent !== undefined) {
      this.intents.set(id, { ...intent, status });
    }
  }

  addCharge(charge: ChargeView, transferAmount?: number): void {
    this.charges.set(charge.id, charge);
    if (charge.transfer !== null && transferAmount !== undefined) {
      this.transferRemaining.set(charge.transfer, transferAmount);
    }
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentView> {
    this.createCalls.push(params);
    const id = `pi_${params.idempotencyKey.replace(/[^A-Za-z0-9]/g, "")}`;
    const existing = this.intents.get(id);
    if (existing !== undefined) {
      return existing;
    }
    return this.addIntent({ amount: params.amount, id, metadata: params.metadata });
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntentView> {
    const intent = this.intents.get(id);
    if (intent === undefined) {
      throw new StripeGatewayError(true);
    }
    return intent;
  }

  async cancelPaymentIntent(id: string): Promise<PaymentIntentView> {
    this.cancelCalls.push(id);
    const intent = this.intents.get(id);
    if (intent === undefined) {
      throw new StripeGatewayError(true);
    }
    if (intent.status === "canceled") {
      return intent;
    }
    if (intent.status === "succeeded" || intent.status === "processing") {
      // Stripe: "You cannot cancel this PaymentIntent because it has a status
      // of succeeded."
      throw new StripeGatewayError(true);
    }
    const canceled = { ...intent, status: "canceled" };
    this.intents.set(id, canceled);
    return canceled;
  }

  async createRefund(params: CreateRefundParams): Promise<RefundView> {
    this.refundCalls.push(params);
    if (this.beforeRefund !== null) {
      await this.beforeRefund(params);
    }
    this.fail(this.refundBehaviour);

    const existing = this.refundsByKey.get(params.idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }

    const intent = this.intents.get(params.paymentIntentId);
    const refunded = [...this.refunds.values()]
      .filter((r) => r.payment_intent === params.paymentIntentId && r.status !== "failed")
      .reduce((sum, r) => sum + r.amount, 0);
    if (intent !== undefined && refunded + params.amount > intent.amount) {
      // Stripe's own ceiling — never reached when the reservation works.
      throw new StripeGatewayError(true);
    }

    const refund: RefundView = {
      amount: params.amount,
      charge: null,
      id: `re_${params.idempotencyKey.replace(/[^A-Za-z0-9]/g, "")}`,
      metadata: params.metadata,
      payment_intent: params.paymentIntentId,
      status: this.refundStatus,
    };
    this.refundsByKey.set(params.idempotencyKey, refund);
    this.refunds.set(refund.id, refund);
    if (this.loseRefundResponse) {
      throw new StripeGatewayError(false);
    }
    return refund;
  }

  /** A refund made in the Stripe dashboard: exists at Stripe, unknown here. */
  addDashboardRefund(paymentIntentId: string, amount: number, status = "succeeded"): RefundView {
    const refund: RefundView = {
      amount,
      charge: null,
      id: next("re_dash"),
      metadata: {},
      payment_intent: paymentIntentId,
      status,
    };
    this.refunds.set(refund.id, refund);
    return refund;
  }

  setRefundStatus(id: string, status: string): RefundView {
    const refund = this.refunds.get(id);
    if (refund === undefined) {
      throw new Error(`no refund ${id}`);
    }
    const updated = { ...refund, status };
    this.refunds.set(id, updated);
    for (const [key, value] of this.refundsByKey) {
      if (value.id === id) {
        this.refundsByKey.set(key, updated);
      }
    }
    return updated;
  }

  /** Serves `all` in pages through the production pager (collectPages). */
  private async paged<T extends { id: string }>(all: T[]): Promise<Listing<T>> {
    return collectPages(async (startingAfter) => {
      const start =
        startingAfter === null ? 0 : all.findIndex((item) => item.id === startingAfter) + 1;
      const data = all.slice(start, start + this.listPageSize);
      return { data, hasMore: start + this.listPageSize < all.length };
    }, this.listMaxPages);
  }

  async listRefunds(paymentIntentId: string): Promise<Listing<RefundView>> {
    this.listRefundCalls.push(paymentIntentId);
    this.fail(this.listBehaviour);
    return this.paged([...this.refunds.values()].filter((r) => r.payment_intent === paymentIntentId));
  }

  async listTransferReversals(transferId: string): Promise<Listing<TransferReversalView>> {
    this.fail(this.listBehaviour);
    return this.paged(this.reversalsByTransfer.get(transferId) ?? []);
  }

  async listTransfersByGroup(group: string): Promise<Listing<TransferView>> {
    this.fail(this.listBehaviour);
    return this.paged(this.transfersByGroup.get(group) ?? []);
  }

  async retrieveCharge(chargeId: string): Promise<ChargeView> {
    const charge = this.charges.get(chargeId);
    if (charge === undefined) {
      throw new StripeGatewayError(true);
    }
    return charge;
  }

  async createTransferReversal(
    params: Parameters<StripeMoneyGateway["createTransferReversal"]>[0],
  ): Promise<TransferReversalView> {
    this.reversalCalls.push(params);
    this.fail(this.reversalBehaviour);
    const existing = this.reversalsByKey.get(params.idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }
    const remaining = this.transferRemaining.get(params.transferId) ?? 0;
    if (remaining <= 0) {
      throw new StripeGatewayError(true);
    }
    const reversal = { amount: remaining, id: next("trr"), metadata: params.metadata };
    this.transferRemaining.set(params.transferId, 0);
    this.reversalsByKey.set(params.idempotencyKey, reversal);
    this.reversalsByTransfer.set(params.transferId, [
      ...(this.reversalsByTransfer.get(params.transferId) ?? []),
      reversal,
    ]);
    if (this.loseReversalResponse) {
      throw new StripeGatewayError(false);
    }
    return reversal;
  }

  async createTransfer(
    params: Parameters<StripeMoneyGateway["createTransfer"]>[0],
  ): Promise<TransferView> {
    this.transferCalls.push(params);
    this.fail(this.transferBehaviour);
    const existing = this.transfersByKey.get(params.idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }
    const transfer = { amount: params.amount, id: next("tr"), metadata: params.metadata };
    this.transfersByKey.set(params.idempotencyKey, transfer);
    this.transfersByGroup.set(params.transferGroup, [
      ...(this.transfersByGroup.get(params.transferGroup) ?? []),
      transfer,
    ]);
    if (this.loseTransferResponse) {
      throw new StripeGatewayError(false);
    }
    return transfer;
  }

  async listPaymentIntents(params: {
    createdGte: number;
    limit: number;
    startingAfter: string | null;
  }): Promise<PaymentIntentPage> {
    this.fail(this.listBehaviour);
    const all: PaymentIntentSummary[] = [...this.intents.values()]
      .filter((intent) => intent.created >= params.createdGte)
      .map((intent) => ({
        amount: intent.amount,
        chargeCreated: intent.chargeCreated,
        created: intent.created,
        currency: intent.currency,
        id: intent.id,
        metadata: intent.metadata,
        status: intent.status,
      }));
    const start =
      params.startingAfter === null
        ? 0
        : all.findIndex((i) => i.id === params.startingAfter) + 1;
    const page = all.slice(start, start + params.limit);
    return { data: page, hasMore: start + params.limit < all.length };
  }
}

export function moneyEnv(stripe: FakeMoneyStripe, overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides, [STRIPE_GATEWAY_OVERRIDE]: stripe } as unknown as Env;
}

// ── Seeding ─────────────────────────────────────────────────────────────────

export interface SeedTenantOptions {
  chargesEnabled?: boolean;
  commissionBps?: number | null;
  connect?: boolean;
  hostname?: string;
  payoutsEnabled?: boolean;
  shopName?: string;
}

export async function seedTenant(
  tenantId: string,
  options: SeedTenantOptions = {},
): Promise<string | null> {
  const now = Date.now();
  const connect = options.connect ?? true;
  const accountId = connect ? `acct_${tenantId.replace(/[^A-Za-z0-9]/g, "")}` : null;
  const statements = [
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, support_email, default_locale,
        default_currency, created_at, updated_at, stripe_account_id,
        stripe_charges_enabled, stripe_payouts_enabled, commission_bps
      ) VALUES (?, 'active', ?, ?, 'sv-SE', 'SEK', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      tenantId,
      options.shopName ?? `Shop ${tenantId}`,
      `ops-${tenantId}@example.test`,
      now,
      now,
      accountId,
      connect && (options.chargesEnabled ?? true) ? 1 : 0,
      connect && (options.payoutsEnabled ?? true) ? 1 : 0,
      options.commissionBps ?? null,
    ),
  ];
  if (options.hostname !== undefined) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO tenant_domains (
          domain_id, tenant_id, hostname, kind, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
      ).bind(`domain-${tenantId}`, tenantId, options.hostname, now, now),
    );
  }
  await env.DB.batch(statements);
  return accountId;
}

export interface SnapshotLine {
  lineNo: number;
  productionCostMinor: number;
  quantity: number;
  sku: string;
  withholdMinor: number;
}

export function snapshotJson(lines: SnapshotLine[]): string {
  const withhold = lines.reduce((sum, line) => sum + line.withholdMinor, 0);
  const cost = lines.reduce((sum, line) => sum + line.productionCostMinor, 0);
  return JSON.stringify({
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      printFiles: [
        {
          heightMm: 350,
          r2Key: `pod/print/${line.sku}.png`,
          sha256: "a".repeat(64),
          slot: "front",
          widthMm: 250,
        },
      ],
      productionCostMinor: line.productionCostMinor,
      quantity: line.quantity,
      sku: line.sku,
      withholdMinor: line.withholdMinor,
    })),
    printer: "fake-printer",
    totals: { productionCostMinor: cost, withholdMinor: withhold },
  });
}

export interface SeedCheckoutOptions {
  /** Frozen Connect facts, as the payment route writes them. */
  connect?: { accountId: string; feeMinor: number; withheldMinor: number } | null;
  expiresAt?: number;
  itemCount?: number;
  paymentIntentId?: string | null;
  paymentIntentStatus?: string | null;
  paymentIntentStatusAt?: number | null;
  snapshot?: string | null;
  status?: string;
  tenantId: string;
  unitPriceMinor?: number;
  updatedAt?: number;
}

export interface SeededCheckout {
  checkoutId: string;
  paymentIntentId: string | null;
  totalMinor: number;
}

export async function seedCheckout(options: SeedCheckoutOptions): Promise<SeededCheckout> {
  const now = Date.now();
  const createdAt = options.updatedAt ?? now;
  const checkoutId = next("ck");
  const itemCount = options.itemCount ?? 1;
  const unit = options.unitPriceMinor ?? 20_000;
  const total = unit * itemCount;
  const intentId =
    options.paymentIntentId === undefined ? next("pi") : options.paymentIntentId;

  const productIds: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < itemCount; index += 1) {
    const productId = next("prod");
    productIds.push(productId);
    statements.push(
      env.DB.prepare(
        `INSERT INTO products (
          product_id, tenant_id, status, sku, name, b2c_price_minor, currency,
          created_at, updated_at
        ) VALUES (?, ?, 'active', ?, ?, ?, 'SEK', ?, ?)`,
      ).bind(productId, options.tenantId, `SKU-${productId}`, `Tee ${index}`, unit, now, now),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO checkouts (
        checkout_id, tenant_id, status, customer_email, currency,
        delivery_method, shipping_country, subtotal_minor, shipping_minor,
        vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor,
        payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at,
        connect_account_id, application_fee_minor, withheld_minor,
        payment_intent_status, payment_intent_status_at, production_snapshot_json
      ) VALUES (?, ?, ?, ?, 'SEK', 'pickup', NULL, ?, 0, 0, 2500, 0, NULL, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?)`,
    ).bind(
      checkoutId,
      options.tenantId,
      options.status ?? "open",
      `buyer-${checkoutId}@example.test`,
      total,
      total,
      intentId,
      `hash-${checkoutId}`,
      options.expiresAt ?? now + DAY_MS,
      createdAt,
      createdAt,
      options.connect?.accountId ?? null,
      options.connect?.feeMinor ?? null,
      options.connect?.withheldMinor ?? null,
      options.paymentIntentStatus ?? null,
      options.paymentIntentStatusAt ?? null,
      options.snapshot ?? null,
    ),
  );

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
        `SKU-${productId}`,
        `Tee ${index}`,
        unit,
        unit,
        createdAt,
        createdAt,
      ),
    );
  }

  await env.DB.batch(statements);
  return { checkoutId, paymentIntentId: intentId, totalMinor: total };
}

// ── Signed webhook events ───────────────────────────────────────────────────

const signer = new Stripe("sk_test_signing_helper_only", {
  apiVersion: STRIPE_API_VERSION,
  httpClient: Stripe.createFetchHttpClient(),
});

export async function postEvent(
  type: string,
  object: Record<string, unknown>,
  options: { created?: number; env?: Env; eventId?: string } = {},
): Promise<{ eventId: string; response: Response }> {
  const eventId = options.eventId ?? next("evt");
  const payload = JSON.stringify({
    api_version: STRIPE_API_VERSION,
    created: options.created ?? Math.floor(Date.now() / 1_000),
    data: { object },
    id: eventId,
    livemode: false,
    object: "event",
    type,
  });
  const signature = await signer.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });
  const response = await worker.fetch(
    new Request(`https://hooks.money.test${WEBHOOK_PATH}`, {
      body: payload,
      headers: { "content-type": "application/json", "stripe-signature": signature },
      method: "POST",
    }),
    options.env ?? (env as Env),
  );
  return { eventId, response };
}

/** Pays a seeded checkout through the REAL webhook and returns the order id. */
export async function payCheckout(
  checkout: SeededCheckout,
  tenantId: string,
  options: { latestCharge?: string } = {},
): Promise<string> {
  const { response } = await postEvent("payment_intent.succeeded", {
    amount: checkout.totalMinor,
    currency: "sek",
    id: checkout.paymentIntentId,
    ...(options.latestCharge === undefined ? {} : { latest_charge: options.latestCharge }),
    metadata: { checkout_id: checkout.checkoutId, tenant_id: tenantId },
    object: "payment_intent",
    status: "succeeded",
  });
  expect(response.status).toBe(200);
  const order = await env.DB.prepare("SELECT order_id FROM orders WHERE checkout_id = ?")
    .bind(checkout.checkoutId)
    .first<{ order_id: string }>();
  if (order === null) {
    throw new Error("the webhook did not create an order");
  }
  return order.order_id;
}

export async function paymentEventRow(eventId: string) {
  return env.DB.prepare(
    "SELECT outcome, reason_code, tenant_id, object_id FROM payment_events WHERE event_id = ?",
  )
    .bind(eventId)
    .first<{ object_id: string | null; outcome: string; reason_code: string | null; tenant_id: string | null }>();
}

export interface OrderMoneyRow {
  application_fee_minor: number;
  charged_minor: number;
  connect_account_id: string | null;
  dispute_amount_minor: number;
  dispute_id: string | null;
  dispute_recovery: string | null;
  dispute_retransferred_minor: number;
  dispute_status: string | null;
  payout_state: string;
  refund_reserved_minor: number;
  refund_succeeded_minor: number;
  refund_version: number;
  refunded_total_minor: number;
  status: string;
  stripe_amount_refunded_minor: number;
  stripe_charge_id: string | null;
  stripe_transfer_id: string | null;
  transfer_reversed_minor: number;
  withheld_minor: number;
}

export async function orderMoney(orderId: string): Promise<OrderMoneyRow> {
  const row = await env.DB.prepare("SELECT * FROM orders WHERE order_id = ?")
    .bind(orderId)
    .first<OrderMoneyRow>();
  if (row === null) {
    throw new Error(`no order ${orderId}`);
  }
  return row;
}

export async function refundOps(orderId: string) {
  const rows = await env.DB.prepare(
    `SELECT id, state, amount_minor, origin, stripe_refund_id, created_by, reason
     FROM refund_operations WHERE order_id = ? ORDER BY created_at, id`,
  )
    .bind(orderId)
    .all<{
      amount_minor: number;
      created_by: string | null;
      id: string;
      origin: string;
      reason: string | null;
      state: string;
      stripe_refund_id: string | null;
    }>();
  return rows.results;
}

export async function openAlerts(kind: string, resourceId?: string) {
  const rows = await env.DB.prepare(
    `SELECT id, tenant_id, kind, severity, message, resource_type, resource_id
     FROM alerts WHERE kind = ? AND resolved_at IS NULL
       AND (?2 IS NULL OR resource_id = ?2)`,
  )
    .bind(kind, resourceId ?? null)
    .all<{ id: string; kind: string; message: string; resource_id: string; resource_type: string; severity: string; tenant_id: string | null }>();
  return rows.results;
}

// ── Admin sessions (Better Auth, exactly as the admin suites build them) ────

export interface Admin {
  cookie: string;
  userId: string;
}

const FIXTURE_PASSWORD = "test-password-long-enough";

export async function signUpAdmin(email: string, tenantId: string | null): Promise<Admin> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email, name: email, password: FIXTURE_PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.json<{ user: { id: string } }>();

  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const signedIn = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) {
    throw new Error("no session cookie");
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
     VALUES (?, 'tenant_admin', 'active', ?, ?)`,
  )
    .bind(body.user.id, now, now)
    .run();
  if (tenantId !== null) {
    await env.DB.prepare(
      `INSERT INTO tenant_memberships (
        membership_id, tenant_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
    )
      .bind(`membership-${tenantId}-${body.user.id}`, tenantId, body.user.id, now, now)
      .run();
  }
  return { cookie, userId: body.user.id };
}

export const ADMIN_HOST = "https://admin.money.test";

export function adminRequest(
  path: string,
  method: string,
  options: { body?: unknown; cookie?: string; origin?: string | null; shopId?: string | null } = {},
): Request {
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  if (options.shopId !== undefined && options.shopId !== null) {
    headers.set("x-shop-id", options.shopId);
  }
  const origin = options.origin === undefined ? ADMIN_HOST : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(`${ADMIN_HOST}${path}`, {
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body),
    headers,
    method,
  });
}
