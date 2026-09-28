import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { evaluatePodGate, quoteForProduct } from "../pod/pod-mappings";
import type { AdminRefusalCode } from "./admin-catalog";
import {
  auditStatement,
  hasOnlyKeys,
  isPlainObject,
  isUniqueConstraintFailure,
  parseBoolean,
  parseOptionalText,
  parsePriceMinor,
  parseSku,
  refused,
} from "./admin-catalog";
import type { AdminVariant, ProductRow, VariantRow } from "./admin-product-reads";
import {
  isProductLive,
  loadProductRow,
  loadProductScreeningInput,
  MAX_ACTIVE_VARIANTS,
  MAX_PRODUCT_VARIANTS,
  toAdminVariant,
  variantScreeningTexts,
} from "./admin-product-reads";
import type { ScreeningGuard } from "./screening";
import {
  isScreeningConflict,
  readScreeningGuard,
  screeningFenceStatement,
  screeningStatementsFor,
  withScreeningRetry,
} from "./screening";
import type { ProductScreeningInput } from "./screening-core";

/**
 * CP4-A — a product's variants (the admin's rail):
 *
 *   POST   /v1/admin/products/:productId/variants
 *   PATCH  /v1/admin/products/:productId/variants/:variantId
 *   DELETE /v1/admin/products/:productId/variants/:variantId
 *
 * MONEY STAYS KEYED ON THE VARIANT'S SKU. Checkout resolves a line by the
 * variant's id, this product and `active = 1`, and charges this row's price
 * under this row's sku (src/commerce/checkout.ts resolveLine, unchanged). So:
 * a variant's sku is unique in the shop (0005), a variant a checkout, an order
 * or a print mapping names is DEACTIVATED, never deleted (its row is the
 * history those rows point at), and a price only changes through the gate
 * below.
 *
 * Every write is one batch with its audit row, fenced like a product edit
 * (src/catalog/screening.ts, THE FENCE): a variant's label, group and size are
 * text a visitor reads, so a write that leaves the product live re-screens it
 * from the texts the batch writes, and any other write carries the fence.
 * Every write also moves `products.updated_at` forward — the content fence a
 * concurrent first publish checks.
 *
 * PRISGOLV (the product rule of updateAdminProduct, per variant): on a POD
 * product that is live after the write, a variant that BECOMES sellable
 * (created active, or reactivated) and an active variant whose price is
 * LOWERED must clear the gate — the whole product's gate as it stands
 * (evaluatePodGate: mappings, suspensions, every other unit's floor) AND this
 * unit's floor at its new price (the seller quote of the set that prints it,
 * the same quote and the same floor the gate computes). A raise, or a write to
 * a product that is not live, is not gated: the next publish gates it whole.
 * Taking away the LAST active variant of a live POD product makes the base
 * unit required, so the base price must then clear its floor too.
 */

export interface CreateVariantInput {
  active: boolean;
  group: string | null;
  label: string;
  position: number | null;
  priceMinor: number;
  size: string | null;
  sku: string;
}

export interface UpdateVariantInput {
  active?: boolean;
  group?: string | null;
  label?: string;
  position?: number;
  priceMinor?: number;
  size?: string | null;
  sku?: string;
}

export type VariantWriteResult =
  | { status: "ok"; variant: AdminVariant }
  /** DELETE: `deleted` = the row is gone; `deactivated` = something names it, so it stays. */
  | { outcome: "deactivated" | "deleted"; status: "removed"; variant: AdminVariant | null }
  | { code: AdminRefusalCode; message: string; status: "refused" }
  | { code: "conflict" | "variant_limit"; status: "conflict" }
  | { status: "invalid" | "not_found" };

const CREATE_KEYS = ["active", "group", "label", "position", "priceMinor", "size", "sku"] as const;
const LABEL_MAX_LENGTH = 200;
const GROUP_MAX_LENGTH = 100;
const SIZE_MAX_LENGTH = 50;
const POSITION_MAX = 10_000;

function parseLabel(value: unknown): string | null {
  const label = parseOptionalText(value, LABEL_MAX_LENGTH);
  return typeof label === "string" ? label : null;
}

function parsePosition(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= POSITION_MAX
    ? value
    : null;
}

