import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import type { PublicImage } from "../storage/public-objects";
import { getReferencablePublicImage, resolvePublicImages } from "../storage/public-objects";
import { collectionPath, slugify } from "../storefront/addresses";
import { publicShopStatement } from "../storefront/public-shop";
import type { TenantContext } from "../tenancy/resolve-tenant";
import type { DisplayCursor, DisplayOrderColumns } from "./admin-product-reads";
import {
  decodeDisplayCursor,
  displayOrderAfter,
  displayOrderBy,
  encodeDisplayCursor,
} from "./admin-product-reads";
import type { PublicProductSummary } from "./public-catalog";
import {
  listPublicProductPage,
  listPublicProductsByIds,
  MAX_PUBLIC_PRODUCTS_BY_IDS,
} from "./public-catalog";

/**
 * CP4-B — collections (migrations/0041; manifest row 20; D87).
 *
 * Firebase source: the `collections` collection, written by
 * AdminCollectionEdit.jsx / AdminCollections.jsx and read by
 * PublicStorefront.jsx, ProductCollectionPage.jsx and AdminMenu.jsx. A
 * collection is MANUAL (hand-picked products, in pick order) or SMART (every
 * product carrying one tag, in the storefront's display order —
 * src/utils/collectionResolver.js).
 *
 * THE PRODUCTS OF A COLLECTION reach a public shape only through builder A's
 * functions (src/catalog/public-catalog.ts): a manual collection's members by
 * `listPublicProductsByIds` (the order given, whatever THE predicate refuses
 * dropped), a smart one's by `listPublicProductPage` with the tag's ADDRESS
 * form (`slugify`, as product_tags.tag_key and the /tagg/<key> page match
 * it). This module writes no product query of its own: a draft, an
 * archived or taken-down product, or another shop's, cannot appear.
 *
 * A PUBLIC read answers only a PUBLISHED collection of an ACTIVE, PUBLISHED
 * shop (storefront/public-shop.ts publicShopStatement, the one gate of the
 * public reads of CP4). `:ref` is a handle, an external_ref or an id, which
 * share one namespace per shop (0041's triggers and `refConflict` below), so
 * a ref names at most one collection.
 */

export const COLLECTION_TYPES = ["manual", "smart"] as const;
export type CollectionType = (typeof COLLECTION_TYPES)[number];

/** A new collection gets a UUID; an imported one keeps its Firestore id. */
export const COLLECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const COLLECTION_HANDLE_MAX_LENGTH = 200;
/** URL-unreserved characters: one path segment that never needs an escape. */
const EXTERNAL_REF_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const HAS_LETTER_OR_DIGIT = /[A-Za-z0-9]/;
const OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const COLLECTION_TITLE_MAX_LENGTH = 200;
export const COLLECTION_DESCRIPTION_MAX_LENGTH = 5_000;
/** product_tags.tag's rule (0040). */
export const COLLECTION_RULE_TAG_MAX_LENGTH = 50;
/** 0041's position CHECK (0–499) and UNIQUE (collection_id, position). */
export const MAX_COLLECTION_PRODUCTS = 500;
const PRODUCT_ID_MAX_LENGTH = 128;
const SORT_ORDER_LIMIT = 1_000_000_000;

/** Longer than any valid ref: a handle is at most 200 characters, the others 128. */
export const COLLECTION_REF_MAX_LENGTH = 200;

/** One collection's fields; a description of 5 000 characters escapes to ~30 KB. */
export const COLLECTION_BODY_MAX_BYTES = 65_536;
/** 500 ids of up to 128 characters, with room for escapes. */
export const COLLECTION_PRODUCTS_BODY_MAX_BYTES = 262_144;

export const ADMIN_COLLECTION_LIST_LIMIT = 50;
export const PUBLIC_COLLECTION_LIST_LIMIT = 100;
export const PUBLIC_COLLECTION_PRODUCT_LIMIT = 24;
const LIST_LIMIT_MAX = 100;

// Plain text on one line (title, tag): no control character at all.
const LINE_CONTROL = /[\u0000-\u001f\u007f]/;
// Plain text that may break lines (the description).
const TEXT_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The display order of the lists: sort order (NULL last), then title, then id. */
const ORDER_COLUMNS: DisplayOrderColumns = {
  id: "collection.collection_id",
  name: "collection.title",
  sortOrder: "collection.sort_order",
};

function iso(now: number): string {
  return new Date(now).toISOString();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── the grammar of a handle and an external reference ───────────────────────

/**
 * A handle is exactly what the source's slugify leaves (AdminCollectionEdit
 * slugifies every keystroke of the field): a fixed point of `slugify`,
 * i.e. lower-case ASCII letters, digits, `_` and `-`, never `--`, with at
 * least one letter or digit. The same rule as 0041's CHECK.
 */
export function isCollectionHandle(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= COLLECTION_HANDLE_MAX_LENGTH &&
    slugify(value) === value &&
    /[a-z0-9]/.test(value)
  );
}

export function isExternalRef(value: string): boolean {
  return EXTERNAL_REF_PATTERN.test(value) && HAS_LETTER_OR_DIGIT.test(value);
}

// ── parsing the admin's input ───────────────────────────────────────────────

export interface CollectionFields {
  description?: string | null;
  externalRef?: string | null;
  featured?: boolean;
  handle?: string;
  imageObjectId?: string | null;
  published?: boolean;
  ruleTag?: string | null;
  sortOrder?: number | null;
  title?: string;
  type?: CollectionType;
}

