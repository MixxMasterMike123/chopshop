import { env } from "cloudflare:workers";
import { expect } from "vitest";

import { createAuth } from "../src/auth/create-auth";
import { SNAPWEAR_SKUS } from "../src/dispatch/snapwear-skus";
import { printerJobId } from "../src/dispatch/snapwear-wire";
import type { OutboxRow } from "../src/outbox/outbox";

/**
 * Fixtures for the CP2-B suites (outbox, dispatch, order confirmation email).
 *
 * Orders are seeded the way CP2-A's webhook writes them (checkout → order →
 * order_items with `production_json`, `orders.production_snapshot_json`, and in
 * the same batch the `dispatch` + `email` outbox rows of the shared contract),
 * without going through Stripe: these suites test what happens AFTER the order
 * batch commits.
 */

export const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
export const SKU = [...SNAPWEAR_SKUS][0] as string;
export const OTHER_SKU = [...SNAPWEAR_SKUS][1] as string;
const DAY_MS = 24 * 60 * 60 * 1_000;

let counter = 0;

export function envWith(overrides: Record<PropertyKey, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

export async function seedTenant(tenantId: string, shopName = `Shop ${tenantId}`): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tenants (tenant_id, status, shop_name, default_locale,
       default_currency, created_at, updated_at)
     VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)
     ON CONFLICT(tenant_id) DO NOTHING`,
  )
    .bind(tenantId, shopName, now, now)
    .run();
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface PrintFileSpec {
  /** Written to the private bucket unless false (a missing file). */
  present?: boolean;
  r2Key?: string;
  /** Overrides the snapshot's sha256 (a mismatch). */
  sha256?: string;
  slot: string;
  /** Written WITHOUT a stored checksum. */
  unverified?: boolean;
}

export interface LineSpec {
  name?: string;
  printFiles?: PrintFileSpec[];
  /** null ⇒ a non-POD line (no production_json, no dispatch row). */
  production?: "none" | "pod";
  quantity?: number;
  sku?: string;
  unitPriceMinor?: number;
}

export interface SeededOrder {
  dispatchIds: string[];
  emailId: string;
  orderId: string;
  orderNumber: string;
  tenantId: string;
}

export interface SeedOrderOptions {
  createdAt?: number;
  customerEmail?: string;
  deliveryMethod?: "pickup" | "shipping";
  discountMinor?: number;
  lines?: LineSpec[];
  printer?: string | null;
  /** Skip the outbox rows (to insert them by hand). */
  withOutbox?: boolean;
}

/**
 * A paid order with its production snapshot and outbox rows, as the webhook
 * batch leaves it. Print files are real objects in the private bucket, written
 * WITH their sha256 (as render-jobs promote writes canonical prints).
 */
export async function seedOrder(
  tenantId: string,
  options: SeedOrderOptions = {},
): Promise<SeededOrder> {
  counter += 1;
  const now = options.createdAt ?? Date.now();
  const orderId = crypto.randomUUID();
  const checkoutId = `ck-cp2b-${counter}-${orderId.slice(0, 8)}`;
  const intentId = `pi_cp2b_${counter}_${orderId.slice(0, 8)}`;
  const orderNumber = `CP2B-${counter}`;
  const email = options.customerEmail ?? `buyer-${counter}@example.test`;
  const deliveryMethod = options.deliveryMethod ?? "pickup";
  const lines = options.lines ?? [{}];

  const productId = `prod-cp2b-${counter}-${orderId.slice(0, 8)}`;
  const bucket = env.PRIVATE_BUCKET;

  const items: Array<{
    lineNo: number;
    name: string;
    production: Record<string, unknown> | null;
    quantity: number;
    unitPriceMinor: number;
  }> = [];
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const quantity = line.quantity ?? 1;
    const unitPriceMinor = line.unitPriceMinor ?? 29_900;
    let production: Record<string, unknown> | null = null;
    if ((line.production ?? "pod") === "pod") {
      const printFiles = [];
      for (const spec of line.printFiles ?? [{ slot: "front" }]) {
        const r2Key = spec.r2Key ?? `pod/${tenantId}/print/art-${counter}-${lineNo}-${spec.slot}.png`;
        const bytes = new TextEncoder().encode(`print ${r2Key}`);
        const digest = await sha256Hex(bytes);
        if (spec.present !== false) {
          await bucket.put(r2Key, bytes, spec.unverified === true ? {} : { sha256: digest });
        }
        printFiles.push({
          heightMm: 350,
          r2Key,
          sha256: spec.sha256 ?? digest,
          slot: spec.slot,
          widthMm: 250,
        });
      }
      production = {
        lineNo,
        printFiles,
        productionCostMinor: 9_000,
        quantity,
        sku: line.sku ?? SKU,
        withholdMinor: 9_000,
      };
    }
    items.push({ lineNo, name: line.name ?? `Tröja ${lineNo}`, production, quantity, unitPriceMinor });
  }

  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0);
  const shipping = deliveryMethod === "pickup" ? 0 : 4_900;
  const discount = options.discountMinor ?? 0;
  const total = subtotal + shipping - discount;
  const vat = Math.round(total - total / 1.25);
  const snapshot =
    items.some((item) => item.production !== null) && options.printer !== null
      ? JSON.stringify({
          lines: items.filter((item) => item.production !== null).map((item) => item.production),
          printer: options.printer ?? "fake-printer",
          totals: { productionCostMinor: 9_000, withholdMinor: 9_000 },
        })
      : null;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO products (product_id, tenant_id, status, sku, name, b2c_price_minor,
         currency, created_at, updated_at)
       VALUES (?, ?, 'active', ?, 'Tröja', 29900, 'SEK', ?, ?)`,
    ).bind(productId, tenantId, `sku-${productId}`, now, now),
    env.DB.prepare(
      `INSERT INTO checkouts (
         checkout_id, tenant_id, status, customer_email, currency,
         delivery_method, shipping_country, subtotal_minor, shipping_minor,
         vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor,
         payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at
       ) VALUES (?, ?, 'completed', ?, 'SEK', ?, ?, ?, ?, ?, 2500, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      checkoutId,
      tenantId,
      email,
      deliveryMethod,
      deliveryMethod === "pickup" ? null : "SE",
      subtotal,
      shipping,
      vat,
      discount,
      discount > 0 ? "discount-cp2b" : null,
      total,
      intentId,
      `hash-${checkoutId}`,
      now + DAY_MS,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO orders (
         order_id, tenant_id, checkout_id, payment_intent_id, order_number,
         status, customer_email, currency, delivery_method, shipping_country,
         subtotal_minor, shipping_minor, vat_minor, vat_rate_bp,
         discount_minor, discount_code_id, total_minor, captured_minor,
         refunded_total_minor, stripe_event_id, paid_at, created_at, updated_at,
         production_snapshot_json
       ) VALUES (?, ?, ?, ?, ?, 'paid', ?, 'SEK', ?, ?, ?, ?, ?, 2500, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).bind(
      orderId,
      tenantId,
      checkoutId,
      intentId,
      orderNumber,
      email,
      deliveryMethod,
      deliveryMethod === "pickup" ? null : "SE",
      subtotal,
      shipping,
      vat,
      discount,
      discount > 0 ? "discount-cp2b" : null,
      total,
      total,
      `evt_cp2b_${counter}`,
      now,
      now,
      now,
      snapshot,
    ),
    ...items.map((item) =>
      env.DB.prepare(
        `INSERT INTO order_items (
           order_item_id, order_id, tenant_id, item_index, product_id, variant_id,
           sku, name, quantity, unit_price_minor, line_total_minor, created_at,
           updated_at, production_json
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        orderId,
        tenantId,
        item.lineNo - 1,
        productId,
        `sku-${productId}`,
        item.name,
        item.quantity,
        item.unitPriceMinor,
        item.quantity * item.unitPriceMinor,
        now,
        now,
        item.production === null ? null : JSON.stringify(item.production),
      ),
    ),
  ];

  const dispatchIds: string[] = [];
  const emailId = crypto.randomUUID();
  if (options.withOutbox !== false) {
    for (const item of items) {
      if (item.production === null) {
        continue;
      }
      const outboxId = crypto.randomUUID();
      dispatchIds.push(outboxId);
      statements.push(
        outboxInsert({
          aggregateId: orderId,
          dedupeKey: `dispatch:${orderId}:${item.lineNo}`,
          eventType: "dispatch",
          now,
          outboxId,
          payload: { jobId: printerJobId(orderId, item.lineNo), lineNo: item.lineNo, orderId },
          tenantId,
        }),
      );
    }
    statements.push(
      outboxInsert({
        aggregateId: orderId,
        dedupeKey: `email:order_confirmation:${orderId}`,
        eventType: "email",
        now,
        outboxId: emailId,
        payload: { kind: "order_confirmation", orderId },
        tenantId,
      }),
    );
  }

  await env.DB.batch(statements);
  return { dispatchIds, emailId, orderId, orderNumber, tenantId };
}

