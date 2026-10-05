import { env } from "cloudflare:workers";

import { acceptTermsStatement } from "./legal-fixtures";

/**
 * Fixtures of CP9-AC (Övergiven kassa): a shop that can take orders, its two
 * switches, products, and checkouts written straight into D1 at a chosen
 * time with a chosen frozen consent. Invented data only.
 */

export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;

let counter = 0;

/** A fresh suffix, unique within the test file. */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

export interface ReminderShop {
  host: string;
  tenantId: string;
}

/**
 * An active, published shop with a name, a support address, an account that
 * takes destination charges and its legal gate open (acceptTermsStatement's
 * fixture trigger). `addOn`: the platform's add-on row (null: no row, the
 * opt-in default off). `seller`: the seller's switch row (null: none).
 */
export async function seedReminderShop(
  tenantId: string,
  options: {
    addOn?: boolean | null;
    seller?: { delayHours?: number; enabled: boolean; enabledAt?: number | null } | null;
    shopName?: string | null;
    supportEmail?: string | null;
  } = {},
): Promise<ReminderShop> {
  const now = Date.now();
  const host = `${tenantId}.reminders.test`;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, support_email, default_locale,
        default_currency, created_at, updated_at, stripe_account_id,
        stripe_charges_enabled, stripe_payouts_enabled
      ) VALUES (?, 'active', ?, ?, 'sv-SE', 'SEK', ?, ?, ?, 1, 1)`,
    ).bind(
      tenantId,
      options.shopName === undefined ? `Butik ${tenantId}` : options.shopName,
      options.supportEmail === undefined ? `hej@${tenantId}.test` : options.supportEmail,
      now,
      now,
      `acct_${tenantId.replace(/[^A-Za-z0-9]/g, "")}`,
    ),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, host, now, now),
    acceptTermsStatement(env.DB, tenantId),
  ];
  const addOn = options.addOn === undefined ? true : options.addOn;
  if (addOn !== null) {
    statements.push(addOnStatement(tenantId, addOn));
  }
  await env.DB.batch(statements);
  const seller = options.seller === undefined ? { enabled: true, enabledAt: 1 } : options.seller;
  if (seller !== null) {
    await setSellerSwitch(tenantId, seller);
  }
  return { host, tenantId };
}

export function addOnStatement(tenantId: string, enabled: boolean): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO tenant_features (tenant_id, feature_key, enabled, updated_at, updated_by)
     VALUES (?, 'abandonedCheckout', ?, ?, 'fixture')
     ON CONFLICT (tenant_id, feature_key) DO UPDATE SET enabled = excluded.enabled`,
  ).bind(tenantId, enabled ? 1 : 0, new Date().toISOString());
}

export async function setAddOn(tenantId: string, enabled: boolean): Promise<void> {
  await addOnStatement(tenantId, enabled).run();
}

/** The seller's switch as the admin route would leave it (enabledAt: when it was turned on). */
export async function setSellerSwitch(
  tenantId: string,
  seller: { delayHours?: number; enabled: boolean; enabledAt?: number | null },
): Promise<void> {
  const enabledAt = seller.enabledAt === undefined ? (seller.enabled ? 1 : null) : seller.enabledAt;
  await env.DB.prepare(
    `INSERT INTO checkout_reminder_settings (tenant_id, enabled, delay_hours, enabled_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, 'fixture')
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = excluded.enabled, delay_hours = excluded.delay_hours,
       enabled_at = excluded.enabled_at, updated_at = excluded.updated_at`,
  )
    .bind(tenantId, seller.enabled ? 1 : 0, seller.delayHours ?? 1, enabledAt, Date.now())
    .run();
}