const COLLECTION_FIELDS = [
  "description",
  "externalRef",
  "featured",
  "handle",
  "imageObjectId",
  "published",
  "ruleTag",
  "sortOrder",
  "title",
  "type",
] as const;

/**
 * Plain text: NFC, trimmed, no control character (line breaks where allowed),
 * no lone surrogate. `null` = refused; "" = empty after trimming.
 */
function parseText(value: unknown, maxLength: number, lineBreaks: boolean): string | null {
  if (typeof value !== "string" || LONE_SURROGATE.test(value)) {
    return null;
  }
  const text = value.normalize("NFC").trim();
  return text.length > maxLength || (lineBreaks ? TEXT_CONTROL : LINE_CONTROL).test(text) ? null : text;
}

type FieldResult<T> = { ok: true; value: T } | { ok: false };

const refused: { ok: false } = { ok: false };

function parseTitle(value: unknown): FieldResult<string> {
  const text = parseText(value, COLLECTION_TITLE_MAX_LENGTH, false);
  return text === null || text === "" ? refused : { ok: true, value: text };
}

/** `null` or "" (or only white space) clears. */
function parseDescription(value: unknown): FieldResult<string | null> {
  if (value === null) {
    return { ok: true, value: null };
  }
  const text = parseText(value, COLLECTION_DESCRIPTION_MAX_LENGTH, true);
  return text === null ? refused : { ok: true, value: text === "" ? null : text };
}

/** Refused, never repaired: a client slugifies as the source's form did. */
function parseHandle(value: unknown): FieldResult<string> {
  return typeof value === "string" && isCollectionHandle(value) ? { ok: true, value } : refused;
}

/** `null` or "" clears. */
function parseExternalRef(value: unknown): FieldResult<string | null> {
  if (value === null || value === "") {
    return { ok: true, value: null };
  }
  return typeof value === "string" && isExternalRef(value) ? { ok: true, value } : refused;
}

/** A tag with an address (A's tag rule); `null` only where the type allows it. */
function parseRuleTag(value: unknown): FieldResult<string | null> {
  if (value === null) {
    return { ok: true, value: null };
  }
  const text = parseText(value, COLLECTION_RULE_TAG_MAX_LENGTH, false);
  return text === null || text === "" || slugify(text) === "" ? refused : { ok: true, value: text };
}

function parseImageObjectId(value: unknown): FieldResult<string | null> {
  if (value === null) {
    return { ok: true, value: null };
  }
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value) ? { ok: true, value } : refused;
}

function parseSortOrder(value: unknown): FieldResult<number | null> {
  if (value === null) {
    return { ok: true, value: null };
  }
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= -SORT_ORDER_LIMIT &&
    value <= SORT_ORDER_LIMIT
    ? { ok: true, value }
    : refused;
}

function parseBoolean(value: unknown): FieldResult<boolean> {
  return typeof value === "boolean" ? { ok: true, value } : refused;
}

function parseType(value: unknown): FieldResult<CollectionType> {
  return typeof value === "string" && (COLLECTION_TYPES as readonly string[]).includes(value)
    ? { ok: true, value: value as CollectionType }
    : refused;
}

/**
 * Strict body: only a collection's own fields, each well-formed. `create`
 * requires `title`; an update takes any non-empty subset. null = refused.
 * Whether `ruleTag` fits the type is decided with the stored row
 * (`resolveRule`), since an update may name one without the other.
 */
export function parseCollectionInput(body: unknown, mode: "create" | "update"): CollectionFields | null {
  if (!isPlainRecord(body)) {
    return null;
  }
  const keys = Object.keys(body);
  if (
    keys.length === 0 ||
    !keys.every((key) => (COLLECTION_FIELDS as readonly string[]).includes(key)) ||
    (mode === "create" && !keys.includes("title"))
  ) {
    return null;
  }

  const input: CollectionFields = {};
  const steps: Array<() => boolean> = [
    () => take(body.title, parseTitle, (value) => (input.title = value)),
    () => take(body.handle, parseHandle, (value) => (input.handle = value)),
    () => take(body.externalRef, parseExternalRef, (value) => (input.externalRef = value)),
    () => take(body.description, parseDescription, (value) => (input.description = value)),
    () => take(body.imageObjectId, parseImageObjectId, (value) => (input.imageObjectId = value)),
    () => take(body.type, parseType, (value) => (input.type = value)),
    () => take(body.ruleTag, parseRuleTag, (value) => (input.ruleTag = value)),
    () => take(body.published, parseBoolean, (value) => (input.published = value)),
    () => take(body.featured, parseBoolean, (value) => (input.featured = value)),
    () => take(body.sortOrder, parseSortOrder, (value) => (input.sortOrder = value)),
  ];
  return steps.every((step) => step()) ? input : null;
}

function take<T>(value: unknown, parse: (value: unknown) => FieldResult<T>, assign: (value: T) => void): boolean {
  if (value === undefined) {
    return true;
  }
  const parsed = parse(value);
  if (!parsed.ok) {
    return false;
  }
  assign(parsed.value);
  return true;
}

/**
 * `PUT …/products`: the WHOLE ordered list, a JSON array of product ids, at
 * most 500, each once. Whether each is a product of this shop is the write's
 * (0041's trigger), answered as `product_not_found`. null = refused.
 */