export function parseCreateVariantInput(body: unknown): CreateVariantInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CREATE_KEYS)) {
    return null;
  }
  const sku = parseSku(body.sku);
  const label = parseLabel(body.label);
  const priceMinor = parsePriceMinor(body.priceMinor);
  const group = body.group === undefined ? null : parseOptionalText(body.group, GROUP_MAX_LENGTH);
  const size = body.size === undefined ? null : parseOptionalText(body.size, SIZE_MAX_LENGTH);
  const position = body.position === undefined ? null : parsePosition(body.position);
  const active = body.active === undefined ? true : parseBoolean(body.active);
  if (
    sku === null ||
    label === null ||
    priceMinor === null ||
    group === undefined ||
    size === undefined ||
    (body.position !== undefined && position === null) ||
    active === null
  ) {
    return null;
  }
  return { active, group, label, position, priceMinor, size, sku };
}

export function parseUpdateVariantInput(body: unknown): UpdateVariantInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CREATE_KEYS)) {
    return null;
  }
  const input: UpdateVariantInput = {};
  if (body.sku !== undefined) {
    const sku = parseSku(body.sku);
    if (sku === null) {
      return null;
    }
    input.sku = sku;
  }
  if (body.label !== undefined) {
    const label = parseLabel(body.label);
    if (label === null) {
      return null;
    }
    input.label = label;
  }
  if (body.priceMinor !== undefined) {
    const priceMinor = parsePriceMinor(body.priceMinor);
    if (priceMinor === null) {
      return null;
    }
    input.priceMinor = priceMinor;
  }
  if (body.group !== undefined) {
    const group = parseOptionalText(body.group, GROUP_MAX_LENGTH);
    if (group === undefined) {
      return null;
    }
    input.group = group;
  }
  if (body.size !== undefined) {
    const size = parseOptionalText(body.size, SIZE_MAX_LENGTH);
    if (size === undefined) {
      return null;
    }
    input.size = size;
  }
  if (body.position !== undefined) {
    const position = parsePosition(body.position);
    if (position === null) {
      return null;
    }
    input.position = position;
  }
  if (body.active !== undefined) {
    const active = parseBoolean(body.active);
    if (active === null) {
      return null;
    }
    input.active = active;
  }
  return Object.keys(input).length === 0 ? null : input;
}

const VARIANT_SELECT = `SELECT variant_id, product_id, sku, label, price_minor, active,
     variant_group, size, position
   FROM product_variants
   WHERE tenant_id = ? AND product_id = ?`;

async function loadVariant(
  db: D1Database,
  tenantId: string,
  productId: string,
  variantId: string,
): Promise<VariantRow | null> {
  return db
    .prepare(`${VARIANT_SELECT} AND variant_id = ? LIMIT 1`)
    .bind(tenantId, productId, variantId)
    .first<VariantRow>();
}

/** The product's active variants in rail order (bounded: a product holds at most 200 rows). */
async function loadActiveVariants(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<VariantRow[]> {
  const result = await db
    .prepare(`${VARIANT_SELECT} AND active = 1 ORDER BY position, label, variant_id LIMIT ?`)
    .bind(tenantId, productId, MAX_PRODUCT_VARIANTS + 1)
    .all<VariantRow>();
  return result.results;
}


/**
 * PRISGOLV for one unit about to become sellable, or re-priced lower, at
 * `priceMinor`: the whole gate as it stands, then this unit's own floor.
 * `variantId` null = a unit that has no variant-level mapping set of its own
 * yet (a new variant: the product's set prints it; or the base unit).
 */
async function podUnitGate(
  db: D1Database,
  principal: TenantAdminPrincipal,
  product: ProductRow,
  unit: { priceMinor: number; variantId: string | null },
): Promise<AdminRefusalCode | null> {
  const whole = await evaluatePodGate(db, principal.tenantId, product.product_id);
  if (whole !== null) {
    return whole;
  }
  const quote = await quoteForProduct(db, principal, product.product_id, unit.variantId);
  if (quote.status !== "ok") {
    // No set prints this unit (or the set cannot be priced): the gate's
    // "no mapping, no sale".
    return "pod_mapping_missing";
  }
  if (quote.quote.currency !== product.currency) {
    return "currency_mismatch";
  }
  return unit.priceMinor < quote.quote.priceFloorMinor ? "price_below_floor" : null;
}

/** The fenced tail every variant write ends with: the content fence, the screening, the audit. */
async function fencedTail(
  db: D1Database,
  principal: TenantAdminPrincipal,
  guard: ScreeningGuard,
  product: ProductRow,
  live: boolean,
  activeAfter: readonly VariantRow[],
  now: number,
): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [
    // Every writer of screened content moves updated_at strictly forward: a
    // concurrent FIRST publish of this product fences on it.
    db
      .prepare(
        `UPDATE products SET updated_at = max(?, updated_at + 1)
         WHERE tenant_id = ? AND product_id = ?`,
      )
      .bind(now, principal.tenantId, product.product_id),
  ];
  if (live) {
    const stored = await loadProductScreeningInput(db, principal.tenantId, product.product_id);
    // Every text a visitor reads after this write (screening-core.ts
    // ProductScreeningInput): what D1 holds, with the variant set this batch
    // leaves active.
    const texts: ProductScreeningInput = {
      ...(stored ?? { description: product.description, name: product.name }),
      variantTexts: variantScreeningTexts(activeAfter),
    };
    const screening = await screeningStatementsFor(db, { guard, now, texts });
    statements.push(...screening.statements);
  } else {
    statements.push(screeningFenceStatement(db, guard, now));
  }
  return statements;
}

