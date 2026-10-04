import { env } from "cloudflare:workers";

import { acceptTermsStatement } from "./legal-fixtures";

/**
 * Shared fixtures for the CP8-DC suites (discount holds, the preview, the
 * lifecycle). Not a test file (no `.test.`), so vitest never runs it alone.
 *
 * The clock is REAL (Date.now()), for the reason webhook.test.ts gives: the
 * routes read their own clock when they decide whether a hold still counts,
 * and seeded rows sit beside rows the routes write.
 */

export const MINUTE_MS = 60 * 1_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

let counter = 0;
/** Unique across a file's whole run: D1 persists between the tests of a file. */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.floor(Math.random() * 1e6)}`;
}

/** A PaymentIntent id of Stripe's shape (`pi_…`, no hyphen). */
export function nextIntentId(): string {
  counter += 1;
  return `pi_dc_${counter}_${Math.floor(Math.random() * 1e6)}`;
}

/** sha256 hex of `${tenantId}:${email}`, as createCheckout computes it. */
export async function buyerKeyOf(tenantId: string, email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${tenantId}:${email}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * An active shop on a verified storefront host that has accepted the platform
 * terms. `discountCodes` is opt-in (DC2): the switch row is written unless the
 * suite asks for none, so a suite that is not about the switch need not think
 * about it.
 */
export async function seedShop(
  tenantId: string,
  hostname: string,
  options: { commissionBps?: number | null; discountCodes?: boolean | null } = {},
): Promise<void> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, support_email, default_locale,
        default_currency, created_at, updated_at, commission_bps
      ) VALUES (?, 'active', ?, ?, 'sv-SE', 'SEK', ?, ?, ?)`,
    ).bind(tenantId, `Shop ${tenantId}`, `ops-${tenantId}@example.test`, now, now, options.commissionBps ?? null),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, now, now),
    acceptTermsStatement(env.DB, tenantId),
  ];
  const discountCodes = options.discountCodes === undefined ? true : options.discountCodes;
  if (discountCodes !== null) {
    statements.push(switchStatement(tenantId, discountCodes));
  }
  await env.DB.batch(statements);
}

export function switchStatement(tenantId: string, enabled: boolean): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO tenant_features (tenant_id, feature_key, enabled, updated_at, updated_by)
     VALUES (?, 'discountCodes', ?, ?, 'fixture')
     ON CONFLICT (tenant_id, feature_key) DO UPDATE SET enabled = excluded.enabled`,
  ).bind(tenantId, enabled ? 1 : 0, new Date().toISOString());
}

export async function setDiscountSwitch(tenantId: string, enabled: boolean): Promise<void> {
  await switchStatement(tenantId, enabled).run();
}

/** A plain (not POD) published product. */
export async function seedPlainProduct(tenantId: string, productId: string, priceMinor: number): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO products (
        product_id, tenant_id, status, sku, name, description,
        b2c_price_minor, currency, is_pod, weight_grams,
        allow_shipping, allow_pickup, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, NULL, ?, 'SEK', 0, 0, 1, 1, ?, ?)`,
    ).bind(productId, tenantId, `SKU-${productId}`, `Internal ${productId}`, priceMinor, now, now),
    env.DB.prepare(
      `INSERT INTO product_publications (
        product_id, tenant_id, published, public_name, public_description,
        public_price_minor, currency, projection_version, published_at, updated_at
      ) VALUES (?, ?, 1, ?, NULL, ?, 'SEK', 1, ?, ?)`,
    ).bind(productId, tenantId, `Public ${productId}`, priceMinor, now, now),
  ]);
}

export interface CodeSeed {
  active?: boolean;
  code: string;
  endsAt?: number | null;
  maxUses?: number | null;
  minSpendMinor?: number | null;
  percentBp?: number | null;
  productIds?: string[] | null;
  startsAt?: number | null;
  tenantId: string;
  type?: "fixed" | "percent";
  usedCount?: number;
  valueMinor?: number | null;
}