export function parseCollectionProductsInput(body: unknown): string[] | null {
  if (!Array.isArray(body) || body.length > MAX_COLLECTION_PRODUCTS) {
    return null;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of body as unknown[]) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > PRODUCT_ID_MAX_LENGTH ||
      LINE_CONTROL.test(entry) ||
      LONE_SURROGATE.test(entry) ||
      seen.has(entry)
    ) {
      return null;
    }
    seen.add(entry);
    ids.push(entry);
  }
  return ids;
}

// ── rows and views ──────────────────────────────────────────────────────────

interface CollectionRow {
  collection_id: string;
  created_at: string;
  created_by: string | null;
  description: string | null;
  external_ref: string | null;
  featured: number;
  handle: string;
  image_object_id: string | null;
  published: number;
  rule_tag: string | null;
  sort_order: number | null;
  title: string;
  type: CollectionType;
  updated_at: string;
  updated_by: string | null;
}

const COLLECTION_COLUMNS = `collection.collection_id AS collection_id,
  collection.handle AS handle,
  collection.external_ref AS external_ref,
  collection.title AS title,
  collection.description AS description,
  collection.image_object_id AS image_object_id,
  collection.type AS type,
  collection.rule_tag AS rule_tag,
  collection.published AS published,
  collection.featured AS featured,
  collection.sort_order AS sort_order,
  collection.created_at AS created_at,
  collection.updated_at AS updated_at,
  collection.created_by AS created_by,
  collection.updated_by AS updated_by`;

export interface AdminCollectionSummary {
  collectionId: string;
  createdAt: string;
  externalRef: string | null;
  featured: boolean;
  handle: string;
  /** The cover while it is an active public product image of this shop, else null. */
  image: PublicImage | null;
  /** As stored, also when the object was removed since (D93). */
  imageObjectId: string | null;
  /** "/samling/<handle>", relative to the shop's root. */
  path: string;
  /** Member rows of a manual collection (any product status); 0 for a smart one. */
  productCount: number;
  published: boolean;
  ruleTag: string | null;
  sortOrder: number | null;
  title: string;
  type: CollectionType;
  updatedAt: string;
}

export interface AdminCollection extends AdminCollectionSummary {
  createdBy: string | null;
  description: string | null;
  /** The members in order (a manual collection's list; [] for a smart one). */
  productIds: string[];
  updatedBy: string | null;
}

function adminSummary(
  row: CollectionRow,
  productCount: number,
  images: ReadonlyMap<string, PublicImage>,
): AdminCollectionSummary {
  return {
    collectionId: row.collection_id,
    createdAt: row.created_at,
    externalRef: row.external_ref,
    featured: row.featured === 1,
    handle: row.handle,
    image: row.image_object_id === null ? null : (images.get(row.image_object_id) ?? null),
    imageObjectId: row.image_object_id,
    path: collectionPath(row.handle),
    productCount,
    published: row.published === 1,
    ruleTag: row.rule_tag,
    sortOrder: row.sort_order,
    title: row.title,
    type: row.type,
    updatedAt: row.updated_at,
  };
}

function coverImages(
  env: Env,
  db: D1Database,
  tenantId: string,
  rows: readonly CollectionRow[],
): Promise<Map<string, PublicImage>> {
  return resolvePublicImages(
    env,
    db,
    tenantId,
    rows.flatMap((row) => (row.image_object_id === null ? [] : [row.image_object_id])),
    ["product_media"],
  );
}

async function readCollectionRow(
  db: D1Database,
  tenantId: string,
  collectionId: string,
): Promise<CollectionRow | null> {
  return db
    .prepare(
      `SELECT ${COLLECTION_COLUMNS}
       FROM collections AS collection
       WHERE collection.tenant_id = ? AND collection.collection_id = ?
       LIMIT 1`,
    )
    .bind(tenantId, collectionId)
    .first<CollectionRow>();
}

export async function getAdminCollection(
  env: Env,
  db: D1Database,
  tenantId: string,
  collectionId: string,
): Promise<AdminCollection | null> {
  const row = await readCollectionRow(db, tenantId, collectionId);
  if (row === null) {
    return null;
  }
  const members = await db
    .prepare(
      `SELECT product_id FROM collection_products
       WHERE tenant_id = ? AND collection_id = ?
       ORDER BY position
       LIMIT ${MAX_COLLECTION_PRODUCTS}`,
    )
    .bind(tenantId, collectionId)
    .all<{ product_id: string }>();
  const productIds = members.results.map((member) => member.product_id);
  return {
    ...adminSummary(row, productIds.length, await coverImages(env, db, tenantId, [row])),
    createdBy: row.created_by,
    description: row.description,
    productIds,
    updatedBy: row.updated_by,
  };
}

// ── lists: the query and the keyset cursor ──────────────────────────────────

export interface CollectionListQuery {
  cursor: DisplayCursor | null;
  limit: number;
}

/** Each allowed key at most once, no other key. */
function strictParams(params: URLSearchParams, allowed: readonly string[]): boolean {
  const keys = [...params.keys()];
  return keys.every((key) => allowed.includes(key)) && new Set(keys).size === keys.length;
}