/** A published, active product (and optionally one variant) of `tenantId`. */
export async function seedProduct(
  tenantId: string,
  productId: string,
  options: { name?: string; priceMinor?: number; published?: boolean; variant?: { active?: boolean; label: string; variantId: string } } = {},
): Promise<void> {
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO products (
        product_id, tenant_id, status, sku, name, description,
        b2c_price_minor, currency, is_pod, internal_json, weight_grams,
        allow_shipping, allow_pickup, shipping_json, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, NULL, ?, 'SEK', 0, NULL, 300, 1, 1, NULL, ?, ?)`,
    ).bind(productId, tenantId, `SKU-${productId}`, options.name ?? `Produkt ${productId}`, options.priceMinor ?? 10_000, now, now),
    env.DB.prepare(
      `INSERT INTO product_publications (
        product_id, tenant_id, published, public_name, public_description,
        public_price_minor, currency, projection_version, published_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, 'SEK', 1, ?, ?)`,
    ).bind(
      productId,
      tenantId,
      options.published === false ? 0 : 1,
      options.name ?? `Produkt ${productId}`,
      options.priceMinor ?? 10_000,
      now,
      now,
    ),
  ];
  if (options.variant !== undefined) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO product_variants (
          variant_id, tenant_id, product_id, sku, label, price_minor,
          active, attributes_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).bind(
        options.variant.variantId,
        tenantId,
        productId,
        `SKU-${options.variant.variantId}`,
        options.variant.label,
        options.priceMinor ?? 10_000,
        options.variant.active === false ? 0 : 1,
        now,
        now,
      ),
    );
  }
  await env.DB.batch(statements);
}

/** A frozen consent as consent.ts freezeConsent writes it (reminder only when true). */
export function consentJson(options: { marketing?: boolean; reminder?: boolean } = {}): string {
  return JSON.stringify({
    marketing: options.marketing === true,
    recordedAt: "2026-10-05T10:00:00.000Z",
    ...(options.reminder === true ? { reminder: true } : {}),
    terms: true,
    v: 1,
    withdrawal: { disclosureSha256: null, disclosureVersion: null, personalizedItems: [], waived: false },
  });
}

export interface SeededCheckout {
  checkoutId: string;
  email: string;
  paymentIntentId: string | null;
}

/**
 * A checkout as checkout + payment would leave it, written at `createdAt`.
 * Defaults: open, an intent, the reminder box ticked, one line of `productId`.
 */
export async function seedCheckout(
  tenantId: string,
  options: {
    consent?: string | null;
    createdAt: number;
    email?: string;
    lines?: Array<{ name?: string; productId: string; quantity?: number; variantId?: string | null }>;
    paymentIntentId?: string | null;
    paymentIntentStatus?: string | null;
    recipientName?: string | null;
    status?: "abandoned" | "completed" | "expired" | "open";
  },
): Promise<SeededCheckout> {
  const checkoutId = crypto.randomUUID();
  const email = options.email ?? `${nextId("buyer")}@buyer.test`;
  const paymentIntentId =
    options.paymentIntentId === undefined ? `pi_${checkoutId.replaceAll("-", "")}` : options.paymentIntentId;
  const lines = options.lines ?? [];
  const subtotal = lines.reduce((sum, line) => sum + 10_000 * (line.quantity ?? 1), 0);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO checkouts (
        checkout_id, tenant_id, status, customer_email, currency,
        delivery_method, shipping_country, subtotal_minor, shipping_minor,
        vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor,
        payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at,
        payment_intent_status, payment_intent_status_at, consent_json
      ) VALUES (?, ?, ?, ?, 'SEK', 'pickup', NULL, ?, 0, 0, 2500, 0, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      checkoutId,
      tenantId,
      options.status ?? "open",
      email,
      subtotal,
      subtotal,
      paymentIntentId,
      `hash-${checkoutId}`,
      options.createdAt + DAY_MS,
      options.createdAt,
      options.createdAt,
      options.paymentIntentStatus ?? null,
      options.consent === undefined ? consentJson({ reminder: true }) : options.consent,
    ),
  ];
  for (const [index, line] of lines.entries()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO checkout_items (
          checkout_item_id, checkout_id, tenant_id, item_index, product_id,
          variant_id, sku, name, quantity, unit_price_minor,
          line_total_minor, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 10000, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        checkoutId,
        tenantId,
        index,
        line.productId,
        line.variantId ?? null,
        `SKU-${line.variantId ?? line.productId}`,
        line.name ?? `Produkt ${line.productId}`,
        line.quantity ?? 1,
        10_000 * (line.quantity ?? 1),
        options.createdAt,
        options.createdAt,
      ),
    );
  }
  if (options.recipientName !== null) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO checkout_recipients (
           checkout_id, tenant_id, delivery_method, name, phone, address_line1,
           address_line2, postal_code, city, country, pickup_location_id,
           pickup_location_name, pickup_location_address, pickup_date, created_at
         ) VALUES (?, ?, 'pickup', ?, NULL, NULL, NULL, NULL, NULL, NULL, 'fixture-pickup',
                   'Testbutikens utlämning', 'Testgatan 1, 123 45 Teststad', NULL, ?)`,
      ).bind(checkoutId, tenantId, options.recipientName ?? "Anna Andersson", new Date(options.createdAt).toISOString()),
    );
  }
  await env.DB.batch(statements);
  return { checkoutId, email, paymentIntentId };
}

/** An order row for a checkout (the webhook's), the columns its CHECKs need. */
export async function seedOrderFor(tenantId: string, checkout: SeededCheckout, now = Date.now()): Promise<string> {
  const orderId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO orders (
       order_id, tenant_id, checkout_id, payment_intent_id, order_number,
       status, customer_email, currency, delivery_method, shipping_country,
       subtotal_minor, shipping_minor, vat_minor, vat_rate_bp,
       discount_minor, discount_code_id, total_minor, captured_minor,
       refunded_total_minor, stripe_event_id, paid_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'paid', ?, 'SEK', 'pickup', NULL, 10000, 0, 2000, 2500, 0, NULL, 10000, 10000, 0, ?, ?, ?, ?)`,
  )
    .bind(
      orderId,
      tenantId,
      checkout.checkoutId,
      checkout.paymentIntentId ?? `pi_order_${orderId.replaceAll("-", "")}`,
      `CS-${orderId.slice(0, 8)}`,
      checkout.email,
      `evt_${orderId.replaceAll("-", "")}`,
      now,
      now,
      now,
    )
    .run();
  return orderId;
}

export async function catalogVersionOf(tenantId: string): Promise<number> {
  return count("SELECT catalog_version AS n FROM tenants WHERE tenant_id = ?", tenantId);
}

export async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** An SQL error's message (D1 wraps the RAISE text). */
export async function refusal(statement: D1PreparedStatement): Promise<string> {
  try {
    await statement.run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
}
