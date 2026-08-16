import type { TenantContext } from "../tenancy/resolve-tenant";

export interface CheckoutItemInput {
  productId: string;
  quantity: number;
  variantId?: string;
}

export interface CreateCheckoutInput {
  email: string;
  idempotencyKey: string;
  items: CheckoutItemInput[];
}

export interface CheckoutLine {
  itemIndex: number;
  lineTotalMinor: number;
  name: string;
  productId: string;
  quantity: number;
  sku: string;
  unitPriceMinor: number;
  variantId: string | null;
}

/**
 * A priced line plus the currency of the publication it came from. Currency is
 * a checkout-level field in the response, but it must be carried per line long
 * enough to prove the whole basket agrees on one.
 */
interface ResolvedLine extends CheckoutLine {
  currency: string;
}

export interface Checkout {
  checkoutId: string;
  currency: string;
  expiresAt: number;
  items: CheckoutLine[];
  subtotalMinor: number;
  totalMinor: number;
}

export type CreateCheckoutResult =
  | { checkout: Checkout; replayed: boolean; status: "ok" }
  | { status: "conflict" | "invalid_items" };

interface PublicationRow {
  currency: string;
  product_id: string;
  public_name: string;
  public_price_minor: number;
  sku: string;
}

interface VariantRow {
  price_minor: number;
  sku: string;
  variant_id: string;
}

interface CheckoutRow {
  checkout_id: string;
  currency: string;
  customer_email: string;
  expires_at: number;
  subtotal_minor: number;
  total_minor: number;
}

interface CheckoutItemRow {
  item_index: number;
  line_total_minor: number;
  name: string;
  product_id: string;
  quantity: number;
  sku: string;
  unit_price_minor: number;
  variant_id: string | null;
}

const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_CHECKOUT_ITEMS = 50;

// quantity <= 999 and unit price <= 100_000_000 (the same ceiling the admin
// catalogue enforces) bound every line total at 9.99e10 and a 50-line subtotal
// at 5e12 — three orders of magnitude below Number.MAX_SAFE_INTEGER, so the
// integer arithmetic below can never lose precision.
export const MAX_ITEM_QUANTITY = 999;
const MAX_UNIT_PRICE_MINOR = 100_000_000;

const CHECKOUT_KEYS = ["email", "idempotencyKey", "items"] as const;
const ITEM_KEYS = ["productId", "quantity", "variantId"] as const;
const EMAIL_MAX_LENGTH = 254;
const ID_MAX_LENGTH = 128;
const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

// Mirrors the bootstrap address gate: whitespace and C0/C1 control bytes are
// rejected outright rather than trimmed, so an address that only becomes valid
// after normalization never becomes a stored identity.
const EMAIL_FORBIDDEN_PATTERN = /[\s\u0000-\u001f\u007f-\u009f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function parseEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > EMAIL_MAX_LENGTH) {
    return null;
  }

  const email = value.toLowerCase();
  if (EMAIL_FORBIDDEN_PATTERN.test(email)) {
    return null;
  }

  const [local, domain, ...rest] = email.split("@");
  if (rest.length > 0 || local === undefined || domain === undefined) {
    return null;
  }

  return local.length > 0 && domain.length > 0 ? email : null;
}

function parseId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= ID_MAX_LENGTH
    ? value
    : null;
}

function parseQuantity(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_ITEM_QUANTITY
    ? value
    : null;
}

function parseIdempotencyKey(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= IDEMPOTENCY_KEY_MIN_LENGTH &&
    value.length <= IDEMPOTENCY_KEY_MAX_LENGTH &&
    IDEMPOTENCY_KEY_PATTERN.test(value)
    ? value
    : null;
}

function parseItem(value: unknown): CheckoutItemInput | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ITEM_KEYS)) {
    return null;
  }

  const productId = parseId(value.productId);
  const quantity = parseQuantity(value.quantity);
  if (productId === null || quantity === null) {
    return null;
  }

  if (value.variantId === undefined) {
    return { productId, quantity };
  }

  const variantId = parseId(value.variantId);
  return variantId === null ? null : { productId, quantity, variantId };
}

/**
 * Strict allowlist on both the envelope and every item. A body carrying
 * `price`, `unitPriceMinor`, `sku`, `name`, `currency`, or any other pricing
 * field is rejected outright rather than ignored: silently dropping such a key
 * would let a caller believe it had influenced the total, and a future refactor
 * that started reading it would turn that belief into a real price override.
 * The server is the only source of money in this request.
 */
