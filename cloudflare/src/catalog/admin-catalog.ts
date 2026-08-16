import type { TenantAdminPrincipal } from "../auth/live-authorization";
import type {
  ShippingRates,
  ShippingRatesWire,
} from "../commerce/shipping";
import {
  MAX_WEIGHT_GRAMS,
  normalizeShippingRates,
  toShippingRatesWire,
} from "../commerce/shipping";

export interface AdminProduct {
  allowPickup: boolean;
  allowShipping: boolean;
  currency: string;
  description: string | null;
  name: string;
  priceMinor: number;
  productId: string;
  // The admin-facing `{region: {cost}}` form, identical to what a write sends
  // and to what the column stores, so a product round-trips unchanged.
  shippingRates: ShippingRatesWire | null;
  sku: string;
  status: ProductStatus;
  weightGrams: number;
}

export type ProductStatus = "draft" | "active" | "archived";

export type AdminCatalogResult =
  | { product: AdminProduct; status: "ok" }
  | { status: "conflict" | "invalid" | "not_found" };

export interface CreateProductInput {
  allowPickup?: boolean;
  allowShipping?: boolean;
  currency: string;
  description: string | null;
  name: string;
  priceMinor: number;
  shippingRates?: ShippingRates | null;
  sku: string;
  weightGrams?: number;
}

export interface UpdateProductInput {
  allowPickup?: boolean;
  allowShipping?: boolean;
  description?: string | null;
  name?: string;
  priceMinor?: number;
  shippingRates?: ShippingRates | null;
  sku?: string;
  status?: ProductStatus;
  weightGrams?: number;
}

interface ProductRow {
  allow_pickup: number;
  allow_shipping: number;
  currency: string;
  description: string | null;
  name: string;
  b2c_price_minor: number;
  product_id: string;
  shipping_json: string | null;
  sku: string;
  status: ProductStatus;
  weight_grams: number;
}

const CREATE_KEYS = [
  "allowPickup",
  "allowShipping",
  "currency",
  "description",
  "name",
  "priceMinor",
  "shippingRates",
  "sku",
  "weightGrams",
] as const;
const UPDATE_KEYS = [
  "allowPickup",
  "allowShipping",
  "description",
  "name",
  "priceMinor",
  "shippingRates",
  "sku",
  "status",
  "weightGrams",
] as const;
const PRODUCT_STATUSES: ProductStatus[] = ["draft", "active", "archived"];
const SKU_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 2_000;
const PRICE_MINOR_MAX = 100_000_000;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// Defaults for a freshly created product, matching the schema's column
// defaults. Shipping is permitted and pickup is not: a merchant who has not
// configured collection cannot honour a collected order, and defaulting the
// other way would let a buyer zero the carriage on a product nobody agreed to
// hand over in person.
const DEFAULT_WEIGHT_GRAMS = 0;
const DEFAULT_ALLOW_SHIPPING = true;
const DEFAULT_ALLOW_PICKUP = false;
const PRODUCT_SELECT = `SELECT
     product_id, sku, name, description, b2c_price_minor, currency, status,
     weight_grams, allow_shipping, allow_pickup, shipping_json
   FROM products
   WHERE tenant_id = ?
     AND product_id = ?
   LIMIT 1`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function parseSku(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= SKU_MAX_LENGTH
    ? value
    : null;
}

function parseName(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= NAME_MAX_LENGTH
    ? value
    : null;
}

function parseDescription(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && value.length <= DESCRIPTION_MAX_LENGTH
    ? value
    : undefined;
}

function parsePriceMinor(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= PRICE_MINOR_MAX
    ? value
    : null;
}

function parseCurrency(value: unknown): string | null {
  return typeof value === "string" && CURRENCY_PATTERN.test(value)
    ? value
    : null;
}

function parseWeightGrams(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_WEIGHT_GRAMS
    ? value
    : null;
}

/**
 * Strictly boolean. A truthy 1 or "true" is refused rather than coerced: these
 * two flags decide whether a basket may skip carriage, so a caller that sends
 * the wrong type should be told it sent the wrong type, not quietly granted the
 * meaning the coercion happened to produce.
 */
function parseBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * The per-region carriage table. Shape validation is delegated to the same
 * gate the checkout engine reads with, so a table that can be written here is
 * exactly a table that prices correctly there — unknown region keys, non-integer
 * costs, and out-of-range costs are all rejected, and the whole object is
 * refused rather than partially accepted.
 *
 * `null` is a meaningful value: it clears the table back to the fallback
 * tariff. `undefined` (absent key) means "leave unchanged" and is distinguished
 * from it by the caller.
 */
function parseShippingRatesInput(
  value: unknown,
): ShippingRates | null | undefined {
  if (value === null) {
    return null;
  }

  return normalizeShippingRates(value) ?? undefined;
}

function parseStatus(value: unknown): ProductStatus | null {
  return typeof value === "string" &&
    (PRODUCT_STATUSES as string[]).includes(value)
    ? (value as ProductStatus)
    : null;
}

export function parseCreateProductInput(
  body: unknown,
): CreateProductInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CREATE_KEYS)) {
    return null;
  }

  const sku = parseSku(body.sku);
  const name = parseName(body.name);
  const priceMinor = parsePriceMinor(body.priceMinor);
  const currency = parseCurrency(body.currency);
  const description =
    body.description === undefined
      ? null
      : parseDescription(body.description);

  if (
    sku === null ||
    name === null ||
    priceMinor === null ||
    currency === null ||
    description === undefined
  ) {
    return null;
  }

  const input: CreateProductInput = {
    currency,
    description,
    name,
    priceMinor,
    sku,
  };

  if (body.weightGrams !== undefined) {
    const weightGrams = parseWeightGrams(body.weightGrams);
    if (weightGrams === null) {
      return null;
    }
    input.weightGrams = weightGrams;
  }

  if (body.allowShipping !== undefined) {
    const allowShipping = parseBoolean(body.allowShipping);
    if (allowShipping === null) {
      return null;
    }
    input.allowShipping = allowShipping;
  }

  if (body.allowPickup !== undefined) {
    const allowPickup = parseBoolean(body.allowPickup);
    if (allowPickup === null) {
      return null;
    }
    input.allowPickup = allowPickup;
  }

  if (body.shippingRates !== undefined) {
    const shippingRates = parseShippingRatesInput(body.shippingRates);
    if (shippingRates === undefined) {
      return null;
    }
    input.shippingRates = shippingRates;
  }

  return input;
}

export function parseUpdateProductInput(
  body: unknown,
): UpdateProductInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, UPDATE_KEYS)) {
    return null;
  }

  const input: UpdateProductInput = {};

  if (body.sku !== undefined) {
    const sku = parseSku(body.sku);
    if (sku === null) {
      return null;
    }
    input.sku = sku;
  }

  if (body.name !== undefined) {
    const name = parseName(body.name);
    if (name === null) {
      return null;
    }
    input.name = name;
  }

  if (body.description !== undefined) {
    const description = parseDescription(body.description);
    if (description === undefined) {
      return null;
    }
    input.description = description;
  }

  if (body.priceMinor !== undefined) {
    const priceMinor = parsePriceMinor(body.priceMinor);
    if (priceMinor === null) {
      return null;
    }
    input.priceMinor = priceMinor;
  }

  if (body.status !== undefined) {
    const status = parseStatus(body.status);
    if (status === null) {
      return null;
    }
    input.status = status;
  }

  if (body.weightGrams !== undefined) {
    const weightGrams = parseWeightGrams(body.weightGrams);
    if (weightGrams === null) {
      return null;
    }
    input.weightGrams = weightGrams;
  }

  if (body.allowShipping !== undefined) {
    const allowShipping = parseBoolean(body.allowShipping);
    if (allowShipping === null) {
      return null;
    }
    input.allowShipping = allowShipping;
  }

  if (body.allowPickup !== undefined) {
    const allowPickup = parseBoolean(body.allowPickup);
    if (allowPickup === null) {
      return null;
    }
    input.allowPickup = allowPickup;
  }

  if (body.shippingRates !== undefined) {
    const shippingRates = parseShippingRatesInput(body.shippingRates);
    if (shippingRates === undefined) {
      return null;
    }
    input.shippingRates = shippingRates;
  }

  return Object.keys(input).length === 0 ? null : input;
}

