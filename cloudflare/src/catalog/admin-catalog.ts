import type { TenantAdminPrincipal } from "../auth/live-authorization";

export interface AdminProduct {
  currency: string;
  description: string | null;
  name: string;
  priceMinor: number;
  productId: string;
  sku: string;
  status: ProductStatus;
}

export type ProductStatus = "draft" | "active" | "archived";

export type AdminCatalogResult =
  | { product: AdminProduct; status: "ok" }
  | { status: "conflict" | "invalid" | "not_found" };

export interface CreateProductInput {
  currency: string;
  description: string | null;
  name: string;
  priceMinor: number;
  sku: string;
}

export interface UpdateProductInput {
  description?: string | null;
  name?: string;
  priceMinor?: number;
  sku?: string;
  status?: ProductStatus;
}

interface ProductRow {
  currency: string;
  description: string | null;
  name: string;
  b2c_price_minor: number;
  product_id: string;
  sku: string;
  status: ProductStatus;
}

const CREATE_KEYS = [
  "currency",
  "description",
  "name",
  "priceMinor",
  "sku",
] as const;
const UPDATE_KEYS = [
  "description",
  "name",
  "priceMinor",
  "sku",
  "status",
] as const;
const PRODUCT_STATUSES: ProductStatus[] = ["draft", "active", "archived"];
const SKU_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 2_000;
const PRICE_MINOR_MAX = 100_000_000;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const PRODUCT_SELECT = `SELECT
     product_id, sku, name, description, b2c_price_minor, currency, status
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

  return { currency, description, name, priceMinor, sku };
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

  return Object.keys(input).length === 0 ? null : input;
}

function toAdminProduct(row: ProductRow): AdminProduct {
  return {
    currency: row.currency,
    description: row.description,
    name: row.name,
    priceMinor: row.b2c_price_minor,
    productId: row.product_id,
    sku: row.sku,
    status: row.status,
  };
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

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO products (
            product_id, tenant_id, status, sku, name, description,
            b2c_price_minor, currency, is_pod, created_at, updated_at
          ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .bind(
          productId,
          principal.tenantId,
          input.sku,
          input.name,
          input.description,
          input.priceMinor,
          input.currency,
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
      currency: input.currency,
      description: input.description,
      name: input.name,
      priceMinor: input.priceMinor,
      productId,
      sku: input.sku,
      status: "draft",
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

  const next: AdminProduct = {
    currency: existing.currency,
    description: input.description === undefined
      ? existing.description
      : input.description,
    name: input.name ?? existing.name,
    priceMinor: input.priceMinor ?? existing.b2c_price_minor,
    productId,
    sku: input.sku ?? existing.sku,
    status: input.status ?? existing.status,
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
             status = ?, updated_at = ?
         WHERE tenant_id = ?
           AND product_id = ?`,
      )
      .bind(
        next.sku,
        next.name,
        next.description,
        next.priceMinor,
        next.status,
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
