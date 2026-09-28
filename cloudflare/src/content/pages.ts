import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import type { PublicImage } from "../storage/public-objects";
import { getReferencablePublicImage, resolvePublicImages } from "../storage/public-objects";
import type { HtmlRefusal } from "./html-refusal";
import { checkHtml } from "./html-refusal";

/**
 * CP4-C — content pages and posts (migrations/0042 `pages`; D84, D88, D94).
 *
 * Firebase source: the `pages` collection, written by AdminPageEdit.jsx
 * (title, slug, content, status, metaTitle, metaDescription, per language)
 * and read by DynamicPage.jsx, DynamicRouteHandler.jsx and ShopFooter.jsx. A
 * post (D88) is the same row with `kind = 'post'`: a date, an author, a
 * summary and an image. Attachments are not carried (D94). The legal pages
 * are not rows here (D79, src/routes/public-legal.ts).
 *
 * Every text is a map of language tag → string (D84). The content is HTML,
 * refused at write when it holds anything that can run or fetch
 * (html-refusal.ts); the storefront still cleans it when it renders it.
 *
 * Every read and write names the tenant. A public read answers only a
 * PUBLISHED page of an ACTIVE, PUBLISHED shop; a draft, or any page of an
 * unpublished or suspended shop, is absent.
 */

