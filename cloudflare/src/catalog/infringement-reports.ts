import type { PlatformPrincipal } from "../auth/live-authorization";
import type { TenantContext } from "../tenancy/resolve-tenant";
import type { PlatformScreeningView } from "./screening";
import { decideByPlatform } from "./screening";

/**
 * Infringement reports — notice & takedown (CP3-D, SnapWear A10, DECISIONS
 * D58), migration 0036.
 *
 * Ported from functions/src/infringement/submitInfringementReport.ts (intake),
 * takedownProduct.ts (takedown with a report) and
 * src/pages/platform/PlatformReports.jsx (reviewing / rejected / reopen).
 *
 *   submitReport            POST /v1/reports (storefront, tenant = hostname)
 *   listReports, getReport  the platform queue
 *   handleReport            reviewing | rejected
 *   takedownReportedProduct the one takedown (decideByPlatform) + the report,
 *                           in ONE batch
 *
 * PERSONAL DATA: the reporter's name, organisation and email live in the
 * report row and in the platform views below — nowhere else. The arrival alert
 * names the report, the shop and the product by id; audit rows carry ids and
 * the platform's own note; nothing is logged. The reporter's IP is the intake
 * rate-limit key only (src/routes/storefront-reports.ts) and is never stored.
 */

export const RIGHT_TYPES = ["trademark", "copyright", "other"] as const;
export type RightType = (typeof RIGHT_TYPES)[number];
export type ReportStatus = "new" | "rejected" | "reviewing" | "taken_down";
export const REPORT_STATUSES: readonly ReportStatus[] = ["new", "reviewing", "rejected", "taken_down"];

/** The alert kind (0017 `alerts`) a new report raises for the digest. */
export const REPORT_ALERT_KIND = "infringement_report_received";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_NOTE_LENGTH = 2_000;

export function isReportId(value: string): boolean {
  return REPORT_ID_PATTERN.test(value);
}

// ── intake ──────────────────────────────────────────────────────────────────

export interface ReportSubmission {
  attestation: true;
  description: string;
  productId: string;
  productUrl: string | null;
  reporterEmail: string;
  reporterName: string;
  reporterOrg: string | null;
  rightType: RightType;
}

const SUBMISSION_KEYS = [
  "attestation",
  "description",
  "productId",
  "productUrl",
  "reporterEmail",
  "reporterName",
  "reporterOrg",
  "rightType",
  "website",
];

/** Trimmed single-line text in [min, max], or null. */
function line(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string" || SINGLE_LINE_CONTROL.test(value)) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

/**
 * The storefront form's body, or null. Null covers EVERY refusal — a malformed
 * field, an unknown key, a missing attestation AND a filled honeypot
 * (`website`, visually hidden in the form: any value = a bot) — so the route
 * answers them all with the same 400 and a caller cannot tell which it was.
 *
 * Firebase clipped over-long fields silently; this refuses them (the columns
 * carry CHECKs, and a truncated legal notice is worse than a visible error).
 * Firebase's rules otherwise: name required, a valid email, a known right
 * type, a description of at least 20 characters, attestation === true.
 */
export function parseReportSubmission(body: unknown): ReportSubmission | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => SUBMISSION_KEYS.includes(key))) {
    return null;
  }
  // The honeypot: absent or empty. Anything else is refused exactly like a
  // malformed body (no write, no alert).
  if (record.website !== undefined && record.website !== "") {
    return null;
  }
  if (record.attestation !== true) {
    return null;
  }

  const productId = typeof record.productId === "string" ? record.productId : "";
  const reporterName = line(record.reporterName, 1, 200);
  const reporterOrg =
    record.reporterOrg === undefined || record.reporterOrg === null || record.reporterOrg === ""
      ? null
      : line(record.reporterOrg, 1, 200);
  const reporterEmail = line(record.reporterEmail, 3, 320);
  const productUrl =
    record.productUrl === undefined || record.productUrl === null || record.productUrl === ""
      ? null
      : line(record.productUrl, 1, 1_000);
  const description =
    typeof record.description === "string" && !CONTROL.test(record.description)
      ? record.description.trim()
      : "";
  const rightType = (RIGHT_TYPES as readonly unknown[]).includes(record.rightType)
    ? (record.rightType as RightType)
    : null;

  if (
    !PRODUCT_ID_PATTERN.test(productId) ||
    reporterName === null ||
    (record.reporterOrg !== undefined &&
      record.reporterOrg !== null &&
      record.reporterOrg !== "" &&
      reporterOrg === null) ||
    reporterEmail === null ||
    !EMAIL_PATTERN.test(reporterEmail) ||
    (record.productUrl !== undefined &&
      record.productUrl !== null &&
      record.productUrl !== "" &&
      productUrl === null) ||
    description.length < 20 ||
    description.length > 5_000 ||
    rightType === null
  ) {
    return null;
  }

  return {
    attestation: true,
    description,
    productId,
    productUrl,
    reporterEmail,
    reporterName,
    reporterOrg,
    rightType,
  };
}