function toAdminProduct(row: ProductRow): AdminProduct {
  return {
    allowPickup: row.allow_pickup === 1,
    allowShipping: row.allow_shipping === 1,
    currency: row.currency,
    description: row.description,
    name: row.name,
    priceMinor: row.b2c_price_minor,
    productId: row.product_id,
    // Re-validated on the way out with the same gate that guards the way in. A
    // row that somehow holds a malformed blob reports no table rather than
    // handing an admin a shape the checkout engine will refuse to price from.
    shippingRates: toWire(storedShippingRates(row)),
    sku: row.sku,
    status: row.status,
    weightGrams: row.weight_grams,
  };
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The stored carriage table in internal form, or null when there is none. */
function storedShippingRates(row: ProductRow): ShippingRates | null {
  return emptyToNull(
    normalizeShippingRates(
      row.shipping_json === null ? null : safeParseJson(row.shipping_json),
    ),
  );
}

/** Internal → admin-facing, preserving 'no table' as null rather than {}. */
function toWire(rates: ShippingRates | null): ShippingRatesWire | null {
  return rates === null ? null : toShippingRatesWire(rates);
}

/**
 * The stored form of a carriage table: the same `{region: {cost}}` shape the
 * admin sends and reads back, so the column holds exactly what the parser
 * accepts and `parseShippingRates` can validate it on the way out with the same
 * gate that guarded the way in.
 *
 * `null` and an empty table are stored identically as SQL NULL: an object with
 * no regions configures nothing, and keeping two encodings of "no table" would
 * mean two code paths that must stay in agreement forever.
 */
function serializeShippingRates(rates: ShippingRates | null): string | null {
  const stored = emptyToNull(rates);
  return stored === null ? null : JSON.stringify(toShippingRatesWire(stored));
}

function emptyToNull(rates: ShippingRates | null): ShippingRates | null {
  return rates === null || Object.keys(rates).length === 0 ? null : rates;
}

function isUniqueConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

function auditStatement(
  db: D1Database,
  principal: TenantAdminPrincipal,
  action: string,
  productId: string,
  now: number,
  metadata: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        event_id, tenant_id, actor_user_id, action, resource_type,
        resource_id, request_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'product', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      principal.tenantId,
      principal.userId,
      action,
      productId,
      crypto.randomUUID(),
      metadata === null ? null : JSON.stringify(metadata),
      now,
    );
}

async function loadProduct(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<ProductRow | null> {
  return db.prepare(PRODUCT_SELECT).bind(tenantId, productId).first<ProductRow>();
}

export async function createAdminProduct(
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: CreateProductInput,
  now: number,
): Promise<AdminCatalogResult> {
  const productId = crypto.randomUUID();
  const weightGrams = input.weightGrams ?? DEFAULT_WEIGHT_GRAMS;
  const allowShipping = input.allowShipping ?? DEFAULT_ALLOW_SHIPPING;
  const allowPickup = input.allowPickup ?? DEFAULT_ALLOW_PICKUP;
  const shippingRates = input.shippingRates ?? null;

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO products (
            product_id, tenant_id, status, sku, name, description,
            b2c_price_minor, currency, is_pod, weight_grams,
            allow_shipping, allow_pickup, shipping_json, created_at, updated_at
          ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          productId,
          principal.tenantId,
          input.sku,
          input.name,
          input.description,
          input.priceMinor,
          input.currency,
          weightGrams,
          allowShipping ? 1 : 0,
          allowPickup ? 1 : 0,
          serializeShippingRates(shippingRates),
          now,
          now,
        ),
      auditStatement(db, principal, "product.create", productId, now, null),
    ]);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return {
    product: {
      allowPickup,
      allowShipping,
      currency: input.currency,
      description: input.description,
      name: input.name,
      priceMinor: input.priceMinor,
      productId,
      shippingRates: toWire(emptyToNull(shippingRates)),
      sku: input.sku,
      status: "draft",
      weightGrams,
    },
    status: "ok",
  };
}