/** Exactly the INSERT CP2-A's webhook makes (src/commerce/webhook.ts). */
export function outboxInsert(row: {
  aggregateId: string;
  dedupeKey: string;
  eventType: string;
  now: number;
  outboxId: string;
  payload: Record<string, unknown>;
  tenantId: string | null;
}): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO outbox_events (
       outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
       dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'order', ?, ?, ?, 'pending', ?, ?, ?)`,
  ).bind(
    row.outboxId,
    row.tenantId,
    row.eventType,
    row.aggregateId,
    row.dedupeKey,
    JSON.stringify(row.payload),
    row.now,
    row.now,
    row.now,
  );
}

export async function outboxRow(outboxId: string): Promise<OutboxRow> {
  const row = await env.DB.prepare("SELECT * FROM outbox_events WHERE outbox_id = ?")
    .bind(outboxId)
    .first<OutboxRow>();
  if (row === null) {
    throw new Error(`no outbox row ${outboxId}`);
  }
  return row;
}

export interface LineRow {
  dispatch_state: string | null;
  dispatched_at: string | null;
  printer_job_ref: string | null;
  production_state: string | null;
}

export async function lineRow(orderId: string, lineNo = 1): Promise<LineRow> {
  const row = await env.DB.prepare(
    `SELECT dispatch_state, printer_job_ref, dispatched_at, production_state
     FROM order_items WHERE order_id = ? AND item_index = ?`,
  )
    .bind(orderId, lineNo - 1)
    .first<LineRow>();
  if (row === null) {
    throw new Error(`no line ${orderId}/${lineNo}`);
  }
  return row;
}

export async function printerJobs(orderId: string): Promise<
  Array<{ id: string; job_id: string; payload_json: string }>
> {
  const rows = await env.DB.prepare(
    "SELECT id, job_id, payload_json FROM fake_printer_jobs WHERE order_id = ? ORDER BY received_at, id",
  )
    .bind(orderId)
    .all<{ id: string; job_id: string; payload_json: string }>();
  return rows.results;
}

export async function alertsFor(resourceId: string): Promise<
  Array<{ id: string; kind: string; message: string; resolved_at: string | null; severity: string }>
> {
  const rows = await env.DB.prepare(
    `SELECT id, kind, severity, message, resolved_at FROM alerts
     WHERE resource_id = ? ORDER BY created_at, id`,
  )
    .bind(resourceId)
    .all<{ id: string; kind: string; message: string; resolved_at: string | null; severity: string }>();
  return rows.results;
}

// ── sessions ────────────────────────────────────────────────────────────────

const FIXTURE_PASSWORD = "test-password-long-enough";

export interface SignedUpUser {
  cookie: string;
  userId: string;
}

export async function signUp(email: string): Promise<SignedUpUser> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email, name: email, password: FIXTURE_PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  const body = await response.json<{ user: { id: string } }>();
  expect(response.status).toBe(200);

  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const signedIn = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
  expect(signedIn.status).toBe(200);
  if (cookie === undefined) {
    throw new Error("no session cookie");
  }
  return { cookie, userId: body.user.id };
}

export async function grantAccess(userId: string, accountType: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(userId, accountType, now, now)
    .run();
}

export async function grantMembership(userId: string, tenantId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (membership_id, tenant_id, user_id, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
  )
    .bind(`membership-${tenantId}-${userId}`, tenantId, userId, now, now)
    .run();
}

export function sessionRequest(
  url: string,
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
  const origin = options.origin === undefined ? new URL(url).origin : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, {
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

// ── fake queues ─────────────────────────────────────────────────────────────

export interface RecordingQueue {
  queue: Queue;
  sent: unknown[];
}

export function recordingQueue(options: { fail?: boolean } = {}): RecordingQueue {
  const sent: unknown[] = [];
  const queue = {
    async send(body: unknown) {
      if (options.fail === true) {
        throw new Error("queue down");
      }
      sent.push(body);
    },
    async sendBatch(messages: Iterable<MessageSendRequest>) {
      if (options.fail === true) {
        throw new Error("queue down");
      }
      for (const message of messages) {
        sent.push(message.body);
      }
    },
  } as unknown as Queue;
  return { queue, sent };
}

/** A fake env: recording queues, so no nudge reaches the pool's consumers. */
export function quietEnv(overrides: Record<PropertyKey, unknown> = {}): {
  emails: RecordingQueue;
  env: Env;
  nudges: RecordingQueue;
  renders: RecordingQueue;
} {
  const nudges = recordingQueue();
  const emails = recordingQueue();
  const renders = recordingQueue();
  return {
    emails,
    env: envWith({
      EMAIL_QUEUE: emails.queue,
      OUTBOX_QUEUE: nudges.queue,
      RENDER_JOBS_QUEUE: renders.queue,
      ...overrides,
    }),
    nudges,
    renders,
  };
}