export type SubmitReportResult = { reportId: string; status: "ok" } | { status: "not_accepted" };

/**
 * Stores one report against a product of THIS storefront's shop, and raises
 * the platform alert, in one batch. A product id that is unknown, or that
 * belongs to another shop, is `not_accepted` — the same answer as a malformed
 * body — after the same single indexed read in both cases.
 *
 * Firebase stored an unresolvable report with `productId: null` for a human to
 * sort out; here a report always names its product (0036), which the CP6 page
 * guarantees by linking the form from the product page.
 */
export async function submitReport(
  db: D1Database,
  tenant: TenantContext,
  input: ReportSubmission,
  now: number,
): Promise<SubmitReportResult> {
  const product = await db
    .prepare("SELECT product_id, name FROM products WHERE tenant_id = ? AND product_id = ? LIMIT 1")
    .bind(tenant.tenantId, input.productId)
    .first<{ name: string; product_id: string }>();
  if (product === null) {
    return { status: "not_accepted" };
  }

  const reportId = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  const productName = product.name.trim().slice(0, 500);
  await db.batch([
    db
      .prepare(
        `INSERT INTO infringement_reports (
           report_id, tenant_id, product_id, product_name, product_url,
           reporter_name, reporter_org, reporter_email, right_type, description,
           attestation, status, source, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'new', 'storefront', ?)`,
      )
      .bind(
        reportId,
        tenant.tenantId,
        product.product_id,
        productName === "" ? null : productName,
        input.productUrl,
        input.reporterName,
        input.reporterOrg,
        input.reporterEmail,
        input.rightType,
        input.description,
        iso,
      ),
    // The alert digest (D40) is the platform's notification; ids only.
    db
      .prepare(
        `INSERT INTO alerts (
           id, tenant_id, kind, severity, message, resource_type, resource_id, created_at
         ) VALUES (?, ?, ?, 'warning', ?, 'infringement_report', ?, ?)`,
      )
      .bind(
        `${REPORT_ALERT_KIND}:${crypto.randomUUID()}`,
        tenant.tenantId,
        REPORT_ALERT_KIND,
        `infringement report ${reportId} for shop ${tenant.tenantId} (product ${product.product_id}) awaits review`,
        reportId,
        iso,
      ),
  ]);
  return { reportId, status: "ok" };
}

// ── the platform views ──────────────────────────────────────────────────────

export interface PlatformReportView {
  attestation: boolean;
  createdAt: string;
  description: string;
  handledAt: string | null;
  handledBy: string | null;
  handledByLegacyUid: string | null;
  note: string | null;
  productId: string;
  productName: string | null;
  /** The product's CURRENT takedown state (it may have been taken down or reinstated since). */
  productTakenDown: boolean;
  productUrl: string | null;
  reportId: string;
  reporterEmail: string;
  reporterName: string;
  reporterOrg: string | null;
  rightType: string;
  source: string;
  status: ReportStatus;
  tenantId: string;
  version: number;
}

interface ReportRow {
  attestation: number;
  created_at: string;
  description: string;
  handled_at: string | null;
  handled_by: string | null;
  handled_by_legacy_uid: string | null;
  note: string | null;
  product_id: string;
  product_name: string | null;
  product_url: string | null;
  report_id: string;
  reporter_email: string;
  reporter_name: string;
  reporter_org: string | null;
  right_type: string;
  source: string;
  status: ReportStatus;
  taken_down: number;
  tenant_id: string;
  version: number;
}

