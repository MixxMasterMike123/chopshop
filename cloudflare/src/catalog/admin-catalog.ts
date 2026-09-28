import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import type { ShippingRates } from "../commerce/shipping";
import {
  MAX_WEIGHT_GRAMS,
  normalizeShippingRates,
  toShippingRatesWire,
} from "../commerce/shipping";
import { evaluatePodGate, podRefusalMessage } from "../pod/pod-mappings";
import type { AdminProduct, ProductRow, ProductStatus } from "./admin-product-reads";
import {
  emptyToNull,
  loadAdminProduct,
  loadProductScreeningInput,
  MAX_PRODUCT_TAGS,
  storedShippingRates,
  toWire,
} from "./admin-product-reads";
import type { ProductScreeningInput } from "./screening-core";
import {
  isScreeningConflict,
  readScreeningGuard,
  screeningFenceStatement,
  screeningStatementsFor,
  withScreeningRetry,
} from "./screening";
import { checkHtml } from "../content/html-refusal";

// The admin product and its status moved to the read layer with CP4-A (the
// module every product write and screening read from); re-exported here so
// the importers of this module keep one place to import them from.
export type { AdminProduct, ProductStatus } from "./admin-product-reads";

/**
 * Why a publish (or a price edit) was refused — answered 422 with the code.
 *
 *   taken_down           a platform takedown stamp is set (A10)
 *   pod_mapping_missing  a POD product has a sellable unit with no active mapping
 *   pod_mapping_suspended a routing edit suspended one of its mappings
 *   pod_too_large        more variants/mappings than one gate checks completely
 *   pod_unpriced         its printer SKU / slots have no price (A1)
 *   currency_mismatch    the printer prices in another currency
 *   price_below_floor    PRISGOLV (podPricing.js): a price under the break-even floor
 */
export type AdminRefusalCode =
  | "currency_mismatch"
  | "pod_mapping_missing"
  | "pod_mapping_suspended"
  | "pod_too_large"
  | "pod_unpriced"
  | "price_below_floor"
  | "taken_down";

export type AdminCatalogResult =
  | { product: AdminProduct; status: "ok" }
  /**
   * `message` says what to do next (podRefusalMessage) — for pod_too_large it
   * names the exit (unpublish + reduce variants). src/app.ts renders a fixed
   * sentence today; the consolidation should prefer this one.
   */
  | { code: AdminRefusalCode; message: string; status: "refused" }
  | { status: "conflict" | "invalid" | "not_found" };

export function refused(code: AdminRefusalCode): { code: AdminRefusalCode; message: string; status: "refused" } {
  return { code, message: podRefusalMessage(code), status: "refused" };
}

/**
 * CP4-A: the fields a storefront page shows beyond name, description, price
 * and delivery (the field table of docs/cf-port/CP4_A_REPORT.md). Each is
 * optional on a write; on an update, `null` clears it and an absent key leaves
 * it alone. `tags` replaces the whole list.
 */
export interface ProductContentInput {
  brand?: string | null;
  category?: string | null;
  compareAtPriceMinor?: number | null;
  eanCode?: string | null;
  featured?: boolean;
  launchDate?: string | null;
  moreInfo?: string | null;
  size?: string | null;
  sizeGuide?: string | null;
  sortOrder?: number | null;
  stock?: number | null;
  tags?: string[];
}

