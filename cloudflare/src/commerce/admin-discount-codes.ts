import type { TenantAdminPrincipal } from "../auth/live-authorization";
import type { DiscountScope, DiscountType } from "./discount-codes";
import {
  DISCOUNT_SCOPES,
  DISCOUNT_TYPES,
  MAX_DISCOUNT_PERCENT_BP,
  MAX_DISCOUNT_PRODUCT_IDS,
  MAX_DISCOUNT_VALUE_MINOR,
  MAX_PRODUCT_ID_LENGTH,
  isValidDiscountCode,
  normalizeDiscountCode,
} from "./discount-codes";

/**
 * Tenant-admin CRUD for campaign discount codes.
 *
 * Shaped after src/catalog/admin-catalog.ts throughout, deliberately: strict
 * allowlist parsers that reject unknown keys outright, one `db.batch` per
 * mutation that also appends its audit row, audit metadata carrying field NAMES
 * only, bare 409 on a unique collision, and fail-closed not_found for anything
 * this tenant does not own.
 *
 * ACTIVATION IS A PATCH FIELD, not a pair of action routes. The products
 * surface uses `POST .../publish` because publishing is not a column write —
 * it upserts a separate projection row and bumps a version. Activation here is
 * one boolean on one row, indistinguishable from editing any other field, and
 * giving it its own verb would mean two code paths writing the same column with
 * two audit vocabularies for the same event.
 *
 * `used_count` IS NOT WRITABLE HERE, ever. It is not in either allowlist, not
 * in any UPDATE statement, and not settable at create. It is incremented by the
 * PAYMENT checkpoint on a paid order (production does this in the Stripe
 * webhook, once, after the order row is created). A checkout is not a sale, so
 * nothing in checkout touches it either. An admin who could edit it could
 * resurrect a filled-up code without any record that the cap was ever reached.
 */

export interface AdminDiscountCode {
  active: boolean;
  code: string;
  discountCodeId: string;
  endsAt: number | null;
  maxUses: number | null;
  minSpendMinor: number | null;
  percentBp: number | null;
  productIds: string[] | null;
  scope: DiscountScope;
  startsAt: number | null;
  type: DiscountType;
  // Read-only here and read-only everywhere in this file. Exposed because a
  // merchant needs to see how much of a cap is spent; never accepted on a write.
  usedCount: number;
  valueMinor: number | null;
}

export type AdminDiscountCodeResult =
  | { discountCode: AdminDiscountCode; status: "ok" }
  | { status: "conflict" | "invalid" | "not_found" };

export interface CreateDiscountCodeInput {
  active?: boolean;
  code: string;
  endsAt?: number | null;
  maxUses?: number | null;
  minSpendMinor?: number | null;
  percentBp?: number;
  productIds?: string[];
  scope: DiscountScope;
  startsAt?: number | null;
  type: DiscountType;
  valueMinor?: number;
}

export interface UpdateDiscountCodeInput {
  active?: boolean;
  code?: string;
  endsAt?: number | null;
  maxUses?: number | null;
  minSpendMinor?: number | null;
  percentBp?: number;
  productIds?: string[];
  scope?: DiscountScope;
  startsAt?: number | null;
  type?: DiscountType;
  valueMinor?: number;
}

interface DiscountCodeRow {
  active: number;
  code: string;
  discount_code_id: string;
  ends_at: number | null;
  max_uses: number | null;
  min_spend_minor: number | null;
  percent_bp: number | null;
  product_ids_json: string | null;
  scope: DiscountScope;
  starts_at: number | null;
  type: DiscountType;
  used_count: number;
  value_minor: number | null;
}

const CREATE_KEYS = [
  "active",
  "code",
  "endsAt",
  "maxUses",
  "minSpendMinor",
  "percentBp",
  "productIds",
  "scope",
  "startsAt",
  "type",
  "valueMinor",
] as const;
// Identical to the create set: every field a code carries is editable, and
// nothing that is not a field of the code appears in either. `usedCount` is
// absent from both by design, not by omission.
const UPDATE_KEYS = CREATE_KEYS;