function parseLimit(raw: string | null, fallback: number): number | null {
  if (raw === null) {
    return fallback;
  }
  const limit = Number(raw);
  return /^\d{1,3}$/.test(raw) && limit >= 1 && limit <= LIST_LIMIT_MAX ? limit : null;
}

function parseListQuery(url: URL, fallbackLimit: number): CollectionListQuery | null {
  const params = url.searchParams;
  if (!strictParams(params, ["cursor", "limit"])) {
    return null;
  }
  const limit = parseLimit(params.get("limit"), fallbackLimit);
  const rawCursor = params.get("cursor");
  const cursor = rawCursor === null ? null : decodeDisplayCursor(rawCursor);
  return limit === null || (rawCursor !== null && cursor === null) ? null : { cursor, limit };
}

/** `GET /v1/admin/collections?cursor&limit` — null when malformed. */
export function parseAdminCollectionListQuery(url: URL): CollectionListQuery | null {
  return parseListQuery(url, ADMIN_COLLECTION_LIST_LIMIT);
}

/** `GET /v1/collections?cursor&limit` — null when malformed. */
export function parsePublicCollectionListQuery(url: URL): CollectionListQuery | null {
  return parseListQuery(url, PUBLIC_COLLECTION_LIST_LIMIT);
}

function listStatement(
  db: D1Database,
  tenantId: string,
  query: CollectionListQuery,
  options: { publishedOnly: boolean; withCount: boolean },
): D1PreparedStatement {
  const where = ["collection.tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (options.publishedOnly) {
    where.push("collection.published = 1");
  }
  if (query.cursor !== null) {
    const after = displayOrderAfter(query.cursor, ORDER_COLUMNS);
    where.push(after.sql);
    binds.push(...after.binds);
  }
  const count = options.withCount
    ? `, (SELECT COUNT(*) FROM collection_products AS member
          WHERE member.tenant_id = collection.tenant_id
            AND member.collection_id = collection.collection_id) AS product_count`
    : "";
  return db
    .prepare(
      `SELECT ${COLLECTION_COLUMNS}${count}
       FROM collections AS collection
       WHERE ${where.join(" AND ")}
       ORDER BY ${displayOrderBy(ORDER_COLUMNS)}
       LIMIT ?`,
    )
    .bind(...binds, query.limit + 1);
}

/** The last row of a full page as the cursor of the next one; null = no more. */
function nextCursorOf(rows: readonly CollectionRow[], limit: number): string | null {
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return last === undefined
    ? null
    : encodeDisplayCursor({ id: last.collection_id, name: last.title, sortOrder: last.sort_order });
}

/**
 * Every collection of the shop (published or not) in the display order —
 * sort order, NULL last, then title, then id (AdminCollections.jsx
 * compareCollections) — keyset on that order.
 */
export async function listAdminCollections(
  env: Env,
  db: D1Database,
  tenantId: string,
  query: CollectionListQuery,
): Promise<{ collections: AdminCollectionSummary[]; nextCursor: string | null }> {
  const result = await listStatement(db, tenantId, query, { publishedOnly: false, withCount: true }).all<
    CollectionRow & { product_count: number }
  >();
  const page = result.results.slice(0, query.limit);
  const images = await coverImages(env, db, tenantId, page);
  return {
    collections: page.map((row) => adminSummary(row, row.product_count, images)),
    nextCursor: nextCursorOf(result.results, query.limit),
  };
}

// ── admin writes ────────────────────────────────────────────────────────────

export type CollectionWriteResult =
  | { collection: AdminCollection; status: "ok" }
  | {
      status:
        | "conflict"
        | "external_ref_taken"
        | "handle_taken"
        | "image_not_referencable"
        | "invalid"
        | "not_found";
    };

export type CollectionProductsWriteResult =
  | { collection: AdminCollection; status: "ok" }
  | { status: "not_found" | "not_manual" | "product_not_found" };

type AuditAction =
  | "collections.create"
  | "collections.delete"
  | "collections.products"
  | "collections.update";