async function commit(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<"conflict" | null> {
  try {
    await db.batch(statements);
    return null;
  } catch (error) {
    if (!isScreeningConflict(error) && isUniqueConstraintFailure(error)) {
      return "conflict";
    }
    throw error;
  }
}

// ── create ──────────────────────────────────────────────────────────────────

export async function createProductVariant(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  input: CreateVariantInput,
  now: number,
): Promise<VariantWriteResult> {
  return withScreeningRetry<VariantWriteResult>(
    now,
    (attemptNow) => createProductVariantOnce(db, principal, productId, input, attemptNow),
    () => ({ code: "conflict", status: "conflict" }),
  );
}

async function createProductVariantOnce(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  input: CreateVariantInput,
  now: number,
): Promise<VariantWriteResult> {
  // FIRST, before any content read (THE FENCE).
  const guard = await readScreeningGuard(db, principal.tenantId, productId);
  const product = await loadProductRow(db, principal.tenantId, productId);
  if (product === null) {
    return { status: "not_found" };
  }
  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active,
              COALESCE(MAX(position), -1) AS last_position
       FROM product_variants WHERE tenant_id = ? AND product_id = ?`,
    )
    .bind(principal.tenantId, productId)
    .first<{ active: number; last_position: number; total: number }>();
  if (
    (counts?.total ?? 0) >= MAX_PRODUCT_VARIANTS ||
    (input.active && (counts?.active ?? 0) >= MAX_ACTIVE_VARIANTS)
  ) {
    return { code: "variant_limit", status: "conflict" };
  }

  const live = await isProductLive(db, principal.tenantId, product);
  if (input.active && live && product.is_pod === 1) {
    const failure = await podUnitGate(db, principal, product, {
      priceMinor: input.priceMinor,
      variantId: null,
    });
    if (failure !== null) {
      return refused(failure);
    }
  }

  const variantId = crypto.randomUUID();
  const row: VariantRow = {
    active: input.active ? 1 : 0,
    label: input.label,
    position: input.position ?? Math.min((counts?.last_position ?? -1) + 1, 10_000),
    price_minor: input.priceMinor,
    product_id: productId,
    size: input.size,
    sku: input.sku,
    variant_group: input.group,
    variant_id: variantId,
  };
  const activeAfter = input.active
    ? [...(await loadActiveVariants(db, principal.tenantId, productId)), row]
    : await loadActiveVariants(db, principal.tenantId, productId);

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO product_variants (
           variant_id, tenant_id, product_id, sku, label, price_minor, active,
           variant_group, size, position, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        variantId,
        principal.tenantId,
        productId,
        row.sku,
        row.label,
        row.price_minor,
        row.active,
        row.variant_group,
        row.size,
        row.position,
        now,
        now,
      ),
    ...(await fencedTail(db, principal, guard, product, live, activeAfter, now)),
    auditStatement(db, principal, "product.variant_create", productId, now, { variantId }),
  ];
  if ((await commit(db, statements)) === "conflict") {
    return { code: "conflict", status: "conflict" };
  }
  return { status: "ok", variant: toAdminVariant(row) };
}

// ── update ──────────────────────────────────────────────────────────────────

export async function updateProductVariant(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  variantId: string,
  input: UpdateVariantInput,
  now: number,
): Promise<VariantWriteResult> {
  return withScreeningRetry<VariantWriteResult>(
    now,
    (attemptNow) => updateProductVariantOnce(db, principal, productId, variantId, input, attemptNow),
    () => ({ code: "conflict", status: "conflict" }),
  );
}

async function updateProductVariantOnce(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  variantId: string,
  input: UpdateVariantInput,
  now: number,
): Promise<VariantWriteResult> {
  // FIRST, before any content read (THE FENCE).
  const guard = await readScreeningGuard(db, principal.tenantId, productId);
  const product = await loadProductRow(db, principal.tenantId, productId);
  const existing =
    product === null ? null : await loadVariant(db, principal.tenantId, productId, variantId);
  if (product === null || existing === null) {
    return { status: "not_found" };
  }

  const next: VariantRow = {
    ...existing,
    active: input.active === undefined ? existing.active : input.active ? 1 : 0,
    label: input.label ?? existing.label,
    position: input.position ?? existing.position,
    price_minor: input.priceMinor ?? existing.price_minor,
    size: input.size === undefined ? existing.size : input.size,
    sku: input.sku ?? existing.sku,
    variant_group: input.group === undefined ? existing.variant_group : input.group,
  };
  const activeBefore = await loadActiveVariants(db, principal.tenantId, productId);
  const activeAfter = [
    ...activeBefore.filter((variant) => variant.variant_id !== variantId),
    ...(next.active === 1 ? [next] : []),
  ];
  const activating = existing.active === 0 && next.active === 1;
  if (activating && activeBefore.length >= MAX_ACTIVE_VARIANTS) {
    return { code: "variant_limit", status: "conflict" };
  }

  const live = await isProductLive(db, principal.tenantId, product);
  if (live && product.is_pod === 1) {
    const failure = await gateVariantChange(db, principal, product, existing, next, activeAfter.length);
    if (failure !== null) {
      return refused(failure);
    }
  }

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE product_variants
         SET sku = ?, label = ?, price_minor = ?, active = ?, variant_group = ?,
             size = ?, position = ?, updated_at = max(?, updated_at)
         WHERE tenant_id = ? AND product_id = ? AND variant_id = ?`,
      )
      .bind(
        next.sku,
        next.label,
        next.price_minor,
        next.active,
        next.variant_group,
        next.size,
        next.position,
        now,
        principal.tenantId,
        productId,
        variantId,
      ),
    ...(await fencedTail(db, principal, guard, product, live, activeAfter, now)),
    auditStatement(db, principal, "product.variant_update", productId, now, {
      fields: Object.keys(input).sort(),
      variantId,
    }),
  ];
  if ((await commit(db, statements)) === "conflict") {
    return { code: "conflict", status: "conflict" };
  }
  return { status: "ok", variant: toAdminVariant(next) };
}