export const PAGE_KINDS = ["page", "post"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const PAGE_STATUSES = ["draft", "published"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

/**
 * First path segments the storefront owns (CP4_BRIEFS.md, "The address
 * grammar"), `legal` (the legal pages live at `<root>/legal/<…>`) and the four
 * legal keys. MUST equal the list in 0042's two `pages_reserved_slug_*`
 * triggers (test/pages.test.ts pins the two together).
 */
export const RESERVED_PAGE_SLUGS = [
  "_api",
  "angerratt",
  "angra",
  "assets",
  "cart",
  "checkout",
  "integritetspolicy",
  "kategori",
  "kopvillkor",
  "legal",
  "order-confirmation",
  "order-return",
  "plattformsvillkor",
  "product",
  "produkter",
  "rapportera-intrang",
  "samling",
  "tagg",
] as const;

/** One storefront path segment: lower-case ASCII letters, digits, inner hyphens. */
export const PAGE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
/** `sv`, `sv-SE`, `fil-PH`: the tags 0042's trigger admits. */
export const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
/** A new page gets a UUID; an imported one keeps its Firestore id. */
export const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_MS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([A-Za-z0-9_-]{1,128})$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Plain text on one line (titles, the author): no control character at all.
const LINE_CONTROL = /[\u0000-\u001f\u007f]/;
// Plain text that may break lines (summary, meta description).
const TEXT_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** Languages per text. One exists today (`sv-SE`). */
export const PAGE_LANGUAGES_MAX = 10;
/** 0042's CHECK on content_json, in UTF-8 bytes of the stored JSON. */
export const PAGE_CONTENT_MAX_BYTES = 262_144;
/**
 * The request-body cap. Larger than the content cap because a client may
 * escape what the stored JSON writes raw (`å` is 6 bytes, `å` is 2).
 */
export const PAGE_BODY_MAX_BYTES = 1_048_576;

interface TextRule {
  /** 0042's CHECK on the stored JSON, in bytes. */
  jsonMaxBytes: number;
  lineBreaks: boolean;
  maxLength: number;
}

const TEXT_RULES = {
  metaDescription: { jsonMaxBytes: 32_768, lineBreaks: true, maxLength: 1_000 },
  metaTitle: { jsonMaxBytes: 16_384, lineBreaks: false, maxLength: 300 },
  summary: { jsonMaxBytes: 65_536, lineBreaks: true, maxLength: 2_000 },
  title: { jsonMaxBytes: 16_384, lineBreaks: false, maxLength: 300 },
} as const satisfies Record<string, TextRule>;
const AUTHOR_MAX_LENGTH = 200;

export const ADMIN_PAGE_LIST_LIMIT = 50;
export const PUBLIC_PAGE_LIST_LIMIT = 20;
const PAGE_LIST_LIMIT_MAX = 100;

export type LanguageMap = Record<string, string>;

function iso(now: number): string {
  return new Date(now).toISOString();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** A map stored with its keys in sorted order, so equal maps store equal text. */
function mapJson(map: LanguageMap): string {
  const sorted: LanguageMap = {};
  for (const key of Object.keys(map).sort()) {
    sorted[key] = map[key] ?? "";
  }
  return JSON.stringify(sorted);
}

export function pagePath(slug: string): string {
  return `/${slug}`;
}

// ── parsing the admin's input ───────────────────────────────────────────────

export interface PageFields {
  author?: string | null;
  content?: LanguageMap;
  imageObjectId?: string | null;
  kind?: PageKind;
  metaDescription?: LanguageMap | null;
  metaTitle?: LanguageMap | null;
  publishedAt?: string | null;
  slug?: string;
  status?: PageStatus;
  summary?: LanguageMap | null;
  title?: LanguageMap;
}

export type ParsedPageInput =
  | { input: PageFields; status: "ok" }
  | { status: "invalid" }
  | { status: "reserved_slug" }
  | { language: string; reason: HtmlRefusal; status: "content_refused" }
  | { status: "too_large" };

type FieldResult<T> = { status: "ok"; value: T } | Exclude<ParsedPageInput, { status: "ok" }>;

const PAGE_FIELDS = [
  "author",
  "content",
  "imageObjectId",
  "kind",
  "metaDescription",
  "metaTitle",
  "publishedAt",
  "slug",
  "status",
  "summary",
  "title",
] as const;

function languageMapEntries(value: unknown): Array<[string, unknown]> | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const entries = Object.entries(value);
  return entries.length <= PAGE_LANGUAGES_MAX &&
    entries.every(([language]) => LANGUAGE_TAG_PATTERN.test(language))
    ? entries
    : null;
}

/**
 * A plain-text map (title, summary, meta title and description): each value
 * a string within its length, with no control character but a line break
 * where the rule allows one, and no lone surrogate. Empty values are dropped
 * from an optional map, and an optional map left empty is stored as NULL. A
 * title needs at least one language, and no title may be blank.
 */
function parseTextMap(
  value: unknown,
  rule: TextRule,
  required: boolean,
): FieldResult<LanguageMap | null> {
  if (value === null && !required) {
    return { status: "ok", value: null };
  }
  const entries = languageMapEntries(value);
  if (entries === null) {
    return { status: "invalid" };
  }
  const map: LanguageMap = {};
  for (const [language, text] of entries) {
    if (
      typeof text !== "string" ||
      text.length > rule.maxLength ||
      (rule.lineBreaks ? TEXT_CONTROL : LINE_CONTROL).test(text) ||
      LONE_SURROGATE.test(text)
    ) {
      return { status: "invalid" };
    }
    if (text.trim().length === 0) {
      if (required) {
        return { status: "invalid" };
      }
      continue;
    }
    map[language] = text;
  }
  if (Object.keys(map).length === 0) {
    return required ? { status: "invalid" } : { status: "ok", value: null };
  }
  return utf8Length(mapJson(map)) > rule.jsonMaxBytes
    ? { status: "too_large" }
    : { status: "ok", value: map };
}

/** The content: HTML per language, each admitted by the refusal as it is. */
function parseContent(value: unknown): FieldResult<LanguageMap> {
  const entries = languageMapEntries(value);
  if (entries === null || entries.length === 0) {
    return { status: "invalid" };
  }
  const map: LanguageMap = {};
  for (const [language, html] of entries) {
    if (typeof html !== "string") {
      return { status: "invalid" };
    }
    const verdict = checkHtml(html);
    if (!verdict.ok) {
      return verdict.reason === "too_large"
        ? { status: "too_large" }
        : { language, reason: verdict.reason, status: "content_refused" };
    }
    map[language] = html;
  }
  return utf8Length(mapJson(map)) > PAGE_CONTENT_MAX_BYTES
    ? { status: "too_large" }
    : { status: "ok", value: map };
}

function parseSlug(value: unknown): FieldResult<string> {
  if (typeof value !== "string" || !PAGE_SLUG_PATTERN.test(value)) {
    return { status: "invalid" };
  }
  return (RESERVED_PAGE_SLUGS as readonly string[]).includes(value)
    ? { status: "reserved_slug" }
    : { status: "ok", value };
}

function parseAuthor(value: unknown): FieldResult<string | null> {
  if (value === null) {
    return { status: "ok", value: null };
  }
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= AUTHOR_MAX_LENGTH &&
    !LINE_CONTROL.test(value) &&
    !LONE_SURROGATE.test(value)
    ? { status: "ok", value }
    : { status: "invalid" };
}

function parsePublishedAt(value: unknown): FieldResult<string | null> {
  if (value === null) {
    return { status: "ok", value: null };
  }
  return typeof value === "string" &&
    ISO_MS_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    iso(Date.parse(value)) === value
    ? { status: "ok", value }
    : { status: "invalid" };
}

function parseImageObjectId(value: unknown): FieldResult<string | null> {
  if (value === null) {
    return { status: "ok", value: null };
  }
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value)
    ? { status: "ok", value }
    : { status: "invalid" };
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): FieldResult<T> {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? { status: "ok", value: value as T }
    : { status: "invalid" };
}

/**
 * Strict body: only the page's own fields, each well-formed. `create`
 * requires slug, title and content; an update takes any non-empty subset.
 * Nullable: summary, metaTitle, metaDescription, author, imageObjectId,
 * publishedAt (null clears). The first problem found answers; the refusal of
 * the content names the language and the reason.
 */
export function parsePageInput(body: unknown, mode: "create" | "update"): ParsedPageInput {
  if (!isPlainRecord(body)) {
    return { status: "invalid" };
  }
  const keys = Object.keys(body);
  if (
    keys.length === 0 ||
    !keys.every((key) => (PAGE_FIELDS as readonly string[]).includes(key)) ||
    (mode === "create" && !["content", "slug", "title"].every((key) => keys.includes(key)))
  ) {
    return { status: "invalid" };
  }

  const input: PageFields = {};
  const steps: Array<() => ParsedPageInput | null> = [
    () => field(body.slug, parseSlug, (value) => (input.slug = value)),
    () => field(body.kind, (value) => parseEnum(value, PAGE_KINDS), (value) => (input.kind = value)),
    () => field(body.status, (value) => parseEnum(value, PAGE_STATUSES), (value) => (input.status = value)),
    () =>
      field(
        body.title,
        (value) => parseTextMap(value, TEXT_RULES.title, true),
        (value) => {
          if (value !== null) {
            input.title = value;
          }
        },
      ),
    () => field(body.summary, (value) => parseTextMap(value, TEXT_RULES.summary, false), (value) => (input.summary = value)),
    () =>
      field(body.metaTitle, (value) => parseTextMap(value, TEXT_RULES.metaTitle, false), (value) => (input.metaTitle = value)),
    () =>
      field(
        body.metaDescription,
        (value) => parseTextMap(value, TEXT_RULES.metaDescription, false),
        (value) => (input.metaDescription = value),
      ),
    () => field(body.author, parseAuthor, (value) => (input.author = value)),
    () => field(body.imageObjectId, parseImageObjectId, (value) => (input.imageObjectId = value)),
    () => field(body.publishedAt, parsePublishedAt, (value) => (input.publishedAt = value)),
    () => field(body.content, parseContent, (value) => (input.content = value)),
  ];
  for (const step of steps) {
    const problem = step();
    if (problem !== null) {
      return problem;
    }
  }

  // A published page carries its date: clearing it on a page that is (or is
  // being made) published is refused, not repaired.
  if (input.status === "published" && input.publishedAt === null) {
    return { status: "invalid" };
  }
  return { input, status: "ok" };
}

function field<T>(
  value: unknown,
  parse: (value: unknown) => FieldResult<T>,
  assign: (value: T) => void,
): ParsedPageInput | null {
  if (value === undefined) {
    return null;
  }
  const parsed = parse(value);
  if (parsed.status !== "ok") {
    return parsed;
  }
  assign(parsed.value);
  return null;
}

// ── rows and views ──────────────────────────────────────────────────────────

interface PageRow {
  author: string | null;
  content_json: string;
  created_at: string;
  created_by: string | null;
  image_object_id: string | null;
  kind: PageKind;
  meta_description_json: string | null;
  meta_title_json: string | null;
  page_id: string;
  published_at: string | null;
  slug: string;
  status: PageStatus;
  summary_json: string | null;
  title_json: string;
  updated_at: string;
  updated_by: string | null;
}

const PAGE_COLUMNS = `page_id, slug, kind, status, title_json, content_json, summary_json,
  meta_title_json, meta_description_json, author, image_object_id, published_at,
  created_at, updated_at, created_by, updated_by`;

/** A stored map read back; anything but a string value is left out. */
function readMap(json: string | null): LanguageMap | null {
  if (json === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(json);
  if (!isPlainRecord(parsed)) {
    return null;
  }
  const map: LanguageMap = {};
  for (const key of Object.keys(parsed).sort()) {
    const value = parsed[key];
    if (typeof value === "string") {
      map[key] = value;
    }
  }
  return map;
}

export interface AdminPageSummary {
  createdAt: string;
  kind: PageKind;
  pageId: string;
  path: string;
  publishedAt: string | null;
  slug: string;
  status: PageStatus;
  title: LanguageMap;
  updatedAt: string;
}

export interface AdminPageView extends AdminPageSummary {
  author: string | null;
  content: LanguageMap;
  createdBy: string | null;
  /** The named image when it is still an active public product image, else null. */
  image: PublicImage | null;
  /** As stored, also when the object was removed since (D93). */
  imageObjectId: string | null;
  metaDescription: LanguageMap | null;
  metaTitle: LanguageMap | null;
  summary: LanguageMap | null;
  updatedBy: string | null;
}

type SummaryRow = Pick<
  PageRow,
  "created_at" | "kind" | "page_id" | "published_at" | "slug" | "status" | "title_json" | "updated_at"
>;

function adminSummary(row: SummaryRow): AdminPageSummary {
  return {
    createdAt: row.created_at,
    kind: row.kind,
    pageId: row.page_id,
    path: pagePath(row.slug),
    publishedAt: row.published_at,
    slug: row.slug,
    status: row.status,
    title: readMap(row.title_json) ?? {},
    updatedAt: row.updated_at,
  };
}

async function readPageRow(db: D1Database, tenantId: string, pageId: string): Promise<PageRow | null> {
  return db
    .prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE tenant_id = ? AND page_id = ? LIMIT 1`)
    .bind(tenantId, pageId)
    .first<PageRow>();
}

export async function getAdminPage(
  env: Env,
  db: D1Database,
  tenantId: string,
  pageId: string,
): Promise<AdminPageView | null> {
  const row = await readPageRow(db, tenantId, pageId);
  if (row === null) {
    return null;
  }
  const images =
    row.image_object_id === null
      ? new Map<string, PublicImage>()
      : await resolvePublicImages(env, db, tenantId, [row.image_object_id], ["product_media"]);
  return {
    ...adminSummary(row),
    author: row.author,
    content: readMap(row.content_json) ?? {},
    createdBy: row.created_by,
    image: row.image_object_id === null ? null : (images.get(row.image_object_id) ?? null),
    imageObjectId: row.image_object_id,
    metaDescription: readMap(row.meta_description_json),
    metaTitle: readMap(row.meta_title_json),
    summary: readMap(row.summary_json),
    updatedBy: row.updated_by,
  };
}

// ── lists: the query and the keyset cursor ──────────────────────────────────

export interface PageListQuery {
  /** The last row of the previous page: its sort key and id. */
  cursor: { at: string; pageId: string } | null;
  kind: PageKind | null;
  limit: number;
}

export interface AdminPageListQuery extends PageListQuery {
  status: PageStatus | null;
}

function parseLimit(raw: string | null, fallback: number): number | null {
  if (raw === null) {
    return fallback;
  }
  const limit = Number(raw);
  return /^\d{1,3}$/.test(raw) && limit >= 1 && limit <= PAGE_LIST_LIMIT_MAX ? limit : null;
}

function parseCursor(raw: string | null): PageListQuery["cursor"] | "invalid" {
  if (raw === null) {
    return null;
  }
  const match = CURSOR_PATTERN.exec(raw);
  if (match === null || Number.isNaN(Date.parse(match[1] ?? ""))) {
    return "invalid";
  }
  return { at: match[1] as string, pageId: match[2] as string };
}

/** Each allowed key at most once, no other key. */
function strictParams(params: URLSearchParams, allowed: readonly string[]): boolean {
  const keys = [...params.keys()];
  return keys.every((key) => allowed.includes(key)) && new Set(keys).size === keys.length;
}

/** `GET /v1/admin/pages?kind&status&cursor&limit` — null when malformed. */
export function parseAdminPageListQuery(url: URL): AdminPageListQuery | null {
  const params = url.searchParams;
  if (!strictParams(params, ["cursor", "kind", "limit", "status"])) {
    return null;
  }
  const kind = params.get("kind");
  const status = params.get("status");
  const limit = parseLimit(params.get("limit"), ADMIN_PAGE_LIST_LIMIT);
  const cursor = parseCursor(params.get("cursor"));
  if (
    (kind !== null && !(PAGE_KINDS as readonly string[]).includes(kind)) ||
    (status !== null && !(PAGE_STATUSES as readonly string[]).includes(status)) ||
    limit === null ||
    cursor === "invalid"
  ) {
    return null;
  }
  return { cursor, kind: kind as PageKind | null, limit, status: status as PageStatus | null };
}

/** `GET /v1/pages?kind&lang&cursor&limit` — null when malformed. */
export function parsePublicPageListQuery(url: URL): (PageListQuery & { lang: string | null }) | null {
  const params = url.searchParams;
  if (!strictParams(params, ["cursor", "kind", "lang", "limit"])) {
    return null;
  }
  const kind = params.get("kind");
  const limit = parseLimit(params.get("limit"), PUBLIC_PAGE_LIST_LIMIT);
  const cursor = parseCursor(params.get("cursor"));
  if (
    (kind !== null && !(PAGE_KINDS as readonly string[]).includes(kind)) ||
    limit === null ||
    cursor === "invalid"
  ) {
    return null;
  }
  return { cursor, kind: kind as PageKind | null, lang: params.get("lang"), limit };
}

/** `GET /v1/pages/:slug?lang` — the requested language; null when malformed. */
export function parsePublicPageQuery(url: URL): { lang: string | null } | null {
  const params = url.searchParams;
  return strictParams(params, ["lang"]) ? { lang: params.get("lang") } : null;
}

/**
 * Newest first by creation, keyset on (created_at, page_id): an edit never
 * moves a page from one list page to another.
 */
export async function listAdminPages(
  db: D1Database,
  tenantId: string,
  query: AdminPageListQuery,
): Promise<{ nextCursor: string | null; pages: AdminPageSummary[] }> {
  const where = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (query.kind !== null) {
    where.push("kind = ?");
    binds.push(query.kind);
  }
  if (query.status !== null) {
    where.push("status = ?");
    binds.push(query.status);
  }
  if (query.cursor !== null) {
    where.push("(created_at, page_id) < (?, ?)");
    binds.push(query.cursor.at, query.cursor.pageId);
  }
  const rows = await db
    .prepare(
      `SELECT page_id, slug, kind, status, title_json, published_at, created_at, updated_at
       FROM pages
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, page_id DESC
       LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<SummaryRow>();

  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);
  return {
    nextCursor:
      rows.results.length > query.limit && last !== undefined ? `${last.created_at}~${last.page_id}` : null,
    pages: page.map(adminSummary),
  };
}

// ── admin writes ────────────────────────────────────────────────────────────

export type PageWriteResult =
  | { page: AdminPageView; status: "ok" }
  | { status: "image_not_referencable" | "invalid" | "not_found" | "slug_taken" };

function auditStatement(
  db: D1Database,
  principal: TenantAdminPrincipal,
  action: "pages.create" | "pages.delete" | "pages.update",
  pageId: string,
  metadata: Record<string, unknown>,
  now: number,
): D1PreparedStatement {
  // Written only while the page exists: after a create or an update the row
  // is there; before a delete it still is. A write that found no row audits
  // nothing.
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       )
       SELECT ?, ?, ?, ?, 'page', ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM pages WHERE tenant_id = ? AND page_id = ?)`,
    )
    .bind(
      crypto.randomUUID(),
      principal.tenantId,
      principal.userId,
      action,
      pageId,
      crypto.randomUUID(),
      auditMetadataJson(principal, metadata),
      now,
      principal.tenantId,
      pageId,
    );
}

function isConstraintFailure(error: unknown, pattern: RegExp): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return pattern.test(message);
}

const SLUG_TAKEN = /UNIQUE constraint failed: pages\.tenant_id, pages\.slug/;

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
 * Creates a page and its audit row in one batch. The image must be an active
 * public product image of this shop (`getReferencablePublicImage`); a
 * published page without a date is dated now.
 */
export async function createPage(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: PageFields,
  now: number,
): Promise<PageWriteResult> {
  if (input.slug === undefined || input.title === undefined || input.content === undefined) {
    return { status: "invalid" };
  }
  if (!(await imageIsReferencable(env, db, principal.tenantId, input.imageObjectId))) {
    return { status: "image_not_referencable" };
  }

  const status = input.status ?? "draft";
  const publishedAt = input.publishedAt ?? (status === "published" ? iso(now) : null);
  const pageId = crypto.randomUUID();
  const nowIso = iso(now);

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO pages (
             page_id, tenant_id, slug, kind, status, title_json, content_json, summary_json,
             meta_title_json, meta_description_json, author, image_object_id, published_at,
             created_at, updated_at, created_by, updated_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          pageId,
          principal.tenantId,
          input.slug,
          input.kind ?? "page",
          status,
          mapJson(input.title),
          mapJson(input.content),
          input.summary === undefined || input.summary === null ? null : mapJson(input.summary),
          input.metaTitle === undefined || input.metaTitle === null ? null : mapJson(input.metaTitle),
          input.metaDescription === undefined || input.metaDescription === null
            ? null
            : mapJson(input.metaDescription),
          input.author ?? null,
          input.imageObjectId ?? null,
          publishedAt,
          nowIso,
          nowIso,
          principal.userId,
          principal.userId,
        ),
      auditStatement(
        db,
        principal,
        "pages.create",
        pageId,
        { kind: input.kind ?? "page", slug: input.slug, status },
        now,
      ),
    ]);
  } catch (error) {
    if (isConstraintFailure(error, SLUG_TAKEN)) {
      return { status: "slug_taken" };
    }
    throw error;
  }

  const page = await getAdminPage(env, db, principal.tenantId, pageId);
  return page === null ? { status: "not_found" } : { page, status: "ok" };
}

/**
 * Replaces each field the input names, in one UPDATE with its audit row. The
 * first publish dates the page (`COALESCE`, so a concurrent publish keeps the
 * first date); going back to draft keeps the date. The image is checked only
 * when it changes: a form sent back unchanged is not refused because its
 * image was removed since (D93).
 */
export async function updatePage(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  pageId: string,
  input: PageFields,
  now: number,
): Promise<PageWriteResult> {
  const current = await readPageRow(db, principal.tenantId, pageId);
  if (current === null) {
    return { status: "not_found" };
  }
  if ((input.status ?? current.status) === "published" && input.publishedAt === null) {
    return { status: "invalid" };
  }
  if (
    input.imageObjectId !== current.image_object_id &&
    !(await imageIsReferencable(env, db, principal.tenantId, input.imageObjectId))
  ) {
    return { status: "image_not_referencable" };
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
  const optionalMap = (value: LanguageMap | null): string | null => (value === null ? null : mapJson(value));

  if (input.slug !== undefined) {
    set("slug", "slug", input.slug);
  }
  if (input.kind !== undefined) {
    set("kind", "kind", input.kind);
  }
  if (input.status !== undefined) {
    set("status", "status", input.status);
  }
  if (input.title !== undefined) {
    set("title_json", "title", mapJson(input.title));
  }
  if (input.content !== undefined) {
    set("content_json", "content", mapJson(input.content));
  }
  if (input.summary !== undefined) {
    set("summary_json", "summary", optionalMap(input.summary));
  }
  if (input.metaTitle !== undefined) {
    set("meta_title_json", "metaTitle", optionalMap(input.metaTitle));
  }
  if (input.metaDescription !== undefined) {
    set("meta_description_json", "metaDescription", optionalMap(input.metaDescription));
  }
  if (input.author !== undefined) {
    set("author", "author", input.author);
  }
  if (input.imageObjectId !== undefined) {
    set("image_object_id", "imageObjectId", input.imageObjectId);
  }
  if (input.publishedAt !== undefined) {
    set("published_at", "publishedAt", input.publishedAt);
  } else if (input.status === "published") {
    sets.push("published_at = COALESCE(published_at, ?)");
    binds.push(iso(now));
  }

  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `UPDATE pages
           SET ${sets.join(", ")}, updated_at = max(created_at, ?), updated_by = ?
           WHERE tenant_id = ? AND page_id = ?`,
        )
        .bind(...binds, iso(now), principal.userId, principal.tenantId, pageId),
      auditStatement(db, principal, "pages.update", pageId, { fields, slug: input.slug ?? current.slug }, now),
    ]);
  } catch (error) {
    if (isConstraintFailure(error, SLUG_TAKEN)) {
      return { status: "slug_taken" };
    }
    // Published meanwhile by another request, with the date cleared here.
    if (isConstraintFailure(error, /CHECK constraint failed/)) {
      return { status: "invalid" };
    }
    throw error;
  }
  // D1 counts the catalog_version trigger's row too: compare with zero only.
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return { status: "not_found" };
  }

  const page = await getAdminPage(env, db, principal.tenantId, pageId);
  return page === null ? { status: "not_found" } : { page, status: "ok" };
}

/** Deletes a page; the audit row is written first, while the page exists. */
export async function deletePage(
  db: D1Database,
  principal: TenantAdminPrincipal,
  pageId: string,
  now: number,
): Promise<{ status: "not_found" | "ok" }> {
  const current = await readPageRow(db, principal.tenantId, pageId);
  if (current === null) {
    return { status: "not_found" };
  }
  const results = await db.batch([
    auditStatement(
      db,
      principal,
      "pages.delete",
      pageId,
      { kind: current.kind, slug: current.slug, status: current.status },
      now,
    ),
    db.prepare("DELETE FROM pages WHERE tenant_id = ? AND page_id = ?").bind(principal.tenantId, pageId),
  ]);
  return (results[1]?.meta.changes ?? 0) === 0 ? { status: "not_found" } : { status: "ok" };
}

// ── public reads ────────────────────────────────────────────────────────────

/**
 * The text of a map in the first of `preferred` it holds (a blank value does
 * not count), else in its first language in sorted order: the page's own
 * text, never another row's. Null when the map holds no text at all.
 */
function pickText(map: LanguageMap | null, preferred: readonly string[]): { lang: string; text: string } | null {
  if (map === null) {
    return null;
  }
  for (const lang of [...preferred, ...Object.keys(map).sort()]) {
    const text = map[lang];
    if (typeof text === "string" && text.length > 0) {
      return { lang, text };
    }
  }
  return null;
}

/**
 * The requested language when it is a well-formed tag, then the shop's
 * default language (tenants.default_locale). An absent, malformed or unknown
 * request falls to the default, as the brief asks.
 */
function preferredLanguages(requested: string | null, defaultLocale: string): string[] {
  return requested !== null && LANGUAGE_TAG_PATTERN.test(requested)
    ? [requested, defaultLocale]
    : [defaultLocale];
}

export interface PublicPageSummary {
  author: string | null;
  image: PublicImage | null;
  kind: PageKind;
  path: string;
  publishedAt: string;
  slug: string;
  summary: string | null;
  title: string;
}

export interface PublicPageDetail extends PublicPageSummary {
  content: string;
  /** The language the content is answered in. */
  lang: string;
  metaDescription: string | null;
  metaTitle: string | null;
  updatedAt: string;
}

interface PublicTenantRow {
  catalog_version: number;
  default_locale: string;
}

/**
 * The shop, only while it is active AND published: the one gate of every
 * public read of a page (and of a legal page), with the version the ETag is
 * made from.
 */
export function publicTenantStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT catalog_version, default_locale
       FROM tenants
       WHERE tenant_id = ? AND status = 'active' AND published = 1
       LIMIT 1`,
    )
    .bind(tenantId);
}