const REPORT_SELECT = `SELECT r.report_id, r.tenant_id, r.product_id, r.product_name, r.product_url,
     r.reporter_name, r.reporter_org, r.reporter_email, r.right_type, r.description,
     r.attestation, r.status, r.source, r.note, r.handled_by, r.handled_by_legacy_uid,
     r.version, r.created_at, r.handled_at,
     (p.takedown_at IS NOT NULL) AS taken_down
   FROM infringement_reports AS r
   LEFT JOIN products AS p ON p.product_id = r.product_id`;

function reportView(row: ReportRow): PlatformReportView {
  return {
    attestation: row.attestation === 1,
    createdAt: row.created_at,
    description: row.description,
    handledAt: row.handled_at,
    handledBy: row.handled_by,
    handledByLegacyUid: row.handled_by_legacy_uid,
    note: row.note,
    productId: row.product_id,
    productName: row.product_name,
    productTakenDown: row.taken_down === 1,
    productUrl: row.product_url,
    reportId: row.report_id,
    reporterEmail: row.reporter_email,
    reporterName: row.reporter_name,
    reporterOrg: row.reporter_org,
    rightType: row.right_type,
    source: row.source,
    status: row.status,
    tenantId: row.tenant_id,
    version: row.version,
  };
}

export async function getReport(db: D1Database, reportId: string): Promise<PlatformReportView | null> {
  const row = await db
    .prepare(`${REPORT_SELECT} WHERE r.report_id = ? LIMIT 1`)
    .bind(reportId)
    .first<ReportRow>();
  return row === null ? null : reportView(row);
}

export interface ReportListQuery {
  cursor: { createdAt: string; reportId: string } | null;
  limit: number;
  status: ReportStatus | null;
  tenantId: string | null;
}

export const REPORT_LIST_LIMIT = 50;
const MAX_REPORT_LIST_LIMIT = 100;
const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPORT_CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([A-Za-z0-9_-]{1,128})$/;

export function parseReportListQuery(url: URL): ReportListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!["cursor", "limit", "status", "tenantId"].includes(key)) {
      return null;
    }
  }
  const statusRaw = params.get("status");
  if (statusRaw !== null && !(REPORT_STATUSES as readonly string[]).includes(statusRaw)) {
    return null;
  }
  const tenantId = params.get("tenantId");
  if (tenantId !== null && !TENANT_PATTERN.test(tenantId)) {
    return null;
  }
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? REPORT_LIST_LIMIT : Number(limitRaw);
  if (!/^\d{1,3}$/.test(limitRaw ?? "50") || limit < 1 || limit > MAX_REPORT_LIST_LIMIT) {
    return null;
  }
  const cursorRaw = params.get("cursor");
  let cursor: ReportListQuery["cursor"] = null;
  if (cursorRaw !== null) {
    const match = REPORT_CURSOR_PATTERN.exec(cursorRaw);
    if (match === null) {
      return null;
    }
    cursor = { createdAt: match[1] as string, reportId: match[2] as string };
  }
  return { cursor, limit, status: statusRaw as ReportStatus | null, tenantId };
}

/**
 * Newest first (Firebase orderBy createdAt desc), keyset-paginated on
 * (created_at, report_id). `newCount` is every shop's `new` reports — the
 * navigation badge — whatever the filter.
 */