function auditStatement(
  db: D1Database,
  principal: TenantAdminPrincipal,
  action: AuditAction,
  collectionId: string,
  metadata: Record<string, unknown>,
  now: number,
): D1PreparedStatement {
  // Written only while the collection exists: after a create or an update the
  // row is there; before a delete it still is. A write that found no row
  // audits nothing.
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       )
       SELECT ?, ?, ?, ?, 'collection', ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM collections WHERE tenant_id = ? AND collection_id = ?)`,
    )
    .bind(
      crypto.randomUUID(),
      principal.tenantId,
      principal.userId,
      action,
      collectionId,
      crypto.randomUUID(),
      auditMetadataJson(principal, metadata),
      now,
      principal.tenantId,
      collectionId,
    );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The refusal a failed collection write stands for, when it is one the
 * checks before the write could not see (a concurrent write): the unique
 * constraints and 0041's triggers. null = not ours; rethrown.
 */
function writeRefusal(
  error: unknown,
): "conflict" | "external_ref_taken" | "handle_taken" | "image_not_referencable" | null {
  const message = errorMessage(error);
  if (
    /UNIQUE constraint failed: collections\.tenant_id, collections\.handle/.test(message) ||
    /the handle names another collection/.test(message)
  ) {
    return "handle_taken";
  }
  if (
    /UNIQUE constraint failed: collections\.tenant_id, collections\.external_ref/.test(message) ||
    /the external reference names another collection/.test(message)
  ) {
    return "external_ref_taken";
  }
  if (/collection image must be/.test(message)) {
    return "image_not_referencable";
  }
  if (
    /the collection id names another collection/.test(message) ||
    /UNIQUE constraint failed: collections\.collection_id/.test(message) ||
    /a smart collection holds no products/.test(message)
  ) {
    return "conflict";
  }
  return null;
}

/**
 * The shared namespace of `:ref` (0041): does a name about to be written —
 * the handle, the external reference, or a NEW collection's id — equal a
 * handle, an external reference or an id of ANOTHER collection of this shop?
 * Checked before the write for a clear answer; the triggers refuse the same
 * at the write. `selfId` is excluded: a collection's own names may coincide.
 */
async function refConflict(
  db: D1Database,
  tenantId: string,
  selfId: string,
  written: { externalRef: string | null; handle: string | null; newId: string | null },
): Promise<"conflict" | "external_ref_taken" | "handle_taken" | null> {
  const values = [written.handle, written.externalRef, written.newId];
  if (values.every((value) => value === null)) {
    return null;
  }
  const rows = await db
    .prepare(
      `SELECT handle, external_ref, collection_id FROM collections
       WHERE tenant_id = ?
         AND collection_id IS NOT ?
         AND (
           handle IN (?, ?, ?) OR external_ref IN (?, ?, ?) OR collection_id IN (?, ?, ?)
         )
       LIMIT 9`,
    )
    .bind(tenantId, selfId, ...values, ...values, ...values)
    .all<{ collection_id: string; external_ref: string | null; handle: string }>();
  const names = (value: string | null): boolean =>
    value !== null &&
    rows.results.some(
      (row) => row.handle === value || row.external_ref === value || row.collection_id === value,
    );
  if (names(written.handle)) {
    return "handle_taken";
  }
  if (names(written.externalRef)) {
    return "external_ref_taken";
  }
  return names(written.newId) ? "conflict" : null;
}

async function imageIsReferencable(
  env: Env,
  db: D1Database,
  tenantId: string,
  objectId: string | null | undefined,
): Promise<boolean> {
  return (
    objectId === undefined ||
    objectId === null ||
    (await getReferencablePublicImage(env, db, tenantId, objectId, ["product_media"])) !== null
  );
}

/**
 * The type and tag a write leaves: a smart collection must end with a tag, a
 * manual one with none (a tag named for a collection that stays or becomes
 * manual is refused; turning it manual clears the stored tag). null = refused.
 */
function resolveRule(
  input: CollectionFields,
  current: { rule_tag: string | null; type: CollectionType } | null,
): { ruleTag: string | null; type: CollectionType } | null {
  const type = input.type ?? current?.type ?? "manual";
  if (type === "manual") {
    return typeof input.ruleTag === "string" ? null : { ruleTag: null, type };
  }
  const ruleTag = input.ruleTag !== undefined ? input.ruleTag : (current?.rule_tag ?? null);
  return ruleTag === null ? null : { ruleTag, type };
}

/**
 * Creates a collection and its audit row in one batch. The handle is the one
 * named, else the title's address form (AdminCollectionEdit: `handle ||
 * slugify(title)`); the cover must be an active public product image of this
 * shop; a new collection is a draft unless `published` says otherwise.
 */
export async function createCollection(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: CollectionFields,
  now: number,
): Promise<CollectionWriteResult> {
  if (input.title === undefined) {
    return { status: "invalid" };
  }
  const handle = input.handle ?? slugify(input.title);
  const rule = resolveRule(input, null);
  if (!isCollectionHandle(handle) || rule === null) {
    return { status: "invalid" };
  }
  if (!(await imageIsReferencable(env, db, principal.tenantId, input.imageObjectId))) {
    return { status: "image_not_referencable" };
  }
  const collectionId = crypto.randomUUID();
  const taken = await refConflict(db, principal.tenantId, collectionId, {
    externalRef: input.externalRef ?? null,
    handle,
    newId: collectionId,
  });
  if (taken !== null) {
    return { status: taken };
  }

  const nowIso = iso(now);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO collections (
             collection_id, tenant_id, handle, external_ref, title, description,
             image_object_id, type, rule_tag, published, featured, sort_order,
             created_at, updated_at, created_by, updated_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          collectionId,
          principal.tenantId,
          handle,
          input.externalRef ?? null,
          input.title,
          input.description ?? null,
          input.imageObjectId ?? null,
          rule.type,
          rule.ruleTag,
          input.published === true ? 1 : 0,
          input.featured === true ? 1 : 0,
          input.sortOrder ?? null,
          nowIso,
          nowIso,
          principal.userId,
          principal.userId,
        ),
      auditStatement(
        db,
        principal,
        "collections.create",
        collectionId,
        { handle, published: input.published === true, type: rule.type },
        now,
      ),
    ]);
  } catch (error) {
    const refusal = writeRefusal(error);
    if (refusal !== null) {
      return { status: refusal };
    }
    throw error;
  }

  const collection = await getAdminCollection(env, db, principal.tenantId, collectionId);
  return collection === null ? { status: "not_found" } : { collection, status: "ok" };
}

/**
 * Replaces each field the input names, in one batch with its audit row. The
 * cover is checked (and written) only when it changes, so a form sent back
 * unchanged is not refused because its cover was removed since (D93). A
 * collection that ends smart loses its member rows in the same batch (the
 * source wrote `productIds: []` for a smart collection).
 */
export async function updateCollection(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  collectionId: string,
  input: CollectionFields,
  now: number,
): Promise<CollectionWriteResult> {
  const current = await readCollectionRow(db, principal.tenantId, collectionId);
  if (current === null) {
    return { status: "not_found" };
  }
  const rule = resolveRule(input, current);
  if (rule === null) {
    return { status: "invalid" };
  }
  const imageChanges = input.imageObjectId !== undefined && input.imageObjectId !== current.image_object_id;
  if (imageChanges && !(await imageIsReferencable(env, db, principal.tenantId, input.imageObjectId))) {
    return { status: "image_not_referencable" };
  }
  const taken = await refConflict(db, principal.tenantId, collectionId, {
    externalRef:
      input.externalRef !== undefined && input.externalRef !== current.external_ref ? input.externalRef : null,
    handle: input.handle !== undefined && input.handle !== current.handle ? input.handle : null,
    newId: null,
  });
  if (taken !== null) {
    return { status: taken };
  }

  // Column names come from this fixed list, never from the request.
  const sets: string[] = [];
  const binds: unknown[] = [];
  const fields: string[] = [];
  const set = (column: string, fieldName: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    binds.push(value);
    fields.push(fieldName);
  };
  if (input.title !== undefined) {
    set("title", "title", input.title);
  }
  if (input.handle !== undefined) {
    set("handle", "handle", input.handle);
  }
  if (input.externalRef !== undefined) {
    set("external_ref", "externalRef", input.externalRef);
  }
  if (input.description !== undefined) {
    set("description", "description", input.description);
  }
  if (imageChanges) {
    set("image_object_id", "imageObjectId", input.imageObjectId);
  }
  const ruleWritten =
    input.type !== undefined || input.ruleTag !== undefined || rule.ruleTag !== current.rule_tag;
  if (ruleWritten) {
    set("type", "type", rule.type);
    set("rule_tag", "ruleTag", rule.ruleTag);
  }
  if (input.published !== undefined) {
    set("published", "published", input.published ? 1 : 0);
  }
  if (input.featured !== undefined) {
    set("featured", "featured", input.featured ? 1 : 0);
  }
  if (input.sortOrder !== undefined) {
    set("sort_order", "sortOrder", input.sortOrder);
  }

  const statements: D1PreparedStatement[] = [];
  // Members are removed only by the change that makes the collection smart. A
  // change that writes no rule (a title) removes none: the row it read may be
  // older than another writer's change to a manual collection with members,
  // and a smart collection holds none to remove (0041).
  if (ruleWritten && rule.type === "smart") {
    statements.push(
      db
        .prepare("DELETE FROM collection_products WHERE tenant_id = ? AND collection_id = ?")
        .bind(principal.tenantId, collectionId),
    );
  }
  const updateIndex = statements.length;
  statements.push(
    db
      .prepare(
        `UPDATE collections
         SET ${[...sets, "updated_at = max(created_at, ?)", "updated_by = ?"].join(", ")}
         WHERE tenant_id = ? AND collection_id = ?`,
      )
      .bind(...binds, iso(now), principal.userId, principal.tenantId, collectionId),
    auditStatement(
      db,
      principal,
      "collections.update",
      collectionId,
      { fields, handle: input.handle ?? current.handle },
      now,
    ),
  );

  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    const refusal = writeRefusal(error);
    if (refusal !== null) {
      return { status: refusal };
    }
    throw error;
  }
  // D1 counts the catalog_version trigger's row too: compare with zero only.
  if ((results[updateIndex]?.meta.changes ?? 0) === 0) {
    return { status: "not_found" };
  }

  const collection = await getAdminCollection(env, db, principal.tenantId, collectionId);
  return collection === null ? { status: "not_found" } : { collection, status: "ok" };
}

/** Deletes a collection and its members; the audit row is written first, while it exists. */
export async function deleteCollection(
  db: D1Database,
  principal: TenantAdminPrincipal,
  collectionId: string,
  now: number,
): Promise<{ status: "not_found" | "ok" }> {
  const current = await readCollectionRow(db, principal.tenantId, collectionId);
  if (current === null) {
    return { status: "not_found" };
  }
  const results = await db.batch([
    auditStatement(
      db,
      principal,
      "collections.delete",
      collectionId,
      { handle: current.handle, published: current.published === 1, type: current.type },
      now,
    ),
    db
      .prepare("DELETE FROM collection_products WHERE tenant_id = ? AND collection_id = ?")
      .bind(principal.tenantId, collectionId),
    db
      .prepare("DELETE FROM collections WHERE tenant_id = ? AND collection_id = ?")
      .bind(principal.tenantId, collectionId),
  ]);
  return (results[2]?.meta.changes ?? 0) === 0 ? { status: "not_found" } : { status: "ok" };
}

/**
 * Replaces a MANUAL collection's members with `productIds`, in that order,
 * in one batch with its audit row. Every id must name a product of this shop
 * (any status: the public read decides what a visitor sees); 0041's trigger
 * refuses anything else, and nothing is written. A smart collection has no
 * members: `not_manual`.
 */
export async function setCollectionProducts(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  collectionId: string,
  productIds: readonly string[],
  now: number,
): Promise<CollectionProductsWriteResult> {
  const current = await readCollectionRow(db, principal.tenantId, collectionId);
  if (current === null) {
    return { status: "not_found" };
  }
  if (current.type !== "manual") {
    return { status: "not_manual" };
  }

  const statements: D1PreparedStatement[] = [
    db
      .prepare("DELETE FROM collection_products WHERE tenant_id = ? AND collection_id = ?")
      .bind(principal.tenantId, collectionId),
  ];
  if (productIds.length > 0) {
    // One statement for the whole list: json_each yields each id with its
    // index, which is its position.
    statements.push(
      db
        .prepare(
          `INSERT INTO collection_products (tenant_id, collection_id, product_id, position)
           SELECT ?, ?, list.value, list.key
           FROM json_each(?) AS list`,
        )
        .bind(principal.tenantId, collectionId, JSON.stringify(productIds)),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE collections SET updated_at = max(created_at, ?), updated_by = ?
         WHERE tenant_id = ? AND collection_id = ?`,
      )
      .bind(iso(now), principal.userId, principal.tenantId, collectionId),
    auditStatement(db, principal, "collections.products", collectionId, { count: productIds.length }, now),
  );

  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    const message = errorMessage(error);
    if (/member must be a product of the collection tenant/.test(message)) {
      return { status: "product_not_found" };
    }
    if (/a smart collection holds no products/.test(message)) {
      return { status: "not_manual" };
    }
    if (/member tenant_id must match collection tenant_id/.test(message)) {
      return { status: "not_found" };
    }
    throw error;
  }
  if ((results[statements.length - 2]?.meta.changes ?? 0) === 0) {
    return { status: "not_found" };
  }

  const collection = await getAdminCollection(env, db, principal.tenantId, collectionId);
  return collection === null ? { status: "not_found" } : { collection, status: "ok" };
}

