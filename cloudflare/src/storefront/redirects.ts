import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import { encodePathSegment } from "./addresses";

/**
 * CP4-D — a shop's permanent forwards (D88, migrations/0043 `redirects`).
 *
 * A shop that moves from another shop system brings its search traffic with
 * it: every old address it had gets a 301 to its new one, answered by
 * `GET /v1/seo` before the storefront application runs. Written by the
 * importer and by `PUT /v1/admin/redirects`; the admin page is CP5.
 *
 * THE PATH NORMAL FORM is made by ONE function, `normalizeStorefrontPath`, at
 * write (both paths of a forward) and at lookup (the path a visitor asked
 * for), so a forward can never be written in a form the lookup does not make.
 */

/** Longest path accepted, before and after normalisation. */
export const STOREFRONT_PATH_MAX_LENGTH = 2_048;
/** Forwards per PUT or DELETE, and the page size cap of the admin list. */
export const REDIRECTS_PER_CALL_MAX = 500;
export const REDIRECTS_PAGE_DEFAULT = 100;

// C0 and C1 controls: never part of an address anyone can type or follow.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A path relative to the shop's root, in the ONE normal form, or null.
 *
 *   - the query (`?…`) and the fragment (`#…`) are dropped;
 *   - it must start with `/`; trailing slashes are dropped (the root stays `/`);
 *   - each segment is percent-decoded to UTF-8 (a malformed escape or invalid
 *     UTF-8 refuses) and put in Unicode NFC, so `%C3%A5`, `å` and `a` + U+030A
 *     are one path, and old addresses holding encoded emoji match;
 *   - refused: an empty segment (`//`), a `.` or `..` segment (also when it was
 *     written `%2e`), a segment that DECODES to hold `/` or `\`, a backslash
 *     anywhere, a control character, and anything longer than 2 048;
 *   - letter case is kept as given.
 */
export function normalizeStorefrontPath(raw: string): string | null {
  if (raw.length === 0 || raw.length > STOREFRONT_PATH_MAX_LENGTH) {
    return null;
  }

  let path = raw;
  const cut = path.search(/[?#]/);
  if (cut !== -1) {
    path = path.slice(0, cut);
  }
  if (!path.startsWith("/") || path.includes("\\")) {
    return null;
  }

  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return "/";
  }

  const segments: string[] = [];
  for (const encoded of trimmed.slice(1).split("/")) {
    if (encoded.length === 0) {
      return null;
    }
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    segment = segment.normalize("NFC");
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      CONTROL_CHARACTER.test(segment)
    ) {
      return null;
    }
    segments.push(segment);
  }

  const normal = `/${segments.join("/")}`;
  return normal.length > STOREFRONT_PATH_MAX_LENGTH ? null : normal;
}

/**
 * A normal-form path written as an address path: each segment encoded by the
 * segment rule of the address grammar (addresses.ts).
 */
export function encodeStorefrontPath(normal: string): string {
  if (normal === "/") {
    return "/";
  }
  return `/${normal.slice(1).split("/").map(encodePathSegment).join("/")}`;
}

/**
 * First segments a forward may not start FROM: the storefront's own pages a
 * purchase goes through, the API and asset prefixes, and the files the web
 * Worker answers itself. A forward there would take the page away from every
 * visitor who navigates to it (GET /v1/seo answers the forward first).
 */
const UNFORWARDABLE_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  "_api",
  "angra",
  "assets",
  "cart",
  "checkout",
  "images",
  "order-confirmation",
  "order-return",
  "rapportera-intrang",
  "robots.txt",
  "sitemap.xml",
]);

export type RedirectPathCheck =
  | { ok: true; path: string }
  | { ok: false; reason: "invalid_path" | "reserved_path" };

/** A from_path as written: the normal form, never the root or a reserved page. */
export function parseRedirectFromPath(value: unknown): RedirectPathCheck {
  if (typeof value !== "string") {
    return { ok: false, reason: "invalid_path" };
  }
  const path = normalizeStorefrontPath(value);
  if (path === null) {
    return { ok: false, reason: "invalid_path" };
  }
  const first = path.slice(1).split("/")[0] ?? "";
  if (path === "/" || UNFORWARDABLE_FIRST_SEGMENTS.has(first.toLowerCase())) {
    return { ok: false, reason: "reserved_path" };
  }
  return { ok: true, path };
}

/**
 * A to_path as written: a path of the shop's own storefront, in the normal
 * form. It must START with `/` before anything is dropped, so neither a scheme
 * (`javascript:…`, `https:…`) nor a host (`//host`, `/\host`) can pass; the
 * normal form then refuses `//`, backslashes and dot segments, encoded or not.
 * No query and no fragment: they are refused rather than silently dropped.
 */
export function parseRedirectToPath(value: unknown): RedirectPathCheck {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return { ok: false, reason: "invalid_path" };
  }
  const path = normalizeStorefrontPath(value);
  return path === null ? { ok: false, reason: "invalid_path" } : { ok: true, path };
}