/**
 * Bounds for the two timestamp columns. Both are ms epochs, and a value outside
 * this range is a unit error rather than a campaign: seconds mistaken for
 * milliseconds land in 1970, and a 32-bit overflow lands past year 10000. Both
 * would produce a window that silently never opens or never closes.
 */
const MIN_TIMESTAMP_MS = 0;
const MAX_TIMESTAMP_MS = 253_402_300_799_000;

const SELECT_COLUMNS = `discount_code_id, code, active, type, value_minor,
     percent_bp, starts_at, ends_at, max_uses, used_count, min_spend_minor,
     scope, product_ids_json`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function parseBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseType(value: unknown): DiscountType | null {
  return typeof value === "string" &&
    (DISCOUNT_TYPES as readonly string[]).includes(value)
    ? (value as DiscountType)
    : null;
}

function parseScope(value: unknown): DiscountScope | null {
  return typeof value === "string" &&
    (DISCOUNT_SCOPES as readonly string[]).includes(value)
    ? (value as DiscountScope)
    : null;
}

/**
 * The code as the merchant typed it, normalized to the stored form. Trim and
 * uppercase happen HERE rather than being demanded of the caller, because the
 * checkout lookup normalizes the buyer's input the same way: if the two sides
 * disagreed about normalization, a merchant could create a code no buyer could
 * ever resolve.
 */
function parseCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = normalizeDiscountCode(value);
  return isValidDiscountCode(normalized) ? normalized : null;
}

function parseBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

/**
 * A nullable numeric field. `null` is a real value here — it clears a bound
 * back to "unlimited" / "no minimum" / "no window edge" — and is distinguished
 * from an absent key, which leaves the stored value alone. `undefined` is the
 * parse failure signal, so the two are never confused.
 */
function parseNullableBounded(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null | undefined {
  if (value === null) {
    return null;
  }

  return parseBoundedInteger(value, minimum, maximum) ?? undefined;
}

/**
 * The product-id list for a scoped code. Entries are bounded strings and the
 * list is deduplicated but NOT validated against the catalogue: production
 * stores a loose array and tolerates ids whose products were later deleted, and
 * the engine treats an unmatched id as contributing nothing. Requiring the ids
 * to resolve here would make deleting a product fail while a code names it,
 * which is a behaviour change the merchant never asked for.
 *
 * An empty list is rejected rather than accepted: production's admin form
 * refuses to save a products-scoped code with no products selected, and a code
 * scoped to nothing discounts nothing while looking configured.
 */
function parseProductIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_DISCOUNT_PRODUCT_IDS
  ) {
    return null;
  }

  const ids = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_PRODUCT_ID_LENGTH
    ) {
      return null;
    }
    ids.add(entry);
  }

  return [...ids];
}

/**
 * The cross-field rules the column CHECKs also state, applied to a fully
 * resolved code so the same predicate governs a create and the post-merge
 * result of a PATCH.
 *
 * Applying them to the MERGED row rather than to the patch is what makes a
 * partial edit safe: switching a 'percent' code to 'fixed' without supplying a
 * valueMinor would otherwise write a fixed code carrying only a percentage, and
 * the schema would reject the batch with a raw constraint error instead of this
 * surface answering a clean 400.
 */
function isCoherent(input: {
  percentBp: number | null;
  productIds: string[] | null;
  scope: DiscountScope;
  type: DiscountType;
  valueMinor: number | null;
  endsAt: number | null;
  startsAt: number | null;
}): boolean {
  if (input.type === "fixed") {
    if (input.valueMinor === null || input.percentBp !== null) {
      return false;
    }
  } else if (input.percentBp === null || input.valueMinor !== null) {
    return false;
  }

  if (input.scope === "products") {
    if (input.productIds === null || input.productIds.length === 0) {
      return false;
    }
  } else if (input.productIds !== null) {
    return false;
  }

  return (
    input.startsAt === null ||
    input.endsAt === null ||
    input.endsAt >= input.startsAt
  );
}