export async function listReports(
  db: D1Database,
  query: ReportListQuery,
): Promise<{ newCount: number; nextCursor: string | null; reports: PlatformReportView[] }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (query.status !== null) {
    where.push("r.status = ?");
    binds.push(query.status);
  }
  if (query.tenantId !== null) {
    where.push("r.tenant_id = ?");
    binds.push(query.tenantId);
  }
  if (query.cursor !== null) {
    where.push("(r.created_at, r.report_id) < (?, ?)");
    binds.push(query.cursor.createdAt, query.cursor.reportId);
  }
  const rows = await db
    .prepare(
      `${REPORT_SELECT}
       ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
       ORDER BY r.created_at DESC, r.report_id DESC
       LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<ReportRow>();
  const counted = await db
    .prepare("SELECT COUNT(*) AS total FROM infringement_reports WHERE status = 'new'")
    .first<{ total: number }>();

  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);
  return {
    newCount: counted?.total ?? 0,
    nextCursor:
      rows.results.length > query.limit && last !== undefined
        ? `${last.created_at}~${last.report_id}`
        : null,
    reports: page.map(reportView),
  };
}

// ── handling ────────────────────────────────────────────────────────────────

/**
 * The transitions (0036 `infringement_reports_status_transition` enforces the
 * same table):
 *
 *   new        → reviewing | rejected | taken_down
 *   reviewing  → rejected | taken_down
 *   rejected   → reviewing          (PlatformReports "Öppna igen")
 *   taken_down → —                  final
 *
 * Moving a report to its own status is refused too (a double click answers
 * 409 instead of writing a second audit row).
 */
const TRANSITIONS: Record<ReportStatus, readonly ReportStatus[]> = {
  new: ["reviewing", "rejected", "taken_down"],
  rejected: ["reviewing"],
  reviewing: ["rejected", "taken_down"],
  taken_down: [],
};

export function canTransition(from: ReportStatus, to: ReportStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface HandleReportInput {
  note?: string | null;
  status: "rejected" | "reviewing";
}

/** undefined = invalid; null = clear. */
function parseNote(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || CONTROL.test(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    return undefined;
  }
  return trimmed === "" ? null : trimmed;
}

export function parseHandleReportInput(body: unknown): HandleReportInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "status" || key === "note")) {
    return null;
  }
  if (record.status !== "reviewing" && record.status !== "rejected") {
    return null;
  }
  if (record.note === undefined) {
    return { status: record.status };
  }
  const note = parseNote(record.note);
  return note === undefined ? null : { note, status: record.status };
}

export interface TakedownReportInput {
  note?: string | null;
  /** Optional confirmation: must be the report's own product. */
  productId?: string;
}

export function parseTakedownReportInput(body: unknown): TakedownReportInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "note" || key === "productId")) {
    return null;
  }
  const input: TakedownReportInput = {};
  if (record.productId !== undefined) {
    if (typeof record.productId !== "string" || !PRODUCT_ID_PATTERN.test(record.productId)) {
      return null;
    }
    input.productId = record.productId;
  }
  if (record.note !== undefined) {
    const note = parseNote(record.note);
    if (note === undefined) {
      return null;
    }
    input.note = note;
  }
  return input;
}

export type ReportConflictCode =
  | "conflict"
  | "product_mismatch"
  | "report_closed"
  | "tenant_mismatch"
  | "transition_refused";

export type HandleReportResult =
  | { report: PlatformReportView; status: "ok" }
  | { code: ReportConflictCode; status: "conflict" }
  | { status: "not_found" };

export type TakedownReportResult =
  | { report: PlatformReportView; screening: PlatformScreeningView; status: "ok" }
  | { code: ReportConflictCode; status: "conflict" }
  | { status: "not_found" };

/** A write computed from a stale read (0036's version / transition triggers). */
function isReportConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("infringement report version must increase") ||
    message.includes("infringement report status transition refused")
  );
}

interface ReportState {
  product_id: string;
  status: ReportStatus;
  tenant_id: string;
  version: number;
}

async function loadReportState(db: D1Database, reportId: string): Promise<ReportState | null> {
  return db
    .prepare(
      "SELECT tenant_id, product_id, status, version FROM infringement_reports WHERE report_id = ? LIMIT 1",
    )
    .bind(reportId)
    .first<ReportState>();
}

/** The arrival alert has done its job once a human has handled the report. */
function resolveArrivalAlert(db: D1Database, reportId: string, iso: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE alerts SET resolved_at = MAX(created_at, ?)
       WHERE kind = ? AND resource_type = 'infringement_report' AND resource_id = ?
         AND resolved_at IS NULL`,
    )
    .bind(iso, REPORT_ALERT_KIND, reportId);
}

function reportAuditStatement(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  reportId: string,
  action: string,
  note: string | null,
  metadata: unknown,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type, resource_id,
         reason, request_id, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, 'infringement_report', ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      tenantId,
      principal.userId,
      action,
      reportId,
      note,
      crypto.randomUUID(),
      JSON.stringify(metadata),
      now,
    );
}

/**
 * reviewing / rejected: the status, the note (replaced when given, kept when
 * absent), the handler and time, the audit row and the arrival alert's
 * resolution in ONE batch, written at `<read version> + 1` so a concurrent
 * handling makes this one a 409 instead of overwriting it.
 */