type PublicRow = Pick<
  PageRow,
  "author" | "image_object_id" | "kind" | "published_at" | "slug" | "summary_json" | "title_json"
>;

function publicSummary(
  row: PublicRow,
  preferred: readonly string[],
  images: ReadonlyMap<string, PublicImage>,
): PublicPageSummary {
  return {
    author: row.author,
    image: row.image_object_id === null ? null : (images.get(row.image_object_id) ?? null),
    kind: row.kind,
    path: pagePath(row.slug),
    // Never null on a published row (0042's CHECK).
    publishedAt: row.published_at ?? "",
    slug: row.slug,
    summary: pickText(readMap(row.summary_json), preferred)?.text ?? null,
    title: pickText(readMap(row.title_json), preferred)?.text ?? "",
  };
}

/**
 * One PUBLISHED page of an active, published shop, by slug, with the shop's
 * catalog_version read in the same batch (one transaction). Null for
 * anything else: a draft, an unknown slug, another shop's slug, an
 * unpublished or suspended shop.
 */
export async function readPublicPage(
  env: Env,
  db: D1Database,
  tenantId: string,
  slug: string,
  requestedLang: string | null,
): Promise<{ catalogVersion: number; page: PublicPageDetail } | null> {
  if (!PAGE_SLUG_PATTERN.test(slug)) {
    return null;
  }
  const [tenantResult, pageResult] = await db.batch<PublicTenantRow | PageRow>([
    publicTenantStatement(db, tenantId),
    db
      .prepare(
        `SELECT ${PAGE_COLUMNS}
         FROM pages
         WHERE tenant_id = ? AND slug = ? AND status = 'published'
         LIMIT 1`,
      )
      .bind(tenantId, slug),
  ]);
  const tenant = tenantResult?.results[0] as PublicTenantRow | undefined;
  const row = pageResult?.results[0] as PageRow | undefined;
  if (tenant === undefined || row === undefined) {
    return null;
  }

  const preferred = preferredLanguages(requestedLang, tenant.default_locale);
  const images =
    row.image_object_id === null
      ? new Map<string, PublicImage>()
      : await resolvePublicImages(env, db, tenantId, [row.image_object_id], ["product_media"]);
  const content = pickText(readMap(row.content_json), preferred);
  return {
    catalogVersion: tenant.catalog_version,
    page: {
      ...publicSummary(row, preferred, images),
      content: content?.text ?? "",
      lang: content?.lang ?? preferred[0] ?? tenant.default_locale,
      metaDescription: pickText(readMap(row.meta_description_json), preferred)?.text ?? null,
      metaTitle: pickText(readMap(row.meta_title_json), preferred)?.text ?? null,
      updatedAt: row.updated_at,
    },
  };
}