// ── public reads ────────────────────────────────────────────────────────────

/** What a visitor, and a shop's own website (D87), may read of a collection. */
export interface PublicCollection {
  description: string | null;
  externalRef: string | null;
  featured: boolean;
  handle: string;
  /** The cover (a public product image), or null. */
  image: PublicImage | null;
  /** "/samling/<handle>", relative to the shop's root. */
  path: string;
  /** The admin's order (NULL last); the list is already in it, the home re-sorts by it. */
  sortOrder: number | null;
  title: string;
}

export interface PublicCollectionPage {
  collections: PublicCollection[];
  nextCursor: string | null;
}

export interface PublicCollectionDetail {
  collection: PublicCollection;
  nextCursor: string | null;
  products: PublicProductSummary[];
}

export interface VersionedValue<T> {
  catalogVersion: number;
  value: T;
}

function toPublic(row: CollectionRow, images: ReadonlyMap<string, PublicImage>): PublicCollection {
  return {
    description: row.description,
    externalRef: row.external_ref,
    featured: row.featured === 1,
    handle: row.handle,
    image: row.image_object_id === null ? null : (images.get(row.image_object_id) ?? null),
    path: collectionPath(row.handle),
    sortOrder: row.sort_order,
    title: row.title,
  };
}

/**
 * The PUBLISHED collections of an active, published shop, in the display
 * order, keyset on it; the shop's catalog_version read in the same batch
 * (one transaction), so the version labels the rows it was read with. null =
 * the shop is not public.
 */