export async function updateAdminProduct(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  input: UpdateProductInput,
  now: number,
): Promise<AdminCatalogResult> {
  const existing = await loadProduct(db, principal.tenantId, productId);
  if (existing === null) {
    return { status: "not_found" };
  }

  const current = toAdminProduct(existing);
  // The carriage table is carried in internal form through this function and
  // converted once, below, so the value that is serialized to the column and
  // the value that is returned come from the same source.
  // `undefined` leaves the table alone; an explicit `null` clears it. An empty
  // object is stored as no table at all, so it is reported that way too — the
  // response must describe the row that was actually written.
  const nextRates = emptyToNull(
    input.shippingRates === undefined
      ? storedShippingRates(existing)
      : input.shippingRates,
  );

  const next: AdminProduct = {
    allowPickup: input.allowPickup ?? current.allowPickup,
    allowShipping: input.allowShipping ?? current.allowShipping,
    currency: current.currency,
    description: input.description === undefined
      ? current.description
      : input.description,
    name: input.name ?? current.name,
    priceMinor: input.priceMinor ?? current.priceMinor,
    productId,
    shippingRates: toWire(nextRates),
    sku: input.sku ?? current.sku,
    status: input.status ?? current.status,
    weightGrams: input.weightGrams ?? current.weightGrams,
  };

  const publication = await db
    .prepare(
      `SELECT published
       FROM product_publications
       WHERE tenant_id = ?
         AND product_id = ?
       LIMIT 1`,
    )
    .bind(principal.tenantId, productId)
    .first<{ published: number }>();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE products
         SET sku = ?, name = ?, description = ?, b2c_price_minor = ?,
             status = ?, weight_grams = ?, allow_shipping = ?,
             allow_pickup = ?, shipping_json = ?, updated_at = ?
         WHERE tenant_id = ?
           AND product_id = ?`,
      )
      .bind(
        next.sku,
        next.name,
        next.description,
        next.priceMinor,
        next.status,
        next.weightGrams,
        next.allowShipping ? 1 : 0,
        next.allowPickup ? 1 : 0,
        serializeShippingRates(nextRates),
        now,
        principal.tenantId,
        productId,
      ),
  ];

  if (publication !== null) {
    // Keep the read projection honest: it mirrors the canonical row, and a
    // product that is no longer active can never stay published.
    statements.push(
      db
        .prepare(
          `UPDATE product_publications
           SET public_name = ?, public_description = ?, public_price_minor = ?,
               currency = ?, published = CASE WHEN ? = 'active' THEN published ELSE 0 END,
               projection_version = projection_version + 1, updated_at = ?
           WHERE tenant_id = ?
             AND product_id = ?`,
        )
        .bind(
          next.name,
          next.description,
          next.priceMinor,
          next.currency,
          next.status,
          now,
          principal.tenantId,
          productId,
        ),
    );
  }

  statements.push(
    auditStatement(db, principal, "product.update", productId, now, {
      fields: Object.keys(input).sort(),
    }),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return { product: next, status: "ok" };
}

export async function publishAdminProduct(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  now: number,
): Promise<AdminCatalogResult> {
  const existing = await loadProduct(db, principal.tenantId, productId);
  if (existing === null) {
    return { status: "not_found" };
  }
  if (existing.status !== "active") {
    return { status: "conflict" };
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO product_publications (
          product_id, tenant_id, published, public_name, public_description,
          public_price_minor, currency, projection_version, published_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(product_id) DO UPDATE SET
          published = 1,
          public_name = excluded.public_name,
          public_description = excluded.public_description,
          public_price_minor = excluded.public_price_minor,
          currency = excluded.currency,
          projection_version = product_publications.projection_version + 1,
          published_at = excluded.published_at,
          updated_at = excluded.updated_at`,
      )
      .bind(
        productId,
        principal.tenantId,
        existing.name,
        existing.description,
        existing.b2c_price_minor,
        existing.currency,
        now,
        now,
      ),
    auditStatement(db, principal, "product.publish", productId, now, null),
  ]);

  return { product: toAdminProduct(existing), status: "ok" };
}

export async function unpublishAdminProduct(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  now: number,
): Promise<AdminCatalogResult> {
  const existing = await loadProduct(db, principal.tenantId, productId);
  if (existing === null) {
    return { status: "not_found" };
  }

  await db.batch([
    db
      .prepare(
        `UPDATE product_publications
         SET published = 0, projection_version = projection_version + 1,
             updated_at = ?
         WHERE tenant_id = ?
           AND product_id = ?`,
      )
      .bind(now, principal.tenantId, productId),
    auditStatement(db, principal, "product.unpublish", productId, now, null),
  ]);

  return { product: toAdminProduct(existing), status: "ok" };
}