export interface CreateProductInput extends ProductContentInput {
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

export interface UpdateProductInput extends ProductContentInput {
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

const CONTENT_KEYS = [
  "brand",
  "category",
  "compareAtPriceMinor",
  "eanCode",
  "featured",
  "launchDate",
  "moreInfo",
  "size",
  "sizeGuide",
  "sortOrder",
  "stock",
  "tags",
] as const;
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
  ...CONTENT_KEYS,
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
  ...CONTENT_KEYS,
] as const;
const PRODUCT_STATUSES: ProductStatus[] = ["draft", "active", "archived"];
const SKU_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 2_000;
export const PRICE_MINOR_MAX = 100_000_000;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// The column caps of migrations/0040, checked here so a bad value is a 400
// with nothing written rather than a failed batch.
const CATEGORY_MAX_LENGTH = 100;
const TAG_MAX_LENGTH = 50;
const MORE_INFO_MAX_LENGTH = 20_000;
const SIZE_GUIDE_MAX_LENGTH = 5_000;
const SIZE_MAX_LENGTH = 50;
const BRAND_MAX_LENGTH = 100;
const EAN_MAX_LENGTH = 32;
const STOCK_MAX = 1_000_000_000;
const SORT_ORDER_LIMIT = 1_000_000_000;
const HANDLE_MAX_LENGTH = 1_200;
const LAUNCH_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A control character: refused in one-line text; tab, LF and CR pass in multi-line text. */
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MULTILINE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Defaults for a freshly created product, matching the schema's column
// defaults. Shipping is permitted and pickup is not: a merchant who has not
// configured collection cannot honour a collected order, and defaulting the
// other way would let a buyer zero the carriage on a product nobody agreed to
// hand over in person.
const DEFAULT_WEIGHT_GRAMS = 0;
const DEFAULT_ALLOW_SHIPPING = true;
const DEFAULT_ALLOW_PICKUP = false;

// ── the address rules (the source system's, shared with the importer) ──────

/**
 * The source system's `slugify` (src/utils/productUrls.js), byte for byte:
 * lowercase, trim, whitespace → "-", å/ä → a, ö → o, & → "-and-", every
 * other character outside [A-Za-z0-9_-] dropped, runs of "-" collapsed. It
 * builds every storefront address that carries a name: a product's handle, a
 * category's `/kategori/<key>`, a tag's `/tagg/<key>`. The importer applies
 * the same function (the pinned vectors are in test/admin-products.test.ts).
 */
export function addressSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/&/g, "-and-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-");
}

/**
 * A product's handle: the last segment of its storefront address today,
 * `slugify(name + " " + size) + "_" + sku` (productUrls.js
 * getVariantProductSlug; the product page finds the product by the sku after
 * the last "_"). A "/" in the sku becomes "-": one path segment cannot carry
 * it, and the source address of such a product never resolved either.
 */
export function productHandle(name: string, size: string | null, sku: string): string {
  return `${addressSlug(`${name} ${size ?? ""}`)}_${sku.replace(/\//g, "-")}`;
}

/** A category's or a tag's address form; "" = the text has no address (refused). */
export function categoryKey(category: string): string {
  return addressSlug(category);
}

export function productTagKey(tag: string): string {
  return addressSlug(tag);
}

/**
 * The storefront path of a product, relative to the shop's root (the address
 * grammar of CP4_BRIEFS.md): the handle as ONE percent-encoded segment,
 * `encodeURIComponent` plus `!'()*`, the segment rule of
 * src/storefront/redirects.ts, so every surface writes a handle one way.
 */
export function productPath(handle: string): string {
  const segment = encodeURIComponent(handle).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `/product/${segment}`;
}

function isValidHandle(handle: string): boolean {
  return handle.length >= 1 && handle.length <= HANDLE_MAX_LENGTH && !handle.includes("/");
}

// ── parsing ─────────────────────────────────────────────────────────────────

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

export function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