export async function listPublicCollections(
  env: Env,
  db: D1Database,
  tenantId: string,
  query: CollectionListQuery,
): Promise<VersionedValue<PublicCollectionPage> | null> {
  const [tenantResult, listResult] = await db.batch<{ catalog_version: number } | CollectionRow>([
    publicShopStatement(db, tenantId),
    listStatement(db, tenantId, query, { publishedOnly: true, withCount: false }),
  ]);
  const tenant = tenantResult?.results[0] as { catalog_version: number } | undefined;
  if (tenant === undefined) {
    return null;
  }
  const rows = (listResult?.results ?? []) as CollectionRow[];
  const page = rows.slice(0, query.limit);
  const images = await coverImages(env, db, tenantId, page);
  return {
    catalogVersion: tenant.catalog_version,
    value: { collections: page.map((row) => toPublic(row, images)), nextCursor: nextCursorOf(rows, query.limit) },
  };
}

/**
 * The cursor of a collection's product pages. A manual collection pages by
 * member position (a decimal); a smart one by A's display cursor (base64url,
 * never a decimal). Which one a collection takes is its type's.
 */
export type CollectionProductCursor =
  | { kind: "display"; cursor: DisplayCursor }
  | { kind: "position"; position: number };

const POSITION_CURSOR = /^(?:0|[1-9]\d{0,2})$/;

export interface PublicCollectionQuery {
  cursor: CollectionProductCursor | null;
  limit: number;
}

/** `GET /v1/collections/:ref?cursor&limit` — null when malformed. */
export function parsePublicCollectionQuery(url: URL): PublicCollectionQuery | null {
  const params = url.searchParams;
  if (!strictParams(params, ["cursor", "limit"])) {
    return null;
  }
  const limit = parseLimit(params.get("limit"), PUBLIC_COLLECTION_PRODUCT_LIMIT);
  if (limit === null) {
    return null;
  }
  const raw = params.get("cursor");
  if (raw === null) {
    return { cursor: null, limit };
  }
  if (POSITION_CURSOR.test(raw) && Number(raw) < MAX_COLLECTION_PRODUCTS) {
    return { cursor: { kind: "position", position: Number(raw) }, limit };
  }
  const display = decodeDisplayCursor(raw);
  return display === null ? null : { cursor: { cursor: display, kind: "display" }, limit };
}