export function parseCreateDiscountCodeInput(
  body: unknown,
): CreateDiscountCodeInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CREATE_KEYS)) {
    return null;
  }

  const code = parseCode(body.code);
  const type = parseType(body.type);
  const scope = parseScope(body.scope);
  if (code === null || type === null || scope === null) {
    return null;
  }

  const input: CreateDiscountCodeInput = { code, scope, type };

  if (body.valueMinor !== undefined) {
    const valueMinor = parseBoundedInteger(
      body.valueMinor,
      0,
      MAX_DISCOUNT_VALUE_MINOR,
    );
    if (valueMinor === null) {
      return null;
    }
    input.valueMinor = valueMinor;
  }

  if (body.percentBp !== undefined) {
    const percentBp = parseBoundedInteger(
      body.percentBp,
      1,
      MAX_DISCOUNT_PERCENT_BP,
    );
    if (percentBp === null) {
      return null;
    }
    input.percentBp = percentBp;
  }

  if (body.productIds !== undefined) {
    const productIds = parseProductIds(body.productIds);
    if (productIds === null) {
      return null;
    }
    input.productIds = productIds;
  }

  if (body.startsAt !== undefined) {
    const startsAt = parseNullableBounded(
      body.startsAt,
      MIN_TIMESTAMP_MS,
      MAX_TIMESTAMP_MS,
    );
    if (startsAt === undefined) {
      return null;
    }
    input.startsAt = startsAt;
  }

  if (body.endsAt !== undefined) {
    const endsAt = parseNullableBounded(
      body.endsAt,
      MIN_TIMESTAMP_MS,
      MAX_TIMESTAMP_MS,
    );
    if (endsAt === undefined) {
      return null;
    }
    input.endsAt = endsAt;
  }

  if (body.maxUses !== undefined) {
    const maxUses = parseNullableBounded(body.maxUses, 1, Number.MAX_SAFE_INTEGER);
    if (maxUses === undefined) {
      return null;
    }
    input.maxUses = maxUses;
  }

  if (body.minSpendMinor !== undefined) {
    const minSpendMinor = parseNullableBounded(
      body.minSpendMinor,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (minSpendMinor === undefined) {
      return null;
    }
    input.minSpendMinor = minSpendMinor;
  }

  if (body.active !== undefined) {
    const active = parseBoolean(body.active);
    if (active === null) {
      return null;
    }
    input.active = active;
  }

  return isCoherent({
    endsAt: input.endsAt ?? null,
    percentBp: input.percentBp ?? null,
    productIds: input.productIds ?? null,
    scope,
    startsAt: input.startsAt ?? null,
    type,
    valueMinor: input.valueMinor ?? null,
  })
    ? input
    : null;
}

/**
 * Shape-only for a PATCH: coherence cannot be judged here because a partial
 * body is legitimately incoherent on its own (`{type: 'fixed'}` is a valid edit
 * when the stored row already carries a valueMinor). The merged row is checked
 * in `updateAdminDiscountCode`, which is the only place both halves are known.
 */
