import type { TenantContext } from "../tenancy/resolve-tenant";
import type {
  DeliveryMethod,
  ShippingRates,
} from "./shipping";
import {
  DELIVERY_METHODS,
  getShippingRegion,
  MAX_VAT_SAFE_TOTAL_MINOR,
  parseShippingRates,
  shippingMinor,
  vatMinor,
} from "./shipping";

export interface CheckoutItemInput {
  productId: string;
  quantity: number;
  variantId?: string;
}

export interface CreateCheckoutInput {
  deliveryMethod: DeliveryMethod;
  email: string;
  idempotencyKey: string;
  items: CheckoutItemInput[];
  shippingCountry: string | null;
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
 * A priced line plus everything about the underlying product that the shipping
 * engine and the delivery-eligibility gate need. Currency is a checkout-level
 * field in the response, but it must be carried per line long enough to prove
 * the whole basket agrees on one; the delivery flags and weight likewise are
 * per-product facts that the basket-level decision is made from.
 */
interface ResolvedLine extends CheckoutLine {
  allowPickup: boolean;
  allowShipping: boolean;
  currency: string;
  shippingRates: ShippingRates | null;
  weightGrams: number;
}

export interface Checkout {
  checkoutId: string;
  currency: string;
  deliveryMethod: DeliveryMethod;
  discountMinor: number;
  expiresAt: number;
  items: CheckoutLine[];
  shippingCountry: string | null;
  shippingMinor: number;
  subtotalMinor: number;
  totalMinor: number;
  vatMinor: number;
  vatRateBp: number;
}

export type CreateCheckoutResult =
  | { checkout: Checkout; replayed: boolean; status: "ok" }
  | { status: "conflict" | "invalid_items" };

interface PublicationRow {
  allow_pickup: number;
  allow_shipping: number;
  currency: string;
  product_id: string;
  public_name: string;
  public_price_minor: number;
  shipping_json: string | null;
  sku: string;
  weight_grams: number;
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
  delivery_method: DeliveryMethod;
  discount_minor: number;
  expires_at: number;
  shipping_country: string | null;
  shipping_minor: number;
  subtotal_minor: number;
  total_minor: number;
  vat_minor: number;
  vat_rate_bp: number;
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
// at ~5e12 — three orders of magnitude below Number.MAX_SAFE_INTEGER, so the
// sums below can never lose precision.
//
// That bound is NOT sufficient for the VAT derivation, which scales the total
// by 10 000 before dividing: the largest permissible subtotal exceeds what that
// scaling can represent exactly. `quoteTotals` therefore refuses a total above
// MAX_VAT_SAFE_TOTAL_MINOR rather than quoting an imprecise tax on it. No real
// basket approaches either ceiling; the point is that the failure mode is a
// refusal instead of a silently-wrong number.
export const MAX_ITEM_QUANTITY = 999;
const MAX_UNIT_PRICE_MINOR = 100_000_000;

const CHECKOUT_KEYS = [
  "deliveryMethod",
  "email",
  "idempotencyKey",
  "items",
  "shippingCountry",
] as const;
const ITEM_KEYS = ["productId", "quantity", "variantId"] as const;
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
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

function parseDeliveryMethod(value: unknown): DeliveryMethod | null {
  return typeof value === "string" &&
    (DELIVERY_METHODS as readonly string[]).includes(value)
    ? (value as DeliveryMethod)
    : null;
}

/**
 * ISO-3166-1 alpha-2, normalized to uppercase so 'se' and 'SE' are one country
 * rather than two — the schema stores uppercase and the region table is keyed on
 * it, so a lowercase value slipping through would silently price as
 * 'worldwide'. The pattern is ASCII-letters-only and length-exact: it is not a
 * membership test against a real country list, and it does not need to be,
 * because an unrecognized code resolves to the most expensive region rather
 * than the cheapest.
 */
function parseShippingCountry(value: unknown): string | null {
  return typeof value === "string" && COUNTRY_PATTERN.test(value)
    ? value.toUpperCase()
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
 * `price`, `unitPriceMinor`, `sku`, `name`, `currency`, `shippingMinor`, or any
 * other pricing field is rejected outright rather than ignored: silently
 * dropping such a key would let a caller believe it had influenced the total,
 * and a future refactor that started reading it would turn that belief into a
 * real price override. The server is the only source of money in this request.
 *
 * `deliveryMethod` is required rather than defaulted. A default would make the
 * cheaper branch reachable by omission, and the two branches price differently:
 * a body that forgot to say how the basket leaves the shop has not described a
 * purchasable basket, and guessing on the buyer's behalf is not this parser's
 * job.
 *
 * `shippingCountry` is required for a shipped basket and REJECTED for a
 * collected one, rather than accepted-and-ignored. A pickup request carrying a
 * country is self-contradictory, and the schema stores NULL there, so honouring
 * such a body would mean silently discarding a field the caller believed
 * mattered.
 */
export function parseCreateCheckoutInput(
  body: unknown,
): CreateCheckoutInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CHECKOUT_KEYS)) {
    return null;
  }

