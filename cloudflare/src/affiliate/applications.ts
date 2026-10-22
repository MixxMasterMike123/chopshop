import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import { parseEmail } from "../platform/provision-users";
import type { TenantContext } from "../tenancy/resolve-tenant";
import {
  parseLang,
  parsePromotionMethod,
  parseSocials,
  parseText,
  type PromotionMethod,
} from "./affiliates";
import { affiliateMailStatement } from "./mail";
import { readCurrentAffiliateTerms } from "./terms";

/**
 * CP13 — the application (design §5.1, §3.2): the storefront's public form,
 * the shop's queue, the denial, and the retention of denied rows.
 *
 * THE PUBLIC WRITE is the tightest surface here: no session, the tenant from
 * the verified hostname, two rate limits (the route), a strict bounded body,
 * the current terms version required, and ONE answer — 202 with an id —
 * whatever happened after validation: a second submission of a pending
 * address stores nothing and sends nothing, and its answer is byte-shaped
 * like the first (a fresh id that names no row), so the form is no oracle on
 * whether an address applied. The application, the applicant's receipt and
 * the shop's notice commit in one batch, or nothing does.
 *
 * Addresses are not on the form (they are collected in the portal before a
 * first payout, [DEV-9]).
 */

/** A denied application is kept this long, then deleted (a D68 default, design §13.8). */
export const DENIED_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
/** Rows deleted per retention run (each cron tick): bounded. */
export const RETENTION_BATCH = 100;
export const APPLICATION_LIST_LIMIT = 50;
const MAX_APPLICATION_LIST_LIMIT = 100;

export interface ApplyInput {
  email: string;
  message: string | null;
  name: string;
  phone: string | null;
  preferredLang: "en" | "sv";
  promotionMethod: PromotionMethod;
  socialsJson: string | null;
  termsVersion: string;
}

const APPLY_KEYS = [
  "email",
  "message",
  "name",
  "phone",
  "preferredLang",
  "promotionMethod",
  "socials",
  "termsAccepted",
  "termsVersion",
] as const;

/**
 * `{ name, email, phone?, socials?, promotionMethod, message?, preferredLang,
 * termsVersion, termsAccepted: true }`, strict keys, every text bounded. The
 * terms version is checked against the current one by the caller.
 */
export function parseApplyInput(body: unknown): ApplyInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => (APPLY_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const name = parseText(record.name, 100);
  const email = parseEmail(record.email);
  const phone = parseText(record.phone, 40);
  const message = record.message === undefined ? null : parseMessage(record.message);
  const socials = parseSocials(record.socials);
  const promotionMethod = parsePromotionMethod(record.promotionMethod);
  const preferredLang = parseLang(record.preferredLang);
  const termsVersion = record.termsVersion;
  if (
    name === undefined ||
    name === null ||
    email === null ||
    phone === undefined ||
    message === undefined ||
    socials === undefined ||
    promotionMethod === null ||
    preferredLang === null ||
    typeof termsVersion !== "string" ||
    !/^[0-9A-Za-z._-]{1,32}$/.test(termsVersion) ||
    record.termsAccepted !== true
  ) {
    return null;
  }
  return {
    email,
    message,
    name,
    phone,
    preferredLang,
    promotionMethod,
    socialsJson: socials,
    termsVersion,
  };
}

/** A free text of up to 2 000 characters (line breaks allowed, other controls not). */
function parseMessage(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (text === "") {
    return null;
  }
  return text.length <= 2_000 && !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? text : undefined;
}

export type SubmitResult =
  | { applicationId: string; outboxIds: string[]; status: "accepted" }
  /** The terms version is not the current one: a 400 (the form is stale). */
  | { status: "stale_terms" };

/**
 * The application, the applicant's receipt and the shop's notice, in ONE
 * batch: the row only when no PENDING application of this address exists in
 * this shop (the partial unique index is the backstop), and each mail row and
 * the audit row only when the row was written.
 */