export function parseCreateCheckoutInput(
  body: unknown,
): CreateCheckoutInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CHECKOUT_KEYS)) {
    return null;
  }

  const email = parseEmail(body.email);
  const idempotencyKey = parseIdempotencyKey(body.idempotencyKey);
  if (email === null || idempotencyKey === null) {
    return null;
  }

  if (
    !Array.isArray(body.items) ||
    body.items.length === 0 ||
    body.items.length > MAX_CHECKOUT_ITEMS
  ) {
    return null;
  }

  const items: CheckoutItemInput[] = [];
  for (const raw of body.items) {
    const item = parseItem(raw);
    if (item === null) {
      return null;
    }
    items.push(item);
  }

  return { email, idempotencyKey, items };
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Hashes the caller-chosen idempotency key together with the tenant it was
 * presented under. The tenant prefix is inside the digest, not merely beside it
 * in a composite key, so a key observed on one storefront cannot be replayed to
 * probe another tenant's stored hashes.
 */
export async function hashIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${tenantId}:${idempotencyKey}`),
    ),
  );
}

/**
 * Narrowed to the idempotency index by name rather than matching any UNIQUE
 * violation. Every other unique column in this batch is a fresh UUID, so a
 * broad match is not exploitable today — but the moment someone adds, say, a
 * "one open cart per buyer" constraint, a broad match would misreport that
 * legitimately-different checkout as a reused idempotency key and answer 409
 * about a key the caller never reused.
 */
function isIdempotencyCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("UNIQUE constraint failed") &&
    message.includes("checkouts.idempotency_key_hash")
  );
}

/**
 * Resolves one requested line against the tenant's own published catalogue.
 *
 * This is the pricing authority. The request contributes exactly three things —
 * a product id, an optional variant id, and a quantity — and every other value
 * on the resulting line (sku, name, unit price, currency) is read here from
 * rows the tenant owns. The publication join is deliberately the same predicate
 * set the public catalogue uses (published = 1, product active, both rows on
 * this tenant), so nothing purchasable through checkout is invisible on the
 * storefront and nothing hidden from the storefront is purchasable.
 */
async function resolveLine(
  db: D1Database,
  tenant: TenantContext,
  item: CheckoutItemInput,
  itemIndex: number,
): Promise<ResolvedLine | null> {
  const publication = await db
    .prepare(
      `SELECT
         publication.product_id AS product_id,
         publication.public_name AS public_name,
         publication.public_price_minor AS public_price_minor,
         publication.currency AS currency,
         product.sku AS sku
       FROM product_publications AS publication
       INNER JOIN products AS product
         ON product.product_id = publication.product_id
        AND product.tenant_id = publication.tenant_id
       WHERE publication.tenant_id = ?
         AND product.tenant_id = ?
         AND publication.published = 1
         AND product.status = 'active'
         AND publication.product_id = ?
       LIMIT 1`,
    )
    .bind(tenant.tenantId, tenant.tenantId, item.productId)
    .first<PublicationRow>();

  if (publication === null) {
    return null;
  }

  let sku = publication.sku;
  let unitPriceMinor = publication.public_price_minor;
  let variantId: string | null = null;

  if (item.variantId !== undefined) {
    // The variant must belong to this tenant AND to the product the caller
    // named: without the product predicate a buyer could quote a cheap
    // variant's price against an expensive product.
    const variant = await db
      .prepare(
        `SELECT
           variant.variant_id AS variant_id,
           variant.sku AS sku,
           variant.price_minor AS price_minor
         FROM product_variants AS variant
         WHERE variant.tenant_id = ?
           AND variant.product_id = ?
           AND variant.variant_id = ?
           AND variant.active = 1
         LIMIT 1`,
      )
      .bind(tenant.tenantId, publication.product_id, item.variantId)
      .first<VariantRow>();

    if (variant === null) {
      return null;
    }

    sku = variant.sku;
    unitPriceMinor = variant.price_minor;
    variantId = variant.variant_id;
  }

  // A price beyond the admin ceiling means the catalogue row is corrupt, not
  // that the buyer is owed an unbounded line: refuse rather than quote it.
  if (unitPriceMinor > MAX_UNIT_PRICE_MINOR) {
    return null;
  }

  return {
    currency: publication.currency,
    itemIndex,
    lineTotalMinor: unitPriceMinor * item.quantity,
    name: publication.public_name,
    productId: publication.product_id,
    quantity: item.quantity,
    sku,
    unitPriceMinor,
    variantId,
  };
}

/**
 * Resolves and prices every requested line, or nothing at all. A single
 * unknown, unpublished, inactive, or foreign reference fails the whole
 * checkout: a partially-priced cart is worse than a rejected one, because the
 * buyer would be charged for a basket they never assembled.
 */
async function resolveLines(
  db: D1Database,
  tenant: TenantContext,
  items: CheckoutItemInput[],
): Promise<ResolvedLine[] | null> {
  const seen = new Set<string>();

  for (const item of items) {
    // Duplicate (product, variant) pairs are a client bug — quantities belong
    // merged before submission — and silently summing them here would make the
    // idempotency fingerprint below ambiguous.
    const key = JSON.stringify([item.productId, item.variantId ?? null]);
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);
  }

  const lines: ResolvedLine[] = [];
  for (const [itemIndex, item] of items.entries()) {
    const line = await resolveLine(db, tenant, item, itemIndex);
    if (line === null) {
      return null;
    }
    lines.push(line);
  }

  return lines;
}

/**
 * Currency comes from the resolved publication rows, never from the request.
 * A mixed-currency basket has no defensible single total, so it is rejected
 * rather than silently summed under whichever currency happened to come first.
 */
function resolveCurrency(lines: ResolvedLine[]): string | null {
  const first = lines[0];
  if (first === undefined) {
    return null;
  }

  return lines.every((line) => line.currency === first.currency)
    ? first.currency
    : null;
}

function toCheckout(
  row: CheckoutRow,
  lines: CheckoutLine[],
): Checkout {
  return {
    checkoutId: row.checkout_id,
    currency: row.currency,
    expiresAt: row.expires_at,
    items: lines,
    subtotalMinor: row.subtotal_minor,
    totalMinor: row.total_minor,
  };
}

/**
 * Decides whether a colliding idempotency key is a replay of the same request
 * or a reuse of the key for a different one.
 *
 * The comparison is against the freshly-resolved server prices, not against the
 * client's payload, so it also catches the case a client cannot see: if a price
 * changed between the two attempts, the stored line no longer matches what the
 * server would quote now, the fingerprint mismatches, and the caller gets a
 * conflict. That is the correct outcome — returning the stale checkout would
 * silently honour an expired price, and returning a new one under the same key
 * would break idempotency. A client that hits this must retry with a new key.
 */
function matchesExisting(
  existing: CheckoutRow,
  existingLines: CheckoutItemRow[],
  email: string,
  currency: string,
  lines: CheckoutLine[],
): boolean {
  if (
    existing.customer_email !== email ||
    existing.currency !== currency ||
    existingLines.length !== lines.length
  ) {
    return false;
  }

  return existingLines.every((stored, index) => {
    const line = lines[index] as CheckoutLine;
    return (
      stored.item_index === line.itemIndex &&
      stored.product_id === line.productId &&
      stored.variant_id === line.variantId &&
      stored.sku === line.sku &&
      // The display name is part of the frozen buyer-facing snapshot — the
      // schema forbids editing it after creation — so a publication rename
      // between attempts must conflict just as a reprice does. Without this
      // the replay would answer 'ok' while returning a line description that
      // is neither what the client just asked for nor what the catalogue says.
      stored.name === line.name &&
      stored.quantity === line.quantity &&
      stored.unit_price_minor === line.unitPriceMinor
      // line_total_minor is deliberately not compared: it is derived from
      // quantity * unit_price_minor and pinned by a CHECK, so comparing it
      // could only ever restate a check already made above.
    );
  });
}

async function loadExisting(
  db: D1Database,
  tenant: TenantContext,
  idempotencyKeyHash: string,
): Promise<{ lines: CheckoutItemRow[]; row: CheckoutRow } | null> {
  const row = await db
    .prepare(
      `SELECT
         checkout_id, currency, customer_email, expires_at,
         subtotal_minor, total_minor
       FROM checkouts
       WHERE tenant_id = ?
         AND idempotency_key_hash = ?
       LIMIT 1`,
    )
    .bind(tenant.tenantId, idempotencyKeyHash)
    .first<CheckoutRow>();

  if (row === null) {
    return null;
  }

  const items = await db
    .prepare(
      `SELECT
         item_index, product_id, variant_id, sku, name,
         quantity, unit_price_minor, line_total_minor
       FROM checkout_items
       WHERE tenant_id = ?
         AND checkout_id = ?
       ORDER BY item_index ASC`,
    )
    .bind(tenant.tenantId, row.checkout_id)
    .all<CheckoutItemRow>();

  return { lines: items.results, row };
}

function storedLine(row: CheckoutItemRow): CheckoutLine {
  return {
    itemIndex: row.item_index,
    lineTotalMinor: row.line_total_minor,
    name: row.name,
    productId: row.product_id,
    quantity: row.quantity,
    sku: row.sku,
    unitPriceMinor: row.unit_price_minor,
    variantId: row.variant_id,
  };
}

export async function createCheckout(
  db: D1Database,
  tenant: TenantContext,
  input: CreateCheckoutInput,
  now: number,
): Promise<CreateCheckoutResult> {
  if (input.items.length === 0 || input.items.length > MAX_CHECKOUT_ITEMS) {
    return { status: "invalid_items" };
  }

  const lines = await resolveLines(db, tenant, input.items);
  if (lines === null) {
    return { status: "invalid_items" };
  }

  const currency = resolveCurrency(lines);
  if (currency === null) {
    return { status: "invalid_items" };
  }

  const subtotalMinor = lines.reduce(
    (total, line) => total + line.lineTotalMinor,
    0,
  );
  // Shipping, VAT, and discount engines are later checkpoints. Until they
  // exist the totals contract holds trivially, and the schema CHECK keeps it
  // honest once they do.
  const totalMinor = subtotalMinor;
  const expiresAt = now + CHECKOUT_TTL_MS;
  const checkoutId = crypto.randomUUID();
  const idempotencyKeyHash = await hashIdempotencyKey(
    tenant.tenantId,
    input.idempotencyKey,
  );

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO checkouts (
          checkout_id, tenant_id, status, customer_email, currency,
          subtotal_minor, shipping_minor, vat_minor, discount_minor,
          total_minor, payment_intent_id, idempotency_key_hash,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, 'open', ?, ?, ?, 0, 0, 0, ?, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        checkoutId,
        tenant.tenantId,
        input.email,
        currency,
        subtotalMinor,
        totalMinor,
        idempotencyKeyHash,
        expiresAt,
        now,
        now,
      ),
  ];

  for (const line of lines) {
    statements.push(
      db
        .prepare(
          `INSERT INTO checkout_items (
            checkout_item_id, checkout_id, tenant_id, item_index, product_id,
            variant_id, sku, name, quantity, unit_price_minor,
            line_total_minor, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          checkoutId,
          tenant.tenantId,
          line.itemIndex,
          line.productId,
          line.variantId,
          line.sku,
          line.name,
          line.quantity,
          line.unitPriceMinor,
          line.lineTotalMinor,
          now,
          now,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_events (
          event_id, tenant_id, actor_user_id, action, resource_type,
          resource_id, request_id, metadata_json, created_at
        ) VALUES (?, ?, NULL, 'checkout.create', 'checkout', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        tenant.tenantId,
        checkoutId,
        crypto.randomUUID(),
        // Line count only. The buyer's address is a personal identifier and an
        // anonymous checkout has no actor, so the audit row deliberately
        // carries neither.
        JSON.stringify({ items: lines.length }),
        now,
      ),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    if (!isIdempotencyCollision(error)) {
      throw error;
    }

    const existing = await loadExisting(db, tenant, idempotencyKeyHash);
    if (
      existing === null ||
      !matchesExisting(
        existing.row,
        existing.lines,
        input.email,
        currency,
        lines,
      )
    ) {
      return { status: "conflict" };
    }

    return {
      checkout: toCheckout(existing.row, existing.lines.map(storedLine)),
      replayed: true,
      status: "ok",
    };
  }

  return {
    checkout: {
      checkoutId,
      currency,
      expiresAt,
      // Projected field by field rather than spread: currency is a
      // checkout-level value and must not reappear on every line.
      items: lines.map((line) => ({
        itemIndex: line.itemIndex,
        lineTotalMinor: line.lineTotalMinor,
        name: line.name,
        productId: line.productId,
        quantity: line.quantity,
        sku: line.sku,
        unitPriceMinor: line.unitPriceMinor,
        variantId: line.variantId,
      })),
      subtotalMinor,
      totalMinor,
    },
    replayed: false,
    status: "ok",
  };
}