/** A campaign code row, written directly. Returns its id. */
export async function seedCode(seed: CodeSeed): Promise<string> {
  const id = nextId("dc");
  const now = Date.now();
  const type = seed.type ?? (seed.percentBp == null ? "fixed" : "percent");
  await env.DB.prepare(
    `INSERT INTO discount_codes (
      discount_code_id, tenant_id, code, active, type, value_minor, percent_bp,
      starts_at, ends_at, max_uses, used_count, min_spend_minor, scope,
      product_ids_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      seed.tenantId,
      seed.code,
      (seed.active ?? true) ? 1 : 0,
      type,
      type === "fixed" ? (seed.valueMinor ?? 500) : null,
      type === "percent" ? (seed.percentBp ?? 1_000) : null,
      seed.startsAt ?? null,
      seed.endsAt ?? null,
      seed.maxUses ?? null,
      seed.usedCount ?? 0,
      seed.minSpendMinor ?? null,
      seed.productIds == null ? "all" : "products",
      seed.productIds == null ? null : JSON.stringify(seed.productIds),
      now,
      now,
    )
    .run();
  return id;
}

export interface DiscountedCheckoutSeed {
  /** created_at = updated_at; defaults to now. */
  createdAt?: number;
  /** The buyer's address, lowercased as the parser would. */
  email?: string;
  discountCodeId: string | null;
  discountMinor?: number;
  expiresAt?: number;
  paymentIntentId?: string | null;
  paymentIntentStatus?: string | null;
  paymentIntentStatusAt?: number | null;
  subtotalMinor?: number;
  tenantId: string;
  /** One frozen line worth the subtotal, as the webhook copies it. */
  withLine?: boolean;
}

/**
 * A checkout row whose money satisfies 0009/0010's CHECKs, with the discount
 * frozen as the checkout would freeze it (and, `withLine`, one line).
 */
export async function seedDiscountedCheckout(seed: DiscountedCheckoutSeed): Promise<{
  checkoutId: string;
  email: string;
  expiresAt: number;
  totalMinor: number;
}> {
  const now = seed.createdAt ?? Date.now();
  const checkoutId = nextId("ck-dc");
  const email = seed.email ?? `${checkoutId}@buyer.test`;
  const subtotal = seed.subtotalMinor ?? 10_000;
  const discount = seed.discountMinor ?? (seed.discountCodeId === null ? 0 : 1_000);
  const expiresAt = seed.expiresAt ?? now + DAY_MS;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO checkouts (
        checkout_id, tenant_id, status, customer_email, currency,
        delivery_method, shipping_country, subtotal_minor, shipping_minor,
        vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor,
        payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at,
        payment_intent_status, payment_intent_status_at
      ) VALUES (?, ?, 'open', ?, 'SEK', 'pickup', NULL, ?, 0, 0, 2500, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      checkoutId,
      seed.tenantId,
      email,
      subtotal,
      discount,
      seed.discountCodeId,
      subtotal - discount,
      seed.paymentIntentId ?? null,
      `hash-${checkoutId}`,
      expiresAt,
      now,
      now,
      seed.paymentIntentStatus ?? null,
      seed.paymentIntentStatusAt ?? null,
    ),
  ];
  if (seed.withLine === true) {
    const productId = nextId("prod-dc");
    statements.push(
      env.DB.prepare(
        `INSERT INTO products (
          product_id, tenant_id, status, sku, name, b2c_price_minor, currency,
          created_at, updated_at
        ) VALUES (?, ?, 'active', ?, 'Mugg', ?, 'SEK', ?, ?)`,
      ).bind(productId, seed.tenantId, `SKU-${productId}`, subtotal, now, now),
      env.DB.prepare(
        `INSERT INTO checkout_items (
          checkout_item_id, checkout_id, tenant_id, item_index, product_id,
          variant_id, sku, name, quantity, unit_price_minor,
          line_total_minor, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, NULL, ?, 'Mugg', 1, ?, ?, ?, ?)`,
      ).bind(`ci-${checkoutId}`, checkoutId, seed.tenantId, productId, `SKU-${productId}`, subtotal, subtotal, now, now),
    );
  }
  await env.DB.batch(statements);
  return { checkoutId, email, expiresAt, totalMinor: subtotal - discount };
}

export interface HoldSeed {
  buyerKey: string;
  checkoutId: string;
  createdAt?: number;
  discountCodeId: string;
  expiresAt?: number;
  holdId?: string;
  orderId?: string | null;
  state?: string;
  tenantId: string;
}

export function holdStatement(seed: HoldSeed): D1PreparedStatement {
  const createdAt = seed.createdAt ?? Date.now();
  return env.DB.prepare(
    `INSERT INTO discount_code_holds (
      hold_id, tenant_id, discount_code_id, checkout_id, buyer_key, state,
      order_id, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    seed.holdId ?? nextId("hold"),
    seed.tenantId,
    seed.discountCodeId,
    seed.checkoutId,
    seed.buyerKey,
    seed.state ?? "held",
    seed.orderId ?? null,
    seed.expiresAt ?? createdAt + 60 * MINUTE_MS,
    createdAt,
    createdAt,
  );
}

/**
 * A checkout that froze `codeId` for `email`, and its live hold. Returns the
 * checkout id and the buyer key.
 */
export async function seedHeldCheckout(
  tenantId: string,
  codeId: string,
  options: {
    createdAt?: number;
    email?: string;
    expiresAt?: number;
    paymentIntentId?: string | null;
    withLine?: boolean;
  } = {},
): Promise<{ buyerKey: string; checkoutId: string; email: string; holdId: string; totalMinor: number }> {
  const checkout = await seedDiscountedCheckout({
    discountCodeId: codeId,
    ...(options.email === undefined ? {} : { email: options.email }),
    ...(options.paymentIntentId === undefined ? {} : { paymentIntentId: options.paymentIntentId }),
    ...(options.withLine === undefined ? {} : { withLine: options.withLine }),
    tenantId,
  });
  const buyerKey = await buyerKeyOf(tenantId, checkout.email);
  const holdId = nextId("hold");
  await holdStatement({
    buyerKey,
    checkoutId: checkout.checkoutId,
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    discountCodeId: codeId,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    holdId,
    tenantId,
  }).run();
  return { buyerKey, checkoutId: checkout.checkoutId, email: checkout.email, holdId, totalMinor: checkout.totalMinor };
}

export interface HoldRow {
  buyer_key: string;
  checkout_id: string;
  created_at: number;
  discount_code_id: string;
  expires_at: number;
  hold_id: string;
  order_id: string | null;
  state: string;
  tenant_id: string;
  updated_at: number;
}

export async function holdsOfCheckout(checkoutId: string): Promise<HoldRow[]> {
  const rows = await env.DB.prepare("SELECT * FROM discount_code_holds WHERE checkout_id = ?")
    .bind(checkoutId)
    .all<HoldRow>();
  return rows.results;
}

export async function holdById(holdId: string): Promise<HoldRow | null> {
  return env.DB.prepare("SELECT * FROM discount_code_holds WHERE hold_id = ?").bind(holdId).first<HoldRow>();
}

export async function usedCountOf(codeId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT used_count FROM discount_codes WHERE discount_code_id = ?")
    .bind(codeId)
    .first<{ used_count: number }>();
  return row?.used_count ?? -1;
}

/** The message a refused statement aborted with, or null when it ran. */
export async function refusal(statement: D1PreparedStatement): Promise<string | null> {
  try {
    await statement.run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