  const email = parseEmail(body.email);
  const idempotencyKey = parseIdempotencyKey(body.idempotencyKey);
  const deliveryMethod = parseDeliveryMethod(body.deliveryMethod);
  if (email === null || idempotencyKey === null || deliveryMethod === null) {
    return null;
  }

  let shippingCountry: string | null = null;
  if (deliveryMethod === "shipping") {
    shippingCountry = parseShippingCountry(body.shippingCountry);
    if (shippingCountry === null) {
      return null;
    }
  } else if (body.shippingCountry !== undefined) {
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

  return {
    deliveryMethod,
    email,
    idempotencyKey,
    items,
    shippingCountry,
  };
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
         product.sku AS sku,
         product.weight_grams AS weight_grams,
         product.allow_shipping AS allow_shipping,
         product.allow_pickup AS allow_pickup,
         product.shipping_json AS shipping_json
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
    // The delivery flags and the carriage table are canonical PRODUCT fields,
    // read from the row this query already joins for tenancy. They deliberately
    // do not exist on the publication projection: a buyer has no business
    // learning a parcel's weight, and a projection copy would be one more thing
    // that can drift away from what the merchant actually configured.
    allowPickup: publication.allow_pickup === 1,
    allowShipping: publication.allow_shipping === 1,
    currency: publication.currency,
    itemIndex,
    lineTotalMinor: unitPriceMinor * item.quantity,
    name: publication.public_name,
    productId: publication.product_id,
    quantity: item.quantity,
    shippingRates: parseShippingRates(publication.shipping_json),
    sku,
    unitPriceMinor,
    variantId,
    weightGrams: publication.weight_grams,
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

/**
 * The priced quote for a basket, before it is written.
 *
 * The delivery-eligibility gate lives here rather than in the parser because it
 * is not a shape question: it depends on what the tenant's catalogue says about
 * every resolved product, which only the server can know. It mirrors production
 * audit fix P1-06 — pickup zeroes carriage, so the SERVER, never the client,
 * decides whether this basket may be collected. The shipping direction is
 * gated symmetrically: a product the merchant marked collect-only must not be
 * put in a parcel just because the buyer asked.
 *
 * `every` is the right quantifier in both directions. One ineligible line makes
 * the whole basket ineligible, because a basket is fulfilled as one shipment.
 */
function quoteTotals(
  lines: ResolvedLine[],
  deliveryMethod: DeliveryMethod,
  shippingCountry: string | null,
  vatRateBp: number,
): {
  shippingMinor: number;
  subtotalMinor: number;
  totalMinor: number;
  vatMinor: number;
} | null {
  const subtotal = lines.reduce(
    (total, line) => total + line.lineTotalMinor,
    0,
  );

  let shipping = 0;
  if (deliveryMethod === "pickup") {
    if (!lines.every((line) => line.allowPickup)) {
      return null;
    }
  } else {
    if (!lines.every((line) => line.allowShipping)) {
      return null;
    }
    if (shippingCountry === null) {
      return null;
    }

    // The base tariff comes from the FIRST line's product, mirroring
    // production's cart. resolveLines has already guaranteed at least one line.
    const first = lines[0] as ResolvedLine;
    shipping = shippingMinor(
      getShippingRegion(shippingCountry),
      first.shippingRates,
      lines,
    );
  }

  // The v2 contract: total = subtotal + shipping - discount. Prices are
  // VAT-inclusive, so VAT is deliberately not a term — adding it would charge
  // the tax already inside subtotal a second time. The discount engine is a
  // later checkpoint; naming its contribution here rather than omitting the
  // term keeps this expression the same shape as the schema CHECK it must
  // satisfy, so the two can be read against each other.
  const discount = 0;
  const total = subtotal + shipping - discount;

  // A basket beyond the range VAT can be derived exactly for. The column
  // ceilings permit it arithmetically — 50 lines × 999 units × the maximum unit
  // price is ~5e12, past the ~9e11 the derivation stays exact below — but no
  // real basket comes near it, so reaching here means a corrupt catalogue row
  // or a deliberate overflow probe. It is refused as unprocessable rather than
  // quoted imprecisely or thrown as a 500: the buyer gets the same opaque
  // answer as any other unpriceable basket, and no imprecise money is stored.
  if (total > MAX_VAT_SAFE_TOTAL_MINOR) {
    return null;
  }

  return {
    shippingMinor: shipping,
    subtotalMinor: subtotal,
    totalMinor: total,
    // Derived last and stored for the invoice, never added to the total.
    vatMinor: vatMinor(total, vatRateBp),
  };
}

/**
 * The tenant's VAT rate at quote time. Read here rather than carried on
 * TenantContext because the resolver runs on every request including reads that
 * have no use for it, and because the rate must be read in the same request
 * that freezes it onto the row.
 *
 * A missing row cannot happen — the resolver has already proven the tenant is
 * active — but the column is read defensively rather than asserted: falling
 * back to the schema default is the same number the tenant would have anyway.
 */
async function loadVatRateBp(
  db: D1Database,
  tenant: TenantContext,
): Promise<number> {
  const row = await db
    .prepare("SELECT vat_rate_bp FROM tenants WHERE tenant_id = ? LIMIT 1")
    .bind(tenant.tenantId)
    .first<{ vat_rate_bp: number }>();

  return row?.vat_rate_bp ?? 2_500;
}

function toCheckout(
  row: CheckoutRow,
  lines: CheckoutLine[],
): Checkout {
  return {
    checkoutId: row.checkout_id,
    currency: row.currency,
    deliveryMethod: row.delivery_method,
    discountMinor: row.discount_minor,
    expiresAt: row.expires_at,
    items: lines,
    shippingCountry: row.shipping_country,
    shippingMinor: row.shipping_minor,
    subtotalMinor: row.subtotal_minor,
    totalMinor: row.total_minor,
    vatMinor: row.vat_minor,
    vatRateBp: row.vat_rate_bp,
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
 *
 * total_minor and vat_minor are deliberately not compared. Both are pure
 * functions of fields this comparison already pins — the total of the line
 * prices plus the recomputed carriage, and the VAT of that total at the
 * compared rate — and the schema's CHECKs make the first relationship an
 * invariant of every stored row. Comparing them could only ever restate a check
 * already made, and a reader who saw them compared would reasonably assume they
 * were an INDEPENDENT source of truth, which they are not.
 */
function matchesExisting(
  existing: CheckoutRow,
  existingLines: CheckoutItemRow[],
  email: string,
  currency: string,
  lines: CheckoutLine[],
  quote: {
    deliveryMethod: DeliveryMethod;
    shippingCountry: string | null;
    shippingMinor: number;
    vatRateBp: number;
  },
): boolean {
  if (
    existing.customer_email !== email ||
    existing.currency !== currency ||
    // The delivery decision is priced, so it is part of the fingerprint. A
    // replay that switched from pickup to shipping (or the reverse) is a
    // different purchase at a different price under a reused key, and answering
    // 'ok' would hand back a checkout the caller did not just describe.
    existing.delivery_method !== quote.deliveryMethod ||
    existing.shipping_country !== quote.shippingCountry ||
    // Freshly recomputed carriage, not the client's word for it. This is the
    // case only the server can see: the merchant may have edited the shipping
    // table, a product's weight, or the fallback-triggering configuration
    // between the two attempts, and the stored quote would then be stale. A
    // stale carriage quote must conflict for the same reason a stale price
    // must — replaying it would silently honour a tariff that no longer exists.
    existing.shipping_minor !== quote.shippingMinor ||
    // The frozen rate. A tenant that changed its VAT rate between attempts
    // would otherwise replay an invoice line computed under the old one.
    existing.vat_rate_bp !== quote.vatRateBp ||
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
         checkout_id, currency, customer_email, delivery_method,
         shipping_country, expires_at, subtotal_minor, shipping_minor,
         vat_minor, vat_rate_bp, discount_minor, total_minor
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

  const vatRateBp = await loadVatRateBp(db, tenant);
  const quote = quoteTotals(
    lines,
    input.deliveryMethod,
    input.shippingCountry,
    vatRateBp,
  );
  // A basket whose products do not all permit the requested delivery method is
  // not purchasable that way. It answers the same opaque 422 as an unresolvable
  // line, and for the same reason: naming the offending product would turn the
  // route into an oracle for which items a tenant offers for collection.
  if (quote === null) {
    return { status: "invalid_items" };
  }

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
          delivery_method, shipping_country, subtotal_minor, shipping_minor,
          vat_minor, vat_rate_bp, discount_minor, total_minor,
          payment_intent_id, idempotency_key_hash,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        checkoutId,
        tenant.tenantId,
        input.email,
        currency,
        input.deliveryMethod,
        input.shippingCountry,
        quote.subtotalMinor,
        quote.shippingMinor,
        quote.vatMinor,
        vatRateBp,
        quote.totalMinor,
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
        {
          deliveryMethod: input.deliveryMethod,
          shippingCountry: input.shippingCountry,
          shippingMinor: quote.shippingMinor,
          vatRateBp,
        },
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
      deliveryMethod: input.deliveryMethod,
      discountMinor: 0,
      expiresAt,
      // Projected field by field rather than spread: currency is a
      // checkout-level value and must not reappear on every line, and the
      // weight/delivery flags the shipping engine read are merchant
      // configuration that no buyer-facing response should carry.
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
      shippingCountry: input.shippingCountry,
      shippingMinor: quote.shippingMinor,
      subtotalMinor: quote.subtotalMinor,
      totalMinor: quote.totalMinor,
      vatMinor: quote.vatMinor,
      vatRateBp,
    },
    replayed: false,
    status: "ok",
  };
}