/**
 * The PRISGOLV cases of a variant edit on a live POD product: the variant
 * becomes sellable, its active price goes down, or it was the last active
 * variant (the base unit becomes the one a buyer gets).
 */
async function gateVariantChange(
  db: D1Database,
  principal: TenantAdminPrincipal,
  product: ProductRow,
  existing: VariantRow,
  next: VariantRow,
  activeAfterCount: number,
): Promise<AdminRefusalCode | null> {
  if (next.active === 1 && (existing.active === 0 || next.price_minor < existing.price_minor)) {
    return podUnitGate(db, principal, product, {
      priceMinor: next.price_minor,
      variantId: existing.variant_id,
    });
  }
  if (existing.active === 1 && next.active === 0 && activeAfterCount === 0) {
    return podUnitGate(db, principal, product, {
      priceMinor: product.b2c_price_minor,
      variantId: null,
    });
  }
  return null;
}

// ── delete ──────────────────────────────────────────────────────────────────

/**
 * Rows that name a variant and outlive it: a checkout line, an order line
 * (paid money), a print mapping. Each is ON DELETE RESTRICT, and each is the
 * reason a variant is deactivated rather than deleted.
 */
const VARIANT_REFERENCED = `(
     EXISTS (SELECT 1 FROM order_items WHERE variant_id = ?)
     OR EXISTS (SELECT 1 FROM checkout_items WHERE variant_id = ?)
     OR EXISTS (SELECT 1 FROM pod_mappings WHERE variant_id = ?)
   )`;

export async function deleteProductVariant(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  variantId: string,
  now: number,
): Promise<VariantWriteResult> {
  return withScreeningRetry<VariantWriteResult>(
    now,
    (attemptNow) => deleteProductVariantOnce(db, principal, productId, variantId, attemptNow),
    () => ({ code: "conflict", status: "conflict" }),
  );
}