// ── store ───────────────────────────────────────────────────────────────────

export interface RedirectView {
  createdAt: string;
  createdBy: string;
  fromPath: string;
  toPath: string;
}

interface RedirectRow {
  created_at: string;
  created_by: string;
  from_path: string;
  to_path: string;
}

function toView(row: RedirectRow): RedirectView {
  return {
    createdAt: row.created_at,
    createdBy: row.created_by,
    fromPath: row.from_path,
    toPath: row.to_path,
  };
}

/**
 * The forward for a normal-form path, or null. The address is ENCODED for the
 * answer: the stored form is decoded (it may hold spaces or emoji), and the
 * web Worker takes only a plain path.
 */
export async function findRedirect(
  db: D1Database,
  tenantId: string,
  normalPath: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT to_path FROM redirects
       WHERE tenant_id = ? AND from_path = ?
       LIMIT 1`,
    )
    .bind(tenantId, normalPath)
    .first<{ to_path: string }>();
  return row === null ? null : encodeStorefrontPath(row.to_path);
}

/** The admin list cursor: the last from_path, base64url of its UTF-8. */
export function encodeRedirectCursor(fromPath: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(fromPath)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeRedirectCursor(cursor: string): string | null {
  if (cursor.length === 0 || cursor.length > 3_000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    return null;
  }
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const fromPath = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // A cursor is a STORED path, already in the normal form: it is not
    // normalised again (a stored `%`, `?` or `#` is a character of the path,
    // not URL syntax). It only has to look like one.
    return fromPath.startsWith("/") &&
      fromPath.length <= STOREFRONT_PATH_MAX_LENGTH &&
      !CONTROL_CHARACTER.test(fromPath)
      ? fromPath
      : null;
  } catch {
    return null;
  }
}

/** One page of the shop's forwards, ordered by from_path (keyset). */
export async function listRedirects(
  db: D1Database,
  tenantId: string,
  after: string | null,
  limit: number,
): Promise<{ nextCursor: string | null; redirects: RedirectView[] }> {
  const rows = await db
    .prepare(
      `SELECT from_path, to_path, created_at, created_by
       FROM redirects
       WHERE tenant_id = ? AND (? IS NULL OR from_path > ?)
       ORDER BY from_path ASC
       LIMIT ?`,
    )
    .bind(tenantId, after, after, limit + 1)
    .all<RedirectRow>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    nextCursor:
      rows.results.length > limit && last !== undefined ? encodeRedirectCursor(last.from_path) : null,
    redirects: page.map(toView),
  };
}

export interface RedirectInput {
  fromPath: string;
  toPath: string;
}

export type ParsedRedirects =
  | { entries: RedirectInput[]; status: "ok" }
  | { status: "invalid" }
  | { problems: RedirectProblem[]; status: "refused" };

export interface RedirectProblem {
  /** The index of the entry in the request. */
  index: number;
  reason: "chain" | "duplicate" | "invalid_path" | "reserved_path" | "same_path";
}

/**
 * PUT /v1/admin/redirects body: `{ redirects: [{ fromPath, toPath }] }`,
 * 1–500 entries, no other key. Each path is normalised; the batch must not
 * name one from_path twice, and no entry's target may be another entry's
 * from_path (a chain inside the batch). Problems are named per entry.
 */
export function parseRedirectsPut(body: unknown): ParsedRedirects {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: "invalid" };
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.redirects)) {
    return { status: "invalid" };
  }
  const list: unknown[] = record.redirects;
  if (list.length === 0 || list.length > REDIRECTS_PER_CALL_MAX) {
    return { status: "invalid" };
  }

  const problems: RedirectProblem[] = [];
  const entries: RedirectInput[] = [];
  list.forEach((raw, index) => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => key !== "fromPath" && key !== "toPath")
    ) {
      problems.push({ index, reason: "invalid_path" });
      return;
    }
    const entry = raw as Record<string, unknown>;
    const from = parseRedirectFromPath(entry.fromPath);
    const to = parseRedirectToPath(entry.toPath);
    if (!from.ok) {
      problems.push({ index, reason: from.reason });
      return;
    }
    if (!to.ok) {
      problems.push({ index, reason: to.reason });
      return;
    }
    if (from.path === to.path) {
      problems.push({ index, reason: "same_path" });
      return;
    }
    entries.push({ fromPath: from.path, toPath: to.path });
  });

  if (problems.length === 0) {
    const froms = new Map<string, number>();
    entries.forEach((entry, index) => {
      if (froms.has(entry.fromPath)) {
        problems.push({ index, reason: "duplicate" });
      }
      froms.set(entry.fromPath, index);
    });
    entries.forEach((entry, index) => {
      if (froms.has(entry.toPath)) {
        problems.push({ index, reason: "chain" });
      }
    });
  }

  return problems.length > 0 ? { problems, status: "refused" } : { entries, status: "ok" };
}