export async function handleReport(
  db: D1Database,
  principal: PlatformPrincipal,
  reportId: string,
  input: HandleReportInput,
  now: number,
): Promise<HandleReportResult> {
  const current = await loadReportState(db, reportId);
  if (current === null) {
    return { status: "not_found" };
  }
  if (!canTransition(current.status, input.status)) {
    return { code: "transition_refused", status: "conflict" };
  }
  const iso = new Date(now).toISOString();
  const keepNote = input.note === undefined;
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE infringement_reports
           SET status = ?, note = CASE WHEN ? THEN note ELSE ? END,
               handled_by = ?, handled_by_legacy_uid = NULL,
               handled_at = max(?, created_at), version = ?
           WHERE report_id = ?`,
        )
        .bind(
          input.status,
          keepNote ? 1 : 0,
          keepNote ? null : (input.note ?? null),
          principal.userId,
          iso,
          current.version + 1,
          reportId,
        ),
      reportAuditStatement(
        db,
        principal,
        current.tenant_id,
        reportId,
        `report.${input.status}`,
        input.note ?? null,
        { from: current.status, to: input.status },
        now,
      ),
      resolveArrivalAlert(db, reportId, iso),
    ]);
  } catch (error) {
    if (isReportConflict(error)) {
      return { code: "conflict", status: "conflict" };
    }
    throw error;
  }
  const report = await getReport(db, reportId);
  return report === null ? { status: "not_found" } : { report, status: "ok" };
}

/**
 * The takedown of a reported product (Firebase takedownProduct with a
 * reportId): decideByPlatform(…, "blocked") — the product's takedown stamp,
 * its screening row 'blocked', its audit row carrying the report id and note —
 * PLUS the report → taken_down with handler and time, the report's audit row
 * and the arrival alert's resolution, all in decideByPlatform's ONE batch.
 *
 * Refused (409, nothing written) when the report is closed (rejected or
 * taken_down), when the body names another product than the report's, or
 * when the report's shop is not the product's (0036 makes that impossible to
 * store; checked again here and guarded in the batch itself, where a mismatch
 * or a report that moved since this read aborts everything).
 */
export async function takedownReportedProduct(
  db: D1Database,
  principal: PlatformPrincipal,
  reportId: string,
  input: TakedownReportInput,
  now: number,
): Promise<TakedownReportResult> {
  const current = await loadReportState(db, reportId);
  if (current === null) {
    return { status: "not_found" };
  }
  if (!canTransition(current.status, "taken_down")) {
    return { code: "report_closed", status: "conflict" };
  }
  if (input.productId !== undefined && input.productId !== current.product_id) {
    return { code: "product_mismatch", status: "conflict" };
  }
  const product = await db
    .prepare("SELECT tenant_id FROM products WHERE product_id = ? LIMIT 1")
    .bind(current.product_id)
    .first<{ tenant_id: string }>();
  if (product === null || product.tenant_id !== current.tenant_id) {
    return { code: "tenant_mismatch", status: "conflict" };
  }

  const iso = new Date(now).toISOString();
  const note = input.note ?? null;
  const keepNote = input.note === undefined;
  const statements = [
    // The guard: version 0 (refused by the version trigger and the CHECK)
    // unless the report still names this product of this product's shop, and
    // `<read> + 1` otherwise — which a concurrent write has already passed.
    db
      .prepare(
        `UPDATE infringement_reports
         SET status = 'taken_down',
             note = CASE WHEN ? THEN note ELSE ? END,
             handled_by = ?, handled_by_legacy_uid = NULL,
             handled_at = max(?, created_at),
             version = CASE
               WHEN product_id = ?
                AND tenant_id = (SELECT tenant_id FROM products WHERE product_id = ?)
               THEN ? ELSE 0 END
         WHERE report_id = ?`,
      )
      .bind(
        keepNote ? 1 : 0,
        keepNote ? null : note,
        principal.userId,
        iso,
        current.product_id,
        current.product_id,
        current.version + 1,
        reportId,
      ),
    reportAuditStatement(
      db,
      principal,
      current.tenant_id,
      reportId,
      "report.taken_down",
      note,
      { from: current.status, productId: current.product_id, to: "taken_down" },
      now,
    ),
    resolveArrivalAlert(db, reportId, iso),
  ];

  let screening: PlatformScreeningView | null;
  try {
    screening = await decideByPlatform(db, principal, current.product_id, "blocked", now, {
      note,
      reportId,
      statements,
    });
  } catch (error) {
    if (isReportConflict(error)) {
      return { code: "conflict", status: "conflict" };
    }
    throw error;
  }
  const report = await getReport(db, reportId);
  return screening === null || report === null
    ? { status: "not_found" }
    : { report, screening, status: "ok" };
}