async function deleteProductVariantOnce(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  variantId: string,
  now: number,
): Promise<VariantWriteResult> {
  // FIRST, before any content read (THE FENCE).
  const guard = await readScreeningGuard(db, principal.tenantId, productId);
  const product = await loadProductRow(db, principal.tenantId, productId);
  const existing =
    product === null ? null : await loadVariant(db, principal.tenantId, productId, variantId);
  if (product === null || existing === null) {
    return { status: "not_found" };
  }

  const activeAfter = (await loadActiveVariants(db, principal.tenantId, productId)).filter(
    (variant) => variant.variant_id !== variantId,
  );
  const live = await isProductLive(db, principal.tenantId, product);
  if (live && product.is_pod === 1) {
    const failure = await gateVariantChange(
      db,
      principal,
      product,
      existing,
      { ...existing, active: 0 },
      activeAfter.length,
    );
    if (failure !== null) {
      return refused(failure);
    }
  }

  const referenced = [variantId, variantId, variantId];
  const { tenantId } = principal;
  const statements: D1PreparedStatement[] = [
    // The variant's images belong to its GROUP (the group rule): they move to
    // the group's next variant when there is one, and leave with the variant
    // when there is none. Only when the row really goes (nothing names it).
    db
      .prepare(
        `UPDATE OR IGNORE product_images
         SET variant_id = (
           SELECT sibling.variant_id FROM product_variants AS sibling
           WHERE sibling.tenant_id = ? AND sibling.product_id = ?
             AND sibling.variant_group = ? AND sibling.variant_id <> ?
           ORDER BY sibling.position, sibling.label, sibling.variant_id
           LIMIT 1
         )
         WHERE tenant_id = ? AND product_id = ? AND variant_id = ?
           AND ? IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM product_variants AS sibling
             WHERE sibling.tenant_id = ? AND sibling.product_id = ?
               AND sibling.variant_group = ? AND sibling.variant_id <> ?
           )
           AND NOT ${VARIANT_REFERENCED}`,
      )
      .bind(
        tenantId,
        productId,
        existing.variant_group,
        variantId,
        tenantId,
        productId,
        variantId,
        existing.variant_group,
        tenantId,
        productId,
        existing.variant_group,
        variantId,
        ...referenced,
      ),
    db
      .prepare(
        `DELETE FROM product_images
         WHERE tenant_id = ? AND product_id = ? AND variant_id = ?
           AND NOT ${VARIANT_REFERENCED}`,
      )
      .bind(tenantId, productId, variantId, ...referenced),
    db
      .prepare(
        `DELETE FROM product_variants
         WHERE tenant_id = ? AND product_id = ? AND variant_id = ?
           AND NOT ${VARIANT_REFERENCED}`,
      )
      .bind(tenantId, productId, variantId, ...referenced),
    // Still there = something names it: it stays, inactive. (Nothing when it
    // was deleted above: the row is gone.)
    db
      .prepare(
        `UPDATE product_variants SET active = 0, updated_at = max(?, updated_at)
         WHERE tenant_id = ? AND product_id = ? AND variant_id = ?`,
      )
      .bind(now, tenantId, productId, variantId),
    ...(await fencedTail(db, principal, guard, product, live, activeAfter, now)),
    // The audit row says which of the two happened, decided by the rows above
    // in this same batch.
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, 'product.variant_delete', 'product', ?, ?,
                json_patch(
                  json_object(
                    'outcome', CASE WHEN EXISTS (
                      SELECT 1 FROM product_variants WHERE variant_id = ?
                    ) THEN 'deactivated' ELSE 'deleted' END,
                    'variantId', ?
                  ),
                  ?
                ),
                ?`,
      )
      .bind(
        crypto.randomUUID(),
        tenantId,
        principal.userId,
        productId,
        crypto.randomUUID(),
        variantId,
        variantId,
        // auditMetadataJson's rule: the acting-as grant, when there is one.
        principal.actingAs === undefined
          ? "{}"
          : JSON.stringify({ actingAsGrantId: principal.actingAs.grantId }),
        now,
      ),
  ];
  if ((await commit(db, statements)) === "conflict") {
    return { code: "conflict", status: "conflict" };
  }

  const after = await loadVariant(db, tenantId, productId, variantId);
  return after === null
    ? { outcome: "deleted", status: "removed", variant: null }
    : { outcome: "deactivated", status: "removed", variant: toAdminVariant(after) };
}