export async function submitApplication(
  db: D1Database,
  tenant: TenantContext,
  input: ApplyInput,
  now: number,
): Promise<SubmitResult> {
  const terms = await readCurrentAffiliateTerms(db, now);
  if (terms === null || terms.version !== input.termsVersion) {
    return { status: "stale_terms" };
  }
  const applicationId = crypto.randomUUID();
  const nowIso = new Date(now).toISOString();
  const written = {
    binds: [applicationId, tenant.tenantId],
    sql: "EXISTS (SELECT 1 FROM affiliate_applications WHERE application_id = ? AND tenant_id = ?)",
  };
  const received = affiliateMailStatement(db, {
    aggregateId: applicationId,
    aggregateType: "affiliate_application",
    dedupeKey: `email:affiliate_application_received:${applicationId}`,
    guard: written,
    kind: "affiliate_application_received",
    now,
    payload: { applicationId },
    tenantId: tenant.tenantId,
  });
  const notice = affiliateMailStatement(db, {
    aggregateId: applicationId,
    aggregateType: "affiliate_application",
    dedupeKey: `email:affiliate_application_notice:${applicationId}`,
    guard: written,
    kind: "affiliate_application_notice",
    now,
    payload: { applicationId },
    tenantId: tenant.tenantId,
  });
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO affiliate_applications (
             application_id, tenant_id, status, name, email, phone, socials_json,
             promotion_method, message, preferred_lang, terms_version, terms_accepted_at,
             created_at, updated_at
           )
           SELECT ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM affiliate_applications
             WHERE tenant_id = ? AND email = ? AND status = 'pending'
           )`,
        )
        .bind(
          applicationId,
          tenant.tenantId,
          input.name,
          input.email,
          input.phone,
          input.socialsJson,
          input.promotionMethod,
          input.message,
          input.preferredLang,
          input.termsVersion,
          nowIso,
          nowIso,
          nowIso,
          tenant.tenantId,
          input.email,
        ),
      received.statement,
      notice.statement,
      // An anonymous write: no actor, and nothing of the applicant.
      db
        .prepare(
          `INSERT INTO audit_events (
             event_id, tenant_id, actor_user_id, action, resource_type,
             resource_id, request_id, metadata_json, created_at
           )
           SELECT ?, ?, NULL, 'affiliate.apply', 'affiliate_application', ?, ?, NULL, ?
           WHERE ${written.sql}`,
        )
        .bind(crypto.randomUUID(), tenant.tenantId, applicationId, crypto.randomUUID(), now, ...written.binds),
    ]);
  } catch (error) {
    // Two submissions of one address racing: the index refused the second.
    // The same answer as any duplicate.
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("UNIQUE constraint failed: affiliate_applications")) {
      throw error;
    }
  }
  return { applicationId, outboxIds: [received.outboxId, notice.outboxId], status: "accepted" };
}

// ── the shop's queue ────────────────────────────────────────────────────────

export type ApplicationStatus = "approved" | "denied" | "pending";

export interface ApplicationRow {
  affiliate_id: string | null;
  application_id: string;
  created_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  email: string;
  message: string | null;
  name: string;
  phone: string | null;
  preferred_lang: "en" | "sv";
  promotion_method: string;
  socials_json: string | null;
  status: ApplicationStatus;
  terms_accepted_at: string;
  terms_version: string;
}

const APPLICATION_COLUMNS = `application_id, status, name, email, phone, socials_json, promotion_method,
  message, preferred_lang, terms_version, terms_accepted_at, decided_at, decision_reason, affiliate_id,
  created_at`;

export interface ApplicationListQuery {
  cursor: { createdAt: string; id: string; rank: number } | null;
  limit: number;
  status: ApplicationStatus | null;
}

const CURSOR_PATTERN =
  /^([01])~(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** `?status=&cursor=&limit=`, all optional; anything else a 400. */
export function parseApplicationListQuery(url: URL): ApplicationListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!["cursor", "limit", "status"].includes(key) || params.getAll(key).length !== 1) {
      return null;
    }
  }
  const status = params.get("status");
  if (status !== null && status !== "pending" && status !== "approved" && status !== "denied") {
    return null;
  }
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? APPLICATION_LIST_LIMIT : /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : 0;
  if (limit < 1 || limit > MAX_APPLICATION_LIST_LIMIT) {
    return null;
  }
  const cursorRaw = params.get("cursor");
  let cursor: ApplicationListQuery["cursor"] = null;
  if (cursorRaw !== null) {
    const match = CURSOR_PATTERN.exec(cursorRaw);
    if (match === null) {
      return null;
    }
    cursor = { createdAt: match[2] as string, id: match[3] as string, rank: Number(match[1]) };
  }
  return { cursor, limit, status: status as ApplicationStatus | null };
}

const RANK_SQL = "(CASE WHEN status = 'pending' THEN 0 ELSE 1 END)";

/** The shop's applications: pending first, then newest first; bounded, by cursor. */
export async function listApplications(
  db: D1Database,
  tenantId: string,
  query: ApplicationListQuery,
): Promise<{ applications: ApplicationRow[]; nextCursor: string | null }> {
  const where = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (query.status !== null) {
    where.push("status = ?");
    binds.push(query.status);
  }
  if (query.cursor !== null) {
    where.push(`(${RANK_SQL} > ? OR (${RANK_SQL} = ? AND (created_at, application_id) < (?, ?)))`);
    binds.push(query.cursor.rank, query.cursor.rank, query.cursor.createdAt, query.cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT ${APPLICATION_COLUMNS}, ${RANK_SQL} AS rank
       FROM affiliate_applications
       WHERE ${where.join(" AND ")}
       ORDER BY rank ASC, created_at DESC, application_id DESC
       LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<ApplicationRow & { rank: number }>();
  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);
  return {
    applications: page,
    nextCursor:
      rows.results.length > query.limit && last !== undefined
        ? `${last.rank}~${last.created_at}~${last.application_id}`
        : null,
  };
}

export async function readApplication(
  db: D1Database,
  tenantId: string,
  applicationId: string,
): Promise<ApplicationRow | null> {
  return db
    .prepare(`SELECT ${APPLICATION_COLUMNS} FROM affiliate_applications WHERE tenant_id = ? AND application_id = ? LIMIT 1`)
    .bind(tenantId, applicationId)
    .first<ApplicationRow>();
}

// ── the denial ──────────────────────────────────────────────────────────────

/** `{ reason }`, 1–500 characters (it is mailed to the applicant). */
export function parseDenyInput(body: unknown): { reason: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "reason")) {
    return null;
  }
  const reason = parseMessage(record.reason);
  return reason === undefined || reason === null || reason.length > 500 ? null : { reason };
}

export type DenyResult =
  | { outboxId: string; status: "ok" }
  | { status: "already_decided" | "not_found" };

/**
 * pending → denied, with who, when and why, the audit row and the denial
 * mail, in one batch keyed on the decision's stamp. Nothing is deleted.
 */
export async function denyApplication(
  db: D1Database,
  principal: TenantAdminPrincipal,
  applicationId: string,
  reason: string,
  now: number,
): Promise<DenyResult> {
  const decisionId = crypto.randomUUID();
  const nowIso = new Date(now).toISOString();
  const decided = {
    binds: [applicationId, decisionId],
    sql: "EXISTS (SELECT 1 FROM affiliate_applications WHERE application_id = ? AND decision_id = ?)",
  };
  const mail = affiliateMailStatement(db, {
    aggregateId: applicationId,
    aggregateType: "affiliate_application",
    dedupeKey: `email:affiliate_application_denied:${applicationId}`,
    guard: decided,
    kind: "affiliate_application_denied",
    now,
    payload: { applicationId },
    tenantId: principal.tenantId,
  });
  const [decision] = await db.batch([
    db
      .prepare(
        `UPDATE affiliate_applications
         SET status = 'denied', decided_by = ?, decided_at = ?, decision_id = ?, decision_reason = ?,
             updated_at = MAX(updated_at, ?)
         WHERE application_id = ? AND tenant_id = ? AND status = 'pending'`,
      )
      .bind(principal.userId, nowIso, decisionId, reason, nowIso, applicationId, principal.tenantId),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?, tenant_id, ?, 'affiliate.deny', 'affiliate_application', application_id, ?, ?, ?
         FROM affiliate_applications WHERE application_id = ? AND decision_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        crypto.randomUUID(),
        auditMetadataJson(principal, { decisionId }),
        now,
        applicationId,
        decisionId,
      ),
    mail.statement,
  ]);
  if ((decision?.meta.changes ?? 0) > 0) {
    return { outboxId: mail.outboxId, status: "ok" };
  }
  return (await readApplication(db, principal.tenantId, applicationId)) === null
    ? { status: "not_found" }
    : { status: "already_decided" };
}

// ── retention ───────────────────────────────────────────────────────────────

/**
 * Deletes the DENIED applications decided more than 12 months ago, at most
 * RETENTION_BATCH per run, with ONE audit row naming how many (no tenant: a
 * platform job; nothing of the applicants). Approved rows are never touched
 * (0059's delete trigger refuses any other row). Safe to repeat every tick.
 */
export async function purgeDeniedApplications(db: D1Database, now: number): Promise<number> {
  const cutoff = new Date(now - DENIED_RETENTION_MS).toISOString();
  const due = `SELECT application_id FROM affiliate_applications
               WHERE status = 'denied' AND decided_at < ?
               ORDER BY decided_at
               LIMIT ${RETENTION_BATCH}`;
  const [, deleted] = await db.batch([
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?, NULL, NULL, 'affiliate.application_retention', 'affiliate_application', NULL, ?,
                json_object('deleted', COUNT(*)), ?
         FROM (${due})
         HAVING COUNT(*) > 0`,
      )
      .bind(crypto.randomUUID(), crypto.randomUUID(), now, cutoff),
    db
      .prepare(`DELETE FROM affiliate_applications WHERE application_id IN (${due})`)
      .bind(cutoff),
  ]);
  return deleted?.meta.changes ?? 0;
}