/** DELETE /v1/admin/redirects body: `{ fromPaths: [...] }`, 1–500, normalised. */
export function parseRedirectsDelete(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.fromPaths)) {
    return null;
  }
  const list: unknown[] = record.fromPaths;
  if (list.length === 0 || list.length > REDIRECTS_PER_CALL_MAX) {
    return null;
  }
  const paths = new Set<string>();
  for (const raw of list) {
    const path = typeof raw === "string" ? normalizeStorefrontPath(raw) : null;
    if (path === null) {
      return null;
    }
    paths.add(path);
  }
  return [...paths];
}

const IN_CHUNK = 90;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += IN_CHUNK) {
    out.push(values.slice(start, start + IN_CHUNK));
  }
  return out;
}

export type PutRedirectsResult =
  | { redirects: RedirectView[]; status: "ok" }
  | { problems: RedirectProblem[]; status: "refused" }
  | { status: "conflict" };

/**
 * Writes the entries (an entry whose from_path exists gets the new target),
 * audited, in ONE batch. Refused against what is stored, stricter than the
 * final state would need so that no order of the batch's statements can meet
 * a trigger: an entry's target may not be a stored from_path, and an entry's
 * from_path may not be a stored target. A write that races in between fails
 * the whole batch on the 0043 triggers and answers `conflict`, writing nothing.
 */
export async function putRedirects(
  db: D1Database,
  principal: TenantAdminPrincipal,
  entries: readonly RedirectInput[],
  now: number,
): Promise<PutRedirectsResult> {
  const tenantId = principal.tenantId;
  const targets = [...new Set(entries.map((entry) => entry.toPath))];
  const froms = [...new Set(entries.map((entry) => entry.fromPath))];

  const lookups: D1PreparedStatement[] = [
    ...chunks(targets).map((chunk) =>
      db
        .prepare(
          `SELECT from_path AS path FROM redirects
           WHERE tenant_id = ? AND from_path IN (${placeholders(chunk.length)})
           LIMIT ${IN_CHUNK}`,
        )
        .bind(tenantId, ...chunk),
    ),
    ...chunks(froms).map((chunk) =>
      db
        .prepare(
          `SELECT DISTINCT to_path AS path FROM redirects
           WHERE tenant_id = ? AND to_path IN (${placeholders(chunk.length)})
           LIMIT ${IN_CHUNK}`,
        )
        .bind(tenantId, ...chunk),
    ),
  ];
  const results = await db.batch<{ path: string }>(lookups);
  const targetChunks = chunks(targets).length;
  const storedFroms = new Set<string>();
  const storedTargets = new Set<string>();
  results.forEach((result, index) => {
    for (const row of result.results) {
      (index < targetChunks ? storedFroms : storedTargets).add(row.path);
    }
  });

  const problems: RedirectProblem[] = [];
  entries.forEach((entry, index) => {
    if (storedFroms.has(entry.toPath) || storedTargets.has(entry.fromPath)) {
      problems.push({ index, reason: "chain" });
    }
  });
  if (problems.length > 0) {
    return { problems, status: "refused" };
  }

  const nowIso = new Date(now).toISOString();
  const statements: D1PreparedStatement[] = entries.map((entry) =>
    db
      .prepare(
        `INSERT INTO redirects (tenant_id, from_path, to_path, created_at, created_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, from_path) DO UPDATE SET
           to_path = excluded.to_path,
           created_at = excluded.created_at,
           created_by = excluded.created_by`,
      )
      .bind(tenantId, entry.fromPath, entry.toPath, nowIso, principal.userId),
  );
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, ?, ?, 'storefront.redirects_put', 'redirects', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        tenantId,
        principal.userId,
        tenantId,
        crypto.randomUUID(),
        auditMetadataJson(principal, { count: entries.length }),
        now,
      ),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes("a forward must not chain")) {
      return { status: "conflict" };
    }
    throw error;
  }

  const written: RedirectView[] = entries.map((entry) => ({
    createdAt: nowIso,
    createdBy: principal.userId,
    fromPath: entry.fromPath,
    toPath: entry.toPath,
  }));
  return { redirects: written, status: "ok" };
}

/** Removes the named forwards (unknown paths are no-ops), audited, one batch. */
export async function deleteRedirects(
  db: D1Database,
  principal: TenantAdminPrincipal,
  fromPaths: readonly string[],
  now: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = chunks(fromPaths).map((chunk) =>
    db
      .prepare(
        `DELETE FROM redirects
         WHERE tenant_id = ? AND from_path IN (${placeholders(chunk.length)})`,
      )
      .bind(principal.tenantId, ...chunk),
  );
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, ?, ?, 'storefront.redirects_delete', 'redirects', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.tenantId,
        principal.userId,
        principal.tenantId,
        crypto.randomUUID(),
        auditMetadataJson(principal, { count: fromPaths.length }),
        now,
      ),
  );
  await db.batch(statements);
}