export function parseUpdateDiscountCodeInput(
  body: unknown,
): UpdateDiscountCodeInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, UPDATE_KEYS)) {
    return null;
  }

  const input: UpdateDiscountCodeInput = {};

  if (body.code !== undefined) {
    const code = parseCode(body.code);
    if (code === null) {
      return null;
    }
    input.code = code;
  }

  if (body.type !== undefined) {
    const type = parseType(body.type);
    if (type === null) {
      return null;
    }
    input.type = type;
  }

  if (body.scope !== undefined) {
    const scope = parseScope(body.scope);
    if (scope === null) {
      return null;
    }
    input.scope = scope;
  }

  if (body.valueMinor !== undefined) {
    const valueMinor = parseBoundedInteger(
      body.valueMinor,
      0,
      MAX_DISCOUNT_VALUE_MINOR,
    );
    if (valueMinor === null) {
      return null;
    }
    input.valueMinor = valueMinor;
  }

  if (body.percentBp !== undefined) {
    const percentBp = parseBoundedInteger(
      body.percentBp,
      1,
      MAX_DISCOUNT_PERCENT_BP,
    );
    if (percentBp === null) {
      return null;
    }
    input.percentBp = percentBp;
  }

  if (body.productIds !== undefined) {
    const productIds = parseProductIds(body.productIds);
    if (productIds === null) {
      return null;
    }
    input.productIds = productIds;
  }

  if (body.startsAt !== undefined) {
    const startsAt = parseNullableBounded(
      body.startsAt,
      MIN_TIMESTAMP_MS,
      MAX_TIMESTAMP_MS,
    );
    if (startsAt === undefined) {
      return null;
    }
    input.startsAt = startsAt;
  }

  if (body.endsAt !== undefined) {
    const endsAt = parseNullableBounded(
      body.endsAt,
      MIN_TIMESTAMP_MS,
      MAX_TIMESTAMP_MS,
    );
    if (endsAt === undefined) {
      return null;
    }
    input.endsAt = endsAt;
  }

  if (body.maxUses !== undefined) {
    const maxUses = parseNullableBounded(body.maxUses, 1, Number.MAX_SAFE_INTEGER);
    if (maxUses === undefined) {
      return null;
    }
    input.maxUses = maxUses;
  }

  if (body.minSpendMinor !== undefined) {
    const minSpendMinor = parseNullableBounded(
      body.minSpendMinor,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (minSpendMinor === undefined) {
      return null;
    }
    input.minSpendMinor = minSpendMinor;
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

function parseStoredProductIds(value: string | null): string[] | null {
  if (value === null) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }

  return Array.isArray(decoded)
    ? decoded.filter((entry): entry is string => typeof entry === "string")
    : null;
}

function toAdminDiscountCode(row: DiscountCodeRow): AdminDiscountCode {
  return {
    active: row.active === 1,
    code: row.code,
    discountCodeId: row.discount_code_id,
    endsAt: row.ends_at,
    maxUses: row.max_uses,
    minSpendMinor: row.min_spend_minor,
    percentBp: row.percent_bp,
    productIds: parseStoredProductIds(row.product_ids_json),
    scope: row.scope,
    startsAt: row.starts_at,
    type: row.type,
    usedCount: row.used_count,
    valueMinor: row.value_minor,
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
  discountCodeId: string,
  now: number,
  metadata: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        event_id, tenant_id, actor_user_id, action, resource_type,
        resource_id, request_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'discount_code', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      principal.tenantId,
      principal.userId,
      action,
      discountCodeId,
      crypto.randomUUID(),
      // Field NAMES only. The code string itself is a capability a buyer can
      // spend, and the values are the merchant's campaign terms; neither
      // belongs in an append-only log read by platform operators.
      metadata === null ? null : JSON.stringify(metadata),
      now,
    );
}

async function loadDiscountCode(
  db: D1Database,
  tenantId: string,
  discountCodeId: string,
): Promise<DiscountCodeRow | null> {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM discount_codes
       WHERE tenant_id = ?
         AND discount_code_id = ?
       LIMIT 1`,
    )
    .bind(tenantId, discountCodeId)
    .first<DiscountCodeRow>();
}

export async function getAdminDiscountCode(
  db: D1Database,
  principal: TenantAdminPrincipal,
  discountCodeId: string,
): Promise<AdminDiscountCodeResult> {
  const row = await loadDiscountCode(db, principal.tenantId, discountCodeId);
  return row === null
    ? { status: "not_found" }
    : { discountCode: toAdminDiscountCode(row), status: "ok" };
}

export async function createAdminDiscountCode(
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: CreateDiscountCodeInput,
  now: number,
): Promise<AdminDiscountCodeResult> {
  const discountCodeId = crypto.randomUUID();
  const productIds = input.productIds ?? null;
  const code: AdminDiscountCode = {
    active: input.active ?? true,
    code: input.code,
    discountCodeId,
    endsAt: input.endsAt ?? null,
    maxUses: input.maxUses ?? null,
    minSpendMinor: input.minSpendMinor ?? null,
    percentBp: input.percentBp ?? null,
    productIds,
    scope: input.scope,
    startsAt: input.startsAt ?? null,
    type: input.type,
    // Always zero at create, and not readable from the input: the field is not
    // in the allowlist, so a body carrying it was already rejected.
    usedCount: 0,
    valueMinor: input.valueMinor ?? null,
  };

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO discount_codes (
            discount_code_id, tenant_id, code, active, type, value_minor,
            percent_bp, starts_at, ends_at, max_uses, used_count,
            min_spend_minor, scope, product_ids_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .bind(
          discountCodeId,
          principal.tenantId,
          code.code,
          code.active ? 1 : 0,
          code.type,
          code.valueMinor,
          code.percentBp,
          code.startsAt,
          code.endsAt,
          code.maxUses,
          code.minSpendMinor,
          code.scope,
          productIds === null ? null : JSON.stringify(productIds),
          now,
          now,
        ),
      auditStatement(
        db,
        principal,
        "discount_code.create",
        discountCodeId,
        now,
        null,
      ),
    ]);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return { discountCode: code, status: "ok" };
}

export async function updateAdminDiscountCode(
  db: D1Database,
  principal: TenantAdminPrincipal,
  discountCodeId: string,
  input: UpdateDiscountCodeInput,
  now: number,
): Promise<AdminDiscountCodeResult> {
  const existing = await loadDiscountCode(
    db,
    principal.tenantId,
    discountCodeId,
  );
  if (existing === null) {
    return { status: "not_found" };
  }

  const current = toAdminDiscountCode(existing);

  // Switching type or scope must clear the field belonging to the other branch,
  // or the merged row would carry both and fail the schema's XOR. Clearing is
  // the right direction rather than refusing the edit: a merchant turning a
  // percent code into a fixed one has said what the new value is, and keeping
  // the stale percentage beside it would leave a row whose meaning depends on
  // which column a future reader looks at first.
  const type = input.type ?? current.type;
  const scope = input.scope ?? current.scope;
  const next: AdminDiscountCode = {
    active: input.active ?? current.active,
    code: input.code ?? current.code,
    discountCodeId,
    endsAt: input.endsAt === undefined ? current.endsAt : input.endsAt,
    maxUses: input.maxUses === undefined ? current.maxUses : input.maxUses,
    minSpendMinor:
      input.minSpendMinor === undefined
        ? current.minSpendMinor
        : input.minSpendMinor,
    percentBp:
      type === "percent" ? (input.percentBp ?? current.percentBp) : null,
    productIds:
      scope === "products" ? (input.productIds ?? current.productIds) : null,
    scope,
    startsAt: input.startsAt === undefined ? current.startsAt : input.startsAt,
    type,
    // Carried through untouched. It is neither in the allowlist nor in the
    // UPDATE statement below; it appears here only so the response describes
    // the row that exists.
    usedCount: current.usedCount,
    valueMinor: type === "fixed" ? (input.valueMinor ?? current.valueMinor) : null,
  };

  if (
    !isCoherent({
      endsAt: next.endsAt,
      percentBp: next.percentBp,
      productIds: next.productIds,
      scope: next.scope,
      startsAt: next.startsAt,
      type: next.type,
      valueMinor: next.valueMinor,
    })
  ) {
    return { status: "invalid" };
  }

  try {
    await db.batch([
      db
        .prepare(
          `UPDATE discount_codes
           SET code = ?, active = ?, type = ?, value_minor = ?, percent_bp = ?,
               starts_at = ?, ends_at = ?, max_uses = ?, min_spend_minor = ?,
               scope = ?, product_ids_json = ?, updated_at = ?
           WHERE tenant_id = ?
             AND discount_code_id = ?`,
        )
        .bind(
          next.code,
          next.active ? 1 : 0,
          next.type,
          next.valueMinor,
          next.percentBp,
          next.startsAt,
          next.endsAt,
          next.maxUses,
          next.minSpendMinor,
          next.scope,
          next.productIds === null ? null : JSON.stringify(next.productIds),
          now,
          principal.tenantId,
          discountCodeId,
        ),
      auditStatement(
        db,
        principal,
        "discount_code.update",
        discountCodeId,
        now,
        { fields: Object.keys(input).sort() },
      ),
    ]);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return { discountCode: next, status: "ok" };
}