function publicCollectionByRefStatement(db: D1Database, tenantId: string, ref: string): D1PreparedStatement {
  // The handle, then the external reference, then the id. The namespace is
  // shared (0041), so at most one row can match; the order only makes the
  // choice deterministic should that rule ever be broken.
  return db
    .prepare(
      `SELECT ${COLLECTION_COLUMNS}
       FROM collections AS collection
       WHERE collection.tenant_id = ?
         AND collection.published = 1
         AND (collection.handle = ? OR collection.external_ref = ? OR collection.collection_id = ?)
       ORDER BY CASE
         WHEN collection.handle = ? THEN 0
         WHEN collection.external_ref = ? THEN 1
         ELSE 2
       END
       LIMIT 1`,
    )
    .bind(tenantId, ref, ref, ref, ref, ref);
}

/**
 * A manual collection's page: its member ids after `after` in position order
 * (at most 500, the table's cap), handed to A's `listPublicProductsByIds` in
 * chunks until `limit + 1` PUBLIC products are found or the members run out.
 * The first chunk is exactly `limit + 1` ids (every member public: one call,
 * nothing wasted); later chunks are A's maximum. The cursor is the position
 * of the last product answered, so a member that stops being public between
 * two pages is simply absent and nothing repeats.
 */
async function manualProductPage(
  env: Env,
  db: D1Database,
  tenant: TenantContext,
  collectionId: string,
  after: number | null,
  limit: number,
): Promise<{ nextCursor: string | null; products: PublicProductSummary[] }> {
  const members = await db
    .prepare(
      `SELECT product_id, position FROM collection_products
       WHERE tenant_id = ? AND collection_id = ? AND position > ?
       ORDER BY position
       LIMIT ${MAX_COLLECTION_PRODUCTS}`,
    )
    .bind(tenant.tenantId, collectionId, after ?? -1)
    .all<{ position: number; product_id: string }>();
  const positions = new Map(members.results.map((member) => [member.product_id, member.position]));

  const want = limit + 1;
  const found: PublicProductSummary[] = [];
  let offset = 0;
  let chunkSize = Math.min(want, MAX_PUBLIC_PRODUCTS_BY_IDS);
  while (found.length < want && offset < members.results.length) {
    const chunk = members.results.slice(offset, offset + chunkSize).map((member) => member.product_id);
    offset += chunk.length;
    found.push(...(await listPublicProductsByIds(env, db, tenant, chunk)));
    chunkSize = MAX_PUBLIC_PRODUCTS_BY_IDS;
  }

  const products = found.slice(0, limit);
  const last = products.at(-1);
  return {
    nextCursor:
      found.length > limit && last !== undefined ? String(positions.get(last.productId) ?? "") : null,
    products,
  };
}

export type PublicCollectionRead =
  | { status: "invalid_cursor" | "not_found" }
  | ({ status: "ok" } & VersionedValue<PublicCollectionDetail>);

/**
 * One PUBLISHED collection of an active, published shop by `ref` (handle,
 * external reference or id), with one page of its PUBLIC products. The
 * collection row and the shop's catalog_version are read in one batch. The
 * member and product reads follow outside that snapshot; every change to
 * them bumps the version (0040, 0041 triggers), so at worst the body is newer
 * than its label — one extra full answer, never a stale 304.
 */
export async function readPublicCollection(
  env: Env,
  db: D1Database,
  tenant: TenantContext,
  ref: string,
  query: PublicCollectionQuery,
): Promise<PublicCollectionRead> {
  if (ref.length === 0 || ref.length > COLLECTION_REF_MAX_LENGTH) {
    return { status: "not_found" };
  }
  const [tenantResult, collectionResult] = await db.batch<{ catalog_version: number } | CollectionRow>([
    publicShopStatement(db, tenant.tenantId),
    publicCollectionByRefStatement(db, tenant.tenantId, ref),
  ]);
  const shop = tenantResult?.results[0] as { catalog_version: number } | undefined;
  const row = collectionResult?.results[0] as CollectionRow | undefined;
  if (shop === undefined || row === undefined) {
    return { status: "not_found" };
  }

  let products: { nextCursor: string | null; products: PublicProductSummary[] };
  if (row.type === "manual") {
    if (query.cursor !== null && query.cursor.kind !== "position") {
      return { status: "invalid_cursor" };
    }
    products = await manualProductPage(
      env,
      db,
      tenant,
      row.collection_id,
      query.cursor?.position ?? null,
      query.limit,
    );
  } else {
    if (query.cursor !== null && query.cursor.kind !== "display") {
      return { status: "invalid_cursor" };
    }
    const tag = row.rule_tag === null ? "" : slugify(row.rule_tag);
    products =
      tag === ""
        ? { nextCursor: null, products: [] }
        : await listPublicProductPage(env, db, tenant, {
            cursor: query.cursor?.cursor ?? null,
            limit: query.limit,
            tag,
          });
  }

  return {
    catalogVersion: shop.catalog_version,
    status: "ok",
    value: {
      collection: toPublic(row, await coverImages(env, db, tenant.tenantId, [row])),
      nextCursor: products.nextCursor,
      products: products.products,
    },
  };
}