/**
 * PUBLISHED pages of an active, published shop, newest first, keyset on
 * (published_at, page_id), at most `limit` per answer. `kind` narrows to
 * pages or posts. Null when the shop is not public.
 */
export async function listPublicPages(
  env: Env,
  db: D1Database,
  tenantId: string,
  query: PageListQuery & { lang: string | null },
): Promise<{ catalogVersion: number; nextCursor: string | null; pages: PublicPageSummary[] } | null> {
  const where = ["tenant_id = ?", "status = 'published'"];
  const binds: unknown[] = [tenantId];
  if (query.kind !== null) {
    where.push("kind = ?");
    binds.push(query.kind);
  }
  if (query.cursor !== null) {
    where.push("(published_at, page_id) < (?, ?)");
    binds.push(query.cursor.at, query.cursor.pageId);
  }
  const [tenantResult, pagesResult] = await db.batch<PublicTenantRow | (PublicRow & { page_id: string })>([
    publicTenantStatement(db, tenantId),
    db
      .prepare(
        `SELECT page_id, slug, kind, title_json, summary_json, author, image_object_id, published_at
         FROM pages
         WHERE ${where.join(" AND ")}
         ORDER BY published_at DESC, page_id DESC
         LIMIT ?`,
      )
      .bind(...binds, query.limit + 1),
  ]);
  const tenant = tenantResult?.results[0] as PublicTenantRow | undefined;
  if (tenant === undefined) {
    return null;
  }
  const rows = (pagesResult?.results ?? []) as Array<PublicRow & { page_id: string }>;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);

  const preferred = preferredLanguages(query.lang, tenant.default_locale);
  const images = await resolvePublicImages(
    env,
    db,
    tenantId,
    page.flatMap((row) => (row.image_object_id === null ? [] : [row.image_object_id])),
    ["product_media"],
  );
  return {
    catalogVersion: tenant.catalog_version,
    nextCursor:
      rows.length > query.limit && last !== undefined && last.published_at !== null
        ? `${last.published_at}~${last.page_id}`
        : null,
    pages: page.map((row) => publicSummary(row, preferred, images)),
  };
}