export function parseSku(value: unknown): string | null {
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

export function parsePriceMinor(value: unknown): number | null {
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
export function parseBoolean(value: unknown): boolean | null {
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

/**
 * Optional free text: `null` clears; a string is NFC-normalised and trimmed,
 * and one that is empty after trimming clears too (the screening routes' note
 * rule). `undefined` = invalid (too long, a control character, not a string).
 */
export function parseOptionalText(
  value: unknown,
  maxLength: number,
  multiline = false,
): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.normalize("NFC").trim();
  if ((multiline ? MULTILINE_CONTROL_PATTERN : CONTROL_PATTERN).test(text)) {
    return undefined;
  }
  if (text.length > maxLength) {
    return undefined;
  }
  return text === "" ? null : text;
}

function parseOptionalInteger(value: unknown, min: number, max: number): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/** A real calendar date as YYYY-MM-DD (the 0040 CHECK's round trip), or null. */
function parseLaunchDate(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !LAUNCH_DATE_PATTERN.test(value)) {
    return undefined;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

/** A category with an address; "" or a text whose address is empty is refused. */
function parseCategory(value: unknown): string | null | undefined {
  const category = parseOptionalText(value, CATEGORY_MAX_LENGTH);
  if (typeof category === "string" && categoryKey(category) === "") {
    return undefined;
  }
  return category;
}

/**
 * The whole tag list: at most 20, each 1–50 characters with an address.
 * Two tags with one address are one tag — sent twice, the list is refused
 * (a client bug), never collapsed.
 */
function parseTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PRODUCT_TAGS) {
    return undefined;
  }
  const tags: string[] = [];
  const keys = new Set<string>();
  for (const entry of value) {
    const tag = parseOptionalText(entry, TAG_MAX_LENGTH);
    if (typeof tag !== "string") {
      return undefined;
    }
    const key = productTagKey(tag);
    if (key === "" || keys.has(key)) {
      return undefined;
    }
    keys.add(key);
    tags.push(tag);
  }
  return tags;
}

/**
 * The CP4-A fields of a create or update body into `input`. false = one of
 * them is invalid (the whole body is refused).
 */
/**
 * "Mer information" is HTML a visitor's browser renders: it passes the same
 * refusal at write as a page's content (src/content/html-refusal.ts), so
 * nothing that can run or fetch is stored. `undefined` = refused.
 */
function parseMoreInfo(value: unknown): string | null | undefined {
  const text = parseOptionalText(value, MORE_INFO_MAX_LENGTH, true);
  return typeof text === "string" && !checkHtml(text).ok ? undefined : text;
}

function parseContentFields(body: Record<string, unknown>, input: ProductContentInput): boolean {
  const optional: Array<[keyof ProductContentInput, (value: unknown) => unknown]> = [
    ["brand", (value) => parseOptionalText(value, BRAND_MAX_LENGTH)],
    ["category", parseCategory],
    ["compareAtPriceMinor", (value) => parseOptionalInteger(value, 0, PRICE_MINOR_MAX)],
    ["eanCode", (value) => parseOptionalText(value, EAN_MAX_LENGTH)],
    ["featured", (value) => parseBoolean(value) ?? undefined],
    ["launchDate", parseLaunchDate],
    ["moreInfo", parseMoreInfo],
    ["size", (value) => parseOptionalText(value, SIZE_MAX_LENGTH)],
    ["sizeGuide", (value) => parseOptionalText(value, SIZE_GUIDE_MAX_LENGTH, true)],
    ["sortOrder", (value) => parseOptionalInteger(value, -SORT_ORDER_LIMIT, SORT_ORDER_LIMIT)],
    ["stock", (value) => parseOptionalInteger(value, 0, STOCK_MAX)],
    ["tags", parseTags],
  ];
  for (const [key, parse] of optional) {
    if (body[key] === undefined) {
      continue;
    }
    const parsed = parse(body[key]);
    if (parsed === undefined) {
      return false;
    }
    Object.assign(input, { [key]: parsed });
  }
  return true;
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

  if (!parseContentFields(body, input)) {
    return null;
  }

  return isValidHandle(productHandle(input.name, input.size ?? null, input.sku)) ? input : null;
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

  if (!parseContentFields(body, input)) {
    return null;
  }

  return Object.keys(input).length === 0 ? null : input;
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

export function isUniqueConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

/** One audit row of a product write (resource_type 'product'), for the batch it belongs to. */
export function auditStatement(
  db: D1Database,
  principal: TenantAdminPrincipal,
  action: string,
  productId: string,
  now: number,
  metadata: Record<string, unknown> | null,
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
      auditMetadataJson(principal, metadata),
      now,
    );
}

/** One INSERT per tag, in the list's order. */
function tagInsertStatements(
  db: D1Database,
  tenantId: string,
  productId: string,
  tags: readonly string[],
): D1PreparedStatement[] {
  return tags.map((tag, position) =>
    db
      .prepare(
        `INSERT INTO product_tags (tenant_id, product_id, tag_key, tag, position)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(tenantId, productId, productTagKey(tag), tag, position),
  );
}

/** The statements that make a product's tag list exactly `tags` (in that order). */
function tagReplaceStatements(
  db: D1Database,
  tenantId: string,
  productId: string,
  tags: readonly string[],
): D1PreparedStatement[] {
  return [
    db
      .prepare("DELETE FROM product_tags WHERE tenant_id = ? AND product_id = ?")
      .bind(tenantId, productId),
    ...tagInsertStatements(db, tenantId, productId, tags),
  ];
}

/**
 * A product's screened texts after this edit: what D1 holds, with the fields
 * the edit writes laid over it. Read AFTER the guard (THE FENCE).
 */
async function screeningInputAfter(
  db: D1Database,
  tenantId: string,
  next: AdminProduct,
): Promise<ProductScreeningInput> {
  const stored = await loadProductScreeningInput(db, tenantId, next.productId);
  return {
    ...(stored ?? {}),
    brand: next.brand,
    category: next.category,
    description: next.description,
    moreInfo: next.moreInfo,
    name: next.name,
    size: next.size,
    sizeGuide: next.sizeGuide,
    tags: next.tags,
  };
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
  const product: AdminProduct = {
    allowPickup,
    allowShipping,
    brand: input.brand ?? null,
    category: input.category ?? null,
    compareAtPriceMinor: input.compareAtPriceMinor ?? null,
    currency: input.currency,
    description: input.description,
    eanCode: input.eanCode ?? null,
    featured: input.featured ?? false,
    handle: productHandle(input.name, input.size ?? null, input.sku),
    // D46: never the seller's to set. The studio's buyer flow sets it (CP6).
    isPersonalized: false,
    isPod: false,
    launchDate: input.launchDate ?? null,
    moreInfo: input.moreInfo ?? null,
    name: input.name,
    priceMinor: input.priceMinor,
    productId,
    screeningStatus: null,
    shippingRates: toWire(emptyToNull(shippingRates)),
    size: input.size ?? null,
    sizeGuide: input.sizeGuide ?? null,
    sku: input.sku,
    sortOrder: input.sortOrder ?? null,
    status: "draft",
    stock: input.stock ?? null,
    tags: input.tags ?? [],
    weightGrams,
  };

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO products (
            product_id, tenant_id, status, sku, name, description,
            b2c_price_minor, currency, is_pod, weight_grams,
            allow_shipping, allow_pickup, shipping_json, created_at, updated_at,
            handle, featured, sort_order, compare_at_price_minor, category,
            category_key, more_info, size_guide, size, brand, ean_code, stock,
            launch_date, is_personalized
          ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          productId,
          principal.tenantId,
          product.sku,
          product.name,
          product.description,
          product.priceMinor,
          product.currency,
          weightGrams,
          allowShipping ? 1 : 0,
          allowPickup ? 1 : 0,
          serializeShippingRates(shippingRates),
          now,
          now,
          product.handle,
          product.featured ? 1 : 0,
          product.sortOrder,
          product.compareAtPriceMinor,
          product.category,
          product.category === null ? null : categoryKey(product.category),
          product.moreInfo,
          product.sizeGuide,
          product.size,
          product.brand,
          product.eanCode,
          product.stock,
          product.launchDate,
          product.isPersonalized ? 1 : 0,
        ),
      ...tagInsertStatements(db, principal.tenantId, productId, product.tags),
      auditStatement(db, principal, "product.create", productId, now, null),
    ]);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return { product, status: "ok" };
}

/**
 * A product edit. Guarded by the product's screening fence (src/catalog/
 * screening.ts, THE FENCE): if a platform decision or another edit lands
 * between this edit's reads and its batch, the batch rolls back whole and the
 * edit is re-run once from fresh reads — so an edit can never go live under a
 * verdict that was reached for different content. A second conflict answers
 * `conflict` (409) with nothing written.
 */
export async function updateAdminProduct(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  input: UpdateProductInput,
  now: number,
): Promise<AdminCatalogResult> {
  return withScreeningRetry<AdminCatalogResult>(
    now,
    (attemptNow) => updateAdminProductOnce(db, principal, productId, input, attemptNow),
    () => ({ status: "conflict" }),
  );
}

/** `input` over `current`: an absent key keeps the stored value, `null` clears it. */
function pick<T>(value: T | undefined, current: T): T {
  return value === undefined ? current : value;
}

async function updateAdminProductOnce(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  input: UpdateProductInput,
  now: number,
): Promise<AdminCatalogResult> {
  // FIRST, before any content read (THE FENCE).
  const guard = await readScreeningGuard(db, principal.tenantId, productId);
  const loaded = await loadAdminProduct(db, principal.tenantId, productId);
  if (loaded === null) {
    return { status: "not_found" };
  }
  const { product: current, row: existing } = loaded;

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

  const name = input.name ?? current.name;
  const size = pick(input.size, current.size);
  const sku = input.sku ?? current.sku;
  // The handle follows the name, the size and the sku, as the source system's
  // address does; the old address keeps resolving through the sku after its
  // last "_" (GET /v1/products/:ref).
  const handle =
    input.name === undefined && input.size === undefined && input.sku === undefined
      ? current.handle
      : productHandle(name, size, sku);
  if (!isValidHandle(handle)) {
    return { status: "invalid" };
  }

  const next: AdminProduct = {
    allowPickup: input.allowPickup ?? current.allowPickup,
    allowShipping: input.allowShipping ?? current.allowShipping,
    brand: pick(input.brand, current.brand),
    category: pick(input.category, current.category),
    compareAtPriceMinor: pick(input.compareAtPriceMinor, current.compareAtPriceMinor),
    currency: current.currency,
    description: pick(input.description, current.description),
    eanCode: pick(input.eanCode, current.eanCode),
    featured: input.featured ?? current.featured,
    handle,
    isPersonalized: current.isPersonalized,
    isPod: current.isPod,
    launchDate: pick(input.launchDate, current.launchDate),
    moreInfo: pick(input.moreInfo, current.moreInfo),
    name,
    priceMinor: input.priceMinor ?? current.priceMinor,
    productId,
    screeningStatus: current.screeningStatus,
    shippingRates: toWire(nextRates),
    size,
    sizeGuide: pick(input.sizeGuide, current.sizeGuide),
    sku,
    sortOrder: pick(input.sortOrder, current.sortOrder),
    status: input.status ?? current.status,
    stock: pick(input.stock, current.stock),
    tags: input.tags ?? current.tags,
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

  // PRISGOLV (src/wagons/pod-wagon/podPricing.js, enforced by ProductForm on
  // every save of a live POD product): a price edit may not put a LIVE POD
  // product under its break-even floor.
  //
  //   - Only a LOWERED price on a product that stays live is gated. A raise
  //     can only move a price away from the floor, and a product that is not
  //     live is gated in full by the next publish — so neither is refused,
  //     and an imported product past the gate's size is never stranded (it
  //     can always be unpublished, re-priced upward, and re-mapped).
  //   - The gate must PASS: every non-null answer refuses (reviewer P2). A
  //     gate that stopped early — a suspended mapping, a unit it could not
  //     quote, too many variants — has not shown the new price clears the
  //     floor, and treating that as a pass let a live product be re-priced
  //     under PRISGOLV while one of its mappings was suspended.
  const liveAfter = publication?.published === 1 && next.status === "active";
  if (
    input.priceMinor !== undefined &&
    existing.is_pod === 1 &&
    liveAfter &&
    input.priceMinor < existing.b2c_price_minor
  ) {
    const failure = await evaluatePodGate(db, principal.tenantId, productId, {
      productPriceMinor: input.priceMinor,
    });
    if (failure !== null) {
      return refused(failure);
    }
  }

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE products
         SET sku = ?, name = ?, description = ?, b2c_price_minor = ?,
             status = ?, weight_grams = ?, allow_shipping = ?,
             allow_pickup = ?, shipping_json = ?,
             handle = ?, featured = ?,
             -- Written only when this edit names it: the order route is a
             -- second writer of this column and takes no screening fence, so
             -- an edit that merely read it must not write an older place back.
             sort_order = CASE WHEN ? = 1 THEN ? ELSE sort_order END,
             compare_at_price_minor = ?, category = ?, category_key = ?,
             more_info = ?, size_guide = ?, size = ?, brand = ?,
             ean_code = ?, stock = ?, launch_date = ?, is_personalized = ?,
             -- Strictly increasing, never merely "now": a concurrent first
             -- publish fences on this column (publishAdminProduct), and two
             -- writes in one millisecond must still read as a change.
             updated_at = max(?, updated_at + 1)
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
        next.handle,
        next.featured ? 1 : 0,
        input.sortOrder === undefined ? 0 : 1,
        next.sortOrder,
        next.compareAtPriceMinor,
        next.category,
        next.category === null ? null : categoryKey(next.category),
        next.moreInfo,
        next.sizeGuide,
        next.size,
        next.brand,
        next.eanCode,
        next.stock,
        next.launchDate,
        next.isPersonalized ? 1 : 0,
        now,
        principal.tenantId,
        productId,
      ),
  ];

  if (input.tags !== undefined) {
    statements.push(...tagReplaceStatements(db, principal.tenantId, productId, next.tags));
  }

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

  // PLAN §2.4: product text is screened content. A product that stays live
  // through this edit is re-screened from the text this batch writes, in this
  // batch; one that leaves the storefront (archived/draft) is not live, and a
  // draft harms nobody (the Firebase `isLive` rule). CP4-A: "the text" is
  // every text a visitor reads (screening-core.ts ProductScreeningInput), with
  // this edit's fields laid over what D1 holds.
  let screeningStatus = current.screeningStatus;
  if (liveAfter) {
    const screening = await screeningStatementsFor(db, {
      guard,
      now,
      texts: await screeningInputAfter(db, principal.tenantId, next),
    });
    statements.push(...screening.statements);
    screeningStatus = screening.status;
  } else {
    // Not screened, still fenced: a publish or platform decision racing this
    // edit must not commit around it.
    statements.push(screeningFenceStatement(db, guard, now));
  }

  statements.push(
    auditStatement(db, principal, "product.update", productId, now, {
      fields: Object.keys(input).sort(),
    }),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    if (!isScreeningConflict(error) && isUniqueConstraintFailure(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return { product: { ...next, screeningStatus }, status: "ok" };
}

/**
 * Publish = the product becomes LIVE. In one batch: the public projection, the
 * product's screening (its first one creates the D8 row — a shop's first N
 * products land 'pending' and stay off the storefront until a platform
 * approval), and the audit row. catalog_version bumps by trigger.
 *
 * Refused (422 + code) before anything is written when the product is taken
 * down, or — for a POD product — when any sellable unit has no active mapping,
 * is unpriced, or is priced under PRISGOLV (evaluatePodGate). A 'pending'
 * product is NOT refused: publishing is how it enters the review queue.
 */
export async function publishAdminProduct(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  now: number,
): Promise<AdminCatalogResult> {
  return withScreeningRetry<AdminCatalogResult>(
    now,
    (attemptNow) => publishAdminProductOnce(db, principal, productId, attemptNow),
    () => ({ status: "conflict" }),
  );
}

async function publishAdminProductOnce(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  now: number,
): Promise<AdminCatalogResult> {
  // FIRST, before any content read (THE FENCE).
  const guard = await readScreeningGuard(db, principal.tenantId, productId);
  const loaded = await loadAdminProduct(db, principal.tenantId, productId);
  if (loaded === null) {
    return { status: "not_found" };
  }
  const existing: ProductRow = loaded.row;
  if (existing.status !== "active") {
    return { status: "conflict" };
  }
  if (existing.takedown_at !== null) {
    return refused("taken_down");
  }
  if (existing.is_pod === 1) {
    const failure = await evaluatePodGate(db, principal.tenantId, productId);
    if (failure !== null) {
      return refused(failure);
    }
  }

  // Every text a visitor will read once this is live (CP4-A), read after the
  // guard like every other content read.
  const texts = await loadProductScreeningInput(db, principal.tenantId, productId);
  if (texts === null) {
    return { status: "not_found" };
  }
  const screening = await screeningStatementsFor(db, { guard, now, texts });

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
    ...screening.statements,
    // The content fence. A product that was never screened has no row for a
    // concurrent edit or mapping change to bump, so this publish also checks
    // that the product row it screened is still the row it read: every writer
    // of screened content moves products.updated_at strictly forward (text
    // edits, mapping create/delete, variant and image writes, platform
    // decisions), and a moved value sets the row this batch just wrote to
    // version 0 — tripping the version trigger and rolling the publish back
    // for a retry from fresh reads.
    db
      .prepare(
        `UPDATE product_screening SET version = 0
         WHERE tenant_id = ? AND product_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM products
             WHERE tenant_id = ? AND product_id = ? AND updated_at = ?
           )`,
      )
      .bind(
        principal.tenantId,
        productId,
        principal.tenantId,
        productId,
        existing.updated_at,
      ),
    auditStatement(db, principal, "product.publish", productId, now, null),
  ]);

  return {
    product: { ...loaded.product, screeningStatus: screening.status },
    status: "ok",
  };
}

export async function unpublishAdminProduct(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  now: number,
): Promise<AdminCatalogResult> {
  const loaded = await loadAdminProduct(db, principal.tenantId, productId);
  if (loaded === null) {
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

  return { product: loaded.product, status: "ok" };
}

// ── the display order (PUT /v1/admin/products/order) ───────────────────────

export const MAX_ORDER_ENTRIES = 200;

export interface ProductOrderEntry {
  productId: string;
  /** null clears the product's place (it sorts after every ordered product). */
  sortOrder: number | null;
}

const PRODUCT_ID_MAX_LENGTH = 128;

/** `[{ productId, sortOrder }]`, 1–200 entries, each product once. */
export function parseProductOrderInput(body: unknown): ProductOrderEntry[] | null {
  if (!Array.isArray(body) || body.length === 0 || body.length > MAX_ORDER_ENTRIES) {
    return null;
  }
  const entries: ProductOrderEntry[] = [];
  const seen = new Set<string>();
  for (const entry of body) {
    if (!isPlainObject(entry) || !hasOnlyKeys(entry, ["productId", "sortOrder"])) {
      return null;
    }
    const productId = entry.productId;
    const sortOrder = parseOptionalInteger(entry.sortOrder, -SORT_ORDER_LIMIT, SORT_ORDER_LIMIT);
    if (
      typeof productId !== "string" ||
      productId.length === 0 ||
      productId.length > PRODUCT_ID_MAX_LENGTH ||
      seen.has(productId) ||
      sortOrder === undefined ||
      entry.sortOrder === undefined
    ) {
      return null;
    }
    seen.add(productId);
    entries.push({ productId, sortOrder });
  }
  return entries;
}

export type ProductOrderResult =
  | { products: ProductOrderEntry[]; status: "ok" }
  | { status: "not_found" };

/**
 * The admin's drag order, in ONE batch: every named product of this shop gets
 * its place, or — when one of them is not this shop's — nothing is written
 * (404, the same answer an unknown id gets). Not screened content, so no
 * screening fence; `updated_at` moves forward like every product write.
 */
export async function setProductOrder(
  db: D1Database,
  principal: TenantAdminPrincipal,
  entries: readonly ProductOrderEntry[],
  now: number,
): Promise<ProductOrderResult> {
  const found = new Set<string>();
  for (let start = 0; start < entries.length; start += 90) {
    const chunk = entries.slice(start, start + 90).map((entry) => entry.productId);
    const rows = await db
      .prepare(
        `SELECT product_id FROM products
         WHERE tenant_id = ? AND product_id IN (${chunk.map(() => "?").join(", ")})`,
      )
      .bind(principal.tenantId, ...chunk)
      .all<{ product_id: string }>();
    for (const row of rows.results) {
      found.add(row.product_id);
    }
  }
  if (found.size !== entries.length) {
    return { status: "not_found" };
  }

  await db.batch([
    ...entries.map((entry) =>
      db
        .prepare(
          `UPDATE products SET sort_order = ?, updated_at = max(?, updated_at + 1)
           WHERE tenant_id = ? AND product_id = ?`,
        )
        .bind(entry.sortOrder, now, principal.tenantId, entry.productId),
    ),
    db
      .prepare(
        `INSERT INTO audit_events (
          event_id, tenant_id, actor_user_id, action, resource_type,
          resource_id, request_id, metadata_json, created_at
        ) VALUES (?, ?, ?, 'product.reorder', 'product', NULL, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.tenantId,
        principal.userId,
        crypto.randomUUID(),
        auditMetadataJson(principal, { entries }),
        now,
      ),
  ]);

  return { products: [...entries], status: "ok" };
}
